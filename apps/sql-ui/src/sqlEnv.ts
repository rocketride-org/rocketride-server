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
//   LOCAL  (localEnv.ts)        — over the realm's engine core (sqlCore.ts:
//          the shared endpoint store, sessions, identity). Used by the full
//          app (SqlApp), where the realm legitimately owns a connection.
//   REMOTE (createRemoteSqlEnv) — every call is a `sql.*` op on the tool's
//          sidebar CONTROLLER (ops.ts / sqlController.ts), through the frame
//          caller (sqlFrame.ts). Used by every dev-tool document frame:
//          frames hold NO client and import nothing that does.
//
// The provider decides which one a subtree gets; views only ever call
// useSqlEnv(). `ready` is the run/apply enablement: the shell connection in
// the full app, the host's `host:connection` snapshot in a frame.
//
// Persistence follows the mount (§3.5): the full app keeps history and its
// switches in the shell's workspace preferences; a dev-tool frame never calls
// `usePrefs` (in rocket-ui it would write into rocket-ui's own bag, in VS
// Code it does nothing): history lives in the controller (`history`), and
// the per-connection pattern-check switch is session-only (`prefs`, an
// in-memory accessor per window).
// =============================================================================

import { createContext, useContext } from 'react';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { IGenerationTicket } from 'shared/explorer/generation';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import { createSessionGridPersistence } from 'shared/explorer/devtool/gridPersistence';
import type { JsonValue } from 'shared/explorer/devtool/reply';
import type { IDataGridPersistence } from 'shell';
import type { SqlOps } from './ops';
import type { SqlEndpoint, SqlExecuteResult, SqlSchemaResponse, SqlSession, SavedSqlConnection, SqlDialect } from './connect';
import { SQL_OP_TIMEOUT_MS } from './sqlTimeouts';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import type { SqlHistoryApi } from './history/api';

// =============================================================================
// THE SEAM
// =============================================================================

/** The engine surface a sql-ui view may use. */
export interface SqlEnv {
	/** Whether the engine is reachable (drives run/apply enablement). */
	ready: boolean;
	/** The session for an endpoint (all statement traffic). The endpoint must carry its `connId`. */
	getSession(endpoint: SqlEndpoint): SqlSession;
	/** Resolve a saved connection to a live endpoint (direct mode starts
	 *  or reattaches its temp pipeline). */
	resolveEndpoint(conn: SavedSqlConnection): Promise<SqlEndpoint>;
	/** Stop a direct connection's temp pipeline, fire-and-forget (best
	 *  effort — the idle TTL is the backstop). A no-op for a pipeline
	 *  connection. Named by the saved connection's id, and the endpoint key
	 *  the caller opened: nothing is stopped once the connection's key is
	 *  another (an edit started a new pipeline under the same project). */
	releaseEndpoint(connId: string, key?: string): void;
	/** The New Connection picker's list: endpoints a pipeline connection can be saved for. */
	discoverEndpoints(): Promise<SqlEndpoint[]>;
	/** One service definition (the direct path's config schema). */
	getService(provider: string): Promise<unknown>;
	/** Server-side single-component pipeline validation. */
	validate(pipeline: Record<string, unknown>): Promise<unknown>;
	/** Environment-variable names for the config form's autocomplete.
	 *  Never rejects — failures come back as an empty list. */
	getEnvironmentKeys(): Promise<string[]>;
	/** Insert or replace a saved connection (it is committed where the list is owned). */
	saveConnection(conn: SavedSqlConnection): Promise<void>;
	/** Delete a saved connection (a direct one's temp pipeline is stopped first, best effort). */
	deleteConnection(conn: SavedSqlConnection): Promise<void>;
	/**
	 * One saved connection by id, from the list's owner (null: no such
	 * connection). For a record a partial replica does not hold.
	 */
	getConnection(connId: string): Promise<SavedSqlConnection | null>;
	/** A provider's display title from the realm's cached service list, when it has one. */
	serviceTitle(provider: string): string | undefined;
	/** Statement history: read, record and edit (where it lives depends on the mount). */
	history: SqlHistoryApi;
	/** Small per-user switches (`sql.patternChecks`): workspace preferences in the full app, this session only in a dev-tool frame. */
	prefs: IPrefsAccessor;
	/**
	 * Grid layouts (sort, columns, page), always as plain-JSON copies
	 * (shared/explorer/devtool/gridPersistence): never the shell's bare
	 * channel, which hands Tabulator the stored object to rewrite in place.
	 * The full app keeps them in its own workspace prefs; a dev-tool frame,
	 * in the realm's session only, so its grids never write into the host's
	 * prefs.
	 */
	gridPersistence: IDataGridPersistence;
}

/** A realm's session-only preferences (dev-tool frames): kept in memory, never written anywhere. */
const sessionPrefValues = new Map<string, unknown>();

/** The session-only accessor every dev-tool frame of this window shares. */
export const SESSION_PREFS: IPrefsAccessor = {
	getPref: (key) => sessionPrefValues.get(key),
	setPref: (key, value) => { sessionPrefValues.set(key, value); },
};

/** The session-only grid layouts every dev-tool frame of this window shares. */
export const SESSION_GRIDS: IDataGridPersistence = createSessionGridPersistence();

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
// REMOTE — over the controller's ops
// =============================================================================

/**
 * The connection id an endpoint was resolved from.
 *
 * @param endpoint - The endpoint.
 * @returns Its connection id.
 * @throws TypeError for an endpoint that did not come from a saved connection.
 */
function connIdOf(endpoint: SqlEndpoint): string {
	if (typeof endpoint.connId !== 'string' || endpoint.connId === '') throw new TypeError(`The endpoint '${endpoint.key}' carries no connection id.`);
	return endpoint.connId;
}

/**
 * A dropped request: its ticket expired (Stop waiting, a newer request, the
 * view closing).
 *
 * @param tool - The tool.
 * @returns The stale marker every caller ignores.
 */
function dropped(tool: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'stale', tool, message: `The '${tool}' request was superseded; its answer is dropped.` });
}

/**
 * Run one remote call under a generation ticket, FRAME-SIDE (port of
 * 740b69c6d): the ticket is a function and never crosses the op channel. An
 * expired ticket sends nothing; an answer (or failure) that arrives after it
 * expired is dropped as `stale`. The controller's one retry after a
 * TASK_STOPPED refusal cannot see it.
 *
 * @param ticket - The caller's ticket, if any.
 * @param tool - The tool (named in the stale marker).
 * @param send - The op call.
 * @returns What the op answered.
 */
async function underTicket<T>(ticket: IGenerationTicket | undefined, tool: string, send: () => Promise<T>): Promise<T> {
	if (ticket && !ticket.isCurrent()) throw dropped(tool);
	try {
		const value = await send();
		if (ticket && !ticket.isCurrent()) throw dropped(tool);
		return value;
	} catch (error) {
		if (ticket && !ticket.isCurrent()) throw dropped(tool);
		throw error;
	}
}

/**
 * An SqlSession whose four tools are controller ops. Stateless — the token
 * vault, the retry rule and the waits live in the CONTROLLER's session.
 *
 * @param caller - The frame's caller.
 * @param endpoint - The endpoint to bind (carrying its connId).
 * @returns The proxy session.
 */
function remoteSession(caller: IFrameCaller<SqlOps>, endpoint: SqlEndpoint): SqlSession {
	const connId = connIdOf(endpoint);
	return {
		endpoint,
		execute: (sql: string, opts?: { params?: unknown[]; idempotent?: boolean; generation?: IGenerationTicket }): Promise<SqlExecuteResult> =>
			underTicket(opts?.generation, 'execute', () => caller.callReply('sql.execute', {
				connId,
				sql,
				...(opts?.params ? { params: opts.params as JsonValue[] } : {}),
				...(opts?.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
			}, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] })),
		getSchema: (table?: string): Promise<SqlSchemaResponse> =>
			caller.callReply('sql.getSchema', { connId, ...(table ? { table } : {}) }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.getSchema'] }),
		refreshSchema: (): Promise<SqlSchemaResponse> => caller.callReply('sql.refreshSchema', { connId }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.refreshSchema'] }),
		dialect: (): Promise<SqlDialect> => caller.callReply('sql.dialect', { connId }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.dialect'] }),
	};
}

/**
 * The controller-backed environment (dev-tool document frames). The frame
 * holds no client: every call crosses the tool channel and executes on the
 * controller's single engine connection.
 *
 * @param caller - The frame's caller (sqlFrame.ts).
 * @param ready - The controller realm's server reachability (`host:connection`).
 * @param owner - The identity fingerprint the frame belongs to (sent with mutations).
 * @param history - The frame's view of the controller's history (history/remoteHistory.ts).
 * @returns The environment (rebuild when `ready` changes).
 */
export function createRemoteSqlEnv(caller: IFrameCaller<SqlOps>, ready: boolean, owner: () => string | null, history: SqlHistoryApi): SqlEnv {
	return {
		history,
		prefs: SESSION_PREFS,
		gridPersistence: SESSION_GRIDS,
		ready,
		getSession: (endpoint) => remoteSession(caller, endpoint),
		resolveEndpoint: (conn) => caller.callReply('sql.resolveEndpoint', { connId: conn.id }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.resolveEndpoint'] }),
		releaseEndpoint: (connId, key) => {
			// Fire-and-forget: a late or lost reply is fine — the TTL reaps.
			void caller.callReply('sql.releaseEndpoint', { connId, ...(key !== undefined ? { key } : {}) }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.releaseEndpoint'] }).catch(() => undefined);
		},
		discoverEndpoints: () => caller.callReply('sql.discoverEndpoints', {}, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.discoverEndpoints'] }),
		getService: (provider) => caller.callReply('sql.getService', { provider }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.getService'] }),
		validate: (pipeline) => caller.callReply('sql.validate', { pipeline: pipeline as { [key: string]: JsonValue } }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.validate'] }),
		getEnvironmentKeys: () => caller.callReply('sql.envKeys', {}, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.envKeys'] }).catch(() => []),
		saveConnection: async (conn) => {
			await caller.callReply('sql.saveConnection', { connection: conn, owner: owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] });
		},
		deleteConnection: async (conn) => {
			await caller.callReply('sql.deleteConnection', { connId: conn.id, owner: owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.deleteConnection'] });
		},
		getConnection: (connId) => caller.callReply('sql.connection', { connId }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.connection'] }),
		// A frame has no service cache of its own; the dialog falls back to its titles.
		serviceTitle: () => undefined,
	};
}
