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
// HISTORY — A FRAME'S VIEW OF THE CONTROLLER'S HISTORY
// =============================================================================
//
// In a dev tool the controller owns history (sqlController.ts). A frame:
//
//   reads    the retained `history` topic: where history is kept, and per
//            connection it has read, a revision and the recording switch. On
//            first use, and whenever a revision moves on, it reads the
//            entries again with `sql.history` (an op result: a history bag
//            does not fit the retained-state cap);
//   writes   through ops only: `sql.historyRecord` for a finished statement,
//            `sql.historyEdit` for delete, pin, note, clear and the switch.
//            Each carries the identity the frame belongs to; the controller
//            refuses a write for anyone else.
//
// Nothing here touches the shell's preferences: in a rocket-ui dev-tool mount
// `usePrefs` would write into rocket-ui's own bag, and in VS Code it is a
// no-op.
// =============================================================================

import { useEffect, useSyncExternalStore } from 'react';
import type { TypedToolChannel } from 'shell';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import type { SqlEndpoint } from '../connect';
import type { HistoryState, SqlEventMap, SqlOps, SqlStateMap } from '../ops';
import { SQL_OP_TIMEOUT_MS } from '../sqlTimeouts';
import { devToolPrivacyNotice } from './api';
import type { HistoryEdit, SqlHistoryApi } from './api';
import type { HistoryEntry } from './types';

/** Shared empty list, so an unread connection keeps a stable snapshot. */
const NO_ENTRIES: HistoryEntry[] = [];

/** A frame's history view, with its lifetime. */
export interface RemoteHistory extends SqlHistoryApi {
	/** Start following one connection outside React (the hooks call it from an effect). */
	watch(endpoint: SqlEndpoint): void;
	/** One connection's entries as last read (outside React). */
	entriesOf(endpoint: SqlEndpoint): HistoryEntry[];
	/** Forget every entry read (identity change, sign-out, a dropped connection). */
	reset(): void;
	/** Stop following the channel. */
	dispose(): void;
}

/** What {@link createRemoteHistory} needs. */
export interface RemoteHistoryOptions {
	/** The frame's caller. */
	caller: IFrameCaller<SqlOps>;
	/** The frame's channel. */
	channel: TypedToolChannel<SqlStateMap, SqlEventMap>;
	/** The identity fingerprint the frame belongs to (sent with writes). */
	owner: () => string | null;
}

/**
 * A history entry as JSON carries it (no undefined fields).
 *
 * @param entry - The entry.
 * @returns The entry without undefined fields.
 */
function jsonEntry(entry: HistoryEntry): HistoryEntry {
	return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as HistoryEntry;
}

/**
 * Build a frame's history view over its controller.
 *
 * @param opts - See {@link RemoteHistoryOptions}.
 * @returns The view; dispose it with the frame.
 */
export function createRemoteHistory(opts: RemoteHistoryOptions): RemoteHistory {
	const { caller, channel, owner } = opts;
	/** What this frame has read, per endpoint key. */
	const read = new Map<string, { endpoint: SqlEndpoint; entries: HistoryEntry[]; rev: number | null; loaded: boolean; loading: boolean; again: boolean; recording: boolean | null; reread: boolean }>();
	let state: HistoryState | undefined;
	let epoch = 0;
	const listeners = new Set<() => void>();
	const notify = (): void => listeners.forEach((listener) => listener());
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	};

	/**
	 * Read one connection's entries from the controller.
	 *
	 * @param key - The endpoint key.
	 */
	const fetch = (key: string): void => {
		const slot = read.get(key);
		if (!slot || typeof slot.endpoint.connId !== 'string') return;
		if (slot.loading) {
			slot.again = true;
			return;
		}
		slot.loading = true;
		const asked = epoch;
		const rev = state?.keys[key]?.rev ?? null;
		caller.callReply('sql.history', { connId: slot.endpoint.connId, owner: owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] })
			.then((entries) => {
				if (asked !== epoch || read.get(key) !== slot) return;
				slot.entries = Array.isArray(entries) ? entries : NO_ENTRIES;
				slot.rev = rev;
				slot.loaded = true;
				notify();
			})
			.catch(() => undefined)
			.finally(() => {
				slot.loading = false;
				if (slot.again && asked === epoch) {
					slot.again = false;
					fetch(key);
				}
			});
	};

	const offState = channel.onState('history', (snapshot) => {
		const before = state;
		state = snapshot;
		for (const [key, slot] of read) {
			const followed = snapshot?.keys?.[key];
			if (followed) slot.recording = followed.recording;
			const rev = followed?.rev;
			// The controller stopped following this key (it follows the keys read
			// most recently): reading it again follows it again. Only on the
			// change itself (the same snapshot delivered again reads nothing),
			// and ONCE per view: with more views open than the controller follows,
			// a view dropped a second time keeps what it last read until it is
			// opened again, so the views cannot evict each other forever.
			const unfollowed = rev === undefined && before?.keys?.[key] !== undefined && snapshot?.storage !== 'none' && snapshot?.storage === before?.storage;
			const followAgain = unfollowed && !slot.reread;
			if (followAgain) slot.reread = true;
			// A revision moved on, or a read that failed (the controller could not
			// vouch for anyone yet) can now succeed.
			if ((rev !== undefined && rev !== slot.rev) || (!slot.loaded && snapshot?.storage !== 'none') || followAgain) fetch(key);
		}
		notify();
	});

	// A read refused because the frame had not yet learnt its account (its
	// owner was null) is tried again once the controller vouches for one.
	const offIdentity = channel.onState('identity', (snapshot) => {
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { fingerprint?: unknown }).fingerprint : undefined;
		if (typeof value !== 'string' || value === '') return;
		for (const [key, slot] of read) {
			if (!slot.loaded && !slot.loading) fetch(key);
		}
	});

	/**
	 * Start following one connection (first use reads its entries).
	 *
	 * @param endpoint - The connection's endpoint.
	 */
	const watch = (endpoint: SqlEndpoint): void => {
		const slot = read.get(endpoint.key);
		if (slot) {
			// The view was opened again: it may follow again, and a key the
			// controller no longer follows is read (and followed) now.
			slot.reread = false;
			if (slot.loaded && state?.keys?.[endpoint.key] === undefined && state?.storage !== 'none') fetch(endpoint.key);
			return;
		}
		read.set(endpoint.key, { endpoint, entries: NO_ENTRIES, rev: null, loaded: false, loading: false, again: false, recording: state?.keys?.[endpoint.key]?.recording ?? null, reread: false });
		fetch(endpoint.key);
	};

	/**
	 * Send one write; failures are dropped (the controller's state is the truth).
	 *
	 * @param endpoint - The connection.
	 * @param send - The op call.
	 */
	const write = (endpoint: SqlEndpoint, send: (connId: string) => Promise<unknown>): void => {
		if (typeof endpoint.connId !== 'string') return;
		void send(endpoint.connId).catch(() => undefined);
	};
	const edit = (endpoint: SqlEndpoint, change: HistoryEdit): void => write(endpoint, (connId) => caller.callReply('sql.historyEdit', { connId, edit: change, owner: owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyEdit'] }));

	return {
		useHistory(endpoint) {
			// The epoch moves on a reset, so a reset view reads the entries again.
			const seen = useSyncExternalStore(subscribe, () => epoch);
			useEffect(() => { watch(endpoint); }, [endpoint, seen]);
			return useSyncExternalStore(subscribe, () => read.get(endpoint.key)?.entries ?? NO_ENTRIES);
		},
		useRecording(endpoint) {
			const seen = useSyncExternalStore(subscribe, () => epoch);
			useEffect(() => { watch(endpoint); }, [endpoint, seen]);
			// While a key is between being dropped and read again, the last switch seen stands.
			return useSyncExternalStore(subscribe, () => state?.keys?.[endpoint.key]?.recording ?? read.get(endpoint.key)?.recording ?? true);
		},
		usePrivacyNotice() {
			return useSyncExternalStore(subscribe, () => devToolPrivacyNotice(state?.storage ?? 'none'));
		},
		record: (endpoint, entry) => write(endpoint, (connId) => caller.callReply('sql.historyRecord', { connId, entry: jsonEntry(entry), owner: owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] })),
		removeEntry: (endpoint, id) => edit(endpoint, { action: 'remove', id }),
		togglePin: (endpoint, id) => edit(endpoint, { action: 'pin', id }),
		setNote: (endpoint, id, note) => edit(endpoint, { action: 'note', id, note }),
		clearForKey: (endpoint) => edit(endpoint, { action: 'clear' }),
		setRecording: (endpoint, on) => edit(endpoint, { action: 'recording', on }),
		watch,
		entriesOf: (endpoint) => read.get(endpoint.key)?.entries ?? NO_ENTRIES,
		reset() {
			epoch += 1;
			read.clear();
			notify();
		},
		dispose() {
			offState();
			offIdentity();
			read.clear();
			listeners.clear();
		},
	};
}
