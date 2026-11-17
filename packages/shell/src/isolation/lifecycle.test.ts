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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// LIFECYCLE TESTS — G4 round 1 (DA F4; security L2, L3): runs never escape the ledger
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { ENTRY_A, makeRoot } from './__test__/fixtures';
import { clientRequest, dap, settle } from './__test__/realm';
import { assertDenied, startRun } from './__test__/util';

const execMsg = (): DAPMessage => dap('execute', { pipeline: { components: [], source: 'chat_1' }, args: [], ttl: 60 });
const terminated = (t: ReturnType<typeof makeRoot>): string[] => t.cm.engine.messagesFor('terminate').map((r) => String((r.message.arguments as { token?: string }).token));

test('G4-F4 execute ignores the app timeout; a lost answer is recovered and terminated', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	assert.equal((await clientRequest(A, execMsg(), 1000)).ok, true);
	assert.equal(engine.messagesFor('execute')[0].timeout, 115_000, 'execute is sent with the root budget, not the app timeout');

	const client = engine.client as { request: (m: DAPMessage, timeout?: number) => Promise<DAPMessage> };
	const original = client.request;
	client.request = async (m, timeout) => {
		const r = await original(m, timeout);
		if (m.command === 'execute') throw new Error('Request timed out');
		return r;
	};
	const envelope = await clientRequest(A, execMsg(), 1000);
	assert.equal(envelope.ok, false, 'the realm sees the failure');
	await settle();
	const lost = engine.runs.at(-1)!;
	assert.ok(terminated(t).includes(lost.token), 'the run the engine started is found by its minted project and terminated');
});

test('G4-F4 teardownAll refuses new requests and terminates a run that answers late', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	await startRun(A);
	const releaseExec = engine.hold('execute');
	const pending = clientRequest(A, execMsg());
	await settle();
	const releaseTerm = engine.hold('terminate');
	const tearing = t.root.teardownAll(3000);
	await settle();
	assertDenied(await clientRequest(A, dap('rrext_ping')), ['capability', 'rate', 'unknown_op'], 'a request while the root is closing');
	releaseExec();
	await pending;
	await settle();
	releaseTerm();
	await tearing;
	await settle();
	const late = engine.runs.at(-1)!;
	assert.ok(terminated(t).includes(late.token), 'the late run is terminated, not forgotten');
	assert.equal((await clientRequest(A, dap('rrext_ping'))).ok, true, 'requests work again after teardown');
});

test('G4-F4 detach ends the realm runs', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	await startRun(A);
	A.detach();
	await settle();
	assert.ok(terminated(t).includes(t.cm.engine.runs[0].token), 'detach terminates live runs');
});

test('G4-L3 a run whose answer cannot be recorded is terminated', async (tt) => {
	const t = makeRoot({ __throwIn: 'ledger' });
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const envelope = await clientRequest(A, execMsg());
	assert.equal(envelope.ok, false);
	await settle();
	assert.ok(terminated(t).includes(t.cm.engine.runs[0].token), 'the orphaned run is terminated');
});
