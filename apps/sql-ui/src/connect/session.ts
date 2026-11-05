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
// CONNECT — SESSION (tool invocation bound to one endpoint)
// =============================================================================
//
// A thin SQL face over the shared tool session
// (shared/explorer/connect/session): it drives the node's shared SQL tools
// (execute / get_schema / refresh_schema / dialect) through the endpoint
// store, which owns the task token. The SqlSession contract is unchanged.
//
// Retry is no longer "a fresh token lookup returned a different token" (task
// tokens are deterministic, so that never fired after a restart). It is the
// shared rule: one retry, idempotent tools only, only on the server's
// TASK_STOPPED code, and only after re-discovery finds the SAME endpoint
// running again. `execute` is repeated only when the caller marks the
// statement a read.
//
// It runs where the engine connection is: the full app's realm, or the dev
// tool's CONTROLLER. A dev-tool frame never holds one (sqlEnv.ts REMOTE).
//
// Port of f63da6e22 (connect/session.ts).
// =============================================================================

import { isStaleError } from 'shared/explorer/errors';
import type { IToolSession } from 'shared/explorer/connect/session';
import type { IGenerationTicket } from 'shared/explorer/generation';
import { statementWaitMs } from './tools';
import type {
	SqlEndpoint,
	SqlExecuteResult,
	SqlSchemaResponse,
	SqlSession,
	SqlDialect,
} from './types';

// =============================================================================
// DIALECT MAPPING
// =============================================================================

/** Dialect strings this app recognises from the node's `dialect` tool. */
const KNOWN_DIALECTS: ReadonlySet<string> = new Set(['mysql', 'postgres', 'clickhouse', 'neo4j']);

/**
 * Map a node-reported dialect string onto the app's SqlDialect union.
 *
 * @param value - The raw dialect string from the node.
 * @returns The matching SqlDialect, or 'unknown'.
 */
export function toDialect(value: unknown): SqlDialect {
	return typeof value === 'string' && KNOWN_DIALECTS.has(value) ? (value as SqlDialect) : 'unknown';
}

// =============================================================================
// SESSION IMPLEMENTATION
// =============================================================================

/** SqlSession over the shared tool session. */
class SqlToolSession implements SqlSession {
	/** The endpoint this session is bound to. */
	readonly endpoint: SqlEndpoint;

	/** The shared session (it reads the task token from the store's vault at call time). */
	private readonly session: IToolSession;

	/**
	 * @param session - The shared session for the endpoint.
	 * @param endpoint - The endpoint to bind to (the app's token-free description).
	 */
	constructor(session: IToolSession, endpoint: SqlEndpoint) {
		this.session = session;
		this.endpoint = endpoint;
	}

	/** @inheritdoc */
	async execute(sql: string, opts?: { params?: unknown[]; idempotent?: boolean; generation?: IGenerationTicket }): Promise<SqlExecuteResult> {
		// Omit `params` entirely when there is nothing to bind: the node's
		// placeholder rewriting is skipped for an empty list, so an unbound
		// statement keeps travelling exactly as it did before.
		const params = opts?.params;
		const input = params && params.length > 0 ? { sql, params } : { sql };
		// Default NO retry: an unmarked statement may well be a write. The wait
		// is the node's published statement deadline plus a pad, or none. The
		// caller's ticket goes down with the call (port of 740b69c6d), so a
		// request it abandoned is never sent again by the session's retry.
		const generation = opts?.generation;
		return this.session.invoke<SqlExecuteResult>('execute', input, {
			idempotent: opts?.idempotent === true,
			timeoutMs: statementWaitMs(this.session.info()),
			...(generation === undefined ? {} : { generation }),
		});
	}

	/** @inheritdoc */
	async getSchema(table?: string): Promise<SqlSchemaResponse> {
		return this.session.invoke<SqlSchemaResponse>('get_schema', table ? { table } : {});
	}

	/** @inheritdoc */
	async refreshSchema(): Promise<SqlSchemaResponse> {
		try {
			return await this.session.invoke<SqlSchemaResponse>('refresh_schema', {});
		} catch (error) {
			// A dropped (superseded) result is not a failure of the tool.
			if (isStaleError(error)) throw error;
			// ANY other failure falls back. A node without the tool and a node
			// that simply could not answer are indistinguishable at this layer,
			// and matching the engine's error wording would rot the first time it
			// changed. Serve the task-start snapshot and flag it, rather than
			// present it as freshly reflected; when the fallback ALSO fails, its
			// error is the one the caller sees.
			const schema = await this.getSchema();
			return { ...schema, stale: true };
		}
	}

	/** @inheritdoc */
	async dialect(): Promise<SqlDialect> {
		const result = await this.session.invoke<{ dialect?: string }>('dialect', {});
		return toDialect(result?.dialect);
	}
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a live session bound to one database endpoint.
 *
 * @param session - The endpoint store's session for the endpoint (`store.session(client, endpoint)`).
 * @param endpoint - The app's token-free description of the endpoint.
 * @returns The bound session.
 */
export function createSqlSession(session: IToolSession, endpoint: SqlEndpoint): SqlSession {
	return new SqlToolSession(session, endpoint);
}
