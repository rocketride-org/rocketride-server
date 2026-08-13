/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Database API namespace for the RocketRide TypeScript SDK.
 *
 * Exposes `client.database.query(...)` for issuing raw SQL or Cypher directly
 * against a database pipeline node via the `execute` tool function, bypassing
 * the LLM translation layer that the default `client.chat(...)` flow uses.
 */

import type { RocketRideClient } from './client.js';
import { createSequelize } from './database/sequelize/create-sequelize.js';
import type { SequelizeConstructor } from './database/sequelize/create-sequelize.js';

// =============================================================================
// DATABASE-LIKE INTERFACE (structural subset used by the pg shim)
// =============================================================================

/**
 * Structural interface satisfied by `DatabaseApi` (and test doubles) for the
 * Sequelize pg-compatible shim.  Only the four methods the shim needs are
 * required, so the interface remains stable across future `DatabaseApi`
 * additions without forcing shim changes.
 */
export interface DatabaseLike {
	/** Execute a raw SQL statement. */
	query(options: { token: string; sql: string; nodeId?: string; sessionId?: string; params?: unknown[] }): Promise<{ rows: Record<string, unknown>[]; affected_rows: number }>;
	/** Begin a database transaction. */
	beginTransaction(options: { token: string; nodeId?: string }): Promise<{ session_id: string }>;
	/** Commit an open transaction. */
	commit(options: { token: string; sessionId: string; nodeId?: string }): Promise<{ ok: boolean }>;
	/** Roll back an open transaction. */
	rollback(options: { token: string; sessionId: string; nodeId?: string }): Promise<{ ok: boolean }>;
}

// =============================================================================
// DIALECT ENUM
// =============================================================================

/**
 * Underlying database engine a pipeline is connected to.
 *
 * Returned by `client.database.dialect(...)` so applications can branch on
 * dialect-specific behavior (e.g. SQL syntax differences, type coercion) and
 * detect when they're talking to a graph DB instead of a relational one.
 */
export enum DatabaseDialect {
	POSTGRES = 'postgres',
	MYSQL = 'mysql',
	NEO4J = 'neo4j',
}

// =============================================================================
// DATABASE API CLASS
// =============================================================================

/**
 * Direct database-query namespace on RocketRideClient.
 *
 * Accessed via `client.database` — not instantiated directly. Statements
 * submitted through this namespace bypass the LLM translation layer and
 * safety checks, so the caller is responsible for the SQL/Cypher they pass.
 */
export class DatabaseApi {
	constructor(private readonly client: RocketRideClient) {}

	/**
	 * Execute a raw SQL or Cypher statement against a database pipeline node.
	 *
	 * Invokes the `execute` tool function on the target database node,
	 * bypassing LLM translation and SQL safety checks.
	 *
	 * @param options.token - Pipeline token for authentication and resource access.
	 * @param options.sql - Raw SQL or Cypher statement to execute.
	 * @param options.nodeId - Target database node ID.  When empty the call
	 *   broadcasts to all tool-lane nodes; the first database node handles it.
	 * @param options.sessionId - Optional transaction session ID returned by
	 *   `beginTransaction`.  When provided the statement runs within that session.
	 * @param options.params - Optional positional parameters bound to the statement
	 *   (e.g. `[1, 'foo']` for `$1`, `$2` placeholders).
	 * @returns Object with `rows` (array of row objects) and `affected_rows` (number).
	 */
	async query(options: { token: string; sql: string; nodeId?: string; sessionId?: string; params?: unknown[] }): Promise<{ rows: Record<string, unknown>[]; affected_rows: number }> {
		if (typeof options.token !== 'string' || options.token.trim() === '') {
			throw new Error('token must be a non-empty string');
		}
		if (typeof options.sql !== 'string' || options.sql.trim() === '') {
			throw new Error('sql must be a non-empty string');
		}

		const input: Record<string, unknown> = { sql: options.sql };
		if (options.sessionId) input.session_id = options.sessionId;
		if (options.params) input.params = options.params;

		return this.client.tool({
			token: options.token,
			tool: 'execute',
			nodeId: options.nodeId,
			input,
		});
	}

	/**
	 * Begin a database transaction on a pipeline node.
	 *
	 * Returns a `session_id` that must be threaded through subsequent
	 * `query`, `commit`, and `rollback` calls to keep them within the
	 * same transaction.
	 *
	 * @param options.token - Pipeline token for authentication and resource access.
	 * @param options.nodeId - Target database node ID.
	 * @returns Object containing the `session_id` string for the new transaction.
	 */
	async beginTransaction(options: { token: string; nodeId?: string }): Promise<{ session_id: string }> {
		if (typeof options.token !== 'string' || options.token.trim() === '') {
			throw new Error('token must be a non-empty string');
		}
		return this.client.tool({ token: options.token, tool: 'begin', nodeId: options.nodeId, input: {} });
	}

	/**
	 * Commit an open transaction session, making all its changes permanent.
	 *
	 * @param options.token - Pipeline token for authentication and resource access.
	 * @param options.sessionId - Transaction session ID returned by `beginTransaction`.
	 * @param options.nodeId - Target database node ID.
	 * @returns Object with `ok: true` on success.
	 */
	async commit(options: { token: string; sessionId: string; nodeId?: string }): Promise<{ ok: boolean }> {
		if (typeof options.token !== 'string' || options.token.trim() === '') {
			throw new Error('token must be a non-empty string');
		}
		if (!options.sessionId) throw new Error('sessionId must be a non-empty string');
		return this.client.tool({
			token: options.token,
			tool: 'commit',
			nodeId: options.nodeId,
			input: { session_id: options.sessionId },
		});
	}

	/**
	 * Roll back an open transaction session, discarding all its changes.
	 *
	 * @param options.token - Pipeline token for authentication and resource access.
	 * @param options.sessionId - Transaction session ID returned by `beginTransaction`.
	 * @param options.nodeId - Target database node ID.
	 * @returns Object with `ok: true` on success.
	 */
	async rollback(options: { token: string; sessionId: string; nodeId?: string }): Promise<{ ok: boolean }> {
		if (typeof options.token !== 'string' || options.token.trim() === '') {
			throw new Error('token must be a non-empty string');
		}
		if (!options.sessionId) throw new Error('sessionId must be a non-empty string');
		return this.client.tool({
			token: options.token,
			tool: 'rollback',
			nodeId: options.nodeId,
			input: { session_id: options.sessionId },
		});
	}

	/**
	 * Discover the underlying database engine for a pipeline node.
	 *
	 * Invokes the `dialect` tool function on the target database node.
	 *
	 * @param options.token - Pipeline token for authentication and resource access.
	 * @param options.nodeId - Target database node ID.  When empty the call
	 *   broadcasts to all tool-lane nodes; the first database node handles it.
	 * @returns The dialect reported by the node.
	 * @throws If `token` is empty or the response is not a recognized dialect.
	 */
	async dialect(options: { token: string; nodeId?: string }): Promise<DatabaseDialect> {
		if (typeof options.token !== 'string' || options.token.trim() === '') {
			throw new Error('token must be a non-empty string');
		}

		const result = await this.client.tool<{ dialect?: string }>({
			token: options.token,
			tool: 'dialect',
			nodeId: options.nodeId,
		});

		const known = Object.values(DatabaseDialect) as string[];
		if (!result?.dialect || !known.includes(result.dialect)) {
			throw new Error(`Unexpected dialect response from pipeline: ${JSON.stringify(result)}`);
		}
		return result.dialect as DatabaseDialect;
	}

	/**
	 * Build a Sequelize ORM instance that transports its SQL over this RocketRide
	 * pipe (via `query`/`beginTransaction`/`commit`/`rollback`) instead of a TCP socket.
	 *
	 * Passes `this` as the `DatabaseLike` transport — TypeScript confirms structural
	 * compatibility at compile time.
	 *
	 * The `sequelize` package is a peer dependency, not a hard dependency: it pulls
	 * in Node built-ins (`util`, `debug`) that cannot be bundled for browser targets.
	 * Callers must import `Sequelize` themselves and pass the class in.
	 *
	 * @param options.Sequelize - The `Sequelize` class (`import { Sequelize } from 'sequelize'`).
	 * @param options.token - Pipeline token for authentication.
	 * @param options.nodeId - Target database node id (pins transactions to one node).
	 * @param options.sequelizeOptions - Extra Sequelize options merged over the defaults.
	 * @returns A configured `Sequelize` instance ready for model definition and queries.
	 */
	sequelize(options: { Sequelize: SequelizeConstructor; token: string; nodeId?: string; sequelizeOptions?: import('sequelize').Options }): import('sequelize').Sequelize {
		return createSequelize({ Sequelize: options.Sequelize, db: this, token: options.token, nodeId: options.nodeId, sequelizeOptions: options.sequelizeOptions });
	}
}
