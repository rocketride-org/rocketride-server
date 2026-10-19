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
// SQL ENV — where the views' engine calls actually go
// =============================================================================
//
// Every view and dialog reaches the engine through this ONE seam instead of
// holding a RocketRide client. Two implementations:
//
//   LOCAL  (createLocalSqlEnv)  — wraps the shell client directly. Used by
//          the full app (SqlApp), where the realm legitimately owns a
//          connection, and by the sidebar CONTROLLER to serve the ops.
//   REMOTE (createRemoteSqlEnv) — routes every call over `controller(...)`
//          to the tool's sidebar controller (see ops.ts / sqlBridge.ts).
//          Used by every dev-tool document frame: frames hold NO client.
//
// The provider decides which one a subtree gets; views only ever call
// useSqlEnv(). `ready` replaces the old `client && isConnected` enablement —
// remotely it reflects the CONTROLLER's connection (`host:connection`).
// =============================================================================

import { createContext, useContext } from 'react';
import type { ToolControllerFn } from 'shell';
import { getBusSqlClient } from './connect/busClient';
import type { SqlWireClient } from './connect/busClient';
import type { SqlOps } from './ops';
import { createSqlSession, discoverSqlEndpoints, releaseDirectEndpoint, resolveEndpoint } from './connect';
import type { SqlEndpoint, SqlExecuteResult, SqlSchemaResponse, SqlSession, SavedSqlConnection, SqlDialect } from './connect';

// =============================================================================
// THE SEAM
// =============================================================================

/** The engine surface a sql-ui view may use. */
export interface SqlEnv {
	/** Whether the engine is reachable (drives run/apply enablement). */
	ready: boolean;
	/** The session for an endpoint (cached; all statement traffic). */
	getSession(endpoint: SqlEndpoint): SqlSession;
	/** Resolve a saved connection to a live endpoint (direct mode starts
	 *  or reattaches its temp pipeline). */
	resolveEndpoint(conn: SavedSqlConnection): Promise<SqlEndpoint>;
	/** Stop a direct connection's temp pipeline, fire-and-forget (best
	 *  effort — the idle TTL is the backstop). */
	releaseEndpoint(key: string): void;
	/** Discover database endpoints in the server's running pipelines. */
	discoverEndpoints(): Promise<SqlEndpoint[]>;
	/** One service definition (the direct path's config schema). */
	getService(provider: string): Promise<unknown>;
	/** Server-side single-component pipeline validation. */
	validate(pipeline: Record<string, unknown>): Promise<unknown>;
	/** Environment-variable names for the config form's autocomplete.
	 *  Never rejects — failures come back as an empty list. */
	getEnvironmentKeys(): Promise<string[]>;
}

const SqlEnvContext = createContext<SqlEnv | null>(null);

/** The provider component both mount roots wrap their subtree in. */
export const SqlEnvProvider = SqlEnvContext.Provider;

/**
 * The subtree's engine surface. Throws when no provider is mounted — every
 * sql-ui mount root (SqlApp, SqlDevTool) must install one.
 *
 * @returns The environment.
 */
export function useSqlEnv(): SqlEnv {
	const env = useContext(SqlEnvContext);
	if (!env) throw new Error('useSqlEnv: no SqlEnvProvider above this component.');
	return env;
}

// =============================================================================
// LOCAL — over the realm's own client
// =============================================================================

/** Session cache per endpoint key, tied to the client that created it so a
 *  reconnect (new client instance) transparently rebuilds sessions. Module
 *  level: shared across env instances in the realm (token caching). */
const localSessions = new Map<string, { client: SqlWireClient; session: SqlSession }>();

/**
 * The cached local session for an endpoint. Exported for the sidebar
 * controller, which serves the session ops from the same cache.
 *
 * @param client - The realm's RocketRide client.
 * @param endpoint - The endpoint to bind.
 * @returns The cached or freshly created session.
 */
export function getLocalSession(client: SqlWireClient, endpoint: SqlEndpoint): SqlSession {
	const cached = localSessions.get(endpoint.key);
	if (cached && cached.client === client) return cached.session;
	const session = createSqlSession(client, endpoint);
	localSessions.set(endpoint.key, { client, session });
	return session;
}

/**
 * The client-backed environment (full app + controller realm).
 *
 * @param client - The realm's client, or null while disconnected.
 * @param isConnected - The shell's connection flag.
 * @returns The environment (rebuild on client/connection change).
 */
export function createLocalSqlEnv(isConnected: boolean): SqlEnv {
	// The bus-backed adapter — one stable identity per realm (busClient.ts).
	const client = getBusSqlClient();
	const need = (): SqlWireClient => {
		if (!isConnected) throw new Error('Not connected to a server.');
		return client;
	};
	return {
		ready: isConnected,
		getSession: (endpoint) => getLocalSession(need(), endpoint),
		resolveEndpoint: (conn) => resolveEndpoint(need(), conn),
		releaseEndpoint: (key) => {
			void releaseDirectEndpoint(client, key);
		},
		discoverEndpoints: () => discoverSqlEndpoints(need()),
		getService: (provider) => need().getService(provider),
		validate: (pipeline) => need().validate({ pipeline }),
		getEnvironmentKeys: async () => {
			try {
				return await need().getEnvironmentKeys();
			} catch {
				return [];
			}
		},
	};
}

// =============================================================================
// REMOTE — over controller(...) ops
// =============================================================================

/**
 * An SqlSession whose four tools are controller ops. Stateless — the
 * token cache and retry policy live in the CONTROLLER's real session.
 *
 * @param call - The frame's controller function.
 * @param endpoint - The endpoint to bind.
 * @returns The proxy session.
 */
function remoteSession(call: ToolControllerFn<SqlOps>, endpoint: SqlEndpoint): SqlSession {
	return {
		endpoint,
		execute: (sql: string, opts?: { params?: unknown[]; idempotent?: boolean }): Promise<SqlExecuteResult> =>
			call('sql.execute', { endpoint, sql, ...(opts?.params ? { params: opts.params } : {}), ...(opts?.idempotent !== undefined ? { idempotent: opts.idempotent } : {}) }),
		getSchema: (table?: string): Promise<SqlSchemaResponse> =>
			call('sql.getSchema', { endpoint, ...(table ? { table } : {}) }),
		refreshSchema: (): Promise<SqlSchemaResponse> => call('sql.refreshSchema', { endpoint }),
		dialect: (): Promise<SqlDialect> => call('sql.dialect', { endpoint }),
	};
}

/**
 * The controller-backed environment (dev-tool document frames). The frame
 * holds no client: every call crosses the tool channel and executes on the
 * controller's single engine connection.
 *
 * @param call - The frame's controller function (createToolController(peer)).
 * @param ready - The controller realm's server reachability (`host:connection`).
 * @returns The environment (rebuild when `ready` changes).
 */
export function createRemoteSqlEnv(call: ToolControllerFn<SqlOps>, ready: boolean): SqlEnv {
	return {
		ready,
		getSession: (endpoint) => remoteSession(call, endpoint),
		resolveEndpoint: (conn) => call('sql.resolveEndpoint', { connId: conn.id }),
		releaseEndpoint: (key) => {
			// Fire-and-forget: a late or lost reply is fine — the TTL reaps.
			void call('sql.releaseEndpoint', { key }).catch(() => undefined);
		},
		discoverEndpoints: () => call('sql.discoverEndpoints', {}),
		getService: (provider) => call('sql.getService', { provider }),
		validate: (pipeline) => call('sql.validate', { pipeline }),
		getEnvironmentKeys: () => call('sql.envKeys', {}).catch(() => []),
	};
}
