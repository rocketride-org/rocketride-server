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
// RESULT NOTES — the muted lines under a result grid, only when they apply
// =============================================================================
//
// Two notes can ride under a result:
//
//   - PRECISION: the node turns `Decimal` into a float and JSON cannot carry
//     an integer beyond 2^53. The note used to sit under every result with a
//     numeric column; it now shows only when a value could really have lost
//     something: a float with more than 15 significant digits, an integer
//     beyond ±2^53, or a column the schema types as DECIMAL/NUMERIC.
//   - SAME-NAME COLUMNS: rows arrive as objects, so two columns with one name
//     merge into one. The note shows, conservatively, when the statement
//     projects `*` over a join or names the same output column twice.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SqlSchemaResponse } from '../src/connect';
import { MERGED_COLUMNS_NOTE, inferColumnTypes, isDecimalSqlType, mayMergeColumns, precisionNoteApplies } from '../src/sql/resultTypes';

const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

const SCHEMA: SqlSchemaResponse = {
	database: 'shop',
	tables: {
		orders: { columns: [{ column: 'id', type: 'INT' }, { column: 'total', type: 'NUMERIC(10,2)' }, { column: 'weight', type: 'DOUBLE PRECISION' }] },
		events: { columns: [{ column: 'id', type: 'UInt64' }, { column: 'amount', type: 'Decimal(18, 4)' }] },
	},
};

/**
 * Whether the precision note shows for rows of a statement.
 *
 * @param rows - The rows.
 * @param sql - The statement.
 * @param schema - The schema snapshot.
 * @returns The answer.
 */
function note(rows: Record<string, unknown>[], sql = 'SELECT 1', schema: SqlSchemaResponse | null = null): boolean {
	const columns = Object.keys(rows[0] ?? {});
	return precisionNoteApplies(columns, rows, inferColumnTypes(rows, schema, sql, 'postgres', columns));
}

describe('precisionNoteApplies', () => {
	it('is off for ordinary numbers', () => {
		assert.equal(note([{ n: 1, f: 0.1, g: 123.456, h: 560, big: Number.MAX_SAFE_INTEGER, neg: -Number.MAX_SAFE_INTEGER }]), false);
		assert.equal(note([{ f: 0.123456789012345 }]), false, '15 significant digits');
	});

	it('is on for a float with more than 15 significant digits', () => {
		assert.equal(note([{ f: 0.1 + 0.2 }]), true);
		assert.equal(note([{ f: 1234567.123456789 }]), true);
	});

	it('is on for an integer beyond ±2^53', () => {
		assert.equal(note([{ n: 2 ** 53 + 2 }]), true);
		assert.equal(note([{ n: -(2 ** 53) - 2 }]), true);
		assert.equal(note([{ n: 1e20 }]), true);
	});

	it('is on for a column the schema types as DECIMAL or NUMERIC, whatever the values', () => {
		assert.equal(note([{ id: 1, total: 560 }], 'SELECT id, total FROM orders', SCHEMA), true);
		assert.equal(note([{ id: 1, amount: 3.5 }], 'SELECT id, amount FROM events', SCHEMA), true);
	});

	it('is off for a schema-typed float or integer column with ordinary values', () => {
		assert.equal(note([{ id: 1, weight: 2.5 }], 'SELECT id, weight FROM orders', SCHEMA), false);
	});

	it('is off for numbers written as text and for non-numbers', () => {
		assert.equal(note([{ s: '9007199254740993', t: 'x', b: true, o: { n: 0.1 + 0.2 }, z: null }]), false);
	});

	it('reads only the captured columns', () => {
		const rows: Record<string, unknown>[] = [{ id: 1, extra: 0.1 + 0.2 }];
		assert.equal(precisionNoteApplies(['id'], rows, inferColumnTypes(rows, null, 'SELECT id', 'postgres', ['id'])), false);
	});
});

describe('isDecimalSqlType', () => {
	it('matches DECIMAL, NUMERIC and their spellings by whole token', () => {
		for (const type of ['DECIMAL(10,2)', 'numeric', 'NUMERIC(12, 4)', 'dec(5)', 'FIXED', 'Decimal(18, 4)', 'Decimal64(4)', 'Nullable(Decimal(9, 2))']) assert.equal(isDecimalSqlType(type), true, type);
		for (const type of ['INT', 'DOUBLE PRECISION', 'FLOAT', 'MONEY', 'TEXT', 'VARCHAR(10)']) assert.equal(isDecimalSqlType(type), false, type);
	});
});

describe('mayMergeColumns', () => {
	it('flags * over a join, in either spelling of the join', () => {
		assert.equal(mayMergeColumns('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id', 'postgres'), true);
		assert.equal(mayMergeColumns('SELECT * FROM orders o LEFT OUTER JOIN customers c USING (customer_id)', 'mysql'), true);
		assert.equal(mayMergeColumns('select * from orders, customers', 'postgres'), true);
	});

	it('flags two table stars over a join, not one', () => {
		assert.equal(mayMergeColumns('SELECT o.*, c.* FROM orders o JOIN customers c ON c.id = o.customer_id', 'postgres'), true);
		assert.equal(mayMergeColumns('SELECT o.*, c.name FROM orders o JOIN customers c ON c.id = o.customer_id', 'postgres'), false);
	});

	it('flags an output name used twice: a column, an alias, or both', () => {
		assert.equal(mayMergeColumns('SELECT o.order_id, c.name, p.name FROM orders o JOIN customers c ON c.id = o.c JOIN products p ON p.id = o.p', 'postgres'), true);
		assert.equal(mayMergeColumns('SELECT a AS x, b AS x FROM t', 'postgres'), true);
		assert.equal(mayMergeColumns('SELECT a x, b AS "x" FROM t', 'postgres'), true);
		assert.equal(mayMergeColumns('SELECT o.id, c.id FROM o, c', 'mysql'), true);
	});

	it('folds unquoted names on PostgreSQL only, as the servers name the columns', () => {
		assert.equal(mayMergeColumns('SELECT id, ID FROM t', 'postgres'), true);
		assert.equal(mayMergeColumns('SELECT id, ID FROM t', 'mysql'), false);
		assert.equal(mayMergeColumns('SELECT "id", "ID" FROM t', 'postgres'), false);
	});

	it('stays quiet when nothing repeats', () => {
		for (const sql of [
			'SELECT * FROM orders',
			'SELECT id, name FROM customers',
			'SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id',
			"SELECT * FROM t WHERE note = 'a join b, c'",
			'SELECT * FROM t WHERE id IN (SELECT a.id FROM a JOIN b ON a.id = b.id)',
			'SELECT count(*), count(*) FROM t',
			'SELECT * FROM (SELECT 1 AS a) s',
			'UPDATE t SET a = 1',
		]) {
			assert.equal(mayMergeColumns(sql, 'postgres'), false, sql);
		}
	});

	it('reads the statement a WITH chain carries, and past comments and DISTINCT', () => {
		assert.equal(mayMergeColumns('WITH x AS (SELECT id FROM a) SELECT * FROM x JOIN b ON b.id = x.id', 'postgres'), true);
		assert.equal(mayMergeColumns('-- both\nSELECT DISTINCT a.id, /* again */ b.id FROM a, b', 'postgres'), true);
	});

	it('says so in plain words', () => {
		assert.equal(MERGED_COLUMNS_NOTE, 'Columns with the same name are merged; alias them');
	});
});

describe('QueryView: the notes under the grid', () => {
	it('shows the precision note only when it applies', () => {
		assert.doesNotMatch(view, /const hasNumeric/);
		assert.match(view, /precisionNoteApplies\(resultCols, rows, columnTypes\)/);
	});

	it('shows the same-name note when the statement may merge columns', () => {
		assert.match(view, /mayMergeColumns\(displayed\.sql, dialect\)/);
		assert.match(view, /\{MERGED_COLUMNS_NOTE\}/);
	});
});
