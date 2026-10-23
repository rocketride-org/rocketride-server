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
// SQL-UI PROTOCOL — frames ask, the controller executes
// =============================================================================
//
// The tool's whole wire vocabulary as protocol maps (shell ToolOpMap /
// ToolStateMap / ToolEventMap pattern): ops a DOCUMENT FRAME calls, the
// state topics the controller publishes, and the events either side sends.
// Frames hold NO RocketRide client: a frame awaits a `sql.*` op and the
// tool's sidebar controller executes it on its single engine connection (see
// sqlBridge.ts for both sides, sqlEnv.ts for the frame-side SqlEnv built over
// these).
//
// The rules every op follows (R2, R3, R4):
//
//   - It names a saved connection by its id (`connId`). No endpoint object,
//     no owner-aware `k1|…` key and no task token ever travels from a frame;
//     what travels back is the token-free SqlEndpoint.
//   - Its params carry `deadlineAt` (the frame's now + its timeout): the
//     controller refuses, without running it, a call that arrives after it.
//   - It answers a Reply: a failure (the node's, the database's, "not
//     running", "not signed in") is DATA with its kind and code, rebuilt in
//     the frame as the same ExplorerToolError. A void op answers Reply<null>.
//   - Every argument and result survives a JSON round trip (VS Code carries
//     them through postMessage).
//   - Every mutation is an op (saving and deleting a connection), never an
//     event: an event can be delivered twice and replayed on a remount.
//     Event names and op names stay disjoint.
//
// Own module (types only) so sqlEnv and sqlBridge can both import the
// vocabulary without a cycle. Connection reachability rides the shell's
// `host:connection` system topic — not a sql-ui-specific vocabulary.
// =============================================================================

import type { ToolOpMap, ToolOpSpec, ToolStateMap, ToolEventMap } from 'shell';
import type { IDeadline } from 'shared/explorer/devtool/deadline';
import type { JsonValue, Reply } from 'shared/explorer/devtool/reply';
import type { IIdentityState } from 'shared/explorer/devtool/frameIdentity';
import type { SqlEndpoint, SqlExecuteResult, SqlSchemaResponse, SavedSqlConnection, SavedConnectionsStatus, SqlDialect } from './connect';
import type { HistoryEdit, HistoryStorage } from './history/api';
import type { HistoryEntry } from './history/types';

/**
 * Who a mutation was made for: the identity fingerprint the calling frame
 * belongs to (the first one its identity guard saw). The controller refuses
 * the mutation when that is not who is signed in now.
 */
export interface IOwnedCall {
	/** The calling frame's identity fingerprint, or null before it saw one. */
	owner: string | null;
}

/** The sql tool's op map — private to this tool. */
export interface SqlOps extends ToolOpMap {
	// ── Connection lifecycle ─────────────────────────────────────────────────
	/** Resolve a saved connection to its running endpoint (direct mode starts
	 *  or reattaches its temp pipeline — the controller owns it). */
	'sql.resolveEndpoint': ToolOpSpec<IDeadline & { connId: string }, Reply<SqlEndpoint>>;
	/** Stop a direct connection's temp pipeline, best effort (no-op for a
	 *  pipeline connection). Fire-and-forget callers may ignore the result. */
	'sql.releaseEndpoint': ToolOpSpec<IDeadline & { connId: string; key?: string }, Reply<null>>;
	/** The New Connection picker's list: discovered endpoints a pipeline
	 *  connection can be saved for (the caller's own development runs). */
	'sql.discoverEndpoints': ToolOpSpec<IDeadline, Reply<SqlEndpoint[]>>;
	// ── Session tools (SqlSession, one op per method) ───────────────────────
	/** Execute one statement on a connection. The controller classifies it
	 *  again: transaction control is refused, and only a read may be retried. */
	'sql.execute': ToolOpSpec<IDeadline & { connId: string; sql: string; params?: JsonValue[]; idempotent?: boolean }, Reply<SqlExecuteResult>>;
	/** Read the connection's (task-start) schema reflection. */
	'sql.getSchema': ToolOpSpec<IDeadline & { connId: string; table?: string }, Reply<SqlSchemaResponse>>;
	/** Ask the node to re-reflect the database (falls back to the task-start
	 *  snapshot, flagged `stale`, when the node cannot). */
	'sql.refreshSchema': ToolOpSpec<IDeadline & { connId: string }, Reply<SqlSchemaResponse>>;
	/** Report the connection's SQL dialect. */
	'sql.dialect': ToolOpSpec<IDeadline & { connId: string }, Reply<SqlDialect>>;
	// ── Connection editor support ────────────────────────────────────────────
	/** Fetch one service definition (the direct path's config schema). */
	'sql.getService': ToolOpSpec<IDeadline & { provider: string }, Reply<JsonValue>>;
	/** Validate a single-component pipeline payload server-side. */
	'sql.validate': ToolOpSpec<IDeadline & { pipeline: { [key: string]: JsonValue } }, Reply<JsonValue>>;
	/** Environment-variable names for the config form's `${}` autocomplete. */
	'sql.envKeys': ToolOpSpec<IDeadline, Reply<string[]>>;
	/**
	 * One saved connection by id (null: no such connection). Frames ask for it
	 * when the published list is partial (`ConnectionsState.partial`) and the
	 * record they need is not in it.
	 */
	'sql.connection': ToolOpSpec<IDeadline & { connId: string }, Reply<SavedSqlConnection | null>>;
	// ── Saved-connection mutations (the controller owns the list) ───────────
	/** Insert or replace a saved connection (the editor document's save). */
	'sql.saveConnection': ToolOpSpec<IDeadline & IOwnedCall & { connection: SavedSqlConnection }, Reply<null>>;
	/** Delete a saved connection (a direct one's temp pipeline is stopped first, best effort). */
	'sql.deleteConnection': ToolOpSpec<IDeadline & IOwnedCall & { connId: string }, Reply<null>>;
	// ── History (the controller owns it; frames read and edit through these) ──
	/** One connection's history entries, newest first (bulk: an op result, never retained state); only for the frame's own account. */
	'sql.history': ToolOpSpec<IDeadline & IOwnedCall & { connId: string }, Reply<HistoryEntry[]>>;
	/** Record one finished statement (dropped when recording is off for the connection). */
	'sql.historyRecord': ToolOpSpec<IDeadline & IOwnedCall & { connId: string; entry: HistoryEntry }, Reply<null>>;
	/** Edit one connection's history: delete, pin, note, clear, or the recording switch. */
	'sql.historyEdit': ToolOpSpec<IDeadline & IOwnedCall & { connId: string; edit: HistoryEdit }, Reply<null>>;
}

/** The saved-connection list as the controller publishes it. */
export interface ConnectionsState {
	/** 'ready' once the controller has read the list for the signed-in identity. */
	status: SavedConnectionsStatus;
	/** The list (empty unless ready); only its first `partial.kept` records when partial. */
	list: SavedSqlConnection[];
	/**
	 * Null when `list` is the whole list. Otherwise the whole list did not fit
	 * the retained-state budget: `list` holds its first `kept` of `total`
	 * records, and a frame asks for any other record with `sql.connection`
	 * (it never reports a connection missing from a partial list as gone).
	 */
	partial: { kept: number; total: number } | null;
}

/**
 * What frames need to follow history without holding it: where it is kept,
 * and, per connection a frame has read, a revision that moves on every change
 * plus the recording switch. The entries themselves are an op result
 * (`sql.history`): a history bag (up to 256 KB) does not fit the retained
 * state cap. The keys are bounded: the controller follows the connections
 * read most recently (MAX_WATCHED_HISTORY_KEYS); a view whose key is no
 * longer listed reads it again once, which lists it again (a view dropped a
 * second time keeps what it last read until it is opened again).
 */
export interface HistoryState {
	/** Where the controller keeps history (the privacy line says so). */
	storage: HistoryStorage;
	/** Per endpoint key a frame has read: the revision and the recording switch. */
	keys: Record<string, { rev: number; recording: boolean }>;
}

/** The sql tool's state topics (controller → documents). Fixed topics; never one per document. */
export interface SqlStateMap extends ToolStateMap {
	/** The saved-connection list, replicated to every document realm. */
	connections: ConnectionsState;
	/** History revisions and switches (entries travel as op results). */
	history: HistoryState;
	/** Who the controller vouches for (the fingerprint only; R9). */
	identity: IIdentityState;
}

/** The sql tool's events: idempotent hints only. */
export interface SqlEventMap extends ToolEventMap {
	/** A document could not open its connection: the message, for the sidebar's error line. */
	openError: string;
	/** The frame realm's active endpoint key (activeDocKey fallback). */
	active: string | null;
}

// Re-exported so op consumers get arg types without reaching into connect/.
export type { SavedSqlConnection };
