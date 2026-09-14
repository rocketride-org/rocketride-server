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

// Fix-round coverage for Task 5's `POST /agent/sessions/:id/gate` (review Important gap:
// this route shipped with zero automated tests despite carrying the task's explicit
// owner-check constraint). Harness mirrors tests/quotas.test.ts / tests/proxy.test.ts:
// a REAL Express app via createApp(), a REAL SessionManager, and manager.attachFake() to
// register a LiveSession without spawning an opencode binary — the gate route never dials
// opencode, so no fake upstream server is needed here.

import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentConfig, loadConfig } from '../src/config';
import { createApp, EnvKeyResolver } from '../src/index';
import { MemorySessionIndex } from '../src/sessionIndex';
import { SessionManager } from '../src/session';
import type { Identity, IdentityResolver } from '../src/types';

class FakeIdentityResolver implements IdentityResolver {
	constructor(private map: Record<string, Identity>) {}
	async resolve(credential: string): Promise<Identity> {
		const id = this.map[credential];
		if (!id) throw new Error('bad credential');
		return id;
	}
}

const ALICE_TOKEN = 'tok-alice';
const BOB_TOKEN = 'tok-bob';

function freshCfg(): AgentConfig {
	return loadConfig({
		RR_MCP_UPSTREAM: 'http://127.0.0.1:1', // never dialed by this route
		AGENT_ANTHROPIC_KEY: 'sk-test',
		RR_AGENT_DATA_DIR: path.join(os.tmpdir(), `ra-gate-test-${randomUUID()}`),
	} as NodeJS.ProcessEnv);
}

describe('Task 5 fix round: POST /agent/sessions/:id/gate', () => {
	let manager: SessionManager;
	let index: MemorySessionIndex;
	let app: ReturnType<typeof createApp>;
	let appSrv: ReturnType<typeof app.listen>;
	let base: string;

	beforeAll(async () => {
		const cfg = freshCfg();
		index = new MemorySessionIndex();
		manager = new SessionManager({
			cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		});
		app = createApp({
			cfg, manager, index,
			identity: new FakeIdentityResolver({
				[ALICE_TOKEN]: { ownerId: 'alice', tenantId: 't1' },
				[BOB_TOKEN]: { ownerId: 'bob', tenantId: 't2' },
			}),
		});
		appSrv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => appSrv.once('listening', r));
		base = `http://127.0.0.1:${(appSrv.address() as AddressInfo).port}`;
	});

	afterAll(() => { appSrv.close(); });

	async function makeSessionWithGate(): Promise<string> {
		const id = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, ALICE_TOKEN, 'http://127.0.0.1:1');
		const live = manager.getLive(id)!;
		live.turn.awaitingGate = { id: 'run-cost', options: ['run', 'cancel'] };
		return id;
	}

	async function postGate(id: string, token: string, body: unknown) {
		return fetch(`${base}/agent/sessions/${id}/gate`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	// MANDATORY (the task's named owner-check constraint): a foreign owner must be rejected
	// BEFORE any state mutation. This exercises the real owner check — it fails if the check
	// is removed, since bob's request would otherwise clear alice's live gate.
	test('a foreign owner is rejected 404, and the gate is left untouched', async () => {
		const id = await makeSessionWithGate();
		const live = manager.getLive(id)!;

		const res = await postGate(id, BOB_TOKEN, { id: 'run-cost', option: 'run' });

		expect(res.status).toBe(404);
		expect((await res.json()) as { error: string }).toEqual({ error: 'no such session' });
		// The state mutation (clearing awaitingGate) must never have happened for bob's request.
		expect(live.turn.awaitingGate).toEqual({ id: 'run-cost', options: ['run', 'cancel'] });
	});

	test('missing id or option is rejected 400', async () => {
		const id = await makeSessionWithGate();

		const missingId = await postGate(id, ALICE_TOKEN, { option: 'run' });
		expect(missingId.status).toBe(400);

		const missingOption = await postGate(id, ALICE_TOKEN, { id: 'run-cost' });
		expect(missingOption.status).toBe(400);

		// Neither malformed request touched the still-open gate.
		expect(manager.getLive(id)!.turn.awaitingGate).toEqual({ id: 'run-cost', options: ['run', 'cancel'] });
	});

	// The race guard (index.ts ~46-49): answering a gate id that doesn't match the currently
	// open one (e.g. the user's answer to gate A arrives after the agent already opened gate B).
	test('a mismatched/stale gate id is rejected 409, and the currently-open gate is left untouched', async () => {
		const id = await makeSessionWithGate();
		const live = manager.getLive(id)!;

		const res = await postGate(id, ALICE_TOKEN, { id: 'some-other-gate', option: 'run' });

		expect(res.status).toBe(409);
		expect(live.turn.awaitingGate).toEqual({ id: 'run-cost', options: ['run', 'cancel'] });
	});

	// New contract (final-review close-the-loop fix): /gate RECORDS the answer and emits
	// gate.answered, but deliberately does NOT clear awaitingGate — the prompt proxy consumes it
	// one-shot on the next prompt_async (see tests/gate-loop.test.ts). Clearing it here would strip
	// the answering context off the very turn that answers the gate.
	test('a valid answer emits gate.answered and leaves the gate for the proxy to consume', async () => {
		const id = await makeSessionWithGate();
		const live = manager.getLive(id)!;
		const events: Array<{ type: string; id?: string; option?: string }> = [];
		live.events.on('event', (e: { type: string; id?: string; option?: string }) => events.push(e));

		const res = await postGate(id, ALICE_TOKEN, { id: 'run-cost', option: 'run' });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: 'run-cost', option: 'run' });
		// Still set — the proxy, not this route, consumes it on the answering prompt.
		expect(live.turn.awaitingGate).toEqual({ id: 'run-cost', options: ['run', 'cancel'] });
		expect(events).toContainEqual({ type: 'gate.answered', id: 'run-cost', option: 'run' });
	});
});
