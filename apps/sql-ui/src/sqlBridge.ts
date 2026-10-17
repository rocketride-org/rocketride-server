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
//
// Two legacy RAW peer ops remain for hosts without a documents API, where
// the tool has a single frame instead of per-document windows: 'open' (show
// a connection in the single frame) and 'overlay' (raise the add/edit modal
// there). Both hosts in this repo have documents; these are compatibility
// only.
// =============================================================================

import { createToolChannel } from 'shell';
import { getClient } from 'shell';
import type { DevToolProps, ToolChannel } from 'shell';
import { applySavedConnections, getSavedConnection, getSavedConnections, getSavedConnectionsStatus, resolveEndpoint, subscribeSavedConnections, upsertSavedConnection } from './connect';
import type { SavedSqlConnection } from './connect';
import { getActiveConnection, requestConnectionOverlay, subscribeActiveConnection } from './navigation';
import type { ConnectionOverlayRequest } from './navigation';
import { connectionEditorDocKey, connectionEditorUri, connectionUri, getDocs } from './docs';

// =============================================================================
// PROTOCOL NAMES
// =============================================================================

/** State topic: the saved-connection list (controller → documents). */
const TOPIC_CONNECTIONS = 'connections';
/** Event: editor save to commit in the controller realm. */
const EVENT_SAVE = 'saveConnection';
/** Event: open/resolve failure surfaced to the sidebar. */
const EVENT_ERROR = 'openError';
/** Event: a document's endpoint key came to front (activeDocKey fallback). */
const EVENT_ACTIVE = 'active';

/** Legacy raw ops for documents-less hosts (single-frame tools). */
type SqlLegacyMessage =
	| { op: 'open'; connId: string }
	| { op: 'overlay'; request: ConnectionOverlayRequest | null };

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
	/** The peer pipe (transport for the channel, and the legacy ops). */
	peer: DevToolProps['peer'];
	/** The typed channel; built locally over `peer` when the host is too old
	 *  to provide one (degraded: no host-side retention). */
	channel?: ToolChannel;
	/** Host documents API, when the host has one. */
	documents?: DevToolProps['documents'];
}

/** The mount's channel, host-provided or locally constructed. */
function channelOf(ctx: SqlToolMountContext): ToolChannel {
	return ctx.channel ?? createToolChannel(ctx.peer);
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
	const client = getClient();
	if (!client || !client.isConnected()) throw new Error('Not connected to a server.');
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
	channel.onEvent(EVENT_SAVE, (payload) => {
		upsertSavedConnection(payload as SavedSqlConnection);
	});

	// The list rides to every document as retained state — now, whenever the
	// store changes, and never before the owner load has read the file.
	const publishConnections = (): void => {
		if (getSavedConnectionsStatus() !== 'ready') return;
		channel.publishState(TOPIC_CONNECTIONS, getSavedConnections());
	};
	publishConnections();
	subscribeSavedConnections(publishConnections);

	// ── Frame → sidebar feeds ────────────────────────────────────────────────

	channel.onEvent(EVENT_ACTIVE, (payload) => {
		activeKey = (payload as string | null) ?? null;
		activeSubs.forEach((fn) => fn(activeKey));
	});
	channel.onEvent(EVENT_ERROR, (payload) => {
		errorSubs.forEach((fn) => fn(String(payload)));
	});

	// ── The sidebar's actions ────────────────────────────────────────────────

	return {
		// Per-document hosts open the connection's OWN top-level tab; legacy
		// single-frame hosts are summoned over the raw peer.
		openConnection: (conn) => {
			if (ctx.documents) ctx.documents.open(conn.id, conn.name);
			else ctx.peer.post({ op: 'open', connId: conn.id } satisfies SqlLegacyMessage);
		},
		openConnectionEditor: (editing) => {
			if (ctx.documents) ctx.documents.open(connectionEditorDocKey(editing?.id ?? null), editing ? `Edit ${editing.name}` : 'New Connection');
			else ctx.peer.post({ op: 'overlay', request: { kind: 'modal', editing } } satisfies SqlLegacyMessage);
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
	channelOf(ctx).sendEvent(EVENT_SAVE, conn);
}

/** The actual one-per-realm wiring behind {@link attachSqlDocumentHost}. */
function wireSqlDocumentHost(ctx: SqlToolMountContext): () => void {
	const channel = channelOf(ctx);

	// The controller's list, applied as a READ-ONLY replica (no writer, so a
	// mutation attempted in this realm is refused by the store). In-shell
	// both realms share the store: applying an identical list is a no-op, so
	// the publish→apply→notify cycle cannot loop.
	const offConnections = channel.onState(TOPIC_CONNECTIONS, (snapshot) => {
		applySavedConnections(snapshot as SavedSqlConnection[]);
	});

	// Legacy raw ops (documents-less single-frame hosts only).
	const offPeer = ctx.peer.subscribe((message) => {
		const msg = message as SqlLegacyMessage;
		if (!msg || typeof msg !== 'object') return;
		switch (msg.op) {
			case 'open': {
				const conn = getSavedConnection(msg.connId);
				if (!conn) break;
				openSavedConnection(conn).catch((err: unknown) => {
					channel.sendEvent(EVENT_ERROR, err instanceof Error ? err.message : String(err));
				});
				break;
			}
			case 'overlay': requestConnectionOverlay(msg.request); break;
		}
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
		channel.sendEvent(EVENT_ACTIVE, key);
	};
	pushActive();
	const offActive = subscribeActiveConnection(pushActive);
	const onVisible = (): void => {
		if (document.visibilityState !== 'visible') return;
		lastActive = getActiveConnection();
		channel.sendEvent(EVENT_ACTIVE, lastActive);
	};
	document.addEventListener('visibilitychange', onVisible);

	return () => {
		offConnections();
		offPeer();
		offActive();
		document.removeEventListener('visibilitychange', onVisible);
	};
}
