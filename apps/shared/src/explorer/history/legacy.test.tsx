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
// EXPLORER HISTORY — LEGACY KEYS (saved SQL history survives the new key)
// =============================================================================
//
// The owner-aware connection key replaces SQL Explorer's `projectId:source:nodeId`.
// Everything saved under the old key — history entries, the recording switch,
// the pattern-check switch — must still be read, without migrating, renaming
// or deleting anything behind the user's back, and without ever being read
// across owners or across dev and deploy. No automatic write touches the old
// list (a run, the bound, a pin or note copy), for any team context that reads
// it; only the user's own Delete or Clear removes entries from it.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHistoryStore } from './store';
import { createConnectionFlags } from './flags';
import type { IHistoryEntry, IPrefsAccessor } from './types';
import { buildEndpointKey, legacyKeyFromKey } from '../keys';

// =============================================================================
// FIXTURES
// =============================================================================

const BATCH_MS = 10;

/** The user's own dev run: the only connection the old key could have meant. */
const DEV = buildEndpointKey({ runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't', projectId: 'proj-1', roles: { tools: 'tools_1' }, nodeId: 'db_1' });
/** The user's own dev run of the same pipeline under ANOTHER development team: it reads the same old list. */
const DEV_OTHER_TEAM = buildEndpointKey({ runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't2', projectId: 'proj-1', roles: { tools: 'tools_1' }, nodeId: 'db_1' });
/** The team's deployment of the SAME project, source and node. */
const DEPLOY = buildEndpointKey({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', teamId: 'team-1', projectId: 'proj-1', roles: { tools: 'tools_1' }, nodeId: 'db_1' });
/** What SQL Explorer saved before the key changed. */
const OLD = 'proj-1:tools_1:db_1';

/** A fake workspace preferences file. */
interface IFakePrefs {
	values: Record<string, unknown>;
	api: IPrefsAccessor;
}

/**
 * Build a fake preferences file (writes round-trip through JSON).
 *
 * @param initial - What it holds.
 * @returns The file.
 */
function fakePrefs(initial: Record<string, unknown> = {}): IFakePrefs {
	const values: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
	return {
		values,
		api: {
			getPref: (key) => values[key],
			setPref: (key, value) => { values[key] = JSON.parse(JSON.stringify(value)); },
		},
	};
}

/**
 * One saved SQL entry.
 *
 * @param id - Id.
 * @param sql - Text.
 * @param at - Time.
 * @param over - Extra fields.
 * @returns The entry.
 */
function saved(id: string, sql: string, at: number, over: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, sql, at, ms: 4, outcome: 'rows', kind: 'read', rows: 1, ...over };
}

/**
 * Build a SQL history store with the legacy bridge.
 *
 * @returns The store.
 */
function sqlStore() {
	return createHistoryStore<'sql'>({ historyKey: 'sql.history', recordingKey: 'sql.historyRecording', textField: 'sql', persistDelayMs: BATCH_MS, legacyKeyOf: legacyKeyFromKey });
}

/**
 * Read a connection's history through the hook.
 *
 * @param store - The store.
 * @param key - The connection.
 * @returns The entry ids, newest first.
 */
function ids(store: ReturnType<typeof sqlStore>, key: string): string[] {
	let seen: IHistoryEntry<'sql'>[] = [];
	const Probe: React.FC = () => { seen = store.useHistory(key); return null; };
	renderToStaticMarkup(<Probe />);
	return seen.map((entry) => entry.id);
}

/**
 * Read a connection's recording switch through the hook.
 *
 * @param store - The store.
 * @param key - The connection.
 * @returns The switch.
 */
function recording(store: ReturnType<typeof sqlStore>, key: string): boolean {
	let seen = true;
	const Probe: React.FC = () => { seen = store.useRecording(key); return null; };
	renderToStaticMarkup(<Probe />);
	return seen;
}

/**
 * Wait past the batch window.
 *
 * @returns A promise.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, BATCH_MS * 4); });
}

/**
 * The saved list under one key.
 *
 * @param prefs - The file.
 * @param key - The key.
 * @returns The raw entries.
 */
function stored(prefs: IFakePrefs, key: string): Array<Record<string, unknown>> | undefined {
	return (prefs.values['sql.history'] as Record<string, Array<Record<string, unknown>>> | undefined)?.[key];
}

const OLD_LIST = [saved('o2', 'SELECT 2', 20, { pinned: true, note: 'keep me' }), saved('o1', 'SELECT 1', 10)];

/**
 * A full old list: 100 entries, newest first.
 *
 * @param count - How many.
 * @returns The entries.
 */
function fullOldList(count = 100): Array<Record<string, unknown>> {
	return Array.from({ length: count }, (_, i) => saved(`o${count - i}`, `SELECT ${count - i}`, (count - i) * 10));
}

/**
 * Record one run under a connection.
 *
 * @param store - The store.
 * @param key - The connection.
 * @param id - The entry id.
 * @param at - Its time.
 */
function runOn(store: ReturnType<typeof sqlStore>, key: string, id: string, at: number): void {
	store.runs.emitRun(key, { id, sql: `SELECT '${id}'`, at, ms: 1, outcome: 'rows', rows: 1, kind: 'read' } as IHistoryEntry<'sql'>);
}

// =============================================================================
// HISTORY
// =============================================================================

describe('history under a legacy key', () => {
	it('shows entries saved under the OLD key when the connection is opened under the new key', () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const detach = store.attachPrefs(prefs.api);
		try {
			assert.deepEqual(ids(store, DEV), ['o2', 'o1']);
			assert.deepEqual(ids(store, OLD), ['o2', 'o1']);
		} finally {
			detach();
		}
	});

	it('shows NOTHING for the team deployment of the same project: history never crosses dev and deploy', () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const detach = store.attachPrefs(prefs.api);
		try {
			assert.deepEqual(ids(store, DEPLOY), []);
			assert.equal(legacyKeyFromKey(DEPLOY), null);
		} finally {
			detach();
		}
	});

	it('writes new runs under the NEW key only and leaves the old list byte-identical', async () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const detach = store.attachPrefs(prefs.api);
		try {
			store.runs.emitRun(DEV, { id: 'n1', sql: 'SELECT 3', at: 30, ms: 1, outcome: 'rows', rows: 1, kind: 'read' } as IHistoryEntry<'sql'>);
			await settle();
			assert.deepEqual(stored(prefs, DEV)?.map((e) => e.id), ['n1']);
			assert.deepEqual(stored(prefs, OLD), OLD_LIST);
			assert.deepEqual(ids(store, DEV), ['n1', 'o2', 'o1']);
		} finally {
			detach();
		}
	});

	it('keeps old entries readable across a reload (the file is the source of truth)', async () => {
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const first = sqlStore();
		let detach = first.attachPrefs(prefs.api);
		first.runs.emitRun(DEV, { id: 'n1', sql: 'SELECT 3', at: 30, ms: 1, outcome: 'rows', rows: 1, kind: 'read' } as IHistoryEntry<'sql'>);
		await settle();
		detach();

		const reloaded = sqlStore();
		detach = reloaded.attachPrefs(prefs.api);
		try {
			assert.deepEqual(ids(reloaded, DEV), ['n1', 'o2', 'o1']);
		} finally {
			detach();
		}
	});

	it('pins and annotates an old entry through a COPY under the new key; the old list is untouched', async () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const detach = store.attachPrefs(prefs.api);
		try {
			store.togglePin(DEV, 'o1');
			store.setNote(DEV, 'o1', 'from the new key');
			await settle();
			assert.deepEqual(stored(prefs, OLD), OLD_LIST);
			assert.deepEqual(stored(prefs, DEV)?.map((e) => ({ id: e.id, sql: e.sql, pinned: e.pinned, note: e.note })), [{ id: 'o1', sql: 'SELECT 1', pinned: true, note: 'from the new key' }]);
			// The copy stands in for the original: one row, pinned and annotated.
			assert.deepEqual(ids(store, DEV), ['o2', 'o1']);
			// Another team context still reads the original, unchanged.
			assert.deepEqual(ids(store, DEV_OTHER_TEAM), ['o2', 'o1']);
		} finally {
			detach();
		}
	});

	it('deletes an old entry from the stored old list too, so its text leaves the preferences file', async () => {
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const store = sqlStore();
		let detach = store.attachPrefs(prefs.api);
		try {
			store.removeEntry(DEV, 'o2');
			await settle();
			assert.deepEqual(stored(prefs, OLD), [OLD_LIST[1]], 'Delete takes exactly the deleted id out of the old list');
			assert.equal(JSON.stringify(prefs.values).includes('SELECT 2'), false, 'the deleted statement is still in the file');
			assert.equal(JSON.stringify(prefs.values).includes('keep me'), false, 'the deleted note is still in the file');
			assert.deepEqual(Object.keys(prefs.values).sort(), ['sql.history', 'sql.historyRecording']);
			assert.deepEqual(ids(store, DEV), ['o1']);
			// The old list is shared: the same dev run under another team no longer sees it either.
			assert.deepEqual(ids(store, DEV_OTHER_TEAM), ['o1']);
		} finally {
			detach();
		}
		const reloaded = sqlStore();
		detach = reloaded.attachPrefs(prefs.api);
		try {
			assert.deepEqual(ids(reloaded, DEV), ['o1']);
		} finally {
			detach();
		}
	});

	it('deletes both the copy under the new key and the original when an old entry was pinned first', async () => {
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const store = sqlStore();
		const detach = store.attachPrefs(prefs.api);
		try {
			store.togglePin(DEV, 'o1');
			await settle();
			assert.deepEqual(stored(prefs, DEV)?.map((e) => e.id), ['o1']);
			store.removeEntry(DEV, 'o1');
			await settle();
			assert.equal(stored(prefs, DEV), undefined);
			assert.deepEqual(stored(prefs, OLD), [OLD_LIST[0]]);
			assert.equal(JSON.stringify(prefs.values).includes('SELECT 1'), false, 'the deleted statement is still in the file');
			assert.deepEqual(ids(store, DEV), ['o2']);
		} finally {
			detach();
		}
	});

	it('collapses a re-run of an old statement onto a copy of the old entry, keeping its pin and note', async () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST } });
		const detach = store.attachPrefs(prefs.api);
		try {
			store.runs.emitRun(DEV, { id: 'again', sql: 'SELECT 2', at: 40, ms: 9, outcome: 'rows', rows: 5, kind: 'read' } as IHistoryEntry<'sql'>);
			await settle();
			assert.deepEqual(stored(prefs, OLD), OLD_LIST);
			const own = stored(prefs, DEV)!;
			assert.deepEqual(own.map((e) => e.id), ['o2']);
			assert.equal(own[0]!.pinned, true);
			assert.equal(own[0]!.note, 'keep me');
			assert.equal(own[0]!.at, 40);
			assert.equal(own[0]!.rows, 5);
			assert.deepEqual(ids(store, DEV), ['o2', 'o1']);
		} finally {
			detach();
		}
	});

	it('clears the connection\'s own list AND every old entry, one beyond the visible bound included', async () => {
		const store = sqlStore();
		const full = fullOldList();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: full, [DEV]: [saved('n0', 'SELECT 0', 5_000)] } });
		const detach = store.attachPrefs(prefs.api);
		try {
			// 101 entries: the view shows 100, so the oldest old entry is stored but not shown.
			assert.equal(ids(store, DEV).length, 100);
			store.clearForKey(DEV);
			await settle();
			assert.equal(stored(prefs, DEV), undefined);
			assert.equal(stored(prefs, OLD), undefined, 'Clear must empty the old list');
			assert.equal(JSON.stringify(prefs.values).includes('SELECT'), false, 'a cleared statement is still in the file');
			assert.deepEqual(Object.keys(prefs.values).sort(), ['sql.history', 'sql.historyRecording']);
			assert.deepEqual(ids(store, DEV), []);
			// The old list is shared: the same dev run under another team no longer sees it either.
			assert.deepEqual(ids(store, DEV_OTHER_TEAM), []);
		} finally {
			detach();
		}
		const reloaded = sqlStore();
		const again = reloaded.attachPrefs(prefs.api);
		try {
			assert.deepEqual(ids(reloaded, DEV), []);
		} finally {
			again();
		}
	});

	it('never prunes a FULL old list: a new run bounds the view, not the stored list', async () => {
		const store = sqlStore();
		const full = fullOldList();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: full } });
		const detach = store.attachPrefs(prefs.api);
		try {
			runOn(store, DEV, 'n1', 5_000);
			await settle();
			assert.deepEqual(stored(prefs, OLD), full, 'the old list must be stored exactly as it was');
			assert.deepEqual(stored(prefs, DEV)?.map((e) => e.id), ['n1']);
			const view = ids(store, DEV);
			assert.equal(view.length, 100);
			assert.equal(view[0], 'n1');
		} finally {
			detach();
		}
	});

	it('never lets one team context\'s runs wipe the old entries another team context reads', async () => {
		const store = sqlStore();
		const legacy = fullOldList(50);
		const prefs = fakePrefs({ 'sql.history': { [OLD]: legacy } });
		const detach = store.attachPrefs(prefs.api);
		try {
			for (let i = 1; i <= 100; i += 1) runOn(store, DEV, `a${i}`, 10_000 + i);
			await settle();
			assert.deepEqual(stored(prefs, OLD), legacy);
			assert.equal(stored(prefs, DEV)?.length, 100);
			assert.equal(ids(store, DEV).length, 100);
			assert.deepEqual(ids(store, DEV_OTHER_TEAM), legacy.map((e) => e.id));
		} finally {
			detach();
		}
	});

	it('de-duplicates by id and bounds the merged view like any list', () => {
		const store = createHistoryStore<'sql'>({ historyKey: 'sql.history', recordingKey: 'sql.historyRecording', textField: 'sql', legacyKeyOf: legacyKeyFromKey, limits: { maxEntries: 3, maxTextChars: 100, maxErrorChars: 10 } });
		const prefs = fakePrefs({ 'sql.history': { [OLD]: [saved('a', 'S a', 10), saved('dup', 'S dup', 9), saved('b', 'S b', 8)], [DEV]: [saved('c', 'S c', 12), saved('dup', 'S dup', 9)] } });
		const detach = store.attachPrefs(prefs.api);
		try {
			assert.deepEqual(ids(store as never, DEV), ['c', 'a', 'dup']);
		} finally {
			detach();
		}
	});

	it('serves a stable snapshot between changes (a useSyncExternalStore requirement)', () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.history': { [OLD]: OLD_LIST, [DEV]: [saved('n0', 'SELECT 0', 5)] } });
		const detach = store.attachPrefs(prefs.api);
		try {
			let first: unknown;
			let second: unknown;
			const A: React.FC = () => { first = store.useHistory(DEV); second = store.useHistory(DEV); return null; };
			renderToStaticMarkup(<A />);
			assert.equal(first, second);
		} finally {
			detach();
		}
	});
});

// =============================================================================
// SWITCHES
// =============================================================================

describe('switches under a legacy key', () => {
	it('inherits a recording switch-OFF chosen under the old key (privacy-preserving), and lets the new key override it', async () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.historyRecording': { [OLD]: false } });
		const detach = store.attachPrefs(prefs.api);
		try {
			assert.equal(recording(store, DEV), false);
			store.runs.emitRun(DEV, { id: 'x', sql: 'SELECT card', at: 1, ms: 1, outcome: 'rows', kind: 'read' } as IHistoryEntry<'sql'>);
			await settle();
			assert.equal(stored(prefs, DEV), undefined);

			store.setRecording(DEV, true);
			assert.equal((prefs.values['sql.historyRecording'] as Record<string, boolean>)[DEV], true);
			assert.equal((prefs.values['sql.historyRecording'] as Record<string, boolean>)[OLD], false);
			assert.equal(recording(store, DEV), true);
		} finally {
			detach();
		}
	});

	it('does not let the old key\'s switch reach the deployment', () => {
		const store = sqlStore();
		const prefs = fakePrefs({ 'sql.historyRecording': { [OLD]: false } });
		const detach = store.attachPrefs(prefs.api);
		try {
			assert.equal(recording(store, DEPLOY), true);
		} finally {
			detach();
		}
	});

	it('connection flags: new key wins, then the old key, then the default; writes touch only the new key', () => {
		const flags = createConnectionFlags({ prefKey: 'sql.patternChecks', defaultValue: true, legacyKeyOf: legacyKeyFromKey });
		const prefs = fakePrefs({ 'sql.patternChecks': { [OLD]: false } });
		assert.equal(flags.read(prefs.api, DEV), false);
		assert.equal(flags.read(prefs.api, DEPLOY), true);
		flags.write(prefs.api, DEV, true);
		assert.deepEqual(prefs.values['sql.patternChecks'], { [OLD]: false, [DEV]: true });
		assert.equal(flags.read(prefs.api, DEV), true);
		flags.write(prefs.api, DEV, false);
		assert.deepEqual(prefs.values['sql.patternChecks'], { [OLD]: false, [DEV]: false });
	});

	it('connection flags read exactly like the pre-extraction rule (`stored !== false`) when there is no legacy key', () => {
		const flags = createConnectionFlags({ prefKey: 'sql.patternChecks', defaultValue: true });
		for (const [stored, expected] of [[undefined, true], [true, true], [false, false], ['no', true], [0, true], [null, true]] as const) {
			const prefs = fakePrefs({ 'sql.patternChecks': { k: stored } });
			// JSON round-trip turns undefined into a missing key, which is the same case.
			assert.equal(flags.read(prefs.api, 'k'), expected, String(stored));
		}
		assert.equal(flags.read(fakePrefs({ 'sql.patternChecks': 'garbage' }).api, 'k'), true);
		assert.equal(flags.read(fakePrefs().api, 'k'), true);
	});
});
