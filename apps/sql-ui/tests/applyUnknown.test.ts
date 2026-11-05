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
// AN APPLY WHOSE ANSWER NEVER CAME, AND EDITING DURING AN APPLY (review round 2)
// =============================================================================
//
// R2-I1: an apply that threw without a reply may still have run (the frame's
// own "It may still have run"): the page says so, reads the table again,
// keeps the staged changes, and lets Apply run again only after Review SQL,
// whose words then say rows may already be saved. R2-M3: a controller that
// goes away mid-apply says so at once. R2-I4: nothing can be staged, undone
// or planned while an apply runs, and what it settled is dropped by key.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import { thrownApplyMayHaveRun } from '../src/sql/applyMode';
import { MAY_HAVE_RUN_REASON, mayHaveRunWarning } from '../src/components/ReviewSqlDialog';
import { dropKeys, emptyRowEdits, stageUpdate, unstage } from '../src/sql/rowEdits';
import type { RowEditTarget } from '../src/sql/rowEdits';

const SRC = path.resolve(__dirname, '..', 'src');
const VIEW = fs.readFileSync(path.join(SRC, 'views', 'TableDataView.tsx'), 'utf8');
const DRAWER = fs.readFileSync(path.join(SRC, 'components', 'RecordDrawer.tsx'), 'utf8');
const DESIGN = fs.readFileSync(path.join(SRC, 'views', 'TableDesignView.tsx'), 'utf8');

describe('R2-I1: which thrown applies may still have run', () => {
	it('the frame\'s lost connection ("It may still have run"), any timeout, and anything not a known refusal: may have run', () => {
		const lost = new ExplorerToolError({ kind: 'timeout', tool: 'sql.applyBatch', message: 'Lost the connection while \'sql.applyBatch\' was running. It may still have run.' });
		assert.equal(thrownApplyMayHaveRun(lost), true);
		assert.equal(thrownApplyMayHaveRun(new ExplorerToolError({ kind: 'timeout', tool: 'sql.applyBatch', message: '\'sql.applyBatch\' did not answer within 645s; it may still be running.' })), true);
		assert.equal(thrownApplyMayHaveRun(new ExplorerToolError({ kind: 'malformed', tool: 'apply', message: 'odd answer' })), true);
		assert.equal(thrownApplyMayHaveRun(new Error('something else')), true);
		assert.equal(thrownApplyMayHaveRun('a string'), true);
	});

	it('refused before anything was sent: the list, no connection, another account, no transactions, begin refused', () => {
		for (const kind of ['invalid', 'unavailable', 'stale', 'upgrade', 'raised'] as const) {
			assert.equal(thrownApplyMayHaveRun(new ExplorerToolError({ kind, tool: 'apply', message: 'no' })), false, kind);
		}
	});

	it('the words: Apply waits for Review SQL, which says rows may be saved and new rows could be inserted twice', () => {
		assert.equal(MAY_HAVE_RUN_REASON, 'The last Apply may have run. Open Review SQL and check the data before applying again.');
		assert.equal(mayHaveRunWarning(0), 'The last Apply may have run: its answer did not arrive. Some of these changes may already be saved, so check the data before you apply again.');
		assert.match(mayHaveRunWarning(2), /A new row that was saved would be inserted a second time\.$/);
	});

	it('the data page: a thrown apply that may have run reads the table again, keeps the edits, and holds Apply until Review', () => {
		assert.match(VIEW, /if \(thrownApplyMayHaveRun\(error\)\) \{[\s\S]*?setUncertain\('blocked'\);[\s\S]*?setWriteEpoch\(\(n\) => n \+ 1\);/);
		assert.match(VIEW, /applyDisabledReason=\{editGate \?\? \(uncertain === 'blocked' \? MAY_HAVE_RUN_REASON : null\)\}/);
		assert.match(VIEW, /if \(uncertain === 'blocked'\) setUncertain\('reviewed'\);/);
		assert.match(VIEW, /<ReviewSqlDialog[\s\S]*?warning=\{uncertain \? mayHaveRunWarning\(counts\.inserted\) : null\}/);
		assert.match(VIEW, /<ApplyConfirmDialog[\s\S]*?warning=\{uncertain \? mayHaveRunWarning\(counts\.inserted\) : null\}/);
	});

	it('the designer classifies a thrown apply the same way', () => {
		assert.match(DESIGN, /const unknown = thrownApplyMayHaveRun\(err\);/);
	});
});

describe('R2-M3: a controller that goes away mid-apply says so at once', () => {
	it('when the engine stops being ready during an apply, the outcome is unknown now, not after the whole timeout', () => {
		assert.match(VIEW, /if \(!applying \|\| env\.ready\) return;[\s\S]*?setLostDuringApply\(true\);[\s\S]*?setUncertain\('blocked'\);/);
		assert.match(VIEW, /busyLabel=\{lostDuringApply \? 'Outcome unknown' : 'Applying\.\.\.'\}/);
	});
});

describe('R2-I4: no staging while an apply runs, and what it settled is dropped by key', () => {
	const target: RowEditTarget = { dialect: 'postgres', table: 'orders', def: { columns: [{ column: 'id', type: 'INTEGER' }, { column: 'status', type: 'TEXT' }], primary_key: ['id'] } };

	it('an Undo during the run does not make another change leave staging: settled by key, not position', () => {
		let edits = emptyRowEdits();
		for (const id of [1, 2, 3]) edits = stageUpdate(edits, target, { id, status: 'a' }, { status: 'b' });
		const sent = edits.entries.map((edit) => edit.key);
		// During the run the user undoes row 1; the apply saved row 1 only, then failed at row 2.
		const current = unstage(edits, sent[0]!);
		const after = dropKeys(current, sent.slice(0, 1));
		assert.deepEqual(after.entries.map((edit) => edit.key), [sent[1], sent[2]], 'row 2 is still staged');
	});

	it('the data page sends the keys with the statements and drops the settled ones by key', () => {
		assert.match(VIEW, /keys: edits\.entries\.map\(\(edit\) => edit\.key\)/);
		assert.match(VIEW, /setEdits\(\(current\) => dropKeys\(current, ask\.keys\.slice\(0, settled\)\)\)/);
		assert.match(VIEW, /if \(applying\) return 'An apply is running\.';/);
	});

	it('the drawer: Undo and an open form\'s Stage wait for the apply', () => {
		assert.match(DRAWER, /disabled=\{editing\.busy\}[^>]*>Undo<\/Button>|<Button variant="secondary" disabled=\{editing\.busy\} onClick=\{\(\) => \{ editing\.undo\(row\)/);
		assert.match(DRAWER, /<Button variant="primary" disabled=\{busy\} onClick=\{\(\) => onSubmit\(values\)\}>\{submitLabel\}<\/Button>/);
		assert.match(VIEW, /busy: applying,/);
	});

	it('the designer: no gesture changes the plan while it applies, and the failed plan is settled from what was sent', () => {
		for (const gesture of ['addColumn', 'selectColumn', 'applyEdit']) {
			assert.match(DESIGN, new RegExp(`const ${gesture} = useCallback\\([^]*?if \\(applying\\) return;`), gesture);
		}
		assert.match(DESIGN, /setOps\(\(prev\) => \[\.\.\.planAfterFailure\(sent, stopped\), \.\.\.prev\.slice\(sent\.length\)\]\)/);
		assert.match(DESIGN, /Stage Foreign Key/);
		assert.ok((DESIGN.match(/disabled=\{applying\}/g) ?? []).length >= 2, 'drop buttons wait for the apply');
	});
});
