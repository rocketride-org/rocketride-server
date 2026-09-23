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
 * Minimal `pg`-compatible shim that transports SQL over a RocketRide
 * `DatabaseLike` (e.g. `DatabaseApi`), so Sequelize v6 can use it as a
 * `dialectModule` for the Postgres dialect without requiring a real `pg`
 * connection.
 *
 * Transaction handling: `START TRANSACTION` and `BEGIN` call
 * `db.beginTransaction` and pin the returned `session_id` on `_sessionId`.
 * Subsequent queries carry `sessionId` automatically.  `COMMIT` and `ROLLBACK`
 * call the corresponding `db` methods and clear `_sessionId`.
 *
 * `SAVEPOINT`, `RELEASE SAVEPOINT`, and `SET TRANSACTION` are NOT intercepted
 * — they fall through as ordinary session queries (nested-transaction support
 * is a follow-up).
 */

import type { DatabaseLike } from '../../database.js';

// =============================================================================
// CONTEXT
// =============================================================================

/**
 * Context supplied to {@link makePgShim}.  Captured by closure and threaded
 * through every `Client` instance created from the returned constructor.
 */
export interface ShimContext {
	/** A `DatabaseLike` (e.g. `client.database`) to forward SQL through. */
	db: DatabaseLike;
	/** Pipeline token passed to every `db.query` call. */
	token: string;
	/** Optional target database node ID; forwarded as-is. */
	nodeId?: string;
}

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/** Shape of a normalised pg query result. */
export interface QueryResult {
	rows: Record<string, unknown>[];
	rowCount: number;
	fields: never[];
	command: string;
}

/** The inner connection object exposed on each client instance. */
export interface ShimConnection {
	on(event: string, cb: unknown): this;
	once(event: string, cb: unknown): this;
	removeListener(event: string, cb: unknown): this;
}

/** The pg-compatible types object returned by {@link makePgShim}. */
export interface ShimTypes {
	getTypeParser(oid: unknown): (v: unknown) => unknown;
	setTypeParser(): void;
	arrayParser: { create(str: unknown): { parse(v: unknown): unknown } };
}

/** The full pg-compatible module object returned by {@link makePgShim}. */
export interface PgShim {
	Client: new (config: unknown) => PgShimClientInstance;
	types: ShimTypes;
	defaults: Record<string, never>;
	escapeIdentifier(s: string): string;
	escapeLiteral(s: string): string;
}

/** Public interface for instances created from the shim `Client` constructor. */
export interface PgShimClientInstance {
	/** Placeholder transaction session ID — set by Task A3. */
	_sessionId?: string;
	/** Inner connection object exposing parameterStatus event hooks. */
	connection: ShimConnection;
	/** Promise form. */
	connect(): Promise<void>;
	/** Callback form — calls cb(null) synchronously, returns undefined. */
	connect(cb: (err: Error | null) => void): undefined;
	/** Promise form. */
	end(): Promise<void>;
	/** Callback form — calls cb() synchronously, returns undefined. */
	end(cb: () => void): undefined;
	on(event: string, cb: unknown): this;
	once(event: string, cb: unknown): this;
	removeListener(event: string, cb: unknown): this;
	emit(event: string, ...args: unknown[]): this;
	/** Promise form — no callback. */
	query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult>;
	/** Callback form — callback as second arg. */
	query(sql: string, cb: (err: Error | null, result: QueryResult) => void): undefined;
	/** Callback form — values array + callback. */
	query(sql: string, values: unknown[], cb: (err: Error | null, result: QueryResult) => void): undefined;
	/** Config-object callback form. */
	query(config: { text: string; values?: unknown[] }, cb: (err: Error | null, result: QueryResult) => void): undefined;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Extract the leading SQL verb (uppercased) from a statement. */
function commandOf(sql: string): string {
	const m = /^\s*(\w+)/.exec(sql);
	return m ? m[1].toUpperCase() : '';
}

/**
 * Standard pg literal quoting: wrap in single-quotes, escape embedded
 * single-quotes by doubling them, and handle backslashes with `E'...'` syntax.
 */
function escapeLiteral(s: string): string {
	const hasBackslash = s.includes('\\');
	const escaped = s.replace(/\\/g, '\\\\').replace(/'/g, "''");
	return hasBackslash ? `E'${escaped}'` : `'${escaped}'`;
}

/** Double-quote an identifier, escaping internal double-quotes by doubling. */
function escapeIdentifier(s: string): string {
	return '"' + s.replace(/"/g, '""') + '"';
}

// =============================================================================
// SHIM FACTORY
// =============================================================================

/**
 * Build a pg-compatible module object that Sequelize v6 accepts as
 * `dialectModule`.
 *
 * @param ctx - Shim context: db handle, token, and optional nodeId.
 * @returns Object with `Client` constructor, `types`, `defaults`,
 *   `escapeIdentifier`, and `escapeLiteral` — the subset Sequelize reads.
 *
 * @example
 * ```ts
 * const shim = makePgShim({ db: client.database, token: myToken });
 * const sequelize = new Sequelize({ dialect: 'postgres', dialectModule: shim });
 * ```
 */
export function makePgShim(ctx: ShimContext): PgShim {
	// -----------------------------------------------------------------------
	// Inner connection object — Sequelize hooks parameterStatus events on it
	// -----------------------------------------------------------------------
	const shimConnection: ShimConnection = {
		on(_event: string, _cb: unknown): typeof shimConnection {
			return shimConnection;
		},
		once(_event: string, _cb: unknown): typeof shimConnection {
			return shimConnection;
		},
		removeListener(_event: string, _cb: unknown): typeof shimConnection {
			return shimConnection;
		},
	};

	// -----------------------------------------------------------------------
	// Client class
	// -----------------------------------------------------------------------

	/**
	 * pg-compatible Client class.  Instances are created by Sequelize for each
	 * pooled connection.  All SQL is forwarded over `ctx.db`.
	 */
	class PgShimClientImpl implements PgShimClientInstance {
		/**
		 * Active transaction session ID, or `undefined` when no transaction is
		 * open.  Set by `START TRANSACTION`/`BEGIN` interception and cleared
		 * by `COMMIT`/`ROLLBACK` interception or `end()`.
		 */
		_sessionId?: string;

		/** Inner connection object — exposes parameterStatus event hooks. */
		connection: ShimConnection = shimConnection;

		constructor(_config: unknown) {}

		// ------------------------------------------------------------------
		// Lifecycle
		// ------------------------------------------------------------------

		/**
		 * Establish a connection.
		 *
		 * Dual-mode: if `cb` is supplied (callback form used by Sequelize's pool
		 * acquire path), calls `cb(null)` synchronously and returns `undefined`.
		 * Otherwise returns a resolved `Promise<void>`.
		 */
		connect(): Promise<void>;
		connect(cb: (err: Error | null) => void): undefined;
		connect(cb?: (err: Error | null) => void): Promise<void> | undefined {
			if (typeof cb === 'function') {
				cb(null);
				return undefined;
			}
			return Promise.resolve();
		}

		/**
		 * Release the connection.
		 *
		 * If a transaction session is still open, rolls it back first for leak
		 * safety before resolving or calling `cb`.
		 *
		 * Dual-mode: callback form schedules the rollback async, calls `cb()`
		 * when done, and returns `undefined`; promise form awaits the rollback
		 * then resolves `Promise<void>`.
		 */
		end(): Promise<void>;
		end(cb: () => void): undefined;
		end(cb?: () => void): Promise<void> | undefined {
			if (typeof cb === 'function') {
				// Async rollback then callback
				const capturedCb = cb;
				const doEnd = async (): Promise<void> => {
					if (this._sessionId) {
						const sid = this._sessionId;
						this._sessionId = undefined;
						try {
							await ctx.db.rollback({ token: ctx.token, sessionId: sid, nodeId: ctx.nodeId });
						} catch {
							// Swallow rollback errors on close; session will expire server-side
						}
					}
					capturedCb();
				};
				doEnd();
				return undefined;
			}
			// Promise mode
			if (this._sessionId) {
				const sid = this._sessionId;
				this._sessionId = undefined;
				return ctx.db
					.rollback({ token: ctx.token, sessionId: sid, nodeId: ctx.nodeId })
					.then(() => undefined)
					.catch(() => undefined);
			}
			return Promise.resolve();
		}

		// ------------------------------------------------------------------
		// Event emitter stubs (no-op — shim has no actual socket)
		// ------------------------------------------------------------------

		/** No-op; returns `this` for chaining. */
		on(_event: string, _cb: unknown): this {
			return this;
		}

		/** No-op; returns `this` for chaining. */
		once(_event: string, _cb: unknown): this {
			return this;
		}

		/** No-op; returns `this` for chaining. */
		removeListener(_event: string, _cb: unknown): this {
			return this;
		}

		/** No-op; returns `this` for chaining. */
		emit(_event: string, ..._args: unknown[]): this {
			return this;
		}

		// ------------------------------------------------------------------
		// Query — supports all four pg calling conventions
		// ------------------------------------------------------------------

		/**
		 * Execute a SQL statement via the RocketRide database transport.
		 *
		 * Transaction-control SQL is intercepted before forwarding:
		 * - `START TRANSACTION` / `BEGIN` → calls `db.beginTransaction` and pins
		 *   the returned `session_id` on `this._sessionId`.
		 * - `COMMIT` → calls `db.commit` (when a session is open) then clears `_sessionId`.
		 * - `ROLLBACK` → calls `db.rollback` (when a session is open) then clears `_sessionId`.
		 * - `SAVEPOINT`, `RELEASE SAVEPOINT`, `SET TRANSACTION` → forwarded as
		 *   ordinary session queries (not intercepted).
		 *
		 * Interception honours the dual callback/promise calling convention:
		 * callback form calls `cb(null, result)` and returns `undefined`;
		 * promise form resolves the result.
		 *
		 * Supported calling conventions (mirroring the `pg` module):
		 * - `query(sql)` → `Promise<QueryResult>`
		 * - `query(sql, values[])` → `Promise<QueryResult>`
		 * - `query(sql, cb)` → `undefined` (callback receives `(null, result)`)
		 * - `query(sql, values[], cb)` → `undefined`
		 * - `query({text, values?}, cb?)` → Promise or callback
		 *
		 * @param textOrConfig - SQL string or config object `{ text, values? }`.
		 * @param valuesOrCb - Positional bind values **or** a callback function.
		 * @param maybeCb - Callback when `valuesOrCb` is the bind-values array.
		 */
		query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult>;
		query(sql: string, cb: (err: Error | null, result: QueryResult) => void): undefined;
		query(sql: string, values: unknown[], cb: (err: Error | null, result: QueryResult) => void): undefined;
		query(config: { text: string; values?: unknown[] }, cb: (err: Error | null, result: QueryResult) => void): undefined;
		query(textOrConfig: string | { text: string; values?: unknown[] }, valuesOrCb?: unknown[] | ((err: Error | null, result: QueryResult) => void), maybeCb?: (err: Error | null, result: QueryResult) => void): Promise<QueryResult> | undefined {
			// Normalise sql, values, and callback from the overloaded arguments
			let sql: string;
			let values: unknown[] | undefined;
			let cb: ((err: Error | null, result: QueryResult) => void) | undefined;

			if (typeof textOrConfig === 'string') {
				sql = textOrConfig;
				if (typeof valuesOrCb === 'function') {
					cb = valuesOrCb as (err: Error | null, result: QueryResult) => void;
					values = undefined;
				} else {
					values = valuesOrCb as unknown[] | undefined;
					cb = maybeCb;
				}
			} else {
				// Config object form
				sql = textOrConfig.text;
				values = textOrConfig.values;
				if (typeof valuesOrCb === 'function') {
					cb = valuesOrCb as (err: Error | null, result: QueryResult) => void;
				} else {
					cb = maybeCb;
				}
			}

			// Intercept transaction-control SQL and drive the RocketRide session.
			// Only START TRANSACTION / BEGIN / COMMIT / ROLLBACK are intercepted.
			// SAVEPOINT, RELEASE SAVEPOINT, and SET TRANSACTION fall through as
			// ordinary session queries so that nested-savepoint support can be
			// added later without shim changes.
			// Anchored to the whole statement so only bare transaction control is
			// intercepted. Forms like `ROLLBACK TO SAVEPOINT x` / `RELEASE SAVEPOINT x`
			// must NOT match here — they fall through as ordinary session queries so
			// nested savepoints keep working.
			const txMatch = /^\s*(START TRANSACTION|BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.exec(sql);
			if (txMatch) {
				const kw = txMatch[1].toUpperCase();
				const intercept = async (): Promise<QueryResult> => {
					if (kw === 'START TRANSACTION' || kw === 'BEGIN') {
						const r = await ctx.db.beginTransaction({ token: ctx.token, nodeId: ctx.nodeId });
						this._sessionId = r.session_id;
					} else if (kw === 'COMMIT') {
						if (this._sessionId) {
							await ctx.db.commit({ token: ctx.token, sessionId: this._sessionId, nodeId: ctx.nodeId });
							this._sessionId = undefined;
						}
					} else {
						// ROLLBACK
						if (this._sessionId) {
							await ctx.db.rollback({ token: ctx.token, sessionId: this._sessionId, nodeId: ctx.nodeId });
							this._sessionId = undefined;
						}
					}
					return { rows: [], rowCount: 0, fields: [], command: kw };
				};

				if (typeof cb === 'function') {
					const capturedCb = cb;
					intercept()
						.then((result) => capturedCb(null, result))
						.catch((err: Error) => capturedCb(err, null as unknown as QueryResult));
					return undefined;
				}
				return intercept();
			}

			// Build the db.query options, omitting sessionId when undefined
			const dbOptions: Parameters<DatabaseLike['query']>[0] = {
				token: ctx.token,
				sql,
				nodeId: ctx.nodeId,
				...(this._sessionId !== undefined ? { sessionId: this._sessionId } : {}),
				...(values !== undefined && values.length > 0 ? { params: values } : {}),
			};

			if (typeof cb === 'function') {
				// Callback mode: run async, invoke cb, return undefined
				const capturedCb = cb;
				ctx.db
					.query(dbOptions)
					.then((raw) => {
						capturedCb(null, mapResult(raw, sql));
					})
					.catch((err: Error) => {
						capturedCb(err, null as unknown as QueryResult);
					});
				return undefined;
			}

			// Promise mode
			return ctx.db.query(dbOptions).then((raw) => mapResult(raw, sql));
		}
	}

	// -----------------------------------------------------------------------
	// Module-level exports (Sequelize reads these off the dialectModule object)
	// -----------------------------------------------------------------------

	const types: ShimTypes = {
		/** Return an identity parser for every OID — no type coercion. */
		getTypeParser: (_oid: unknown) => (v: unknown) => v,
		/** No-op — shim does not need to override pg type parsers. */
		setTypeParser: () => {},
		/** Minimal array-parser stub. */
		arrayParser: {
			create: (_str: unknown) => ({
				parse: (v: unknown) => v,
			}),
		},
	};

	return {
		Client: PgShimClientImpl,
		types,
		defaults: {},
		escapeIdentifier,
		escapeLiteral,
	};
}

// =============================================================================
// PRIVATE MODULE HELPERS
// =============================================================================

function mapResult(raw: { rows: Record<string, unknown>[]; affected_rows: number }, sql: string): QueryResult {
	return {
		rows: raw.rows,
		rowCount: raw.affected_rows || raw.rows.length,
		fields: [],
		command: commandOf(sql),
	};
}
