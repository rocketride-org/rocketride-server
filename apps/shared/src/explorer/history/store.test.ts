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
// EXPLORER HISTORY STORE — parameterisation and isolation of the factory
// =============================================================================
//
// SQL Explorer's own suites (apps/sql-ui/tests/historyStore.test.ts and
// trim.test.ts) exercise the persistence rules THROUGH its binding of this
// factory and stay unchanged. What they cannot show is what only a second
// instance can: that the persisted text field and preference keys are
// parameters, and that two stores in one process never see each other.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStore } from './store';
import { createRunEvents } from './runEvents';
import { trimBag, trimHistory } from './trim';
import { DEFAULT_HISTORY_LIMITS } from './types';
import type { IHistoryEntry, IPrefsAccessor } from './types';

// =============================================================================
// FIXTURES
// =============================================================================

/** A fake workspace preferences file; writes round-trip through JSON like the real one. */
interface IFakePrefs {
	/** What the file holds right now. */
	values: Record<string, unknown>;
	/** The accessor handed to a store. */
	api: IPrefsAccessor;
}

/**
 * Build a fake preferences file.
 *
 * @param initial - What the file already holds.
 * @returns The file and its accessor.
 */
function fakePrefs(initial: Record<string, unknown> = {}): IFakePrefs {
	const values: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
	return {
		values,
		api: {
			getPref: (key: string) => values[key],
			setPref: (key: string, value: unknown) => { values[key] = JSON.parse(JSON.stringify(value)); },
		},
	};
}

/** The batch window the stores in these tests use; short so the suite stays fast. */
const BATCH_MS = 10;

/**
 * Wait past the store's batch window.
 *
 * @returns A promise resolving after it.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, BATCH_MS * 4); });
}

/**
 * Build one finished statement under a text field.
 *
 * @param field - The text field name.
 * @param id - The entry id.
 * @param text - The statement text.
 * @param at - Run time.
 * @returns The entry.
 */
function run<F extends string>(field: F, id: string, text: string, at = 1): IHistoryEntry<F> {
	return { id, [field]: text, at, ms: 3, outcome: 'rows', rows: 1, kind: 'read' } as IHistoryEntry<F>;
}

// =============================================================================
// PARAMETERS
// =============================================================================

describe('createHistoryStore — what the app chooses', () => {
	it('persists the statement under the configured field and the configured preference keys, and nothing else', async () => {
		const store = createHistoryStore<'cypher'>({ historyKey: 'graph.history', recordingKey: 'graph.historyRecording', textField: 'cypher', persistDelayMs: BATCH_MS });
		const prefs = fakePrefs();
		const detach = store.attachPrefs(prefs.api);
		try {
			store.runs.emitRun('conn', run('cypher', 'g1', 'MATCH (n) RETURN n LIMIT 25'));
			await settle();
			assert.deepEqual(Object.keys(prefs.values).sort(), ['graph.history', 'graph.historyRecording']);
			const written = (prefs.values['graph.history'] as Record<string, Record<string, unknown>[]>).conn;
			assert.deepEqual(written, [{ id: 'g1', cypher: 'MATCH (n) RETURN n LIMIT 25', at: 1, ms: 3, outcome: 'rows', kind: 'read', rows: 1 }]);
			assert.equal('sql' in (written?.[0] as object), false);
		} finally {
			detach();
		}
	});

	it('writes entries with the persisted key order id, text, at, ms, outcome, kind, then optional fields', async () => {
		const store = createHistoryStore<'sql'>({ historyKey: 'sql.history', recordingKey: 'sql.historyRecording', textField: 'sql', persistDelayMs: BATCH_MS });
		// A reload re-reads the file and rewrites it: a different key order would churn the workspace file on every open.
		const original = { id: 'a', sql: 'SELECT 1', at: 5, ms: 2, outcome: 'error', kind: 'write', error: 'boom', limit: 10, pinned: true, note: 'n', truncated: true };
		const prefs = fakePrefs({ 'sql.history': { conn: [original] } });
		const detach = store.attachPrefs(prefs.api);
		try {
			store.togglePin('conn', 'a');
			store.togglePin('conn', 'a');
			await settle();
			const written = (prefs.values['sql.history'] as Record<string, unknown[]>).conn?.[0];
			assert.equal(JSON.stringify(written), JSON.stringify({ id: 'a', sql: 'SELECT 1', at: 5, ms: 2, outcome: 'error', kind: 'write', limit: 10, error: 'boom', pinned: true, note: 'n', truncated: true }));
		} finally {
			detach();
		}
	});

	it('drops stored entries that lack its text field, so another app\'s history in the same file is not read as its own', async () => {
		const store = createHistoryStore<'cypher'>({ historyKey: 'graph.history', recordingKey: 'graph.historyRecording', textField: 'cypher', persistDelayMs: BATCH_MS });
		const prefs = fakePrefs({ 'graph.history': { conn: [{ id: 's1', sql: 'SELECT 1', at: 1, ms: 1, outcome: 'rows', kind: 'read' }, 7, null, { id: 'c1', cypher: 'RETURN 1', at: 2 }], onlySql: [{ id: 's2', sql: 'SELECT 2' }] } });
		const detach = store.attachPrefs(prefs.api);
		try {
			// A mutation makes the store write back what it hydrated.
			store.togglePin('conn', 'c1');
			await settle();
			const written = prefs.values['graph.history'] as Record<string, { id: string; pinned?: boolean }[]>;
			assert.deepEqual(written.conn?.map((e) => e.id), ['c1']);
			assert.equal(written.conn?.[0]?.pinned, true);
			assert.equal('onlySql' in written, false);
		} finally {
			detach();
		}
	});

	it('honours custom bounds', async () => {
		const store = createHistoryStore<'cypher'>({
			historyKey: 'graph.history',
			recordingKey: 'graph.historyRecording',
			textField: 'cypher',
			limits: { maxEntries: 2, maxTextChars: 5, maxErrorChars: 3 },
			persistDelayMs: BATCH_MS,
		});
		const prefs = fakePrefs();
		const detach = store.attachPrefs(prefs.api);
		try {
			store.runs.emitRun('c', run('cypher', 'a', 'AAAAAAAAAA', 1));
			store.runs.emitRun('c', run('cypher', 'b', 'BBBBBBBBBB', 2));
			store.runs.emitRun('c', run('cypher', 'd', 'DDDDDDDDDD', 3));
			await settle();
			const written = (prefs.values['graph.history'] as Record<string, { id: string; cypher: string; truncated?: boolean }[]>).c;
			assert.deepEqual(written?.map((e) => e.id), ['d', 'b']);
			assert.deepEqual(written?.map((e) => e.cypher), ['DDDDD', 'BBBBB']);
			assert.deepEqual(written?.map((e) => e.truncated), [true, true]);
		} finally {
			detach();
		}
	});

	it('listens on a bus handed to it, and exposes its own bus when none is', async () => {
		const bus = createRunEvents<'cypher'>();
		const shared = createHistoryStore<'cypher'>({ historyKey: 'h', recordingKey: 'r', textField: 'cypher', runs: bus, persistDelayMs: BATCH_MS });
		assert.equal(shared.runs, bus);
		const own = createHistoryStore<'cypher'>({ historyKey: 'h', recordingKey: 'r', textField: 'cypher' });
		assert.notEqual(own.runs, bus);
		const prefs = fakePrefs();
		const detach = shared.attachPrefs(prefs.api);
		try {
			bus.emitRun('k', run('cypher', 'x', 'RETURN 1'));
			await settle();
			assert.equal((prefs.values.h as Record<string, unknown[]>).k?.length, 1);
		} finally {
			detach();
		}
	});
});

// =============================================================================
// ISOLATION
// =============================================================================

describe('createHistoryStore — two stores in one process', () => {
	it('keeps SQL, Graph and a mocked Vector store apart: runs, switches and writes never cross', async () => {
		const sql = createHistoryStore<'sql'>({ historyKey: 'sql.history', recordingKey: 'sql.historyRecording', textField: 'sql', persistDelayMs: BATCH_MS });
		const graph = createHistoryStore<'cypher'>({ historyKey: 'graph.history', recordingKey: 'graph.historyRecording', textField: 'cypher', persistDelayMs: BATCH_MS });
		const vector = createHistoryStore<'query'>({ historyKey: 'vector.history', recordingKey: 'vector.historyRecording', textField: 'query', persistDelayMs: BATCH_MS });
		// One workspace file per app, as the shell gives each app its own prefs bag.
		const sqlPrefs = fakePrefs();
		const graphPrefs = fakePrefs();
		const vectorPrefs = fakePrefs();
		const detaches = [sql.attachPrefs(sqlPrefs.api), graph.attachPrefs(graphPrefs.api), vector.attachPrefs(vectorPrefs.api)];
		try {
			// The SAME connection key in all three: a collision would be visible here.
			const key = 'k1|dev|user|u|t|p|tools=tools_1|n';
			sql.runs.emitRun(key, run('sql', 's', 'SELECT 1'));
			graph.runs.emitRun(key, run('cypher', 'g', 'MATCH (n) RETURN n'));
			// Graph recording off must not switch SQL or Vector off.
			graph.setRecording(key, false);
			vector.runs.emitRun(key, run('query', 'v', 'find similar'));
			graph.runs.emitRun(key, run('cypher', 'g2', 'MATCH (m) RETURN m'));
			await settle();

			const ids = (prefs: IFakePrefs, pref: string): string[] =>
				((prefs.values[pref] as Record<string, { id: string }[]>)?.[key] ?? []).map((e) => e.id);
			assert.deepEqual(ids(sqlPrefs, 'sql.history'), ['s']);
			assert.deepEqual(ids(graphPrefs, 'graph.history'), ['g']);
			assert.deepEqual(ids(vectorPrefs, 'vector.history'), ['v']);
			assert.equal((graphPrefs.values['graph.historyRecording'] as Record<string, boolean>)[key], false);
			assert.equal((sqlPrefs.values['sql.historyRecording'] as Record<string, boolean>)[key], undefined);
			assert.equal((vectorPrefs.values['vector.historyRecording'] as Record<string, boolean>)[key], undefined);
		} finally {
			detaches.forEach((detach) => detach());
		}
	});

	it('does not deliver one store\'s run bus events to another store', async () => {
		const a = createHistoryStore<'cypher'>({ historyKey: 'a.h', recordingKey: 'a.r', textField: 'cypher', persistDelayMs: BATCH_MS });
		const b = createHistoryStore<'cypher'>({ historyKey: 'b.h', recordingKey: 'b.r', textField: 'cypher', persistDelayMs: BATCH_MS });
		const prefsA = fakePrefs();
		const prefsB = fakePrefs();
		const detachA = a.attachPrefs(prefsA.api);
		const detachB = b.attachPrefs(prefsB.api);
		try {
			a.runs.emitRun('k', run('cypher', 'only-a', 'RETURN 1'));
			await settle();
			assert.equal((prefsA.values['a.h'] as Record<string, unknown[]>)?.k?.length, 1);
			assert.equal((prefsB.values['b.h'] as Record<string, unknown[]> | undefined)?.k, undefined);
		} finally {
			detachA();
			detachB();
		}
	});

	it('gives each store its own recording state: a switch-off in one survives only in its own file', () => {
		const a = createHistoryStore<'sql'>({ historyKey: 'a.h', recordingKey: 'a.r', textField: 'sql' });
		const b = createHistoryStore<'sql'>({ historyKey: 'b.h', recordingKey: 'b.r', textField: 'sql' });
		const prefsA = fakePrefs();
		const prefsB = fakePrefs();
		const detachA = a.attachPrefs(prefsA.api);
		const detachB = b.attachPrefs(prefsB.api);
		try {
			a.setRecording('k', false);
			assert.deepEqual(prefsA.values['a.r'], { k: false });
			assert.equal(prefsB.values['b.r'], undefined);
		} finally {
			detachA();
			detachB();
		}
	});
});

// =============================================================================
// OUTSIDE REACT (a dev-tool controller serves history to its frames)
// =============================================================================

describe('createHistoryStore — read from code outside React', () => {
	it('getHistory and getRecording answer what the hooks would, and subscribe fires on every change until unsubscribed', async () => {
		const store = createHistoryStore<'sql'>({ historyKey: 'o.h', recordingKey: 'o.r', textField: 'sql', persistDelayMs: BATCH_MS });
		const prefs = fakePrefs({ 'o.h': { k: [run('sql', 'old', 'SELECT 0', 1)] }, 'o.r': { off: false } });
		let changes = 0;
		const off = store.subscribe(() => { changes += 1; });
		const detach = store.attachPrefs(prefs.api);
		try {
			assert.deepEqual(store.getHistory('k').map((e) => e.id), ['old']);
			assert.deepEqual(store.getHistory('unknown'), []);
			assert.equal(store.getHistory('unknown'), store.getHistory('other'), 'an unknown connection reads one stable empty list');
			assert.equal(store.getRecording('k'), true);
			assert.equal(store.getRecording('off'), false);
			const before = store.getHistory('k');
			const seen = changes;
			store.runs.emitRun('k', run('sql', 'new', 'SELECT 1', 2));
			assert.ok(changes > seen, 'a recorded run notifies');
			assert.deepEqual(store.getHistory('k').map((e) => e.id), ['new', 'old']);
			assert.notEqual(store.getHistory('k'), before, 'a changed list is a new snapshot');
			assert.equal(store.getHistory('k'), store.getHistory('k'), 'an unchanged list is the same snapshot');
			store.setRecording('k', false);
			assert.equal(store.getRecording('k'), false);
			off();
			const after = changes;
			store.togglePin('k', 'new');
			assert.equal(changes, after, 'nothing after unsubscribe');
			await settle();
		} finally {
			detach();
		}
	});
});

describe('createHistoryStore — flush before the last detach', () => {
	it('flush writes a batch still inside its debounce at once; without it the last detach drops that batch', () => {
		const flushed = createHistoryStore<'sql'>({ historyKey: 'f.h', recordingKey: 'f.r', textField: 'sql', persistDelayMs: 60_000 });
		const kept = fakePrefs();
		const detachKept = flushed.attachPrefs(kept.api, 'owner');
		flushed.runs.emitRun('k', run('sql', 'last', 'SELECT 1', 5));
		assert.equal(kept.values['f.h'], undefined, 'the premise: the run waits in the debounce');
		flushed.flush();
		const written = kept.values['f.h'] as unknown as Record<string, Array<{ id: string }>>;
		assert.deepEqual(written.k.map((e) => e.id), ['last'], 'written at once');
		detachKept();

		const dropped = createHistoryStore<'sql'>({ historyKey: 'f.h', recordingKey: 'f.r', textField: 'sql', persistDelayMs: 60_000 });
		const lost = fakePrefs();
		const detachLost = dropped.attachPrefs(lost.api, 'owner');
		dropped.runs.emitRun('k', run('sql', 'last', 'SELECT 1', 5));
		detachLost();
		assert.equal(lost.values['f.h'], undefined, 'the control: the last detach drops the batch');
	});

	it('flush writes nothing when nothing is pending, and is a no-op with no accessor attached', () => {
		const store = createHistoryStore<'sql'>({ historyKey: 'g.h', recordingKey: 'g.r', textField: 'sql', persistDelayMs: 60_000 });
		store.flush();
		let writes = 0;
		const prefs = fakePrefs({ 'g.h': { k: [run('sql', 'old', 'SELECT 0', 1)] } });
		const detach = store.attachPrefs({ getPref: prefs.api.getPref, setPref: (key, value) => { writes += 1; prefs.api.setPref(key, value); } }, 'owner');
		store.flush();
		assert.equal(writes, 0, 'no pending batch: no write');
		store.setRecording('k', false);
		const afterSwitch = writes;
		store.flush();
		assert.equal(writes, afterSwitch, 'the switch was written at once (persistNow), so nothing is left to flush');
		detach();
		store.flush();
		assert.equal(writes, afterSwitch, 'detached: no write');
	});
});

// =============================================================================
// TRIM, PARAMETERISED
// =============================================================================

describe('trimHistory — the text field is a parameter', () => {
	it('bounds and collapses on the configured field only', () => {
		const long = 'x'.repeat(DEFAULT_HISTORY_LIMITS.maxTextChars + 10);
		const [kept] = trimHistory([run('cypher', 'a', long)], 'cypher');
		assert.equal(kept?.cypher.length, DEFAULT_HISTORY_LIMITS.maxTextChars);
		assert.equal(kept?.truncated, true);
		// An entry carrying the OTHER app's field is not bounded by this one.
		const stray = { ...run('cypher', 'b', 'short'), sql: long } as IHistoryEntry<'cypher'>;
		assert.equal(trimHistory([stray], 'cypher')[0]?.truncated, undefined);
	});

	it('collapses consecutive repeats of the same cypher onto the older entry', () => {
		const newer = run('cypher', 'n', 'MATCH (n) RETURN n', 20);
		const older = { ...run('cypher', 'o', 'MATCH (n) RETURN n', 10), pinned: true, note: 'keep' } as IHistoryEntry<'cypher'>;
		const kept = trimHistory([newer, older], 'cypher');
		assert.equal(kept.length, 1);
		assert.equal(kept[0]?.id, 'o');
		assert.equal(kept[0]?.at, 20);
		assert.equal(kept[0]?.pinned, true);
		assert.equal(kept[0]?.note, 'keep');
	});

	it('trimBag works on any entry type and drops the oldest unpinned first', () => {
		const bag = { a: [run('cypher', 'a1', 'x'.repeat(200), 5), { ...run('cypher', 'a2', 'y'.repeat(200), 1), pinned: true } as IHistoryEntry<'cypher'>] };
		const kept = trimBag(bag, 330);
		assert.deepEqual(kept.a?.map((e) => e.id), ['a2']);
		assert.equal(bag.a.length, 2);
	});
});
