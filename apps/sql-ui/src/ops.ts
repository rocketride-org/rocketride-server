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
// Frames hold NO RocketRide client: a frame awaits
// `call('sql.execute', …)` and the tool's sidebar controller executes it on
// its single server connection (see sqlBridge.ts for the serving side,
// sqlEnv.ts for the frame-side SqlEnv built over these).
//
// Own module (types only) so sqlEnv and sqlBridge can both import the
// vocabulary without a cycle. Connection reachability rides the shell's
// `host:connection` system topic — not a sql-ui-specific vocabulary.
// =============================================================================

import type { ToolOpMap, ToolOpSpec, ToolStateMap, ToolEventMap } from 'shell';
import type { SqlEndpoint, SqlExecuteResult, SqlSchemaResponse, SavedSqlConnection, SqlDialect } from './connect';

/** The sql tool's op map — private to this tool. */
export interface SqlOps extends ToolOpMap {
	// ── Connection lifecycle ─────────────────────────────────────────────────
	/** Resolve a saved connection to a live endpoint (direct mode starts or
	 *  reattaches its temp tool pipeline — the controller owns the revival). */
	'sql.resolveEndpoint': ToolOpSpec<{ connId: string }, SqlEndpoint>;
	/** Stop a direct connection's temp pipeline, best effort (no-op for
	 *  non-direct keys). Fire-and-forget callers may ignore the result. */
	'sql.releaseEndpoint': ToolOpSpec<{ key: string }, void>;
	/** Discover database endpoints across the server's running pipelines
	 *  (the New Connection dialog's pipeline path). */
	'sql.discoverEndpoints': ToolOpSpec<Record<string, never>, SqlEndpoint[]>;
	// ── Session tools (SqlSession, one op per method) ───────────────────────
	/** Execute one statement against an endpoint. */
	'sql.execute': ToolOpSpec<{ endpoint: SqlEndpoint; sql: string; params?: unknown[]; idempotent?: boolean }, SqlExecuteResult>;
	/** Read the endpoint's (task-start) schema reflection. */
	'sql.getSchema': ToolOpSpec<{ endpoint: SqlEndpoint; table?: string }, SqlSchemaResponse>;
	/** Ask the node to re-reflect the database (falls back to the task-start
	 *  snapshot, flagged `stale`, when the node cannot). */
	'sql.refreshSchema': ToolOpSpec<{ endpoint: SqlEndpoint }, SqlSchemaResponse>;
	/** Report the endpoint's SQL dialect. */
	'sql.dialect': ToolOpSpec<{ endpoint: SqlEndpoint }, SqlDialect>;
	// ── Connection editor support ────────────────────────────────────────────
	/** Fetch one service definition (the direct path's config schema). */
	'sql.getService': ToolOpSpec<{ provider: string }, unknown>;
	/** Validate a single-component pipeline payload server-side. */
	'sql.validate': ToolOpSpec<{ pipeline: Record<string, unknown> }, unknown>;
	/** Environment-variable names for the config form's `${}` autocomplete. */
	'sql.envKeys': ToolOpSpec<Record<string, never>, string[]>;
}

/** The sql tool's state topics (controller → documents). */
export interface SqlStateMap extends ToolStateMap {
	/** The saved-connection list, replicated to every document realm. */
	connections: SavedSqlConnection[];
}

/** The sql tool's events. */
export interface SqlEventMap extends ToolEventMap {
	/** Editor save, handed to the controller realm to commit. */
	saveConnection: SavedSqlConnection;
	/** Open/resolve failure message, surfaced to the sidebar. */
	openError: string;
	/** The frame realm's active endpoint key (activeDocKey fallback). */
	active: string | null;
}

// Re-exported so op consumers get arg types without reaching into connect/.
export type { SavedSqlConnection };
