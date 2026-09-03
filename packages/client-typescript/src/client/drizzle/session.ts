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
 * Custom Drizzle ORM driver session for RocketRide pipes.
 *
 * Queries and transactions transport over a pipeline's `execute` /
 * `begin` / `commit` / `rollback` tool functions instead of a TCP socket.
 * Modeled on drizzle-orm 0.45.2 `pg-proxy/session.ts` (queries) and
 * `node-postgres/session.ts` (transactions).
 */

import { sql } from 'drizzle-orm';
import type { Cache } from 'drizzle-orm/cache/core';
import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import { entityKind } from 'drizzle-orm/entity';
import { type Logger, NoopLogger } from 'drizzle-orm/logger';
import { PgPreparedQuery, PgSession, PgTransaction } from 'drizzle-orm/pg-core';
import type { PgDialect, PgQueryResultHKT, PgTransactionConfig, PreparedQueryConfig, SelectedFieldsOrdered } from 'drizzle-orm/pg-core';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import { fillPlaceholders, type QueryWithTypings } from 'drizzle-orm/sql/sql';
import type { Assume } from 'drizzle-orm/utils';
import * as drizzleUtils from 'drizzle-orm/utils';

// mapResultRow is runtime-exported from drizzle-orm/utils but marked
// @internal in the published typings; bind it once with the signature the
// stock pg-proxy driver relies on.
const mapResultRow = (drizzleUtils as unknown as {
	mapResultRow: <T>(columns: SelectedFieldsOrdered, row: unknown[], joinsNotNullableMap: Record<string, boolean> | undefined) => T;
}).mapResultRow;

/**
 * `PgPreparedQuery.prototype.queryWithCache` is drizzle's cache-consultation
 * wrapper (hash the query, check `cache.get`, run `query()` on a miss, then
 * `cache.put`). It is real at runtime (`drizzle-orm/pg-core/session.js`, and
 * every stock driver's `execute()` routes through it — see
 * `node-postgres/session.js`) but marked `@internal` and stripped from the
 * published `.d.ts`, so it is accessed the same way `mapResultRow` is above:
 * a verified runtime export cast past its absent public typing.
 */
interface HasQueryWithCache {
	queryWithCache<R>(queryString: string, params: unknown[], query: () => Promise<R>): Promise<R>;
}

/**
 * Transport contract between the Drizzle driver and the RocketRide SDK.
 *
 * `query` runs one SQL statement: `method: 'all'` requests positional array
 * rows (selects, mapped by field order); `method: 'execute'` requests object
 * rows (DDL / writes / raw statements). `withSession` returns a transport
 * whose `query` calls run inside the given server-side transaction session.
 */
export interface PipesTransport {
	query(sql: string, params: unknown[], method: 'all' | 'execute'): Promise<{ rows: unknown[]; affectedRows: number }>;
	begin(): Promise<string>;
	commit(sessionId: string): Promise<void>;
	rollback(sessionId: string): Promise<void>;
	withSession(sessionId: string): PipesTransport;
}

export interface PipesSessionOptions {
	logger?: Logger;
	/** Forwarded to every prepared query so `DrizzleConfig.cache` reaches drizzle's cache-consultation path. */
	cache?: Cache;
}

/**
 * Shape of a no-fields `execute()` result — mirrors node-postgres's
 * `QueryResult` (`{ rows, rowCount, ... }`) so ported `r.rowCount` checks
 * keep working. Mapped paths (selects, `.returning()`) still resolve to
 * plain row arrays, not this shape.
 *
 * Generic over the row type (rather than an intersection over a fixed
 * `rows: unknown[]`) because drizzle's polymorphic `this['row']` type can
 * only appear directly as a generic argument on the HKT's `type` member —
 * nesting it inside a further object-type literal there is a TS2526 error.
 * Modeled on `drizzle-orm/node-postgres/session.d.ts`'s
 * `NodePgQueryResultHKT extends PgQueryResultHKT { type: QueryResult<Assume<this['row'], QueryResultRow>> }`.
 */
export interface PipesQueryResult<TRow = unknown> {
	rows: TRow[];
	rowCount: number;
}

export interface PipesQueryResultHKT extends PgQueryResultHKT {
	type: PipesQueryResult<Assume<this['row'], { [column: string]: any }>>;
}

export class PipesPreparedQuery<T extends PreparedQueryConfig> extends PgPreparedQuery<T> {
	static override readonly [entityKind]: string = 'RocketRidePipesPreparedQuery';

	/** Assigned by drizzle's query builders at runtime; @internal in the published typings. */
	declare joinsNotNullableMap?: Record<string, boolean>;

	constructor(
		private transport: PipesTransport,
		private queryString: string,
		private params: unknown[],
		private logger: Logger,
		private fields: SelectedFieldsOrdered | undefined,
		private _isResponseInArrayMode: boolean,
		private customResultMapper?: (rows: unknown[][]) => T['execute'],
		cache?: Cache,
		queryMetadata?: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] },
		cacheConfig?: WithCacheConfig,
	) {
		super({ sql: queryString, params }, cache, queryMetadata, cacheConfig);
	}

	async execute(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['execute']> {
		const params = fillPlaceholders(this.params, placeholderValues);
		this.logger.logQuery(this.queryString, params);
		const { fields, customResultMapper } = this;
		const withCache = this as unknown as HasQueryWithCache;

		if (!fields && !customResultMapper) {
			const { rows, affectedRows } = await withCache.queryWithCache(this.queryString, params, () =>
				this.transport.query(this.queryString, params, 'execute'));
			return { rows, rowCount: rows.length > 0 ? rows.length : affectedRows } as T['execute'];
		}

		const { rows } = await withCache.queryWithCache(this.queryString, params, () =>
			this.transport.query(this.queryString, params, 'all'));
		return customResultMapper
			? customResultMapper(rows as unknown[][])
			: (rows as unknown[][]).map((row) => mapResultRow<T['execute']>(fields!, row, this.joinsNotNullableMap));
	}

	async all(): Promise<void> {}

	/** @internal */
	isResponseInArrayMode(): boolean {
		return this._isResponseInArrayMode;
	}
}

export class PipesSession<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends PgSession<PipesQueryResultHKT, TFullSchema, TSchema> {
	static override readonly [entityKind]: string = 'RocketRidePipesSession';

	private logger: Logger;

	constructor(
		private transport: PipesTransport,
		dialect: PgDialect,
		private schema: RelationalSchemaConfig<TSchema> | undefined,
		private options: PipesSessionOptions = {},
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
	}

	prepareQuery<T extends PreparedQueryConfig>(
		query: QueryWithTypings,
		fields: SelectedFieldsOrdered | undefined,
		name: string | undefined,
		isResponseInArrayMode: boolean,
		customResultMapper?: (rows: unknown[][]) => T['execute'],
		queryMetadata?: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] },
		cacheConfig?: WithCacheConfig,
	): PipesPreparedQuery<T> {
		return new PipesPreparedQuery(
			this.transport,
			query.sql,
			query.params,
			this.logger,
			fields,
			isResponseInArrayMode,
			customResultMapper,
			this.options.cache,
			queryMetadata,
			cacheConfig,
		);
	}

	override async transaction<T>(
		transaction: (tx: PipesTransaction<TFullSchema, TSchema>) => Promise<T>,
		config?: PgTransactionConfig,
	): Promise<T> {
		const sessionId = await this.transport.begin();
		const txSession = new PipesSession<TFullSchema, TSchema>(this.transport.withSession(sessionId), this.dialect, this.schema, this.options);
		const tx = new PipesTransaction<TFullSchema, TSchema>(this.dialect, txSession, this.schema);
		try {
			if (config) {
				await tx.setTransaction(config);
			}
			const result = await transaction(tx);
			await this.transport.commit(sessionId);
			return result;
		} catch (err) {
			try {
				await this.transport.rollback(sessionId);
			} catch {
				// Best-effort: the server may have already discarded the session
				// (idle-reaped, transport down). The original error is the story.
			}
			throw err;
		}
	}
}

export class PipesTransaction<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends PgTransaction<PipesQueryResultHKT, TFullSchema, TSchema> {
	static override readonly [entityKind]: string = 'RocketRidePipesTransaction';

	override async transaction<T>(
		transaction: (tx: PipesTransaction<TFullSchema, TSchema>) => Promise<T>,
	): Promise<T> {
		const savepointName = `sp${this.nestedIndex + 1}`;
		// dialect/session exist at runtime on every PgDatabase but are marked
		// @internal in the published typings (constructor params only).
		const { dialect, session } = this as unknown as { dialect: PgDialect; session: PgSession<PipesQueryResultHKT, TFullSchema, TSchema> };
		const tx = new PipesTransaction<TFullSchema, TSchema>(dialect, session, this.schema, this.nestedIndex + 1);
		await tx.execute(sql.raw(`savepoint ${savepointName}`));
		try {
			const result = await transaction(tx);
			await tx.execute(sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			try {
				await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
			} catch {
				// If recovery is impossible the session itself is gone and the
				// outer transaction's rollback/commit will surface that; keep
				// the inner statement's error as the cause.
			}
			throw err;
		}
	}
}
