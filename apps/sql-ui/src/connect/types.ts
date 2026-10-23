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
// CONNECT — TYPES (the app-facing contract of the connection layer)
// =============================================================================
//
// EVERYTHING that knows how SQL Explorer attaches to a database — task
// discovery, token resolution, node binding, tool invocation — lives in this
// connect/ module and is consumed ONLY through the interfaces below. The
// attach mechanics are expected to change; when they do, only connect/
// changes, never the views, panels, or canvas.
// =============================================================================

import type { IGenerationTicket } from 'shared/explorer/generation';

// =============================================================================
// DIALECT
// =============================================================================

/**
 * Engine dialect reported by a database node. `unknown` covers engines the
 * node reports that this app has no specific handling for (they still work
 * through the generic SQL paths).
 */
export type SqlDialect = 'mysql' | 'postgres' | 'clickhouse' | 'neo4j' | 'unknown';

// =============================================================================
// ENDPOINT
// =============================================================================

/**
 * One reachable database tool node inside a running pipeline task — the unit
 * a "connection" binds to. Purely descriptive and JSON-safe: it holds NO task
 * token and no client state (tokens live only in the endpoint store's vault,
 * in the realm that owns the engine connection), so it may travel to a
 * dev-tool frame.
 */
export interface SqlEndpoint {
	/**
	 * Stable identity for lists, maps, history and document URIs:
	 * `${projectId}:${source}:${nodeId}` (for a direct connection
	 * `sqlconn-<id>:tools_1:<provider>_1`). It is the endpoint store's
	 * `legacyKey`, never its owner-aware `k1|…` key.
	 */
	key: string;
	/**
	 * The saved connection this endpoint was resolved from. Every engine call
	 * names the connection by this id (never by the endpoint itself). Absent
	 * only on a New Connection picker entry, which is not opened directly.
	 */
	connId?: string;
	/** Project (pipeline) identifier the task was started from. */
	projectId: string;
	/** Task display name (pipeline filename or config name). */
	pipelineName: string;
	/** Source component id of the task — needed to resolve the task token. */
	source: string;
	/** The database component id inside the pipeline (tool call target). */
	nodeId: string;
	/** Display name of the database component (falls back to nodeId). */
	nodeName: string;
	/** Component provider, e.g. 'db_mysql', 'db_postgres', 'db_clickhouse', 'rocketride_sql'. */
	provider: string;
	/** Whether the owning task was running at discovery time. */
	running: boolean;
}

// =============================================================================
// TOOL RESULTS
// =============================================================================

/** Result of executing a raw SQL statement on a database node. */
export interface SqlExecuteResult {
	/** Result rows (empty for non-SELECT statements). */
	rows: Record<string, unknown>[];
	/** Rows affected by INSERT/UPDATE/DELETE (0 for SELECT). */
	affected_rows: number;
}

/**
 * One column in a reflected table schema. Shape matches the node's
 * `get_schema` wire format (db_instance_base.get_schema): name + SQL type
 * only — nullability/defaults arrive later via INFORMATION_SCHEMA queries.
 */
export interface SqlSchemaColumn {
	/** Column name. */
	column: string;
	/** Engine-reported datatype string (e.g. 'VARCHAR(255)', 'BIGINT'). */
	type: string;
}

/** One foreign key in a reflected table schema (get_schema wire format). */
export interface SqlSchemaForeignKey {
	/** Constrained (local) column names. */
	columns: string[];
	/** Referenced table name. */
	referred_table: string;
	/** Referenced column names. */
	referred_columns: string[];
}

/** Reflected schema for one table (get_schema wire format). */
export interface SqlSchemaTable {
	/** Columns in engine order. */
	columns: SqlSchemaColumn[];
	/** Primary key column names (present only when the table has one). */
	primary_key?: string[];
	/** Foreign keys declared on this table (present only when any exist). */
	foreign_keys?: SqlSchemaForeignKey[];
}

/** Response of the node's `get_schema` / `refresh_schema` tools. */
export interface SqlSchemaResponse {
	/** Database name the node is attached to. */
	database?: string;
	/** Reflected tables keyed by table name. */
	tables?: Record<string, SqlSchemaTable>;
	/** Error message when reflection failed. */
	error?: string;
	/**
	 * True when this response was served from the node's TASK-START snapshot
	 * and may therefore not reflect DDL run since. Set by
	 * {@link SqlSession.refreshSchema} when the node has no `refresh_schema`
	 * tool and the call fell back to `get_schema`; `get_schema` itself always
	 * serves that snapshot and never sets the flag.
	 */
	stale?: boolean;
}

// =============================================================================
// SESSION
// =============================================================================

/**
 * A live, bound conversation with one database endpoint. The ONLY surface the
 * rest of the app uses to talk to a database — obtained via createSqlSession.
 */
export interface SqlSession {
	/** The endpoint this session is bound to. */
	readonly endpoint: SqlEndpoint;
	/**
	 * Execute a raw SQL statement (requires `allow_execute` on the node).
	 *
	 * Values belong in `opts.params`, not in the statement: the node binds
	 * them through the driver, so nothing the user typed is ever parsed as
	 * SQL. Reference them positionally as `$1..$n`.
	 *
	 * A statement is sent again in one case only: the engine refused it with
	 * `TASK_STOPPED` (its task is stopping or restarting), which it raises
	 * BEFORE the statement reaches the node, and re-discovery then finds the
	 * same endpoint running again within the call's budget. Even so the retry
	 * is opt-in: pass `idempotent` for reads, and leave it unset for anything
	 * that writes. Any other failure, and every failure of a non-idempotent
	 * call, surfaces as-is — a silently re-sent INSERT is worse than an error
	 * the caller can see.
	 *
	 * @param sql - The statement to execute.
	 * @param opts - Optional execution options.
	 * @param opts.params - Positional bind values for `$1..$n`.
	 * @param opts.idempotent - Allow the ONE retry after a pre-dispatch
	 *                          `TASK_STOPPED` refusal. Only for statements the
	 *                          caller classifies as reads.
	 * @param opts.generation - The caller's ticket for this request. Once it
	 *                          expires (Stop waiting, a newer request, the view
	 *                          closing, a change of account) nothing more is
	 *                          sent for the call and its answer or failure is
	 *                          dropped as `stale`. It never leaves the realm
	 *                          that made it: in a dev-tool frame it is checked
	 *                          by the frame's remote session (a function cannot
	 *                          cross the op channel), so there it stops the
	 *                          frame's own send and drops the answer, while the
	 *                          controller's one retry cannot see it.
	 * @returns Rows and affected-row count.
	 */
	execute(sql: string, opts?: { params?: unknown[]; idempotent?: boolean; generation?: IGenerationTicket }): Promise<SqlExecuteResult>;
	/**
	 * Reflect the schema of the attached database (or a single table).
	 *
	 * The node reflects once at task start and serves that snapshot, so DDL
	 * run since will NOT appear here — use {@link refreshSchema} after a
	 * schema change.
	 *
	 * @param table - Optional table name to reflect just one table.
	 * @returns The reflected schema.
	 */
	getSchema(table?: string): Promise<SqlSchemaResponse>;
	/**
	 * Re-reflect the attached database and return the fresh schema.
	 *
	 * ANY failure of the refresh tool falls back to `getSchema` — the engine
	 * gives no reliable way to tell "this node has no such tool" apart from
	 * any other failure, and matching on error text would break the moment
	 * the wording changed. The response then carries
	 * {@link SqlSchemaResponse.stale} so callers can tell the user the
	 * schema may be out of date rather than showing a post-DDL snapshot as
	 * if it were current.
	 *
	 * @returns The reflected schema, flagged `stale` when it came from the
	 *          fallback.
	 */
	refreshSchema(): Promise<SqlSchemaResponse>;
	/**
	 * Report the engine dialect of the attached database.
	 *
	 * @returns The dialect identifier.
	 */
	dialect(): Promise<SqlDialect>;
}
