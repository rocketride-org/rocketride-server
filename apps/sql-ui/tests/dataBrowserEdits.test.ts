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
// DATA BROWSER — staged edits wired into the page (P4 phase 2)
// =============================================================================
//
// The views have no DOM harness here (the shell is stubbed inert), so this
// checks the wiring in the source; the logic it wires is tested as pure
// modules (rowEdits, applyMode, applyHistory, the dialogs' text helpers) and
// over the op wire (applySession, devtool.apply).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src');
const VIEW = fs.readFileSync(path.join(SRC, 'views', 'TableDataView.tsx'), 'utf8');
const DRAWER = fs.readFileSync(path.join(SRC, 'components', 'RecordDrawer.tsx'), 'utf8');

/**
 * Where a pattern first matches, failing when it does not.
 *
 * @param text - The source.
 * @param pattern - What to find.
 * @returns Its index.
 */
function at(text: string, pattern: RegExp): number {
	const found = pattern.exec(text);
	assert.ok(found, `${pattern} is in the source`);
	return found.index;
}

describe('the record drawer edits a row in a form, and stages it', () => {
	it('Edit opens a form of one input and a NULL toggle per field, key columns read only; Delete marks the row; Undo unstages it', () => {
		assert.match(DRAWER, /export const RowEditForm: React\.FC<RowEditFormProps>/);
		assert.match(DRAWER, /<InputField[\s\S]*?disabled=\{locked \|\| field\.isNull\}/);
		assert.match(DRAWER, /<input type="checkbox" checked=\{field\.isNull\}/);
		assert.match(DRAWER, /if \(editing && form\) \{[\s\S]*?<RowEditForm[\s\S]*?lockKeys[\s\S]*?submitLabel="Stage changes"/);
		assert.match(DRAWER, />Edit<\/Button>/);
		assert.match(DRAWER, /onClick=\{\(\) => setEditError\(editing\.remove\(row\)\)\}>Delete<\/Button>/);
		assert.match(DRAWER, /editing\.undo\(row\)/);
		assert.match(DRAWER, /Staged, not saved yet: \{staged\}/);
	});

	it('where rows cannot be changed, the buttons are off and the drawer says why', () => {
		assert.match(DRAWER, /disabled=\{off !== null\}/);
		assert.match(DRAWER, /Editing is off: \{off\}/);
	});

	it('Insert row opens the same form, empty, with the key columns open', () => {
		assert.match(VIEW, /onClick=\{\(\) => setNewRow\(\{ fields: editFormFields\(editTarget, null, undefined\), error: null \}\)\}/);
		assert.match(VIEW, /<RowEditForm\s+title="New row"[\s\S]*?lockKeys=\{false\}[\s\S]*?stageInsert\(edits, editTarget, valuesFromForm\(after\)\)/);
	});
});

describe('the grid marks staged rows from the pristine rows, never from the grid\'s own (fact 4)', () => {
	it('the formatter finds the fetched row by position and asks pendingCell about it', () => {
		assert.match(VIEW, /const position = gridRows\.indexOf\(cell\.getRow\(\)\.getData\(\) as Record<string, unknown>\);/);
		assert.match(VIEW, /const source = position >= 0 \? rows\[position\] : undefined;/);
		assert.match(VIEW, /pendingCell\(editsRef\.current, target, source, column\)/);
		assert.doesNotMatch(VIEW, /pendingCell\([^)]*getData\(\)/, 'no mark is read off a grid row object');
		assert.match(VIEW, /formatter: \(cell: GridCellComponent\) => markCell\(cell, col\.column, col\.column === firstColumn\)/);
	});

	it('a tint plus a mark that does not rely on colour, and the formatters re-run when the staged changes move', () => {
		// A light tint the text stays readable on (live bug 9: the list-selection
		// blue, made for white text, hid the values).
		assert.match(VIEW, /el\.style\.background = 'color-mix\(in srgb, var\(--rr-color-info\) 12%, transparent\)'/);
		assert.doesNotMatch(VIEW, /--rr-bg-list-active/);
		assert.match(VIEW, /el\.append\('✎ ', dataCellEl\(mark\.value\)\)/);
		assert.match(VIEW, /if \(first\) el\.append\('Deleted · '\)/);
		assert.match(VIEW, /el\.setAttribute\('aria-description', `Edited, was \$\{was\}`\)/);
		assert.match(VIEW, /getRows\(\)\.forEach\(\(row\) => row\.reformat\(\)\)/);
	});
});

describe('the bar, Review SQL, the confirmation, then one applyBatch', () => {
	it('the pending-changes bar sits above the grid, with the editing gate as Apply\'s reason', () => {
		assert.ok(at(VIEW, /<PendingChangesBar/) < at(VIEW, /<DataGrid<Record<string, unknown>>/));
		assert.match(VIEW, /<PendingChangesBar[\s\S]*?applyDisabledReason=\{editGate\}/);
	});

	it('Review SQL and the bar\'s Apply both go through the confirmation, and only its confirm sends', () => {
		assert.match(VIEW, /<ReviewSqlDialog[\s\S]*?wording=\{review\.mode\.wording\}[\s\S]*?onApply=\{\(\) => \{ void askApply\(\); \}\}/);
		assert.match(VIEW, /<ApplyConfirmDialog[\s\S]*?onConfirm=\{\(\) => \{ void runApply\(applyAsk, applyAsk\.mode\.atomic\); \}\}/);
		assert.match(VIEW, /\.applyBatch\(ask\.statements, \{ atomic \}\)/);
		assert.equal((VIEW.match(/\.applyBatch\(/g) ?? []).length, 1, 'one place sends');
	});

	it('the words come from the table: a MySQL table\'s engine is read before the confirmation', () => {
		assert.match(VIEW, /engineRef\.current = await readTableEngine\(env\.getSession\(endpoint\), table\)/);
		assert.match(VIEW, /rowApplyMode\(dialect, \{ engine: engineRef\.current \?\? null, noTransactions: knownNoTransactions\(endpoint\.key, snapshot\.refreshedAt\) \}\)/);
	});

	it('no transactions after all: remembered, asked again in the per-statement words, resent without one only if agreed', () => {
		assert.match(VIEW, /if \(isTransactionsUnavailable\(error\)\) \{\s*noteNoTransactions\(endpoint\.key, snapshot\.refreshedAt\);/);
		assert.match(VIEW, /perStatementConfirmText\(noTransactionAsk\.reason\)/);
		assert.match(VIEW, /void runApply\(ask, false\);/);
	});

	it('after the reply: each statement in history, then only what was settled leaves the staged changes, then the page is read again', () => {
		const history = at(VIEW, /for \(const entry of applyHistoryEntries\(ask\.statements, result, /);
		const record = at(VIEW, /env\.history\.record\(endpoint, entry\)/);
		const drop = at(VIEW, /setEdits\(\(current\) => dropKeys\(current, ask\.keys\.slice\(0, settled\)\)\)/);
		// The page is read again after the reply is settled (the earlier bump is the may-have-run path).
		const epoch = VIEW.indexOf('setWriteEpoch((n) => n + 1)', drop);
		assert.ok(history < record && record < drop && drop < epoch);
		assert.match(VIEW, /const settled = settledCount\(result, total\);/);
		// The write epoch does what a countEpoch bump does: totals forgotten, the page refetched.
		assert.match(VIEW, /if \(writeEpoch === 0\) return;\s*countRef\.current = invalidateTotals\(countRef\.current\);\s*gridRef\.current\?\.refetch\(\);\s*\}, \[writeEpoch\]\);/);
	});
});

describe('editing is off, with the reason, wherever it cannot work', () => {
	it('one gate for the page: no primary key, ClickHouse, schema only, and no connection or sidebar', () => {
		assert.match(VIEW, /const editGate = rowEditGate\(\{ dialect, def: tableDef, table, executeState, ready: env\.ready \}\);/);
		assert.match(VIEW, /disabled=\{editGate !== null \|\| applying\}[\s\S]*?Insert row/);
		assert.match(VIEW, /disabledReason: applying \? 'An apply is running\.' : editGate/);
	});
});
