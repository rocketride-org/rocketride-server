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

// Final-review Critical: the gate-answer loop must actually close. This drives the CLOSE-LOOP
// server-side through the REAL prompt-proxy route: with `awaitingGate` set, a prompt_async POST
// forwards to opencode carrying the awaiting-gate context in its `system` field EXACTLY ONCE, and
// the proxy consumes the gate one-shot so no later turn re-injects it (the pre-fix bug where a
// typed answer re-asserted the stale "AWAITING GATE" block on every turn forever).
//
// Harness: a REAL createApp() + REAL SessionManager (manager.attachFake) pointed at a tiny fake
// opencode upstream that just CAPTURES each forwarded prompt_async body and 204s — so the exact
// bytes the proxy forwards can be inspected. Mirrors tests/gate.test.ts's owner-check harness.

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
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

function freshCfg(): AgentConfig {
	return loadConfig({
		RR_MCP_UPSTREAM: 'http://127.0.0.1:1', // never dialed by the prompt-proxy path
		AGENT_ANTHROPIC_KEY: 'sk-test',
		RR_AGENT_DATA_DIR: path.join(os.tmpdir(), `ra-gate-loop-test-${randomUUID()}`),
	} as NodeJS.ProcessEnv);
}

describe('gate-answer loop closes: prompt proxy consumes awaitingGate one-shot', () => {
	let manager: SessionManager;
	let index: MemorySessionIndex;
	let app: ReturnType<typeof createApp>;
	let appSrv: ReturnType<typeof app.listen>;
	let base: string;

	// Fake opencode upstream: record every forwarded prompt body, answer 204 (opencode's
	// prompt_async status — the proxy's audit "ok" path).
	let upstream: http.Server;
	let upstreamBase: string;
	const forwardedPrompts: Array<Record<string, unknown>> = [];

	beforeAll(async () => {
		upstream = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c as Buffer));
			req.on('end', () => {
				try { forwardedPrompts.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* non-JSON — ignore */ }
				res.writeHead(204).end();
			});
		});
		await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
		upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

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
			identity: new FakeIdentityResolver({ [ALICE_TOKEN]: { ownerId: 'alice', tenantId: 't1' } }),
		});
		appSrv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => appSrv.once('listening', r));
		base = `http://127.0.0.1:${(appSrv.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		appSrv.close();
		await new Promise<void>((r) => upstream.close(() => r()));
	});

	async function prompt(id: string, oid: string, text: string) {
		return fetch(`${base}/agent/sessions/${id}/opencode/session/${oid}/prompt_async`, {
			method: 'POST',
			headers: { authorization: `Bearer ${ALICE_TOKEN}`, 'content-type': 'application/json' },
			body: JSON.stringify({ agent: 'rr-builder', parts: [{ type: 'text', text }] }),
		});
	}

	test('the answering prompt carries the awaiting-gate context exactly once, then the gate is gone', async () => {
		const id = await manager.attachFake({ ownerId: 'alice', tenantId: 't1' }, ALICE_TOKEN, upstreamBase);
		const live = manager.getLive(id)!;
		live.turn.awaitingGate = { id: 'run-cost', options: ['run', 'cancel'] };
		forwardedPrompts.length = 0;

		// Turn 1 — the answering prompt (what answerGate()'s follow-up send, or a typed answer, fires).
		const res1 = await prompt(id, 'oc-1', 'Proceed with gate "run-cost": run');
		expect(res1.status).toBe(204);

		// (a) The forwarded prompt's `system` carried the awaiting-gate injection for THIS turn.
		expect(forwardedPrompts).toHaveLength(1);
		const sys1 = forwardedPrompts[0]!.system as string;
		expect(typeof sys1).toBe('string');
		expect(sys1).toContain('AWAITING GATE run-cost');
		// The user's message itself is still forwarded intact — the injection rides `system`, not parts.
		expect(forwardedPrompts[0]!.parts).toBeDefined();

		// (b) One-shot: the gate is consumed off live turn state.
		expect(live.turn.awaitingGate).toBeUndefined();

		// Turn 2 — a later prompt must NOT re-inject the stale gate (the bug this fix closes).
		const res2 = await prompt(id, 'oc-1', 'another message');
		expect(res2.status).toBe(204);
		expect(forwardedPrompts).toHaveLength(2);
		const sys2 = forwardedPrompts[1]!.system;
		// No live state left → no system injected at all (or, if present, no AWAITING GATE).
		expect(typeof sys2 === 'string' ? (sys2 as string) : '').not.toContain('AWAITING GATE');
	});
});
