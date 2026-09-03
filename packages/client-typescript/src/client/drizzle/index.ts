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
 * Drizzle ORM over RocketRide pipes — the `rocketride/drizzle` entry point.
 *
 * This module (and only this module) imports drizzle-orm at runtime; it is a
 * separate package export so apps that never use the ORM pay nothing for it.
 */

import { DefaultLogger } from 'drizzle-orm/logger';
import { PgDatabase, PgDialect } from 'drizzle-orm/pg-core';
import { createTableRelationsHelpers, extractTablesRelationalConfig, type RelationalSchemaConfig, type TablesRelationalConfig } from 'drizzle-orm/relations';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { DrizzleDatabaseLike } from '../database.js';
import { PipesSession, type PipesQueryResultHKT, type PipesTransport } from './session.js';

export * from './session.js';

/** A Drizzle database instance whose SQL transports over a RocketRide pipe. */
export type RocketRideDrizzle<TSchema extends Record<string, unknown> = Record<string, never>> = PgDatabase<PipesQueryResultHKT, TSchema>;

export interface DrizzleOverPipesOptions {
	/** The SDK transport — pass `client.database` (or any `DrizzleDatabaseLike`). */
	client: DrizzleDatabaseLike;
	/** Pipeline token for authentication and resource access. */
	token: string;
	/** Target database node id; pins queries and transactions to one node. */
	nodeId?: string;
}

function makeTransport(db: DrizzleDatabaseLike, token: string, nodeId?: string, sessionId?: string): PipesTransport {
	return {
		async query(sqlText, params, method) {
			const options = {
				token,
				sql: sqlText,
				nodeId,
				sessionId,
				params: params.length > 0 ? params : undefined,
			};
			const res = method === 'all'
				? await db.query({ ...options, rowMode: 'array' })
				: await db.query(options);
			return { rows: res.rows, affectedRows: res.affected_rows ?? 0 };
		},
		async begin() {
			return (await db.beginTransaction({ token, nodeId })).session_id;
		},
		async commit(sessionId) {
			await db.commit({ token, sessionId, nodeId });
		},
		async rollback(sessionId) {
			await db.rollback({ token, sessionId, nodeId });
		},
		withSession(sid) {
			return makeTransport(db, token, nodeId, sid);
		},
	};
}

/**
 * Build a Drizzle ORM instance that transports its SQL over a RocketRide
 * pipeline (via the `execute`/`begin`/`commit`/`rollback` tool functions)
 * instead of a TCP socket. Full transaction support: `db.transaction()`,
 * isolation/access-mode config, and nested savepoints.
 *
 * The target database node must have `allow_execute: true` in its pipeline
 * configuration; the same flag gates transactions.
 *
 * `drizzle-orm` is an optional peer dependency with zero Node-builtin
 * requirements, so this entry point is browser-bundle safe.
 *
 * @param options.client - The SDK transport — pass `client.database`.
 * @param options.token - Pipeline token for authentication.
 * @param options.nodeId - Target database node id (pins transactions to one node).
 * @returns A Drizzle `PgDatabase` ready for queries and transactions.
 */
export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
	options: DrizzleOverPipesOptions & DrizzleConfig<TSchema>,
): RocketRideDrizzle<TSchema> {
	const { client, token, nodeId, ...config } = options;
	const dialect = new PgDialect({ casing: config.casing });
	let logger;
	if (config.logger === true) {
		logger = new DefaultLogger();
	} else if (config.logger !== false) {
		logger = config.logger;
	}

	let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
	if (config.schema) {
		const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
		schema = {
			fullSchema: config.schema,
			schema: tablesConfig.tables,
			tableNamesMap: tablesConfig.tableNamesMap,
		};
	}

	const transport = makeTransport(client, token, nodeId);
	const session = new PipesSession(transport, dialect, schema, { logger, cache: config.cache });
	return new PgDatabase(dialect, session, schema) as RocketRideDrizzle<TSchema>;
}
