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

// Task 4: `GET /agent/providers` — lets the panel learn which inference providers the agent
// supports (Task 1's PROVIDERS registry) without leaking `baseURL` (openai-compatible
// providers' upstream URL) or any secret. Harness mirrors tests/gate.test.ts: a REAL Express
// app via createApp(), a REAL SessionManager, and a fake IdentityResolver — this route never
// touches sessions, so no live session/opencode fixture is needed here.

import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentConfig, loadConfig } from '../src/config';
import { createApp, EnvKeyResolver } from '../src/index';
import { PROVIDERS } from '../src/providers';
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

const CREDENTIAL = 'tok-alice';

// Deterministic stand-in for opencode's built-in native catalog (catalog.ts), so the route
// test never spawns a real opencode. Only `openai` gets models here; every other native
// provider resolves to [] (mirrors a provider opencode's catalog didn't list).
const STUB_NATIVE_CATALOG: Record<string, Array<{ id: string; title: string }>> = {
	openai: [{ id: 'gpt-x', title: 'GPT-X' }],
};

function freshCfg(): AgentConfig {
	return loadConfig({
		RR_MCP_UPSTREAM: 'http://127.0.0.1:1', // never dialed by this route
		AGENT_ANTHROPIC_KEY: 'sk-test',
		RR_AGENT_DATA_DIR: path.join(os.tmpdir(), `ra-providers-test-${randomUUID()}`),
	} as NodeJS.ProcessEnv);
}

describe('Task 4: GET /agent/providers', () => {
	let app: ReturnType<typeof createApp>;
	let appSrv: ReturnType<typeof app.listen>;
	let base: string;

	beforeAll(async () => {
		const cfg = freshCfg();
		const index = new MemorySessionIndex();
		const manager = new SessionManager({
			cfg,
			keys: new EnvKeyResolver({ AGENT_ANTHROPIC_KEY: 'sk-test' } as NodeJS.ProcessEnv),
			index,
			storeFactory: async () => ({ fsReadString: async () => '{}', fsWriteString: async () => undefined, close: async () => undefined }),
		});
		app = createApp({
			cfg, manager, index,
			identity: new FakeIdentityResolver({ [CREDENTIAL]: { ownerId: 'alice', tenantId: 't1' } }),
			nativeCatalog: async () => STUB_NATIVE_CATALOG,
		});
		appSrv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => appSrv.once('listening', r));
		base = `http://127.0.0.1:${(appSrv.address() as AddressInfo).port}`;
	});

	afterAll(() => { appSrv.close(); });

	it('lists supported providers with models, without leaking baseURL', async () => {
		const res = await fetch(`${base}/agent/providers`, { headers: { authorization: `Bearer ${CREDENTIAL}` } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { providers: Array<Record<string, unknown>> };
		expect(body.providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(['openai', 'anthropic']));
		// baseURL is the compat providers' upstream — must never be exposed to the panel.
		for (const p of body.providers) expect(p).not.toHaveProperty('baseURL');
		// Exact shape + values: id/rrNode/label/keyVar/mode + models. Native providers' models
		// come from the injected catalog stub; openai-compatible providers carry their curated list.
		expect(body.providers).toEqual(
			PROVIDERS.map(({ id, rrNode, label, keyVar, mode, models }) => ({
				id, rrNode, label, keyVar, mode,
				models: mode === 'native' ? (STUB_NATIVE_CATALOG[id] ?? []) : (models ?? []),
			})),
		);
		// The openai native provider surfaces the stub's model; a compat provider surfaces its curated list.
		const openai = body.providers.find((p: any) => p.id === 'openai') as any;
		expect(openai.models).toEqual([{ id: 'gpt-x', title: 'GPT-X' }]);
		const kimi = body.providers.find((p: any) => p.id === 'kimi') as any;
		expect(kimi.models.length).toBeGreaterThan(0);
		expect(kimi.models[0]).toHaveProperty('id');
	});

	it('rejects an unauthenticated request', async () => {
		const res = await fetch(`${base}/agent/providers`);
		expect(res.status).toBe(401);
	});
});
