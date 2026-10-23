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
// EXPLORER HISTORY — STORE FACTORY (per-connection statement history)
// =============================================================================
//
// One store per app, made by createHistoryStore and owned by that app. The
// state lives in the factory's closure, so two apps (SQL, Graph, a Vector
// test double) never see each other's entries, switches or timers.
//
// Persisted through the shell's WORKSPACE preferences (server-side, per user)
// rather than browser storage — history follows the person to another browser.
//
// WHERE A WRITE LANDS — the constraint that shapes this file:
// `usePrefs().setPref` reaches `useWorkspaceState.updatePrefs`, which patches
// `apps[activeAppIdRef.current].prefs` — the app that is active AT WRITE TIME,
// not the app that asked. A write issued while the app is in the background
// would be filed under whatever app is in the foreground, and the shell
// reloads each app's prefs from disk on every switch, so it would be both
// misfiled and lost.
//
// So the store writes ONLY while a preferences accessor is attached (the
// bridge component mounts it). The shell unmounts the whole app subtree when
// another app takes over, which makes "attached" equivalent to "this app is
// active". On the last detach the pending debounced write is DROPPED, not
// flushed: up to 300 ms of history can be lost if the user switches apps
// immediately after a run, and that is the honest trade against writing into
// another app's preferences.
//
// THE RECORDING SWITCH IS EXEMPT from that trade. Losing a run costs a row;
// losing a switch-OFF costs the user their decision not to have their text
// written down, and they would never know. So `setRecording` writes through
// immediately instead of riding the debounce, and any switch that could not be
// written (no accessor attached) is remembered in `unsavedRecording` until a
// hydrate can land it.
//
// WHOSE HISTORY IS IN MEMORY — the store outlives a detach, and the next
// attach MERGES what is still in memory into what it reads (so a run whose
// write the detach dropped is saved after all). The shell can sign one account
// out and another in without reloading the page, so that merge would hand the
// previous account's entries to the next one and write them into its workspace
// file. So an attach names the OWNER of the accessor (the identity
// fingerprint: user, organization, development team). The first one binds; an
// attach under a different owner (null: signed out) first forgets everything
// held in memory: entries, switches, runs queued before hydration and any
// pending write. The previous account loses only what had not reached its
// file yet, the same trade as an app switch.
//
// LEGACY KEYS — reading history saved under an older connection key
//
// SQL Explorer's first key was `projectId:source:nodeId`; the owner-aware key
// replaces it, and renaming a key silently orphans every user's saved history.
// So when `legacyKeyOf` maps a connection to its old key, history is read as a
// MERGED VIEW of the two lists. No AUTOMATIC write touches the old list.
// Several new keys can map onto one old key (the same dev run under two
// development teams), so a bound or a copy applied to the old list on behalf
// of one would change, or empty, what the others read.
//
//   - reads: entries under the new key AND under the old key, de-duplicated by
//     id (the new key's copy wins), newest first, bounded like any list. The
//     bound applies to the VIEW: an old entry it leaves out is still stored
//     and is shown again once there is room;
//   - new runs are written under the NEW key only. A run that repeats an old
//     entry's statement collapses onto a COPY of that entry under the new key
//     (same id, so the copy stands in for it; its pin and note are kept);
//   - pin and note on an old entry write a changed copy under the new key;
//   - remove and clear are the user's own deliberate deletes, so they DO reach
//     the old list: remove drops the entry from both lists (the copy and the
//     original), and clear empties the connection's own list and the old list.
//     Every connection that reads that old list stops seeing what was deleted;
//   - so until the user deletes something, an older build still sees its own
//     list, unchanged, and another team context still reads every old entry.
//     The one bound that can still drop an old entry is the size budget across
//     every connection's lists (trimBag), oldest first, as it always has been.
//
// The mapping is the caller's to make safe: the caller maps ONLY connections
// the old key could have meant (see keys.ts legacyKeyFromKey), so history is
// never read across owners or across dev and deploy.
// =============================================================================

import { useSyncExternalStore } from 'react';
import { createRunEvents } from './runEvents';
import type { IRunEvents } from './runEvents';
import { trimBag, trimHistory } from './trim';
import { DEFAULT_HISTORY_LIMITS } from './types';
import type { HistoryBag, IHistoryEntry, IHistoryLimits, IPrefsAccessor } from './types';

// =============================================================================
// OPTIONS + STORE SHAPE
// =============================================================================

/** What distinguishes one app's history store from another's. */
export interface IHistoryStoreOptions<F extends string> {
	/** Preference key holding every connection's entries ('sql.history', 'graph.history'). */
	historyKey: string;
	/** Preference key holding the per-connection recording switch ('sql.historyRecording'). */
	recordingKey: string;
	/** Name of the persisted statement-text field on each entry ('sql', 'cypher'). */
	textField: F;
	/** Per-connection bounds (defaults to {@link DEFAULT_HISTORY_LIMITS}). */
	limits?: IHistoryLimits;
	/** The run bus to listen on (defaults to a fresh one, exposed as `runs`). */
	runs?: IRunEvents<F>;
	/** Debounce before a batch of mutations is written, in ms (default 300). */
	persistDelayMs?: number;
	/**
	 * Maps a connection key to the key its history was saved under before the
	 * key format changed, or null when it has none. When set, every connection's
	 * history is the MERGED view of both lists (see "LEGACY KEYS" below).
	 */
	legacyKeyOf?: (key: string) => string | null;
}

/** One app's history store. */
export interface IHistoryStore<F extends string> {
	/**
	 * Attach the preference accessor and hydrate from it. Reference-counted: more
	 * than one bridge may be mounted, and the LAST detach drops any pending
	 * write and forgets the accessor.
	 *
	 * @param api - The `{ getPref, setPref }` accessor; must be stable.
	 * @param owner - Whose workspace the accessor reads and writes: the identity
	 *   fingerprint, or null when nobody is signed in. The first owner given
	 *   binds; a different one first forgets everything held in memory (see
	 *   "WHOSE HISTORY IS IN MEMORY"). Omitted: no check.
	 * @returns The detach function.
	 */
	attachPrefs(api: IPrefsAccessor, owner?: string | null): () => void;
	/** Subscribe to one connection's history (newest first; empty for an unknown connection). */
	useHistory(key: string): IHistoryEntry<F>[];
	/** Subscribe to one connection's recording switch (default on). */
	useRecording(key: string): boolean;
	/**
	 * One connection's history now, for code outside React (a dev-tool
	 * controller serving its frames): the snapshot `useHistory` would render,
	 * referentially stable until that list changes.
	 */
	getHistory(key: string): IHistoryEntry<F>[];
	/** One connection's recording switch now, for code outside React. */
	getRecording(key: string): boolean;
	/** Be told about every change from code outside React; returns unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Forget one entry. */
	removeEntry(key: string, id: string): void;
	/** Flip one entry's pinned state. */
	togglePin(key: string, id: string): void;
	/** Set (or clear, with '') one entry's note. */
	setNote(key: string, id: string, note: string): void;
	/** Forget every entry for one connection, pinned entries included. */
	clearForKey(key: string): void;
	/** Turn recording on or off for one connection; existing entries are kept either way. */
	setRecording(key: string, on: boolean): void;
	/** The run bus: emitting here records (unless recording is off for that connection). */
	runs: IRunEvents<F>;
	/**
	 * Write the batch still waiting in the debounce NOW, through the attached
	 * accessor. Call it before the last detach when the mount is going away
	 * under the same owner (an unmount, a disconnect): the last detach drops a
	 * pending batch, so a run recorded in the final `persistDelayMs` would never
	 * be written. A no-op when nothing is pending or nothing is attached.
	 */
	flush(): void;
	/** The bounds this store enforces. */
	limits: IHistoryLimits;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * How many pre-hydration runs are held while the recording switch is unknown.
 * The queue exists to survive a hydrate, not to accumulate a session's work,
 * and it holds the user's text — so it is bounded like everything else here.
 */
const MAX_PENDING_RUNS = 100;

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a history store.
 *
 * @param options - The preference keys, text field and bounds.
 * @returns The store.
 */
export function createHistoryStore<F extends string>(options: IHistoryStoreOptions<F>): IHistoryStore<F> {
	const { historyKey, recordingKey, textField } = options;
	const limits = options.limits ?? DEFAULT_HISTORY_LIMITS;
	const persistDelayMs = options.persistDelayMs ?? 300;
	const runs = options.runs ?? createRunEvents<F>();

	/** Shared empty list, so an unknown connection keeps a stable snapshot. */
	const NO_ENTRIES: IHistoryEntry<F>[] = [];
	const legacyKeyOf = options.legacyKeyOf;

	/**
	 * The older key a connection's history may also live under.
	 *
	 * @param key - The connection's current key.
	 * @returns The old key, or null when there is none to read.
	 */
	function legacyOf(key: string): string | null {
		const legacy = legacyKeyOf?.(key) ?? null;
		return legacy !== null && legacy !== '' && legacy !== key ? legacy : null;
	}

	// ── State ─────────────────────────────────────────────────────────────────

	let bag: HistoryBag<F> = {};
	let recording: Record<string, boolean> = {};
	let hydrated = false;

	/**
	 * Recording switches flipped since the last successful write. These are the
	 * ONLY overrides allowed to outrank the stored flags at hydration.
	 *
	 * Keeping the whole of `recording` as an override instead would make every
	 * hydrate prefer a value that may be arbitrarily old: a flag that has
	 * already reached disk is re-read from disk, so a second copy of it in
	 * memory can only ever be stale — and a stale `true` surviving a detach
	 * would turn recording back on for a connection the workspace file says is
	 * off.
	 */
	let unsavedRecording: Record<string, boolean> = {};

	/**
	 * Runs that finished before the recording switch could be read. Holding them
	 * here rather than in `bag` is what keeps a user who turned recording OFF
	 * from having their text persisted: until hydrate, a stored `false` is
	 * indistinguishable from "never set", and the default is on.
	 */
	let pendingRuns: { key: string; entry: IHistoryEntry<F> }[] = [];

	let prefs: IPrefsAccessor | null = null;
	let bridgeCount = 0;
	let persistTimer: ReturnType<typeof setTimeout> | null = null;

	/** Whose history is in memory: set by the first attach that names an owner. */
	let owner: { id: string | null } | null = null;

	const listeners = new Set<() => void>();

	/** Notify every subscribed component that the store changed. */
	function notify(): void {
		listeners.forEach((listener) => listener());
	}

	/**
	 * Trim one connection's entries with this store's text field and bounds.
	 *
	 * @param entries - The entries, newest first.
	 * @returns The bounded entries.
	 */
	function trim(entries: IHistoryEntry<F>[]): IHistoryEntry<F>[] {
		return trimHistory(entries, textField, limits);
	}

	// ── The merged view (legacy keys) ─────────────────────────────────────────

	/** Merged views by connection key, valid while both underlying lists are the same objects. */
	const viewCache = new Map<string, { own: IHistoryEntry<F>[] | undefined; old: IHistoryEntry<F>[]; view: IHistoryEntry<F>[] }>();

	/**
	 * One connection's history as the UI reads it: its own list, plus the list
	 * under its legacy key when there is one (less what this connection copied).
	 * Referentially stable until either list changes, because it is a
	 * useSyncExternalStore snapshot.
	 *
	 * @param key - The connection's key.
	 * @returns The entries, newest first.
	 */
	function viewOf(key: string): IHistoryEntry<F>[] {
		const own = bag[key];
		const legacy = legacyOf(key);
		const old = legacy === null ? undefined : bag[legacy];
		if (old === undefined) return own ?? NO_ENTRIES;
		const cached = viewCache.get(key);
		if (cached !== undefined && cached.own === own && cached.old === old) return cached.view;
		const copied = new Set((own ?? []).map((entry) => entry.id));
		const combined = [...(own ?? []), ...old.filter((entry) => !copied.has(entry.id))].sort((a, b) => b.at - a.at);
		const view = trim(combined);
		viewCache.set(key, { own, old, view });
		return view;
	}

	/**
	 * Whether runs on a connection are recorded: its own switch, else its legacy
	 * key's (so a switch-OFF chosen before the key changed still holds), else on.
	 *
	 * @param key - The connection's key.
	 * @returns True when runs are recorded.
	 */
	function recordingOf(key: string): boolean {
		const legacy = legacyOf(key);
		return recording[key] ?? (legacy === null ? undefined : recording[legacy]) ?? true;
	}

	/**
	 * The old-list entry with this id, if the connection has an old list.
	 *
	 * @param key - The connection's key.
	 * @param id - The entry id.
	 * @returns The entry in the old list, or undefined.
	 */
	function legacyEntryOf(key: string, id: string): IHistoryEntry<F> | undefined {
		const legacy = legacyOf(key);
		if (legacy === null) return undefined;
		return bag[legacy]?.find((entry) => entry.id === id);
	}

	/**
	 * Change one entry the connection can see. An entry in its own list changes
	 * there; an old-list entry is COPIED, changed, into its own list (same id,
	 * so the copy stands in for it), and the old list is left as it is.
	 *
	 * @param key - The connection's key.
	 * @param id - The entry id.
	 * @param change - The change.
	 */
	function editEntry(key: string, id: string, change: (entry: IHistoryEntry<F>) => IHistoryEntry<F>): void {
		const own = bag[key];
		if (own?.some((entry) => entry.id === id)) {
			setEntries(key, own.map((entry) => (entry.id === id ? change(entry) : entry)));
			return;
		}
		const original = legacyEntryOf(key, id);
		if (original === undefined) return;
		setEntries(key, [...(own ?? []), change(original)].sort((a, b) => b.at - a.at));
	}

	// ── Hydration and persistence ─────────────────────────────────────────────

	/**
	 * Narrow one persisted entry, dropping anything the workspace file holds
	 * that is not a usable record. The file is long-lived and hand-editable, so
	 * its contents are treated as untrusted input rather than as our own types.
	 *
	 * @param value - A candidate entry from the preferences bag.
	 * @returns The entry, or null when it cannot be used.
	 */
	function readEntry(value: unknown): IHistoryEntry<F> | null {
		if (!value || typeof value !== 'object') return null;
		const raw = value as Record<string, unknown>;
		const text = raw[textField];
		if (typeof raw.id !== 'string' || typeof text !== 'string') return null;
		// Key order is the persisted order: id, text, at, ms, outcome, kind, then
		// the optional fields. Built literally so a reload rewrites byte-identically.
		return {
			id: raw.id,
			[textField]: text,
			at: typeof raw.at === 'number' ? raw.at : 0,
			ms: typeof raw.ms === 'number' ? raw.ms : 0,
			outcome: (raw.outcome ?? 'rows') as IHistoryEntry<F>['outcome'],
			kind: (raw.kind ?? 'other') as string,
			...(typeof raw.rows === 'number' ? { rows: raw.rows } : {}),
			...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}),
			...(typeof raw.affected === 'number' ? { affected: raw.affected } : {}),
			...(typeof raw.error === 'string' ? { error: raw.error } : {}),
			...(raw.pinned ? { pinned: true } : {}),
			...(typeof raw.note === 'string' ? { note: raw.note } : {}),
			...(raw.truncated ? { truncated: true } : {}),
		} as IHistoryEntry<F>;
	}

	/**
	 * Read both preference keys into memory, MERGING anything already recorded.
	 *
	 * Entries recorded during an earlier attach are in memory only once the last
	 * bridge detaches. Replacing the bag wholesale would throw them away at the
	 * moment persistence became possible, which is the one moment they could
	 * have been saved — so the in-memory entry wins on a shared id and the two
	 * lists are merged by age. Unknown connections read as empty.
	 *
	 * Runs that finished while the recording switch was unknown are decided at
	 * the END of this function, once the stored flags are in hand.
	 */
	function hydrate(): void {
		const rawBag = prefs?.getPref(historyKey);
		const next: HistoryBag<F> = {};
		if (rawBag && typeof rawBag === 'object') {
			for (const [key, value] of Object.entries(rawBag as Record<string, unknown>)) {
				if (!Array.isArray(value)) continue;
				const entries = value.map(readEntry).filter((entry): entry is IHistoryEntry<F> => entry !== null);
				if (entries.length > 0) next[key] = trim(entries);
			}
		}

		const pendingKeys = Object.keys(bag);
		for (const key of pendingKeys) {
			const pending = bag[key] ?? [];
			const stored = next[key] ?? [];
			const known = new Set(pending.map((entry) => entry.id));
			const merged = [...pending, ...stored.filter((entry) => !known.has(entry.id))]
				.sort((a, b) => b.at - a.at);
			next[key] = trim(merged);
		}
		bag = next;

		const rawRecording = prefs?.getPref(recordingKey);
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
		prefs.setPref(historyKey, bag);
		prefs.setPref(recordingKey, recording);
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
		persistTimer = setTimeout(flush, persistDelayMs);
	}

	/**
	 * Write both preference keys NOW, cancelling any batch already in flight.
	 *
	 * A no-op when no accessor is attached — {@link flush} refuses to write
	 * without one, which is the rule this whole file is built around. The caller
	 * is responsible for keeping the unwritten intent (see `unsavedRecording`).
	 */
	function persistNow(): void {
		if (persistTimer !== null) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		flush();
	}

	/**
	 * Forget everything held in memory: entries, switches, runs queued before
	 * hydration and any pending write. The next attach hydrates afresh from its
	 * own accessor.
	 */
	function forgetMemory(): void {
		if (persistTimer !== null) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		bag = {};
		recording = {};
		unsavedRecording = {};
		pendingRuns = [];
		viewCache.clear();
		hydrated = false;
		notify();
	}

	function attachPrefs(api: IPrefsAccessor, ownerId?: string | null): () => void {
		if (ownerId !== undefined) {
			// The first owner binds. Another one (a sign-out included) means what
			// is in memory belongs to somebody else's workspace.
			if (owner !== null && owner.id !== ownerId) forgetMemory();
			owner = { id: ownerId };
		}
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

	// ── Actions ───────────────────────────────────────────────────────────────

	/**
	 * Replace one connection's entries and schedule a write.
	 *
	 * @param key - The connection's endpoint key.
	 * @param entries - The connection's new entries, newest first.
	 */
	function setEntries(key: string, entries: IHistoryEntry<F>[]): void {
		applyLists([[key, entries]]);
	}

	/**
	 * Replace several connections' lists as ONE change: one notification, one write.
	 *
	 * @param updates - Key and new entries pairs, newest first; an empty list removes the key.
	 */
	function applyLists(updates: [string, IHistoryEntry<F>[]][]): void {
		let next = bag;
		let changed = false;
		for (const [key, entries] of updates) {
			if (entries.length === 0) {
				if (!(key in next)) continue;
				if (next === bag) next = { ...bag };
				delete next[key];
			} else {
				if (next === bag) next = { ...bag };
				next[key] = entries;
			}
			changed = true;
		}
		if (!changed) return;
		bag = next;
		notify();
		schedulePersist();
	}

	/**
	 * Record one finished statement, unless recording is off for that connection.
	 *
	 * Before hydration the stored switch is UNREADABLE, and `recording[key]` is
	 * simply absent — which reads as the default, on. Recording the run then
	 * would persist the text of a user who turned history off, because hydrate
	 * merges whatever is already in the bag and schedules a write. So a run that
	 * arrives early waits in `pendingRuns` until the switch is known.
	 *
	 * @param key - The connection's endpoint key.
	 * @param entry - The finished statement's record.
	 */
	function recordRun(key: string, entry: IHistoryEntry<F>): void {
		if (!hydrated) {
			pendingRuns.push({ key, entry });
			if (pendingRuns.length > MAX_PENDING_RUNS) pendingRuns.shift();
			return;
		}
		if (!recordingOf(key)) return;
		const legacy = legacyOf(key);
		if (legacy === null || bag[legacy] === undefined) {
			setEntries(key, trim([entry, ...(bag[key] ?? [])]));
			return;
		}
		// The connection has history under its old key too. Bound the MERGED
		// view, and keep in the connection's own list every survivor that is not
		// an untouched old entry. A run never writes the old list: an old entry
		// the bound leaves out stays stored, and a run that repeats an old entry
		// collapses onto a copy of it, which lands in the own list.
		const merged = trim([entry, ...viewOf(key)]);
		const untouched = new Set<IHistoryEntry<F>>(bag[legacy]);
		setEntries(key, merged.filter((kept) => !untouched.has(kept)));
	}

	function removeEntry(key: string, id: string): void {
		// A delete is the user's own deliberate act, so it reaches the old list
		// too. An old entry the connection copied (pin, note, a repeat) lives in
		// both lists: drop the copy AND the original, or the original would come
		// back and its text would stay in the file.
		const updates: [string, IHistoryEntry<F>[]][] = [];
		const own = bag[key];
		if (own?.some((entry) => entry.id === id)) updates.push([key, own.filter((entry) => entry.id !== id)]);
		const legacy = legacyOf(key);
		if (legacy !== null && legacyEntryOf(key, id) !== undefined) {
			updates.push([legacy, (bag[legacy] as IHistoryEntry<F>[]).filter((entry) => entry.id !== id)]);
		}
		applyLists(updates);
	}

	function togglePin(key: string, id: string): void {
		editEntry(key, id, (entry) => ({ ...entry, pinned: !entry.pinned }));
	}

	function setNote(key: string, id: string, note: string): void {
		editEntry(key, id, (entry) => {
			const next = { ...entry };
			if (note) next.note = note;
			else delete next.note;
			return next;
		});
	}

	function clearForKey(key: string): void {
		// Like a delete, a clear is deliberate: it empties the old list too.
		const legacy = legacyOf(key);
		applyLists(legacy === null ? [[key, []]] : [[key, []], [legacy, []]]);
	}

	function setRecording(key: string, on: boolean): void {
		if (recordingOf(key) === on) return;
		recording = { ...recording, [key]: on };
		unsavedRecording = { ...unsavedRecording, [key]: on };
		notify();
		// NOT debounced, unlike every other mutation here. Runs arrive in bursts
		// and one lost run costs a list row, so they batch. This switch is the
		// opposite on both counts: a person flips it once, deliberately, and what
		// a lost write costs is their decision not to have their text persisted.
		// The last detach CANCELS a pending write (see attachPrefs), so a
		// debounced switch-off dropped there would leave the stored flag saying
		// `true` and the next page load would quietly resume recording.
		persistNow();
	}

	// ── Hooks ─────────────────────────────────────────────────────────────────

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

	function useHistory(key: string): IHistoryEntry<F>[] {
		const snapshot = (): IHistoryEntry<F>[] => viewOf(key);
		return useSyncExternalStore(subscribe, snapshot, snapshot);
	}

	function useRecording(key: string): boolean {
		const snapshot = (): boolean => recordingOf(key);
		return useSyncExternalStore(subscribe, snapshot, snapshot);
	}

	// The runner emits every finished statement; recording is decided here, so
	// the runner stays unaware of whether history is on, off, or persisted.
	runs.subscribeRuns(recordRun);

	return {
		attachPrefs,
		useHistory,
		useRecording,
		getHistory: viewOf,
		getRecording: recordingOf,
		subscribe,
		removeEntry,
		togglePin,
		setNote,
		clearForKey,
		setRecording,
		runs,
		limits,
		flush: () => {
			if (prefs !== null && persistTimer !== null) persistNow();
		},
	};
}
