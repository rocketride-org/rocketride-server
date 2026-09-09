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

import { describe, it, expect } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text, PgDialect } from 'drizzle-orm/pg-core';
import { PipesSession, PipesTransaction, type PipesTransport } from '../src/client/drizzle/session';

const users = pgTable('users', {
	id: integer('id').primaryKey(),
	name: text('name'),
});

interface Call {
	sql: string;
	params: unknown[];
	method: string;
	sessionId?: string;
}

function makeFakeTransport(rowsFor: (sqlText: string) => unknown[]) {
	const calls: Call[] = [];
	const events: string[] = [];
	let nextSession = 0;
	const make = (sessionId?: string): PipesTransport => ({
		async query(sqlText, params, method) {
			calls.push({ sql: sqlText, params, method, sessionId });
			return { rows: rowsFor(sqlText), affectedRows: 0 };
		},
		async begin() {
			const sid = `sid-${++nextSession}`;
			events.push(`begin:${sid}`);
			return sid;
		},
		async commit(sid) {
			events.push(`commit:${sid}`);
		},
		async rollback(sid) {
			events.push(`rollback:${sid}`);
		},
		withSession(sid) {
			return make(sid);
		},
	});
	return { transport: make(), calls, events };
}

function makeDb(rowsFor: (sqlText: string) => unknown[]) {
	const { transport, calls, events } = makeFakeTransport(rowsFor);
	const dialect = new PgDialect();
	const session = new PipesSession(transport, dialect, undefined);
	return { session, dialect, calls, events };
}

/**
 * A transport whose `query` throws for statements matched by `shouldFail`,
 * and whose `rollback` optionally throws too. Used to exercise the client's
 * compensating-rollback failure paths without disturbing the happy-path
 * `makeFakeTransport` helper above.
 */
function makeFaultyTransport(opts: {
	shouldFail?: (sqlText: string) => Error | undefined;
	rollbackError?: Error;
}) {
	const calls: Call[] = [];
	const events: string[] = [];
	let nextSession = 0;
	const make = (sessionId?: string): PipesTransport => ({
		async query(sqlText, params, method) {
			calls.push({ sql: sqlText, params, method, sessionId });
			const err = opts.shouldFail?.(sqlText);
			if (err) {
				throw err;
			}
			return { rows: [], affectedRows: 0 };
		},
		async begin() {
			const sid = `sid-${++nextSession}`;
			events.push(`begin:${sid}`);
			return sid;
		},
		async commit(sid) {
			events.push(`commit:${sid}`);
		},
		async rollback(sid) {
			events.push(`rollback:${sid}`);
			if (opts.rollbackError) {
				throw opts.rollbackError;
			}
		},
		withSession(sid) {
			return make(sid);
		},
	});
	return { transport: make(), calls, events };
}

describe('PipesSession', () => {
	it('runs selects in array mode and maps rows to objects', async () => {
		const { session, dialect, calls } = makeDb(() => [[1, 'ada']]);
		const db = new PipesTransaction(dialect, session, undefined);
		const result = await db.select().from(users);
		expect(calls[0].method).toBe('all');
		expect(calls[0].sql.toLowerCase()).toContain('select');
		expect(result).toEqual([{ id: 1, name: 'ada' }]);
	});

	it('commits a transaction and pins queries to the session', async () => {
		const { session, calls, events } = makeDb(() => []);
		const out = await session.transaction(async (tx) => {
			await tx.insert(users).values({ id: 1, name: 'ada' });
			return 'done';
		});
		expect(out).toBe('done');
		expect(events).toEqual(['begin:sid-1', 'commit:sid-1']);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.sessionId === 'sid-1')).toBe(true);
	});

	it('rolls back when the callback throws and rethrows', async () => {
		const { session, events } = makeDb(() => []);
		await expect(
			session.transaction(async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(events).toEqual(['begin:sid-1', 'rollback:sid-1']);
	});

	it('surfaces the original error when rollback also fails', async () => {
		const original = new Error('duplicate key value violates unique constraint');
		const { transport } = makeFaultyTransport({
			shouldFail: () => original,
			rollbackError: new Error('unknown or expired transaction session: x'),
		});
		const dialect = new PgDialect();
		const session = new PipesSession(transport, dialect, undefined);
		// Query failures now route through drizzle's `queryWithCache` (needed so
		// cache.get/put are consulted — see the cache-propagation tests), which
		// wraps the original error in a `DrizzleQueryError` and preserves it as
		// `.cause`. Assert on the cause so this still proves the *query* error
		// (not the rollback error) is what reaches the caller.
		let thrown: unknown;
		try {
			await session.transaction(async (tx) => {
				await tx.execute(sql.raw('insert into t values (1)'));
			});
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { cause?: unknown } | undefined)?.cause).toBe(original);
	});

	it('surfaces the inner error when rollback-to-savepoint fails', async () => {
		// nested tx: inner callback rejects AND the savepoint rollback statement
		// rejects too -> the caller must still receive the inner error, not the
		// savepoint-rollback failure.
		const savepointError = new Error('unknown or expired transaction session: x');
		const { transport, events } = makeFaultyTransport({
			shouldFail: (sqlText) => (sqlText.toLowerCase().includes('rollback to savepoint') ? savepointError : undefined),
		});
		const dialect = new PgDialect();
		const session = new PipesSession(transport, dialect, undefined);
		await session.transaction(async (tx) => {
			await expect(
				tx.transaction(async (tx2) => {
					await tx2.insert(users).values({ id: 2, name: 'bob' });
					throw new Error('inner');
				})
			).rejects.toThrow('inner');
		});
		expect(events).toEqual(['begin:sid-1', 'commit:sid-1']);
	});

	it('applies transaction config via SET TRANSACTION', async () => {
		const { session, calls } = makeDb(() => []);
		await session.transaction(async () => {}, { isolationLevel: 'serializable' });
		expect(calls[0].sql.toLowerCase()).toBe('set transaction isolation level serializable');
		expect(calls[0].sessionId).toBe('sid-1');
	});

	it('implements nested transactions as savepoints', async () => {
		const { session, calls, events } = makeDb(() => []);
		await session.transaction(async (tx) => {
			await expect(
				tx.transaction(async (tx2) => {
					await tx2.insert(users).values({ id: 2, name: 'bob' });
					throw new Error('inner');
				})
			).rejects.toThrow('inner');
		});
		const sqls = calls.map((c) => c.sql.toLowerCase());
		expect(sqls).toContain('savepoint sp1');
		expect(sqls).toContain('rollback to savepoint sp1');
		expect(events).toEqual(['begin:sid-1', 'commit:sid-1']);
	});

	it('routes statements without selected fields through execute (object mode)', async () => {
		const { session, dialect, calls } = makeDb(() => [{ ok: 1 }]);
		const db = new PipesTransaction(dialect, session, undefined);
		await db.execute(sql`create table x (a int)`);
		expect(calls[0].method).toBe('execute');
	});
});
