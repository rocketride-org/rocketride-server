// MIT License
//
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
// ER MODEL — unit tests for the schema snapshot to xyflow translation
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ISqlSchemaResponse } from '../src/connect';
import { HEADER_HEIGHT, ROW_HEIGHT, buildErModel, nodeHeight, sourceHandle, targetHandle } from '../src/canvas/erModel';

// =============================================================================
// FIXTURES
// =============================================================================

/** Two tables joined by a single-column foreign key. */
const SCHEMA: ISqlSchemaResponse = {
	database: 'shop',
	tables: {
		customers: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'name', type: 'VARCHAR(80)' }],
			primary_key: ['id'],
		},
		orders: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'customer_id', type: 'BIGINT' }],
			primary_key: ['id'],
			foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
		},
	},
};

// =============================================================================
// SIZING AND HANDLES
// =============================================================================

describe('node sizing and handle ids', () => {
	it('grows a node by one row height per column', () => {
		assert.equal(nodeHeight(3) - nodeHeight(2), ROW_HEIGHT);
		assert.equal(nodeHeight(0), HEADER_HEIGHT + 6);
	});

	it('namespaces the source and target handles apart', () => {
		assert.equal(sourceHandle('id'), 's:id');
		assert.equal(targetHandle('id'), 't:id');
		assert.notEqual(sourceHandle('id'), targetHandle('id'));
	});
});

// =============================================================================
// NODES
// =============================================================================

describe('buildErModel nodes', () => {
	it('emits one table node per table, at the origin, typed for the canvas', () => {
		const { nodes } = buildErModel(SCHEMA);
		assert.deepEqual(nodes.map((n) => n.id).sort(), ['customers', 'orders']);
		for (const node of nodes) {
			assert.equal(node.type, 'table');
			assert.deepEqual(node.position, { x: 0, y: 0 });
		}
	});

	it('flags primary-key and foreign-key columns for the glyphs', () => {
		const { nodes } = buildErModel(SCHEMA);
		const orders = nodes.find((n) => n.id === 'orders')!;
		assert.deepEqual(orders.data.columns, [
			{ name: 'id', type: 'BIGINT', pk: true, fk: false },
			{ name: 'customer_id', type: 'BIGINT', pk: false, fk: true },
		]);
	});

	it('returns nothing for an empty or error-only schema', () => {
		assert.deepEqual(buildErModel({}), { nodes: [], edges: [] });
		assert.deepEqual(buildErModel({ error: 'reflection failed' }), { nodes: [], edges: [] });
	});
});

// =============================================================================
// EDGES
// =============================================================================

describe('buildErModel edges', () => {
	it('anchors one edge per FK column pair to the exact column handles', () => {
		const { edges } = buildErModel(SCHEMA);
		assert.deepEqual(edges, [{
			id: 'orders.customer_id->customers.id',
			source: 'orders',
			sourceHandle: 's:customer_id',
			target: 'customers',
			targetHandle: 't:id',
			type: 'smoothstep',
		}]);
	});

	it('pairs a composite key column by column, not as a cross product', () => {
		const { edges } = buildErModel({
			tables: {
				parent: { columns: [{ column: 'a', type: 'INT' }, { column: 'b', type: 'INT' }] },
				child: {
					columns: [{ column: 'x', type: 'INT' }, { column: 'y', type: 'INT' }],
					foreign_keys: [{ columns: ['x', 'y'], referred_table: 'parent', referred_columns: ['a', 'b'] }],
				},
			},
		});
		assert.deepEqual(edges.map((e) => e.id), ['child.x->parent.a', 'child.y->parent.b']);
	});

	it('skips a foreign key pointing outside the snapshot (cross-schema reference)', () => {
		const { edges } = buildErModel({
			tables: {
				orders: {
					columns: [{ column: 'customer_id', type: 'BIGINT' }],
					foreign_keys: [{ columns: ['customer_id'], referred_table: 'other_db_customers', referred_columns: ['id'] }],
				},
			},
		});
		assert.deepEqual(edges, []);
	});

	it('skips a column the engine reported no referred column for', () => {
		const { edges } = buildErModel({
			tables: {
				parent: { columns: [{ column: 'a', type: 'INT' }] },
				child: {
					columns: [{ column: 'x', type: 'INT' }],
					foreign_keys: [{ columns: ['x'], referred_table: 'parent', referred_columns: [] }],
				},
			},
		});
		assert.deepEqual(edges, []);
	});

	it('falls back to the first referred column when the FK is short one entry', () => {
		const { edges } = buildErModel({
			tables: {
				parent: { columns: [{ column: 'a', type: 'INT' }] },
				child: {
					columns: [{ column: 'x', type: 'INT' }, { column: 'y', type: 'INT' }],
					foreign_keys: [{ columns: ['x', 'y'], referred_table: 'parent', referred_columns: ['a'] }],
				},
			},
		});
		assert.deepEqual(edges.map((e) => e.id), ['child.x->parent.a', 'child.y->parent.a']);
	});
});
