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
// SCHEMA STORE — per-connection schema snapshots (App + Sidebar shared state)
// =============================================================================
//
// Module-level store (admin-ui navigation pattern): the shell mounts App and
// Sidebar as siblings, so snapshots live here for both to subscribe to.
// Sessions are cached per endpoint; all database traffic goes through the
// connect/ layer's ISqlSession — never through client.tool directly.
// =============================================================================

import { useSyncExternalStore } from 'react';
import type { RocketRideClient } from 'shell';
import type { ISqlEndpoint, ISqlSchemaResponse, ISqlSession, SqlDialect } from '../connect';
import { createSqlSession } from '../connect';

// =============================================================================
// STATE
// =============================================================================

/** Snapshot lifecycle for one connection's schema. */
export type SchemaStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * What this session has learned about the node's `refresh_schema` tool.
 *
 * `unknown` until a fresh refresh is attempted. A fallback is NOT proof that
 * the tool is missing — a restarted task and a timed-out call look exactly
 * like a node too old to have it — so one fallback only makes the tool
 * `suspect` and a SECOND CONSECUTIVE one latches `unavailable`, after which
 * later refreshes skip the doomed call instead of paying for it every time.
 * Any fresh refresh that actually answers clears the suspicion.
 */
export type RefreshToolState = 'unknown' | 'available' | 'suspect' | 'unavailable';

/** One connection's schema snapshot. */
export interface ISchemaState {
	/** Snapshot lifecycle state. */
	status: SchemaStatus;
	/** The reflected schema (null until the first refresh completes). */
	schema: ISqlSchemaResponse | null;
	/** Engine dialect reported alongside the snapshot ('unknown' until read). */
	dialect: SqlDialect;
	/** Failure detail when status is 'error'. */
	error: string | null;
	/** Unix ms of the last successful refresh (0 = never). */
	refreshedAt: number;
	/**
	 * True when the snapshot came from the node's task-start reflection and
	 * may not reflect DDL run since — either because the caller asked for an
	 * ordinary read, or because a `fresh` refresh fell back (the node has no
	 * usable `refresh_schema` tool). Views that just applied DDL should say so.
	 */
	stale: boolean;
	/** What this session knows about the node's `refresh_schema` tool. */
	refreshTool: RefreshToolState;
}

/** The idle placeholder returned for connections with no snapshot yet. */
const IDLE_SCHEMA: ISchemaState = {
	status: 'idle',
	schema: null,
	dialect: 'unknown',
	error: null,
	refreshedAt: 0,
	stale: false,
	refreshTool: 'unknown',
};

// ── Module-level state ───────────────────────────────────────────────────────

let snapshots: Record<string, ISchemaState> = {};
const listeners = new Set<() => void>();

// Session cache per endpoint key, tied to the client that created it so a
// reconnect (new client instance) transparently rebuilds sessions.
const sessions = new Map<string, { client: RocketRideClient; session: ISqlSession }>();

/**
 * Replace one connection's snapshot and notify subscribers.
 *
 * @param key - The endpoint key.
 * @param next - The new snapshot for that key.
 */
function setSnapshot(key: string, next: ISchemaState): void {
	snapshots = { ...snapshots, [key]: next };
	listeners.forEach((fn) => fn());
}

// =============================================================================
// SESSIONS
// =============================================================================

/**
 * Get (or lazily create) the cached session for an endpoint.
 *
 * @param client - The shell's RocketRide client.
 * @param endpoint - The endpoint to bind.
 * @returns The cached or freshly created session.
 */
export function getSession(client: RocketRideClient, endpoint: ISqlEndpoint): ISqlSession {
	const cached = sessions.get(endpoint.key);
	if (cached && cached.client === client) return cached.session;
	const session = createSqlSession(client, endpoint);
	sessions.set(endpoint.key, { client, session });
	return session;
}

// =============================================================================
// ACTIONS
// =============================================================================

/** The refresh currently running for a connection, and how strong it is. */
const inFlight = new Map<string, { promise: Promise<void>; fresh: boolean }>();

/**
 * Refresh one connection's schema snapshot (dialect + full reflection).
 *
 * Concurrent refreshes of the same connection are SERIALISED rather than
 * dropped: a caller always gets back a promise that settles when a read at
 * least as strong as the one it asked for has landed. An ordinary read joins
 * whatever is running, but a `fresh` request cannot be answered by a plain
 * re-read, so it queues behind the active refresh and then runs its own —
 * the post-DDL path must never be told "already refreshing" and carry on
 * describing the change against the pre-DDL snapshot.
 *
 * The node reflects once at task start, so an ordinary refresh re-reads that
 * same snapshot: it is a cheap way to recover from a transient failure, not a
 * way to see DDL. Pass `fresh` after applying DDL to make the node re-reflect
 * — the resulting snapshot carries {@link ISchemaState.stale} when the call
 * fell back to the task-start reflection.
 *
 * @param client - The shell's RocketRide client.
 * @param endpoint - The connection's endpoint.
 * @param opts - Optional refresh options.
 * @param opts.fresh - Re-reflect the database rather than re-reading the
 *                     task-start snapshot.
 * @returns A promise that settles once the requested read has landed.
 */
export function refreshSchema(client: RocketRideClient, endpoint: ISqlEndpoint, opts?: { fresh?: boolean }): Promise<void> {
	const key = endpoint.key;
	const fresh = opts?.fresh === true;
	const active = inFlight.get(key);

	// Joining is only honest when the active refresh answers this caller too.
	if (active && (!fresh || active.fresh)) return active.promise;

	const run = (): Promise<void> => runRefresh(client, endpoint, fresh);
	const promise: Promise<void> = (active ? active.promise.then(run, run) : run()).finally(() => {
		// Only the entry this call installed may be cleared: a later refresh
		// that queued behind it owns the slot by then.
		if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
	});
	inFlight.set(key, { promise, fresh });
	return promise;
}

/**
 * Perform one refresh. Never rejects: a failure lands in the snapshot's
 * error field, which is what every view reads.
 *
 * @param client - The shell's RocketRide client.
 * @param endpoint - The connection's endpoint.
 * @param fresh - Whether to ask the node to re-reflect the database.
 */
async function runRefresh(client: RocketRideClient, endpoint: ISqlEndpoint, fresh: boolean): Promise<void> {
	const current = snapshots[endpoint.key] ?? IDLE_SCHEMA;
	setSnapshot(endpoint.key, { ...current, status: 'loading', error: null });

	try {
		const session = getSession(client, endpoint);
		// Dialect first (cheap), then the full reflection.
		const dialect = await session.dialect();

		// A fresh refresh is attempted while the tool might exist. The latch
		// takes TWO consecutive fallbacks (see RefreshToolState): one is as
		// likely to be a restarted task or a timed-out call as a missing tool,
		// and latching on it would make every later Refresh Schema, Reverse
		// Engineer and post-DDL read serve the task-start snapshot for the
		// rest of the app session.
		const attemptFresh = fresh && current.refreshTool !== 'unavailable';
		const schema = attemptFresh ? await session.refreshSchema() : await session.getSchema();
		if (schema.error) {
			setSnapshot(endpoint.key, { ...current, status: 'error', dialect, error: schema.error });
			return;
		}

		// `stale` on the response is the session's own report that it fell
		// back — the only signal used here. No error text is inspected.
		const refreshTool: RefreshToolState = attemptFresh
			? (schema.stale === true
				? (current.refreshTool === 'suspect' ? 'unavailable' : 'suspect')
				: 'available')
			: current.refreshTool;

		// A plain read serves the task-start snapshot by construction; a fresh
		// one is current only when the refresh tool actually answered.
		setSnapshot(endpoint.key, {
			status: 'ready',
			schema,
			dialect,
			error: null,
			refreshedAt: Date.now(),
			stale: attemptFresh ? schema.stale === true : true,
			refreshTool,
		});
	} catch (err) {
		setSnapshot(endpoint.key, { ...current, status: 'error', error: err instanceof Error ? err.message : String(err) });
	}
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Register a store listener. Hoisted to module level so useSyncExternalStore
 * receives a STABLE reference — one subscription per component, not one
 * resubscribe per render.
 *
 * @param cb - The change callback.
 * @returns The unsubscribe function.
 */
function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	return () => { listeners.delete(cb); };
}

/**
 * Subscribe to one connection's schema snapshot.
 *
 * @param key - The endpoint key (null returns the idle placeholder).
 * @returns The snapshot for that connection.
 */
export function useSchema(key: string | null): ISchemaState {
	return useSyncExternalStore(
		subscribe,
		() => (key ? snapshots[key] ?? IDLE_SCHEMA : IDLE_SCHEMA),
	);
}
