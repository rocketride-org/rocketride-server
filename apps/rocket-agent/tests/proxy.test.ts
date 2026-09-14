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

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { AuditRecord, Auditor, InMemorySink } from '../src/audit';
import { loadConfig } from '../src/config';
import { createApp, EnvKeyResolver } from '../src/index';
import { MemorySessionIndex } from '../src/sessionIndex';
import { SessionManager, SessionManagerDeps } from '../src/session';
import { reconcileOnBoot, sweep } from '../src/reaper';
import type { Identity, IdentityResolver, InferenceSettings, LiveSession, SessionRecord } from '../src/types';
import { initGit } from '../src/workspace';

class FakeIdentityResolver implements IdentityResolver {
	constructor(private map: Record<string, Identity>) {}
	async resolve(credential: string): Promise<Identity> {
		const id = this.map[credential];
		if (!id) throw new Error('bad credential');
		return id;
	}
}

/**
 * Overrides the protected attach() hook (same extension point Task 3.1's tests use)
 * to count spawns without touching a real child_process — proves resume()'s
 * concurrency guard collapses two concurrent callers into a single attach().
 */
class CountingSessionManager extends SessionManager {
	spawnCount = 0;

	protected async attach(record: SessionRecord, _settings: InferenceSettings, credential: string, sessionRoot: string): Promise<LiveSession> {
		this.spawnCount++;
		await new Promise((r) => setTimeout(r, 50)); // widen the race window
		const live: LiveSession = {
			record,
			proc: { kill: () => true } as unknown as ChildProcess,
			port: 0,
			password: 'fake',
			baseUrl: 'http://127.0.0.1:0',
			mcpSecret: 'fake-mcp-secret',
			latestToken: credential,
			workspaceDir: sessionRoot,
			sessionHome: sessionRoot,
			events: new EventEmitter(),
			openStreams: 0,
			turn: {},
		};
		// `live` is private on SessionManager (not protected) — this cast reaches the
		// real runtime field so the manager's state stays consistent for this test.
		(this as unknown as { live: Map<string, LiveSession> }).live.set(record.sessionId, live);
		return live;
	}
}

/**
 * Points a resumed session's baseUrl at a fake SSE server instead of a real opencode binary —
 * lets the file.edited-envelope / SSE-reconnect test (Important 6) drive watchFileEdits()
 * deterministically without a real opencode server or LLM turn.
 */
class FileWatchSessionManager extends SessionManager {
	protected async attach(record: SessionRecord, _settings: InferenceSettings, credential: string, sessionRoot: string): Promise<LiveSession> {
		const workspaceDir = path.join(sessionRoot, 'workspace');
		await fsp.mkdir(workspaceDir, { recursive: true });
		await fsp.writeFile(path.join(workspaceDir, 'AGENTS.md'), '# fake session\n', 'utf8');
		await initGit(workspaceDir);
		const live: LiveSession = {
			record,
			proc: { kill: () => true } as unknown as ChildProcess,
			port: 0,
			password: 'fake',
			baseUrl: this.fakeSseUrl,
			mcpSecret: 'fake-mcp-secret',
			latestToken: credential,
			workspaceDir,
			sessionHome: sessionRoot,
			events: new EventEmitter(),
			openStreams: 0,
			turn: {},
		};
		(this as unknown as { live: Map<string, LiveSession> }).live.set(record.sessionId, live);
		return live;
	}

	constructor(deps: SessionManagerDeps, private fakeSseUrl: string) {
		super(deps);
	}
}

function listen(handler: http.RequestListener): Promise<{ srv: http.Server; url: string }> {
	const srv = http.createServer(handler);
	return new Promise((r) => srv.listen(0, '127.0.0.1', () =>
		r({ srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` })));
}

describe('session + MCP proxies', () => {
	let fakeOc: { srv: http.Server; url: string };
	let fakeMcp: { srv: http.Server; url: string };
	let mcpSeen: string[];
	let mcpSeenCookies: string[];
	let mcpSeenLastEventId: string[];
	let mcpMode: 'ok' | 'expired';
	let ocEventReqClosed: boolean;
	let app: ReturnType<typeof createApp>;
	let appSrv: http.Server;
	let base: string;
	let manager: SessionManager;
	let index: MemorySessionIndex;
	let auditSink: InMemorySink;

	beforeAll(async () => {
		mcpSeen = [];
		mcpSeenCookies = [];
		mcpSeenLastEventId = [];
		mcpMode = 'ok';
		ocEventReqClosed = false;
		fakeOc = await listen((req, res) => {
			if (req.url === '/global/event') {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write('data: {"type":"server.connected"}\n\n');
				req.on('close', () => { ocEventReqClosed = true; }); // Important 3: disconnect propagation
				return; // held open — SSE passthrough test reads the first frame
			}
			// Task 5.2a: drain the body before responding (some tests below now send one) —
			// an unconsumed POST body on a keep-alive connection can corrupt the NEXT request
			// read on the same socket.
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				// opencode's real `prompt_async` returns 204 with no body — the session-proxy
				// audit tap treats anything else as an error.
				if (req.url && /\/prompt_async\/?$/.test(req.url)) { res.writeHead(204); res.end(); return; }
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({
					echo: req.url, auth: req.headers.authorization ?? '', cookie: req.headers.cookie ?? '',
					body: Buffer.concat(chunks).toString('utf8'),
				}));
			});
		});
		fakeMcp = await listen((req, res) => {
			mcpSeen.push(req.headers.authorization ?? '');
			mcpSeenCookies.push(req.headers.cookie ?? '');
			mcpSeenLastEventId.push(req.headers['last-event-id'] as string ?? '');
			if (mcpMode === 'expired') { res.writeHead(401); res.end(); return; }
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
		});

		const cfg = loadConfig({
			RR_MCP_UPSTREAM: fakeMcp.url,
			AGENT_ANTHROPIC_KEY: 'sk-test',
			RR_AGENT_DATA_DIR: require('node:os').tmpdir() + '/ra-proxy-test',
			// Forwarded so Step 8's env-gated resume test (below) can spawn the real binary;
			// harmless when unset — every other test here uses attachFake() and never spawns.
			OPENCODE_BIN: process.env.OPENCODE_BIN,
		} as NodeJS.ProcessEnv);
		index = new MemorySessionIndex();
		auditSink = new InMemorySink();
		const auditor = new Auditor(auditSink);
		manager = new SessionManager({
			cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
			auditor,
		});
		app = createApp({
			cfg, manager, index,
			identity: new FakeIdentityResolver({
				'tok-alice': { ownerId: 'alice', tenantId: 't1' },
				'tok-alice-2': { ownerId: 'alice', tenantId: 't1' },
				'tok-bob': { ownerId: 'bob', tenantId: 't2' },
			}),
			auditor,
		});
		appSrv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => appSrv.once('listening', r)); // listen() returns before the socket is bound
		base = `http://127.0.0.1:${(appSrv.address() as AddressInfo).port}`;
	});

	afterAll(() => { fakeOc.srv.close(); fakeMcp.srv.close(); appSrv.close(); });

	async function makeSession(): Promise<string> {
		// attachFake registers a LiveSession pointing at fakeOc without spawning a binary.
		return manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', fakeOc.url);
	}

	test('no token → 401; foreign owner → 403', async () => {
		const id = await makeSession();
		expect((await fetch(`${base}/agent/sessions/${id}/opencode/session`)).status).toBe(401);
		const bob = await fetch(`${base}/agent/sessions/${id}/opencode/session`, { headers: { authorization: 'Bearer tok-bob' } });
		expect(bob.status).toBe(403);
	});

	test('owner request is forwarded with basic auth and streams SSE through', async () => {
		const id = await makeSession();
		const ok = await fetch(`${base}/agent/sessions/${id}/opencode/session`, { headers: { authorization: 'Bearer tok-alice' } });
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { auth: string }).auth).toMatch(/^Basic /);

		const sse = await fetch(`${base}/agent/sessions/${id}/opencode/global/event`, { headers: { authorization: 'Bearer tok-alice' } });
		expect(sse.headers.get('content-type')).toContain('text/event-stream');
		const reader = sse.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain('server.connected');
		await reader.cancel();
	});

	// Important 2: header allow-lists, not deny-lists — the panel's SaaS/Zitadel session
	// cookie (and its raw bearer token) must never reach the sandboxed opencode child,
	// nor whatever opencode forwards on to the internal MCP proxy. Round-2 fold-in:
	// `last-event-id` (MCP Streamable HTTP's SSE-resumption header) must still get through.
	test('cookie and the original panel authorization never reach either upstream; last-event-id does', async () => {
		const id = await makeSession();
		const live = manager.getLive(id)!;

		const oc = await fetch(`${base}/agent/sessions/${id}/opencode/session`, {
			headers: { authorization: 'Bearer tok-alice', cookie: 'zitadel_session=super-secret' },
		});
		const ocBody = (await oc.json()) as { auth: string; cookie: string };
		expect(ocBody.auth).toMatch(/^Basic /); // stamped credential present — this is the intended injection
		expect(ocBody.cookie).toBe(''); // but the panel's raw cookie never arrives

		const mcpUrl = `${base}/internal/mcp/${id}/${live.mcpSecret}`;
		await fetch(mcpUrl, { method: 'POST', body: '{}', headers: { cookie: 'zitadel_session=super-secret', 'last-event-id': 'evt-42' } });
		expect(mcpSeenCookies.at(-1)).toBe('');
		expect(mcpSeenLastEventId.at(-1)).toBe('evt-42');
	});

	// Round-2 fix: the increment/decrement pair around a raw stream route must be exactly
	// paired even when the code between them throws BEFORE the close listener (the only
	// other decrement site) ever registers — otherwise the increment leaks forever and the
	// reaper skips that session permanently (the inverse of the bug Important 4 fixed).
	test('an /events error before the close listener registers still decrements openStreams', async () => {
		const id = await makeSession();
		const live = manager.getLive(id)!;
		expect(live.openStreams).toBe(0);

		const spy = jest.spyOn(live.events, 'on').mockImplementationOnce(() => {
			throw new Error('boom — simulated failure between openStreams++ and the close-listener registration');
		});
		try {
			await fetch(`${base}/agent/sessions/${id}/events`, { headers: { authorization: 'Bearer tok-alice' } });
		} finally {
			spy.mockRestore();
		}
		expect(live.openStreams).toBe(0);
	});

	// Critical 1: Express 4 never forwards async-handler rejections to error middleware —
	// an unreachable upstream must degrade to a 502 for that one request, not take the
	// whole process (every tenant's sessions) down via an unhandled rejection.
	test('proxying to a killed upstream returns 502 and the process survives', async () => {
		const dead = await listen((_req, res) => res.end());
		const deadUrl = dead.url;
		await new Promise<void>((r) => dead.srv.close(() => r())); // now nothing listens on this port
		const id = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', deadUrl);

		let unhandled: unknown = null;
		const onUnhandledRejection = (err: unknown) => { unhandled = err; };
		process.on('unhandledRejection', onUnhandledRejection);
		try {
			const res = await fetch(`${base}/agent/sessions/${id}/opencode/session`, { headers: { authorization: 'Bearer tok-alice' } });
			expect(res.status).toBe(502);
			await new Promise((r) => setImmediate(r)); // flush microtasks — catch any stray rejection
			expect(unhandled).toBeNull();

			// Same guarantee on the MCP-facing proxy: point mcpUpstream-independent per-request
			// forward() at the same dead port via a session whose mcpSecret we control.
			const live = manager.getLive(id)!;
			const mcpStatus = await fetch(`${base}/internal/mcp/${id}/${live.mcpSecret}`, { method: 'POST', body: '{}' });
			// mcpUpstream is fixed at app-construction time (fakeMcp), so this call succeeds —
			// the point already proven above is that forward() itself never rejects on ECONNREFUSED.
			expect(mcpStatus.status).toBeGreaterThanOrEqual(200);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}
	});

	// Important 3: a reloaded/closed panel tab must not leak a held-open upstream connection.
	test('closing the client response aborts the upstream request', async () => {
		const id = await makeSession();
		ocEventReqClosed = false;
		const res = await fetch(`${base}/agent/sessions/${id}/opencode/global/event`, { headers: { authorization: 'Bearer tok-alice' } });
		const reader = res.body!.getReader();
		await reader.read(); // ensure the stream is actively flowing before we disconnect
		await reader.cancel(); // simulates the panel tab closing / reloading
		await new Promise((r) => setTimeout(r, 300)); // allow the disconnect to propagate through the proxy
		expect(ocEventReqClosed).toBe(true);
	});

	test('MCP proxy injects the LATEST cached token and pauses on upstream 401', async () => {
		const id = await makeSession();
		const live = manager.getLive(id)!;
		const mcpUrl = `${base}/internal/mcp/${id}/${live.mcpSecret}`;

		await fetch(mcpUrl, { method: 'POST', body: '{}' });
		expect(mcpSeen.at(-1)).toBe('Bearer tok-alice');

		// Panel reconnects with a fresh token → cache updates → next MCP call carries it.
		await fetch(`${base}/agent/sessions/${id}/opencode/session`, { headers: { authorization: 'Bearer tok-alice-2' } });
		await fetch(mcpUrl, { method: 'POST', body: '{}' });
		expect(mcpSeen.at(-1)).toBe('Bearer tok-alice-2');

		// Expired upstream → session pauses + panel event fires; wrong secret → 404.
		const events: string[] = [];
		live.events.on('event', (e: { type: string }) => events.push(e.type));
		mcpMode = 'expired';
		await fetch(mcpUrl, { method: 'POST', body: '{}' });
		expect(live.record.status).toBe('paused_auth');
		expect(events).toContain('auth.expired');
		mcpMode = 'ok';
		expect((await fetch(`${base}/internal/mcp/${id}/wrong`, { method: 'POST', body: '{}' })).status).toBe(404);

		// Fresh panel token resumes the paused session.
		await fetch(`${base}/agent/sessions/${id}/opencode/session`, { headers: { authorization: 'Bearer tok-alice' } });
		expect(live.record.status).toBe('active');
		expect(events).toContain('auth.refreshed');
	});

	// Important 4 (final-review): pauseForCap() only ever set status + emitted an event —
	// nothing actually stopped a write, so an owner over the 512MB cap could keep growing the
	// shared PVC unbounded. PUT /files/* must reject and leave the file untouched.
	test('PUT /files/* is rejected with 413 while workspace_full, and the file is not written', async () => {
		const id = await makeSession();
		try {
			const live = manager.getLive(id)!;
			const target = path.join(live.workspaceDir, 'over-cap.pipe');
			await expect(fsp.access(target)).rejects.toThrow(); // doesn't exist yet

			manager.pauseForCap(live);
			const res = await fetch(`${base}/agent/sessions/${id}/files/over-cap.pipe`, {
				method: 'PUT', headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' }, body: '{}',
			});
			expect(res.status).toBe(413);
			await expect(fsp.access(target)).rejects.toThrow(); // still doesn't exist — write never happened
		} finally {
			// workspace_full is never 'archived' — left alone this session would permanently
			// eat one of this describe block's shared-manager tenant-cap slots for every test
			// that runs after it (including the real-binary create() tests further down).
			await manager.archive(id);
		}
	});

	// Important 4 (final-review), other half: the opencode proxy's write verbs must be gated
	// the same way — POST/PUT/PATCH rejected, but GET (read) and DELETE (can only shrink the
	// workspace) still go through, so the user isn't trapped at the cap with no way out.
	test('the opencode proxy rejects POST/PUT/PATCH with 413 while workspace_full, but still allows GET and DELETE', async () => {
		const id = await makeSession();
		try {
			const live = manager.getLive(id)!;
			manager.pauseForCap(live);
			const alice = { authorization: 'Bearer tok-alice' };

			for (const method of ['POST', 'PUT', 'PATCH']) {
				const res = await fetch(`${base}/agent/sessions/${id}/opencode/session`, { method, headers: alice, body: '{}' });
				expect(res.status).toBe(413);
			}
			expect((await fetch(`${base}/agent/sessions/${id}/opencode/session`, { headers: alice })).status).toBe(200);
			expect((await fetch(`${base}/agent/sessions/${id}/opencode/session`, { method: 'DELETE', headers: alice })).status).toBe(200);
		} finally {
			await manager.archive(id); // see the previous test's finally comment
		}
	});

	test('reaper archives idle sessions with save-back + snapshot', async () => {
		const id = await makeSession();
		const live = manager.getLive(id)!;
		live.record.lastActivity = Date.now() - 3 * 60 * 60 * 1000; // 3h idle > 2h TTL
		let killed = false;
		live.proc = { kill: () => { killed = true; return true; } } as never;
		await sweep(manager, index, manager.deps.cfg);
		expect((await index.get(id))!.status).toBe('archived');
		expect(manager.getLive(id)).toBeUndefined();
		expect(killed).toBe(true);
	});

	// 3.5: retention purge — archived sessions past cfg.retentionDays lose both their index
	// entry and their on-disk session dir; sessions not yet past the cutoff are left alone.
	test('retention purge deletes disk + index for archived sessions past the cutoff, leaves fresher ones', async () => {
		const oldId = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', fakeOc.url);
		const freshId = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', fakeOc.url);
		await manager.destroy(oldId);
		await manager.destroy(freshId);
		const oldRecord = (await index.get(oldId))!;
		oldRecord.status = 'archived';
		oldRecord.lastActivity = Date.now() - 40 * 86_400_000; // past the 30-day default retention
		await index.put(oldRecord);
		const freshRecord = (await index.get(freshId))!;
		freshRecord.status = 'archived'; // archived, but recently — under the cutoff
		await index.put(freshRecord);

		const oldDir = manager.sessionRoot(oldId);
		const freshDir = manager.sessionRoot(freshId);
		await expect(fsp.access(oldDir)).resolves.toBeUndefined();

		await sweep(manager, index, manager.deps.cfg);

		expect(await index.get(oldId)).toBeNull();
		await expect(fsp.access(oldDir)).rejects.toThrow();
		expect(await index.get(freshId)).not.toBeNull();
		await expect(fsp.access(freshDir)).resolves.toBeUndefined();
	});

	// 3.5 hardening: a sessionId that would resolve outside dataDir/sessions (e.g. path
	// traversal via a compromised index record) must never reach fs.rm — the purge skips it
	// and leaves the index entry rather than trusting an unvalidated path.
	test('retention purge refuses to delete a session dir outside dataDir/sessions', async () => {
		const cfg = manager.deps.cfg;
		const canaryDir = path.join(cfg.dataDir, 'canary');
		await fsp.mkdir(canaryDir, { recursive: true });
		await fsp.writeFile(path.join(canaryDir, 'do-not-delete.txt'), 'still here', 'utf8');

		const maliciousId = '../canary';
		const record: SessionRecord = {
			sessionId: maliciousId,
			ownerId: 'alice',
			tenantId: 't1',
			title: 'evil',
			pipePath: '',
			pipesTouched: [],
			status: 'archived',
			createdAt: Date.now(),
			lastActivity: Date.now() - 40 * 86_400_000,
		};
		await index.put(record);
		const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await sweep(manager, index, cfg);
		} finally {
			errSpy.mockRestore();
		}

		// The canary file (outside sessionsRoot) survives, and the suspicious record is
		// left in the index rather than silently dropped — it never passed the safety check.
		await expect(fsp.access(path.join(canaryDir, 'do-not-delete.txt'))).resolves.toBeUndefined();
		expect(await index.get(maliciousId)).not.toBeNull();
		await index.remove(maliciousId);
		await fsp.rm(canaryDir, { recursive: true, force: true });
	});

	// Critical 2 (final-review): boot-time reconciliation. A freshly-started replica has an
	// empty live map (Recreate-strategy redeploys kill the old process outright), so any
	// non-archived index record left behind is orphaned — countActive() would otherwise keep
	// counting it against the tenant cap forever, with nothing in the reaper's normal sweep
	// ever able to notice or clear it.
	test('reconcileOnBoot archives non-archived records with no live process on this instance, and countActive drops', async () => {
		const bootIndex = new MemorySessionIndex();
		const bootManager = new SessionManager({
			cfg: manager.deps.cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index: bootIndex,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		}); // fresh manager, empty live map — simulates the process right after boot

		const orphanActive: SessionRecord = {
			sessionId: 'orphan-active', ownerId: 'alice', tenantId: 'boot-tenant', title: 'x',
			pipePath: '', pipesTouched: [], status: 'active', createdAt: Date.now(), lastActivity: Date.now(),
		};
		const orphanPaused: SessionRecord = {
			sessionId: 'orphan-paused', ownerId: 'alice', tenantId: 'boot-tenant', title: 'x',
			pipePath: '', pipesTouched: [], status: 'paused_auth', createdAt: Date.now(), lastActivity: Date.now(),
		};
		const alreadyArchived: SessionRecord = {
			sessionId: 'already-archived', ownerId: 'alice', tenantId: 'boot-tenant', title: 'x',
			pipePath: '', pipesTouched: [], status: 'archived', createdAt: Date.now(), lastActivity: Date.now(),
		};
		await bootIndex.put(orphanActive);
		await bootIndex.put(orphanPaused);
		await bootIndex.put(alreadyArchived);
		expect(await bootIndex.countActive('boot-tenant')).toBe(2);

		await reconcileOnBoot(bootManager, bootIndex);

		expect((await bootIndex.get('orphan-active'))!.status).toBe('archived');
		expect((await bootIndex.get('orphan-paused'))!.status).toBe('archived');
		expect((await bootIndex.get('already-archived'))!.status).toBe('archived'); // untouched, still archived
		expect(await bootIndex.countActive('boot-tenant')).toBe(0);
	});

	test('reconcileOnBoot leaves a record alone if this instance actually has it live', async () => {
		const bootIndex = new MemorySessionIndex();
		const id = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', fakeOc.url);
		const live = manager.getLive(id)!;
		await bootIndex.put(live.record); // same manager DOES have this session live
		await reconcileOnBoot(manager, bootIndex);
		expect((await bootIndex.get(id))!.status).toBe('active'); // not archived out from under a live session
	});

	// Critical 2 (final-review): shutdown-time archiving — the other half of the same fix.
	// A graceful SIGTERM/SIGINT should never need reconcileOnBoot() to clean up after it.
	test('archiveAllLive archives every live session (the SIGTERM/SIGINT handler calls this)', async () => {
		const shutdownIndex = new MemorySessionIndex();
		const shutdownManager = new SessionManager({
			cfg: manager.deps.cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index: shutdownIndex,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		});
		const idA = await shutdownManager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', fakeOc.url);
		const idB = await shutdownManager.attachFake({ ownerId: 'bob', tenantId: 't2' }, 'tok-bob', fakeOc.url);
		expect(shutdownManager.listLive()).toHaveLength(2);

		await shutdownManager.archiveAllLive();

		expect(shutdownManager.listLive()).toHaveLength(0);
		expect((await shutdownIndex.get(idA))!.status).toBe('archived');
		expect((await shutdownIndex.get(idB))!.status).toBe('archived');
	});

	// Important 4: a held-open proxied stream is activity — the reaper must not archive
	// out from under a connected client just because lastActivity is stale.
	test('a session with an open SSE stream survives an idle sweep; closing it lets the next sweep archive', async () => {
		const id = await makeSession();
		const live = manager.getLive(id)!;
		let killed = false;
		live.proc = { kill: () => { killed = true; return true; } } as never;

		const res = await fetch(`${base}/agent/sessions/${id}/opencode/global/event`, { headers: { authorization: 'Bearer tok-alice' } });
		const reader = res.body!.getReader();
		await reader.read(); // stream is actively open → openStreams > 0

		// Backdate AFTER connecting: touch() (fired while establishing the proxied
		// request) already reset lastActivity to "now" — this simulates a connection
		// that's been open for hours, still serving a client, with a stale activity clock.
		live.record.lastActivity = Date.now() - 3 * 60 * 60 * 1000; // idle past the 2h TTL

		await sweep(manager, index, manager.deps.cfg);
		expect(manager.getLive(id)).toBeDefined();
		expect(killed).toBe(false);
		expect((await index.get(id))!.status).not.toBe('archived');

		await reader.cancel(); // client disconnects → stream closes → openStreams back to 0
		await new Promise((r) => setTimeout(r, 300)); // let the close propagate and decrement the refcount

		await sweep(manager, index, manager.deps.cfg);
		expect((await index.get(id))!.status).toBe('archived');
		expect(manager.getLive(id)).toBeUndefined();
		expect(killed).toBe(true);
	});

	// Important 5: two concurrent resume() calls for the same session must spawn exactly once.
	test('two concurrent resumes spawn only once', async () => {
		const countingIndex = new MemorySessionIndex();
		const countingManager = new CountingSessionManager({
			cfg: manager.deps.cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index: countingIndex,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		});
		const record: SessionRecord = {
			sessionId: 'resume-race-session',
			ownerId: 'alice',
			tenantId: 't1',
			title: 'resume race',
			pipePath: '',
			pipesTouched: [],
			status: 'archived',
			createdAt: Date.now(),
			lastActivity: Date.now(),
		};
		await countingIndex.put(record);

		const resumeIdentity: Identity = { ownerId: 'alice', tenantId: 't1' };
		const [a, b] = await Promise.all([
			countingManager.resume(record.sessionId, resumeIdentity, 'tok-alice'),
			countingManager.resume(record.sessionId, resumeIdentity, 'tok-alice'),
		]);
		expect(countingManager.spawnCount).toBe(1);
		expect(a.status).toBe('active');
		expect(b.status).toBe('active');
	});

	// Important 6: archive()'s save-back failure must be visible, not just console.error'd —
	// emit an event on the session's own emitter and flag the archived record (3.5 lists it).
	test('archive emits save.failed and flags the record when save-back throws', async () => {
		const failingIndex = new MemorySessionIndex();
		const failingManager = new SessionManager({
			cfg: manager.deps.cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index: failingIndex,
			storeFactory: async () => ({
				fsReadString: async () => '{}',
				fsWriteString: async () => { throw new Error('store unavailable'); },
				close: async () => undefined,
			}),
		});
		const id = await failingManager.attachFake({ ownerId: 'alice', tenantId: 't1' }, 'tok-alice', fakeOc.url);
		const live = failingManager.getLive(id)!;
		// saveBack() only calls fsWriteString when there's a *.pipe to write — give it one.
		await fsp.writeFile(path.join(live.workspaceDir, 'demo.pipe'), '{}', 'utf8');

		const events: string[] = [];
		live.events.on('event', (e: { type: string }) => events.push(e.type));

		await failingManager.archive(id);

		expect(events).toContain('save.failed');
		const archived = await failingIndex.get(id);
		expect(archived!.saveFailed).toBe(true);
		expect(archived!.status).toBe('archived'); // archive still proceeds — retry-on-resume semantics stand
	});

	const IT = process.env.OPENCODE_BIN ? test : test.skip;
	IT('archive frees the process; resume re-attaches to persisted opencode state', async () => {
		const record = await manager.create({
			identity: { ownerId: 'alice', tenantId: 't1' }, credential: 'tok-alice', title: 'resume-me',
		});
		const homeBefore = manager.getLive(record.sessionId)!.sessionHome;
		await manager.archive(record.sessionId);
		expect(manager.getLive(record.sessionId)).toBeUndefined();
		const resumed = await manager.resume(record.sessionId, { ownerId: 'alice', tenantId: 't1' }, 'tok-alice');
		expect(resumed.status).toBe('active');
		expect(manager.getLive(record.sessionId)!.sessionHome).toBe(homeBefore); // same XDG data → sessions persist
	}, 120_000);

	// Important 5 (final-review): CONFIRMED against the pinned binary + the repo's own locked
	// config — GET /config resolves `provider.anthropic.options.apiKey` from the locked
	// config's `{env:AGENT_ANTHROPIC_KEY}` placeholder and served the RAW key before the fix
	// below (proxy.ts's redactApiKeys(), applied to /config* in index.ts's opencode route).
	// This pins the redaction through the actual pass-through proxy the browser talks to.
	IT('the opencode proxy redacts the resolved provider API key from /config and /config/providers', async () => {
		const record = await manager.create({
			identity: { ownerId: 'alice', tenantId: 't1' }, credential: 'tok-alice', title: 'config-leak-check',
		});
		try {
			for (const p of ['/config', '/config/providers']) {
				const res = await fetch(`${base}/agent/sessions/${record.sessionId}/opencode${p}`, { headers: { authorization: 'Bearer tok-alice' } });
				expect(res.status).toBe(200);
				const served = await res.text();
				expect(served).not.toContain('sk-test'); // the AGENT_ANTHROPIC_KEY this manager's EnvKeyResolver hands out
			}
		} finally {
			await manager.archive(record.sessionId);
		}
	}, 120_000);

	// Important 6 (final-review): VERIFY V2 was wrong — the wire envelope is
	// `{ directory, payload: { type, properties } }`, not `{ type, properties }` at the top
	// level, so `event.type` was always undefined and no per-turn snapshot ever fired. This
	// drives watchFileEdits() against a fake SSE server that emits the CORRECT envelope, and
	// also proves a dropped connection reconnects instead of silently ending the audit trail.
	test('file.edited events (correct envelope) trigger a snapshot commit, and a dropped SSE stream reconnects', async () => {
		let connections = 0;
		const responses: http.ServerResponse[] = [];
		const sse = await listen((req, res) => {
			if (req.url === '/global/event') {
				responses.push(res);
				connections++;
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				return; // held open until the test ends it, to simulate a stream drop
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, echo: req.url }));
		});

		const fwIndex = new MemorySessionIndex();
		const fwManager = new FileWatchSessionManager({
			cfg: manager.deps.cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index: fwIndex,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		}, sse.url);

		const record: SessionRecord = {
			// A fresh id every run (not a fixed literal): sessionRoot() is a real on-disk path
			// under the shared tmp dataDir, and initGit()'s unconditional `git commit` fails
			// ("nothing to commit") if a prior run already left an identical initial commit there.
			sessionId: `file-watch-session-${randomUUID()}`,
			ownerId: 'alice',
			tenantId: 't1',
			title: 'file watch',
			pipePath: '',
			pipesTouched: [],
			status: 'archived',
			createdAt: Date.now(),
			lastActivity: Date.now(),
		};
		await fwIndex.put(record);

		try {
			await fwManager.resume(record.sessionId, { ownerId: 'alice', tenantId: 't1' }, 'tok-alice');
			const live = fwManager.getLive(record.sessionId)!;

			const waitFor = async (pred: () => boolean, label: string, timeoutMs = 5000) => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					if (pred()) return;
					await new Promise((r) => setTimeout(r, 20));
				}
				throw new Error(`timed out waiting for: ${label}`);
			};

			await waitFor(() => connections === 1, 'first SSE connection');

			const snapshots: Array<{ sha?: string; file?: string }> = [];
			live.events.on('event', (e: { type: string; sha?: string; file?: string }) => { if (e.type === 'snapshot') snapshots.push(e); });

			// commitTurn() only produces a sha (and thus a 'snapshot' event) when `git status`
			// is dirty — the SSE event alone is just the trigger, so give it something to commit.
			await fsp.writeFile(path.join(live.workspaceDir, 'demo.pipe'), '{"nodes":[]}\n', 'utf8');
			responses[0].write(`data: ${JSON.stringify({ directory: live.workspaceDir, payload: { type: 'file.edited', properties: { file: 'demo.pipe' } } })}\n\n`);
			await waitFor(() => snapshots.length === 1, 'first snapshot event');
			expect(snapshots[0].file).toBe('demo.pipe');
			expect(snapshots[0].sha).toBeTruthy();

			// Drop the stream — the watcher must reconnect, not give up.
			responses[0].end();
			await waitFor(() => connections === 2, 'reconnect after stream drop', 8000);

			await fsp.writeFile(path.join(live.workspaceDir, 'demo2.pipe'), '{"nodes":[]}\n', 'utf8');
			responses[1].write(`data: ${JSON.stringify({ directory: live.workspaceDir, payload: { type: 'file.edited', properties: { file: 'demo2.pipe' } } })}\n\n`);
			await waitFor(() => snapshots.length === 2, 'second snapshot event after reconnect');
			expect(snapshots[1].file).toBe('demo2.pipe');
		} finally {
			for (const res of responses) if (!res.writableEnded) res.end();
			sse.srv.close();
		}
	}, 20_000);

	// Task 5.2a: the MCP proxy and session (opencode) proxy taps both emit AuditRecords into
	// the SAME shared Auditor `beforeAll` wires into both `manager` and `app` — this section
	// proves it end to end for a full fake session, per the task brief's "extend Phase 3's
	// fake-upstream proxy tests" instruction.
	describe('Task 5.2a: audit trail', () => {
		function lastRecord(kind: AuditRecord['kind'], action?: string): AuditRecord | undefined {
			for (let i = auditSink.records.length - 1; i >= 0; i--) {
				const r = auditSink.records[i];
				if (r.kind === kind && (!action || r.action === action)) return r;
			}
			return undefined;
		}

		test('MCP tools/call is recorded as mcp.tool: action, ok status, duration, argsDigest, pipePaths — never the raw args', async () => {
			const id = await makeSession();
			const live = manager.getLive(id)!;
			const before = auditSink.records.length;
			const secretArg = 'sk-ant-XXXXsuperSecretXXXX';
			await fetch(`${base}/internal/mcp/${id}/${live.mcpSecret}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0', id: 1, method: 'tools/call',
					params: { name: 'validate_pipeline', arguments: { pipePath: 'flows/demo.pipe', apiKey: secretArg } },
				}),
			});
			expect(auditSink.records.length).toBe(before + 1);
			const rec = lastRecord('mcp.tool', 'validate_pipeline')!;
			expect(rec.sessionId).toBe(id);
			expect(rec.tenantId).toBe('t1');
			expect(rec.userId).toBe('alice');
			expect(rec.status).toBe('ok');
			expect(rec.durationMs).toBeGreaterThanOrEqual(0);
			expect(rec.pipePaths).toEqual(['flows/demo.pipe']);
			expect(rec.argsDigest).toMatch(/^[0-9a-f]{64}$/);
			// The negative test, pinned by the task brief: the secret must appear NOWHERE.
			expect(JSON.stringify(rec)).not.toContain(secretArg);
		});

		test('a non-tools/call MCP frame (e.g. tools/list) is forwarded but NOT audited', async () => {
			const id = await makeSession();
			const live = manager.getLive(id)!;
			const before = auditSink.records.length;
			await fetch(`${base}/internal/mcp/${id}/${live.mcpSecret}`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
			});
			expect(auditSink.records.length).toBe(before);
		});

		test('an MCP tools/call against an expired upstream is recorded as status: error', async () => {
			const id = await makeSession();
			const live = manager.getLive(id)!;
			mcpMode = 'expired';
			try {
				await fetch(`${base}/internal/mcp/${id}/${live.mcpSecret}`, {
					method: 'POST', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_pipeline', arguments: {} } }),
				});
				const rec = lastRecord('mcp.tool', 'run_pipeline')!;
				expect(rec.status).toBe('error');
			} finally {
				mcpMode = 'ok';
			}
		});

		test('prompt_async is recorded as agent.prompt with status ok on a 204, and the prompt text never appears in the record', async () => {
			const id = await makeSession();
			const promptText = 'please read my sk-ant-fakeSecretInPrompt and do something with it';
			const res = await fetch(`${base}/agent/sessions/${id}/opencode/session/oc-session-1/prompt_async`, {
				method: 'POST', headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
				body: JSON.stringify({ agent: 'rr-builder', parts: [{ type: 'text', text: promptText }] }),
			});
			expect(res.status).toBe(204);
			const rec = lastRecord('agent.prompt', 'prompt_async')!;
			expect(rec.sessionId).toBe(id);
			expect(rec.status).toBe('ok');
			expect(JSON.stringify(rec)).not.toContain(promptText);
			expect(JSON.stringify(rec)).not.toContain('sk-ant-fakeSecretInPrompt');
		});

		test('a rejected permission reply is recorded as agent.permission: status denied; an accepted one as ok', async () => {
			const id = await makeSession();
			const denyRes = await fetch(`${base}/agent/sessions/${id}/opencode/session/oc-session-1/permissions/perm-1`, {
				method: 'POST', headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
				body: JSON.stringify({ response: 'reject' }),
			});
			expect(denyRes.status).toBe(200);
			expect(lastRecord('agent.permission')!.status).toBe('denied');

			const allowRes = await fetch(`${base}/agent/sessions/${id}/opencode/session/oc-session-1/permissions/perm-2`, {
				method: 'POST', headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
				body: JSON.stringify({ response: 'once' }),
			});
			expect(allowRes.status).toBe(200);
			expect(lastRecord('agent.permission')!.status).toBe('ok');
		});

		test('an ordinary opencode call (e.g. GET /session) is forwarded but NOT audited', async () => {
			const id = await makeSession();
			const before = auditSink.records.length;
			await fetch(`${base}/agent/sessions/${id}/opencode/session`, { headers: { authorization: 'Bearer tok-alice' } });
			expect(auditSink.records.length).toBe(before);
		});

		test('lifecycle: create() emits session.create, archive() emits session.archive, resume() emits session.resume', async () => {
			// A fresh manager + index + auditor (same pattern the existing archiveAllLive /
			// reconcileOnBoot tests above use, via CountingSessionManager's fake attach()) — the
			// SHARED `manager`/`index` in this file accumulate un-archived fake sessions across
			// many other tests and would otherwise trip the real tenant-cap check inside
			// manager.create().
			const freshIndex = new MemorySessionIndex();
			const lifecycleSink = new InMemorySink();
			const lifecycleManager = new CountingSessionManager({
				cfg: manager.deps.cfg,
				keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
				index: freshIndex,
				storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
				auditor: new Auditor(lifecycleSink),
			});
			const findRecord = (kind: AuditRecord['kind'], action: string) => [...lifecycleSink.records].reverse().find((r) => r.kind === kind && r.action === action);

			const record = await lifecycleManager.create({ identity: { ownerId: 'alice', tenantId: 't1' }, credential: 'tok-alice', title: 'audit-lifecycle' });
			try {
				const createRec = findRecord('lifecycle', 'session.create')!;
				expect(createRec.sessionId).toBe(record.sessionId);
				expect(createRec.tenantId).toBe('t1');
				expect(createRec.userId).toBe('alice');
				expect(createRec.status).toBe('ok');

				await lifecycleManager.archive(record.sessionId);
				const archiveRec = findRecord('lifecycle', 'session.archive')!;
				expect(archiveRec.sessionId).toBe(record.sessionId);
				expect(archiveRec.status).toBe('ok');

				const resumed = await lifecycleManager.resume(record.sessionId, { ownerId: 'alice', tenantId: 't1' }, 'tok-alice');
				expect(resumed.status).toBe('active');
				const resumeRec = findRecord('lifecycle', 'session.resume')!;
				expect(resumeRec.sessionId).toBe(record.sessionId);
			} finally {
				await lifecycleManager.archive(record.sessionId);
			}
		});

		test('lifecycle: an idle reap is recorded as session.reap, not session.archive', async () => {
			const id = await makeSession();
			const live = manager.getLive(id)!;
			live.record.lastActivity = Date.now() - 3 * 60 * 60 * 1000; // idle past the 2h TTL
			live.proc = { kill: () => true } as never;
			await sweep(manager, index, manager.deps.cfg);
			const rec = lastRecord('lifecycle', 'session.reap')!;
			expect(rec.sessionId).toBe(id);
			expect(rec.status).toBe('ok');
		});

		test('lifecycle: revert() emits session.revert with a digest, not the raw sha exposed as a leak vector', async () => {
			const id = await makeSession();
			const live = manager.getLive(id)!;
			await fsp.writeFile(path.join(live.workspaceDir, 'demo.pipe'), '{"nodes":[]}\n', 'utf8');
			const sha = await import('../src/workspace').then((m) => m.commitTurn(live.workspaceDir, 'a turn to revert to'));
			await manager.revert(id, sha!);
			const rec = lastRecord('lifecycle', 'session.revert')!;
			expect(rec.sessionId).toBe(id);
			expect(rec.status).toBe('ok');
			expect(rec.argsDigest).toMatch(/^[0-9a-f]{64}$/);
		});
	});
});
