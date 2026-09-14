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

import { loadConfig } from '../src/config';
import { MemorySessionIndex } from '../src/index';
import { pipeShapeFromJson, SessionManager, SessionManagerDeps } from '../src/session';
import type { KeyResolver, LiveSession, ProviderKeys, StoreFs } from '../src/types';

const THREE_NODE_PIPE = JSON.stringify({
	components: [
		{ id: 'webhook_1', provider: 'webhook' },
		{ id: 'parse_1', provider: 'parse', input: [{ lane: 'in', from: 'webhook_1' }] },
		{ id: 'response_1', provider: 'response_text', input: [{ lane: 'in', from: 'parse_1' }] },
	],
	source: 'webhook_1',
});

class FakeKeyResolver implements KeyResolver {
	async resolve(): Promise<ProviderKeys> {
		return { anthropic: 'sk-ant-fake' };
	}
}

describe('pipeShapeFromJson (pure)', () => {
	it('walks source -> ... -> sink by provider name', () => {
		expect(pipeShapeFromJson(THREE_NODE_PIPE)).toBe('webhook → parse → response_text');
	});
	it('returns undefined for invalid JSON', () => {
		expect(pipeShapeFromJson('not json')).toBeUndefined();
	});
	it('returns undefined when there are no components', () => {
		expect(pipeShapeFromJson(JSON.stringify({ components: [] }))).toBeUndefined();
	});
});

describe('SessionManager.describePipeShape', () => {
	/** Records every path `fsReadString` was asked for, so the test can assert the `.projects/` prefix. */
	class RecordingStore implements StoreFs {
		readonly requestedPaths: string[] = [];
		constructor(private readonly pipesByPath: Record<string, string>) {}
		async fsReadString(p: string): Promise<string> {
			this.requestedPaths.push(p);
			const text = this.pipesByPath[p];
			if (text === undefined) throw new Error(`ENOENT ${p}`);
			return text;
		}
		async fsWriteString(): Promise<void> { /* unused */ }
		async close(): Promise<void> { /* unused */ }
	}

	function managerWithStore(store: RecordingStore): SessionManager {
		const deps: SessionManagerDeps = {
			cfg: loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:8080/mcp' }),
			keys: new FakeKeyResolver(),
			index: new MemorySessionIndex(),
			storeFactory: async () => store,
		};
		return new SessionManager(deps);
	}

	// describePipeShape only reads `live.latestToken` — a bare object literal is enough,
	// no real spawn/create() needed.
	const fakeLive = { latestToken: 'cred-a' } as LiveSession;

	it('reads the store at the .projects/-prefixed path when given a stripped x-rr-open-doc uri', async () => {
		const store = new RecordingStore({ '.projects/myflow.pipe': THREE_NODE_PIPE });
		const manager = managerWithStore(store);

		const shape = await manager.describePipeShape(fakeLive, 'myflow.pipe');

		expect(store.requestedPaths).toEqual(['.projects/myflow.pipe']);
		expect(shape).toBe('webhook → parse → response_text');
	});

	it('tolerates a uri that already carries the .projects/ prefix', async () => {
		const store = new RecordingStore({ '.projects/dir/myflow.pipe': THREE_NODE_PIPE });
		const manager = managerWithStore(store);

		const shape = await manager.describePipeShape(fakeLive, '.projects/dir/myflow.pipe');

		expect(store.requestedPaths).toEqual(['.projects/dir/myflow.pipe']);
		expect(shape).toBe('webhook → parse → response_text');
	});

	it('returns undefined (not a throw) when the store has no such pipe', async () => {
		const store = new RecordingStore({});
		const manager = managerWithStore(store);

		await expect(manager.describePipeShape(fakeLive, 'missing.pipe')).resolves.toBeUndefined();
	});
});
