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
// RATE, SIZE AND QUOTA TESTS — T26 to T28 (fake clock through opts.now)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { ENTRY_A, makeRoot, refAppKey } from './__test__/fixtures';
import { transcript } from './__test__/n1';
import { clientRequest, dap, settle } from './__test__/realm';
import { assertDenied, assertDeniedOp, assertNotForwarded, brief, outcome, startRun, trackSettled, openFs, openPipe } from './__test__/util';

const key = refAppKey(ENTRY_A.id);

test('T26 request, notify, refresh and concurrency limits', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const ping = dap('rrext_ping');

	for (let i = 0; i < 100; i++) assert.equal((await clientRequest(A, ping)).ok, true, `request ${i + 1} of the first 100 must be allowed`);
	const before = engine.received.length;
	assertDenied(await clientRequest(A, ping), 'rate', 'the 101st request in the same instant');
	assertNotForwarded(engine, before, 'the 101st request');
	t.clock.advance(1000);
	for (let i = 0; i < 20; i++) assert.equal((await clientRequest(A, ping)).ok, true, `request ${i + 1} after 1 s must be allowed`);

	// Concurrency: 33 unresolved requests, the 33rd is refused at once.
	const C = t.open(ENTRY_A);
	t.clock.advance(60_000);
	const release = engine.hold('rrext_ping');
	const calls = Array.from({ length: 33 }, () => clientRequest(C, ping));
	const last = trackSettled(calls[32]);
	await settle();
	try {
		assert.ok(last.settled(), 'the 33rd concurrent request must be refused immediately (it is still pending, so it was forwarded)');
		assertDenied(await calls[32], 'rate', 'the 33rd concurrent request');
	} finally {
		release();
		await Promise.all(calls);
	}

	// shell.notify: 1 per 2 s. shell.frameToken.refresh: 1 per 60 s.
	const N = t.open(ENTRY_A);
	t.clock.advance(60_000);
	assert.ok((await outcome(N.request('shell.notify', { message: 'one' }))).ok, 'the first notify must resolve');
	await assertDeniedOp(N.request('shell.notify', { message: 'two' }), 'rate', 'a second notify within 2 s');
	t.clock.advance(2000);
	assert.ok((await outcome(N.request('shell.notify', { message: 'three' }))).ok, 'a notify after 2 s must resolve');
	assert.ok((await outcome(N.request('shell.frameToken.refresh', {}))).ok, 'the first refresh must resolve');
	t.clock.advance(30_000);
	await assertDeniedOp(N.request('shell.frameToken.refresh', {}), 'rate', 'a second refresh within 60 s');
	t.clock.advance(30_000);
	assert.ok((await outcome(N.request('shell.frameToken.refresh', {}))).ok, 'a refresh after 60 s must resolve');
});

test('T27 request and response size caps', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const KIB = 1024;
	const sized = (bytes: number): DAPMessage => {
		const base = dap('execute', { pipeline: { components: [], source: 'chat_1', blob: '' }, args: [], ttl: 60 });
		const overhead = Buffer.byteLength(JSON.stringify(base));
		(base.arguments!.pipeline as { blob: string }).blob = 'x'.repeat(bytes - overhead);
		assert.equal(Buffer.byteLength(JSON.stringify(base)), bytes);
		return base;
	};
	let before = engine.received.length;
	assertDenied(await clientRequest(A, sized(256 * KIB + 1)), 'too_large', 'a client.request of 256 KiB + 1');
	assertNotForwarded(engine, before, 'an oversized request');
	assert.equal((await clientRequest(A, sized(200 * KIB))).ok, true, 'a 200 KiB request is allowed');

	const run = await startRun(A);
	engine.setStatus({ notes: ['x'.repeat(8 * 1024 * 1024 + 1)] });
	before = A.received.length;
	const envelope = await clientRequest(A, dap('rrext_get_task_status', { token: run.token }));
	assertDenied(envelope, 'too_large', 'a response of 8 MiB + 1');
	await settle();
	// Whole messages, not brief() (which cuts at 240 characters and would miss a leak later in the body).
	assert.ok(!transcript(A, before).some((text) => text.includes('xxxxxxxxxx')), 'the body must not reach the realm');
});

test('T28 per-realm quotas', async (tt) => {
	await tt.test('9th live run', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		for (let i = 0; i < 8; i++) await startRun(A);
		const before = t.cm.engine.received.length;
		assertDenied(await clientRequest(A, dap('execute', { pipeline: { components: [], source: 'chat_1' }, args: [], ttl: 60 })), 'quota', 'the 9th live run');
		assertNotForwarded(t.cm.engine, before, 'the 9th run');
	});
	await tt.test('17th pipe', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		for (let i = 0; i < 16; i++) await openPipe(A, run.token);
		assertDenied(await clientRequest(A, dap('rrext_process', { subcommand: 'open', object: {}, mimeType: 'text/plain', token: run.token })), 'quota', 'the 17th pipe');
	});
	await tt.test('33rd store handle', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		for (let i = 0; i < 32; i++) await openFs(A, `apps/${key}/f${i}`, 'r');
		assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_open', path: `apps/${key}/f33`, mode: 'r' })), 'quota', 'the 33rd store handle');
	});
	await tt.test('17th monitor key (a run and event type pair)', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		for (let i = 0; i < 16; i++) assert.ok((await outcome(A.request('client.addMonitor', { key: { token: run.token }, types: [`t${i}`] }))).ok, `monitor ${i + 1} must be allowed`);
		await assertDeniedOp(A.request('client.addMonitor', { key: { token: run.token }, types: ['t16'] }), 'quota', 'the 17th monitor key');
	});
	await tt.test('65th registered op', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const A2 = t.open(ENTRY_A);
		for (let i = 1; i <= 65; i++) A.bus.handle(`app.${key}.op${i}`, () => i);
		await settle();
		assert.equal(await A2.request(`app.${key}.op64`, {}), 64, 'the 64th op is registered');
		await assertDeniedOp(A2.request(`app.${key}.op65`, {}), ['quota', 'unknown_op', 'namespace'], 'the 65th op');
	});
	await tt.test('65th topic interest', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const A2 = t.open(ENTRY_A);
		for (let i = 1; i <= 65; i++) A2.retained.publish(`app.${key}.t${i}`, { i });
		await settle();
		for (let i = 1; i <= 65; i++) A.retained.subscribe(`app.${key}.t${i}`, () => {});
		await settle();
		const topics = A.received.filter((m) => (m as { __rrbus?: string }).__rrbus === 'topic').map((m) => (m as { topic: string }).topic);
		assert.ok(topics.includes(`app.${key}.t64`), 'the 64th interest is served');
		assert.ok(!topics.includes(`app.${key}.t65`), 'the 65th interest is refused');
	});
});
