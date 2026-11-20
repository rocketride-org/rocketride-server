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
// HISTORY STORE — per-connection statement history (App + Sidebar shared state)
// =============================================================================
//
// SQL Explorer's instance of the shared history store
// (shared/explorer/history/store — read that file for WHERE A WRITE LANDS and
// why the recording switch writes through). This module fixes the three
// things that are SQL Explorer's alone and must never change, because renaming
// any of them silently orphans users' saved history:
//
//   - the preference keys `sql.history` and `sql.historyRecording`
//   - the `sql` field of a persisted entry
//   - the bounds (100 entries, 8 KiB of statement, 1 KiB of error)
//
// The module instance below is the FULL APP's (it persists through the
// shell's workspace preferences, HistoryPrefsBridge). A dev-tool controller
// makes its own with createSqlHistoryStore() and attaches it to a file in the
// user's store instead (sqlController.ts); dev-tool frames import neither and
// reach history through ops.
//
// The full app's store is attached through the page's workspace pin
// (workspacePin.ts): the shell's preferences still hold the first account's
// bag after another account signs in without a reload, so for that account
// the store is attached to a throwaway accessor instead. It then forgets the
// first account's entries (another owner) and reads and writes nothing of
// the shell's.
// =============================================================================

import { useSyncExternalStore } from 'react';
import { createHistoryStore } from 'shared/explorer/history/store';
import type { IHistoryStore } from 'shared/explorer/history/store';
import { createRunEvents } from 'shared/explorer/history/runEvents';
import { createHistoryPrefsBridge } from 'shared/explorer/react';
import type { IPrefsAttachable } from 'shared/explorer/react';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import type { HistoryEntry } from './types';
import { DEFAULT_HISTORY_LIMITS } from './trim';
import { sqlRunEvents } from './runEvents';
import { APP_WORKSPACE_PIN } from './workspacePin';
import type { WorkspaceAccess, WorkspacePin } from './workspacePin';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Preference key holding every connection's entries. */
const PREF_HISTORY = 'sql.history';

/** Preference key holding the per-connection recording switch. */
const PREF_RECORDING = 'sql.historyRecording';

// =============================================================================
// THE STORE
// =============================================================================

/** A SQL Explorer history store (same keys, field and bounds as the module one). */
export type SqlHistoryStore = IHistoryStore<'sql'>;

/**
 * Create a SQL Explorer history store with its own run bus: the same
 * preference keys, `sql` field and bounds, so a file written by one is read
 * by another.
 *
 * @param runs - The run bus to listen on (default: a fresh one).
 * @returns The store.
 */
export function createSqlHistoryStore(runs = createRunEvents<'sql'>()): SqlHistoryStore {
	return createHistoryStore<'sql'>({
		historyKey: PREF_HISTORY,
		recordingKey: PREF_RECORDING,
		textField: 'sql',
		limits: {
			maxEntries: DEFAULT_HISTORY_LIMITS.maxEntries,
			maxTextChars: DEFAULT_HISTORY_LIMITS.maxSqlChars,
			maxErrorChars: DEFAULT_HISTORY_LIMITS.maxErrorChars,
		},
		runs,
	});
}

/**
 * A throwaway accessor kept in memory: nothing is read from or written to
 * anywhere else. Attaching a store to one under a new owner (and detaching it
 * at once) makes the store forget the previous owner's entries straight away.
 *
 * @returns The accessor.
 */
export function memoryPrefs(): IPrefsAccessor {
	const values = new Map<string, unknown>();
	return {
		getPref: (key) => values.get(key),
		setPref: (key, value) => { values.set(key, value); },
	};
}

/** A history store's attach, through a workspace pin. */
export interface PinnedHistory extends IPrefsAttachable {
	/** Where the account the store was last attached for stands (outside React). */
	access(): WorkspaceAccess;
	/** The same, as a hook. */
	useAccess(): WorkspaceAccess;
}

/**
 * Attach a store to the shell's preferences only for the pinned account: any
 * other account (or nobody) gets a throwaway accessor, under its own owner,
 * so the store forgets what it held and reads and writes nothing of the
 * shell's. An attach without an owner is not checked.
 *
 * @param store - The history store.
 * @param pin - Whose preferences these are.
 * @returns The attach, and where the last attached account stands.
 */
export function pinHistory(store: SqlHistoryStore, pin: WorkspacePin): PinnedHistory {
	let access: WorkspaceAccess = 'nobody';
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	};
	const snapshot = (): WorkspaceAccess => access;
	return {
		attachPrefs(api, owner) {
			if (owner === undefined) return store.attachPrefs(api);
			const next = pin.access(owner);
			if (next !== access) {
				access = next;
				listeners.forEach((listener) => listener());
			}
			return store.attachPrefs(next === 'owner' ? api : memoryPrefs(), owner);
		},
		access: snapshot,
		useAccess: () => useSyncExternalStore(subscribe, snapshot, snapshot),
	};
}

/** The full app's store (module-level), on the app's run bus. */
const store = createSqlHistoryStore(sqlRunEvents);

/** The full app's store, attached through the page's workspace pin. */
const pinned = pinHistory(store, APP_WORKSPACE_PIN);

/**
 * Attach the shell's preference accessor and hydrate from it (through the
 * page's workspace pin, when an owner is given).
 *
 * Exported because it is the store's real seam onto the shell:
 * {@link HistoryPrefsBridge} is a null-rendering wrapper around this call, and
 * the persistence rules worth testing (what a hydrate trusts, what a detach
 * drops) live in the store rather than in React.
 */
export const attachPrefs = pinned.attachPrefs;

/** Where the account the full app's history was last attached for stands (outside React). */
export const historyAccess = pinned.access;

/** Where the account the full app's history was last attached for stands (a hook). */
export const useHistoryAccess = pinned.useAccess;

/** Forget one entry. */
export const removeEntry = store.removeEntry;

/** Flip one entry's pinned state. */
export const togglePin = store.togglePin;

/** Set (or clear, with '') one entry's note. */
export const setNote = store.setNote;

/** Forget every entry for one connection, pinned entries included. */
export const clearForKey = store.clearForKey;

/**
 * Turn recording on or off for one connection. Existing entries are kept
 * either way — switching off stops new records, it does not erase old ones.
 */
export const setRecording = store.setRecording;

/**
 * Subscribe to one connection's history.
 *
 * @param key - The connection's endpoint key.
 * @returns The entries, newest first (empty for an unknown connection).
 */
export function useHistory(key: string): HistoryEntry[] {
	return store.useHistory(key) as HistoryEntry[];
}

/**
 * Subscribe to one connection's recording switch (default on).
 *
 * @param key - The connection's endpoint key.
 * @returns Whether runs on that connection are being recorded.
 */
export const useRecording = store.useRecording;

/**
 * Mounts the store's access to workspace preferences.
 *
 * Renders nothing. Mount it wherever SQL Explorer is on screen and history
 * should be kept — the connection workbench does, and the History drawer
 * mounts its own so the drawer works even from a query document whose
 * workbench tab was closed. Multiple mounts are safe. It attaches through
 * the page's workspace pin.
 */
export const HistoryPrefsBridge = createHistoryPrefsBridge(pinned);
