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
// EXPLORER HISTORY — WHOSE HISTORY IS IN MEMORY (a change of identity)
// =============================================================================
//
// The store is a module singleton and keeps what it hydrated after the last
// bridge detaches. The shell can sign one account out and another in without
// reloading the page, so the next account's first attach must find none of
// the previous account's entries, switches or queued runs: not on screen, not
// merged into its own list, and not written into its own workspace file.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHistoryStore } from './store';
import type { IHistoryEntry, IPrefsAccessor } from './types';

// =============================================================================
// FIXTURES
// =============================================================================

const BATCH_MS = 10;

/** A connection key both accounts can reach (a team deployment carries no user id). */
const SHARED = 'k1|deploy|team|team-1|team-1|proj-1|tools=tools_1|db_1';

/** A's own dev run. */
const A_DEV = 'k1|dev|user|u-a|team-1|proj-1|tools=tools_1|db_1';

/** The identity fingerprints (user|org|devTeam). */
const ALICE = 'u-a|org-1|team-1';
const BOB = 'u-b|org-1|team-1';

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
 * One finished SQL statement.
 *
 * @param id - Id.
 * @param sql - Text.
 * @param at - Time.
 * @returns The entry.
 */
function entry(id: string, sql: string, at: number): IHistoryEntry<'sql'> {
	return { id, sql, at, ms: 2, outcome: 'rows', kind: 'read', rows: 1 } as IHistoryEntry<'sql'>;
}

/**
 * Build a SQL history store.
 *
 * @returns The store.
 */
function sqlStore() {
	return createHistoryStore<'sql'>({ historyKey: 'sql.history', recordingKey: 'sql.historyRecording', textField: 'sql', persistDelayMs: BATCH_MS });
}

/**
 * Read a connection's history through the hook, as a component would.
 *
 * @param store - The store.
 * @param key - The connection.
 * @returns The entry ids, newest first.
 */
function ids(store: ReturnType<typeof sqlStore>, key: string): string[] {
	let seen: IHistoryEntry<'sql'>[] = [];
	const Probe: React.FC = () => { seen = store.useHistory(key); return null; };
	renderToStaticMarkup(<Probe />);
	return seen.map((item) => item.id);
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
 * The ids stored under one connection in a preferences file.
 *
 * @param prefs - The file.
 * @param key - The connection.
 * @returns The ids.
 */
function storedIds(prefs: IFakePrefs, key: string): string[] {
	return ((prefs.values['sql.history'] as Record<string, { id: string }[]> | undefined)?.[key] ?? []).map((item) => item.id);
}

/**
 * Wait past the batch window.
 *
 * @returns A promise.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, BATCH_MS * 4); });
}

// =============================================================================
// SUITE
// =============================================================================

describe('history store — a change of identity forgets what is in memory', () => {
	it('shows, merges and writes none of the previous account\'s history for the next one', async () => {
		const store = sqlStore();
		const alice = fakePrefs({ 'sql.history': { [SHARED]: [entry('a-old', 'SELECT secret_a', 1)], [A_DEV]: [entry('a-dev', 'SELECT 1', 2)] } });
		const detachA = store.attachPrefs(alice.api, ALICE);
		store.runs.emitRun(SHARED, entry('a-new', "SELECT * FROM payroll WHERE name = 'alice'", 3));
		await settle();
		// A run whose debounced write the detach drops: in memory only.
		store.runs.emitRun(SHARED, entry('a-late', 'SELECT late_a', 4));
		detachA();

		const bob = fakePrefs({ 'sql.history': { [SHARED]: [entry('b-own', 'SELECT 2', 5)] } });
		const detachB = store.attachPrefs(bob.api, BOB);
		try {
			assert.deepEqual(ids(store, SHARED), ['b-own']);
			assert.deepEqual(ids(store, A_DEV), []);
			store.runs.emitRun(SHARED, entry('b-new', 'SELECT 3', 6));
			await settle();
			assert.deepEqual(storedIds(bob, SHARED), ['b-new', 'b-own']);
			assert.deepEqual(Object.keys(bob.values['sql.history'] as object), [SHARED]);
			assert.equal(JSON.stringify(bob.values).includes('_a'), false, 'nothing of A reached B\'s file');
		} finally {
			detachB();
		}
		// A's own file still holds what was written while A was attached.
		assert.deepEqual(storedIds(alice, SHARED), ['a-new', 'a-old']);
	});

	it('does not carry the previous account\'s recording switch, or runs queued before hydration, to the next', async () => {
		const store = sqlStore();
		const alice = fakePrefs({ 'sql.historyRecording': { [SHARED]: false } });
		const detachA = store.attachPrefs(alice.api, ALICE);
		assert.equal(recording(store, SHARED), false);
		detachA();
		// A run that finished while no bridge was attached: whose it is cannot be told.
		store.runs.emitRun(SHARED, entry('queued', 'SELECT queued', 7));

		const bob = fakePrefs();
		const detachB = store.attachPrefs(bob.api, BOB);
		try {
			assert.equal(recording(store, SHARED), true, 'B never turned recording off');
			assert.deepEqual(ids(store, SHARED), []);
			await settle();
			assert.deepEqual(storedIds(bob, SHARED), []);
		} finally {
			detachB();
		}
	});

	it('forgets on sign-out (null) too, and keeps everything when the same account attaches again', async () => {
		const store = sqlStore();
		const alice = fakePrefs({ 'sql.history': { [SHARED]: [entry('a-old', 'SELECT 1', 1)] } });
		let detach = store.attachPrefs(alice.api, ALICE);
		store.runs.emitRun(SHARED, entry('a-late', 'SELECT 2', 2));
		detach();
		// Same account again: the run the detach did not write is merged and saved.
		detach = store.attachPrefs(alice.api, ALICE);
		await settle();
		assert.deepEqual(storedIds(alice, SHARED), ['a-late', 'a-old']);
		detach();

		const signedOut = fakePrefs();
		detach = store.attachPrefs(signedOut.api, null);
		try {
			assert.deepEqual(ids(store, SHARED), []);
			await settle();
			assert.deepEqual(signedOut.values, {});
		} finally {
			detach();
		}
	});

	it('drops a pending write when the account changes while a bridge is still attached', async () => {
		const store = sqlStore();
		const alice = fakePrefs();
		const detachA = store.attachPrefs(alice.api, ALICE);
		store.runs.emitRun(SHARED, entry('a-run', 'SELECT secret_a', 1));
		// B's bridge attaches before A's detaches (no pending write may land in B's file).
		const bob = fakePrefs();
		const detachB = store.attachPrefs(bob.api, BOB);
		detachA();
		try {
			await settle();
			assert.deepEqual(storedIds(bob, SHARED), []);
			assert.deepEqual(ids(store, SHARED), []);
		} finally {
			detachB();
		}
	});
});
