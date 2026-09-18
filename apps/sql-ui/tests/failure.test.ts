// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// SQL FAILURE — unit tests for what the app says when a statement fails
// =============================================================================
//
// Each expectation is tied to a literal the backend actually produces; the
// line references are in the module's header.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, maxRowsText } from '../src/sql/failure';
import { applyRowLimit } from '../src/sql/batch';
import { stripSqlComments } from '../src/sql/split';

describe('describeFailure', () => {
	it('puts the first line of the driver text in the headline', () => {
		const notice = describeFailure("Table 'sample_shop.custmers' doesn't exist\n(1146)");
		assert.equal(notice.headline, "Database reported: Table 'sample_shop.custmers' doesn't exist");
	});

	it('keeps the whole message verbatim', () => {
		const notice = describeFailure('line one\nline two');
		assert.equal(notice.verbatim, 'line one\nline two');
	});

	it('recognises the node generic placeholder', () => {
		const notice = describeFailure('SQL execution failed (check server logs for details)');
		assert.equal(notice.generic, true);
	});

	it('does not call real driver text generic', () => {
		assert.equal(describeFailure('syntax error at or near "slect"').generic, false);
	});

	it('recognises the allow_execute refusal', () => {
		const notice = describeFailure('execute tool is disabled for this node (set allow_execute=true)');
		assert.equal(notice.allowExecuteOff, true);
	});

	it('does not claim allow_execute for an ordinary failure', () => {
		assert.equal(describeFailure('deadlock found when trying to get lock').allowExecuteOff, false);
	});

	it('reads the node row cap out of an overflow', () => {
		assert.equal(describeFailure('EXECUTE query exceeded max_execute_rows=1000').maxExecuteRows, 1000);
	});

	it('reports no cap when the failure is unrelated', () => {
		assert.equal(describeFailure('connection reset').maxExecuteRows, null);
	});

	it('treats an empty message as the generic case rather than an empty quote', () => {
		// An Error with no message reaches this path; `generic: false` made
		// QueryView and ExplainPanel render the headline with nothing after it.
		const notice = describeFailure('');
		assert.equal(notice.generic, true);
		assert.equal(notice.verbatim, '');
	});

	it('treats a whitespace-only message the same way', () => {
		assert.equal(describeFailure('   \n  ').generic, true);
	});
});

// =============================================================================
// THE NODE'S OWN PREFIX
// =============================================================================
//
// A node that returns the driver's text wraps it in `SQL execution failed: `.
// That prefix is the NODE talking, and the banner says `Database reported:`,
// so quoting the prefix would attribute the node's words to the database.
// =============================================================================

describe('describeFailure — the node execute prefix', () => {
	it('quotes what the database said, not the node wrapper', () => {
		const notice = describeFailure('SQL execution failed: no such table: orders');
		assert.equal(notice.headline, 'Database reported: no such table: orders');
	});

	it('still keeps the whole message verbatim, prefix included', () => {
		const notice = describeFailure('SQL execution failed: no such table: orders');
		assert.equal(notice.verbatim, 'SQL execution failed: no such table: orders');
		assert.equal(notice.generic, false);
	});

	it('strips the prefix from the first line of a multi-line message', () => {
		const notice = describeFailure('SQL execution failed: no such table: orders\n(sqlite3.OperationalError)');
		assert.equal(notice.headline, 'Database reported: no such table: orders');
		assert.equal(notice.verbatim, 'SQL execution failed: no such table: orders\n(sqlite3.OperationalError)');
	});

	it('leaves the generic placeholder generic', () => {
		// It carries a parenthesis, not a colon, so it is not the prefix form
		// and there is still nothing real to quote.
		const notice = describeFailure('SQL execution failed (check server logs for details)');
		assert.equal(notice.generic, true);
	});

	it('leaves a message without the prefix alone', () => {
		const notice = describeFailure('syntax error at or near "slect"');
		assert.equal(notice.headline, 'Database reported: syntax error at or near "slect"');
		assert.equal(notice.generic, false);
	});

	it('treats the prefix with nothing behind it as nothing to quote', () => {
		// Rendering `Database reported:` with an empty quote would be worse
		// than saying plainly that no message came back.
		const notice = describeFailure('SQL execution failed:');
		assert.equal(notice.generic, true);
		assert.equal(notice.verbatim, 'SQL execution failed:');
	});

	it('keeps reading the node flags through the prefix', () => {
		assert.equal(
			describeFailure('SQL execution failed: execute tool is disabled for this node (set allow_execute=true)').allowExecuteOff,
			true,
		);
		assert.equal(
			describeFailure('SQL execution failed: EXECUTE query exceeded max_execute_rows=1000').maxExecuteRows,
			1000,
		);
	});
});

describe('maxRowsText', () => {
	it('names the cap', () => {
		assert.equal(maxRowsText(1000), 'The node caps results at 1,000 rows; choose a lower limit or add LIMIT.');
	});
});

describe('applyRowLimit', () => {
	it('appends a limit to a SELECT', () => {
		assert.deepEqual(applyRowLimit('SELECT * FROM orders', '200'), { sql: 'SELECT * FROM orders\nLIMIT 200', limit: 200, state: 'applied' });
	});

	it('drops a trailing semicolon before appending', () => {
		assert.equal(applyRowLimit('SELECT 1;', '200').sql, 'SELECT 1\nLIMIT 200');
	});

	it('applies no limit for All', () => {
		assert.deepEqual(applyRowLimit('SELECT * FROM orders', 'All'), { sql: 'SELECT * FROM orders', limit: null, state: 'none' });
	});

	it('reports a statement that limits itself, rather than claiming none', () => {
		assert.deepEqual(applyRowLimit('SELECT * FROM orders LIMIT 5', '200'), {
			sql: 'SELECT * FROM orders LIMIT 5',
			limit: null,
			state: 'in-statement',
		});
	});

	it('still reports the statement own limit under All', () => {
		// The generated "Select top 100" reads `... LIMIT 100`; under All this
		// used to render "100 rows returned (no limit applied)", which invites
		// the reader to conclude the table holds exactly 100 rows.
		assert.equal(applyRowLimit('SELECT * FROM orders LIMIT 100', 'All').state, 'in-statement');
	});

	it('leaves an UPDATE alone', () => {
		assert.deepEqual(applyRowLimit('UPDATE orders SET a = 1', '200'), { sql: 'UPDATE orders SET a = 1', limit: null, state: 'none' });
	});

	it('leaves DDL alone', () => {
		assert.equal(applyRowLimit('CREATE TABLE t (id INT)', '200').limit, null);
	});

	it('leaves SHOW and EXPLAIN alone', () => {
		assert.equal(applyRowLimit('SHOW TABLES', '200').limit, null);
		assert.equal(applyRowLimit('EXPLAIN SELECT 1', '200').limit, null);
	});

	it('limits a read-only WITH chain', () => {
		assert.equal(applyRowLimit('WITH r AS (SELECT 1) SELECT * FROM r', '200').limit, 200);
	});

	it('limits a WITH chain whose only verb is quoted or in a literal', () => {
		// The row-limit rule reads the same masked text the classification
		// does; if it drifts, a read silently returns every row under a meta
		// line that says a limit was applied elsewhere.
		assert.equal(applyRowLimit('WITH d AS (SELECT 1) SELECT * FROM "delete"', '1000', 'postgres').state, 'applied');
		assert.equal(applyRowLimit("WITH d AS (SELECT 'delete me' AS t) SELECT * FROM d", '1000').state, 'applied');
		assert.equal(applyRowLimit('WITH d AS (SELECT $$delete from orders$$ AS t) SELECT 1', '1000', 'postgres').state, 'applied');
	});

	it('still appends nothing to a data-modifying WITH chain', () => {
		// Appending LIMIT there is invalid SQL, so this stays as it was.
		assert.deepEqual(applyRowLimit('WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone', '200'), {
			sql: 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone',
			limit: null,
			state: 'none',
		});
	});

	it('inserts the limit before a trailing locking clause', () => {
		// MySQL documents the order `[LIMIT ...] [FOR UPDATE | LOCK IN SHARE
		// MODE]` and rejects a LIMIT that follows the clause; PostgreSQL
		// accepts either order. Appending would therefore send MySQL a
		// statement that does not parse, and skipping the limit would stream
		// every row of a read the app used to bound. The limit is INSERTED
		// before the clause instead: valid on both engines, and the user's own
		// clauses keep the order they were typed in.
		for (const [statement, dialect, expected] of [
			['SELECT * FROM orders FOR UPDATE', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE'],
			['SELECT * FROM orders FOR NO KEY UPDATE', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR NO KEY UPDATE'],
			['SELECT * FROM orders FOR SHARE', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR SHARE'],
			['SELECT * FROM orders FOR KEY SHARE', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR KEY SHARE'],
			['SELECT * FROM orders FOR UPDATE OF orders NOWAIT', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE OF orders NOWAIT'],
			['SELECT * FROM orders FOR UPDATE OF t1, t2 NOWAIT', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE OF t1, t2 NOWAIT'],
			['SELECT * FROM orders FOR UPDATE OF "my orders" NOWAIT', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE OF "my orders" NOWAIT'],
			['SELECT * FROM orders FOR UPDATE SKIP LOCKED', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE SKIP LOCKED'],
			['SELECT * FROM orders ORDER BY id FOR UPDATE', 'postgres', 'SELECT * FROM orders ORDER BY id\nLIMIT 200\nFOR UPDATE'],
			['SELECT * FROM orders FOR UPDATE OF a FOR SHARE OF b', 'postgres', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE OF a FOR SHARE OF b'],
			['select * from orders for update', 'postgres', 'select * from orders\nLIMIT 200\nfor update'],
			['SELECT * FROM orders FOR UPDATE', 'mysql', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE'],
			['SELECT * FROM orders FOR SHARE NOWAIT', 'mysql', 'SELECT * FROM orders\nLIMIT 200\nFOR SHARE NOWAIT'],
			['SELECT * FROM orders LOCK IN SHARE MODE', 'mysql', 'SELECT * FROM orders\nLIMIT 200\nLOCK IN SHARE MODE'],
			['SELECT * FROM orders lock in share mode', 'mysql', 'SELECT * FROM orders\nLIMIT 200\nlock in share mode'],
			['SELECT * FROM orders FOR UPDATE', 'unknown', 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE'],
			['SELECT * FROM orders LOCK IN SHARE MODE', 'unknown', 'SELECT * FROM orders\nLIMIT 200\nLOCK IN SHARE MODE'],
		] as const) {
			assert.deepEqual(
				applyRowLimit(statement, '200', dialect),
				{ sql: expected, limit: 200, state: 'applied' },
				`${statement} (${dialect})`,
			);
		}
	});

	it('reads the locking clause through a trailing comment and a trailing semicolon', () => {
		// The clause is still the statement's last clause when a comment or a
		// `;` follows it, and the inserted LIMIT goes in front of the clause
		// rather than inside the comment or after the terminator.
		assert.deepEqual(applyRowLimit('SELECT * FROM orders FOR UPDATE -- nightly', '200', 'postgres'), {
			sql: 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE -- nightly',
			limit: 200,
			state: 'applied',
		});
		assert.equal(applyRowLimit('SELECT * FROM orders FOR UPDATE;', '200', 'postgres').sql, 'SELECT * FROM orders\nLIMIT 200\nFOR UPDATE;');
		assert.equal(
			applyRowLimit('SELECT * FROM orders /* nightly */ FOR UPDATE /* now */', '200', 'postgres').sql,
			'SELECT * FROM orders /* nightly */\nLIMIT 200\nFOR UPDATE /* now */',
		);
	});

	it('still appends at the END for a statement that only MENTIONS a locking clause', () => {
		// `lock` is NON-RESERVED in PostgreSQL, so `SELECT * FROM lock` is an
		// ordinary read of a table called `lock`: matching a bare `lock`
		// keyword would move its limit in front of the table name. A clause
		// inside a literal, a comment or a subquery is not the statement's
		// trailing clause either, and a statement whose own LIMIT precedes the
		// clause keeps reporting the bound it carries.
		assert.deepEqual(applyRowLimit('SELECT * FROM lock', '200', 'postgres'), {
			sql: 'SELECT * FROM lock\nLIMIT 200',
			limit: 200,
			state: 'applied',
		});
		assert.equal(applyRowLimit("SELECT 'for update' FROM t", '200', 'postgres').sql, "SELECT 'for update' FROM t\nLIMIT 200");
		assert.equal(applyRowLimit('SELECT * FROM t -- for update', '200', 'postgres').sql, 'SELECT * FROM t -- for update\nLIMIT 200');
		assert.equal(applyRowLimit('SELECT * FROM (SELECT 1 FROM t FOR UPDATE) x', '200', 'postgres').sql, 'SELECT * FROM (SELECT 1 FROM t FOR UPDATE) x\nLIMIT 200');
		assert.equal(applyRowLimit('SELECT * FROM orders LIMIT 5 FOR UPDATE', '200', 'postgres').state, 'in-statement');
		// MariaDB's `FOR SYSTEM_TIME` is a system-versioning clause, not a lock,
		// and it is followed by more of the statement: a guard that matched a
		// bare `for` would cut the statement in half.
		assert.equal(
			applyRowLimit('SELECT * FROM t FOR SYSTEM_TIME AS OF NOW() WHERE id = 1', '200', 'mysql').sql,
			'SELECT * FROM t FOR SYSTEM_TIME AS OF NOW() WHERE id = 1\nLIMIT 200',
		);
	});

	it('bounds a WITH chain that ends in a locking clause, except the two the classifier reads as writes', () => {
		// `FOR SHARE` and `FOR KEY SHARE` carry no word the CTE classification
		// treats as a write, so the chain is a read and takes the inserted
		// limit. `FOR UPDATE` and `FOR NO KEY UPDATE` do carry one — the
		// classifier takes the clause's `UPDATE` for the chain's verb — so the
		// chain is classified as a write and gets no limit at all. That is a
		// gap in the WITH-chain classification rather than in this rule, and it
		// predates it; pinned here so it cannot change unnoticed.
		assert.equal(
			applyRowLimit('WITH x AS (SELECT 1) SELECT * FROM x FOR SHARE', '200', 'postgres').sql,
			'WITH x AS (SELECT 1) SELECT * FROM x\nLIMIT 200\nFOR SHARE',
		);
		assert.equal(applyRowLimit('WITH x AS (SELECT 1) SELECT * FROM x FOR UPDATE', '200', 'postgres').state, 'none');
	});

	it('appends at the END when a limit clause already follows the locking clause', () => {
		// PostgreSQL also accepts `... FOR UPDATE OFFSET 5`, where the
		// statement's own limit clause is the last thing in it. Inserting
		// before the locking clause would produce `LIMIT 200 FOR UPDATE OFFSET
		// 5`, which does not parse, so such a statement keeps the appended
		// form it had before the guard existed.
		assert.deepEqual(applyRowLimit('SELECT * FROM orders FOR UPDATE OFFSET 5', '200', 'postgres'), {
			sql: 'SELECT * FROM orders FOR UPDATE OFFSET 5\nLIMIT 200',
			limit: 200,
			state: 'applied',
		});
	});

	it('never splits a line whose locking clause sits behind an unmasked #', () => {
		// `#` starts a line comment in MySQL only, so it is masked for that
		// dialect alone. On `unknown` — where the app lands when the dialect
		// probe fails — a commented-out `# for update` still reads as the
		// statement's trailing clause, and inserting the limit in front of it
		// would move the clause onto its own line and OUT of the comment: sent
		// to the MySQL server that `#` implies, the statement would take row
		// locks the user had commented out. Such a statement goes out
		// untouched and reports no limit instead.
		assert.deepEqual(applyRowLimit('SELECT * FROM t # for update', '200', 'unknown'), {
			sql: 'SELECT * FROM t # for update',
			limit: null,
			state: 'none',
		});
		assert.deepEqual(applyRowLimit('SELECT * FROM t # lock in share mode', '200', 'unknown'), {
			sql: 'SELECT * FROM t # lock in share mode',
			limit: null,
			state: 'none',
		});
		// On `mysql` the comment IS masked, so the same text is an ordinary
		// unbounded read and takes the limit appended at the end — on a line of
		// its own, which is what keeps it out of the comment.
		assert.deepEqual(applyRowLimit('SELECT * FROM t # for update', '200', 'mysql'), {
			sql: 'SELECT * FROM t # for update\nLIMIT 200',
			limit: 200,
			state: 'applied',
		});
		// A `#` on an EARLIER line comments out nothing the insertion touches,
		// so the clause on the next line still takes the inserted limit.
		assert.deepEqual(applyRowLimit('SELECT * FROM t # note\nFOR UPDATE', '200', 'unknown'), {
			sql: 'SELECT * FROM t # note\nLIMIT 200\nFOR UPDATE',
			limit: 200,
			state: 'applied',
		});
	});

	it('does not read a LIMIT inside a literal or a quoted identifier', () => {
		// These already held — the in-statement test has always read masked
		// text — and are pinned so the masking cannot be dropped from it.
		assert.equal(applyRowLimit("SELECT 'limit 5' FROM t", '1000').state, 'applied');
		assert.equal(applyRowLimit('SELECT * FROM "limit"', '1000', 'postgres').state, 'applied');
	});

	it('leaves a data-modifying WITH chain alone', () => {
		assert.equal(applyRowLimit('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone', '200').limit, null);
	});

	it('limits a parenthesised set expression', () => {
		assert.equal(applyRowLimit('(SELECT 1) UNION (SELECT 2)', '200').limit, 200);
	});

	it('sees through a leading comment', () => {
		assert.equal(applyRowLimit('-- daily\nSELECT * FROM orders', '200').limit, 200);
	});

	it('does not see a LIMIT that only exists in a comment', () => {
		assert.equal(applyRowLimit('SELECT * FROM orders -- no LIMIT here', '200').limit, 200);
	});

	it('does not append the clause INTO a trailing line comment', () => {
		// Joined with a space this read `... -- daily LIMIT 200`: the database
		// saw an unbounded SELECT while the meta line claimed a limit of 200.
		const applied = applyRowLimit('SELECT * FROM orders -- daily', '200');
		assert.equal(applied.sql, 'SELECT * FROM orders -- daily\nLIMIT 200');
		assert.equal(applied.limit, 200);
		// The clause must be code, not comment text, in the statement as sent.
		assert.match(stripSqlComments(applied.sql), /LIMIT 200\s*$/);
	});

	it('leaves a trailing block comment intact and still bounds the statement', () => {
		const applied = applyRowLimit('SELECT * FROM orders /* daily */', '200');
		assert.match(stripSqlComments(applied.sql), /LIMIT 200\s*$/);
	});

	it('does not mistake a subquery LIMIT for the result bound', () => {
		// The outer SELECT is unbounded: reporting `in-statement` here would
		// stream every joined row into the browser under a meta line that says
		// the statement bounded itself.
		const applied = applyRowLimit('SELECT * FROM (SELECT id FROM big LIMIT 10) x JOIN other o ON o.id = x.id', '200');
		assert.equal(applied.state, 'applied');
		assert.equal(applied.limit, 200);
	});

	it('does not mistake a LIMIT inside a string literal for the result bound', () => {
		const applied = applyRowLimit("SELECT * FROM orders WHERE note = 'limit 5'", '200');
		assert.equal(applied.state, 'applied');
		assert.equal(applied.limit, 200);
	});

	describe('applyRowLimit — the SQL-standard FETCH FIRST/NEXT limit clause', () => {

		it('leaves a FETCH FIRST ... ROWS ONLY statement alone and reports the limit in statement', () => {
			// asclearuc's first reported shape (2282-A1): FETCH FIRST n ROWS ONLY and
			// LIMIT n are two productions of the same limit_clause, so the statement
			// already carries its bound and the app must add none.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('accepts FETCH NEXT as the other spelling of FETCH FIRST', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH NEXT 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH NEXT 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('accepts FETCH FIRST ROW ONLY with the count omitted', () => {
			// The count defaults to 1 row; detection must not require a number.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST ROW ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST ROW ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('accepts the singular ROW after an explicit count', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST 1 ROW ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST 1 ROW ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('treats FETCH FIRST 0 ROWS ONLY as a real bound of zero, not as no limit at all', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST 0 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST 0 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('accepts a bind parameter as the fetch count', () => {
			// select_fetch_first_value accepts a parameter; the bound is not a
			// literal, so no number-shaped test may gate the detection.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST $1 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST $1 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('accepts a parenthesised expression as the fetch count', () => {
			// The open paren sits AFTER the FETCH keyword, so the depth-0 site is
			// still the FETCH itself.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST (2 + 3) ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST (2 + 3) ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('is case-insensitive', () => {
			assert.deepEqual(applyRowLimit('select * from orders fetch first 10 rows only', '200', 'postgres'), {
					sql: 'select * from orders fetch first 10 rows only',
					limit: null,
					state: 'in-statement',
			});
		});

		it('accepts a comment between FETCH and FIRST', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH /* count */ FIRST 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH /* count */ FIRST 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('returns the statement verbatim, trailing semicolon included', () => {
			// The in-statement branch never strips `;` — only applied/appended do.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS ONLY;', '200', 'postgres'), {
					sql: 'SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS ONLY;',
					limit: null,
					state: 'in-statement',
			});
		});

		it('returns the statement verbatim through a trailing line comment', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST 10 ROWS ONLY -- nightly', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST 10 ROWS ONLY -- nightly',
					limit: null,
					state: 'in-statement',
			});
		});

		it("reports 'limit in statement' under All, not 'no limit applied'", () => {
			// The in-statement check runs BEFORE the All short-circuit, exactly as
			// it already does for a bare LIMIT under All.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST 10 ROWS ONLY', 'All', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('does not describe FETCH ... WITH TIES as a hard cap', () => {
			// WITH TIES may return MORE than the fetch count, so this must read as
			// in-statement (limit unknown), never as applied (a hard cap of 200).
			assert.deepEqual(applyRowLimit('SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS WITH TIES', '200', 'postgres'), {
					sql: 'SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS WITH TIES',
					limit: null,
					state: 'in-statement',
			});
		});

	});

	describe('applyRowLimit — FETCH combined with OFFSET', () => {

		it('treats OFFSET ... FETCH NEXT ... ROWS ONLY as self-bounded', () => {
			// OFFSET alone is not a row cap, but the FETCH beside it is.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('treats an OFFSET 0 ROWS + FETCH NEXT pairing as self-bounded', () => {
			// The shape a paging UI generates on page one; the zero offset must
			// not make the FETCH look absent.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

		it('accepts FETCH FIRST ... ROWS ONLY followed by OFFSET', () => {
			// PostgreSQL accepts either order of the two clauses.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders FETCH FIRST 10 ROWS ONLY OFFSET 5', '200', 'postgres'), {
					sql: 'SELECT * FROM orders FETCH FIRST 10 ROWS ONLY OFFSET 5',
					limit: null,
					state: 'in-statement',
			});
		});

	});

	describe('applyRowLimit — FETCH FIRST combined with a locking clause', () => {

		it('leaves a FETCH-bounded statement untouched even when a locking clause follows or precedes it', () => {
			// asclearuc's second reported shape (2282-A2): with the in-statement
			// guard fixed, none of these ever reaches trailingLockingClauseAt, so
			// no limit clause is ever spliced next to the lock, on either side.
			for (const [statement, dialect] of [
				['SELECT * FROM orders FETCH FIRST 10 ROWS ONLY FOR UPDATE', 'postgres'],
				['SELECT * FROM orders FETCH FIRST 10 ROWS ONLY FOR SHARE OF orders NOWAIT', 'postgres'],
				['SELECT * FROM orders FETCH FIRST 10 ROWS ONLY FOR UPDATE SKIP LOCKED', 'postgres'],
				['SELECT * FROM orders FETCH FIRST 10 ROWS ONLY FOR UPDATE OF a FOR SHARE OF b', 'postgres'],
				['SELECT * FROM orders ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY FOR UPDATE', 'postgres'],
				['SELECT * FROM orders FOR UPDATE FETCH FIRST 10 ROWS ONLY', 'postgres'],
			] as const) {
				assert.deepEqual(applyRowLimit(statement, '200', dialect), { sql: statement, limit: null, state: 'in-statement' }, `${statement} (${dialect})`);
			}
		});

	});

	describe("applyRowLimit — statements that only mention 'fetch', not a limit clause", () => {

		it('does not mistake the word fetch for a limit clause when it is masked out', () => {
			// A comment, a string/dollar-quoted literal, a quoted or backtick-quoted
			// identifier named fetch, an identifier merely containing fetch, and a
			// MySQL # comment (masked for that dialect) must not be read as a FETCH
			// limit clause — the unbounded read still takes the appended limit.
			for (const [statement, dialect] of [
				['SELECT * FROM orders -- fetch first 10 rows only', 'postgres'],
				['SELECT * FROM orders /* fetch first 10 rows only */', 'postgres'],
				['SELECT \'fetch first 10 rows only\' AS note FROM orders', 'postgres'],
				['SELECT $$fetch first 10 rows only$$ AS note', 'postgres'],
				['SELECT * FROM "fetch"', 'postgres'],
				['SELECT fetch_count FROM t', 'postgres'],
				['SELECT prefetch FROM t', 'postgres'],
				['SELECT * FROM `fetch`', 'mysql'],
				['SELECT * FROM t # fetch first 10 rows only', 'mysql'],
			] as const) {
				assert.deepEqual(
					applyRowLimit(statement, '200', dialect),
					{ sql: `${statement}\nLIMIT 200`, limit: 200, state: 'applied' },
					`${statement} (${dialect})`,
				);
			}
		});

		it('defers to the same-line # ambiguity guard for its OWN limit clause, on both spellings, everywhere but mysql', () => {
			// CodeRabbit 5253101335 (thread r4051099532): on `unknown` — where the
			// app lands when the dialect probe fails, and a MySQL server is a live
			// possibility behind that failure — an unmasked `#` on the same line as
			// the statement's own LIMIT/FETCH clause makes the clause ambiguous:
			// on MySQL, that text is a comment and the SELECT runs unbounded, so
			// reporting `limit in statement` would claim a bound that does not
			// exist. Both spellings now defer to the existing
			// `hashCommentPrecedesClause` guard and report `none` instead — the
			// same ruling the locking-clause case already uses. Nothing is
			// rewritten either way: the guard returns before the append path, so
			// the SQL sent is byte-identical to the input in every case here.
			for (const [statement, dialect] of [
				['SELECT * FROM t # fetch first 10 rows only', 'unknown'],
				['SELECT * FROM t # limit 5', 'unknown'],
				['SELECT * FROM t # fetch first 10 rows only', 'postgres'],
				['SELECT * FROM t # limit 5', 'postgres'],
			] as const) {
				assert.deepEqual(applyRowLimit(statement, '200', dialect), { sql: statement, limit: null, state: 'none' }, `${statement} (${dialect})`);
			}
		});

		it('pins the documented cost on PostgreSQL: # as the bitwise-XOR operator ambiguates a genuinely bounded statement', () => {
			// On PostgreSQL, `#` is the bitwise-XOR operator, not a comment marker —
			// `SELECT a # b FROM t LIMIT 5` is valid SQL with a real, top-level
			// LIMIT, and the read really is bounded. But the same-line `#` guard
			// cannot tell this apart from a MySQL comment shadowing the clause
			// without masking `#` for PostgreSQL too, so it still reports `none`
			// here — the same cost the locking-clause guard already pays on this
			// dialect. Nothing is rewritten: the statement goes out byte-identical.
			assert.deepEqual(applyRowLimit('SELECT a # b FROM t LIMIT 5', '200', 'postgres'), {
				sql: 'SELECT a # b FROM t LIMIT 5',
				limit: null,
				state: 'none',
			});
		});

		it('still appends the limit on mysql, where # is a real comment and masked out', () => {
			// mysql masks `#`, so `hashCommentPrecedesClause` short-circuits and the
			// guard never fires — unchanged by this fix.
			for (const [statement, expectedSql] of [
				['SELECT * FROM t # fetch first 10 rows only', 'SELECT * FROM t # fetch first 10 rows only\nLIMIT 200'],
				['SELECT * FROM t # limit 5', 'SELECT * FROM t # limit 5\nLIMIT 200'],
			] as const) {
				assert.deepEqual(applyRowLimit(statement, '200', 'mysql'), { sql: expectedSql, limit: 200, state: 'applied' }, statement);
			}
		});

		it('does not extend the # guard past the same line, on either spelling', () => {
			// A `#` on an EARLIER line comments out nothing the clause depends on,
			// so the clause on the next line still reads as a real in-statement
			// limit — exactly like the locking-clause case.
			for (const statement of ['SELECT * FROM t # note\nfetch first 10 rows only', 'SELECT * FROM t # note\nlimit 5']) {
				assert.deepEqual(applyRowLimit(statement, '200', 'unknown'), { sql: statement, limit: null, state: 'in-statement' }, statement);
			}
		});

		it('does not let a # inside a string literal fire the guard, on either spelling', () => {
			// The `#` is masked out of `codeOnly` because it sits inside a string
			// literal, so the guard cannot see it — unchanged by this fix.
			for (const statement of ["SELECT '#' AS a FROM t limit 5", "SELECT '#' AS a FROM t fetch first 10 rows only"]) {
				assert.deepEqual(applyRowLimit(statement, '200', 'unknown'), { sql: statement, limit: null, state: 'in-statement' }, statement);
			}
		});

	});

	describe('applyRowLimit — FETCH at a nested query depth', () => {

		it('does not mistake a subquery FETCH for the result bound', () => {
			// The FETCH bounds the subquery (depth 1), not the outer join; parity
			// with the existing subquery-LIMIT case.
			assert.deepEqual(applyRowLimit('SELECT * FROM (SELECT id FROM big FETCH FIRST 10 ROWS ONLY) x JOIN other o ON o.id = x.id', '200', 'postgres'), {
					sql: 'SELECT * FROM (SELECT id FROM big FETCH FIRST 10 ROWS ONLY) x JOIN other o ON o.id = x.id\nLIMIT 200',
					limit: 200,
					state: 'applied',
			});
		});

		it('does not mistake a FETCH inside a WITH body for the result bound', () => {
			assert.deepEqual(applyRowLimit('WITH r AS (SELECT id FROM big FETCH FIRST 10 ROWS ONLY) SELECT * FROM r', '200', 'postgres'), {
					sql: 'WITH r AS (SELECT id FROM big FETCH FIRST 10 ROWS ONLY) SELECT * FROM r\nLIMIT 200',
					limit: 200,
					state: 'applied',
			});
		});

		it('does not mistake a FETCH inside a parenthesised set-query member for the result bound', () => {
			assert.deepEqual(applyRowLimit('(SELECT 1 FETCH FIRST 1 ROW ONLY) UNION (SELECT 2)', '200', 'postgres'), {
					sql: '(SELECT 1 FETCH FIRST 1 ROW ONLY) UNION (SELECT 2)\nLIMIT 200',
					limit: 200,
					state: 'applied',
			});
		});

		it('reads a FETCH on the outer query of a read-only WITH chain as the result bound', () => {
			assert.deepEqual(applyRowLimit('WITH r AS (SELECT 1) SELECT * FROM r FETCH FIRST 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'WITH r AS (SELECT 1) SELECT * FROM r FETCH FIRST 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

	});

	describe('applyRowLimit — statements FETCH must not be mistaken for', () => {

		it('leaves a cursor FETCH NEXT statement alone', () => {
			// Not a SELECT, so returnsRows is false and the rewrite path is never
			// entered — the detection must stay inside the returnsRows gate rather
			// than being hoisted above it.
			assert.deepEqual(applyRowLimit('FETCH NEXT FROM mycursor', '200', 'postgres'), {
					sql: 'FETCH NEXT FROM mycursor',
					limit: null,
					state: 'none',
			});
		});

		it('leaves a cursor FETCH ALL statement alone', () => {
			assert.deepEqual(applyRowLimit('FETCH ALL FROM mycursor', '200', 'postgres'), {
					sql: 'FETCH ALL FROM mycursor',
					limit: null,
					state: 'none',
			});
		});

		it('leaves an INSERT ... SELECT ... FETCH FIRST statement alone', () => {
			// Non-row-returning: RETURNS_ROWS matches ^select only.
			assert.deepEqual(applyRowLimit('INSERT INTO archive SELECT * FROM orders FETCH FIRST 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'INSERT INTO archive SELECT * FROM orders FETCH FIRST 10 ROWS ONLY',
					limit: null,
					state: 'none',
			});
		});

		it('leaves a user-typed EXPLAIN of a FETCH-bounded statement alone', () => {
			assert.deepEqual(applyRowLimit('EXPLAIN SELECT * FROM orders FETCH FIRST 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'EXPLAIN SELECT * FROM orders FETCH FIRST 10 ROWS ONLY',
					limit: null,
					state: 'none',
			});
		});

		it('reports the FETCH bound for the SQL fed to the EXPLAIN drawer, not just the Run path', () => {
			// QueryView's explain drawer calls applyRowLimit and wraps the result's
			// .sql in `EXPLAIN (FORMAT JSON) <body>`; a FETCH statement that is
			// misread as unbounded would send the drawer an invalid plan request,
			// not just an invalid Run.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS ONLY', '200', 'postgres'), {
					sql: 'SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS ONLY',
					limit: null,
					state: 'in-statement',
			});
		});

	});

	describe('applyRowLimit — protections that must survive adding FETCH detection', () => {

		it('still reports a bare LIMIT statement as in-statement on every dialect', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM orders LIMIT 5', '200', 'postgres'), {
					sql: 'SELECT * FROM orders LIMIT 5',
					limit: null,
					state: 'in-statement',
			});
		});

		it('still treats a nested-only LIMIT as unbounded at the result and applies the limit', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM (SELECT id FROM big LIMIT 10) x JOIN other o ON o.id = x.id', '200', 'postgres'), {
					sql: 'SELECT * FROM (SELECT id FROM big LIMIT 10) x JOIN other o ON o.id = x.id\nLIMIT 200',
					limit: 200,
					state: 'applied',
			});
		});

		it('still joins the appended clause with a newline so it cannot land inside a trailing comment', () => {
			assert.deepEqual(applyRowLimit('SELECT * FROM orders -- daily', '200', 'postgres'), {
					sql: 'SELECT * FROM orders -- daily\nLIMIT 200',
					limit: 200,
					state: 'applied',
			});
		});

		it('still leaves a data-modifying WITH chain at none, not in-statement, regardless of dialect', () => {
			assert.deepEqual(applyRowLimit('WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone', '200', 'postgres'), {
					sql: 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone',
					limit: null,
					state: 'none',
			});
		});

		it('still treats a bare OFFSET, with no FETCH, as unbounded and applies the limit', () => {
			// The FETCH detection must not be widened to `offset`: a skip is not a cap.
			assert.deepEqual(applyRowLimit('SELECT * FROM orders ORDER BY id OFFSET 5 ROWS', '200', 'postgres'), {
					sql: 'SELECT * FROM orders ORDER BY id OFFSET 5 ROWS\nLIMIT 200',
					limit: 200,
					state: 'applied',
			});
		});

	});

	describe('applyRowLimit — the FETCH detection is dialect-independent', () => {

		it('reports the FETCH bound on mysql, unknown and clickhouse, not just postgres', () => {
			// MySQL has no FETCH FIRST clause at all, and this text is already
			// invalid MySQL — but the app must not ALSO add a clause the user
			// never typed. `unknown` is where a failed dialect probe lands, and
			// `clickhouse`'s documented synopsis includes FETCH like PostgreSQL's.
			// A dialect-gated detection would leave both broken.
			for (const dialect of ['mysql', 'unknown', 'clickhouse'] as const) {
				const statement = 'SELECT * FROM orders FETCH FIRST 10 ROWS ONLY';
				assert.deepEqual(applyRowLimit(statement, '200', dialect), { sql: statement, limit: null, state: 'in-statement' }, dialect);
			}
		});

	});
});
