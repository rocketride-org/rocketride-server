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
// Module-level store, same pattern as endpointStore/schemaStore, persisted
// through the shell's WORKSPACE preferences (server-side, per user) rather
// than browser storage — history follows the person to another browser.
//
// WHERE A WRITE LANDS — the constraint that shapes this file:
// `usePrefs().setPref` reaches `useWorkspaceState.updatePrefs`, which patches
// `apps[activeAppIdRef.current].prefs` — the app that is active AT WRITE TIME,
// not the app that asked. A write issued while SQL Explorer is in the
// background would be filed under whatever app is in the foreground, and the
// shell reloads each app's prefs from disk on every switch, so it would be
// both misfiled and lost.
//
// So the store writes ONLY while a HistoryPrefsBridge is mounted. The shell
// unmounts the whole app subtree when another app takes over, which makes
// "mounted" equivalent to "SQL Explorer is active". On unmount the pending
// debounced write is DROPPED, not flushed: up to 300 ms of history can be
// lost if the user switches apps immediately after a run, and that is the
// honest trade against writing into another app's preferences.
//
// THE RECORDING SWITCH IS EXEMPT from that trade. Losing a run costs a row;
// losing a switch-OFF costs the user their decision not to have their SQL
// written down, and they would never know. So `setRecording` writes through
// immediately instead of riding the debounce, and any switch that could not
// be written (no bridge mounted) is remembered in `unsavedRecording` until a
// hydrate can land it.
// =============================================================================

import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePrefs } from 'shell';
import type { IPrefsApi } from 'shell';
import type { IHistoryEntry } from './types';
import type { HistoryBag } from './trim';
import { trimBag, trimHistory } from './trim';
import { subscribeRuns } from './runEvents';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Preference key holding every connection's entries. */
const PREF_HISTORY = 'sql.history';

/** Preference key holding the per-connection recording switch. */
const PREF_RECORDING = 'sql.historyRecording';

/** Delay before a batch of mutations is written to the workspace file (ms). */
const PERSIST_DELAY_MS = 300;

/** Shared empty list, so an unknown connection keeps a stable snapshot. */
const NO_ENTRIES: IHistoryEntry[] = [];

/**
 * How many pre-hydration runs are held while the recording switch is unknown.
 * The queue exists to survive a hydrate, not to accumulate a session's work,
 * and it holds the user's SQL — so it is bounded like everything else here.
 */
const MAX_PENDING_RUNS = 100;

// =============================================================================
// STATE
// =============================================================================

let bag: HistoryBag = {};
let recording: Record<string, boolean> = {};
let hydrated = false;

/**
 * Recording switches flipped since the last successful write. These are the
 * ONLY overrides allowed to outrank the stored flags at hydration.
 *
 * Keeping the whole of {@link recording} as an override instead would make
 * every hydrate prefer a value that may be arbitrarily old: a flag that has
 * already reached disk is re-read from disk, so a second copy of it in memory
 * can only ever be stale — and a stale `true` surviving a detach would turn
 * recording back on for a connection the workspace file says is off.
 */
let unsavedRecording: Record<string, boolean> = {};

/**
 * Runs that finished before the recording switch could be read. Holding them
 * here rather than in {@link bag} is what keeps a user who turned recording
 * OFF from having their SQL persisted: until hydrate, a stored `false` is
 * indistinguishable from "never set", and the default is on.
 */
let pendingRuns: { key: string; entry: IHistoryEntry }[] = [];

let prefs: IPrefsApi | null = null;
let bridgeCount = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();

/** Notify every subscribed component that the store changed. */
function notify(): void {
	listeners.forEach((listener) => listener());
}

// =============================================================================
// HYDRATION AND PERSISTENCE
// =============================================================================

/**
 * Narrow one persisted entry, dropping anything the workspace file holds that
 * is not a usable record. The file is long-lived and hand-editable, so its
 * contents are treated as untrusted input rather than as our own types.
 *
 * @param value - A candidate entry from the preferences bag.
 * @returns The entry, or null when it cannot be used.
 */
function readEntry(value: unknown): IHistoryEntry | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Partial<IHistoryEntry>;
	if (typeof raw.id !== 'string' || typeof raw.sql !== 'string') return null;
	return {
		id: raw.id,
		sql: raw.sql,
		at: typeof raw.at === 'number' ? raw.at : 0,
		ms: typeof raw.ms === 'number' ? raw.ms : 0,
		outcome: raw.outcome ?? 'rows',
		kind: raw.kind ?? 'other',
		...(typeof raw.rows === 'number' ? { rows: raw.rows } : {}),
		...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}),
		...(typeof raw.affected === 'number' ? { affected: raw.affected } : {}),
		...(typeof raw.error === 'string' ? { error: raw.error } : {}),
		...(raw.pinned ? { pinned: true } : {}),
		...(typeof raw.note === 'string' ? { note: raw.note } : {}),
		...(raw.truncated ? { truncated: true } : {}),
	};
}

/**
 * Read both preference keys into memory, MERGING anything already recorded.
 *
 * Entries recorded during an earlier attach are in memory only once the last
 * bridge detaches. Replacing the bag wholesale would throw them away at the
 * moment persistence became possible, which is the one moment they could have
 * been saved — so the in-memory entry wins on a shared id and the two lists
 * are merged by age. Unknown connections read as empty.
 *
 * Runs that finished while the recording switch was unknown are decided at
 * the END of this function, once the stored flags are in hand.
 */
function hydrate(): void {
	const rawBag = prefs?.getPref(PREF_HISTORY);
	const next: HistoryBag = {};
	if (rawBag && typeof rawBag === 'object') {
		for (const [key, value] of Object.entries(rawBag as Record<string, unknown>)) {
			if (!Array.isArray(value)) continue;
			const entries = value.map(readEntry).filter((entry): entry is IHistoryEntry => entry !== null);
			if (entries.length > 0) next[key] = trimHistory(entries);
		}
	}

	const pendingKeys = Object.keys(bag);
	for (const key of pendingKeys) {
		const pending = bag[key] ?? [];
		const stored = next[key] ?? [];
		const known = new Set(pending.map((entry) => entry.id));
		const merged = [...pending, ...stored.filter((entry) => !known.has(entry.id))]
			.sort((a, b) => b.at - a.at);
		next[key] = trimHistory(merged);
	}
	bag = next;

	const rawRecording = prefs?.getPref(PREF_RECORDING);
	const flags: Record<string, boolean> = {};
	if (rawRecording && typeof rawRecording === 'object') {
		for (const [key, value] of Object.entries(rawRecording as Record<string, unknown>)) {
			if (typeof value === 'boolean') flags[key] = value;
		}
	}
	// A switch flipped before the bridge mounted outranks the stored one —
	// but only while it is still UNSAVED. Rebuilding from the stored flags
	// rather than layering onto the previous in-memory map is what keeps a
	// value from an earlier attach from outliving the file it came from.
	recording = { ...flags, ...unsavedRecording };

	hydrated = true;

	// Runs held back while the switch was unknown are recorded (or dropped)
	// now, oldest first so the newest still ends up at the top of the list.
	const queued = pendingRuns;
	pendingRuns = [];
	for (const run of queued) recordRun(run.key, run.entry);

	notify();
	// Anything that was waiting in memory now has somewhere to go — entries
	// recorded before the bridge mounted, and switches flipped before it did.
	if (pendingKeys.length > 0 || Object.keys(unsavedRecording).length > 0) schedulePersist();
}

/** Write both preference keys now, applying the whole-bag budget first. */
function flush(): void {
	persistTimer = null;
	if (!prefs) return;
	const trimmed = trimBag(bag);
	// Only re-notify when the budget actually dropped something.
	const changed = JSON.stringify(trimmed) !== JSON.stringify(bag);
	bag = trimmed;
	prefs.setPref(PREF_HISTORY, bag);
	prefs.setPref(PREF_RECORDING, recording);
	// The switches are on disk now, so nothing in memory outranks them.
	unsavedRecording = {};
	if (changed) notify();
}

/**
 * Queue a write. The first mutation starts the clock and later ones ride the
 * same write, so a burst of runs cannot postpone persistence indefinitely.
 */
function schedulePersist(): void {
	if (!prefs || persistTimer !== null) return;
	persistTimer = setTimeout(flush, PERSIST_DELAY_MS);
}

/**
 * Write both preference keys NOW, cancelling any batch already in flight.
 *
 * A no-op when no bridge is mounted — {@link flush} refuses to write without
 * an accessor, which is the rule this whole file is built around. The caller
 * is responsible for keeping the unwritten intent (see
 * {@link unsavedRecording}).
 */
function persistNow(): void {
	if (persistTimer !== null) {
		clearTimeout(persistTimer);
		persistTimer = null;
	}
	flush();
}

/**
 * Attach the shell's preference accessor and hydrate from it.
 *
 * Attachment is reference-counted so more than one bridge may be mounted
 * (the connection workbench keeps one alive; the History drawer mounts its
 * own). The LAST detach drops any pending write and forgets the accessor —
 * see this file's header for why a background write must never happen.
 *
 * Exported because it is the store's real seam onto the shell:
 * {@link HistoryPrefsBridge} is a null-rendering wrapper around this call, and
 * the persistence rules worth testing (what a hydrate trusts, what a detach
 * drops) live here rather than in React.
 *
 * @param api - The `{ getPref, setPref }` accessor; must be stable.
 * @returns The detach function.
 */
export function attachPrefs(api: IPrefsApi): () => void {
	prefs = api;
	bridgeCount += 1;
	if (!hydrated) hydrate();

	return () => {
		bridgeCount -= 1;
		if (bridgeCount > 0) return;
		if (persistTimer !== null) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		prefs = null;
		// The workspace file is the source of truth and is re-read by the
		// shell on every app switch, so the next attach hydrates afresh.
		hydrated = false;
	};
}

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * Replace one connection's entries and schedule a write.
 *
 * @param key - The connection's endpoint key.
 * @param entries - The connection's new entries, newest first.
 */
function setEntries(key: string, entries: IHistoryEntry[]): void {
	if (entries.length === 0) {
		if (!(key in bag)) return;
		const next = { ...bag };
		delete next[key];
		bag = next;
	} else {
		bag = { ...bag, [key]: entries };
	}
	notify();
	schedulePersist();
}

/**
 * Record one finished statement, unless recording is off for that connection.
 *
 * Before hydration the stored switch is UNREADABLE, and `recording[key]` is
 * simply absent — which reads as the default, on. Recording the run then
 * would persist the SQL of a user who turned history off, because hydrate
 * merges whatever is already in the bag and schedules a write. So a run that
 * arrives early waits in {@link pendingRuns} until the switch is known.
 *
 * @param key - The connection's endpoint key.
 * @param entry - The finished statement's record.
 */
function recordRun(key: string, entry: IHistoryEntry): void {
	if (!hydrated) {
		pendingRuns.push({ key, entry });
		if (pendingRuns.length > MAX_PENDING_RUNS) pendingRuns.shift();
		return;
	}
	if (recording[key] === false) return;
	setEntries(key, trimHistory([entry, ...(bag[key] ?? [])]));
}

/**
 * Forget one entry.
 *
 * @param key - The connection's endpoint key.
 * @param id - The entry to remove.
 */
export function removeEntry(key: string, id: string): void {
	const current = bag[key];
	if (!current) return;
	setEntries(key, current.filter((entry) => entry.id !== id));
}

/**
 * Flip one entry's pinned state.
 *
 * @param key - The connection's endpoint key.
 * @param id - The entry to pin or unpin.
 */
export function togglePin(key: string, id: string): void {
	const current = bag[key];
	if (!current) return;
	setEntries(key, current.map((entry) => (
		entry.id === id ? { ...entry, pinned: !entry.pinned } : entry
	)));
}

/**
 * Set (or clear) one entry's note.
 *
 * @param key - The connection's endpoint key.
 * @param id - The entry to annotate.
 * @param note - The note text; empty clears it.
 */
export function setNote(key: string, id: string, note: string): void {
	const current = bag[key];
	if (!current) return;
	setEntries(key, current.map((entry) => {
		if (entry.id !== id) return entry;
		const next = { ...entry };
		if (note) next.note = note;
		else delete next.note;
		return next;
	}));
}

/**
 * Forget every entry for one connection, pinned entries included.
 *
 * @param key - The connection's endpoint key.
 */
export function clearForKey(key: string): void {
	setEntries(key, []);
}

/**
 * Turn recording on or off for one connection. Existing entries are kept
 * either way — switching off stops new records, it does not erase old ones.
 *
 * @param key - The connection's endpoint key.
 * @param on - Whether to record runs on this connection.
 */
export function setRecording(key: string, on: boolean): void {
	if ((recording[key] ?? true) === on) return;
	recording = { ...recording, [key]: on };
	unsavedRecording = { ...unsavedRecording, [key]: on };
	notify();
	// NOT debounced, unlike every other mutation here. Runs arrive in bursts
	// and one lost run costs a list row, so they batch. This switch is the
	// opposite on both counts: a person flips it once, deliberately, and what
	// a lost write costs is their decision not to have their SQL persisted.
	// The last detach CANCELS a pending write (see attachPrefs), so a
	// debounced switch-off dropped there would leave the stored flag saying
	// `true` and the next page load would quietly resume recording.
	persistNow();
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Register a store listener. Hoisted so useSyncExternalStore receives a
 * STABLE reference — one subscription per component, not one per render.
 *
 * @param callback - The change callback.
 * @returns The unsubscribe function.
 */
function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => { listeners.delete(callback); };
}

/**
 * Subscribe to one connection's history.
 *
 * @param key - The connection's endpoint key.
 * @returns The entries, newest first (empty for an unknown connection).
 */
export function useHistory(key: string): IHistoryEntry[] {
	return useSyncExternalStore(subscribe, () => bag[key] ?? NO_ENTRIES);
}

/**
 * Subscribe to one connection's recording switch (default on).
 *
 * @param key - The connection's endpoint key.
 * @returns Whether runs on that connection are being recorded.
 */
export function useRecording(key: string): boolean {
	return useSyncExternalStore(subscribe, () => recording[key] ?? true);
}

// =============================================================================
// PREFS BRIDGE
// =============================================================================

/**
 * Mounts the store's access to workspace preferences.
 *
 * Renders nothing. Mount it wherever SQL Explorer is on screen and history
 * should be kept — the connection workbench does, and the History drawer
 * mounts its own so the drawer works even from a query document whose
 * workbench tab was closed. Multiple mounts are safe.
 *
 * @returns Nothing (a null-rendering component).
 */
export const HistoryPrefsBridge: React.FC = () => {
	const api = usePrefs();

	// The shell hands out a NEW accessor object whenever any preference
	// changes; the store needs one stable identity for the mount's lifetime,
	// so calls are forwarded through a ref instead.
	const latest = useRef(api);
	latest.current = api;

	const stable = useMemo<IPrefsApi>(() => ({
		getPref: (key: string) => latest.current.getPref(key),
		setPref: (key: string, value: unknown) => latest.current.setPref(key, value),
	}), []);

	useEffect(() => attachPrefs(stable), [stable]);

	return null;
};

// =============================================================================
// RUN SUBSCRIPTION
// =============================================================================

// The runner emits every finished statement; recording is decided here, so
// the runner stays unaware of whether history is on, off, or persisted.
subscribeRuns(recordRun);
