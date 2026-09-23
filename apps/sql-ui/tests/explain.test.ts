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
// SQL EXPLAIN — unit tests for the plan statement builder and plan parsers
// =============================================================================
//
// FIXTURE PROVENANCE: every fixture below is hand-built from vendor
// documentation (MySQL 8.0 EXPLAIN FORMAT=JSON, PostgreSQL EXPLAIN (FORMAT
// JSON), ClickHouse EXPLAIN), NOT captured from a live server — none was
// reachable. These tests pin the parsers' behaviour against the documented
// shapes and against malformed input; they do not prove a real server's output
// parses.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IPlanNode } from '../src/sql/explain';
import { buildExplain, countPlanNodes, formatRawPlan, parseExplain, planNotes } from '../src/sql/explain';

// =============================================================================
// FIXTURES
// =============================================================================

/** MySQL `EXPLAIN FORMAT=JSON` document: a two-table nested loop join. */
const MYSQL_PLAN = {
	query_block: {
		select_id: 1,
		cost_info: { query_cost: '10.50' },
		nested_loop: [
			{
				table: {
					table_name: 'orders',
					access_type: 'ALL',
					possible_keys: ['idx_customer'],
					rows_examined_per_scan: 1204,
					rows_produced_per_join: 1204,
					filtered: '100.00',
					cost_info: { read_cost: '1.00', eval_cost: '0.20', prefix_cost: '1.20' },
					attached_condition: '(`shop`.`orders`.`total` > 10)',
				},
			},
			{
				table: {
					table_name: 'customers',
					access_type: 'eq_ref',
					key: 'PRIMARY',
					key_length: '4',
					ref: ['shop.orders.customer_id'],
					rows_examined_per_scan: 1,
					filtered: '100.00',
				},
			},
		],
	},
};

/** PostgreSQL `EXPLAIN (FORMAT JSON)` document: a nested loop over two scans. */
const POSTGRES_PLAN = [
	{
		Plan: {
			'Node Type': 'Nested Loop',
			'Join Type': 'Inner',
			'Startup Cost': 0.29,
			'Total Cost': 16.36,
			'Plan Rows': 4,
			'Plan Width': 72,
			Plans: [
				{
					'Node Type': 'Seq Scan',
					'Parent Relationship': 'Outer',
					'Relation Name': 'orders',
					Alias: 'o',
					'Startup Cost': 0,
					'Total Cost': 1.04,
					'Plan Rows': 4,
					'Plan Width': 16,
				},
				{
					'Node Type': 'Index Scan',
					'Parent Relationship': 'Inner',
					'Relation Name': 'customers',
					Alias: 'c',
					'Index Name': 'customers_pkey',
					'Startup Cost': 0.29,
					'Total Cost': 3.31,
					'Plan Rows': 1,
					'Plan Width': 60,
				},
			],
		},
	},
];

/** ClickHouse `EXPLAIN` output: indented text rows in an `explain` column. */
const CLICKHOUSE_ROWS = [
	{ explain: 'Expression ((Projection + Before ORDER BY))' },
	{ explain: '  Aggregating' },
	{ explain: '    Expression (Before GROUP BY)' },
	{ explain: '      ReadFromMergeTree (default.hits)' },
];

/**
 * Find a node by label anywhere in a plan tree.
 *
 * @param node - The root to search from.
 * @param label - The label to match exactly.
 * @returns The first matching node, or null.
 */
function findNode(node: IPlanNode, label: string): IPlanNode | null {
	if (node.label === label) return node;
	for (const child of node.children) {
		const hit = findNode(child, label);
		if (hit) return hit;
	}
	return null;
}

// =============================================================================
// BUILD
// =============================================================================

describe('buildExplain', () => {
	it('prefixes the dialect form and leaves the statement otherwise untouched', () => {
		assert.equal(buildExplain('mysql', 'SELECT 1'), 'EXPLAIN FORMAT=JSON SELECT 1');
		assert.equal(buildExplain('postgres', 'SELECT 1'), 'EXPLAIN (FORMAT JSON) SELECT 1');
		assert.equal(buildExplain('clickhouse', 'SELECT 1'), 'EXPLAIN SELECT 1');
	});

	it('explains the statement exactly as it would run, applied LIMIT included', () => {
		const sql = 'SELECT * FROM orders WHERE total > 10 LIMIT 200';
		assert.equal(buildExplain('postgres', sql), `EXPLAIN (FORMAT JSON) ${sql}`);
	});

	it('strips exactly one trailing semicolon', () => {
		assert.equal(buildExplain('mysql', 'SELECT 1;'), 'EXPLAIN FORMAT=JSON SELECT 1');
		assert.equal(buildExplain('mysql', 'SELECT 1 ;  '), 'EXPLAIN FORMAT=JSON SELECT 1');
		// Only ONE: an empty second statement must not be silently swallowed.
		assert.equal(buildExplain('mysql', 'SELECT 1;;'), 'EXPLAIN FORMAT=JSON SELECT 1;');
	});

	it('never emits ANALYZE (plain EXPLAIN plans, it does not execute)', () => {
		for (const dialect of ['mysql', 'postgres', 'clickhouse'] as const) {
			assert.equal(buildExplain(dialect, 'DELETE FROM orders')?.includes('ANALYZE'), false);
		}
	});

	it('returns null for dialects with no EXPLAIN support here, and for empty text', () => {
		assert.equal(buildExplain('neo4j', 'MATCH (n) RETURN n'), null);
		assert.equal(buildExplain('unknown', 'SELECT 1'), null);
		assert.equal(buildExplain('mysql', '   '), null);
		assert.equal(buildExplain('mysql', ';'), null);
	});
});

// =============================================================================
// MYSQL
// =============================================================================

describe('parseExplain — mysql', () => {
	it('parses the JSON string in the EXPLAIN column into a query_block tree', () => {
		const result = parseExplain('mysql', [{ EXPLAIN: JSON.stringify(MYSQL_PLAN) }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.root.label, 'query_block');
		const orders = findNode(result.root, 'table: orders');
		const customers = findNode(result.root, 'table: customers');
		assert.ok(orders, 'orders table node present');
		assert.ok(customers, 'customers table node present');
	});

	it('labels table objects by table_name and keeps planner field names verbatim', () => {
		const result = parseExplain('mysql', [{ EXPLAIN: JSON.stringify(MYSQL_PLAN) }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const orders = findNode(result.root, 'table: orders');
		assert.ok(orders);
		const access = orders.fields.find((f) => f.key === 'access_type');
		assert.deepEqual(access, { key: 'access_type', value: 'ALL', numeric: false });
		// Arrays of scalars stay fields, joined — they are not subtrees.
		const keys = orders.fields.find((f) => f.key === 'possible_keys');
		assert.deepEqual(keys, { key: 'possible_keys', value: 'idx_customer', numeric: false });
	});

	it('flags estimate numbers numeric, including MySQL cost strings', () => {
		const result = parseExplain('mysql', [{ EXPLAIN: JSON.stringify(MYSQL_PLAN) }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const orders = findNode(result.root, 'table: orders');
		assert.ok(orders);
		assert.equal(orders.fields.find((f) => f.key === 'rows_examined_per_scan')?.numeric, true);
		// '100.00' arrives as a JSON string but is still a planner estimate.
		assert.equal(orders.fields.find((f) => f.key === 'filtered')?.numeric, true);
		assert.equal(orders.fields.find((f) => f.key === 'attached_condition')?.numeric, false);
		// cost_info is an object → its own node, with numeric-looking strings.
		const cost = findNode(orders, 'cost_info');
		assert.ok(cost);
		assert.equal(cost.fields.find((f) => f.key === 'read_cost')?.numeric, true);
	});

	it('accepts an already-parsed object in the EXPLAIN column', () => {
		const result = parseExplain('mysql', [{ EXPLAIN: MYSQL_PLAN }]);
		assert.equal(result.ok, true);
	});

	it('walks documented containers generically', () => {
		const plan = {
			query_block: {
				select_id: 1,
				ordering_operation: {
					using_filesort: true,
					grouping_operation: {
						using_temporary_table: true,
						table: { table_name: 'events', access_type: 'index' },
					},
				},
			},
		};
		const result = parseExplain('mysql', [{ EXPLAIN: JSON.stringify(plan) }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.ok(findNode(result.root, 'ordering_operation'));
		assert.ok(findNode(result.root, 'grouping_operation'));
		assert.ok(findNode(result.root, 'table: events'));
		assert.equal(countPlanNodes(result.root), 4);
	});

	it('misses (never throws) on malformed input', () => {
		assert.deepEqual(parseExplain('mysql', [{ EXPLAIN: 'not json at all' }]).ok, false);
		assert.deepEqual(parseExplain('mysql', [{ other: 'column' }]).ok, false);
		assert.deepEqual(parseExplain('mysql', [{ EXPLAIN: JSON.stringify({ no_query_block: 1 }) }]).ok, false);
		assert.deepEqual(parseExplain('mysql', [{ EXPLAIN: JSON.stringify([1, 2, 3]) }]).ok, false);
		assert.deepEqual(parseExplain('mysql', []).ok, false);
	});
});

// =============================================================================
// POSTGRES
// =============================================================================

describe('parseExplain — postgres', () => {
	it('parses an already-parsed QUERY PLAN array', () => {
		const result = parseExplain('postgres', [{ 'QUERY PLAN': POSTGRES_PLAN }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.root.label, 'Nested Loop');
		assert.equal(result.root.children.length, 2);
		assert.equal(result.root.children[0].label, 'Seq Scan on orders');
		assert.equal(result.root.children[1].label, 'Index Scan on customers');
	});

	it('parses a QUERY PLAN JSON string into the same tree', () => {
		const parsed = parseExplain('postgres', [{ 'QUERY PLAN': POSTGRES_PLAN }]);
		const asString = parseExplain('postgres', [{ 'QUERY PLAN': JSON.stringify(POSTGRES_PLAN) }]);
		assert.equal(asString.ok, true);
		assert.deepEqual(asString, parsed);
	});

	it('keeps cost and row estimates as numeric fields', () => {
		const result = parseExplain('postgres', [{ 'QUERY PLAN': POSTGRES_PLAN }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const total = result.root.fields.find((f) => f.key === 'Total Cost');
		assert.deepEqual(total, { key: 'Total Cost', value: '16.36', numeric: true });
		assert.equal(result.root.fields.find((f) => f.key === 'Join Type')?.numeric, false);
	});

	it('misses (never throws) on malformed input', () => {
		assert.equal(parseExplain('postgres', [{ 'QUERY PLAN': '{' }]).ok, false);
		assert.equal(parseExplain('postgres', [{ 'QUERY PLAN': [{ NoPlan: true }] }]).ok, false);
		assert.equal(parseExplain('postgres', [{ 'QUERY PLAN': [{ Plan: { 'No Node Type': 1 } }] }]).ok, false);
		assert.equal(parseExplain('postgres', [{ other: 1 }]).ok, false);
		assert.equal(parseExplain('postgres', []).ok, false);
	});
});

// =============================================================================
// CLICKHOUSE
// =============================================================================

describe('parseExplain — clickhouse', () => {
	it('turns indented text rows into a nested tree', () => {
		const result = parseExplain('clickhouse', CLICKHOUSE_ROWS);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.root.label, 'Expression ((Projection + Before ORDER BY))');
		assert.equal(countPlanNodes(result.root), 4);
		assert.equal(result.root.children[0].label, 'Aggregating');
		assert.equal(result.root.children[0].children[0].label, 'Expression (Before GROUP BY)');
		assert.equal(result.root.children[0].children[0].children[0].label, 'ReadFromMergeTree (default.hits)');
	});

	it('keeps unindented output flat under the first line', () => {
		const rows = [{ explain: 'Expression' }, { explain: 'ReadFromStorage' }];
		const result = parseExplain('clickhouse', rows);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.root.label, 'Expression');
		assert.equal(result.root.children.length, 1);
		assert.equal(result.root.children[0].label, 'ReadFromStorage');
	});

	it('splits a single cell that holds several lines', () => {
		const result = parseExplain('clickhouse', [{ explain: 'Expression\n  ReadFromMergeTree (default.hits)' }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(countPlanNodes(result.root), 2);
	});

	it('misses (never throws) when no text arrives', () => {
		assert.equal(parseExplain('clickhouse', [{ explain: null }]).ok, false);
		assert.equal(parseExplain('clickhouse', [{ other: 'x' }]).ok, false);
		assert.equal(parseExplain('clickhouse', [{ explain: '   ' }]).ok, false);
	});
});

// =============================================================================
// UNSUPPORTED DIALECTS
// =============================================================================

describe('parseExplain — unsupported dialects', () => {
	it('misses with a reason naming the dialect', () => {
		const result = parseExplain('neo4j', [{ anything: 1 }]);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.reason, /neo4j/);
	});
});

// =============================================================================
// RAW OUTPUT
// =============================================================================

describe('formatRawPlan', () => {
	it('prints a single-column text result one cell per line', () => {
		assert.equal(formatRawPlan(CLICKHOUSE_ROWS), [
			'Expression ((Projection + Before ORDER BY))',
			'  Aggregating',
			'    Expression (Before GROUP BY)',
			'      ReadFromMergeTree (default.hits)',
		].join('\n'));
	});

	it('keeps a JSON string cell exactly as the database sent it', () => {
		const raw = '{"query_block": {"select_id": 1}}';
		assert.equal(formatRawPlan([{ EXPLAIN: raw }]), raw);
	});

	it('pretty-prints a cell the driver already decoded', () => {
		const text = formatRawPlan([{ 'QUERY PLAN': POSTGRES_PLAN }]);
		assert.match(text, /^\[\n/);
		assert.match(text, /"Node Type": "Nested Loop"/);
	});

	it('falls back to the whole row set for wider results', () => {
		const text = formatRawPlan([{ id: 1, select_type: 'SIMPLE', table: 'orders' }]);
		assert.deepEqual(JSON.parse(text), [{ id: 1, select_type: 'SIMPLE', table: 'orders' }]);
	});

	it('returns empty text for an empty result', () => {
		assert.equal(formatRawPlan([]), '');
	});
});

// =============================================================================
// PATTERN NOTES
// =============================================================================

describe('planNotes', () => {
	/**
	 * Build a bare node carrying the given fields.
	 *
	 * @param label - The node label.
	 * @param fields - The fields as key/value text pairs.
	 * @returns The node.
	 */
	function node(label: string, fields: Record<string, string> = {}): IPlanNode {
		return {
			label,
			fields: Object.entries(fields).map(([key, value]) => ({ key, value, numeric: /^-?\d+(\.\d+)?$/.test(value) })),
			children: [],
		};
	}

	it('cites access_type = ALL with the row estimate, suffixed est.', () => {
		const notes = planNotes(node('table: orders', { access_type: 'ALL', rows_examined_per_scan: '1204' }));
		assert.deepEqual(notes, [{ evidence: 'access_type = ALL', text: 'full table scan (rows_examined_per_scan 1204 est.)' }]);
	});

	it('drops the parenthetical when the planner gave no row estimate', () => {
		const notes = planNotes(node('table: orders', { access_type: 'ALL' }));
		assert.deepEqual(notes, [{ evidence: 'access_type = ALL', text: 'full table scan' }]);
	});

	it('reads filesort and temporary from the tabular Extra column', () => {
		const notes = planNotes(node('table: events', { Extra: 'Using temporary; Using filesort' }));
		assert.deepEqual(notes.map((n) => n.evidence), ['Extra contains Using filesort', 'Extra contains Using temporary']);
	});

	it('reads filesort and temporary from the FORMAT=JSON booleans', () => {
		const notes = planNotes(node('ordering_operation', { using_filesort: 'true', using_temporary_table: 'true' }));
		assert.deepEqual(notes.map((n) => n.evidence), ['using_filesort = true', 'using_temporary_table = true']);
	});

	it('detects a PostgreSQL sequential scan from the node label', () => {
		assert.deepEqual(planNotes(node('Seq Scan on orders')), [{ evidence: 'Node Type = Seq Scan on orders', text: 'sequential scan' }]);
		assert.deepEqual(planNotes(node('Seq Scan')), [{ evidence: 'Node Type = Seq Scan', text: 'sequential scan' }]);
	});

	it('says nothing about nodes no rule matches', () => {
		assert.deepEqual(planNotes(node('Index Scan on customers', { 'Index Name': 'customers_pkey' })), []);
		assert.deepEqual(planNotes(node('table: orders', { access_type: 'eq_ref' })), []);
		assert.deepEqual(planNotes(node('Nested Loop')), []);
	});
});
