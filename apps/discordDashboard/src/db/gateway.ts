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
// THE GATEWAY — one task, one statement at a time, two verbs
// =============================================================================
//
// `useDbGateway` owns the data pipe's task and turns it into `exec` and `tx`.
// Everything above it (`repo.ts`, `useDashboardData.ts`) writes SQL and never
// thinks about tasks, tokens or tools again.
//
// ONE TASK, SHARED. The start passes `useExisting: true` and `ttl: 0`, like
// the bot's own: a second viewer, or this viewer after a reload, finds the
// task that is already there instead of starting a second pool of database
// connections. The task is terminated and restarted only when the CONNECTION
// changes mid-session — a task born on one database cannot be re-pointed at
// another.
//
// ONE STATEMENT AT A TIME. Every call goes through a promise chain, so two
// screens writing at once queue instead of interleaving. It costs latency
// nobody can feel (these are millisecond statements against a local
// database) and it buys the one thing that matters: a `begin` is never
// overtaken by someone else's `execute` on the same pooled instance.
//
// THE STATUS IS LIVE. `ready` is not "it started once": a statement that
// fails sets `error` and the last reason, and the next statement that
// succeeds clears it. That is what the top-of-app banner reads, and it is why
// stopping the container shows up in the UI within one poll rather than at
// the next reload.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShellConnection } from 'shell';
import type { PipelineConfig } from 'shell';
import { connectionKey, DATA_NODE_ID, DATA_SOURCE, DATA_TASK_NAME, dataPipeline, type DbConnection } from './config';
import { ensureSchema } from './schema';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * How long one `execute` may take before the call is abandoned (ms).
 *
 * Explicit rather than the client's own default: these are small statements
 * against a database that is either there or is not, and a request with no
 * budget turns "the container is stopped" into a screen that waits forever
 * instead of a banner that says so.
 */
export const TOOL_TIMEOUT_MS = 30_000;

/** The reason given when a call is made before the task exists. */
export const NOT_CONNECTED = 'The dashboard database is not connected yet.';

// =============================================================================
// TYPES
// =============================================================================

/** One row of a result set, as the `execute` tool shapes it. */
export type DbRow = Record<string, unknown>;

/** Run one statement and get its rows. */
export type Exec = (sql: string, params?: unknown[]) => Promise<DbRow[]>;

/** Where the gateway is. */
export type DbStatus = 'connecting' | 'ready' | 'error';

/** How often an errored gateway re-probes the database. */
export const RECOVERY_MS = 10_000;

/** What {@link useDbGateway} hands back. */
export interface DbGateway {
	/** Coarse state, for the banner and for disabling writes. */
	status: DbStatus;
	/** The last failure's text, or null. */
	error: string | null;
	/** Run one statement outside a transaction. */
	exec: Exec;
	/**
	 * Run several statements in one transaction.
	 *
	 * The callback is handed an {@link Exec} bound to the session; a throw
	 * rolls back, a return commits. Nothing else may run in between — the
	 * whole transaction holds the gateway's queue.
	 */
	tx: <T>(fn: (exec: Exec) => Promise<T>) => Promise<T>;
}

// =============================================================================
// HELPERS
// =============================================================================

/** The message of an unknown throw, never an empty string. */
export function reasonOf(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	const text = String(err ?? '');
	return text.length > 0 ? text : 'The database gave no reason.';
}

/** The rows out of an `execute` result, tolerating a shape with none. */
function rowsOf(result: unknown): DbRow[] {
	if (result === null || typeof result !== 'object') return [];
	const rows = (result as { rows?: unknown }).rows;
	return Array.isArray(rows) ? (rows as DbRow[]) : [];
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Own the data pipe and expose the database as two functions.
 *
 * @param conn - Where the database is, from the manifest settings.
 * @param enabled - False in sample-data mode: no call leaves the browser and
 *        the status says why.
 * @returns The gateway — see {@link DbGateway}.
 */
export function useDbGateway(conn: DbConnection, enabled: boolean): DbGateway {
	const { client, isConnected } = useShellConnection();
	const [status, setStatus] = useState<DbStatus>('connecting');
	const [error, setError] = useState<string | null>(null);
	// Bumped by the recovery loop when the data pipe itself never started, so the
	// task effect below runs again.
	const [attempt, setAttempt] = useState(0);

	// The live task token, and the connection it was started for. Refs, not
	// state: every caller below closes over them once, and a render is not
	// what should decide whether a statement can run.
	const tokenRef = useRef<string | null>(null);
	const keyRef = useRef<string | null>(null);
	// The queue. `then(run, run)` rather than `then(run)`: a rejected
	// predecessor must not stop the next statement from being sent.
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	// What `status` holds, readable from inside a callback.
	const statusRef = useRef<DbStatus>('connecting');
	const key = connectionKey(conn);

	/** Put one unit of work on the queue. */
	const serialize = useCallback(<T>(run: () => Promise<T>): Promise<T> => {
		const next = queue.current.then(run, run);
		queue.current = next.catch(() => undefined);
		return next;
	}, []);

	/** Report a statement's outcome on the status, without re-rendering for nothing. */
	const settle = useCallback((failure: string | null): void => {
		const next: DbStatus = failure === null ? 'ready' : 'error';
		if (statusRef.current === next && failure === null) return;
		statusRef.current = next;
		setStatus(next);
		setError(failure);
	}, []);

	/** One tool call against the data pipe's database component. */
	const invoke = useCallback(
		async <T>(tool: string, input: Record<string, unknown>): Promise<T> => {
			const token = tokenRef.current;
			if (!client || token === null) throw new Error(NOT_CONNECTED);
			return client.tool<T>({
				token,
				tool,
				nodeId: DATA_NODE_ID,
				input,
				timeout: TOOL_TIMEOUT_MS,
			});
		},
		[client]
	);

	/**
	 * One statement, off the queue.
	 *
	 * `params` is omitted entirely when there are none: the server skips the
	 * `$n` rewrite for an absent or empty list, so a statement with a literal
	 * `$1` in a string reaches the driver unchanged.
	 */
	const send = useCallback(
		async (sql: string, params?: unknown[], sessionId?: string): Promise<DbRow[]> => {
			const input: Record<string, unknown> = { sql };
			if (params !== undefined && params.length > 0) input.params = params;
			if (sessionId !== undefined) input.session_id = sessionId;
			try {
				const result = await invoke<unknown>('execute', input);
				settle(null);
				return rowsOf(result);
			} catch (err) {
				settle(reasonOf(err));
				throw err;
			}
		},
		[invoke, settle]
	);

	const exec = useCallback<Exec>((sql, params) => serialize(() => send(sql, params)), [serialize, send]);

	const tx = useCallback(
		<T>(fn: (sessionExec: Exec) => Promise<T>): Promise<T> =>
			// The WHOLE transaction is one queue entry: `send` is called directly
			// inside it rather than through `exec`, which would deadlock on the
			// queue this entry is holding.
			serialize(async () => {
				const begun = await invoke<{ session_id?: string }>('begin', {});
				const sessionId = typeof begun?.session_id === 'string' ? begun.session_id : '';
				if (sessionId.length === 0) throw new Error('The database did not open a transaction.');
				try {
					const result = await fn((sql, params) => send(sql, params, sessionId));
					await invoke('commit', { session_id: sessionId });
					return result;
				} catch (err) {
					// Best effort: a session the reaper already took must not turn a
					// failed statement into a second, more confusing failure.
					await invoke('rollback', { session_id: sessionId }).catch(() => undefined);
					throw err;
				}
			}),
		[serialize, invoke, send]
	);

	// --- The task -------------------------------------------------------------

	useEffect(() => {
		if (!enabled) {
			tokenRef.current = null;
			statusRef.current = 'ready';
			setStatus('ready');
			setError(null);
			return;
		}
		if (!client || !isConnected) {
			tokenRef.current = null;
			statusRef.current = 'connecting';
			setStatus('connecting');
			return;
		}

		let alive = true;
		// A task started for a DIFFERENT connection is not re-pointable: the
		// node read its host and credentials when the pipeline instance was
		// built. Only a changed key terminates — a reconnect reattaches.
		const stale = keyRef.current !== null && keyRef.current !== key ? tokenRef.current : null;
		keyRef.current = key;
		tokenRef.current = null;
		statusRef.current = 'connecting';
		setStatus('connecting');
		setError(null);

		void (async () => {
			try {
				if (stale !== null) await client.terminate(stale).catch(() => undefined);
				const started = await client.use({
					pipeline: dataPipeline(conn) as unknown as PipelineConfig,
					source: DATA_SOURCE,
					useExisting: true,
					// ttl 0 = no idle timeout. The dashboard is open for hours.
					ttl: 0,
					name: DATA_TASK_NAME,
				});
				if (!alive) return;
				tokenRef.current = started.token;
				// The schema runs on the queue, so the first real statement from
				// `useDashboardData` cannot overtake the CREATE TABLE it needs.
				await serialize(() => ensureSchema((sql) => send(sql)));
				if (!alive) return;
				statusRef.current = 'ready';
				setStatus('ready');
				setError(null);
			} catch (err) {
				if (!alive) return;
				tokenRef.current = null;
				statusRef.current = 'error';
				setStatus('error');
				setError(reasonOf(err));
			}
		})();

		return () => {
			alive = false;
		};
		// `conn` is read, not tracked: `key` IS its identity, and the object is
		// rebuilt on every render of the app root.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, client, isConnected, key, serialize, send, attempt]);

	// --- Recovery -------------------------------------------------------------

	// An error is not terminal. The dashboard stops polling while the gateway
	// reports `error`, so without this nothing would ever send the statement
	// that could clear it, and a database that came back would stay "down"
	// until a reload. Every RECOVERY_MS: re-probe with a trivial statement when
	// the data pipe is up, or start the data pipe again when it never was.
	useEffect(() => {
		if (!enabled || status !== 'error') return;
		const timer = setInterval(() => {
			if (tokenRef.current === null) {
				setAttempt((value) => value + 1);
				return;
			}
			void serialize(() => send('SELECT 1')).catch(() => undefined);
		}, RECOVERY_MS);
		return () => clearInterval(timer);
	}, [enabled, status, serialize, send]);

	return { status, error, exec, tx };
}
