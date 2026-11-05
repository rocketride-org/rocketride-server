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
// LEGACY HISTORY — saved SQL history stays the history of its connection
// =============================================================================
//
// SQL Explorer has always kept history per connection under the key
// `projectId:source:nodeId` (sql.history, sql.historyRecording). The shared
// endpoint store now keys endpoints by owner, run kind and team, but this app
// names a saved connection's endpoint by `endpointKeyForConnection(record)`,
// which IS that old key (the store's `legacyKey` of the caller's own
// development run). So what users saved stays theirs, read and written under
// the same key, with no copy and no migration: a run, a pin, a note, a delete,
// a clear and the recording switch all land on the list that was saved.
//
// Port of f63da6e22 (tests/legacyHistory.test.ts), adapted: sql-explorer
// moved history to the owner-aware key and read the old list beside it; this
// branch keeps the old key, so the same user-visible rules hold directly.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IPrefsApi } from 'shell';
import { endpointKeyForConnection } from '../src/connect';
import type { SavedSqlConnection } from '../src/connect';
import { attachPrefs, clearForKey, removeEntry, setRecording, togglePin } from '../src/history/historyStore';
import { emitRun } from '../src/history/runEvents';
import type { HistoryEntry } from '../src/history/types';

/** Past the store's 300 ms write batch. */
const PAST_THE_BATCH_MS = 500;

/**
 * A fake workspace preferences file; writes round-trip through JSON.
 *
 * @param initial - What it holds.
 * @returns The file and its accessor.
 */
function fakePrefs(initial: Record<string, unknown>): { values: Record<string, unknown>; api: IPrefsApi } {
	const values: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
	return {
		values,
		api: {
			getPref: (key: string) => values[key],
			setPref: (key: string, value: unknown) => { values[key] = JSON.parse(JSON.stringify(value)); },
		} as IPrefsApi,
	};
}

/**
 * Wait for the store's batched write.
 *
 * @returns A promise.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, PAST_THE_BATCH_MS); });
}

/**
 * A saved pipeline connection and the key its history lives under.
 *
 * @param name - The project id (distinct per test, because the store is module-level).
 * @returns The record and its key.
 */
function savedPipeline(name: string): { record: SavedSqlConnection; key: string } {
	const record: SavedSqlConnection = { id: `c-${name}`, mode: 'pipeline', name: 'Orders', projectId: name, pipelineName: 'Pipeline A', source: 'tools_1', nodeId: 'db_1', provider: 'db_postgres' };
	return { record, key: endpointKeyForConnection(record) };
}

const saved = (id: string, sql: string, at: number): Record<string, unknown> => ({ id, sql, at, ms: 4, outcome: 'rows', kind: 'read', rows: 1 });
const entry = (id: string, sql: string, at: number): HistoryEntry => ({ id, sql, at, ms: 1, outcome: 'rows', rows: 1, kind: 'read' });

describe('SQL history under the key it was saved with', () => {
	it('names a saved pipeline connection by the pre-owner-aware key `projectId:source:nodeId`', () => {
		assert.equal(savedPipeline('legacy-key').key, 'legacy-key:tools_1:db_1');
	});

	it('records a run onto the list saved under that key, keeping what was there', async () => {
		const { key } = savedPipeline('legacy-a');
		const oldList = [saved('o1', 'SELECT 1', 10)];
		const prefs = fakePrefs({ 'sql.history': { [key]: oldList } });
		const detach = attachPrefs(prefs.api);
		try {
			emitRun(key, entry('n1', 'SELECT 2', 20));
			await settle();
			const bag = prefs.values['sql.history'] as Record<string, Array<{ id: string }>>;
			assert.deepEqual(bag[key]?.map((e) => e.id), ['n1', 'o1']);
			assert.deepEqual(Object.keys(bag), [key], 'no second copy under another key');
		} finally {
			detach();
		}
	});

	it('pins a saved entry in place', async () => {
		const { key } = savedPipeline('legacy-b');
		const prefs = fakePrefs({ 'sql.history': { [key]: [saved('o1', 'SELECT 1', 10)] } });
		const detach = attachPrefs(prefs.api);
		try {
			togglePin(key, 'o1');
			await settle();
			const bag = prefs.values['sql.history'] as Record<string, Array<{ id: string; pinned?: boolean }>>;
			assert.deepEqual(bag[key]?.map((e) => [e.id, e.pinned]), [['o1', true]]);
		} finally {
			detach();
		}
	});

	it('deletes a saved entry, and Clear empties the list, with no other preference key written', async () => {
		const { key } = savedPipeline('legacy-e');
		const oldList = [saved('o2', 'SELECT 2', 20), saved('o1', 'SELECT 1', 10)];
		const prefs = fakePrefs({ 'sql.history': { [key]: oldList } });
		const detach = attachPrefs(prefs.api);
		try {
			removeEntry(key, 'o2');
			await settle();
			let bag = prefs.values['sql.history'] as Record<string, unknown[]>;
			assert.deepEqual(bag[key], [oldList[1]]);
			assert.deepEqual(Object.keys(prefs.values).sort(), ['sql.history', 'sql.historyRecording']);
			clearForKey(key);
			await settle();
			bag = prefs.values['sql.history'] as Record<string, unknown[]>;
			assert.equal(bag[key], undefined);
			assert.deepEqual(Object.keys(prefs.values).sort(), ['sql.history', 'sql.historyRecording']);
		} finally {
			detach();
		}
	});

	it('honours a recording switch-OFF saved under that key, for that connection only', async () => {
		const { key } = savedPipeline('legacy-c');
		const other = savedPipeline('legacy-c-other').key;
		const prefs = fakePrefs({ 'sql.historyRecording': { [key]: false } });
		const detach = attachPrefs(prefs.api);
		try {
			emitRun(key, entry('d1', 'SELECT card_number FROM payments', 1));
			emitRun(other, entry('p1', 'SELECT 1', 2));
			await settle();
			const bag = prefs.values['sql.history'] as Record<string, Array<{ id: string }>> | undefined;
			// The saved choice not to be recorded still holds…
			assert.equal(bag?.[key], undefined);
			// …and never reaches another connection, which has its own key.
			assert.deepEqual(bag?.[other]?.map((e) => e.id), ['p1']);
		} finally {
			detach();
		}
	});

	it('lets the user turn recording back on, under the same key', () => {
		const { key } = savedPipeline('legacy-d');
		const prefs = fakePrefs({ 'sql.historyRecording': { [key]: false } });
		const detach = attachPrefs(prefs.api);
		try {
			setRecording(key, true);
			const flags = prefs.values['sql.historyRecording'] as Record<string, boolean>;
			assert.equal(flags[key], true);
		} finally {
			detach();
		}
	});
});
