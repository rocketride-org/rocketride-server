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
// SQL BRIDGE — the tool's channel protocol (controller ↔ document views)
// =============================================================================
//
// sql-ui on the ToolChannel (the reference tool for the sidebar-as-controller
// architecture):
//
//   STATE  'connections'      controller → documents: the saved-connection
//                             list. Retained — a document opening later
//                             renders from the current snapshot. The
//                             CONTROLLER realm owns the list (loads it with
//                             persistence, commits every mutation); document
//                             realms apply the snapshot as a read-only
//                             replica and never touch the server file.
//   EVENT  'saveConnection'   editor document → controller: a full record
//                             (id minted by the editor) to insert/replace.
//   EVENT  'openError'        document → controller: an open/resolve failure.
//   EVENT  'active'           document → controller: this document's
//                             endpoint key came to front — the fallback
//                             selection signal for hosts without
//                             DevToolProps.activeDocKey.
//   STATE  'engine'           HOST → documents: engine reachability (the
//                             generic tools/core topic — the host publishes
//                             it, no tool does). Frames hold NO RocketRide
//                             client — their run/apply enablement derives
//                             from this retained snapshot.
//   OPS    sql.*              document → controller → document: every engine
//                             interaction a frame needs (resolve/release,
//                             execute, schema, dialect, discovery, service,
//                             validate, env keys), executed on the
//                             controller's single connection. The vocabulary
//                             lives in ops.ts; frames reach it through the
//                             remote SqlEnv (sqlEnv.ts), never directly.
// =============================================================================

import { createToolChannel, createToolOpServer, typedToolChannel } from 'shell';
import { ConnectionManager } from 'shell';
import { getBusSqlClient } from './connect/busClient';
import type { SqlWireClient } from './connect/busClient';
import type { DevToolProps, ToolChannel, TypedToolChannel } from 'shell';
import { applySavedConnections, discoverSqlEndpoints, getSavedConnection, getSavedConnections, getSavedConnectionsStatus, releaseDirectEndpoint, resolveEndpoint, subscribeSavedConnections, upsertSavedConnection } from './connect';
import type { SavedSqlConnection } from './connect';
import { getLocalSession } from './sqlEnv';
import type { SqlOps, SqlStateMap, SqlEventMap } from './ops';
import { getActiveConnection, subscribeActiveConnection } from './navigation';
import { connectionEditorDocKey, connectionEditorUri, connectionUri, getDocs } from './docs';

// =============================================================================
// PROTOCOL
// =============================================================================
//
// The tool's topics, events and ops live in ops.ts as protocol maps
// (SqlStateMap / SqlEventMap / SqlOps) — the typed channel view below makes
// every key and payload check at the call site.

// =============================================================================
// TYPES
// =============================================================================

/** The sidebar's frame-facing actions plus the frame's state feeds. */
export interface SqlSidebarBridge {
	/** Open (or focus) a saved connection's workbench document. */
	openConnection(conn: SavedSqlConnection): void;
	/** Open the add/edit connection editor as a top-level document (null = add). */
	openConnectionEditor(editing: SavedSqlConnection | null): void;
	/** Subscribe to the active connection key (replays current). Returns unsubscribe. */
	subscribeActive(cb: (key: string | null) => void): () => void;
	/** Subscribe to open failures (direct resolves can fail). Returns unsubscribe. */
	subscribeError(cb: (message: string) => void): () => void;
}

/** What a mount hands the bridge builders — straight from DevToolProps. */
export interface SqlToolMountContext {
	/** The peer pipe (the channel's transport). */
	peer: DevToolProps['peer'];
	/** The typed channel; built locally over `peer` when the host is too old
	 *  to provide one (degraded: no host-side retention). */
	channel?: ToolChannel;
	/** Host documents API, when the host has one. */
	documents?: DevToolProps['documents'];
}

/** The mount's channel, host-provided or locally constructed, as the sql
 *  tool's typed protocol view. */
function channelOf(ctx: SqlToolMountContext): TypedToolChannel<SqlStateMap, SqlEventMap> {
	return typedToolChannel<SqlStateMap, SqlEventMap>(ctx.channel ?? createToolChannel(ctx.peer));
}

// =============================================================================
// SHARED OPEN HELPER — resolve + open, used by the local + legacy paths
// =============================================================================

/**
 * Resolves a saved connection (direct mode materialises its temp pipeline)
 * and opens its workbench document. Runs in a realm that owns a Documents
 * instance (the full app, or a legacy single-frame host).
 *
 * @param conn - The saved connection.
 * @throws When resolution fails (no client, pipeline start failure).
 */
async function openSavedConnection(conn: SavedSqlConnection): Promise<void> {
	const client = getBusSqlClient();
	if (!ConnectionManager.getInstance().isConnected()) throw new Error('Not connected to a server.');
	const endpoint = await resolveEndpoint(client, conn);
	getDocs()?.openStaticDocument(connectionUri(endpoint.key), conn.name, endpoint);
}

// =============================================================================
// LOCAL BRIDGE — sidebar and frame in the same document (the full app)
// =============================================================================

// Open-failure emitter for the in-document path.
const localErrorSubs = new Set<(message: string) => void>();

/** The in-document bridge — straight calls into the shared singletons. */
export const localSidebarBridge: SqlSidebarBridge = {
	openConnection(conn) {
		openSavedConnection(conn).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			localErrorSubs.forEach((fn) => fn(message));
		});
	},

	openConnectionEditor(editing) {
		getDocs()?.openStaticDocument(connectionEditorUri(editing?.id ?? null), editing ? `Edit ${editing.name}` : 'New Connection');
	},

	subscribeActive(cb) {
		cb(getActiveConnection());
		return subscribeActiveConnection(() => cb(getActiveConnection()));
	},

	subscribeError(cb) {
		localErrorSubs.add(cb);
		return () => { localErrorSubs.delete(cb); };
	},
};

// =============================================================================
// CONTROLLER SIDE — the devToolSidebar mount
// =============================================================================

/**
 * Builds the CONTROLLER's bridge and wires its channel duties: commit
 * incoming saves (this realm owns the list), and publish the list as
 * retained state on every change. Call once per sidebar mount lifetime.
 *
 * @param ctx - The mount's peer/channel/documents.
 * @returns The bridge the sidebar renders against.
 */
export function createSidebarToolBridge(ctx: SqlToolMountContext): SqlSidebarBridge {
	const channel = channelOf(ctx);
	const activeSubs = new Set<(key: string | null) => void>();
	const errorSubs = new Set<(message: string) => void>();
	let activeKey: string | null = null;

	// ── Channel duties of the OWNER realm ────────────────────────────────────

	// Editor saves commit here (upsert queues internally until the owner
	// load installs the writer, so a racing save defers instead of dying).
	channel.onEvent('saveConnection', (payload) => {
		upsertSavedConnection(payload);
	});

	// Operations served on the controller's engine connection — plain
	// handlers; correlation and replies are the op server's business. The
	// session ops share the realm's local session cache (token caching).
	const needClient = (): SqlWireClient => {
		const client = getBusSqlClient();
		if (!ConnectionManager.getInstance().isConnected()) throw new Error('Not connected to a server.');
		return client;
	};
	const ops = createToolOpServer<SqlOps>(ctx.peer);
	ops.serve('sql.resolveEndpoint', async ({ connId }) => {
		const conn = getSavedConnection(connId);
		if (!conn) throw new Error(`No saved connection '${connId}'.`);
		return resolveEndpoint(needClient(), conn);
	});
	ops.serve('sql.releaseEndpoint', async ({ key }) => {
		await releaseDirectEndpoint(needClient(), key);
	});
	ops.serve('sql.discoverEndpoints', async () => discoverSqlEndpoints(needClient()));
	ops.serve('sql.execute', async ({ endpoint, sql, params, idempotent }) =>
		getLocalSession(needClient(), endpoint).execute(sql, { ...(params ? { params } : {}), ...(idempotent !== undefined ? { idempotent } : {}) }));
	ops.serve('sql.getSchema', async ({ endpoint, table }) => getLocalSession(needClient(), endpoint).getSchema(table));
	ops.serve('sql.refreshSchema', async ({ endpoint }) => getLocalSession(needClient(), endpoint).refreshSchema());
	ops.serve('sql.dialect', async ({ endpoint }) => getLocalSession(needClient(), endpoint).dialect());
	ops.serve('sql.getService', async ({ provider }) => needClient().getService(provider));
	ops.serve('sql.validate', async ({ pipeline }) => needClient().validate({ pipeline }));
	ops.serve('sql.envKeys', async () => {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const keys = await (needClient() as any).account?.getEnvironmentKeys?.();
			return (keys as string[] | undefined) ?? [];
		} catch {
			return [];
		}
	});

	// The list rides to every document as retained state — now, whenever the
	// store changes, and never before the owner load has read the file.
	const publishConnections = (): void => {
		if (getSavedConnectionsStatus() !== 'ready') return;
		channel.publishState('connections', getSavedConnections());
	};
	publishConnections();
	subscribeSavedConnections(publishConnections);

	// ── Frame → sidebar feeds ────────────────────────────────────────────────

	channel.onEvent('active', (payload) => {
		activeKey = payload ?? null;
		activeSubs.forEach((fn) => fn(activeKey));
	});
	channel.onEvent('openError', (payload) => {
		errorSubs.forEach((fn) => fn(String(payload)));
	});

	// ── The sidebar's actions ────────────────────────────────────────────────

	return {
		// Hosts open the connection's OWN top-level tab through documents.
		openConnection: (conn) => {
			ctx.documents?.open(conn.id, conn.name);
		},
		openConnectionEditor: (editing) => {
			ctx.documents?.open(connectionEditorDocKey(editing?.id ?? null), editing ? `Edit ${editing.name}` : 'New Connection');
		},
		subscribeActive(cb) {
			cb(activeKey);
			activeSubs.add(cb);
			return () => { activeSubs.delete(cb); };
		},
		subscribeError(cb) {
			errorSubs.add(cb);
			return () => { errorSubs.delete(cb); };
		},
	};
}

// =============================================================================
// DOCUMENT SIDE — every devToolFrame mount
// =============================================================================

// Connection reachability rides the shell's `host:connection` system topic —
// frames read it with useConnectionReady(channel) from 'shell'.

/** The realm's single document-host wiring teardown (ref-counted). */
let documentHostDetach: (() => void) | null = null;
/** Frame mounts attached in this realm (any number share ONE wiring). */
let documentHosts = 0;

/**
 * Attaches the DOCUMENT side of the protocol for this realm: apply the
 * controller's retained connection list as a read-only replica, act on
 * controller events, and announce this realm's active endpoint. REF-COUNTED:
 * any number of frames may call it, exactly one wiring exists.
 *
 * @param ctx - The mount's peer/channel/documents.
 * @returns Detach (the last detach tears the wiring down).
 */
export function attachSqlDocumentHost(ctx: SqlToolMountContext): () => void {
	documentHosts++;
	if (documentHosts === 1) documentHostDetach = wireSqlDocumentHost(ctx);
	return () => {
		documentHosts--;
		if (documentHosts === 0) {
			documentHostDetach?.();
			documentHostDetach = null;
		}
	};
}

/**
 * Posts an editor document's save to the controller realm for commit.
 *
 * @param ctx - The mount's peer/channel.
 * @param conn - The full record (id minted by the editor).
 */
export function sendConnectionSave(ctx: SqlToolMountContext, conn: SavedSqlConnection): void {
	channelOf(ctx).sendEvent('saveConnection', conn);
}

/** The actual one-per-realm wiring behind {@link attachSqlDocumentHost}. */
function wireSqlDocumentHost(ctx: SqlToolMountContext): () => void {
	const channel = channelOf(ctx);

	// The controller's list, applied as a READ-ONLY replica (no writer, so a
	// mutation attempted in this realm is refused by the store). In-shell
	// both realms share the store: applying an identical list is a no-op, so
	// the publish→apply→notify cycle cannot loop.
	const offConnections = channel.onState('connections', (snapshot) => {
		applySavedConnections(snapshot);
	});

	// Announce this realm's active endpoint — on change, and again whenever
	// the document becomes visible: in VS Code each connection is its own
	// webview panel, and switching editor tabs changes nothing INSIDE either
	// document, so the newly fronted panel re-announces itself. (Hosts with
	// activeDocKey override this signal; it remains the fallback.)
	let lastActive: string | null | undefined;
	const pushActive = (): void => {
		const key = getActiveConnection();
		if (key === lastActive) return;
		lastActive = key;
		channel.sendEvent('active', key);
	};
	pushActive();
	const offActive = subscribeActiveConnection(pushActive);
	const onVisible = (): void => {
		if (document.visibilityState !== 'visible') return;
		lastActive = getActiveConnection();
		channel.sendEvent('active', lastActive);
	};
	document.addEventListener('visibilitychange', onVisible);

	return () => {
		offConnections();
		offActive();
		document.removeEventListener('visibilitychange', onVisible);
	};
}
