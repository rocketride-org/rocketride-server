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
// SESSION — the database tool surface of one endpoint, by address (plan 3.6)
//
// Every call is a standalone tool borrow on the endpoint's ADDRESS: the
// server resolves the publication (or the caller's own run) that answers it,
// starts a dormant engine, runs the one call on the node and releases. There
// is no token to resolve and nothing to keep alive; a direct connection's
// temp pipeline is the one thing that can vanish, and its revival is retried
// once for idempotent calls.
// =============================================================================

import type { RocketRideClient } from 'rocketride';
import { revivalFor } from './resolver';
import type {
	SqlEndpoint,
	SqlExecuteResult,
	SqlProbeResult,
	SqlSchemaResponse,
	SqlSession,
	SqlDialect,
} from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Dialects the editor knows; anything else is `unknown`. */
const KNOWN_DIALECTS: ReadonlySet<string> = new Set(['mysql', 'postgres', 'clickhouse', 'neo4j']);

/**
 * Normalise a `dialect` tool answer.
 *
 * @param value - The tool's `dialect` field.
 * @returns A known dialect or `unknown`.
 */
function toDialect(value: unknown): SqlDialect {
	return typeof value === 'string' && KNOWN_DIALECTS.has(value) ? (value as SqlDialect) : 'unknown';
}

// =============================================================================
// SESSION
// =============================================================================

/**
 * The tool surface of one endpoint over the SDK's standalone tool call.
 */
class SqlToolSession implements SqlSession {
	readonly endpoint: SqlEndpoint;
	private readonly client: RocketRideClient;

	constructor(client: RocketRideClient, endpoint: SqlEndpoint) {
		this.client = client;
		this.endpoint = endpoint;
	}

	/**
	 * One tool borrow on the endpoint's address.
	 *
	 * A failed idempotent call on a direct connection revives its temp
	 * pipeline once and retries: the 15-minute idle ttl can have ended it
	 * between two statements. Anything else surfaces as thrown.
	 *
	 * @param tool - Tool name (execute / get_schema / refresh_schema / dialect).
	 * @param input - Tool arguments.
	 * @param retryAfterRevival - Whether a revival retry is safe for this call.
	 * @returns The tool's answer.
	 */
	private async invoke<T>(tool: string, input: Record<string, unknown>, retryAfterRevival: boolean): Promise<T> {
		const call = (): Promise<T> =>
			this.client.tool<T>({ address: this.endpoint.address, tool, nodeId: this.endpoint.nodeId, input });
		try {
			return await call();
		} catch (err) {
			const revive = retryAfterRevival ? revivalFor(this.endpoint.key) : undefined;
			if (!revive) throw err;
			await revive();
			return await call();
		}
	}

	async execute(sql: string, opts?: { params?: unknown[]; idempotent?: boolean }): Promise<SqlExecuteResult> {
		const params = opts?.params;
		const input = params && params.length > 0 ? { sql, params } : { sql };
		return this.invoke<SqlExecuteResult>('execute', input, opts?.idempotent === true);
	}

	async getSchema(table?: string): Promise<SqlSchemaResponse> {
		return this.invoke<SqlSchemaResponse>('get_schema', table ? { table } : {}, true);
	}

	async refreshSchema(): Promise<SqlSchemaResponse> {
		try {
			return await this.invoke<SqlSchemaResponse>('refresh_schema', {}, true);
		} catch {
			// Older nodes without refresh_schema: the cached schema, marked stale
			const schema = await this.getSchema();
			return { ...schema, stale: true };
		}
	}

	async dialect(): Promise<SqlDialect> {
		const result = await this.invoke<{ dialect?: string }>('dialect', {}, true);
		return toDialect(result?.dialect);
	}
}

// =============================================================================
// FACTORY + PROBE
// =============================================================================

/**
 * A session for one endpoint.
 *
 * @param client - The realm's client.
 * @param endpoint - The endpoint to talk to.
 * @returns The session.
 */
export function createSqlSession(client: RocketRideClient, endpoint: SqlEndpoint): SqlSession {
	return new SqlToolSession(client, endpoint);
}

/**
 * Try the endpoint: dialect and schema in one round. The first call on a
 * dormant pipe starts its engine, so this is also what warms a connection.
 *
 * @param client - The realm's client.
 * @param endpoint - The endpoint to probe.
 * @returns The outcome, never thrown.
 */
export async function probeSqlEndpoint(client: RocketRideClient, endpoint: SqlEndpoint): Promise<SqlProbeResult> {
	const session = createSqlSession(client, endpoint);
	try {
		const dialect = await session.dialect();
		const schema = await session.getSchema();
		if (schema.error) {
			return { ok: false, dialect, error: schema.error };
		}
		return {
			ok: true,
			dialect,
			database: schema.database,
			tableCount: schema.tables ? Object.keys(schema.tables).length : 0,
		};
	} catch (err) {
		return { ok: false, dialect: 'unknown', error: err instanceof Error ? err.message : String(err) };
	}
}
