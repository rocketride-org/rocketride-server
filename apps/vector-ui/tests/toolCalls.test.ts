// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// toolCalls — one outcome for both ways a tool call can fail
// =============================================================================
//
// A tool answers a failure envelope or the call rejects; the chat and ingest
// panels branch on the code either way (NOT_FOUND, RATE_LIMITED), so both are
// folded into one outcome that keeps it. Calls always name the target node.
// =============================================================================

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerEndpoint, IInvokeOptions, IRoleChannel, ISendFile } from 'shared/explorer';
import type { ConsoleModel, VectorChannels } from '../src/contract/types';
import { callTool, outcomeFromError, toolChannelFor } from '../src/chat/toolCalls';

/** Most a test here may take: they await fakes, so a regression must fail, not hang the run. */
const TEST_TIMEOUT_MS = 10_000;

/**
 * Declare a test bounded by {@link TEST_TIMEOUT_MS}.
 *
 * @param name - What it checks.
 * @param fn - The test.
 */
function test(name: string, fn: () => void | Promise<void>): void {
	void nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

/**
 * A fake role channel whose invoke answers from a function.
 *
 * @param role - The role.
 * @param answer - What invoke resolves or throws.
 * @returns The channel and the calls it saw.
 */
function channel(role: string, answer: (tool: string, input: Record<string, unknown>, opts: IInvokeOptions) => unknown): { channel: IRoleChannel; calls: Array<{ tool: string; input: Record<string, unknown>; opts: IInvokeOptions }> } {
	const calls: Array<{ tool: string; input: Record<string, unknown>; opts: IInvokeOptions }> = [];
	return {
		calls,
		channel: {
			role,
			bound: true,
			async sendFiles(_files: ISendFile[]) {
				return [];
			},
			async ask() {
				return {};
			},
			async invoke<T>(tool: string, input: Record<string, unknown> = {}, opts: IInvokeOptions = {}): Promise<T> {
				calls.push({ tool, input, opts });
				return (await answer(tool, input, opts)) as T;
			},
		},
	};
}

test('callTool: a success answer is the value; the node id is always passed', async () => {
	const fake = channel('tools', () => ({ success: true, items: [], total: 0 }));
	const outcome = await callTool(fake.channel, 'chunks', { object_id: 'o', limit: 1 }, 'store_1', { timeoutMs: 5000 });
	assert.deepEqual(outcome, { ok: true, value: { success: true, items: [], total: 0 } });
	assert.deepEqual(fake.calls, [{ tool: 'chunks', input: { object_id: 'o', limit: 1 }, opts: { nodeId: 'store_1', timeoutMs: 5000 } }]);
});

test('callTool: a failure envelope keeps its code, error and extra fields', async () => {
	const envelope = { success: false, code: 'RATE_LIMITED', error: 'Too many embed calls on this task; try again in 12 s.', retry_after_s: 12 };
	const outcome = await callTool(channel('tools', () => envelope).channel, 'embed', { texts: ['q'] }, 'embed_1');
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.code, 'RATE_LIMITED');
	assert.equal(outcome.message, envelope.error);
	assert.equal(outcome.error, envelope);
	assert.equal(outcome.kind, null);
});

test('callTool: a rejection keeps the error kind, headline, detail and code', async () => {
	const thrown = new ExplorerToolError({ kind: 'raised', tool: 'chunks', message: 'No handler found\nfor tool chunks', code: 'NOT_FOUND' });
	const outcome = await callTool(
		channel('tools', () => {
			throw thrown;
		}).channel,
		'chunks',
		{},
		'store_1'
	);
	assert.deepEqual(outcome, { ok: false, code: 'NOT_FOUND', message: 'No handler found', detail: 'for tool chunks', kind: 'raised', error: thrown });
	assert.deepEqual(outcomeFromError('plain'), { ok: false, code: null, message: 'plain', kind: null, error: 'plain' });
	const timeout = outcomeFromError(new ExplorerToolError({ kind: 'timeout', tool: 'search', message: 'Stopped waiting' }));
	assert.equal(timeout.kind, 'timeout');
	assert.equal(timeout.code, null);
});

test('callTool: no channel, no node, or a non-object answer are failures, not exceptions', async () => {
	assert.equal((await callTool(null, 'chunks', {}, 'store_1')).ok, false);
	assert.equal((await callTool(channel('tools', () => ({})).channel, 'chunks', {}, null)).ok, false);
	const odd = await callTool(channel('tools', () => 'text').channel, 'chunks', {}, 'store_1');
	assert.equal(odd.ok, false);
	if (!odd.ok) assert.equal(odd.kind, 'malformed');
});

test('toolChannelFor: the Tools source, or in read-only mode the anchor source', () => {
	const tools = channel('tools', () => ({})).channel;
	const chat = channel('chat', () => ({})).channel;
	const ingest = channel('ingest', () => ({})).channel;
	const model = (readOnly: boolean, anchorRole: string): ConsoleModel => ({ readOnly, connection: { endpoint: { anchorRole } as unknown as IExplorerEndpoint, dialect: null } }) as unknown as ConsoleModel;
	const channels = (overrides: Partial<VectorChannels>): VectorChannels => ({ tools: null, chat: null, ingest: null, ...overrides });
	assert.equal(toolChannelFor(model(false, 'tools'), channels({ tools, chat })), tools);
	assert.equal(toolChannelFor(model(false, 'tools'), channels({ chat })), null);
	assert.equal(toolChannelFor(model(true, 'chat'), channels({ chat, ingest })), chat);
	assert.equal(toolChannelFor(model(true, 'ingest'), channels({ chat, ingest })), ingest);
});
