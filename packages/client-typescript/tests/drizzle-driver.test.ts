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
import { eq, sql } from 'drizzle-orm';
import type { Cache } from 'drizzle-orm/cache/core';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from '../src/client/drizzle/index';

const users = pgTable('users', {
	id: integer('id').primaryKey(),
	name: text('name'),
});

function makeFakeDatabaseLike() {
	const calls: any[] = [];
	let sessions = 0;
	const api = {
		calls,
		async query(options: any) {
			calls.push({ kind: 'query', ...options });
			return options.rowMode === 'array'
				? { rows: [[1, 'ada']], affected_rows: 0 }
				: { rows: [], affected_rows: 1 };
		},
		async beginTransaction(options: any) {
			calls.push({ kind: 'begin', ...options });
			return { session_id: `sid-${++sessions}` };
		},
		async commit(options: any) {
			calls.push({ kind: 'commit', ...options });
			return { ok: true };
		},
		async rollback(options: any) {
			calls.push({ kind: 'rollback', ...options });
			return { ok: true };
		},
	};
	return api;
}

describe('drizzle() over pipes', () => {
	it('select rides query with rowMode array, token, and nodeId', async () => {
		const fake = makeFakeDatabaseLike();
		const db = drizzle({ client: fake as any, token: 'tok', nodeId: 'pg-node' });
		const rows = await db.select().from(users).where(eq(users.id, 1));
		const q = fake.calls[0];
		expect(q).toMatchObject({ kind: 'query', token: 'tok', nodeId: 'pg-node', rowMode: 'array' });
		expect(q.params).toEqual([1]);
		expect(rows).toEqual([{ id: 1, name: 'ada' }]);
	});

	it('transaction threads one sessionId through begin/query/commit', async () => {
		const fake = makeFakeDatabaseLike();
		const db = drizzle({ client: fake as any, token: 'tok', nodeId: 'pg-node' });
		await db.transaction(async (tx) => {
			await tx.insert(users).values({ id: 2, name: 'bob' });
		});
		const kinds = fake.calls.map((c: any) => c.kind);
		expect(kinds).toEqual(['begin', 'query', 'commit']);
		expect(fake.calls[1].sessionId).toBe('sid-1');
		expect(fake.calls[2].sessionId).toBe('sid-1');
	});

	function makeMockDb(result: { rows: unknown[]; affected_rows: number }) {
		return {
			calls: [] as any[],
			async query(this: { calls: any[] }, options: any) {
				this.calls.push(options);
				return result;
			},
			async beginTransaction() {
				throw new Error('not used in these tests');
			},
			async commit() {},
			async rollback() {},
		};
	}

	it('exposes rowCount for writes without returning', async () => {
		const fake = makeMockDb({ rows: [], affected_rows: 3 });
		const db = drizzle({ client: fake as any, token: 'tok' });
		const res = (await db.execute(sql.raw('update t set x = 1'))) as unknown as { rows: unknown[]; rowCount: number };
		expect(res.rowCount).toBe(3);
		expect(res.rows).toEqual([]);
	});

	it('rowCount equals row length for row-returning execute', async () => {
		const fake = makeMockDb({ rows: [{ a: 1 }, { a: 2 }], affected_rows: 0 });
		const db = drizzle({ client: fake as any, token: 'tok' });
		const res = (await db.execute(sql.raw('select a from t'))) as unknown as { rows: unknown[]; rowCount: number };
		expect(res.rowCount).toBe(2);
	});

	/** A minimal in-memory `Cache` (drizzle-orm's `cache/core` contract) that records every `get`/`put` call. */
	function makeFakeCache() {
		const store = new Map<string, unknown>();
		const calls = { get: [] as unknown[], put: [] as unknown[] };
		const cache = {
			strategy: () => 'all' as const,
			async get(key: string, tables: string[], isTag: boolean, isAutoInvalidate?: boolean) {
				calls.get.push({ key, tables, isTag, isAutoInvalidate });
				return store.get(key);
			},
			async put(key: string, response: unknown, tables: string[], isTag: boolean) {
				calls.put.push({ key, response, tables, isTag });
				store.set(key, response);
			},
			async onMutate() {},
		};
		return { cache: cache as unknown as Cache, calls };
	}

	it('propagates DrizzleConfig.cache so repeated selects are served from the cache', async () => {
		const fake = makeFakeDatabaseLike();
		const { cache, calls } = makeFakeCache();
		const db = drizzle({ client: fake as any, token: 'tok', cache });

		await db.select().from(users).where(eq(users.id, 1));
		await db.select().from(users).where(eq(users.id, 1));

		expect(calls.get.length).toBe(2);
		expect(calls.put.length).toBe(1);
		expect(fake.calls.filter((c: any) => c.kind === 'query').length).toBe(1);
	});
});
