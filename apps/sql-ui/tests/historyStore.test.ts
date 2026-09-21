// MIT License
//
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
// HISTORY STORE — persistence rules that decide whether SQL is written down
// =============================================================================
//
// The store is a module-level singleton with a real timer in it, so these
// suites drive it the way the app does — attach a preferences accessor, act,
// detach — rather than reaching into its state. Two consequences shape every
// test here:
//
//  * every test binds its OWN connection key, because the bag and the
//    recording flags outlive a single test, exactly as they outlive a single
//    component in the app;
//  * every attach is paired with a detach in a `finally`, because the detach
//    is what resets `hydrated` and releases the accessor. A test that skipped
//    it would leak a mounted bridge into the next one.
//
// What is asserted is what reached the fake workspace file, because that file
// IS the privacy boundary: an entry that never lands there was never recorded
// on the user's behalf.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IPrefsApi } from 'shell';
import type { IHistoryEntry } from '../src/history/types';
import { DEFAULT_HISTORY_LIMITS } from '../src/history/trim';
import { attachPrefs, setRecording } from '../src/history/historyStore';
import { emitRun } from '../src/history/runEvents';

// =============================================================================
// FIXTURES
// =============================================================================

/** The preference keys the store writes, repeated here on purpose. */
const PREF_HISTORY = 'sql.history';
const PREF_RECORDING = 'sql.historyRecording';

/**
 * The store batches writes behind a 300 ms timer. Tests that expect a
 * BATCHED write wait past it; tests that expect a write-through do not wait
 * at all, which is the whole point of those assertions.
 */
const PAST_THE_BATCH_MS = 500;

/** A fake workspace preferences file, plus the accessor over it. */
interface IFakePrefs {
	/** What the file holds right now. */
	values: Record<string, unknown>;
	/** The accessor handed to the store. */
	api: IPrefsApi;
}

/**
 * Build a fake preferences file.
 *
 * Writes are round-tripped through JSON, like the real workspace file: the
 * store must not be able to keep a live reference into what it "persisted",
 * and hydration must survive plain data rather than its own objects.
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
			setPref: (key: string, value: unknown) => {
				values[key] = JSON.parse(JSON.stringify(value));
			},
		} as IPrefsApi,
	};
}

/**
 * The entries written for one connection.
 *
 * @param prefs - The fake file.
 * @param key - The connection's endpoint key.
 * @returns The entries, or undefined when the connection was never written.
 */
function storedEntries(prefs: IFakePrefs, key: string): IHistoryEntry[] | undefined {
	const bag = prefs.values[PREF_HISTORY] as Record<string, IHistoryEntry[]> | undefined;
	return bag?.[key];
}

/**
 * The recording switch written for one connection.
 *
 * @param prefs - The fake file.
 * @param key - The connection's endpoint key.
 * @returns The stored flag, or undefined when none was written.
 */
function storedRecording(prefs: IFakePrefs, key: string): boolean | undefined {
	const flags = prefs.values[PREF_RECORDING] as Record<string, boolean> | undefined;
	return flags?.[key];
}

/**
 * Build one finished statement.
 *
 * @param id - The entry id.
 * @param sql - The statement text.
 * @param at - The run time, which also orders the list.
 * @returns The entry.
 */
function run(id: string, sql: string, at = 1): IHistoryEntry {
	return { id, sql, at, ms: 3, outcome: 'rows', rows: 1, kind: 'read' };
}

/**
 * Wait for the store's batched write to land.
 *
 * @returns A promise resolving after the batch window.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, PAST_THE_BATCH_MS); });
}

// =============================================================================
// THE RECORDING SWITCH
// =============================================================================

describe('history store — the recording switch', () => {
	it('writes a switch-off through immediately, not on the batch', () => {
		const key = 'conn-write-through';
		const prefs = fakePrefs();
		const detach = attachPrefs(prefs.api);
		try {
			setRecording(key, false);
			// Deliberately no await. The last detach CANCELS a pending batch,
			// so a switch-off that were merely queued could be dropped by an
			// app switch in the next tick and the user would never be told.
			assert.equal(storedRecording(prefs, key), false);
		} finally {
			detach();
		}
	});

	it('keeps recording off across the detach that cancels pending writes', async () => {
		const off = 'conn-kept-off';
		const on = 'conn-kept-on';
		const prefs = fakePrefs();

		const first = attachPrefs(prefs.api);
		try {
			setRecording(off, false);
		} finally {
			// Switching apps immediately after the click: the pending batch is
			// dropped here, so only a write-through survives.
			first();
		}

		// What a RELOAD would read, since module memory is gone by then and
		// only the file speaks. A batched switch-off never gets this far: the
		// detach above cancels it, the file keeps saying nothing, and the next
		// load resumes recording on a connection the user switched off.
		assert.equal(storedRecording(prefs, off), false);

		const second = attachPrefs(prefs.api);
		try {
			emitRun(off, run('kept-off-1', 'SELECT card_number FROM payments'));
			emitRun(on, run('kept-on-1', 'SELECT 1'));
			await settle();
			assert.equal(storedEntries(prefs, off), undefined);
			// The control: the same pipeline DID record the other connection,
			// so the silence above is the switch and not a broken fixture.
			assert.equal(storedEntries(prefs, on)?.length, 1);
		} finally {
			second();
		}
	});

	it('does not let an in-memory switch outlive the file it came from', async () => {
		const key = 'conn-stale-override';
		const prefs = fakePrefs({ [PREF_RECORDING]: { [key]: true } });

		// One attach is enough to put `true` into the store's memory.
		attachPrefs(prefs.api)();

		// The workspace file is the source of truth and the shell re-reads it
		// on every app switch — another window turned recording off.
		prefs.values[PREF_RECORDING] = { [key]: false };

		const detach = attachPrefs(prefs.api);
		try {
			emitRun(key, run('stale-1', 'SELECT 1'));
			await settle();
			assert.equal(storedEntries(prefs, key), undefined);
		} finally {
			detach();
		}
	});

	it('lands a switch flipped while no bridge was mounted', async () => {
		const key = 'conn-detached-flip';
		// Nothing is mounted, so there is nowhere to write; the intent must
		// still survive to the next hydrate rather than being forgotten.
		setRecording(key, false);

		const prefs = fakePrefs();
		const detach = attachPrefs(prefs.api);
		try {
			await settle();
			assert.equal(storedRecording(prefs, key), false);
		} finally {
			detach();
		}
	});
});

// =============================================================================
// RUNS THAT FINISH BEFORE THE SWITCH IS READABLE
// =============================================================================

describe('history store — runs that beat hydration', () => {
	it('drops a queued run when the stored switch turns out to be off', async () => {
		const key = 'conn-early-off';
		// Before hydration a stored `false` is indistinguishable from "never
		// set", and the default is on — so the run has to wait, not record.
		emitRun(key, run('early-off-1', 'SELECT card_number FROM payments'));

		const prefs = fakePrefs({ [PREF_RECORDING]: { [key]: false } });
		const detach = attachPrefs(prefs.api);
		try {
			await settle();
			assert.equal(storedEntries(prefs, key), undefined);
		} finally {
			detach();
		}
	});

	it('records a queued run once the switch is known to be on', async () => {
		const key = 'conn-early-on';
		emitRun(key, run('early-on-1', 'SELECT 1'));

		const prefs = fakePrefs();
		const detach = attachPrefs(prefs.api);
		try {
			await settle();
			assert.deepEqual(storedEntries(prefs, key)?.map((entry) => entry.id), ['early-on-1']);
		} finally {
			detach();
		}
	});
});

// =============================================================================
// THE RELOAD PATH
// =============================================================================

describe('history store — reloading bounded entries', () => {
	it('keeps two statements that share a stored prefix', async () => {
		const key = 'conn-shared-prefix';
		const prefix = 'SELECT '.padEnd(DEFAULT_HISTORY_LIMITS.maxSqlChars, 'a');
		const prefs = fakePrefs();

		const first = attachPrefs(prefs.api);
		try {
			emitRun(key, run('prefix-orders', `${prefix} FROM orders`, 10));
			emitRun(key, run('prefix-invoices', `${prefix} FROM invoices`, 20));
			await settle();
			const written = storedEntries(prefs, key) as IHistoryEntry[];
			assert.equal(written.length, 2);
			// The trap, stated as an assertion: on disk the two statements are
			// character-for-character identical.
			assert.equal(written[0]?.sql, written[1]?.sql);
			assert.deepEqual(written.map((entry) => entry.truncated), [true, true]);
		} finally {
			first();
		}

		// Reopening the app re-reads the file and passes the BOUNDED entries
		// back through the same trim, where comparing text compares prefixes.
		const second = attachPrefs(prefs.api);
		try {
			await settle();
			assert.deepEqual(
				storedEntries(prefs, key)?.map((entry) => entry.id),
				['prefix-invoices', 'prefix-orders'],
			);
		} finally {
			second();
		}
	});
});
