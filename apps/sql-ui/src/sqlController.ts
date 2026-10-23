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
// SQL CONTROLLER — the sidebar mount serves the tool protocol (R1, R2, R6)
// =============================================================================
//
// The dev tool's sidebar mount is its CONTROLLER: it owns the tool's one
// engine connection, as an engine core (sqlCore.ts), and serves every frame
// op from it:
//
//   OPS    sql.*            answered from the core, through the dev-tool
//                           library's attachController: each op is checked
//                           against its `deadlineAt` (a call held while no
//                           controller was mounted, delivered after its frame
//                           gave up, never runs), and answers a Reply.
//   STATE  'connections'   { status, list, partial }: the saved-connection
//                           list the core read for the signed-in identity,
//                           republished on every change. A list too long for
//                           the retained-state budget is published in part
//                           (its first records, and `partial: { kept, total }`)
//                           and frames ask for any other record by op.
//   STATE  'identity'      { fingerprint }: who the core vouches for (R9).
//   STATE  'history'       { storage, keys }: where history is kept and, per
//                           connection a frame has read (the 128 read most
//                           recently), a revision and the recording switch.
//                           Entries travel as op results.
//
//   Each topic stays within 64 KiB and all of them within 128 KiB (the whole
//   map is republished on every publish): shrinkSqlState replaces an
//   oversize snapshot with an honest bounded one, never silently.
//   (`devtool:controller`, the readiness state, is the library's.)
//   EVENT  'active'        heard: a frame's active endpoint key.
//   EVENT  'openError'     heard: a connection a frame could not open.
//
// The controller's OWN checks, whatever a frame sent:
//
//   - a statement is classified again with the node's dialect
//     (sql/gate.ts): transaction control is refused, and only a read is ever
//     repeated (T10);
//   - a saved-connection record must be a usable record naming a database
//     node (sqlCore.ts checkSavedConnection);
//   - a mutation (save, delete, a history record or edit) is refused unless
//     the calling frame belongs to the identity signed in now (`owner`),
//     checked again after every wait, so a call from before a change of
//     account can never write into the next account's list or history.
//
// HISTORY (§3.5). The controller owns SQL history in dev-tool mounts: its
// own history store (same keys, field and bounds as the full app's), kept in
// a per-user file beside the saved connections,
// `@/User/.workspace/rocketride.sql.history.json` (the dev-tool library's
// createFsPrefs): the file is READ before the store attaches (an attach
// before the read would start empty and overwrite it), the folder is made
// before the first write, writes are debounced, one bag per identity
// fingerprint, the 256 KB bag cap holds, and a file that exists but cannot be
// read is never written (history is kept for the session). A new identity
// gets a new accessor and the store forgets what it held at once. An unmount
// writes the batch still in the debounce first. Last writer wins across
// windows (a known limitation the privacy line states).
//
// LIFETIME (R6, R7). `attachSqlController` runs inside the sidebar's
// `useEffect` and its `dispose` is the cleanup: exactly one op server per
// mount, created after the channel, never in a render. At mount it publishes
// retained state only: no event, no call, no `documents.open`; the core waits
// for activation before its first discovery. Documents open only on a user
// action in the sidebar.
// =============================================================================

import type { DevToolProps, ToolChannel } from 'shell';
import { ExplorerToolError } from 'shared/explorer/errors';
import { attachController } from 'shared/explorer/devtool/controller';
import type { RequiredControllerHandlers } from 'shared/explorer/devtool/controller';
import type { DeadlineError } from 'shared/explorer/devtool/deadline';
import { publishIdentityState } from 'shared/explorer/devtool/frameIdentity';
import type { JsonValue } from 'shared/explorer/devtool/reply';
import { guardRetainedState, jsonByteLength } from 'shared/explorer/devtool/state';
import type { IOversizeInfo } from 'shared/explorer/devtool/state';
import { attachWhenLoaded, createFsPrefs, historyPrefsPath } from 'shared/explorer/devtool/prefs';
import type { IFsPrefs } from 'shared/explorer/devtool/prefs';
import type { IIdentitySnapshot } from 'shared/explorer/devtool/identity';
import type { IStoreClock } from 'shared/explorer/connect/store';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import type { IFocusTarget } from 'shared/explorer/devtool/watch';
import { SQL_APP_ID } from './appId';
import { getSavedConnections, getSavedConnectionsStatus, subscribeSavedConnections } from './connect';
import { connectionEditorDocKey } from './docs';
import type { ConnectionsState, HistoryState, SqlOps } from './ops';
import { checkHistoryEdit, checkHistoryEntry } from './history/api';
import type { HistoryEdit, HistoryStorage } from './history/api';
import type { HistoryEntry } from './history/types';
import { createSqlHistoryStore, memoryPrefs } from './history/historyStore';
import type { SqlHistoryStore } from './history/historyStore';
import type { SqlSidebarBridge } from './sidebarBridge';
import { gateStatement } from './sql/gate';
import { createSqlCore } from './sqlCore';
import type { SqlCore, SqlCoreBus } from './sqlCore';
import { sqlChannel } from './sqlFrame';
import type { SqlToolProtocol } from './sqlFrame';

/** What {@link attachSqlController} needs (DevToolProps plus the injected realm and factories). */
export interface SqlControllerOptions {
	/** The sidebar mount's peer. */
	peer: DevToolPeer;
	/** The host's channel, when it gave one. */
	channel?: ToolChannel;
	/** The host's documents API (opened only on user actions). */
	documents?: DevToolProps['documents'];
	/** The sidebar's activeDocKey at mount. */
	activeDocKey?: string | null;
	/** The realm's ConnectionManager. */
	cm: SqlCoreBus;
	/** The protocol factories. */
	protocol: SqlToolProtocol;
	/** The deadline guard's clock (tests). */
	now?: () => number;
	/** Where focus comes from (default: the window; null: none). */
	focusTarget?: IFocusTarget | null;
	/** The endpoint store's clock (tests). */
	clock?: IStoreClock;
	/** Told about every call the deadline guard refused (tests, diagnostics). */
	onRefused?: (error: DeadlineError) => void;
}

/** A mounted controller. */
export interface SqlControllerMount {
	/** The bridge the sidebar renders against. */
	readonly bridge: SqlSidebarBridge;
	/** The controller's engine core. */
	readonly core: SqlCore;
	/** The controller's history store (persisted in the user's history file). */
	readonly history: SqlHistoryStore;
	/** The channel the controller serves on. */
	readonly channel: ToolChannel;
	/** Feed every new activeDocKey prop value (activation, R7). */
	noteActiveDocKey(key: string | null | undefined): void;
	/** Tear everything down (the effect's cleanup; idempotent). */
	dispose(): void;
}

/**
 * The saved-connection list as the controller publishes it.
 *
 * @returns The snapshot.
 */
function connectionsState(): ConnectionsState {
	const status = getSavedConnectionsStatus();
	return { status, list: status === 'ready' ? getSavedConnections() : [], partial: null };
}

/**
 * Whether a value is one JSON can carry unchanged (finite numbers; plain
 * arrays and objects of such values).
 *
 * @param value - Anything a frame sent.
 * @param depth - Nesting so far (bounded).
 * @returns True for a JSON value.
 */
function isJsonValue(value: unknown, depth = 0): boolean {
	if (depth > 32) return false;
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
	if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
	return false;
}

/**
 * A frame's input that does not fit an op (R3): answered as `invalid` Reply
 * data before anything is resolved, gated or sent.
 *
 * @param tool - The tool it was for.
 * @param message - What is wrong.
 * @returns The error.
 */
function invalidInput(tool: string, message: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'invalid', tool, message });
}

/**
 * Check `sql.execute`'s input.
 *
 * @param input - The op params.
 * @param input.sql - The statement text.
 * @param input.params - Bind values.
 * @param input.idempotent - What the frame asked for.
 * @throws ExplorerToolError `invalid` naming what is wrong.
 */
export function checkExecuteInput(input: { sql: unknown; params?: unknown; idempotent?: unknown }): void {
	if (typeof input.sql !== 'string') throw invalidInput('execute', 'The statement must be text.');
	if (input.params !== undefined && (!Array.isArray(input.params) || !input.params.every((value) => isJsonValue(value)))) throw invalidInput('execute', 'The statement parameters must be a list of JSON values.');
	if (input.idempotent !== undefined && typeof input.idempotent !== 'boolean') throw invalidInput('execute', 'idempotent must be true or false.');
}

/**
 * Check `sql.getSchema`'s input.
 *
 * @param input - The op params.
 * @param input.table - One table, or none for all.
 * @throws ExplorerToolError `invalid` naming what is wrong.
 */
export function checkSchemaInput(input: { table?: unknown }): void {
	if (input.table !== undefined && typeof input.table !== 'string') throw invalidInput('get_schema', 'The table name must be text.');
}

/**
 * How many connections' history the controller follows at once (the
 * `history` topic's keys): the ones read most recently. A history view whose
 * key is dropped reads it again once, which follows it again. With more
 * views open at once than this, a view dropped a second time keeps showing
 * what it last read, without updates, until it is opened again: the views do
 * not take turns, so nothing re-reads forever.
 */
export const MAX_WATCHED_HISTORY_KEYS = 128;

/**
 * The longest prefix of a list whose snapshot fits a budget.
 *
 * @param total - The list's length.
 * @param fits - Whether a snapshot holding the first `kept` items fits.
 * @returns How many to keep.
 */
function longestFittingPrefix(total: number, fits: (kept: number) => boolean): number {
	let lo = 0;
	let hi = total;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(mid)) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * The retained-state guard's shrink hook: an honest, bounded snapshot in
 * place of one over its budget (never the library's generic `truncated` cut,
 * which frames would not act on).
 *
 *   connections   the first records that fit, and `partial: { kept, total }`:
 *                 a frame asks for any other record with `sql.connection`.
 *   history       the most recently read keys that fit: a frame whose key is
 *                 not listed reads it again (remoteHistory.ts).
 *
 * @param topic - The state topic.
 * @param snapshot - The oversize snapshot.
 * @param info - The budget this publish may use.
 * @returns The snapshot to publish instead.
 */
export function shrinkSqlState(topic: string, snapshot: unknown, info: IOversizeInfo): unknown {
	if (topic === 'connections') {
		const state = snapshot as ConnectionsState;
		const total = state.list.length;
		const at = (kept: number): ConnectionsState => ({ ...state, list: state.list.slice(0, kept), partial: { kept, total } });
		return at(longestFittingPrefix(total, (kept) => jsonByteLength(at(kept)) <= info.budgetBytes));
	}
	if (topic === 'history') {
		const state = snapshot as HistoryState;
		const keys = Object.keys(state.keys);
		// Insertion order is oldest read first: keep the newest.
		const at = (kept: number): HistoryState => ({ ...state, keys: Object.fromEntries(keys.slice(keys.length - kept).map((key) => [key, state.keys[key]!])) });
		return at(longestFittingPrefix(keys.length, (kept) => jsonByteLength(at(kept)) <= info.budgetBytes));
	}
	return snapshot;
}

/**
 * Apply one edit a frame asked for.
 *
 * @param store - The controller's history store.
 * @param key - The connection's history key.
 * @param edit - The checked edit.
 */
function applyHistoryEdit(store: SqlHistoryStore, key: string, edit: HistoryEdit): void {
	switch (edit.action) {
		case 'remove': store.removeEntry(key, edit.id); break;
		case 'pin': store.togglePin(key, edit.id); break;
		case 'note': store.setNote(key, edit.id, edit.note); break;
		case 'clear': store.clearForKey(key); break;
		default: store.setRecording(key, edit.on);
	}
}

/**
 * Mount the controller.
 *
 * @param opts - See {@link SqlControllerOptions}.
 * @returns The mount.
 */
export function attachSqlController(opts: SqlControllerOptions): SqlControllerMount {
	/** Set by dispose (declared first: callbacks below may run during the mount). */
	let disposed = false;
	const core = createSqlCore({
		cm: opts.cm,
		appId: SQL_APP_ID,
		mode: 'devtool',
		activeDocKey: opts.activeDocKey ?? null,
		...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}),
		...(opts.clock ? { clock: opts.clock } : {}),
	});

	/**
	 * Refuse a mutation from a frame that does not belong to who is signed in now.
	 *
	 * @param owner - The calling frame's fingerprint.
	 * @param tool - The op.
	 */
	const requireOwner = (owner: string | null | undefined, tool: string): void => {
		const now = core.identity.get().fingerprint;
		const outcome = tool === 'history' ? 'this history was not read' : 'nothing was changed';
		if (now === null) throw new ExplorerToolError({ kind: 'unavailable', tool, message: `Not signed in to a RocketRide server, so ${outcome}.` });
		if (owner !== now) throw new ExplorerToolError({ kind: 'stale', tool, message: `The signed-in account changed since this document opened, so ${outcome}.` });
	};

	// ── History, persisted in the user's file, per identity ──────────────────

	const history = createSqlHistoryStore();
	let storage: HistoryStorage = 'none';
	let historyOwner: string | null = null;
	/** The accessor of the account history is attached to (or loading for). */
	let prefs: IFsPrefs | null = null;
	/**
	 * The previous account's accessor, kept while nobody is vouched for (a
	 * disconnect, a logout, an org switch): its pending write is held, and
	 * lands if the same account is known again while the sidebar is open.
	 * Disposed (its pending write dropped) once a DIFFERENT account is known,
	 * and closed at the final teardown, where a write still held because
	 * nobody is known is dropped.
	 */
	let parked: IFsPrefs | null = null;
	let detachHistory: (() => void) | null = null;
	let offAttachWhenActive: (() => void) | null = null;
	/** Keys frames have read, with the snapshot last seen and its revision. */
	const watched = new Map<string, { entries: unknown; rev: number; recording: boolean }>();
	let publishHistory: () => void = () => undefined;

	/**
	 * One account's history file accessor.
	 *
	 * @param owner - The account's fingerprint.
	 * @returns The accessor (not loaded yet).
	 */
	const historyFile = (owner: string): IFsPrefs => {
		const accessor = createFsPrefs({
			cm: opts.cm,
			path: historyPrefsPath('sql'),
			owner,
			// Who is signed in now: the live fingerprint, or null while nobody is
			// vouched for. The library HOLDS a write while it is null (a
			// reconnected transport may already be another account's before its
			// account is read, and an org switch passes through unknown), lands
			// it once this same account is known again, and drops it once a
			// different one is: nothing of this account's is ever written over a
			// session nobody vouched for, or into another account's file.
			ownerNow: () => {
				const now = core.identity.get();
				return now.known ? now.fingerprint : null;
			},
			onError: (_error, phase) => {
				if (phase !== 'load' || prefs !== accessor) return;
				storage = 'session';
				publishHistory();
			},
		});
		return accessor;
	};

	const followHistoryOwner = (snapshot: IIdentitySnapshot): void => {
		const owner = snapshot.known ? snapshot.fingerprint : null;
		if (owner === historyOwner) return;
		const previous = historyOwner;
		historyOwner = owner;
		// The batch still in the store's debounce goes to the previous account's
		// accessor FIRST: the store's last detach drops it.
		if (previous !== null) history.flush();
		detachHistory?.();
		detachHistory = null;
		if (prefs !== null) {
			if (owner === null) {
				// Nobody is vouched for: keep it (see `parked`).
				parked?.dispose();
				parked = prefs;
			} else {
				// A different account is known: the previous one's write is dropped.
				prefs.dispose();
			}
			prefs = null;
		}
		watched.clear();
		// Forget the previous identity's entries NOW. The store forgets them
		// only when it is attached under another owner, and the file-backed
		// attach below waits for the new identity's file to be read (seconds,
		// with retries): until then a read would answer from memory with the
		// previous account's statements. A sign-out (owner null) forgets too.
		history.attachPrefs(memoryPrefs(), owner)();
		storage = owner === null ? 'none' : 'file';
		offAttachWhenActive?.();
		offAttachWhenActive = null;
		if (owner !== null) {
			// The file is read only once the tool is activated (R7).
			offAttachWhenActive = core.activation.subscribe(() => {
				if (historyOwner === owner && !disposed) attachFile(owner);
			});
		}
		publishHistory();
	};

	/**
	 * Attach the history store to an account's file (once the tool is active).
	 *
	 * @param owner - The account.
	 */
	const attachFile = (owner: string): void => {
		let accessor: IFsPrefs;
		if (parked !== null && parked.owner === owner) {
			// The same account is back: its accessor carries on, and what it
			// still holds is written now.
			accessor = parked;
			parked = null;
			void accessor.flush();
		} else {
			parked?.dispose();
			parked = null;
			accessor = historyFile(owner);
		}
		prefs = accessor;
		// Load FIRST, then attach (the store reads its preferences at attach).
		detachHistory = attachWhenLoaded(accessor, (api, fingerprint) => history.attachPrefs(api, fingerprint));
	};

	const handlers: RequiredControllerHandlers<SqlOps> = {
		'sql.resolveEndpoint': ({ connId }) => core.resolve(connId),
		'sql.releaseEndpoint': async ({ connId, key }) => {
			if (key !== undefined && typeof key !== 'string') throw invalidInput('release', 'The endpoint key must be text.');
			await core.release(connId, key);
		},
		'sql.discoverEndpoints': () => core.pickable(),
		'sql.execute': ({ connId, sql, params, idempotent }) => {
			checkExecuteInput({ sql, params, idempotent });
			return core.withSession(connId, async (session, ctx) => {
				// Classified with the node's own dialect (asked for when no probe has
				// it); with none, the gate fails closed: sent once, never repeated.
				const gate = gateStatement(sql, await ctx.dialect(), idempotent === true);
				if (gate.refusal !== null) throw new ExplorerToolError({ kind: 'invalid', tool: 'execute', message: gate.refusal });
				return session.execute(sql, { ...(params && params.length > 0 ? { params } : {}), idempotent: gate.idempotent });
			}, 'execute');
		},
		'sql.getSchema': ({ connId, table }) => {
			checkSchemaInput({ table });
			return core.withSession(connId, (session) => session.getSchema(table), 'get_schema');
		},
		'sql.refreshSchema': ({ connId }) => core.withSession(connId, (session) => session.refreshSchema(), 'refresh_schema'),
		'sql.dialect': ({ connId }) => core.withSession(connId, (session) => session.dialect(), 'dialect'),
		'sql.getService': async ({ provider }) => {
			if (typeof provider !== 'string' || provider === '') throw invalidInput('get_service', 'The provider must be a name.');
			return (await core.getService(provider)) as JsonValue;
		},
		'sql.validate': async ({ pipeline }) => {
			if (pipeline === null || typeof pipeline !== 'object' || Array.isArray(pipeline) || Object.getPrototypeOf(pipeline) !== Object.prototype) throw invalidInput('validate', 'The pipeline must be an object.');
			return (await core.validate(pipeline)) as JsonValue;
		},
		'sql.envKeys': () => core.envKeys(),
		'sql.connection': ({ connId }) => core.connection(connId),
		'sql.saveConnection': async ({ connection, owner }) => {
			requireOwner(owner, 'saveConnection');
			// Checked again where the list changes: the account may change while
			// the list is still being read.
			await core.saveConnection(connection, () => requireOwner(owner, 'saveConnection'));
		},
		'sql.deleteConnection': async ({ connId, owner }) => {
			requireOwner(owner, 'deleteConnection');
			await core.deleteConnection(connId, () => requireOwner(owner, 'deleteConnection'));
		},
		'sql.history': async ({ connId, owner }) => {
			// Only the frame's own account's history, checked again after the
			// lookup: a frame bound to A never reads B's statements.
			requireOwner(owner, 'history');
			const key = await core.keyOf(connId);
			requireOwner(owner, 'history');
			const seen = watched.get(key);
			if (seen) {
				// Most recently read last (the eviction order).
				watched.delete(key);
				watched.set(key, seen);
			} else {
				watched.set(key, { entries: history.getHistory(key), rev: 1, recording: history.getRecording(key) });
				for (const oldest of watched.keys()) {
					if (watched.size <= MAX_WATCHED_HISTORY_KEYS) break;
					watched.delete(oldest);
				}
				publishHistory();
			}
			return history.getHistory(key) as HistoryEntry[];
		},
		'sql.historyRecord': async ({ connId, entry, owner }) => {
			requireOwner(owner, 'historyRecord');
			const key = await core.keyOf(connId);
			// Again after the lookup: the run must land in its own account's history.
			requireOwner(owner, 'historyRecord');
			history.runs.emitRun(key, checkHistoryEntry(entry));
		},
		'sql.historyEdit': async ({ connId, edit, owner }) => {
			requireOwner(owner, 'historyEdit');
			const key = await core.keyOf(connId);
			requireOwner(owner, 'historyEdit');
			applyHistoryEdit(history, key, checkHistoryEdit(edit));
		},
	};

	// The channel first (the host's, or one per peer), then exactly one op
	// server, inside the caller's effect (R6).
	const attached = attachController<SqlOps>({
		peer: opts.peer,
		...(opts.channel ? { channel: opts.channel } : {}),
		createToolChannel: opts.protocol.createToolChannel,
		createToolOpServer: opts.protocol.createToolOpServer,
		handlers,
		...(opts.now ? { now: opts.now } : {}),
		...(opts.onRefused ? { onRefused: opts.onRefused } : {}),
		// The first op from a frame is an activation (R7).
		onFirstOp: () => core.activation.open('op'),
	});

	// Retained state, within 64 KiB per topic and 128 KiB together (identity
	// included): an oversize snapshot is replaced by an honest bounded one
	// (shrinkSqlState), never dropped silently.
	const guarded = guardRetainedState(attached.channel, {
		shrink: shrinkSqlState,
		onOversize: (error) => console.log(`[sql-ui] state '${error.topic}' ${error.outcome === 'degraded' ? 'was published in part' : 'was not published'}:`, error.message),
	});
	const state = sqlChannel(guarded);
	const publishConnections = (): void => state.publishState('connections', connectionsState());
	publishConnections();
	const offConnections = subscribeSavedConnections(publishConnections);
	const offIdentity = publishIdentityState(guarded, core.identity);

	// History revisions: a key's revision moves whenever its list or its
	// switch changes, so frames know to read it again.
	publishHistory = (): void => {
		const keys: HistoryState['keys'] = {};
		for (const [key, seen] of watched) keys[key] = { rev: seen.rev, recording: seen.recording };
		state.publishState('history', { storage, keys });
	};
	const offHistory = history.subscribe(() => {
		let changed = false;
		for (const [key, seen] of watched) {
			const entries = history.getHistory(key);
			const recording = history.getRecording(key);
			if (entries === seen.entries && recording === seen.recording) continue;
			watched.set(key, { entries, rev: seen.rev + 1, recording });
			changed = true;
		}
		if (changed) publishHistory();
	});
	followHistoryOwner(core.identity.get());
	const offHistoryOwner = core.identity.subscribe(followHistoryOwner);

	// ── Frame -> sidebar feeds (idempotent hints) ───────────────────────────

	const activeSubs = new Set<(key: string | null) => void>();
	const errorSubs = new Set<(message: string) => void>();
	let activeKey: string | null = null;
	const offActive = state.onEvent('active', (payload) => {
		activeKey = typeof payload === 'string' ? payload : null;
		activeSubs.forEach((fn) => fn(activeKey));
	});
	const offError = state.onEvent('openError', (payload) => {
		errorSubs.forEach((fn) => fn(String(payload)));
	});

	// ── The sidebar's actions (each one a user action: it activates) ────────

	const bridge: SqlSidebarBridge = {
		// Hosts open the connection's OWN top-level tab through documents.
		openConnection: (conn) => {
			core.activation.open('user');
			opts.documents?.open(conn.id, conn.name);
		},
		openConnectionEditor: (editing) => {
			core.activation.open('user');
			opts.documents?.open(connectionEditorDocKey(editing?.id ?? null), editing ? `Edit ${editing.name}` : 'New Connection');
		},
		deleteConnection: (conn) => {
			core.activation.open('user');
			void core.deleteConnection(conn.id).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				errorSubs.forEach((fn) => fn(message));
			});
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

	return {
		bridge,
		core,
		history,
		channel: attached.channel,
		noteActiveDocKey: (key) => core.activation.noteActiveDocKey(key),
		dispose() {
			if (disposed) return;
			disposed = true;
			attached.dispose();
			offConnections();
			offIdentity();
			offHistory();
			offHistoryOwner();
			// Unmounting: write the batch still in the store's debounce FIRST (the
			// last detach drops it), then let each accessor write what it holds,
			// and stop. A write held because nobody is vouched for (a VS Code
			// disconnect unmounts the controller after the account is gone), or
			// one the server cannot take now, is dropped.
			offAttachWhenActive?.();
			history.flush();
			detachHistory?.();
			void prefs?.close();
			void parked?.close();
			parked = null;
			offActive();
			offError();
			activeSubs.clear();
			errorSubs.clear();
			core.dispose();
		},
	};
}
