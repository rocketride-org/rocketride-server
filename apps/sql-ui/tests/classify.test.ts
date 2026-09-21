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
// SQL CLASSIFY — unit tests for statement kinds and the pattern check
// =============================================================================
//
// Two contracts, both safety-relevant:
//   1. `classifyStatement` decides whether the runner may pass
//      `idempotent: true` (which permits ONE silent retry with a fresh token).
//      A statement that changes data must never be classified 'read'.
//   2. `patternCheck` is a TEXT heuristic. Its job is to be honest about what
//      it can and cannot see; the false positives it is allowed to have are
//      pinned here so nobody "fixes" them into false negatives.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlDialect } from '../src/connect';
import type { StatementKind } from '../src/sql/classify';
import { classifyStatement, patternCheck } from '../src/sql/classify';

// =============================================================================
// CLASSIFICATION
// =============================================================================

/** One classification case. */
interface IKindCase {
	/** The statement text. */
	sql: string;
	/** The kind it must be reported as. */
	kind: StatementKind;
	/** Dialect to classify with; the default covers most cases. */
	dialect?: SqlDialect;
}

const KIND_CASES: IKindCase[] = [
	// Reads.
	{ sql: 'SELECT 1', kind: 'read' },
	{ sql: '  select * from orders  ', kind: 'read' },
	{ sql: '(SELECT 1) UNION (SELECT 2)', kind: 'read' },
	{ sql: '-- a note\nSELECT 1', kind: 'read' },
	{ sql: '/* lead */ SELECT 1', kind: 'read' },
	{ sql: 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent', kind: 'read' },
	// A WITH chain is judged on CODE: a verb inside a literal, a dollar-quoted
	// body or a quoted identifier is not a write. The quoted-identifier row is
	// the one that turns up in practice; MySQL reserves `delete`, so a table
	// of that name needs the quotes there, while PostgreSQL does not reserve
	// it and does not need them.
	{ sql: "WITH d AS (SELECT 'delete me' AS t) SELECT * FROM d", kind: 'read' },
	{ sql: 'WITH d AS (SELECT 1) SELECT * FROM "delete"', kind: 'read' },
	{ sql: 'WITH d AS (SELECT $$delete from orders$$ AS t) SELECT 1', kind: 'read', dialect: 'postgres' },
	{ sql: 'WITH d AS (SELECT 1) SELECT * FROM `delete`', kind: 'read', dialect: 'mysql' },
	{ sql: 'SHOW TABLES', kind: 'read' },
	{ sql: 'SHOW CREATE TABLE orders', kind: 'read' },
	{ sql: 'EXPLAIN SELECT * FROM orders', kind: 'read' },
	{ sql: 'EXPLAIN FORMAT=JSON SELECT * FROM orders', kind: 'read' },
	{ sql: 'EXPLAIN (FORMAT JSON) SELECT * FROM orders', kind: 'read' },
	{ sql: 'DESCRIBE orders', kind: 'read' },
	{ sql: 'DESC orders', kind: 'read' },
	{ sql: 'VALUES (1)', kind: 'other' },

	// EXPLAIN ANALYZE really runs the statement — never 'read'.
	{ sql: 'EXPLAIN ANALYZE DELETE FROM orders', kind: 'write' },
	{ sql: 'EXPLAIN (ANALYZE, BUFFERS) UPDATE orders SET a = 1', kind: 'write' },
	{ sql: 'EXPLAIN ANALYZE SELECT * FROM orders', kind: 'read' },

	// Writes.
	{ sql: 'INSERT INTO orders (id) VALUES (1)', kind: 'write' },
	{ sql: 'UPDATE orders SET total = 1', kind: 'write' },
	{ sql: 'DELETE FROM orders', kind: 'write' },
	{ sql: 'REPLACE INTO orders (id) VALUES (1)', kind: 'write' },
	{ sql: 'MERGE INTO orders USING staging ON (1=1)', kind: 'write' },
	{ sql: 'TRUNCATE TABLE orders', kind: 'write' },
	{ sql: 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone', kind: 'write' },
	// Conservative on purpose: `update` here is real code at depth 0, even
	// though FOR UPDATE only locks. Over-classifying costs a retry, not data.
	{ sql: 'WITH a AS (SELECT 1) SELECT * FROM a FOR UPDATE', kind: 'write' },

	// DDL.
	{ sql: 'CREATE TABLE t (id INT)', kind: 'ddl' },
	{ sql: 'ALTER TABLE t ADD COLUMN c INT', kind: 'ddl' },
	{ sql: 'DROP TABLE t', kind: 'ddl' },
	{ sql: 'RENAME TABLE a TO b', kind: 'ddl' },
	{ sql: 'CREATE INDEX ix ON t (id)', kind: 'ddl' },

	// Transaction control.
	{ sql: 'BEGIN', kind: 'tx' },
	{ sql: 'START TRANSACTION', kind: 'tx' },
	{ sql: 'COMMIT', kind: 'tx' },
	{ sql: 'ROLLBACK', kind: 'tx' },
	{ sql: 'ROLLBACK TO SAVEPOINT s1', kind: 'tx' },
	{ sql: 'SAVEPOINT s1', kind: 'tx' },
	{ sql: 'RELEASE SAVEPOINT s1', kind: 'tx' },
	{ sql: 'SET autocommit = 0', kind: 'tx' },
	{ sql: 'SET GLOBAL autocommit = 0', kind: 'tx' },
	{ sql: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', kind: 'tx' },
	{ sql: 'SET SESSION TRANSACTION READ ONLY', kind: 'tx' },

	// Everything else.
	{ sql: 'SET @x = 1', kind: 'other' },
	{ sql: 'USE sample_shop', kind: 'other' },
	{ sql: 'CALL do_thing()', kind: 'other' },
	{ sql: 'GRANT SELECT ON t TO u', kind: 'other' },
	{ sql: '', kind: 'other' },
	{ sql: '-- only a comment', kind: 'other' },
];

describe('classifyStatement', () => {
	for (const testCase of KIND_CASES) {
		it(`${JSON.stringify(testCase.sql)} -> ${testCase.kind}`, () => {
			assert.equal(classifyStatement(testCase.sql, testCase.dialect), testCase.kind);
		});
	}

	it('ignores a keyword that only appears inside a literal', () => {
		assert.equal(classifyStatement("SELECT 'DELETE FROM orders' AS t"), 'read');
	});

	it('does not match a keyword inside a longer word', () => {
		assert.equal(classifyStatement('SELECT deleted_at FROM orders'), 'read');
	});

	it('agrees with the pattern check about read-only WITH chains', () => {
		// The two judgements disagreeing is what this whole review round is
		// about: one said write while the other said there was nothing to
		// confirm. On a read-only chain both must be quiet.
		const chains: [string, SqlDialect][] = [
			["WITH d AS (SELECT 'delete me' AS t) SELECT * FROM d", 'unknown'],
			['WITH d AS (SELECT 1) SELECT * FROM "delete"', 'unknown'],
			['WITH d AS (SELECT $$delete from orders$$ AS t) SELECT 1', 'postgres'],
		];
		for (const [sql, dialect] of chains) {
			assert.equal(classifyStatement(sql, dialect), 'read', sql);
			assert.equal(patternCheck(sql, dialect), null, sql);
		}
	});
});

// =============================================================================
// PATTERN CHECK
// =============================================================================

describe('patternCheck', () => {
	it('flags DELETE with no WHERE', () => {
		assert.deepEqual(patternCheck('DELETE FROM orders'), { kind: 'DELETE without WHERE' });
	});

	it('passes DELETE with a top-level WHERE', () => {
		assert.equal(patternCheck('DELETE FROM orders WHERE id = 5'), null);
	});

	it('passes DELETE whose WHERE holds a subquery', () => {
		assert.equal(patternCheck('DELETE FROM orders WHERE id IN (SELECT id FROM stale)'), null);
	});

	it('flags UPDATE with no WHERE', () => {
		assert.deepEqual(patternCheck('UPDATE orders SET total = 0'), { kind: 'UPDATE without WHERE' });
	});

	it('passes UPDATE with a top-level WHERE', () => {
		assert.equal(patternCheck('UPDATE orders SET total = 0 WHERE id = 5'), null);
	});

	it('does NOT count a WHERE that only exists inside a string literal', () => {
		assert.deepEqual(patternCheck("UPDATE orders SET note = 'where it went'"), { kind: 'UPDATE without WHERE' });
	});

	it('does NOT count a WHERE that only exists inside a comment', () => {
		assert.deepEqual(patternCheck('DELETE FROM orders -- WHERE id = 5'), { kind: 'DELETE without WHERE' });
	});

	it('flags a WHERE that only exists inside a subquery (documented false positive)', () => {
		assert.deepEqual(
			patternCheck('DELETE FROM orders USING (SELECT id FROM stale WHERE x) s'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('flags TRUNCATE', () => {
		assert.deepEqual(patternCheck('TRUNCATE TABLE orders'), { kind: 'TRUNCATE' });
	});

	it('flags DROP', () => {
		assert.deepEqual(patternCheck('DROP TABLE orders'), { kind: 'DROP' });
	});

	it('flags ALTER', () => {
		assert.deepEqual(patternCheck('ALTER TABLE orders ADD COLUMN c INT'), { kind: 'ALTER' });
	});

	it('passes a plain SELECT', () => {
		assert.equal(patternCheck('SELECT * FROM orders'), null);
	});

	it('passes an INSERT', () => {
		assert.equal(patternCheck('INSERT INTO orders (id) VALUES (1)'), null);
	});

	it('passes a commented-out DELETE', () => {
		assert.equal(patternCheck('-- DELETE FROM orders\nSELECT 1'), null);
	});

	it('flags a mysql multi-table DELETE with no WHERE', () => {
		assert.deepEqual(patternCheck('DELETE a FROM orders a'), { kind: 'DELETE without WHERE' });
	});

	it('flags a clickhouse ALTER ... DELETE as ALTER', () => {
		assert.deepEqual(patternCheck('ALTER TABLE orders DELETE WHERE id = 5'), { kind: 'ALTER' });
	});

	it('does not read a non-ASCII alias as a WHERE clause', () => {
		// `where\u00e9` is a legal PostgreSQL identifier. JavaScript's \b sees a
		// word boundary between `where` and `\u00e9`, so the alias satisfied the
		// WHERE test and a full-table delete went unasked.
		assert.deepEqual(
			patternCheck('DELETE FROM t where\u00e9'),
			{ kind: 'DELETE without WHERE' },
		);
		assert.deepEqual(
			patternCheck('DELETE FROM t AS where\u00e9'),
			{ kind: 'DELETE without WHERE' },
		);
		assert.deepEqual(
			patternCheck('UPDATE t where\u00e9 SET x = 1'),
			{ kind: 'UPDATE without WHERE' },
		);
		assert.deepEqual(
			patternCheck('DELETE FROM t \u00e9where'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('still reads an ASCII alias and a real WHERE correctly', () => {
		assert.deepEqual(patternCheck('DELETE FROM t where_e'), { kind: 'DELETE without WHERE' });
		assert.deepEqual(patternCheck('DELETE FROM t whereX'), { kind: 'DELETE without WHERE' });
		assert.equal(patternCheck('DELETE FROM t WHERE id = 1'), null);
	});
});

// =============================================================================
// PATTERN CHECK — EXPLAIN
// =============================================================================
//
// `EXPLAIN ANALYZE` RUNS the statement it describes (PostgreSQL: "the
// statement is actually executed when the ANALYZE option is used"; MySQL
// 8.0.19+ the same), and this app commits every call on its own, so the
// dialog has to see through the prefix. A plain EXPLAIN runs nothing.
// =============================================================================

describe('patternCheck — EXPLAIN', () => {
	it('flags the DELETE that EXPLAIN ANALYZE would run', () => {
		assert.deepEqual(
			patternCheck('EXPLAIN ANALYZE DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('flags through a parenthesised option list', () => {
		assert.deepEqual(
			patternCheck('EXPLAIN (ANALYZE, BUFFERS) UPDATE orders SET x = 1'),
			{ kind: 'UPDATE without WHERE' },
		);
	});

	it('flags a WITH-led statement behind ANALYZE', () => {
		assert.deepEqual(
			patternCheck('EXPLAIN ANALYZE WITH a AS (SELECT 1) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('passes when the statement it would run is bounded', () => {
		assert.equal(patternCheck('EXPLAIN ANALYZE DELETE FROM orders WHERE id = 1'), null);
	});

	it('passes a plain EXPLAIN, which runs nothing', () => {
		assert.equal(patternCheck('EXPLAIN DELETE FROM orders'), null);
	});

	it('passes an EXPLAIN whose options do not include ANALYZE', () => {
		assert.equal(patternCheck('EXPLAIN (FORMAT JSON) DELETE FROM orders'), null);
	});

	it('passes EXPLAIN ANALYZE of a read', () => {
		assert.equal(patternCheck('EXPLAIN ANALYZE SELECT * FROM orders'), null);
	});

	it('agrees with the classification, which already calls these writes', () => {
		// The two judgements disagreeing about EXPLAIN ANALYZE is what let a
		// full-table delete through: classify says write, the dialog said
		// nothing.
		assert.equal(classifyStatement('EXPLAIN ANALYZE DELETE FROM orders'), 'write');
		assert.notEqual(patternCheck('EXPLAIN ANALYZE DELETE FROM orders'), null);
	});
});

// =============================================================================
// PATTERN CHECK — WITH-LED STATEMENTS
// =============================================================================
//
// PostgreSQL lets the statement after a `WITH` chain be data-modifying, so
// `WITH audit AS (...) DELETE FROM orders` is ordinary SQL that deletes every
// row. The leading-keyword test cannot see past the chain, and the two
// judgements this file makes must not disagree about whether `WITH` exists:
// `classifyStatement` already calls both shapes below a write.
// =============================================================================

describe('patternCheck — a WITH chain carrying the verb', () => {
	it('flags a CTE-prefixed DELETE with no WHERE', () => {
		assert.deepEqual(
			patternCheck('WITH audit AS (SELECT id FROM orders) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('passes a CTE-prefixed DELETE with a top-level WHERE', () => {
		assert.equal(
			patternCheck('WITH audit AS (SELECT id FROM orders) DELETE FROM orders WHERE id = 5'),
			null,
		);
	});

	it('flags a CTE-prefixed UPDATE with no WHERE', () => {
		assert.deepEqual(
			patternCheck('WITH audit AS (SELECT id FROM orders) UPDATE orders SET total = 0'),
			{ kind: 'UPDATE without WHERE' },
		);
	});

	it('passes a CTE-prefixed UPDATE with a top-level WHERE', () => {
		assert.equal(
			patternCheck('WITH audit AS (SELECT id FROM orders) UPDATE orders SET total = 0 WHERE id = 5'),
			null,
		);
	});

	it('does NOT count a WHERE that only exists inside the CTE body', () => {
		assert.deepEqual(
			patternCheck('WITH audit AS (SELECT id FROM orders WHERE id > 5) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('sees the verb through a leading line comment and past a literal', () => {
		assert.deepEqual(
			patternCheck("-- note\nWITH a AS (SELECT 'delete where' AS t) DELETE FROM orders"),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('does NOT count a WHERE that only exists inside a trailing block comment', () => {
		assert.deepEqual(
			patternCheck('WITH a AS (SELECT 1) DELETE FROM orders /* WHERE id = 1 */'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('ignores quoted identifiers spelled like the keywords', () => {
		assert.deepEqual(
			patternCheck('WITH "with" AS (SELECT 1) DELETE FROM "where"'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('flags an UPDATE after several CTEs', () => {
		assert.deepEqual(
			patternCheck('WITH a AS (SELECT 1), b AS (SELECT 2) UPDATE orders SET x = 1'),
			{ kind: 'UPDATE without WHERE' },
		);
	});

	it('passes an UPDATE after several CTEs when it carries a WHERE', () => {
		assert.equal(
			patternCheck('WITH a AS (SELECT 1), b AS (SELECT 2) UPDATE orders SET x = 1 WHERE x = 2'),
			null,
		);
	});

	it('flags a DELETE after a RECURSIVE chain', () => {
		assert.deepEqual(
			patternCheck('WITH RECURSIVE t AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('passes a read-only chain whose CTE only names a column like the verb', () => {
		assert.equal(patternCheck('WITH d AS (SELECT deleted_at FROM orders) SELECT * FROM d'), null);
	});

	it('passes a read-only chain whose CTE only holds the verb in a literal', () => {
		assert.equal(patternCheck("WITH d AS (SELECT 'DELETE FROM orders' AS t) SELECT * FROM d"), null);
	});

	it('passes a postgres chain whose dollar-quoted body holds the verb', () => {
		assert.equal(
			patternCheck('WITH d AS (SELECT $$delete from orders$$ AS t) SELECT * FROM d', 'postgres'),
			null,
		);
	});

	it('does NOT count a WHERE inside a mysql # comment', () => {
		assert.deepEqual(
			patternCheck('WITH a AS (SELECT 1) DELETE FROM orders # WHERE id = 1', 'mysql'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('flags a CTE-prefixed DELETE that joins the CTE with USING', () => {
		assert.deepEqual(
			patternCheck('WITH a AS (SELECT id FROM stale) DELETE FROM t USING a'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('passes a WITH-led SELECT whose FOR UPDATE is a locking clause', () => {
		// The verb is the FIRST statement leader at depth 0, and that is the
		// SELECT. `FOR UPDATE` locks rows; calling it an unbounded UPDATE
		// would be a confirmation for something that writes nothing.
		assert.equal(patternCheck('WITH a AS (SELECT 1) SELECT * FROM a FOR UPDATE'), null);
	});

	it('passes a WITH-led SELECT ... FOR UPDATE in mysql too', () => {
		assert.equal(patternCheck('WITH a AS (SELECT 1) SELECT * FROM a FOR UPDATE', 'mysql'), null);
	});

	it('passes a WITH-led upsert whose DO UPDATE trails the INSERT', () => {
		assert.equal(
			patternCheck('WITH src AS (SELECT 1 AS id) INSERT INTO t SELECT id FROM src ON CONFLICT (id) DO UPDATE SET id = excluded.id'),
			null,
		);
	});

	it('passes a WITH-led MERGE whose UPDATE is one of its actions', () => {
		assert.equal(
			patternCheck('WITH a AS (SELECT 1) MERGE INTO t USING a ON (1 = 1) WHEN MATCHED THEN UPDATE SET x = 1'),
			null,
		);
	});

	it('reads past a CTE NAMED after a statement keyword', () => {
		// PostgreSQL lists INSERT, UPDATE, DELETE and MERGE as non-reserved, so
		// `WITH merge AS (...)` is a legal chain. Such a name must not be
		// mistaken for the statement's verb, or the DELETE behind it goes
		// unasked — the very false negative this check exists to close.
		assert.deepEqual(
			patternCheck('WITH merge AS (SELECT 1) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
		assert.deepEqual(
			patternCheck('WITH RECURSIVE merge AS (SELECT 1) UPDATE orders SET x = 1'),
			{ kind: 'UPDATE without WHERE' },
		);
		assert.deepEqual(
			patternCheck('WITH update AS (SELECT 1) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
		assert.deepEqual(
			patternCheck('WITH merge AS MATERIALIZED (SELECT 1) UPDATE orders SET x = 1'),
			{ kind: 'UPDATE without WHERE' },
		);
	});

	it('reads past such a CTE name when it carries a column list', () => {
		// `name (a, b) AS (...)`: the `(` follows the name, not `AS`. No real
		// statement puts `(` straight after INSERT, UPDATE, DELETE or MERGE.
		assert.deepEqual(
			patternCheck('WITH merge (x) AS (SELECT 1) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('still passes a read whose CTE is named after a statement keyword', () => {
		assert.equal(patternCheck('WITH merge AS (SELECT 1) SELECT * FROM merge'), null);
		assert.equal(patternCheck('WITH delete (x) AS (SELECT 1) SELECT * FROM delete'), null);
	});

	it('reads a mysql multi-table UPDATE whose first table is derived', () => {
		// MySQL puts `(` straight after the verb here, which the column-list
		// rule alone mistook for a CTE name. A name is followed by the CTE
		// grammar: an optional column list, then `AS`, then the body.
		assert.deepEqual(
			patternCheck('WITH a AS (SELECT 1) UPDATE (SELECT 1 AS id) AS d JOIN t ON t.id = d.id SET t.x = 1', 'mysql'),
			{ kind: 'UPDATE without WHERE' },
		);
	});

	it('reads the CTE grammar in its other spellings', () => {
		assert.deepEqual(
			patternCheck('WITH merge AS NOT MATERIALIZED (SELECT 1) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
		assert.deepEqual(
			patternCheck('WITH merge AS(SELECT 1) DELETE FROM orders'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('is not confused by a parenthesis inside a literal column list', () => {
		// The column list is walked on masked text, so this `(` is a space
		// and the list still closes where it really closes.
		assert.deepEqual(
			patternCheck("WITH merge ('(') AS (SELECT 1) DELETE FROM orders"),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('reads that statement the same way with and without the chain', () => {
		const withChain = patternCheck('WITH a AS (SELECT 1) UPDATE (SELECT 1 AS id) AS d JOIN t ON t.id = d.id SET t.x = 1', 'mysql');
		const bare = patternCheck('UPDATE (SELECT 1 AS id) AS d JOIN t ON t.id = d.id SET t.x = 1', 'mysql');
		assert.deepEqual(withChain, bare);
	});

	it('does not read a parenthesised SELECT as a CTE name', () => {
		// SELECT, VALUES and TABLE are reserved and can never be names, so a
		// `(` after them is an expression. Treating one as a name would step
		// past the SELECT and read a trailing FOR UPDATE as the verb.
		assert.equal(patternCheck('WITH a AS (SELECT 1) SELECT (1 + 2)'), null);
		assert.equal(patternCheck('WITH a AS (SELECT 1) SELECT (1) FROM a FOR UPDATE'), null);
	});

	it('passes a WITH-led parenthesised set expression', () => {
		// No statement leader sits at depth 0 at all: every branch of the
		// UNION is parenthesised.
		assert.equal(patternCheck('WITH a AS (SELECT 1) (SELECT * FROM a) UNION (SELECT 2)'), null);
	});
});

// =============================================================================
// PATTERN CHECK — A MUTATION INSIDE THE WITH CLAUSE
// =============================================================================
//
// A data-modifying CTE runs even when the outer statement is a SELECT, and a
// `WHERE` at depth >= 1 cannot be attributed to it by a text check — so this
// finding never claims "without WHERE". The outer rule is more specific and
// wins when both apply.
// =============================================================================

describe('patternCheck — a mutation inside the WITH clause', () => {
	it('flags a DELETE inside a CTE body', () => {
		assert.deepEqual(
			patternCheck('WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('flags an UPDATE inside a CTE body', () => {
		assert.deepEqual(
			patternCheck('WITH bumped AS (UPDATE orders SET total = 0 RETURNING *) SELECT * FROM bumped'),
			{ kind: 'UPDATE inside a WITH clause' },
		);
	});

	it('reports the outer unbounded DELETE, which is the more specific finding', () => {
		assert.deepEqual(
			patternCheck('WITH x AS (DELETE FROM a RETURNING id) DELETE FROM b'),
			{ kind: 'DELETE without WHERE' },
		);
	});

	it('reports the inner DELETE when the outer WHERE does not constrain it', () => {
		assert.deepEqual(
			patternCheck('WITH x AS (DELETE FROM a RETURNING id) DELETE FROM b WHERE id IN (SELECT id FROM x)'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('never claims "without WHERE" about a CTE mutation that has one', () => {
		assert.deepEqual(
			patternCheck('WITH g AS (DELETE FROM orders WHERE id IN (SELECT id FROM stale) RETURNING *) SELECT 1'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('does not apply the depth rule to a statement that is not WITH-led', () => {
		assert.equal(patternCheck('DELETE FROM orders WHERE id IN (SELECT id FROM (SELECT 1) s)'), null);
	});

	it('passes an INSERT inside a CTE, as a top-level INSERT passes too', () => {
		assert.equal(
			patternCheck('WITH ins AS (INSERT INTO orders (id) VALUES (1) RETURNING id) SELECT * FROM ins'),
			null,
		);
	});

	it('names the verb that comes first when a chain holds both', () => {
		assert.deepEqual(
			patternCheck('WITH u AS (UPDATE a SET x = 1 RETURNING id), d AS (DELETE FROM b RETURNING id) SELECT 1'),
			{ kind: 'UPDATE inside a WITH clause' },
		);
		assert.deepEqual(
			patternCheck('WITH d AS (DELETE FROM b RETURNING id), u AS (UPDATE a SET x = 1 RETURNING id) SELECT 1'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('does not let a verb inside a literal decide which one came first', () => {
		assert.deepEqual(
			patternCheck("WITH n AS (SELECT 'delete me' AS t), u AS (UPDATE a SET x = 1 RETURNING id), d AS (DELETE FROM b RETURNING id) SELECT 1"),
			{ kind: 'UPDATE inside a WITH clause' },
		);
	});

	it('flags a CTE mutation laid out across lines', () => {
		assert.deepEqual(
			patternCheck('WITH x AS (\n\tDELETE FROM t\n) SELECT 1'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('flags a CTE mutation behind a MATERIALIZED hint', () => {
		assert.deepEqual(
			patternCheck('WITH x AS MATERIALIZED (DELETE FROM t RETURNING *) SELECT 1'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('flags a CTE mutation behind a comment inside the body', () => {
		assert.deepEqual(
			patternCheck('WITH x AS ( /* gone */ DELETE FROM t RETURNING *) SELECT 1'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('passes a CTE whose FOR UPDATE only locks rows', () => {
		// Inside the body but not opening it: the clause belongs to the
		// SELECT that does open it, and nothing is written.
		assert.equal(patternCheck('WITH a AS (SELECT * FROM t FOR UPDATE) SELECT 1'), null);
	});

	it('flags a CTE body that carries its own WITH chain', () => {
		// A DELETE may take its own read-only WITH clause, so the verb does not
		// touch the parenthesis that opens the body. The body's verb is its
		// first leader, not whatever sits nearest the bracket.
		assert.deepEqual(
			patternCheck('WITH a AS (WITH b AS (SELECT 1) DELETE FROM t RETURNING *) SELECT * FROM a'),
			{ kind: 'DELETE inside a WITH clause' },
		);
		assert.deepEqual(
			patternCheck('WITH a AS (WITH b AS (SELECT 1) UPDATE t SET x = 1 RETURNING *) SELECT * FROM a'),
			{ kind: 'UPDATE inside a WITH clause' },
		);
	});

	it('flags such a body when it is the second CTE', () => {
		assert.deepEqual(
			patternCheck('WITH a AS (SELECT 1), b AS (WITH c AS (SELECT 2) DELETE FROM t) SELECT 1'),
			{ kind: 'DELETE inside a WITH clause' },
		);
	});

	it('passes a nested chain whose inner CTE is named after a keyword', () => {
		assert.equal(
			patternCheck('WITH a AS (WITH delete AS (SELECT 1) SELECT * FROM delete) SELECT 1'),
			null,
		);
	});

	it('passes a CTE upsert whose DO UPDATE trails its INSERT', () => {
		assert.equal(
			patternCheck('WITH ins AS (INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET v = 1) SELECT 1'),
			null,
		);
	});
});
