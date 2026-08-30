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
}

/** The idle placeholder returned for connections with no snapshot yet. */
const IDLE_SCHEMA: ISchemaState = { status: 'idle', schema: null, dialect: 'unknown', error: null, refreshedAt: 0 };

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

/**
 * Refresh one connection's schema snapshot (dialect + full reflection).
 * Concurrent refreshes of the same connection are collapsed by the loading
 * gate; failures land in the snapshot's error field.
 *
 * @param client - The shell's RocketRide client.
 * @param endpoint - The connection's endpoint.
 */
export async function refreshSchema(client: RocketRideClient, endpoint: ISqlEndpoint): Promise<void> {
	const current = snapshots[endpoint.key] ?? IDLE_SCHEMA;
	if (current.status === 'loading') return;
	setSnapshot(endpoint.key, { ...current, status: 'loading', error: null });

	try {
		const session = getSession(client, endpoint);
		// Dialect first (cheap), then the full reflection.
		const dialect = await session.dialect();
		const schema = await session.getSchema();
		if (schema.error) {
			setSnapshot(endpoint.key, { ...current, status: 'error', dialect, error: schema.error });
			return;
		}
		setSnapshot(endpoint.key, { status: 'ready', schema, dialect, error: null, refreshedAt: Date.now() });
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
	return () => {
		listeners.delete(cb);
	};
}

/**
 * Subscribe to one connection's schema snapshot.
 *
 * @param key - The endpoint key (null returns the idle placeholder).
 * @returns The snapshot for that connection.
 */
export function useSchema(key: string | null): ISchemaState {
	return useSyncExternalStore(subscribe, () => (key ? (snapshots[key] ?? IDLE_SCHEMA) : IDLE_SCHEMA));
}
