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
// CONNECT — SAVED CONNECTIONS (the user's connection list, two modes)
// =============================================================================
//
// A saved connection is one of two records:
//  - 'pipeline': bound to a database node DISCOVERED inside a user pipeline —
//    usable only while that pipeline runs.
//  - 'direct': owns a full node config captured from the services catalog —
//    always openable; the resolver materialises a temporary tool pipeline on
//    demand (see resolver.ts).
//
// Persistence: the list lives in the USER'S SERVER STORE
// (`@/User/.workspace/rocketride.sql.json`) — a connection describes a database
// reachable through the connected server, so its scope is per-user-per-server,
// and every host (the shell app, the App Builder preview, the VS Code tool
// mount) reads the same list. Configs are stored AS-IS (no fake client-side
// crypto): secret fields should carry `${ROCKETRIDE_*}` env references, which
// the server stores encrypted.
//
// OWNERSHIP (one writer): exactly one realm loads this store with
// persistence — the CONTROLLER realm, i.e. whichever document renders the
// sidebar list (the full app, or the devToolSidebar document in VS Code).
// Document realms never read the server file at all: the controller
// publishes the list as retained ToolChannel state and they apply it here
// as a read-only replica (applySavedConnections — no writer installed, so
// any mutation attempted there is refused). Mutations always execute in the
// controller realm — documents hand their saves over as channel events (see
// sqlBridge), and a save that arrives before the controller's load finishes
// is queued, not dropped.
// =============================================================================

import { useSyncExternalStore } from 'react';

/**
 * The three user-store calls the list needs. The engine core (sqlCore.ts)
 * supplies them over the shell bus, each with an explicit timeout.
 */
export interface SavedConnectionsFs {
	/** Create a folder (an existing one is not an error worth reporting). */
	fsMkdir(path: string): Promise<unknown>;
	/** Read a JSON file. */
	fsReadJson(path: string): Promise<unknown>;
	/** Write a JSON file. */
	fsWriteJson(path: string, value: unknown): Promise<unknown>;
}

// =============================================================================
// TYPES
// =============================================================================

/** Fields shared by both connection modes. */
interface SavedConnectionBase {
	/** Stable id (list identity, temp-pipeline naming). */
	id: string;
	/** User-visible name (sidebar row, workbench tab). */
	name: string;
}

/** A connection bound to a database node inside a user pipeline. */
export interface PipelineBoundConnection extends SavedConnectionBase {
	mode: 'pipeline';
	/** Project (pipeline) identifier the node lives in. */
	projectId: string;
	/** Pipeline display name (shown as the row's detail line). */
	pipelineName: string;
	/** Source component id of the pipeline's task. */
	source: string;
	/** The database component id inside the pipeline. */
	nodeId: string;
	/** Component provider, e.g. 'db_mysql'. */
	provider: string;
}

/** A connection that owns its node config (temp tool pipeline on open). */
export interface DirectConnection extends SavedConnectionBase {
	mode: 'direct';
	/** Component provider, e.g. 'db_mysql'. */
	provider: string;
	/** The node configuration (NodeConfigForm output, stored as-is). */
	config: Record<string, unknown>;
}

/** One saved connection. */
export type SavedSqlConnection = PipelineBoundConnection | DirectConnection;

// =============================================================================
// STORE
// =============================================================================

/** The user store's app-data folder (shared with the shell's workspace
 *  files). A scope-less path defaults to the User scope (`@/User/...`);
 *  explicit scopes are `@/User`, `@/Team`, `@/Org` (case-exact). */
const STORE_DIR = '.workspace';

/** The server-store file the list persists in — app-id-named, beside the
 *  shell's per-app workspace files in the same folder. */
const STORE_PATH = `${STORE_DIR}/rocketride.sql.json`;

/** Load lifecycle of the list ('ready' = the server store has been read). */
export type SavedConnectionsStatus = 'idle' | 'loading' | 'ready';

let status: SavedConnectionsStatus = 'idle';
let connections: SavedSqlConnection[] = [];
/**
 * A replica's note that the controller published only part of the list (its
 * first `kept` of `total` records; see ops.ts ConnectionsState). Always null
 * in the realm that owns the list.
 */
export interface ReplicaPartial {
	/** Records in the replica. */
	kept: number;
	/** Records in the controller's list. */
	total: number;
}
let partial: ReplicaPartial | null = null;
/** Writes the list back to the server store (installed by load). */
let persist: ((list: SavedSqlConnection[]) => void) | null = null;
const listeners = new Set<() => void>();

/** Monotonic load counter — an outdated in-flight load never wins. */
let loadSeq = 0;

function notify(): void {
	listeners.forEach((fn) => fn());
}

/** Notifies subscribers and writes the list through to the server store. */
function commit(next: SavedSqlConnection[]): void {
	// No writer = not the owner realm, or the owner's load is still in
	// flight. A commit here could never persist and would be overwritten by
	// the next load — and a commit onto the empty bootstrap list would WIPE
	// the file. Refuse; saves go through upsertSavedConnection (which
	// queues), deletes only exist where the loaded list is on screen.
	if (!persist) {
		console.log('[sql-ui] connection mutation ignored: this document does not own the saved-connection list');
		return;
	}
	connections = next;
	persist(next);
	notify();
}

/**
 * Loads the list from the connected server's user store and installs the
 * persistence writer — the OWNER realm's load, called only by the realm
 * that renders the sidebar list (the full app, or the devToolSidebar
 * document). Document realms never call this: their list arrives from the
 * controller as retained channel state (applySavedConnections). Reconnects
 * re-load against the new server; a missing file is first run.
 *
 * @param client - The user-store calls (the engine core's, over the bus).
 */
export async function loadSavedConnections(client: SavedConnectionsFs): Promise<void> {
	const seq = ++loadSeq;
	status = 'loading';
	notify();
	// Ensure the app-data folder exists (idempotent; failure surfaces on write).
	try { await client.fsMkdir(STORE_DIR); } catch { /* already exists */ }
	let list: SavedSqlConnection[] = [];
	try {
		const raw = (await client.fsReadJson(STORE_PATH)) as SavedSqlConnection[] | null | undefined;
		if (Array.isArray(raw)) list = raw;
	} catch {
		// No file yet (or unreadable) — start empty; the first save writes it.
	}
	if (seq !== loadSeq) return;
	connections = list;
	persist = (next) => {
		client.fsWriteJson(STORE_PATH, next).catch((err: unknown) => {
			console.log('[sql-ui] failed to persist connections', err);
		});
	};
	status = 'ready';
	notify();
	// Upserts that raced the load (channel saves landing while the file was
	// still being read) apply now, on top of the fresh list.
	if (pendingUpserts.length > 0) {
		const queued = pendingUpserts.splice(0);
		for (const conn of queued) upsertSavedConnection(conn);
	}
}

/**
 * Resets the store (app unmount); the next load starts fresh.
 *
 * Skipped while OTHER consumers still render the list: in an in-shell host
 * the frame and the devToolSidebar share this module, and the frame's
 * unmount must not wipe the list out from under the still-mounted sidebar
 * (seen as the connection list flashing empty). The caller's own React
 * children have already unsubscribed by the time its cleanup runs, so in an
 * isolated document (VS Code webview) the listener set is empty here and
 * the reset proceeds exactly as before.
 *
 * `force` resets whoever still renders it: a change of signed-in identity
 * (the list is the previous user's) or the owner's unmount.
 *
 * @param opts - `force`: reset even while the list is on screen.
 */
export function resetSavedConnections(opts: { force?: boolean } = {}): void {
	if (listeners.size > 0 && opts.force !== true) return;
	loadSeq++;
	status = 'idle';
	connections = [];
	partial = null;
	persist = null;
	pendingUpserts.length = 0;
	notify();
}

/** Owners alive in this realm (engine cores that load and write the list). */
let owners = 0;

/**
 * Mark this realm as an OWNER of the list for as long as the returned release
 * is not called (the engine core does, for its lifetime). While a realm owns
 * the list, a replica snapshot never overwrites it: in one realm (rocket-ui)
 * the frames and the controller share this module, and a snapshot the
 * controller could not publish (over the retained-state cap) or one that is
 * still loading must not wipe the owner's list or cancel its load.
 *
 * @returns Release the claim (idempotent).
 */
export function ownSavedConnections(): () => void {
	owners++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		owners--;
	};
}

/**
 * A published partial note, if it is one.
 *
 * @param value - What the snapshot carried.
 * @returns The note, or null (the list is whole).
 */
function readPartial(value: unknown): ReplicaPartial | null {
	if (value === null || typeof value !== 'object') return null;
	const { kept, total } = value as { kept?: unknown; total?: unknown };
	return typeof kept === 'number' && typeof total === 'number' && kept < total ? { kept, total } : null;
}

/**
 * Applies a snapshot the controller published (`{ status, list, partial }`)
 * in a realm that does NOT own the list: a ready list becomes the read-only
 * replica (with its partial note), anything else shows as loading. A no-op
 * where an owner is alive.
 *
 * @param snapshot - The controller's snapshot.
 * @param snapshot.status - The list's status in the controller.
 * @param snapshot.list - The list (empty unless ready).
 * @param snapshot.partial - Null, or how much of the list it holds.
 */
export function applyReplicaConnections(snapshot: { status: SavedConnectionsStatus; list: SavedSqlConnection[]; partial?: ReplicaPartial | null } | undefined): void {
	if (owners > 0) return;
	if (snapshot?.status === 'ready' && Array.isArray(snapshot.list)) {
		const next = readPartial(snapshot.partial);
		const changed = JSON.stringify(next) !== JSON.stringify(partial);
		partial = next;
		applySavedConnections(snapshot.list);
		if (changed) notify();
	} else {
		resetSavedConnections({ force: true });
	}
}

/**
 * The replica's partial note (non-React consumers).
 *
 * @returns Null when the list is whole (always, where the list is owned).
 */
export function getSavedConnectionsPartial(): ReplicaPartial | null {
	return partial;
}

/**
 * Applies the controller's published list as a READ-ONLY replica — document
 * realms render from this; no writer is installed, so a mutation attempted
 * here is refused by {@link commit}. An identical list is a no-op: in-shell
 * the controller and the documents share this very store, and skipping the
 * echo is what keeps publish→apply→notify from looping.
 *
 * @param list - The controller's authoritative snapshot.
 */
export function applySavedConnections(list: SavedSqlConnection[]): void {
	if (status === 'ready' && JSON.stringify(list) === JSON.stringify(connections)) return;
	connections = list;
	status = 'ready';
	notify();
}

/**
 * Plain subscription to the list (for non-React consumers — the peer host
 * pushes changes to the sidebar mount). Returns unsubscribe.
 *
 * @param cb - Called on every change (not with the current value).
 */
export function subscribeSavedConnections(cb: () => void): () => void {
	listeners.add(cb);
	return () => { listeners.delete(cb); };
}

/**
 * The current list (pairs with subscribeSavedConnections).
 *
 * @returns The saved connections.
 */
export function getSavedConnections(): SavedSqlConnection[] {
	return connections;
}

/**
 * The store's load status (non-React consumers; pairs with
 * {@link useSavedConnectionsStatus}).
 *
 * @returns The current status.
 */
export function getSavedConnectionsStatus(): SavedConnectionsStatus {
	return status;
}

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * Generates a collision-safe connection id. Ids are minted by whoever BUILDS
 * the record (the editor form), so a save can open the new connection's
 * workbench without waiting on the owner's commit.
 *
 * @returns A fresh connection id.
 */
export function newConnectionId(): string {
	// randomUUID exists in every host document (browser / webview).
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/** Upserts that arrived before this realm's owner load finished. */
const pendingUpserts: SavedSqlConnection[] = [];

/**
 * Inserts or replaces a connection by id — the ONE mutation path for saves,
 * running in the owner realm. An upsert landing before the owner's load has
 * installed the writer is queued and applied (and persisted) when it does —
 * a racing save is deferred, never dropped and never committed onto the
 * empty bootstrap list.
 *
 * @param conn - The full record, id included.
 */
export function upsertSavedConnection(conn: SavedSqlConnection): void {
	if (!persist) {
		pendingUpserts.push(conn);
		return;
	}
	const at = connections.findIndex((c) => c.id === conn.id);
	commit(at < 0 ? [...connections, conn] : connections.map((c) => (c.id === conn.id ? conn : c)));
}

/**
 * Removes a connection from the list.
 *
 * @param id - The connection to delete.
 */
export function deleteSavedConnection(id: string): void {
	commit(connections.filter((c) => c.id !== id));
}

/**
 * Looks a connection up by id.
 *
 * @param id - The connection id.
 * @returns The connection, or undefined.
 */
export function getSavedConnection(id: string): SavedSqlConnection | undefined {
	return connections.find((c) => c.id === id);
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Subscribes to the saved-connection list.
 *
 * @returns The current list snapshot.
 */
export function useSavedConnections(): SavedSqlConnection[] {
	return useSyncExternalStore(
		(cb) => { listeners.add(cb); return () => listeners.delete(cb); },
		() => connections,
	);
}

/**
 * Subscribes to the list's load lifecycle (the sidebar distinguishes
 * "still loading" from "genuinely empty").
 *
 * @returns The current status.
 */
export function useSavedConnectionsStatus(): SavedConnectionsStatus {
	return useSyncExternalStore(
		(cb) => { listeners.add(cb); return () => listeners.delete(cb); },
		() => status,
	);
}

/**
 * Subscribes to the replica's partial note (see {@link getSavedConnectionsPartial}).
 *
 * @returns Null when the list is whole.
 */
export function useSavedConnectionsPartial(): ReplicaPartial | null {
	return useSyncExternalStore(
		(cb) => { listeners.add(cb); return () => listeners.delete(cb); },
		() => partial,
	);
}
