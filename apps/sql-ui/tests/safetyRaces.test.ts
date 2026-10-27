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
// SAFETY RACES — the editor and the Query page never undo each other silently
// =============================================================================
//
// The level can be changed in two places: the connection editor (which
// rebuilds the whole record on Save) and the Query page (which sends only the
// level). Two races were found:
//
//   - An editor opened before an in-place change wrote the level it showed
//     when it opened back on Save: off → every on the Query page, then a
//     rename in the editor, stored `off` again, unasked (DA final F-I1). Now an
//     untouched editor shows and saves the LIVE level, and a level the user
//     picks that is lower than the stored one asks first, as the Query page
//     does.
//   - The Query page's 3 s fallback (the owner's answer, kept while this
//     realm's copy of the record lags) was dropped only when the copy's VALUE
//     changed, so a newer copy with the same value kept a stale answer in
//     force (F-M1). It now holds only for the copy it was asked against.
//
// The views have no DOM harness here: the decisions are pure and tested
// directly and over the real dev-tool rig; the wiring is checked in the source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getSavedConnections } from '../src/connect';
import type { DirectConnection, SavedSqlConnection } from '../src/connect';
import { enforcedSafety, safetyLevelOf } from '../src/connect/savedConnections';
import { editorSafetyChoice } from '../src/sql/safety';
import { DIRECT, PIPELINE, rig } from './devtoolRig';
import { until } from './realm';

const read = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');
const OFF: DirectConnection = { ...DIRECT, config: { host: 'db.internal', password: 's3cret' }, safety: 'off' };

/**
 * The record a list holds for an id.
 *
 * @param id - The connection id.
 * @returns The record.
 */
function saved(id: string): SavedSqlConnection | undefined {
	return getSavedConnections().find((c) => c.id === id);
}

describe('editorSafetyChoice', () => {
	it('an untouched editor shows and saves the live stored level, and asks nothing', () => {
		assert.deepEqual(editorSafetyChoice('every', null), { level: 'every', asks: false });
		assert.deepEqual(editorSafetyChoice('off', null), { level: 'off', asks: false });
	});

	it('a level the user picked is kept; a lower one than stored asks first', () => {
		assert.deepEqual(editorSafetyChoice('every', 'off'), { level: 'off', asks: true });
		assert.deepEqual(editorSafetyChoice('every', 'risky'), { level: 'risky', asks: true });
		assert.deepEqual(editorSafetyChoice('risky', 'every'), { level: 'every', asks: false });
		assert.deepEqual(editorSafetyChoice('risky', 'risky'), { level: 'risky', asks: false });
	});

	it('a new connection (nothing stored) takes the pick or the default, and never asks', () => {
		assert.deepEqual(editorSafetyChoice(null, null), { level: 'risky', asks: false });
		assert.deepEqual(editorSafetyChoice(null, 'off'), { level: 'off', asks: false });
	});
});

describe('the editor and an in-place change, over the dev-tool rig', () => {
	it('an editor opened at "Don\'t ask", then a raise on the Query page, then a rename + Save: the raise stands', async () => {
		const r = await rig({ saved: [PIPELINE, OFF] });
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			// 1. The editor opens; its radio is untouched.
			const touched = null;
			assert.equal(editorSafetyChoice(safetyLevelOf(saved('c-direct')), touched).level, 'off');
			// 2. The Query page raises the level (a raise does not ask).
			await r.env.setConnectionSafety('c-direct', 'every');
			await until(() => saved('c-direct')?.safety === 'every', 'the raise');
			// 3. The editor saves a rename: it rebuilds the record with the LIVE level.
			const choice = editorSafetyChoice(safetyLevelOf(saved('c-direct')), touched);
			assert.deepEqual(choice, { level: 'every', asks: false });
			await r.env.saveConnection({ ...OFF, name: 'Renamed', safety: choice.level });
			await until(() => saved('c-direct')?.name === 'Renamed', 'the save');
			assert.equal(saved('c-direct')?.safety, 'every');
		} finally {
			r.dispose();
		}
	});

	it('a level picked in the editor below the stored one asks first, and is stored only once confirmed', async () => {
		const r = await rig({ saved: [PIPELINE, OFF] });
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			await r.env.setConnectionSafety('c-direct', 'every');
			await until(() => saved('c-direct')?.safety === 'every', 'the raise');
			// The user picks "Don't ask" in the editor: lower than stored, so it asks.
			const choice = editorSafetyChoice(safetyLevelOf(saved('c-direct')), 'off');
			assert.deepEqual(choice, { level: 'off', asks: true });
			// Confirmed: saved as picked.
			await r.env.saveConnection({ ...OFF, safety: choice.level });
			await until(() => saved('c-direct')?.safety === 'off', 'the confirmed save');
		} finally {
			r.dispose();
		}
	});
});

describe('the editor wiring', () => {
	const modal = read('components', 'NewConnectionModal.tsx');

	it('no longer seeds the level once: it tracks only whether the user picked one', () => {
		assert.doesNotMatch(modal, /useState<SafetyLevel>\(safetyLevelOf\(editing\)\)/);
		assert.match(modal, /const \[pickedSafety, setPickedSafety\] = useState<SafetyLevel \| null>\(null\);/);
		assert.match(modal, /const safetyChoice = editorSafetyChoice\(editing === null \? null : safetyLevelOf\(editing\), pickedSafety\);/);
		assert.match(modal, /const safety = safetyChoice\.level;/);
		assert.match(modal, /onChange=\{\(\) => setPickedSafety\(option\.id\)\}/);
	});

	it('both save paths go through the lowering check, which asks with the same dialog as the Query page', () => {
		assert.match(modal, /if \(path === 'pipeline'\) confirmSafetyThen\(\(\) => \{ void savePipeline\(\); \}\);/);
		assert.match(modal, /onSubmit=\{\(formData\) => confirmSafetyThen\(\(\) => \{ void saveDirect\(formData\); \}\)\}/);
		assert.match(modal, /if \(safetyChoice\.asks\) \{\s*setLowering\(\(\) => proceed\);\s*return;\s*\}/);
		assert.match(modal, /<SafetyDowngradeDialog[\s\S]*?level=\{safety\}/);
	});

	it('Cancel saves nothing and puts the radio back on the stored level', () => {
		assert.match(modal, /onCancel=\{\(\) => \{\s*setLowering\(null\);\s*setPickedSafety\(null\);\s*\}\}/);
	});
});

describe('enforcedSafety (the Query page\'s 3 s fallback)', () => {
	const copy = (safety: SavedSqlConnection['safety']): SavedSqlConnection => ({ ...OFF, safety });

	it('with no answer from the owner, the copy\'s level is in force', () => {
		const record = copy('risky');
		assert.equal(enforcedSafety(record, null), 'risky');
		assert.equal(enforcedSafety(null, null), 'risky');
	});

	it('the owner\'s answer holds while the copy it was asked against is the one held', () => {
		const lagging = copy('risky');
		assert.equal(enforcedSafety(lagging, { level: 'off', against: lagging }), 'off');
	});

	it('copy lag, then a second writer: a newer copy with the SAME value drops the answer', () => {
		// This document lowered the level to off; the copy lagged at risky, so
		// after 3 s the owner was asked and said off.
		const lagging = copy('risky');
		const asked = { level: 'off' as const, against: lagging };
		assert.equal(enforcedSafety(lagging, asked), 'off');
		// Another document raised it back to risky; the copy jumps straight to a
		// new record holding the value it already showed.
		const newer = copy('risky');
		assert.equal(enforcedSafety(newer, asked), 'risky', 'the stale answer no longer holds');
	});

	it('QueryView keeps the answer with the copy it was asked against, and enforces enforcedSafety', () => {
		const view = read('views', 'QueryView.tsx');
		assert.match(view, /const safety = enforcedSafety\(connectionRecord, askedSafety\);/);
		assert.match(view, /\(record\) => setAskedSafety\(record === null \? null : \{ level: safetyLevelOf\(record\), against: connectionRecordRef\.current \}\),/);
		assert.doesNotMatch(view, /\[recordSafety\]/, 'not reset on the value alone');
	});
});
