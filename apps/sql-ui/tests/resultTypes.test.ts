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
// SQL RESULT TYPES — unit tests for column typing
// =============================================================================
//
// The regression this file exists for is in the architecture audit (§E.10):
// the old substring match made `/int|dec|num|float|double/i` claim `POINT` as
// a number and miss `MONEY`, `REAL` and `SERIAL`. Every mapping below is
// whole-token, and `POINT` has its own case.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ISqlSchemaResponse, SqlDialect } from '../src/connect';
import type { RrType } from '../src/sql/resultTypes';
import { inferColumnTypes, rrTypeFromSqlType, rrTypeFromValues } from '../src/sql/resultTypes';

// =============================================================================
// SQL TYPE NAMES
// =============================================================================

/** One SQL-type mapping case. */
interface ITypeCase {
	/** Engine-reported type string. */
	type: string;
	/** Dialect that reported it. */
	dialect: SqlDialect;
	/** Expected grid type. */
	expect: RrType;
}

const TYPE_CASES: ITypeCase[] = [
	// MySQL.
	{ type: 'BIGINT', dialect: 'mysql', expect: 'number' },
	{ type: 'INT UNSIGNED', dialect: 'mysql', expect: 'number' },
	{ type: 'TINYINT(1)', dialect: 'mysql', expect: 'number' },
	{ type: 'DECIMAL(10,2)', dialect: 'mysql', expect: 'number' },
	{ type: 'DOUBLE', dialect: 'mysql', expect: 'number' },
	{ type: 'FLOAT', dialect: 'mysql', expect: 'number' },
	{ type: 'YEAR', dialect: 'mysql', expect: 'number' },
	{ type: 'VARCHAR(255)', dialect: 'mysql', expect: 'string' },
	{ type: 'TEXT', dialect: 'mysql', expect: 'string' },
	{ type: 'CHAR(3)', dialect: 'mysql', expect: 'string' },
	{ type: 'BLOB', dialect: 'mysql', expect: 'string' },
	{ type: 'BIT(1)', dialect: 'mysql', expect: 'string' },
	{ type: "ENUM('a','b')", dialect: 'mysql', expect: 'string' },
	{ type: "SET('int','x')", dialect: 'mysql', expect: 'string' },
	{ type: 'JSON', dialect: 'mysql', expect: 'json' },
	{ type: 'DATE', dialect: 'mysql', expect: 'date' },
	{ type: 'DATETIME', dialect: 'mysql', expect: 'date' },
	{ type: 'TIMESTAMP', dialect: 'mysql', expect: 'date' },
	{ type: 'TIME', dialect: 'mysql', expect: 'string' },
	{ type: 'BOOLEAN', dialect: 'mysql', expect: 'boolean' },
	{ type: 'POINT', dialect: 'mysql', expect: 'string' },
	{ type: 'MULTIPOINT', dialect: 'mysql', expect: 'string' },

	// PostgreSQL.
	{ type: 'INTEGER', dialect: 'postgres', expect: 'number' },
	{ type: 'SMALLINT', dialect: 'postgres', expect: 'number' },
	{ type: 'SERIAL', dialect: 'postgres', expect: 'number' },
	{ type: 'BIGSERIAL', dialect: 'postgres', expect: 'number' },
	{ type: 'NUMERIC(10,2)', dialect: 'postgres', expect: 'number' },
	{ type: 'REAL', dialect: 'postgres', expect: 'number' },
	{ type: 'DOUBLE PRECISION', dialect: 'postgres', expect: 'number' },
	{ type: 'MONEY', dialect: 'postgres', expect: 'number' },
	{ type: 'BOOLEAN', dialect: 'postgres', expect: 'boolean' },
	{ type: 'CHARACTER VARYING(20)', dialect: 'postgres', expect: 'string' },
	{ type: 'UUID', dialect: 'postgres', expect: 'string' },
	{ type: 'BYTEA', dialect: 'postgres', expect: 'string' },
	{ type: 'INET', dialect: 'postgres', expect: 'string' },
	{ type: 'INTERVAL', dialect: 'postgres', expect: 'string' },
	{ type: 'JSONB', dialect: 'postgres', expect: 'json' },
	{ type: 'TIMESTAMP WITHOUT TIME ZONE', dialect: 'postgres', expect: 'date' },
	{ type: 'TIMESTAMP WITH TIME ZONE', dialect: 'postgres', expect: 'date' },
	{ type: 'TIMESTAMPTZ', dialect: 'postgres', expect: 'date' },
	{ type: 'TIME WITH TIME ZONE', dialect: 'postgres', expect: 'string' },
	{ type: 'POINT', dialect: 'postgres', expect: 'string' },

	// ClickHouse.
	{ type: 'UInt64', dialect: 'clickhouse', expect: 'number' },
	{ type: 'Int32', dialect: 'clickhouse', expect: 'number' },
	{ type: 'Float64', dialect: 'clickhouse', expect: 'number' },
	{ type: 'Decimal(10, 2)', dialect: 'clickhouse', expect: 'number' },
	{ type: 'Decimal64(4)', dialect: 'clickhouse', expect: 'number' },
	{ type: 'Bool', dialect: 'clickhouse', expect: 'boolean' },
	{ type: 'String', dialect: 'clickhouse', expect: 'string' },
	{ type: 'FixedString(8)', dialect: 'clickhouse', expect: 'string' },
	{ type: 'IPv4', dialect: 'clickhouse', expect: 'string' },
	{ type: "Enum8('a' = 1)", dialect: 'clickhouse', expect: 'string' },
	{ type: 'Date', dialect: 'clickhouse', expect: 'date' },
	{ type: 'Date32', dialect: 'clickhouse', expect: 'date' },
	{ type: 'DateTime', dialect: 'clickhouse', expect: 'date' },
	{ type: 'DateTime64(3)', dialect: 'clickhouse', expect: 'date' },
	{ type: 'Nullable(Int32)', dialect: 'clickhouse', expect: 'number' },
	{ type: 'Nullable(DateTime64(3))', dialect: 'clickhouse', expect: 'date' },
	{ type: 'LowCardinality(String)', dialect: 'clickhouse', expect: 'string' },
	{ type: 'Array(UInt8)', dialect: 'clickhouse', expect: 'json' },
	{ type: 'Map(String, UInt64)', dialect: 'clickhouse', expect: 'json' },
	{ type: 'Tuple(UInt8, String)', dialect: 'clickhouse', expect: 'json' },

	// Nothing to go on.
	{ type: '', dialect: 'unknown', expect: 'string' },
	{ type: 'SOMETHING_ELSE', dialect: 'unknown', expect: 'string' },
];

describe('rrTypeFromSqlType', () => {
	for (const testCase of TYPE_CASES) {
		it(`${testCase.dialect}: ${testCase.type || '(empty)'} -> ${testCase.expect}`, () => {
			assert.equal(rrTypeFromSqlType(testCase.type, testCase.dialect), testCase.expect);
		});
	}
});

// =============================================================================
// VALUE INFERENCE
// =============================================================================

describe('rrTypeFromValues', () => {
	it('reports string for an empty sample', () => {
		assert.equal(rrTypeFromValues([]), 'string');
	});

	it('reports string when every value is null', () => {
		assert.equal(rrTypeFromValues([null, null, undefined]), 'string');
	});

	it('reports number for JS numbers', () => {
		assert.equal(rrTypeFromValues([1, 2, 3.5, -4]), 'number');
	});

	it('skips nulls when deciding', () => {
		assert.equal(rrTypeFromValues([null, 1, null, 2]), 'number');
	});

	it('reports number for numeric strings', () => {
		assert.equal(rrTypeFromValues(['1', '2', '-3.5', '3.5e2']), 'number');
	});

	it('keeps a leading-zero string as a string', () => {
		assert.equal(rrTypeFromValues(['0123', '0456']), 'string');
	});

	it('keeps a doubled-zero string as a string', () => {
		assert.equal(rrTypeFromValues(['00']), 'string');
	});

	it('treats a bare zero as a number', () => {
		assert.equal(rrTypeFromValues(['0']), 'number');
	});

	it('treats a leading zero before a decimal point as a number', () => {
		assert.equal(rrTypeFromValues(['0.5', '0']), 'number');
	});

	it('reports boolean for booleans', () => {
		assert.equal(rrTypeFromValues([true, false]), 'boolean');
	});

	it('reports json for objects', () => {
		assert.equal(rrTypeFromValues([{ a: 1 }, { b: 2 }]), 'json');
	});

	it('reports json for arrays', () => {
		assert.equal(rrTypeFromValues([[1, 2], []]), 'json');
	});

	it('reports date for an ISO date', () => {
		assert.equal(rrTypeFromValues(['2026-09-14', '2026-01-02']), 'date');
	});

	it('reports date for an ISO timestamp with a zone', () => {
		assert.equal(rrTypeFromValues(['2026-09-14T14:02:00Z']), 'date');
	});

	it('reports date for the space-separated form the node emits', () => {
		assert.equal(rrTypeFromValues(['2026-09-14 14:02:00']), 'date');
	});

	it('rejects an impossible date that matches the shape', () => {
		assert.equal(rrTypeFromValues(['2026-13-45']), 'string');
	});

	it('reports string for free text', () => {
		assert.equal(rrTypeFromValues(['abc', 'def']), 'string');
	});

	it('reports string for a mixed sample', () => {
		assert.equal(rrTypeFromValues([1, 'abc']), 'string');
	});

	it('samples only the first 200 non-null values', () => {
		const values: unknown[] = Array.from({ length: 200 }, (_, i) => i);
		values.push('not a number');
		assert.equal(rrTypeFromValues(values), 'number');
	});
});

// =============================================================================
// COLUMN TYPING OVER A RESULT
// =============================================================================

/** A two-table schema snapshot. */
const SCHEMA: ISqlSchemaResponse = {
	database: 'sample_shop',
	tables: {
		orders: {
			columns: [
				{ column: 'id', type: 'BIGINT' },
				{ column: 'placed_at', type: 'DATETIME' },
				{ column: 'note', type: 'VARCHAR(255)' },
			],
			primary_key: ['id'],
		},
		customers: {
			columns: [
				{ column: 'id', type: 'BIGINT' },
				{ column: 'name', type: 'VARCHAR(64)' },
			],
		},
	},
};

/** Three rows shaped like `SELECT id, placed_at, note FROM orders`. */
const ROWS = [
	{ id: 1, placed_at: '2026-09-14 14:02:00', note: 'first' },
	{ id: 2, placed_at: '2026-09-14 15:00:00', note: null },
	{ id: 3, placed_at: '2026-09-15 09:30:00', note: 'third' },
];

describe('inferColumnTypes', () => {
	it('returns nothing for an empty result', () => {
		assert.deepEqual(inferColumnTypes([], SCHEMA, 'SELECT * FROM orders', 'mysql'), {});
	});

	it('uses the schema when a single source table is certain', () => {
		const types = inferColumnTypes(ROWS, SCHEMA, 'SELECT id, placed_at, note FROM orders', 'mysql');
		assert.equal(types.id.source, 'schema');
		assert.equal(types.id.rrType, 'number');
		assert.equal(types.id.description, 'BIGINT (schema)');
		assert.equal(types.placed_at.rrType, 'date');
		assert.equal(types.note.description, 'VARCHAR(255) (schema)');
	});

	it('uses the schema for SELECT * from one table', () => {
		assert.equal(inferColumnTypes(ROWS, SCHEMA, 'SELECT * FROM orders', 'mysql').id.source, 'schema');
	});

	it('sees through a trailing LIMIT and a WHERE', () => {
		const sql = 'SELECT * FROM orders WHERE id > 0 ORDER BY id LIMIT 200';
		assert.equal(inferColumnTypes(ROWS, SCHEMA, sql, 'mysql').id.source, 'schema');
	});

	it('sees through a comment', () => {
		const sql = '-- daily check\nSELECT * FROM orders';
		assert.equal(inferColumnTypes(ROWS, SCHEMA, sql, 'mysql').id.source, 'schema');
	});

	it('resolves a schema-qualified table name', () => {
		assert.equal(inferColumnTypes(ROWS, SCHEMA, 'SELECT * FROM sample_shop.orders', 'mysql').id.source, 'schema');
	});

	it('falls back to inference when the statement joins', () => {
		const sql = 'SELECT o.id, o.placed_at, o.note FROM orders o JOIN customers c ON c.id = o.id';
		const types = inferColumnTypes(ROWS, SCHEMA, sql, 'mysql');
		assert.equal(types.id.source, 'inferred');
		assert.equal(types.id.rrType, 'number');
	});

	it('falls back to inference for an old-style comma join', () => {
		const sql = 'SELECT id, placed_at, note FROM orders, customers';
		assert.equal(inferColumnTypes(ROWS, SCHEMA, sql, 'mysql').id.source, 'inferred');
	});

	it('falls back to inference when a returned column is not in the table', () => {
		const rows = [{ id: 1, total: 9 }];
		assert.equal(inferColumnTypes(rows, SCHEMA, 'SELECT id, COUNT(*) AS total FROM orders', 'mysql').id.source, 'inferred');
	});

	it('falls back to inference when the table is not in the snapshot', () => {
		assert.equal(inferColumnTypes(ROWS, SCHEMA, 'SELECT * FROM unknown_table', 'mysql').id.source, 'inferred');
	});

	it('infers when no statement is supplied', () => {
		const types = inferColumnTypes(ROWS, SCHEMA, undefined, 'mysql');
		assert.equal(types.placed_at.source, 'inferred');
		assert.equal(types.placed_at.rrType, 'date');
	});

	it('infers when no schema is supplied', () => {
		assert.equal(inferColumnTypes(ROWS, null, 'SELECT * FROM orders', 'mysql').id.source, 'inferred');
	});

	it('counts only the non-null values it sampled in the description', () => {
		const types = inferColumnTypes(ROWS, null, undefined, 'mysql');
		assert.equal(types.id.description, 'number (inferred from 3 rows)');
		assert.equal(types.note.description, 'string (inferred from 2 rows)');
	});

	it('says so when a column had no non-null value to go on', () => {
		const rows = [{ a: null }, { a: null }];
		assert.equal(inferColumnTypes(rows, null, undefined, 'mysql').a.description, 'string (no non-null values to infer from)');
	});

	it('covers columns that only appear in a later row', () => {
		const rows = [{ a: 1 }, { a: 2, b: 'x' }];
		assert.equal(inferColumnTypes(rows, null, undefined, 'mysql').b.rrType, 'string');
	});
});
