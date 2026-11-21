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
// ROUND 2 TESTS — G4 round 2 (security R2-M1, R2-L1, queued-run recovery,
// app topic memory; DA N1, N2, N3)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { ENTRY_A, ENTRY_B, makeRoot, refAppKey } from './__test__/fixtures';
import { clientRequest, dap, settle } from './__test__/realm';
import { assertDenied, brief, outcome, startRun } from './__test__/util';
import { walk } from './walk';

const key = refAppKey(ENTRY_A.id);
const keyB = refAppKey(ENTRY_B.id);
const execMsg = (): DAPMessage => dap('execute', { pipeline: { components: [], source: 'chat_1' }, args: [], ttl: 60 });
const codeOf = (m: unknown): string | undefined => {
	const r = m as { __rrbus?: string; ok?: boolean; error?: string };
	if (r?.__rrbus !== 'response' || r.ok !== false || !String(r.error).startsWith('RR_DENIED:')) return undefined;
	return (JSON.parse(String(r.error).slice('RR_DENIED:'.length)) as { code?: string }).code;
};

// =============================================================================
// R2-M1 — oversized names are dropped; every refusal is charged
// =============================================================================

test('G4R2-M1 oversized op names are dropped without an echo, and refusals are charged', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const R = t.open(ENTRY_A, { raw: true });
	const big = `app.${keyB}.${'x'.repeat(5 * 1024 * 1024)}`;
	const started = Date.now();
	for (let i = 0; i < 50; i++) R.post({ __rrbus: 'request', id: `big-${i}`, op: big, params: {}, timeoutMs: 5000 });
	for (let i = 0; i < 60; i++) R.post({ __rrbus: 'request', id: `ns-${i}`, op: `app.${keyB}.x`, params: {}, timeoutMs: 5000 });
	await settle();
	const elapsed = Date.now() - started;
	const longest = Math.max(0, ...R.received.map((m) => JSON.stringify(m).length));
	assert.ok(longest < 64 * 1024, `no oversized echo may reach the realm, the longest message was ${longest} chars`);
	const codes = R.received.map(codeOf).filter((c): c is string => c !== undefined);
	assert.ok(codes.includes('rate'), `refusals must be charged: after 110 refused requests some must be rate denials, got ${brief(codes.slice(-12))}`);
	assert.ok(elapsed < 10_000, `the burst must be handled quickly, took ${elapsed} ms`);
});

test('G4R2-M1 a refused response, unregister or publish is charged too', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const R = t.open(ENTRY_A, { raw: true });
	for (let i = 0; i < 40; i++) R.post({ __rrbus: 'response', id: `nope-${i}`, ok: true, result: 1 });
	for (let i = 0; i < 40; i++) R.post({ __rrbus: 'unregister', ops: Array.from({ length: 1000 }, (_, j) => `app.${key}.op${j}`) });
	for (let i = 0; i < 40; i++) R.post({ __rrbus: 'publish', topic: 'shell:account', snapshot: { i } });
	await settle();
	const reply = await R.rawRequest(`app.${keyB}.x`, {});
	assert.equal(codeOf({ __rrbus: 'response', ...reply }), 'rate', `after 120 refused messages the bucket is empty, got ${brief(reply)}`);
});

test('G4R2-M1 a denial never echoes more than 128 characters of an op or command', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const envelope = await clientRequest(A, dap(`rrext_${'y'.repeat(100)}`, {}));
	assertDenied(envelope, ['capability', 'schema'], 'a 106-char command');
	const R = t.open(ENTRY_A, { raw: true });
	const op = `shell.${'z'.repeat(200)}`;
	const reply = await R.rawRequest(op, {});
	const fields = JSON.parse(String(reply?.error).slice('RR_DENIED:'.length)) as { op: string };
	assert.ok(fields.op.length <= 128, `the echoed op is truncated to 128 characters, got ${fields.op.length}`);
});

// =============================================================================
// R2-L1 — rate before the walk; a total string bound in the walker
// =============================================================================

test('G4R2-L1 the rate bucket is charged before the walk; the walker bounds total string size', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const R = t.open(ENTRY_A, { raw: true });
	void A;
	for (let i = 0; i < 100; i++) await R.rawRequest('client.request', { message: dap('rrext_ping') });
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const reply = await R.rawRequest('client.request', { message: dap('rrext_ping', { c: cyclic }) });
	const env = reply?.result as { ok?: boolean; error?: { fields?: { code?: string } } };
	assert.equal(env?.error?.fields?.code, 'rate', `with an empty bucket the answer is rate, before any walk, got ${brief(reply)}`);

	const six = 'x'.repeat(6 * 1024 * 1024);
	assert.throws(() => walk({ a: six, b: six }), 'two 6 MiB strings exceed the walker total');
});

// =============================================================================
// App topic memory: 256 topics x 16 KiB
// =============================================================================

test('G4R2 private app topics are capped at 16 KiB each', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const A2 = t.open(ENTRY_A);
	A.retained.publish(`app.${key}.big`, { s: 'x'.repeat(20 * 1024) });
	A.retained.publish(`app.${key}.ok`, { s: 'x'.repeat(15 * 1024) });
	await settle();
	assert.equal(await A2.request('bus.topic.read', { topic: `app.${key}.big` }), undefined, 'a 20 KiB snapshot is not stored');
	assert.ok(await A2.request('bus.topic.read', { topic: `app.${key}.ok` }), 'a 15 KiB snapshot is stored');
});

// =============================================================================
// Queued past the DAP timeout; DA N2 (source required); DA N3 (teardown awaits late orphans)
// =============================================================================

test('G4R2 a run that starts after its lost answer is still ended at teardown', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const client = engine.client as { request: (m: DAPMessage, timeout?: number) => Promise<DAPMessage> };
	const original = client.request;
	let queued: DAPMessage | undefined;
	client.request = async (m, timeout) => {
		if (m.command === 'execute' && !queued) {
			queued = structuredClone(m);
			throw new Error('Request timed out');
		}
		return original(m, timeout);
	};
	assert.equal((await clientRequest(A, execMsg())).ok, false);
	await settle();
	// The engine starts the queued run only now, after the first recovery attempt found nothing.
	await original(queued!);
	await t.root.teardownAll(3000);
	await settle();
	const started = engine.runs.at(-1)!;
	assert.ok(
		engine.messagesFor('terminate').some((r) => (r.message.arguments as { token?: string }).token === started.token),
		'teardown ends the run found by its minted project'
	);
});

test('G4R2-N2 execute needs a source (the lost-run lookup depends on it)', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	assertDenied(await clientRequest(A, dap('execute', { pipeline: { components: [] }, args: [], ttl: 60 })), 'schema', 'execute without pipeline.source or source');
	assert.equal((await clientRequest(A, dap('execute', { pipeline: { components: [] }, source: 'chat_1', args: [], ttl: 60 }))).ok, true, 'source as an argument is enough');
});

test('G4R2-N3 teardownAll awaits the ending of late answers within its timeout', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const release = engine.hold('execute');
	tt.after(() => release());
	const pending = clientRequest(A, execMsg());
	await settle();
	// Released right after the teardown starts: the answer is late by construction, with no real timer.
	const tearing = t.root.teardownAll(3000);
	release();
	await tearing;
	const late = engine.runs.at(-1);
	assert.ok(late, 'the held execute was answered during teardown');
	assert.ok(
		engine.messagesFor('terminate').some((r) => (r.message.arguments as { token?: string }).token === late.token),
		'the late run is already terminated when teardownAll resolves'
	);
	await pending;
});

// =============================================================================
// DA N1 — no monitor quota leak after a concurrent terminate
// =============================================================================

test('G4R2-N1 monitor slots are not leaked when the run ends during the engine call', async (tt) => {
	await tt.test('client.addMonitor', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run1 = await startRun(A);
		const client = t.cm.engine.client as { addMonitor: (k: unknown, ty: string[]) => Promise<void> };
		const original = client.addMonitor;
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		client.addMonitor = async (k, ty) => {
			await gate;
			return original(k, ty);
		};
		const adds = Array.from({ length: 16 }, (_, i) => outcome(A.request('client.addMonitor', { key: { token: run1.token }, types: [`t${i}`] })));
		await settle();
		assert.equal((await clientRequest(A, dap('terminate', { token: run1.token }))).ok, true);
		open();
		await Promise.all(adds);
		client.addMonitor = original;
		const run2 = await startRun(A);
		for (let i = 0; i < 16; i++) {
			const r = await outcome(A.request('client.addMonitor', { key: { token: run2.token }, types: [`u${i}`] }));
			assert.ok(r.ok, `monitor ${i + 1} on a new run must be allowed (no leaked slots), got ${brief(r)}`);
		}
	});
	await tt.test('rrext_monitor', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run1 = await startRun(A);
		const release = t.cm.engine.hold('rrext_monitor');
		st.after(() => release());
		const direct = clientRequest(A, dap('rrext_monitor', { types: Array.from({ length: 16 }, (_, i) => `t${i}`), token: run1.token }));
		await settle();
		assert.equal((await clientRequest(A, dap('terminate', { token: run1.token }))).ok, true);
		release();
		await direct;
		const run2 = await startRun(A);
		for (let i = 0; i < 16; i++) {
			const r = await outcome(A.request('client.addMonitor', { key: { token: run2.token }, types: [`u${i}`] }));
			assert.ok(r.ok, `monitor ${i + 1} on a new run must be allowed (no leaked slots), got ${brief(r)}`);
		}
	});
});
