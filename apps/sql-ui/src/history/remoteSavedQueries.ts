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
// SAVED QUERIES — A FRAME'S VIEW OF THE CONTROLLER'S
// =============================================================================
//
// In a dev tool the controller owns saved queries (sqlController.ts,
// history/savedQueriesFile.ts). A frame:
//
//   reads    a connection's list with `sql.savedQueries` (an op result,
//            which also says where they are kept), on first use and again
//            whenever the retained `savedQueries` topic's revision moves on
//            (another document saved one, the account changed);
//   writes   through `sql.savedQueryEdit` only, carrying the identity the
//            frame belongs to; the controller refuses a write for anyone
//            else, and a refusal (a cap, a query gone) reaches the caller.
//
// THE LATEST READ WINS. Every read is sent (none waits for another in
// flight) and only the answer to the newest one is used: a read that is
// never answered (its controller went away) cannot hold back the next, and
// an older answer that arrives late cannot replace a newer one. Until the
// first answer the view says it is loading; a failed read says why, and
// `retry` reads again.
//
// Without the frame's channel the view still works, reading again after its
// own changes only. Nothing here touches the shell's preferences.
// =============================================================================

import { useEffect, useSyncExternalStore } from 'react';
import type { TypedToolChannel } from 'shell';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import type { SqlEndpoint } from '../connect';
import type { SavedQueriesState, SqlEventMap, SqlOps, SqlStateMap } from '../ops';
import { SQL_OP_TIMEOUT_MS } from '../sqlTimeouts';
import { devToolSavedQueriesNotice } from './savedQueries';
import type { SavedQueriesReadState, SavedQueriesStorage, SavedQuery, SavedQueryEdit, SqlSavedQueriesApi } from './savedQueries';

/** Shared empty list, so an unread connection keeps a stable snapshot. */
const NO_QUERIES: SavedQuery[] = [];

/** The read states with nothing to say (shared, so snapshots stay stable). */
const LOADING: SavedQueriesReadState = { status: 'loading' };
const READY: SavedQueriesReadState = { status: 'ready' };

/** A frame's saved-queries view, with its lifetime. */
export interface RemoteSavedQueries extends SqlSavedQueriesApi {
	/** Start following one connection outside React (the hook calls it from an effect). */
	watch(endpoint: SqlEndpoint): void;
	/** One connection's queries as last read (outside React). */
	entriesOf(endpoint: SqlEndpoint): SavedQuery[];
	/** Where reading one connection's queries stands (outside React). */
	readStateOf(endpoint: SqlEndpoint): SavedQueriesReadState;
	/** Whether one connection's queries have been read (outside React). */
	loaded(endpoint: SqlEndpoint): boolean;
	/** The privacy line as of the last answer ('' before the controller said where they are kept; outside React). */
	privacyNotice(): string;
	/** Forget everything read (identity change, sign-out, a dropped connection). */
	reset(): void;
	/** Stop following the channel. */
	dispose(): void;
}

/** What {@link createRemoteSavedQueries} needs. */
export interface RemoteSavedQueriesOptions {
	/** The frame's caller. */
	caller: IFrameCaller<SqlOps>;
	/** The identity fingerprint the frame belongs to (sent with every call). */
	owner: () => string | null;
	/** The frame's channel, to follow the controller's revision (without it: reads again after its own changes only). */
	channel?: TypedToolChannel<SqlStateMap, SqlEventMap>;
}

/** What the view holds for one connection. */
interface Slot {
	endpoint: SqlEndpoint;
	queries: SavedQuery[];
	/** The revision the last read answered for (null: not read yet). */
	rev: number | null;
	loaded: boolean;
	/** The newest read sent: only its answer is used. */
	seq: number;
	/** Where reading stands. */
	readState: SavedQueriesReadState;
}

/**
 * Build a frame's saved-queries view over its controller.
 *
 * @param opts - See {@link RemoteSavedQueriesOptions}.
 * @returns The view; dispose it with the frame.
 */
export function createRemoteSavedQueries(opts: RemoteSavedQueriesOptions): RemoteSavedQueries {
	const { caller, owner, channel } = opts;
	const read = new Map<string, Slot>();
	let state: SavedQueriesState | undefined;
	/** Where they are kept, as the last answer or the topic said (the topic wins once it is heard). */
	let storage: SavedQueriesStorage | null = null;
	let epoch = 0;
	const listeners = new Set<() => void>();
	const notify = (): void => listeners.forEach((listener) => listener());
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	};

	/**
	 * Read one connection's queries from the controller.
	 *
	 * @param key - The endpoint key.
	 */
	const fetch = (key: string): void => {
		const slot = read.get(key);
		if (!slot || typeof slot.endpoint.connId !== 'string') return;
		slot.seq += 1;
		const seq = slot.seq;
		const asked = epoch;
		const rev = state?.rev ?? null;
		// Only the newest read of a view that was not reset since counts.
		const current = (): boolean => asked === epoch && read.get(key) === slot && seq === slot.seq;
		caller.callReply('sql.savedQueries', { connId: slot.endpoint.connId, owner: owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueries'] })
			.then((answer) => {
				if (!current()) return;
				slot.queries = Array.isArray(answer?.queries) ? answer.queries : NO_QUERIES;
				slot.rev = rev;
				slot.loaded = true;
				slot.readState = READY;
				if (state === undefined && typeof answer?.storage === 'string') storage = answer.storage;
				notify();
			})
			.catch((error: unknown) => {
				if (!current()) return;
				slot.readState = { status: 'failed', message: error instanceof Error ? error.message : String(error) };
				notify();
			});
	};

	const offState = channel?.onState('savedQueries', (snapshot) => {
		state = snapshot;
		if (snapshot) storage = snapshot.storage;
		for (const [key, slot] of read) {
			// The revision moved on, or a read that failed (nobody was vouched
			// for yet) can now succeed.
			if (snapshot && snapshot.storage !== 'none' && (snapshot.rev !== slot.rev || !slot.loaded)) fetch(key);
		}
		notify();
	});

	// A read refused because the frame had not yet learnt its account is tried
	// again once the controller vouches for one.
	const offIdentity = channel?.onState('identity', (snapshot) => {
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { fingerprint?: unknown }).fingerprint : undefined;
		if (typeof value !== 'string' || value === '') return;
		for (const [key, slot] of read) {
			if (!slot.loaded) fetch(key);
		}
	});

	/**
	 * Start following one connection (first use reads its queries).
	 *
	 * @param endpoint - The connection's endpoint.
	 */
	const watch = (endpoint: SqlEndpoint): void => {
		if (read.has(endpoint.key)) return;
		read.set(endpoint.key, { endpoint, queries: NO_QUERIES, rev: null, loaded: false, seq: 0, readState: LOADING });
		fetch(endpoint.key);
	};

	/**
	 * Read one connection again (the drawer's Retry).
	 *
	 * @param endpoint - The connection.
	 */
	const retry = (endpoint: SqlEndpoint): void => {
		const slot = read.get(endpoint.key);
		if (!slot) {
			watch(endpoint);
			return;
		}
		if (!slot.loaded) slot.readState = LOADING;
		notify();
		fetch(endpoint.key);
	};

	/**
	 * Send one change and read the connection again; a refusal reaches the caller.
	 *
	 * @param endpoint - The connection.
	 * @param change - The change.
	 */
	const edit = async (endpoint: SqlEndpoint, change: SavedQueryEdit): Promise<void> => {
		if (typeof endpoint.connId !== 'string') throw new TypeError(`The endpoint '${endpoint.key}' carries no connection id.`);
		await caller.callReply('sql.savedQueryEdit', { connId: endpoint.connId, edit: change, owner: owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueryEdit'] });
		fetch(endpoint.key);
	};

	// Nothing until the controller has said where they are kept (never a guess).
	const notice = (): string => (storage === null ? '' : devToolSavedQueriesNotice(storage));

	return {
		useSavedQueries(endpoint) {
			// The epoch moves on a reset, so a reset view reads the queries again.
			const seen = useSyncExternalStore(subscribe, () => epoch);
			useEffect(() => { watch(endpoint); }, [endpoint, seen]);
			return useSyncExternalStore(subscribe, () => read.get(endpoint.key)?.queries ?? NO_QUERIES);
		},
		useReadState(endpoint) {
			const seen = useSyncExternalStore(subscribe, () => epoch);
			useEffect(() => { watch(endpoint); }, [endpoint, seen]);
			return useSyncExternalStore(subscribe, () => read.get(endpoint.key)?.readState ?? LOADING);
		},
		retry,
		usePrivacyNotice() {
			return useSyncExternalStore(subscribe, notice);
		},
		save: (endpoint, query) => edit(endpoint, { action: 'add', query }),
		rename: (endpoint, id, name) => edit(endpoint, { action: 'rename', id, name }),
		remove: (endpoint, id) => edit(endpoint, { action: 'remove', id }),
		watch,
		entriesOf: (endpoint) => read.get(endpoint.key)?.queries ?? NO_QUERIES,
		loaded: (endpoint) => read.get(endpoint.key)?.loaded === true,
		readStateOf: (endpoint) => read.get(endpoint.key)?.readState ?? LOADING,
		privacyNotice: notice,
		reset() {
			epoch += 1;
			read.clear();
			notify();
		},
		dispose() {
			offState?.();
			offIdentity?.();
			read.clear();
			listeners.clear();
		},
	};
}
