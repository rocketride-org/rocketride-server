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
// RECORD DRAWER — unit tests for the pure model behind the data browser's row drawer
// =============================================================================
//
// Fields follow the schema's column order and never the row object's keys:
// the grid writes an undefined key into every row object for each column it
// renders (Tabulator `Cell.build`), so a row's own keys are not a column list.
// A foreign-key link looks the referenced row up with bound values.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlSchemaResponse, SqlSchemaTable } from '../src/connect';
import { buildRelationGraph } from '../src/schema/relations';
import {
	KEY_BINARY,
	KEY_TOO_LARGE,
	childRowsPreset,
	fallbackDef,
	isRoundedKey,
	linkRefusal,
	recordFields,
	recordJson,
	referencedRowStatement,
	referencingEdges,
	showRowsRefusal,
} from '../src/sql/record';

const SCHEMA: SqlSchemaResponse = {
	tables: {
		customers: {
			columns: [{ column: 'id', type: 'BIGINT' }, { column: 'name', type: 'VARCHAR(80)' }],
			primary_key: ['id'],
		},
		orders: {
			columns: [
				{ column: 'id', type: 'BIGINT' },
				{ column: 'customer_id', type: 'BIGINT' },
				{ column: 'total', type: 'NUMERIC(10,2)' },
			],
			primary_key: ['id'],
			foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
		},
		shipments: {
			columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'order_no', type: 'INT' }, { column: 'carrier', type: 'TEXT' }],
			foreign_keys: [{ columns: ['tenant_id', 'order_no'], referred_table: 'order_lines', referred_columns: ['tenant_id', 'no'] }],
		},
		order_lines: {
			columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'no', type: 'INT' }],
			primary_key: ['tenant_id', 'no'],
		},
	},
};
const GRAPH = buildRelationGraph(SCHEMA);
const ORDERS = SCHEMA.tables!.orders!;

describe('recordFields', () => {
	it('follows the schema column order, not the row object order', () => {
		const row = { total: 9.5, id: 1, customer_id: 4 };
		assert.deepEqual(recordFields(ORDERS, row).map((f) => f.column), ['id', 'customer_id', 'total']);
	});

	it('does not derive the fields from the keys of the row', () => {
		// The grid adds an undefined key per rendered column to the row object.
		const row: Record<string, unknown> = { id: 1, customer_id: 4, total: 9.5, extra_from_grid: undefined };
		const fields = recordFields(ORDERS, row);
		assert.equal(fields.length, 3);
		assert.ok(!fields.some((f) => f.column === 'extra_from_grid'));
	});

	it('reads a column the row lacks as undefined and keeps its slot', () => {
		const fields = recordFields(ORDERS, { id: 1 });
		assert.equal(fields.length, 3);
		assert.equal(fields[2]!.value, undefined);
	});

	it('carries the type, the PK flag and the foreign keys of each column', () => {
		const [id, customer, total] = recordFields(ORDERS, { id: 1, customer_id: 4, total: 2 }, GRAPH, 'orders');
		assert.equal(id!.pk, true);
		assert.equal(id!.type, 'BIGINT');
		assert.equal(customer!.links.length, 1);
		assert.equal(customer!.links[0]!.refTable, 'customers');
		assert.equal(total!.links.length, 0);
	});
});

describe('recordJson', () => {
	it('writes the keys in schema order and leaves out keys the schema lacks', () => {
		const json = recordJson(ORDERS, { total: 2, extra: 'x', id: 1, customer_id: null });
		assert.deepEqual(Object.keys(JSON.parse(json) as object), ['id', 'customer_id', 'total']);
		assert.ok(!json.includes('extra'));
	});
});

describe('referencedRowStatement', () => {
	const edge = GRAPH.edges.find((e) => e.table === 'orders')!;

	it('looks the row up with a bound value, per dialect quoting', () => {
		const row = { id: 7, customer_id: 4, total: 1 };
		assert.deepEqual(referencedRowStatement('postgres', edge, row), {
			sql: 'SELECT * FROM "customers" WHERE "id" = $1 LIMIT 2',
			params: [4],
		});
		assert.deepEqual(referencedRowStatement('mysql', edge, row), {
			sql: 'SELECT * FROM `customers` WHERE `id` = $1 LIMIT 2',
			params: [4],
		});
	});

	it('handles a composite key: every column pair, in key order', () => {
		const composite = GRAPH.edges.find((e) => e.table === 'shipments')!;
		const stmt = referencedRowStatement('postgres', composite, { carrier: 'x', order_no: 12, tenant_id: 3 });
		assert.deepEqual(stmt, {
			sql: 'SELECT * FROM "order_lines" WHERE "tenant_id" = $1 AND "no" = $2 LIMIT 2',
			params: [3, 12],
		});
	});

	it('has no lookup when any key value is NULL (it points at nothing)', () => {
		assert.equal(referencedRowStatement('postgres', edge, { customer_id: null }), null);
		const composite = GRAPH.edges.find((e) => e.table === 'shipments')!;
		assert.equal(referencedRowStatement('postgres', composite, { tenant_id: 3, order_no: null }), null);
		assert.equal(referencedRowStatement('postgres', composite, { tenant_id: 3 }), null);
	});

	it('escapes a backslash in a ClickHouse name, so the lookup cannot leave the identifier (DA-R1 M6)', () => {
		const hostile = { id: 0, table: 'a', columns: ['c'], refTable: 't\\', refColumns: ['k\\'] };
		assert.deepEqual(referencedRowStatement('clickhouse', hostile, { c: 1 }), { sql: 'SELECT * FROM `t\\\\` WHERE `k\\\\` = $1 LIMIT 2', params: [1] });
	});

	it('quotes hostile identifiers and binds hostile values', () => {
		const hostile = { id: 0, table: 'a"b', columns: ['c"d'], refTable: 'e"f', refColumns: ['g"h'] };
		const stmt = referencedRowStatement('postgres', hostile, { 'c"d': "1' OR '1'='1" });
		assert.deepEqual(stmt, { sql: 'SELECT * FROM "e""f" WHERE "g""h" = $1 LIMIT 2', params: ["1' OR '1'='1"] });
	});
});

describe('rows that reference this one', () => {
	it('lists the child tables whose keys point at the table', () => {
		const inbound = referencingEdges(GRAPH, 'customers');
		assert.deepEqual(inbound.map((e) => e.table), ['orders']);
		assert.deepEqual(referencingEdges(GRAPH, 'orders'), []);
	});

	it('presets one equals chip per key column for "Show rows"', () => {
		const edge = GRAPH.edges.find((e) => e.table === 'orders')!;
		assert.deepEqual(childRowsPreset(edge, { id: 4, name: 'Ada' }), [{ column: 'customer_id', op: 'eq', value: '4' }]);
	});

	it('presets a chip for each column of a composite key', () => {
		const edge = GRAPH.edges.find((e) => e.table === 'shipments')!;
		assert.deepEqual(childRowsPreset(edge, { tenant_id: 3, no: 12 }), [
			{ column: 'tenant_id', op: 'eq', value: '3' },
			{ column: 'order_no', op: 'eq', value: '12' },
		]);
	});

	it('presets nothing when a key value is NULL', () => {
		const edge = GRAPH.edges.find((e) => e.table === 'orders')!;
		assert.equal(childRowsPreset(edge, { id: null }), null);
	});
});

// =============================================================================
// KEYS PAST 2^53 (DA-R1 I3)
// =============================================================================
//
// The node sends a Python int as a full-digit JSON number, and JSON.parse
// rounds one past 2^53 to the nearest double: 1234567890123456789 arrives as
// 1234567890123456800, another row's key. Looking that up would report "No
// row" for a row that exists (or open the wrong one), so a key that arrived
// as such a number is never looked up or preset. A key that arrived as text
// is exact and is followed as usual.
// =============================================================================

describe('keys too large for the browser to hold exactly', () => {
	const edge = GRAPH.edges.find((e) => e.table === 'orders')!;
	const wire = JSON.parse('{"id": 1234567890123456791, "customer_id": 1234567890123456789, "total": 1}') as Record<string, unknown>;

	it('knows a rounded key: an integer number past 2^53, and only that', () => {
		assert.equal(wire.customer_id, 1234567890123456800, 'what JSON.parse made of it');
		assert.equal(isRoundedKey(wire.customer_id), true);
		assert.equal(isRoundedKey(2 ** 53), true, '2^53 and 2^53 + 1 arrive as the same number');
		assert.equal(isRoundedKey(-(2 ** 53)), true);
		assert.equal(isRoundedKey(Number.MAX_SAFE_INTEGER), false);
		assert.equal(isRoundedKey('1234567890123456789'), false, 'text is exact');
		assert.equal(isRoundedKey(4), false);
		assert.equal(isRoundedKey(1.5), false);
		assert.equal(isRoundedKey(null), false);
	});

	it('does not look the referenced row up, and says why', () => {
		assert.equal(referencedRowStatement('postgres', edge, wire), null);
		assert.equal(linkRefusal(edge, wire), KEY_TOO_LARGE);
		assert.equal(KEY_TOO_LARGE, 'This key is too large to look up exactly in the browser.');
	});

	it('looks up a key that arrived as text, exactly as sent', () => {
		const exact = { id: '1234567890123456791', customer_id: '1234567890123456789' };
		assert.equal(linkRefusal(edge, exact), null);
		assert.deepEqual(referencedRowStatement('postgres', edge, exact)?.params, ['1234567890123456789']);
	});

	it('refuses a composite key when any part was rounded', () => {
		const composite = GRAPH.edges.find((e) => e.table === 'shipments')!;
		const row = { tenant_id: 3, order_no: 2 ** 60 };
		assert.equal(referencedRowStatement('postgres', composite, row), null);
		assert.equal(linkRefusal(composite, row), KEY_TOO_LARGE);
	});

	it('presets no "Show rows" chip from a rounded key, and says why', () => {
		const parent = JSON.parse('{"id": 1234567890123456789, "name": "Alice"}') as Record<string, unknown>;
		assert.equal(childRowsPreset(edge, parent), null);
		assert.equal(showRowsRefusal(edge, parent), KEY_TOO_LARGE);
		assert.deepEqual(childRowsPreset(edge, { id: '1234567890123456789' }), [{ column: 'customer_id', op: 'eq', value: '1234567890123456789' }]);
		assert.equal(showRowsRefusal(edge, { id: '1234567890123456789' }), null);
		assert.equal(showRowsRefusal(edge, { id: null }), null, 'a NULL key is no key, not a refusal');
	});
});

// =============================================================================
// BINARY KEYS (DA-R2 I1)
// =============================================================================
//
// The node sends a binary value as text it decoded with errors='replace', so
// the text in the row is not the key the database holds: a lookup would say
// "No row" for a row that exists. Such a key is not looked up or preset.
// =============================================================================

describe('binary keys are neither looked up nor preset', () => {
	const DECODED_KEY = JSON.parse('"\\u0011\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\\b\\u0019*;L]n\\u007f"') as string;
	const TABLES: Record<string, SqlSchemaTable> = {
		tokens: { columns: [{ column: 'id', type: 'BINARY(16)' }, { column: 'note', type: 'VARCHAR(20)' }], primary_key: ['id'] },
		sessions: { columns: [{ column: 'sid', type: 'INT' }, { column: 'token_id', type: 'BINARY(16)' }], primary_key: ['sid'] },
	};
	const edge = { id: 0, table: 'sessions', columns: ['token_id'], refTable: 'tokens', refColumns: ['id'] };

	it('the link is refused with the reason, and no lookup binds the decoded text', () => {
		const row = { sid: 1, token_id: DECODED_KEY };
		assert.equal(linkRefusal(edge, row, TABLES), KEY_BINARY);
		assert.equal(referencedRowStatement('mysql', edge, row, TABLES), null);
		assert.equal(KEY_BINARY, 'This key is binary, which the node sends as text, so it cannot be looked up here.');
		assert.doesNotMatch(KEY_BINARY, /No row/);
	});

	it('the referenced column alone is enough to refuse (a key column typed differently on each side)', () => {
		const tables = { ...TABLES, sessions: { columns: [{ column: 'sid', type: 'INT' }, { column: 'token_id', type: 'CHAR(16)' }] } };
		assert.equal(linkRefusal(edge, { token_id: 'abc' }, tables), KEY_BINARY);
	});

	it('Show rows is refused with the reason, and presets no chip', () => {
		const parent = { id: '<memory at 0x7f3a2c1b0e80>', note: 'x' };
		assert.equal(showRowsRefusal(edge, parent, TABLES), KEY_BINARY);
		assert.equal(childRowsPreset(edge, parent, TABLES), null);
	});

	it('a key whose types are not known (a table the schema lacks) is followed as before', () => {
		assert.equal(linkRefusal(edge, { token_id: 'abc' }), null);
		assert.equal(linkRefusal(edge, { token_id: 'abc' }, {}), null);
		assert.deepEqual(referencedRowStatement('mysql', edge, { token_id: 'abc' }, {})?.params, ['abc']);
	});
});

describe('keys too large: the README says what the drawer does', () => {
	it('names the bound and the reason', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
		assert.match(prose, /A key that reached the browser as a number beyond ±9,007,199,254,740,991 was already rounded on the way/);
		assert.ok(prose.includes(`the link is off and says \`${KEY_TOO_LARGE}\``));
		assert.equal((2 ** 53).toLocaleString('en-US'), '9,007,199,254,740,992');
	});
});

describe('fallbackDef', () => {
	it('lists the columns of a freshly looked-up row when the schema has no entry for its table', () => {
		const def = fallbackDef({ id: 4, name: 'Ada' });
		assert.deepEqual(def.columns.map((c) => c.column), ['id', 'name']);
		assert.deepEqual(recordFields(def, { id: 4, name: 'Ada' }).map((f) => f.value), [4, 'Ada']);
	});
});
