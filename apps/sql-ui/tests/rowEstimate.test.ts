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
// ROW ESTIMATE — how many rows a write would change, from a plain EXPLAIN
// =============================================================================
//
// The write confirmation says "about N rows" when the planner can say. The
// number comes from an EXPLAIN without ANALYZE, which plans and runs nothing:
// PostgreSQL's JSON plan (`Plan Rows` of the scan under ModifyTable) and
// MySQL's classic table (`rows` scaled by `filtered`). ClickHouse, and
// anything those two cannot explain, show "No estimate". The fixtures below
// are hand-built from the vendors' documented shapes, like explain.test.ts.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatement } from '../src/sql/classify';
import { gateStatement } from '../src/sql/gate';
import { needsConfirmation, parseRowEstimate, rowEstimateStatement, rowsChangeText } from '../src/sql/safety';
import type { WriteConfirmation } from '../src/sql/safety';

describe('rowEstimateStatement', () => {
	it('explains a PostgreSQL write as JSON and a MySQL write as the classic table, without ANALYZE', () => {
		assert.equal(rowEstimateStatement("UPDATE orders SET status = 'x' WHERE id < 10;", 'postgres'), "EXPLAIN (FORMAT JSON) UPDATE orders SET status = 'x' WHERE id < 10");
		assert.equal(rowEstimateStatement('DELETE FROM orders WHERE id < 10;', 'mysql'), 'EXPLAIN DELETE FROM orders WHERE id < 10');
		assert.equal(rowEstimateStatement('INSERT INTO a SELECT * FROM b', 'postgres'), 'EXPLAIN (FORMAT JSON) INSERT INTO a SELECT * FROM b');
	});

	it('is a read to the classifier and the gate, so it is never a write and may be repeated', () => {
		for (const [sql, dialect] of [['UPDATE orders SET a = 1', 'postgres'], ['DELETE FROM orders', 'mysql']] as const) {
			const statement = rowEstimateStatement(sql, dialect) as string;
			assert.doesNotMatch(statement, /analy[sz]e/i);
			assert.equal(classifyStatement(statement, dialect), 'read');
			assert.deepEqual(gateStatement(statement, dialect, true), { refusal: null, idempotent: true });
		}
	});

	it('is null on ClickHouse and unknown dialects', () => {
		assert.equal(rowEstimateStatement('ALTER TABLE t DELETE WHERE 1', 'clickhouse'), null);
		assert.equal(rowEstimateStatement('DELETE FROM t', 'clickhouse'), null);
		assert.equal(rowEstimateStatement('DELETE FROM t', 'unknown'), null);
	});

	it('is null for what the planner cannot estimate: DDL, TRUNCATE, WITH chains, SELECT … INTO, reads', () => {
		for (const sql of ['DROP TABLE orders', 'TRUNCATE orders', 'ALTER TABLE t ADD c int', 'WITH g AS (DELETE FROM t RETURNING *) SELECT * FROM g', 'SELECT * INTO archive FROM orders', 'SELECT 1']) {
			assert.equal(rowEstimateStatement(sql, 'postgres'), null, sql);
		}
	});
});

describe('parseRowEstimate: PostgreSQL', () => {
	const plan = (root: Record<string, unknown>) => [{ 'QUERY PLAN': [{ Plan: root }] }];

	it('reads the scan under ModifyTable (newer servers report 0 rows on ModifyTable itself)', () => {
		const rows = plan({ 'Node Type': 'ModifyTable', Operation: 'Update', 'Relation Name': 'orders', 'Plan Rows': 0, Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 20, Filter: "(status = 'paid'::text)" }] });
		assert.equal(parseRowEstimate('postgres', rows), 20);
	});

	it('reads the same plan when the driver returns the cell as a JSON string', () => {
		const rows = [{ 'QUERY PLAN': JSON.stringify([{ Plan: { 'Node Type': 'ModifyTable', 'Plan Rows': 0, Plans: [{ 'Node Type': 'Index Scan', 'Plan Rows': 1 }] } }]) }];
		assert.equal(parseRowEstimate('postgres', rows), 1);
	});

	it('reads the root when it is not a ModifyTable', () => {
		assert.equal(parseRowEstimate('postgres', plan({ 'Node Type': 'Result', 'Plan Rows': 3 })), 3);
	});

	it('gives none for a plan it cannot read', () => {
		assert.equal(parseRowEstimate('postgres', [{ 'QUERY PLAN': 'not json' }]), null);
		assert.equal(parseRowEstimate('postgres', [{ other: 1 }]), null);
		assert.equal(parseRowEstimate('postgres', plan({ 'Node Type': 'ModifyTable', Plans: [{ 'Node Type': 'Seq Scan' }] })), null);
		assert.equal(parseRowEstimate('postgres', []), null);
	});
});

describe('parseRowEstimate: MySQL', () => {
	it('reads the target table\'s rows scaled by filtered', () => {
		const rows = [{ id: 1, select_type: 'UPDATE', table: 'orders', partitions: null, type: 'ALL', possible_keys: null, key: null, key_len: null, ref: null, rows: 40, filtered: 50, Extra: 'Using where' }];
		assert.equal(parseRowEstimate('mysql', rows), 20);
	});

	it('takes filtered as the numeric text MySQL may send', () => {
		assert.equal(parseRowEstimate('mysql', [{ select_type: 'DELETE', table: 'orders', rows: '12', filtered: '100.00' }]), 12);
	});

	it('picks the write\'s own row over a subquery\'s', () => {
		const rows = [
			{ id: 1, select_type: 'DELETE', table: 'orders', rows: 7, filtered: 100 },
			{ id: 2, select_type: 'SUBQUERY', table: 'stale', rows: 1000, filtered: 100 },
		];
		assert.equal(parseRowEstimate('mysql', rows), 7);
	});

	it('gives none when the row count is missing', () => {
		assert.equal(parseRowEstimate('mysql', [{ select_type: 'INSERT', table: 'orders', rows: null, filtered: null }]), null);
	});
});

describe('parseRowEstimate: other dialects', () => {
	it('gives none on ClickHouse and unknown dialects', () => {
		assert.equal(parseRowEstimate('clickhouse', [{ explain: 'Expression' }]), null);
		assert.equal(parseRowEstimate('unknown', [{ rows: 3 }]), null);
	});
});

describe('rowsChangeText', () => {
	const ask = (sql: string) => needsConfirmation(sql, 'postgres', 'every') as WriteConfirmation;

	it('says "about N rows" for an estimate, "Estimating…" while it runs and "No estimate" otherwise', () => {
		const sql = 'UPDATE orders SET a = 1 WHERE id < 10';
		assert.equal(rowsChangeText(ask(sql), sql, { state: 'rows', rows: 1234 }), `about ${(1234).toLocaleString()} rows (planner estimate)`);
		assert.equal(rowsChangeText(ask(sql), sql, { state: 'rows', rows: 1 }), 'about 1 row (planner estimate)');
		assert.equal(rowsChangeText(ask(sql), sql, { state: 'estimating' }), 'Estimating…');
		assert.equal(rowsChangeText(ask(sql), sql, { state: 'none' }), 'No estimate');
	});

	it('says every row for a whole-table UPDATE or DELETE, with the planner\'s number beside it (DA-R1 M3)', () => {
		const sql = 'DELETE FROM orders';
		assert.equal(rowsChangeText(ask(sql), sql, { state: 'rows', rows: 3 }), 'Every row (about 3 by the planner\'s estimate)');
		assert.equal(rowsChangeText(ask(sql), sql, { state: 'estimating' }), 'Every row');
		assert.equal(rowsChangeText(ask(sql), sql, { state: 'none' }), 'Every row');
	});

	it('says a LIMIT or a join can make the estimate wrong', () => {
		const mysql = (sql: string) => needsConfirmation(sql, 'mysql', 'every') as WriteConfirmation;
		for (const sql of ['DELETE FROM orders LIMIT 10', 'UPDATE orders o JOIN customers c ON c.id = o.customer_id SET o.note = NULL WHERE c.active = 0']) {
			assert.equal(rowsChangeText(mysql(sql), sql, { state: 'rows', rows: 3 }), 'about 3 rows (planner estimate, which may be wrong for a LIMIT or a join)', sql);
		}
	});

	it('says every row for TRUNCATE, and has no line for other schema changes', () => {
		assert.equal(rowsChangeText(ask('TRUNCATE orders'), 'TRUNCATE orders', { state: 'none' }), 'Every row');
		assert.equal(rowsChangeText(ask('DROP TABLE orders'), 'DROP TABLE orders', { state: 'none' }), null);
		assert.equal(rowsChangeText(ask('ALTER TABLE t ADD c int'), 'ALTER TABLE t ADD c int', { state: 'none' }), null);
	});
});
