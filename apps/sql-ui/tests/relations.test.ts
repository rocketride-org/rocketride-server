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
// RELATIONS — unit tests for the declared-foreign-key graph and join paths
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ISqlSchemaResponse } from '../src/connect';
import { quoteIdent } from '../src/sql/paging';
import {
	buildRelationGraph,
	describeHop,
	findJoinPaths,
	generateJoinSql,
	inboundReferences,
	orientation,
	outboundReferences,
} from '../src/schema/relations';

// =============================================================================
// FIXTURES
// =============================================================================

/** A small shop: orders -> customers, order_items -> orders/products, audit_log alone. */
const SHOP: ISqlSchemaResponse = {
	database: 'shop',
	tables: {
		customers: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'name', type: 'VARCHAR(80)' }],
			primary_key: ['id'],
		},
		products: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'title', type: 'VARCHAR(80)' }],
			primary_key: ['id'],
		},
		orders: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'customer_id', type: 'BIGINT' }],
			primary_key: ['id'],
			foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
		},
		order_items: {
			columns: [
				{ column: 'order_id', type: 'BIGINT' },
				{ column: 'product_id', type: 'BIGINT' },
			],
			foreign_keys: [
				{ columns: ['order_id'], referred_table: 'orders', referred_columns: ['id'] },
				{ columns: ['product_id'], referred_table: 'products', referred_columns: ['id'] },
			],
		},
		audit_log: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'note', type: 'TEXT' }],
		},
	},
};

/** A composite key: shipments (tenant_id, order_no) -> orders (tenant_id, no). */
const COMPOSITE: ISqlSchemaResponse = {
	tables: {
		orders: {
			columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'no', type: 'INT' }],
			primary_key: ['tenant_id', 'no'],
		},
		shipments: {
			columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'order_no', type: 'INT' }],
			foreign_keys: [{
				columns: ['tenant_id', 'order_no'],
				referred_table: 'orders',
				referred_columns: ['tenant_id', 'no'],
			}],
		},
	},
};

/** Two distinct keys between the same pair of tables. */
const PARALLEL: ISqlSchemaResponse = {
	tables: {
		people: { columns: [{ column: 'id', type: 'INT' }], primary_key: ['id'] },
		messages: {
			columns: [
				{ column: 'sender_id', type: 'INT' },
				{ column: 'recipient_id', type: 'INT' },
			],
			foreign_keys: [
				{ columns: ['sender_id'], referred_table: 'people', referred_columns: ['id'] },
				{ columns: ['recipient_id'], referred_table: 'people', referred_columns: ['id'] },
			],
		},
	},
};

/** A table that points at itself. */
const SELF_REF: ISqlSchemaResponse = {
	tables: {
		nodes: {
			columns: [{ column: 'id', type: 'INT' }, { column: 'parent_id', type: 'INT' }],
			primary_key: ['id'],
			foreign_keys: [{ columns: ['parent_id'], referred_table: 'nodes', referred_columns: ['id'] }],
		},
		leaves: {
			columns: [{ column: 'node_id', type: 'INT' }],
			foreign_keys: [{ columns: ['node_id'], referred_table: 'nodes', referred_columns: ['id'] }],
		},
	},
};

/** A chain long enough to exceed a depth cap: a -> b -> c -> d -> e -> f. */
const CHAIN: ISqlSchemaResponse = {
	tables: {
		a: { columns: [{ column: 'id', type: 'INT' }], primary_key: ['id'] },
		b: { columns: [{ column: 'a_id', type: 'INT' }, { column: 'id', type: 'INT' }], primary_key: ['id'], foreign_keys: [{ columns: ['a_id'], referred_table: 'a', referred_columns: ['id'] }] },
		c: { columns: [{ column: 'b_id', type: 'INT' }, { column: 'id', type: 'INT' }], primary_key: ['id'], foreign_keys: [{ columns: ['b_id'], referred_table: 'b', referred_columns: ['id'] }] },
		d: { columns: [{ column: 'c_id', type: 'INT' }, { column: 'id', type: 'INT' }], primary_key: ['id'], foreign_keys: [{ columns: ['c_id'], referred_table: 'c', referred_columns: ['id'] }] },
		e: { columns: [{ column: 'd_id', type: 'INT' }, { column: 'id', type: 'INT' }], primary_key: ['id'], foreign_keys: [{ columns: ['d_id'], referred_table: 'd', referred_columns: ['id'] }] },
		f: { columns: [{ column: 'e_id', type: 'INT' }], foreign_keys: [{ columns: ['e_id'], referred_table: 'e', referred_columns: ['id'] }] },
	},
};

// =============================================================================
// GRAPH
// =============================================================================

describe('buildRelationGraph', () => {
	it('collects every declared foreign key and nothing else', () => {
		const graph = buildRelationGraph(SHOP);
		assert.equal(graph.tables.length, 5);
		assert.equal(graph.edges.length, 3);
		// audit_log.id looks like a key by name; no edge may exist for it.
		assert.equal(graph.edges.some((edge) => edge.table === 'audit_log'), false);
	});

	it('is empty for a ClickHouse-style schema that declares no keys', () => {
		const graph = buildRelationGraph({ tables: { events: { columns: [{ column: 'ts', type: 'DateTime' }] } } });
		assert.deepEqual(graph.edges, []);
		assert.deepEqual(graph.tables, ['events']);
		assert.deepEqual(findJoinPaths(graph, 'events', 'events'), []);
	});

	it('is empty for a missing or errored snapshot', () => {
		assert.deepEqual(buildRelationGraph(null), { tables: [], edges: [] });
		assert.deepEqual(buildRelationGraph({ error: 'boom' }), { tables: [], edges: [] });
	});

	it('carries every column pair of a composite key', () => {
		const [edge] = buildRelationGraph(COMPOSITE).edges;
		assert.deepEqual(edge?.columns, ['tenant_id', 'order_no']);
		assert.deepEqual(edge?.refColumns, ['tenant_id', 'no']);
	});

	it('drops keys whose two sides have different column counts', () => {
		const graph = buildRelationGraph({
			tables: {
				t: { columns: [], foreign_keys: [{ columns: ['a', 'b'], referred_table: 'u', referred_columns: ['a'] }] },
				u: { columns: [] },
			},
		});
		assert.deepEqual(graph.edges, []);
	});

	it('keeps a key that points at a table missing from the snapshot', () => {
		const graph = buildRelationGraph({
			tables: { t: { columns: [], foreign_keys: [{ columns: ['x'], referred_table: 'gone', referred_columns: ['id'] }] } },
		});
		assert.equal(graph.edges.length, 1);
		// ...but it is not walkable, so it can never appear in a path.
		assert.deepEqual(findJoinPaths(graph, 't', 'gone'), []);
	});
});

describe('inbound and outbound references', () => {
	it('lists the tables that point at one table', () => {
		const graph = buildRelationGraph(SHOP);
		const inbound = inboundReferences(graph, 'orders');
		assert.equal(inbound.length, 1);
		assert.equal(inbound[0]?.table, 'order_items');
		assert.deepEqual(inboundReferences(graph, 'audit_log'), []);
	});

	it('lists a self-referential key on both sides', () => {
		const graph = buildRelationGraph(SELF_REF);
		assert.equal(inboundReferences(graph, 'nodes').length, 2);
		assert.equal(outboundReferences(graph, 'nodes').length, 1);
	});
});

describe('orientation', () => {
	it('splits hubs, leaves and isolated tables', () => {
		const result = orientation(buildRelationGraph(SHOP));
		assert.deepEqual(result.hubs.map((hub) => hub.table), ['customers', 'orders', 'products']);
		assert.deepEqual(result.leaves, ['order_items']);
		assert.deepEqual(result.isolated, ['audit_log']);
	});

	it('counts referencing TABLES, not keys, and ignores self-references', () => {
		const parallel = orientation(buildRelationGraph(PARALLEL));
		assert.deepEqual(parallel.hubs, [{ table: 'people', inbound: 1 }]);
		const self = orientation(buildRelationGraph(SELF_REF));
		assert.deepEqual(self.hubs, [{ table: 'nodes', inbound: 1 }]);
	});
});

// =============================================================================
// PATH FINDING
// =============================================================================

describe('findJoinPaths', () => {
	it('walks keys in both directions to reach a sibling table', () => {
		const paths = findJoinPaths(buildRelationGraph(SHOP), 'orders', 'products');
		assert.equal(paths.length, 1);
		assert.deepEqual(paths[0]?.hops.map((hop) => hop.to), ['order_items', 'products']);
		// orders -> order_items runs against the key's declared direction.
		assert.equal(paths[0]?.hops[0]?.reversed, true);
		assert.equal(paths[0]?.hops[1]?.reversed, false);
	});

	it('returns every parallel key as its own path instead of choosing one', () => {
		const paths = findJoinPaths(buildRelationGraph(PARALLEL), 'messages', 'people');
		assert.equal(paths.length, 2);
		assert.deepEqual(
			paths.map((path) => path.hops[0]?.edge.columns[0]).sort(),
			['recipient_id', 'sender_id'],
		);
	});

	it('reports no path between unrelated tables', () => {
		assert.deepEqual(findJoinPaths(buildRelationGraph(SHOP), 'orders', 'audit_log'), []);
	});

	it('reports no path from a table to itself', () => {
		assert.deepEqual(findJoinPaths(buildRelationGraph(SHOP), 'orders', 'orders'), []);
	});

	it('never loops on a self-referential key', () => {
		const paths = findJoinPaths(buildRelationGraph(SELF_REF), 'leaves', 'nodes');
		assert.equal(paths.length, 1);
		assert.equal(paths[0]?.hops.length, 1);
	});

	it('honours the depth cap', () => {
		const graph = buildRelationGraph(CHAIN);
		assert.equal(findJoinPaths(graph, 'a', 'e').length, 1);
		// a -> f is five joins: out of range at the default cap of four.
		assert.deepEqual(findJoinPaths(graph, 'a', 'f'), []);
		assert.equal(findJoinPaths(graph, 'a', 'f', 5).length, 1);
		assert.deepEqual(findJoinPaths(graph, 'a', 'b', 0), []);
	});

	it('returns nothing for tables outside the snapshot', () => {
		const graph = buildRelationGraph(SHOP);
		assert.deepEqual(findJoinPaths(graph, 'orders', 'nowhere'), []);
		assert.deepEqual(findJoinPaths(graph, 'nowhere', 'orders'), []);
	});
});

// =============================================================================
// SQL GENERATION
// =============================================================================

describe('generateJoinSql', () => {
	it('writes the header comment, aliases, and a LIMIT', () => {
		const [path] = findJoinPaths(buildRelationGraph(SHOP), 'orders', 'products');
		const sql = generateJoinSql('mysql', path!, quoteIdent);
		assert.equal(sql.split('\n')[0], '-- generated from declared foreign keys; review before running');
		assert.equal(sql.includes('SELECT o.*, p.*'), true);
		assert.equal(sql.includes('FROM `orders` o'), true);
		assert.equal(sql.includes('JOIN `order_items` oi ON oi.`order_id` = o.`id`'), true);
		assert.equal(sql.includes('JOIN `products` p ON p.`id` = oi.`product_id`'), true);
		assert.equal(sql.trim().endsWith('LIMIT 100'), true);
	});

	it('quotes per dialect, escaping quotes inside identifiers', () => {
		const odd: ISqlSchemaResponse = {
			tables: {
				'we"ird': { columns: [{ column: 'id', type: 'INT' }], primary_key: ['id'] },
				'ba`d': {
					columns: [{ column: 'we"ird_id', type: 'INT' }],
					foreign_keys: [{ columns: ['we"ird_id'], referred_table: 'we"ird', referred_columns: ['id'] }],
				},
			},
		};
		const graph = buildRelationGraph(odd);
		const [path] = findJoinPaths(graph, 'ba`d', 'we"ird');
		assert.equal(generateJoinSql('postgres', path!, quoteIdent).includes('FROM "ba`d"'), true);
		assert.equal(generateJoinSql('postgres', path!, quoteIdent).includes('"we""ird"'), true);
		assert.equal(generateJoinSql('clickhouse', path!, quoteIdent).includes('FROM `ba``d`'), true);
	});

	it('joins on every column pair of a composite key', () => {
		const [path] = findJoinPaths(buildRelationGraph(COMPOSITE), 'shipments', 'orders');
		const sql = generateJoinSql('mysql', path!, quoteIdent);
		assert.equal(
			sql.includes('JOIN `orders` o ON o.`tenant_id` = s.`tenant_id` AND o.`no` = s.`order_no`'),
			true,
		);
	});

	it('gives colliding initials distinct aliases', () => {
		const collide: ISqlSchemaResponse = {
			tables: {
				orders: { columns: [{ column: 'id', type: 'INT' }], primary_key: ['id'] },
				offers: {
					columns: [{ column: 'order_id', type: 'INT' }],
					foreign_keys: [{ columns: ['order_id'], referred_table: 'orders', referred_columns: ['id'] }],
				},
			},
		};
		const [path] = findJoinPaths(buildRelationGraph(collide), 'offers', 'orders');
		const sql = generateJoinSql('mysql', path!, quoteIdent);
		assert.equal(sql.includes('FROM `offers` o'), true);
		assert.equal(sql.includes('JOIN `orders` o2'), true);
	});

	it('returns an empty string for a path with no hops', () => {
		assert.equal(generateJoinSql('mysql', { from: 'a', to: 'a', hops: [] }, quoteIdent), '');
	});
});

describe('describeHop', () => {
	it('always reads in the declared direction of the key', () => {
		const [path] = findJoinPaths(buildRelationGraph(SHOP), 'orders', 'products');
		assert.deepEqual(path!.hops.map(describeHop), [
			'order_items.order_id -> orders.id',
			'order_items.product_id -> products.id',
		]);
	});

	it('lists every column of a composite key', () => {
		const [path] = findJoinPaths(buildRelationGraph(COMPOSITE), 'shipments', 'orders');
		assert.equal(
			describeHop(path!.hops[0]!),
			'shipments.tenant_id, shipments.order_no -> orders.tenant_id, orders.no',
		);
	});
});
