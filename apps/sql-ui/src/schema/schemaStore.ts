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
// All database traffic arrives as an SqlSession (local or controller-backed
// — this store neither knows nor cares which): callers obtain the session
// from their SqlEnv and hand it in. No RocketRide client in here.
// =============================================================================

import { useSyncExternalStore } from 'react';
import type { SqlSchemaResponse, SqlSession, SqlDialect } from '../connect';
import { describeFailure } from '../sql/failure';

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

/**
 * Whether the node will run statements, as far as this session knows.
 *
 * `unknown` until a statement (or the open-time probe) answers; controls stay
 * enabled while it is unknown, so a probe still in flight never disables
 * anything. `off` means the node refused with its `allow_execute` message, and
 * since that gate covers reads too, it means the connection is schema only.
 */
export type ExecuteState = 'unknown' | 'on' | 'off';

/** One connection's schema snapshot. */
export interface SchemaState {
	/** Snapshot lifecycle state. */
	status: SchemaStatus;
	/** The reflected schema (null until the first refresh completes). */
	schema: SqlSchemaResponse | null;
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
	/** Whether the node will run statements (see {@link ExecuteState}). */
	executeState: ExecuteState;
}

/** The idle placeholder returned for connections with no snapshot yet. */
const IDLE_SCHEMA: SchemaState = {
	status: 'idle',
	schema: null,
	dialect: 'unknown',
	error: null,
	refreshedAt: 0,
	stale: false,
	refreshTool: 'unknown',
	executeState: 'unknown',
};

// ── Module-level state ───────────────────────────────────────────────────────

let snapshots: Record<string, SchemaState> = {};
const listeners = new Set<() => void>();

/**
 * Replace one connection's snapshot and notify subscribers.
 *
 * @param key - The endpoint key.
 * @param next - The new snapshot for that key.
 */
function setSnapshot(key: string, next: SchemaState): void {
	snapshots = { ...snapshots, [key]: next };
	listeners.forEach((fn) => fn());
}

// =============================================================================
// ACTIONS
// =============================================================================

/** The refresh currently running for a connection, and how strong it is. */
const inFlight = new Map<string, { promise: Promise<void>; fresh: boolean }>();

// A change of signed-in account clears it all (clearSchemas, called from
// identityScope.ts in the full app and from a frame's identity guard), reads
// in flight included. Bumped by clearSchemas(): a refresh started under an
// older generation belongs to a forgotten account, and its late answer is
// dropped.
let generation = 0;

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
 * — the resulting snapshot carries {@link SchemaState.stale} when the call
 * fell back to the task-start reflection.
 *
 * @param session - The connection's session (from the caller's SqlEnv).
 * @param opts - Optional refresh options.
 * @param opts.fresh - Re-reflect the database rather than re-reading the
 *                     task-start snapshot.
 * @returns A promise that settles once the requested read has landed.
 */
export function refreshSchema(session: SqlSession, opts?: { fresh?: boolean }): Promise<void> {
	const key = session.endpoint.key;
	const fresh = opts?.fresh === true;
	const active = inFlight.get(key);

	// Joining is only honest when the active refresh answers this caller too.
	if (active && (!fresh || active.fresh)) return active.promise;

	// The generation this request was made in: a refresh queued behind the
	// active one may only start after clearSchemas(), and must not then run.
	const startedIn = generation;
	const run = (): Promise<void> => runRefresh(session, fresh, startedIn);
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
 * error field, which is what every view reads. Nothing is written once
 * {@link clearSchemas} has run since the refresh was asked for: the answer
 * belongs to the account that was signed in then.
 *
 * @param session - The connection's session.
 * @param fresh - Whether to ask the node to re-reflect the database.
 * @param startedIn - The store generation the refresh was asked for in.
 */
async function runRefresh(session: SqlSession, fresh: boolean, startedIn: number): Promise<void> {
	if (startedIn !== generation) return;
	const endpoint = session.endpoint;
	const current = snapshots[endpoint.key] ?? IDLE_SCHEMA;
	// The execute state is learned outside a refresh, so a refresh that took
	// a while keeps whatever was learned meanwhile rather than its start copy.
	const land = (next: SchemaState): void => {
		if (startedIn !== generation) return;
		setSnapshot(endpoint.key, { ...next, executeState: (snapshots[endpoint.key] ?? IDLE_SCHEMA).executeState });
	};
	land({ ...current, status: 'loading', error: null });

	try {
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
			land({ ...current, status: 'error', dialect, error: schema.error });
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
		land({
			status: 'ready',
			schema,
			dialect,
			error: null,
			refreshedAt: Date.now(),
			stale: attemptFresh ? schema.stale === true : true,
			refreshTool,
			executeState: current.executeState,
		});
	} catch (err) {
		land({ ...current, status: 'error', error: err instanceof Error ? err.message : String(err) });
	}
}

// =============================================================================
// EXECUTE STATE
// =============================================================================

/**
 * What a statement failure says about whether the node runs statements.
 *
 * @param message - The failure text as the node reported it.
 * @param current - The state before this failure.
 * @returns `off` for the node's `allow_execute` refusal; `current` for any
 *          other failure (a syntax error says nothing about the gate).
 */
export function executeStateFromFailure(message: string, current: ExecuteState): ExecuteState {
	return describeFailure(message).allowExecuteOff ? 'off' : current;
}

/**
 * Record a new execute state for a connection, if it is a change.
 *
 * @param key - The endpoint key.
 * @param state - The state to record.
 */
function setExecuteState(key: string, state: ExecuteState): void {
	const current = snapshots[key] ?? IDLE_SCHEMA;
	if (current.executeState !== state) setSnapshot(key, { ...current, executeState: state });
}

/**
 * A statement ran on this connection: the node's execute gate is open.
 *
 * @param key - The endpoint key.
 */
export function noteExecuteSuccess(key: string): void {
	setExecuteState(key, 'on');
}

/**
 * A statement failed on this connection; the state changes only when the
 * failure is the node's `allow_execute` refusal.
 *
 * @param key - The endpoint key.
 * @param message - The failure text as the node reported it.
 */
export function noteExecuteFailure(key: string, message: string): void {
	const current = snapshots[key] ?? IDLE_SCHEMA;
	setExecuteState(key, executeStateFromFailure(message, current.executeState));
}

/**
 * Find out once, on open, whether the node runs statements: send `SELECT 1`.
 *
 * It goes straight through the session, not through the query runner, so it
 * is never recorded in history. It is a read, so it opts in to the session's
 * one retry. Any failure other than the `allow_execute` refusal (a task that
 * is restarting, a timeout) leaves the state `unknown`, which keeps every
 * control enabled. The answer of a probe that was running when
 * {@link clearSchemas} ran belongs to a forgotten account and is dropped.
 *
 * @param session - The connection's session.
 */
export async function probeExecute(session: SqlSession): Promise<void> {
	const key = session.endpoint.key;
	const startedIn = generation;
	try {
		await session.execute('SELECT 1', { idempotent: true });
		if (startedIn === generation) noteExecuteSuccess(key);
	} catch (err) {
		if (startedIn === generation) noteExecuteFailure(key, err instanceof Error ? err.message : String(err));
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
export function useSchema(key: string | null): SchemaState {
	return useSyncExternalStore(subscribe, () => schemaSnapshot(key));
}

/**
 * Subscribe to one connection's execute state.
 *
 * @param key - The endpoint key (null returns `unknown`).
 * @returns The state for that connection.
 */
export function useExecuteState(key: string | null): ExecuteState {
	return useSyncExternalStore(subscribe, () => schemaSnapshot(key).executeState);
}

/**
 * How many times the store has been cleared. A view that probes once per open
 * probes again when this moves: a clear forgets what the probe learned.
 *
 * @returns The current generation.
 */
export function schemaGeneration(): number {
	return generation;
}

/**
 * Subscribe to {@link schemaGeneration}.
 *
 * @returns The current generation.
 */
export function useSchemaGeneration(): number {
	return useSyncExternalStore(subscribe, schemaGeneration);
}

/**
 * Read one connection's schema snapshot outside React.
 *
 * @param key - The endpoint key (null returns the idle placeholder).
 * @returns The snapshot for that connection.
 */
export function schemaSnapshot(key: string | null): SchemaState {
	return key ? snapshots[key] ?? IDLE_SCHEMA : IDLE_SCHEMA;
}

// =============================================================================
// CLEAR
// =============================================================================

/**
 * Forget every connection's schema snapshot and refresh in flight. Called
 * when the signed-in account changes or can no longer be vouched for: the
 * snapshots describe the previous account's databases, and a refresh still
 * running for it lands nowhere (see {@link runRefresh}).
 */
export function clearSchemas(): void {
	generation += 1;
	snapshots = {};
	inFlight.clear();
	listeners.forEach((fn) => fn());
}
