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
// RESULT COLUMNS — the inspector and the grid list the statement's own columns
// =============================================================================
//
// Tabulator writes into the row objects it is given: every column the grid
// has when a row renders adds a key to that row, even an `undefined` one
// (Cell.build → column.setFieldValue). The grid applies new data before new
// columns, so statement 1's rows briefly render under statement 3's columns
// and keep statement 3's keys. A column list read from `Object.keys` of a row
// the grid has seen is therefore another statement's list.
//
// So a statement's columns are captured when it settles, before any grid has
// seen its rows, and the inspector, the column types and the grid's columns
// are built from that list. The grid gets copies of the rows, never the
// statement's own objects. The view has no DOM harness here, so its wiring is
// checked on the source, as the other wiring suites do.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { StatementRun } from '../src/sql/batch';
import { gridCopies, resultColumns, settleStatement } from '../src/sql/batch';
import { inferColumnTypes } from '../src/sql/resultTypes';
import { inspectorFields } from '../src/components/CellInspector';

const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

/**
 * A pending statement.
 *
 * @param sql - Its text.
 * @returns The run.
 */
function pending(sql = 'SELECT id, name FROM customers'): StatementRun {
	return { index: 0, sql, kind: 'read', verb: 'SELECT', outcome: 'running' };
}

describe('resultColumns', () => {
	it('lists every key in first-seen order, so a key missing from the first row still counts', () => {
		assert.deepEqual(resultColumns([{ a: 1, b: 2 }, { a: 3, c: 4 }]), ['a', 'b', 'c']);
	});

	it('is empty for no rows', () => {
		assert.deepEqual(resultColumns([]), []);
	});
});

describe('settleStatement', () => {
	it('captures the columns when the statement settles', () => {
		const settled = settleStatement(pending(), { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 });
		assert.deepEqual(settled.columns, ['id', 'name']);
		assert.equal(settled.outcome, 'rows');
		assert.equal(settled.rowCount, 2);
	});

	it('keeps the captured list when the grid later writes another statement\'s keys into a row', () => {
		const settled = settleStatement(pending(), { rows: [{ id: 1, name: 'a' }], affected_rows: 0 });
		// What Tabulator does when statement 3's columns are still set.
		(settled.rows?.[0] as Record<string, unknown>).extra = undefined;
		assert.deepEqual(settled.columns, ['id', 'name']);
	});

	it('a write with no rows has no columns and reports what it affected', () => {
		const settled = settleStatement({ ...pending('UPDATE t SET a = 1 WHERE id = 2'), kind: 'write', verb: 'UPDATE' }, { rows: [], affected_rows: 3 });
		assert.equal(settled.outcome, 'affected');
		assert.equal(settled.affected, 3);
		assert.deepEqual(settled.columns, []);
	});

	it('a read with no rows is still a row result', () => {
		assert.equal(settleStatement(pending(), { rows: [], affected_rows: 0 }).outcome, 'rows');
	});
});

describe('inspectorFields', () => {
	it('lists the statement\'s captured columns, also after a simulated Tabulator mutation', () => {
		const row: Record<string, unknown> = { id: 1, name: 'a' };
		const columns = ['id', 'name'];
		row.extra = undefined;
		const { fields, json } = inspectorFields(row, columns);
		assert.deepEqual(fields.map((field) => field.label), ['id', 'name']);
		assert.deepEqual(fields.map((field) => field.value), [1, 'a']);
		assert.deepEqual(JSON.parse(json), { id: 1, name: 'a' });
	});

	it('follows the captured order, not the row object\'s', () => {
		const { fields } = inspectorFields({ name: 'a', id: 1 }, ['id', 'name']);
		assert.deepEqual(fields.map((field) => field.label), ['id', 'name']);
	});

	it('a column the row lacks reads as null in the JSON, not as a missing key', () => {
		assert.deepEqual(JSON.parse(inspectorFields({ a: 1 }, ['a', 'b']).json), { a: 1, b: null });
	});
});

describe('column types from the captured columns', () => {
	it('types only the captured columns, whatever keys the rows have gained', () => {
		const rows: Record<string, unknown>[] = [{ id: 1 }];
		rows[0].extra = undefined;
		assert.deepEqual(Object.keys(inferColumnTypes(rows, null, 'SELECT id FROM t', 'postgres', ['id'])), ['id']);
	});
});

describe('gridCopies', () => {
	it('hands the grid copies, so the grid\'s writes never reach the statement\'s rows', () => {
		const rows = [{ id: 1 }, { id: 2 }];
		const copies = gridCopies(rows);
		assert.notEqual(copies[0], rows[0]);
		(copies[0] as Record<string, unknown>).extra = undefined;
		assert.deepEqual(Object.keys(rows[0]), ['id']);
		assert.deepEqual(copies, [{ id: 1, extra: undefined }, { id: 2 }]);
	});
});

describe('QueryView wiring of the result columns', () => {
	it('settles statements through settleStatement', () => {
		assert.match(view, /settle: \(run, response\) => settleStatement\(run, response\)/);
	});

	it('builds the grid columns and the column types from the shown run\'s captured columns, never from Object.keys of a row', () => {
		assert.doesNotMatch(view, /Object\.keys\(first\)/);
		assert.doesNotMatch(view, /Object\.keys\(row/);
		assert.match(view, /const resultCols = displayed\?\.columns \?\? EMPTY_COLUMNS;/);
		assert.match(view, /inferColumnTypes\(rows, snapshot\.schema, displayed\.sql, dialect, resultCols\)/);
		assert.match(view, /resultCols\.map\(\(key\) => \{/);
	});

	it('hands the grid memoised copies keyed by the run shown, and maps a clicked copy back to its index', () => {
		assert.match(view, /const gridRows = useMemo\(\(\) => gridCopies\(rows\), \[rows\]\);/);
		assert.match(view, /data=\{gridRows\}/);
		assert.match(view, /key=\{`\$\{batchSeq\}:\$\{displayed\.index\}`\}/);
		assert.match(view, /onRowClick=\{\(row\) => \{\s*const index = gridRows\.indexOf\(row\);/);
	});

	it('gives the inspector the statement\'s own row and columns', () => {
		assert.match(view, /<CellInspector[\s\S]*?row=\{inspected === null \? null : rows\[inspected\] \?\? null\}/);
		assert.match(view, /<CellInspector[\s\S]*?columns=\{resultCols\}/);
	});
});
