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
 * a "connection" binds to. Purely descriptive: holds no token or client state.
 */
export interface ISqlEndpoint {
	/** Stable identity for lists/maps: `${projectId}:${source}:${nodeId}`. */
	key: string;
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
	/** Component provider, e.g. 'db_mysql', 'db_postgres', 'db_clickhouse'. */
	provider: string;
	/** Whether the owning task was running at discovery time. */
	running: boolean;
}

// =============================================================================
// TOOL RESULTS
// =============================================================================

/** Result of executing a raw SQL statement on a database node. */
export interface ISqlExecuteResult {
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
export interface ISqlSchemaColumn {
	/** Column name. */
	column: string;
	/** Engine-reported datatype string (e.g. 'VARCHAR(255)', 'BIGINT'). */
	type: string;
}

/** One foreign key in a reflected table schema (get_schema wire format). */
export interface ISqlSchemaForeignKey {
	/** Constrained (local) column names. */
	columns: string[];
	/** Referenced table name. */
	referred_table: string;
	/** Referenced column names. */
	referred_columns: string[];
}

/** Reflected schema for one table (get_schema wire format). */
export interface ISqlSchemaTable {
	/** Columns in engine order. */
	columns: ISqlSchemaColumn[];
	/** Primary key column names (present only when the table has one). */
	primary_key?: string[];
	/** Foreign keys declared on this table (present only when any exist). */
	foreign_keys?: ISqlSchemaForeignKey[];
}

/** Response of the node's `get_schema` / `refresh_schema` tools. */
export interface ISqlSchemaResponse {
	/** Database name the node is attached to. */
	database?: string;
	/** Reflected tables keyed by table name. */
	tables?: Record<string, ISqlSchemaTable>;
	/** Error message when reflection failed. */
	error?: string;
	/**
	 * True when this response was served from the node's TASK-START snapshot
	 * and may therefore not reflect DDL run since. Set by
	 * {@link ISqlSession.refreshSchema} when the node has no `refresh_schema`
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
export interface ISqlSession {
	/** The endpoint this session is bound to. */
	readonly endpoint: ISqlEndpoint;
	/**
	 * Execute a raw SQL statement (requires `allow_execute` on the node).
	 *
	 * Values belong in `opts.params`, not in the statement: the node binds
	 * them through the driver, so nothing the user typed is ever parsed as
	 * SQL. Reference them positionally as `$1..$n`.
	 *
	 * A session's cached task token goes stale whenever the owning task
	 * restarts, and a stale token fails INDISTINGUISHABLY from a statement
	 * the database refused. Retrying is therefore only safe when re-running
	 * the statement is harmless: pass `idempotent` for reads, and leave it
	 * unset for anything that writes. A non-idempotent failure surfaces as-is
	 * — a silently re-sent INSERT is worse than an error the caller can see.
	 *
	 * @param sql - The statement to execute.
	 * @param opts - Optional execution options.
	 * @param opts.params - Positional bind values for `$1..$n`.
	 * @param opts.idempotent - Allow ONE retry with a re-resolved task token.
	 *                          Only for statements that are safe to re-run.
	 * @returns Rows and affected-row count.
	 */
	execute(sql: string, opts?: { params?: unknown[]; idempotent?: boolean }): Promise<ISqlExecuteResult>;
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
	getSchema(table?: string): Promise<ISqlSchemaResponse>;
	/**
	 * Re-reflect the attached database and return the fresh schema.
	 *
	 * ANY failure of the refresh tool falls back to `getSchema` — the engine
	 * gives no reliable way to tell "this node has no such tool" apart from
	 * any other failure, and matching on error text would break the moment
	 * the wording changed. The response then carries
	 * {@link ISqlSchemaResponse.stale} so callers can tell the user the
	 * schema may be out of date rather than showing a post-DDL snapshot as
	 * if it were current.
	 *
	 * @returns The reflected schema, flagged `stale` when it came from the
	 *          fallback.
	 */
	refreshSchema(): Promise<ISqlSchemaResponse>;
	/**
	 * Report the engine dialect of the attached database.
	 *
	 * @returns The dialect identifier.
	 */
	dialect(): Promise<SqlDialect>;
}

// =============================================================================
// PROBE
// =============================================================================

/** Result of probing an endpoint before binding a session to it. */
export interface ISqlProbeResult {
	/** Whether the endpoint answered both probe calls. */
	ok: boolean;
	/** Reported dialect ('unknown' when the probe failed). */
	dialect: SqlDialect;
	/** Database name, when schema reflection succeeded. */
	database?: string;
	/** Number of tables reported by schema reflection. */
	tableCount?: number;
	/** Failure detail when ok is false. */
	error?: string;
}
