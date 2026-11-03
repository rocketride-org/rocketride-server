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
// Every view and dialog reaches the engine through this ONE seam. Each realm
// now holds a real RocketRideClient (the realm client's requests ride the
// shell bus), so statement traffic, schema reads, discovery, service
// definitions, validation and env keys all run locally on it in BOTH
// implementations. What still differs is ENDPOINT LIFECYCLE:
//
//   LOCAL  (createLocalSqlEnv)  — the realm that owns the saved-connection
//          list resolves/releases endpoints itself (the full app).
//   REMOTE (createRemoteSqlEnv) — a dev-tool document frame forwards
//          resolve/release/discover to the tool's sidebar controller, which
//          refcounts direct-mode temp pipelines in ONE realm (ops/sqlOps.ts).
//
// The provider decides which one a subtree gets; views only ever call
// useSqlEnv().
// =============================================================================

import { createContext, useContext } from 'react';
import type { RocketRideClient } from 'rocketride';
import type { ISqlOpsClient } from './ops';
import { createSqlSession, discoverSqlEndpoints, releaseDirectEndpoint, resolveEndpoint } from './connect';
import type { SqlEndpoint, SqlSession, SavedSqlConnection } from './connect';

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
const localSessions = new Map<string, { client: RocketRideClient; session: SqlSession }>();

/**
 * The cached local session for an endpoint.
 *
 * @param client - The realm's RocketRide client.
 * @param endpoint - The endpoint to bind.
 * @returns The cached or freshly created session.
 */
export function getLocalSession(client: RocketRideClient, endpoint: SqlEndpoint): SqlSession {
	const cached = localSessions.get(endpoint.key);
	if (cached && cached.client === client) return cached.session;
	const session = createSqlSession(client, endpoint);
	localSessions.set(endpoint.key, { client, session });
	return session;
}

/** The env members every realm runs on its own client (both factories). */
function clientBackedEnv(need: () => RocketRideClient): Pick<SqlEnv, 'getSession' | 'getService' | 'validate' | 'getEnvironmentKeys'> {
	return {
		getSession: (endpoint) => getLocalSession(need(), endpoint),
		getService: (provider) => need().getService(provider),
		validate: (pipeline) => need().validate({ pipeline }),
		getEnvironmentKeys: async () => {
			try {
				return await need().account.getEnvironmentKeys();
			} catch {
				return [];
			}
		},
	};
}

/**
 * The environment of a realm that owns endpoint lifecycle itself (the full
 * app, which also owns the saved-connection list).
 *
 * @param client - The realm's connected client, or null while disconnected.
 * @returns The environment (rebuild on client/connection change).
 */
export function createLocalSqlEnv(client: RocketRideClient | null): SqlEnv {
	const need = (): RocketRideClient => {
		if (!client) throw new Error('Not connected to a server.');
		return client;
	};
	return {
		ready: client !== null,
		...clientBackedEnv(need),
		resolveEndpoint: (conn) => resolveEndpoint(need(), conn),
		releaseEndpoint: (key) => {
			if (client) void releaseDirectEndpoint(client, key);
		},
		discoverEndpoints: () => discoverSqlEndpoints(need()),
	};
}

// =============================================================================
// REMOTE — endpoint lifecycle over controller(...) ops
// =============================================================================

/**
 * The environment of a dev-tool document frame. Statement traffic runs on
 * the frame's OWN realm client; endpoint lifecycle (resolve / release /
 * discover) forwards to the sidebar controller, which refcounts direct-mode
 * temp pipelines in one realm.
 *
 * @param ops - The frame's ops client (createSqlOpsClient(peer)).
 * @param client - The frame's connected realm client, or null.
 * @returns The environment (rebuild on client/connection change).
 */
export function createRemoteSqlEnv(ops: ISqlOpsClient, client: RocketRideClient | null): SqlEnv {
	const need = (): RocketRideClient => {
		if (!client) throw new Error('Not connected to a server.');
		return client;
	};
	return {
		ready: client !== null,
		...clientBackedEnv(need),
		resolveEndpoint: (conn) => ops.resolveEndpoint(conn.id),
		releaseEndpoint: (key) => ops.releaseEndpoint(key),
		discoverEndpoints: () => ops.discoverEndpoints(),
	};
}
