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

// Task 5.2b: quotas are already config-backed with UNIT coverage (Phase 1 rate limits;
// Phase 3 maxSessionsPerTenant / idleTtlMs / workspaceCapBytes / retentionDays). This suite
// is the missing INTEGRATION evidence: the REAL SessionManager, REAL create()/archive()/sweep()
// code paths, and a REAL Express app for the write-rejection assertion — only the opencode
// child-process spawn is faked (same protected attach() extension point Phase 3's
// CountingSessionManager / FileWatchSessionManager use in tests/proxy.test.ts). If any of
// these quotas stopped biting, these tests would fail even though the unit tests for the
// config values themselves would keep passing.

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentConfig, loadConfig } from '../src/config';
import { createApp, EnvKeyResolver } from '../src/index';
import { sweep } from '../src/reaper';
import { MemorySessionIndex } from '../src/sessionIndex';
import { SessionManager, SessionManagerDeps } from '../src/session';
import { HttpError, Identity, IdentityResolver, LiveSession, ProviderKeys, SessionRecord } from '../src/types';
import { workspaceSize } from '../src/workspace';

/**
 * Fake-attach harness (same protected extension point as proxy.test.ts's
 * CountingSessionManager / FileWatchSessionManager): overrides ONLY the opencode
 * child-process spawn. Everything else — create()'s tenant-cap check-then-reserve,
 * seedWorkspace(), initGit(), index bookkeeping, archive()'s save-back + git commit,
 * the reaper's idle-TTL and workspace-cap checks — runs the REAL production code, so a
 * quota that stopped biting would fail these tests, not just a mock's canned response.
 */
class FakeAttachSessionManager extends SessionManager {
	protected async attach(record: SessionRecord, _providerKeys: ProviderKeys, credential: string, sessionRoot: string): Promise<LiveSession> {
		const live: LiveSession = {
			record,
			proc: { kill: () => true } as unknown as ChildProcess,
			port: 0,
			password: 'fake',
			baseUrl: 'http://127.0.0.1:0', // never dialed by any of these tests — watchFileEdits() fails silently and retries, same as proxy.test.ts's CountingSessionManager
			mcpSecret: 'fake-mcp-secret',
			latestToken: credential,
			// Real attach() joins sessionRoot the same way — create() already mkdir'd + seeded
			// + git-init'd sessionRoot/workspace before calling attach(), so this must match.
			workspaceDir: path.join(sessionRoot, 'workspace'),
			sessionHome: path.join(sessionRoot, 'home'),
			events: new EventEmitter(),
			openStreams: 0,
		};
		(this as unknown as { live: Map<string, LiveSession> }).live.set(record.sessionId, live);
		return live;
	}
}

class FakeIdentityResolver implements IdentityResolver {
	constructor(private map: Record<string, Identity>) {}
	async resolve(credential: string): Promise<Identity> {
		const id = this.map[credential];
		if (!id) throw new Error('bad credential');
		return id;
	}
}

const CREDENTIAL = 'tok-alice';

function freshCfg(overrides: NodeJS.ProcessEnv = {}): AgentConfig {
	return loadConfig({
		RR_MCP_UPSTREAM: 'http://127.0.0.1:1', // never dialed — loadConfig only requires it be set
		AGENT_ANTHROPIC_KEY: 'sk-test',
		RR_AGENT_DATA_DIR: path.join(os.tmpdir(), `ra-quota-test-${randomUUID()}`),
		...overrides,
	} as NodeJS.ProcessEnv);
}

function makeManager(cfg: AgentConfig, storeFactory?: SessionManagerDeps['storeFactory']): FakeAttachSessionManager {
	return new FakeAttachSessionManager({
		cfg,
		keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
		index: new MemorySessionIndex(),
		storeFactory: storeFactory ?? (async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined })),
	});
}

describe('Task 5.2b: quota enforcement — end-to-end integration evidence', () => {
	// Each test builds its own manager/index/cfg with a unique tmp dataDir (freshCfg()'s
	// randomUUID suffix) — no shared state, so tests never bleed into one another.

	test('Scenario 1: the 11th concurrent session for one tenant is rejected 429 naming maxSessionsPerTenant; a different tenant is unaffected', async () => {
		const cfg = freshCfg();
		const manager = makeManager(cfg);
		const identity: Identity = { ownerId: 'alice', tenantId: 'quota-t1' };

		// Fill the tenant to cfg.maxSessionsPerTenant (default 10) via the REAL create() path —
		// each call runs the real check-then-reserve tenant-lock logic, not a stub.
		for (let i = 0; i < cfg.maxSessionsPerTenant; i++) {
			const rec = await manager.create({ identity, credential: CREDENTIAL, title: `session-${i}` });
			expect(rec.status).toBe('active');
		}
		expect(await manager.deps.index.countActive(identity.tenantId)).toBe(cfg.maxSessionsPerTenant);

		// The 11th create() for the SAME tenant must reject with the real HttpError(429, ...)
		// session.ts's create() throws — the limit is named in the message (maxSessionsPerTenant's
		// configured value), not just a bare 429.
		let err: unknown;
		try {
			await manager.create({ identity, credential: CREDENTIAL, title: 'session-11' });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(HttpError);
		expect((err as HttpError).status).toBe(429);
		expect((err as HttpError).message).toBe(`tenant session limit reached (${cfg.maxSessionsPerTenant})`);
		// The rejected 11th attempt must not have consumed a slot either.
		expect(await manager.deps.index.countActive(identity.tenantId)).toBe(cfg.maxSessionsPerTenant);

		// Per-tenant, not global: a DIFFERENT tenant is completely unaffected by tenant t1 sitting at cap.
		const bob: Identity = { ownerId: 'bob', tenantId: 'quota-t2' };
		const bobRecord = await manager.create({ identity: bob, credential: CREDENTIAL, title: 'bob-first' });
		expect(bobRecord.status).toBe('active');
	}, 60_000);

	test('Scenario 2: filling the workspace past workspaceCapBytes emits workspace_full via the real reaper cap check, and further writes are rejected', async () => {
		// Small cap, set through the SAME config surface production uses (RR_WORKSPACE_CAP_BYTES) —
		// not a mocked workspaceSize().
		const cfg = freshCfg({ RR_WORKSPACE_CAP_BYTES: '10000' });
		const manager = makeManager(cfg);
		const identity: Identity = { ownerId: 'alice', tenantId: 'quota-t3' };

		const record = await manager.create({ identity, credential: CREDENTIAL, title: 'fill-me' });
		const live = manager.getLive(record.sessionId)!;

		// Push the REAL on-disk workspace (already seeded by create() with AGENTS.md/docs/rr-builder.md)
		// well past the cap — the same workspaceSize() the reaper's sweep() calls, not a precomputed number.
		await fsp.writeFile(path.join(live.workspaceDir, 'padding.bin'), Buffer.alloc(20_000, 'x'));
		expect(await workspaceSize(live.workspaceDir)).toBeGreaterThan(cfg.workspaceCapBytes);

		const events: Array<{ type: string; capBytes?: number }> = [];
		live.events.on('event', (e: { type: string; capBytes?: number }) => events.push(e));

		// The real reaper sweep — NOT manager.pauseForCap() called directly — is what must
		// discover the over-cap workspace and pause the session.
		await sweep(manager, manager.deps.index, cfg);

		expect(live.record.status).toBe('workspace_full');
		expect((await manager.deps.index.get(record.sessionId))!.status).toBe('workspace_full');
		expect(events).toContainEqual({ type: 'workspace_full', capBytes: cfg.workspaceCapBytes });

		// Writes rejected: mount the real Express app over this manager and prove the PUT route
		// itself blocks — not just that an internal flag flipped (Important 4, final-review).
		const app = createApp({ cfg, manager, index: manager.deps.index, identity: new FakeIdentityResolver({ [CREDENTIAL]: identity }) });
		const srv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => srv.once('listening', r));
		try {
			const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
			const target = path.join(live.workspaceDir, 'blocked.pipe');
			const res = await fetch(`${base}/agent/sessions/${record.sessionId}/files/blocked.pipe`, {
				method: 'PUT',
				headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' },
				body: '{}',
			});
			expect(res.status).toBe(413);
			await expect(fsp.access(target)).rejects.toThrow(); // never written
		} finally {
			srv.close();
		}
	}, 60_000);

	test('Scenario 3: reaper archives an idle session past idleTtlMs (injectable clock) and save-back actually ran', async () => {
		const writes: Array<{ path: string; text: string }> = [];
		const cfg = freshCfg();
		const manager = makeManager(cfg, async () => ({
			fsReadString: async () => '{}',
			fsWriteString: async (p: string, text: string) => { writes.push({ path: p, text }); },
			close: async () => undefined,
		}));
		const identity: Identity = { ownerId: 'alice', tenantId: 'quota-t4' };

		const record = await manager.create({ identity, credential: CREDENTIAL, title: 'idle-me' });
		const live = manager.getLive(record.sessionId)!;
		// saveBack() only writes when a *.pipe file exists in the workspace root — give it one,
		// so "save-back happened" is provable, not just "archive() returned".
		await fsp.writeFile(path.join(live.workspaceDir, 'idle-demo.pipe'), '{"nodes":[]}\n', 'utf8');

		const t0 = live.record.lastActivity;
		// sweep()'s `now` parameter (defaults to Date.now()) IS the reaper's injectable clock —
		// advancing it past idleTtlMs is the real mechanism, not a backdated field mutation.
		await sweep(manager, manager.deps.index, cfg, t0 + cfg.idleTtlMs + 1);

		expect(manager.getLive(record.sessionId)).toBeUndefined();
		const archived = await manager.deps.index.get(record.sessionId);
		expect(archived!.status).toBe('archived');
		// save-back happened: the spying storeFactory actually received the pipe's content.
		expect(writes).toHaveLength(1);
		expect(writes[0].path).toContain('idle-demo.pipe');
		expect(writes[0].text).toContain('nodes');
	}, 60_000);

	test('Scenario 4: archived sessions do not count toward the concurrency limit — archiving one at cap frees a slot for a new create', async () => {
		const cfg = freshCfg();
		const manager = makeManager(cfg);
		const identity: Identity = { ownerId: 'alice', tenantId: 'quota-t5' };

		const ids: string[] = [];
		for (let i = 0; i < cfg.maxSessionsPerTenant; i++) {
			const rec = await manager.create({ identity, credential: CREDENTIAL, title: `session-${i}` });
			ids.push(rec.sessionId);
		}
		await expect(manager.create({ identity, credential: CREDENTIAL, title: 'over-cap' }))
			.rejects.toMatchObject({ status: 429 });

		// Real archive() path: save-back, final git commit, kill, flip status archived, drop from
		// listLive() — and (the thing under test) index.countActive() no longer counts it.
		await manager.archive(ids[0]);
		expect((await manager.deps.index.get(ids[0]))!.status).toBe('archived');
		expect(await manager.deps.index.countActive(identity.tenantId)).toBe(cfg.maxSessionsPerTenant - 1);

		const fresh = await manager.create({ identity, credential: CREDENTIAL, title: 'after-archive' });
		expect(fresh.status).toBe('active');
		expect(await manager.deps.index.countActive(identity.tenantId)).toBe(cfg.maxSessionsPerTenant);
	}, 60_000);
});
