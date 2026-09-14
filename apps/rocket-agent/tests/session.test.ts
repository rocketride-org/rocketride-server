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

import { EventEmitter } from 'node:events';
import { loadConfig } from '../src/config';
import { MemorySessionIndex } from '../src/index';
import { SessionManager, SessionManagerDeps } from '../src/session';
import { HttpError, Identity, KeyResolver, LiveSession, ProviderKeys, SessionRecord } from '../src/types';

class FakeKeyResolver implements KeyResolver {
	async resolve(): Promise<ProviderKeys> {
		return { anthropic: 'sk-ant-fake' };
	}
}

/**
 * Overrides the protected attach() hook (the extension point the brief
 * reserves for Task 3.3's resume path) so these tests never touch a real
 * child_process — just a configurable delay and pass/fail outcome.
 */
class FakeSessionManager extends SessionManager {
	constructor(
		deps: SessionManagerDeps,
		private spawnDelayMs: number,
		private shouldFail: () => boolean = () => false,
	) {
		super(deps);
	}

	protected async attach(record: SessionRecord, _providerKeys: ProviderKeys, credential: string, sessionRoot: string): Promise<LiveSession> {
		await new Promise((resolve) => setTimeout(resolve, this.spawnDelayMs));
		if (this.shouldFail()) throw new Error('fake spawn failure');
		return {
			record,
			proc: {} as LiveSession['proc'],
			port: 0,
			password: 'fake',
			baseUrl: 'http://127.0.0.1:0',
			mcpSecret: 'fake',
			latestToken: credential,
			workspaceDir: sessionRoot,
			sessionHome: sessionRoot,
			events: new EventEmitter(),
			openStreams: 0,
		};
	}
}

const identity: Identity = { ownerId: 'owner-1', tenantId: 'tenant-1' };

function deps(index: MemorySessionIndex, cap: number): SessionManagerDeps {
	return {
		cfg: loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:8080/mcp', RR_MAX_SESSIONS_PER_TENANT: String(cap) }),
		keys: new FakeKeyResolver(),
		index,
		storeFactory: async () => { throw new Error('not used by create()'); },
	};
}

describe('SessionManager.create() session-cap concurrency', () => {
	test('two concurrent creates for a cap=1 tenant: exactly one succeeds, one gets 429', async () => {
		const index = new MemorySessionIndex();
		const manager = new FakeSessionManager(deps(index, 1), 50);

		const results = await Promise.allSettled([
			manager.create({ identity, credential: 'cred-a' }),
			manager.create({ identity, credential: 'cred-b' }),
		]);

		const fulfilled = results.filter((r): r is PromiseFulfilledResult<SessionRecord> => r.status === 'fulfilled');
		const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

		expect(fulfilled).toHaveLength(1);
		expect(fulfilled[0].value.status).toBe('active');
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toBeInstanceOf(HttpError);
		expect((rejected[0].reason as HttpError).status).toBe(429);

		// The cap was never actually exceeded in the index, not just in the responses.
		expect(await index.countActive('tenant-1')).toBe(1);
	});

	test('on spawn failure, the reservation is cleaned up and frees the cap slot', async () => {
		const index = new MemorySessionIndex();
		const failingManager = new FakeSessionManager(deps(index, 1), 10, () => true);

		await expect(failingManager.create({ identity, credential: 'cred-a' })).rejects.toThrow(/fake spawn failure/);
		expect(await index.countActive('tenant-1')).toBe(0);

		// A follow-up create() against the SAME index must not see a phantom
		// reservation still holding the cap.
		const succeedingManager = new FakeSessionManager(deps(index, 1), 10, () => false);
		const record = await succeedingManager.create({ identity, credential: 'cred-b' });
		expect(record.status).toBe('active');
		expect(await index.countActive('tenant-1')).toBe(1);
	});
});

/** attach() always succeeds and hands back a `proc` whose kill() is a spy — isolates the
 * final-review Important 3 fix (a failure AFTER a successful attach must still kill the
 * child) from the already-covered "attach() itself throws" case above. */
class KillTrackingSessionManager extends SessionManager {
	readonly killSpy = jest.fn();
	protected async attach(record: SessionRecord, _providerKeys: ProviderKeys, credential: string, sessionRoot: string): Promise<LiveSession> {
		const live: LiveSession = {
			record,
			proc: { kill: this.killSpy } as unknown as LiveSession['proc'],
			port: 0,
			password: 'fake',
			baseUrl: 'http://127.0.0.1:0',
			mcpSecret: 'fake',
			latestToken: credential,
			workspaceDir: sessionRoot,
			sessionHome: sessionRoot,
			events: new EventEmitter(),
			openStreams: 0,
		};
		// `live` is private on SessionManager (not protected) — same reach-through cast
		// proxy.test.ts's CountingSessionManager uses — needed so killAndEvict()'s
		// `this.live.get(id)` (and getLive()/listLive() for the test's own assertions)
		// actually see this session, matching what the REAL attach() does internally.
		(this as unknown as { live: Map<string, LiveSession> }).live.set(record.sessionId, live);
		return live;
	}
}

/** Succeeds on the reservation write (put #1) but throws on the post-attach commit (put #2) — the exact ordering Important 3 targets. */
class FailsSecondPutIndex extends MemorySessionIndex {
	private puts = 0;
	async put(r: SessionRecord) {
		this.puts++;
		if (this.puts === 2) throw new Error('simulated index outage on post-attach commit');
		return super.put(r);
	}
}

describe('SessionManager.create() / resume() clean up a SUCCESSFUL attach() on a later failure (final-review Important 3)', () => {
	test('create(): index.put failing after attach() succeeded still kills the child and evicts the live-map entry', async () => {
		const index = new FailsSecondPutIndex();
		const manager = new KillTrackingSessionManager({
			cfg: loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:8080/mcp', RR_MAX_SESSIONS_PER_TENANT: '1' }),
			keys: new FakeKeyResolver(),
			index,
			storeFactory: async () => ({ fsReadString: async () => '', fsWriteString: async () => undefined, close: async () => undefined }),
		});

		await expect(manager.create({ identity, credential: 'cred-a' })).rejects.toThrow(/simulated index outage/);

		expect(manager.killSpy).toHaveBeenCalledWith('SIGTERM');
		expect(manager.listLive()).toHaveLength(0); // no orphaned live-map entry with no index record behind it
		expect(await index.countActive('tenant-1')).toBe(0); // the reservation was released too

		// The cap slot is genuinely free, not phantom-held by the orphan.
		const clean = new KillTrackingSessionManager({
			cfg: loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:8080/mcp', RR_MAX_SESSIONS_PER_TENANT: '1' }),
			keys: new FakeKeyResolver(),
			index: new MemorySessionIndex(),
			storeFactory: async () => ({ fsReadString: async () => '', fsWriteString: async () => undefined, close: async () => undefined }),
		});
		const record = await clean.create({ identity, credential: 'cred-b' });
		expect(record.status).toBe('active');
	});

	test('resume(): index.put failing after attach() succeeded still kills the child and evicts the live-map entry', async () => {
		const index = new FailsSecondPutIndex();
		const existing: SessionRecord = {
			sessionId: 'resume-cleanup-session', ownerId: identity.ownerId, tenantId: identity.tenantId, title: 'x',
			pipePath: '', pipesTouched: [], status: 'archived', createdAt: Date.now(), lastActivity: Date.now(),
		};
		await index.put(existing); // put #1 (reservation-equivalent) — succeeds
		const manager = new KillTrackingSessionManager({
			cfg: loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:8080/mcp', RR_MAX_SESSIONS_PER_TENANT: '1' }),
			keys: new FakeKeyResolver(),
			index,
			storeFactory: async () => ({ fsReadString: async () => '', fsWriteString: async () => undefined, close: async () => undefined }),
		});

		await expect(manager.resume(existing.sessionId, identity, 'cred-a')).rejects.toThrow(/simulated index outage/);

		expect(manager.killSpy).toHaveBeenCalledWith('SIGTERM');
		expect(manager.listLive()).toHaveLength(0);
	});
});
