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

import Redis from 'ioredis';
import type { SessionIndex, SessionRecord } from './types';

export class MemorySessionIndex implements SessionIndex {
	private records = new Map<string, SessionRecord>();
	async put(r: SessionRecord) { this.records.set(r.sessionId, { ...r, pipesTouched: [...r.pipesTouched] }); }
	async get(id: string) { return this.records.get(id) ?? null; }
	async listByOwner(ownerId: string) { return [...this.records.values()].filter((r) => r.ownerId === ownerId); }
	async countActive(tenantId: string) {
		return [...this.records.values()].filter((r) => r.tenantId === tenantId && r.status !== 'archived').length;
	}
	async listArchivedOlderThan(cutoffMs: number) {
		return [...this.records.values()].filter((r) => r.status === 'archived' && r.lastActivity < cutoffMs);
	}
	async listNonArchived() {
		return [...this.records.values()].filter((r) => r.status !== 'archived');
	}
	async remove(id: string) { this.records.delete(id); }
}

/**
 * Redis layout (prefix default 'ragent'):
 *   <p>:s:<sessionId>      → JSON SessionRecord (never a credential field — SessionRecord
 *                            excludes password/mcpSecret/latestToken by type; keep it that way)
 *   <p>:owner:<ownerId>    → SET of sessionIds
 *   <p>:tenant:<tenantId>  → SET of sessionIds
 * Records are small and per-user lists are short (≤10 active/tenant), so
 * SMEMBERS + MGET is the whole query model. Multi-replica-safe: every write
 * rewrites the full record (rocket-agent replica owning the live process is
 * the only writer for a session).
 */
export class RedisSessionIndex implements SessionIndex {
	private redis: Redis;

	/** `urlOrClient` accepts an already-constructed client (tests inject a hermetic fake) as well as a connection URL. */
	constructor(urlOrClient: string | Redis, private prefix = 'ragent') {
		this.redis = typeof urlOrClient === 'string' ? new Redis(urlOrClient) : urlOrClient;
	}

	async close(): Promise<void> {
		await this.redis.quit();
	}

	private key(id: string): string { return `${this.prefix}:s:${id}`; }

	async put(r: SessionRecord): Promise<void> {
		await this.redis
			.multi()
			.set(this.key(r.sessionId), JSON.stringify(r))
			.sadd(`${this.prefix}:owner:${r.ownerId}`, r.sessionId)
			.sadd(`${this.prefix}:tenant:${r.tenantId}`, r.sessionId)
			.exec();
	}

	async get(id: string): Promise<SessionRecord | null> {
		const raw = await this.redis.get(this.key(id));
		return raw ? (JSON.parse(raw) as SessionRecord) : null;
	}

	private async members(setKey: string): Promise<SessionRecord[]> {
		const ids = await this.redis.smembers(setKey);
		if (ids.length === 0) return [];
		const raws = await this.redis.mget(ids.map((id) => this.key(id)));
		return raws.filter((x): x is string => x !== null).map((x) => JSON.parse(x) as SessionRecord);
	}

	async listByOwner(ownerId: string): Promise<SessionRecord[]> {
		return (await this.members(`${this.prefix}:owner:${ownerId}`))
			.sort((a, b) => b.lastActivity - a.lastActivity);
	}

	async countActive(tenantId: string): Promise<number> {
		return (await this.members(`${this.prefix}:tenant:${tenantId}`))
			.filter((r) => r.status !== 'archived').length;
	}

	/** Scan-by-tenant sets would miss orphans; scan record keys directly (bounded: sessions ≤ tenants × 10 + retention window). */
	private async scanAllRecords(): Promise<SessionRecord[]> {
		const records: SessionRecord[] = [];
		let cursor = '0';
		do {
			const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}:s:*`, 'COUNT', 200);
			cursor = next;
			if (keys.length) {
				const raws = await this.redis.mget(keys);
				for (const raw of raws) {
					if (raw) records.push(JSON.parse(raw) as SessionRecord);
				}
			}
		} while (cursor !== '0');
		return records;
	}

	async listArchivedOlderThan(cutoffMs: number): Promise<SessionRecord[]> {
		return (await this.scanAllRecords()).filter((r) => r.status === 'archived' && r.lastActivity < cutoffMs);
	}

	async listNonArchived(): Promise<SessionRecord[]> {
		return (await this.scanAllRecords()).filter((r) => r.status !== 'archived');
	}

	async remove(id: string): Promise<void> {
		const r = await this.get(id);
		const multi = this.redis.multi().del(this.key(id));
		if (r) {
			multi.srem(`${this.prefix}:owner:${r.ownerId}`, id);
			multi.srem(`${this.prefix}:tenant:${r.tenantId}`, id);
		}
		await multi.exec();
	}
}
