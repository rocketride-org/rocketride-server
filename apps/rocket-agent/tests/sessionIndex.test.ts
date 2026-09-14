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

import { AddressInfo } from 'node:net';
import type Redis from 'ioredis';
import { loadConfig } from '../src/config';
import { createApp, EnvKeyResolver } from '../src/index';
import { MemorySessionIndex, RedisSessionIndex } from '../src/sessionIndex';
import { SessionManager } from '../src/session';
import type { SessionIndex, SessionRecord } from '../src/types';

function record(over: Partial<SessionRecord>): SessionRecord {
	return {
		sessionId: over.sessionId ?? 's1',
		ownerId: 'alice',
		tenantId: 't1',
		title: 'untitled',
		pipePath: 'demo/qa.pipe',
		pipesTouched: [],
		status: 'active',
		createdAt: Date.now(),
		lastActivity: Date.now(),
		...over,
	};
}

/**
 * Minimal in-memory stand-in for the ioredis commands RedisSessionIndex issues (multi/set/
 * sadd/srem/del/exec, get, smembers, mget, scan, quit). Not a general ioredis mock — just
 * enough surface to exercise RedisSessionIndex's own logic hermetically, in every
 * environment, without a live Redis server (ioredis-mock is not a repo dependency).
 */
class FakeRedis {
	private strings = new Map<string, string>();
	private sets = new Map<string, Set<string>>();

	multi() {
		const ops: Array<() => void> = [];
		const builder = {
			set: (key: string, val: string) => { ops.push(() => this.strings.set(key, val)); return builder; },
			sadd: (key: string, member: string) => {
				ops.push(() => { if (!this.sets.has(key)) this.sets.set(key, new Set()); this.sets.get(key)!.add(member); });
				return builder;
			},
			srem: (key: string, member: string) => {
				ops.push(() => { this.sets.get(key)?.delete(member); });
				return builder;
			},
			del: (key: string) => { ops.push(() => { this.strings.delete(key); }); return builder; },
			exec: async () => { for (const op of ops) op(); return []; },
		};
		return builder;
	}

	async get(key: string): Promise<string | null> {
		return this.strings.get(key) ?? null;
	}

	async smembers(key: string): Promise<string[]> {
		return [...(this.sets.get(key) ?? [])];
	}

	async mget(keys: string[]): Promise<Array<string | null>> {
		return keys.map((k) => this.strings.get(k) ?? null);
	}

	async scan(_cursor: string, _matchFlag: 'MATCH', pattern: string, _countFlag: 'COUNT', _n: number): Promise<[string, string[]]> {
		const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
		return ['0', [...this.strings.keys()].filter((k) => re.test(k))];
	}

	async del(key: string): Promise<number> {
		return this.strings.delete(key) ? 1 : 0;
	}

	async quit(): Promise<'OK'> {
		return 'OK';
	}
}

function contract(name: string, make: () => Promise<SessionIndex & { close?: () => Promise<void> }>) {
	describe(`SessionIndex contract: ${name}`, () => {
		let index: SessionIndex & { close?: () => Promise<void> };
		beforeEach(async () => { index = await make(); });
		afterEach(async () => { await index.close?.(); });

		test('listByOwner scopes strictly to the owner', async () => {
			await index.put(record({ sessionId: 'a1', ownerId: 'alice' }));
			await index.put(record({ sessionId: 'b1', ownerId: 'bob', tenantId: 't2' }));
			expect((await index.listByOwner('alice')).map((r) => r.sessionId)).toEqual(['a1']);
			expect((await index.listByOwner('bob')).map((r) => r.sessionId)).toEqual(['b1']);
			expect(await index.listByOwner('carol')).toEqual([]);
		});

		test('countActive counts non-archived per tenant (10/tenant cap input)', async () => {
			await index.put(record({ sessionId: 'a1', status: 'active' }));
			await index.put(record({ sessionId: 'a2', status: 'paused_auth' }));
			await index.put(record({ sessionId: 'a3', status: 'archived' }));
			expect(await index.countActive('t1')).toBe(2);
		});

		test('put is an upsert; pipesTouched persists', async () => {
			await index.put(record({ sessionId: 'a1' }));
			await index.put(record({ sessionId: 'a1', title: 'renamed', pipesTouched: ['demo/qa.pipe'] }));
			const got = await index.get('a1');
			expect(got!.title).toBe('renamed');
			expect(got!.pipesTouched).toEqual(['demo/qa.pipe']);
		});

		test('retention query: archived older than cutoff', async () => {
			const old = Date.now() - 40 * 86_400_000;
			await index.put(record({ sessionId: 'old', status: 'archived', lastActivity: old }));
			await index.put(record({ sessionId: 'fresh', status: 'archived' }));
			await index.put(record({ sessionId: 'live', status: 'active', lastActivity: old }));
			const purge = await index.listArchivedOlderThan(Date.now() - 30 * 86_400_000);
			expect(purge.map((r) => r.sessionId)).toEqual(['old']);
			await index.remove('old');
			expect(await index.get('old')).toBeNull();
		});

		// 3.5 addition: saveFailed must round-trip through the index untouched — the flag
		// archive() sets when a final save-back throws — so GET /agent/sessions can surface it.
		test('saveFailed round-trips through the index', async () => {
			await index.put(record({ sessionId: 'a1', saveFailed: true }));
			expect((await index.get('a1'))!.saveFailed).toBe(true);
			await index.put(record({ sessionId: 'a2' }));
			expect((await index.get('a2'))!.saveFailed).toBeUndefined();
		});
	});
}

contract('memory', async () => new MemorySessionIndex());

// Hermetic: RedisSessionIndex accepts an already-constructed client in place of a URL
// (DI for tests) — this runs the exact same contract against FakeRedis above, in every
// environment, with no external Redis required.
contract('redis (hermetic fake)', async () => new RedisSessionIndex(new FakeRedis() as unknown as Redis, `ragent-test-${Math.random()}`));

if (process.env.RR_TEST_REDIS_URL) {
	contract('redis (live)', async () => {
		const idx = new RedisSessionIndex(process.env.RR_TEST_REDIS_URL!, `ragent-test-${Date.now()}`);
		return idx;
	});
}

describe('owner-scoped session API', () => {
	test('list shows only the caller’s sessions; archive keeps them listed; title patch works', async () => {
		const cfg = loadConfig({ RR_MCP_UPSTREAM: 'http://127.0.0.1:9/mcp', RR_AGENT_DATA_DIR: require('node:os').tmpdir() + '/ra-idx' } as NodeJS.ProcessEnv);
		const index = new MemorySessionIndex();
		const manager = new SessionManager({
			cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk' } as NodeJS.ProcessEnv),
			index,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		});
		const app = createApp({
			cfg, manager, index,
			identity: {
				resolve: async (c) =>
					c === 'tok-alice' ? { ownerId: 'alice', tenantId: 't1' }
					: c === 'tok-bob' ? { ownerId: 'bob', tenantId: 't2' }
					: Promise.reject(new Error('bad')),
			},
		});
		const srv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => srv.once('listening', r)); // listen() returns before the socket is bound
		const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
		const alice = { authorization: 'Bearer tok-alice' };
		try {
			const id = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', 'http://127.0.0.1:9');
			await manager.attachFake({ ownerId: 'bob', tenantId: 't2' }, 'tok-bob', 'http://127.0.0.1:9');

			const list = await (await fetch(`${base}/agent/sessions`, { headers: alice })).json() as Array<{ sessionId: string }>;
			expect(list.map((r) => r.sessionId)).toEqual([id]);

			const patched = await fetch(`${base}/agent/sessions/${id}`, {
				method: 'PATCH', headers: { ...alice, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'PDF QA bot' }),
			});
			expect(((await patched.json()) as { title: string }).title).toBe('PDF QA bot');

			expect((await fetch(`${base}/agent/sessions/${id}`, { method: 'DELETE', headers: alice })).status).toBe(204);
			const after = await (await fetch(`${base}/agent/sessions`, { headers: alice })).json() as Array<{ status: string }>;
			expect(after[0].status).toBe('archived');   // archived ≠ gone: resumable until retention
		} finally {
			srv.close();
		}
	});

	test('PATCH is owner-scoped: a foreign owner gets 404, not another tenant’s session', async () => {
		const cfg = loadConfig({ RR_MCP_UPSTREAM: 'http://127.0.0.1:9/mcp', RR_AGENT_DATA_DIR: require('node:os').tmpdir() + '/ra-idx2' } as NodeJS.ProcessEnv);
		const index = new MemorySessionIndex();
		const manager = new SessionManager({
			cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk' } as NodeJS.ProcessEnv),
			index,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		});
		const app = createApp({
			cfg, manager, index,
			identity: {
				resolve: async (c) =>
					c === 'tok-alice' ? { ownerId: 'alice', tenantId: 't1' }
					: c === 'tok-bob' ? { ownerId: 'bob', tenantId: 't2' }
					: Promise.reject(new Error('bad')),
			},
		});
		const srv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => srv.once('listening', r)); // listen() returns before the socket is bound
		const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
		try {
			const id = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', 'http://127.0.0.1:9');
			const res = await fetch(`${base}/agent/sessions/${id}`, {
				method: 'PATCH',
				headers: { authorization: 'Bearer tok-bob', 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'stolen' }),
			});
			expect(res.status).toBe(404);
			expect((await index.get(id))!.title).toBe('fake');
		} finally {
			srv.close();
		}
	});
});
