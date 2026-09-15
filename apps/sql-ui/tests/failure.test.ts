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
});
