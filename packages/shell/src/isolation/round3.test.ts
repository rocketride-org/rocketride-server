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
// ROUND 3 TESTS — G4 round 3 (DA R3-1, R3-2: lost runs never use up the quota;
// security R3-M1: the realm-to-realm response relay; R3-L3: hung engine calls)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { ENTRY_A, makeRoot, refAppKey } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import { clientRequest, dap, settle } from './__test__/realm';
import { assertDenied, assertDeniedOp, brief, denialOf, outcome, startRun } from './__test__/util';

const execMsg = (): DAPMessage => dap('execute', { pipeline: { components: [], source: 'chat_1' }, args: [], ttl: 60 });

/** A root whose internal timers run on its fake clock. */
function rootWithTimers(): { t: ITestRoot; advance(ms: number): Promise<void> } {
	const timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
	let now = (): number => 0;
	const t = makeRoot({
		schedule(cb, ms) {
			const timer = { at: now() + ms, cb, live: true };
			timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
	});
	now = t.clock.now;
	return {
		t,
		async advance(ms) {
			t.clock.advance(ms);
			for (const timer of timers) {
				if (timer.live && timer.at <= t.clock.now()) {
					timer.live = false;
					timer.cb();
				}
			}
			await settle();
		},
	};
}

/** Makes every execute throw a timeout without the engine ever starting the run. */
function loseEveryExecute(t: ITestRoot): void {
	const client = t.cm.engine.client as { request: (m: DAPMessage, timeout?: number) => Promise<DAPMessage> };
	const original = client.request;
	client.request = async (m, timeout) => {
		if (m.command === 'execute') {
			t.cm.engine.received.push({ message: structuredClone(m), timeout });
			throw new Error('Request timed out');
		}
		return original(m, timeout);
	};
}

test('G4R3-1 an execute that was never sent is not a lost run', async (tt) => {
	await tt.test('client not connected', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		t.cm.setConnected(false);
		for (let i = 0; i < 8; i++) assert.equal((await clientRequest(A, execMsg())).ok, false, 'execute fails while disconnected');
		t.cm.setConnected(true);
		const envelope = await clientRequest(A, execMsg());
		assert.equal(envelope.ok, true, `after reconnecting, execute must be accepted (no quota used by unsent requests), got ${brief(denialOf(envelope)?.code ?? envelope)}`);
	});
	await tt.test("the SDK's 'Server is not connected'", async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		for (let i = 0; i < 8; i++) {
			t.cm.engine.throwNext('execute', new Error('Server is not connected'));
			assert.equal((await clientRequest(A, execMsg())).ok, false);
		}
		const envelope = await clientRequest(A, execMsg());
		assert.equal(envelope.ok, true, `execute must be accepted, got ${brief(denialOf(envelope)?.code ?? envelope)}`);
	});
});

test('G4R3-1 a lost run that never appears stops counting after 150 s', async (tt) => {
	const { t, advance } = rootWithTimers();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const client = t.cm.engine.client as { request: (m: DAPMessage, timeout?: number) => Promise<DAPMessage> };
	const original = client.request;
	loseEveryExecute(t);
	assert.equal((await clientRequest(A, execMsg())).ok, false);
	await settle();
	client.request = original;
	for (let i = 0; i < 7; i++) await startRun(A);
	assert.equal(denialOf(await clientRequest(A, execMsg()))?.code, 'quota', 'while the lost run may still start, it counts');
	await advance(30_000);
	await advance(120_000);
	const envelope = await clientRequest(A, execMsg());
	assert.equal(envelope.ok, true, `150 s later, with the last lookup answering "not found", the slot is free again, got ${brief(denialOf(envelope)?.code ?? envelope)}`);
});

test('G4R4-L1 a lost run whose lookup fails for another reason keeps counting', async (tt) => {
	const { t, advance } = rootWithTimers();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const client = t.cm.engine.client as { request: (m: DAPMessage, timeout?: number) => Promise<DAPMessage> };
	const original = client.request;
	loseEveryExecute(t);
	assert.equal((await clientRequest(A, execMsg())).ok, false);
	const lossy = client.request;
	// Every lookup now fails with something other than "not registered" (here a permission error).
	client.request = async (m, timeout) => {
		if (m.command === 'rrext_get_token') return { type: 'response', seq: 1, request_seq: m.seq, command: m.command, success: false, message: "Permission 'task.monitor' denied for this task" } as DAPMessage;
		if (m.command === 'execute') return original(m, timeout);
		return lossy(m, timeout);
	};
	for (let i = 0; i < 7; i++) await startRun(A);
	await advance(30_000);
	await advance(120_000);
	assert.equal(denialOf(await clientRequest(A, execMsg()))?.code, 'quota', 'a lookup that failed for another reason does not release the slot');
});

test('G4R3-2 no lost-run lookup after detach or teardown', async (tt) => {
	for (const how of ['detach', 'teardownAll'] as const) {
		await tt.test(how, async (st) => {
			const { t, advance } = rootWithTimers();
			st.after(() => t.cleanup());
			const A = t.open(ENTRY_A);
			loseEveryExecute(t);
			assert.equal((await clientRequest(A, execMsg())).ok, false);
			await settle();
			if (how === 'detach') A.detach();
			else await t.root.teardownAll(3000);
			await settle();
			const before = t.cm.engine.messagesFor('rrext_get_token').length;
			await advance(30_000);
			await advance(150_000);
			assert.equal(t.cm.engine.messagesFor('rrext_get_token').length, before, `no lookup may run after ${how}`);
		});
	}
});

// =============================================================================
// Security R3-M1 — the response relay between realms of one app
// =============================================================================

const codeOfRejection = (r: { ok: boolean; message?: string }): string | undefined => (!r.ok && r.message?.startsWith('RR_DENIED:') ? (JSON.parse(r.message.slice('RR_DENIED:'.length)) as { code?: string }).code : undefined);

test('G4R3-M1 a relayed response is size-capped, rebuilt and charged', async (tt) => {
	await tt.test('size', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const O = t.open(ENTRY_A);
		const C = t.open(ENTRY_A);
		const op = `app.${refAppKey(ENTRY_A.id)}.echo`;
		O.bus.handle(op, () => 'x'.repeat(50_000_000));
		await settle();
		const r = await outcome(C.request(op, {}));
		assert.equal(codeOfRejection(r as { ok: boolean; message?: string }), 'too_large', `the requester gets too_large, got ${brief(r)}`);
		const longest = Math.max(0, ...C.received.map((m) => JSON.stringify(m).length));
		assert.ok(longest < 64 * 1024, `nothing large is relayed, the longest message was ${longest} chars`);
	});
	await tt.test('rebuilt from allowlisted fields', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const O = t.open(ENTRY_A, { raw: true });
		const C = t.open(ENTRY_A);
		const op = `app.${refAppKey(ENTRY_A.id)}.raw`;
		O.post({ __rrbus: 'register', ops: [op] });
		await settle();
		const pending = outcome(C.request(op, {}));
		await settle();
		const hop = O.received.find((m) => (m as { __rrbus?: string; op?: string }).__rrbus === 'request' && (m as { op?: string }).op === op) as { id: string };
		O.post({ __rrbus: 'response', id: hop.id, ok: true, result: 'fine', extra: { smuggled: 1 } });
		assert.deepEqual(await pending, { ok: true, value: 'fine' });
		const relayed = C.received.find((m) => (m as { __rrbus?: string }).__rrbus === 'response') as Record<string, unknown>;
		assert.ok(!('extra' in relayed), `the relayed response carries only allowlisted fields, got ${brief(Object.keys(relayed))}`);
	});
	await tt.test('charged', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const O = t.open(ENTRY_A);
		const C1 = t.open(ENTRY_A);
		const C2 = t.open(ENTRY_A);
		const op = `app.${refAppKey(ENTRY_A.id)}.ping`;
		O.bus.handle(op, () => 'pong');
		await settle();
		const run = async (c: typeof C1): Promise<Array<{ ok: boolean; message?: string }>> => {
			const out: Array<{ ok: boolean; message?: string }> = [];
			for (let i = 0; i < 60; i++) out.push((await outcome(c.request(op, {}))) as { ok: boolean; message?: string });
			return out;
		};
		const results = (await Promise.all([run(C1), run(C2)])).flat();
		assert.ok(
			results.some((r) => codeOfRejection(r) === 'rate'),
			`120 answers exceed the owner's bucket of 100: some must be refused as rate, got ${brief(results.map((r) => (r.ok ? 'ok' : codeOfRejection(r))).slice(-10))}`
		);
	});
});

// =============================================================================
// Security R3-L3 — a hung engine call is not tracked forever
// =============================================================================

test('G4R3-L3 a hung engine call is dropped from teardown tracking after a timed-out teardown', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const release = t.cm.engine.hold('rrext_ping');
	tt.after(() => release());
	const pending = clientRequest(A, dap('rrext_ping'));
	await settle();
	await t.root.teardownAll(50);
	const logged = t.logs.length;
	await t.root.teardownAll(500);
	assert.equal(t.logs.length, logged, `a second teardown has nothing left to wait for and does not time out, logs: ${brief(t.logs.slice(logged))}`);
	release();
	await pending;
});

// =============================================================================
// Review round — orphan and lost-run termination, stale status, unreceived answers, monitor counts
// =============================================================================

const terminatedTokens = (t: ITestRoot): string[] => t.cm.engine.messagesFor('terminate').map((r) => String((r.message.arguments as { token?: string }).token));

test('R-orphan a late run whose terminate answers success:false is retried, not forgotten', async (tt) => {
	const { t, advance } = rootWithTimers();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const releaseExec = engine.hold('execute');
	tt.after(() => releaseExec());
	// The detach aborts the realm's side of the request; the root's own call is what this test is about.
	const pending = clientRequest(A, execMsg()).catch(() => undefined);
	await settle();
	A.detach();
	await settle();
	engine.failWith('terminate', { message: 'engine busy' });
	releaseExec();
	await pending;
	await settle();
	const token = engine.runs.at(-1)!.token;
	assert.equal(terminatedTokens(t).filter((x) => x === token).length, 1, 'the late run is terminated once, and that answer is a failure');
	await advance(30_000);
	assert.equal(terminatedTokens(t).filter((x) => x === token).length, 2, 'the failed termination is tried again');
});

test('R-lost a lost run whose terminate answers success:false stays counted and is ended on a later lookup', async (tt) => {
	const { t, advance } = rootWithTimers();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const client = engine.client as { request: (m: DAPMessage, timeout?: number) => Promise<DAPMessage> };
	const original = client.request;
	client.request = async (m, timeout) => {
		const r = await original(m, timeout);
		if (m.command === 'execute') throw new Error('Request timed out');
		return r;
	};
	engine.failWith('terminate', { message: 'engine busy' });
	assert.equal((await clientRequest(A, execMsg())).ok, false, 'the realm sees the failure');
	await settle();
	client.request = original;
	const lost = engine.runs.at(-1)!.token;
	assert.equal(terminatedTokens(t).filter((x) => x === lost).length, 1, 'the first termination failed');
	for (let i = 0; i < 7; i++) await startRun(A);
	assert.equal(denialOf(await clientRequest(A, execMsg()))?.code, 'quota', 'a run that could not be ended still counts');
	await advance(30_000);
	assert.equal(terminatedTokens(t).filter((x) => x === lost).length, 2, 'the next lookup ends it');
	assert.equal((await clientRequest(A, execMsg())).ok, true, 'once ended, the slot is free');
});

test('R-restart a status answer from before a restart does not expire the restarted run', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const run = await startRun(A);
	engine.setStatus({ completed: true });
	const release = engine.hold('rrext_get_task_status');
	tt.after(() => release());
	const stale = clientRequest(A, dap('rrext_get_task_status', { token: run.token }));
	await settle();
	const restarted = await clientRequest(A, dap('restart', { token: run.token, projectId: run.projectId, source: run.source, pipeline: { components: [], source: run.source } }));
	assert.equal(restarted.ok, true, 'the restart is accepted');
	release();
	assert.equal((await stale).ok, true, 'the stale status is still delivered');
	t.clock.advance(121_000);
	assert.equal((await clientRequest(A, dap('rrext_get_task_status', { token: run.token }))).ok, true, 'the restarted run is still owned after the grace period');
});

test('R-unreceived an execute answer the realm cannot receive leaves no run held, and the run is ended', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	engine.extendBody('execute', { big: 'x'.repeat(9 * 1024 * 1024) });
	for (let i = 0; i < 9; i++) assertDenied(await clientRequest(A, execMsg()), ['too_large', 'credential'], `execute answer ${i} that is too large`);
	await settle();
	assert.equal(terminatedTokens(t).length, 9, 'every run the realm could not be told about is terminated');
	engine.extendBody('execute', { big: '' });
	assert.equal((await clientRequest(A, execMsg())).ok, true, 'no run quota is held for the refused answers');
});

test('R-monitor a failed monitor removal still lowers the ledger count, as it lowers the SDK count', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const run = await startRun(A);
	const types = Array.from({ length: 16 }, (_, i) => `t${i}`);
	await A.request('client.addMonitor', { key: { token: run.token }, types });
	await assertDeniedOp(A.request('client.addMonitor', { key: { token: run.token }, types: ['extra'] }), 'quota', 'a 17th monitor key');
	const client = t.cm.engine.client as { removeMonitor: (k: unknown, ty: string[]) => Promise<void> };
	const original = client.removeMonitor;
	client.removeMonitor = async () => {
		throw new Error('engine unreachable');
	};
	const failed = await outcome(A.request('client.removeMonitor', { key: { token: run.token }, types: ['t0'] }));
	assert.equal(failed.ok, false, 'the realm sees the removal fail');
	client.removeMonitor = original;
	assert.equal((await outcome(A.request('client.addMonitor', { key: { token: run.token }, types: ['extra'] }))).ok, true, 'the slot of the removed type is free');
});

test('R-gate a request waiting on the API key is not sent once its realm detached or its run went', async (tt) => {
	await tt.test('detach', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const release = t.cm.holdApiKey();
		st.after(() => release());
		const A = t.open(ENTRY_A);
		const pending = clientRequest(A, execMsg()).catch(() => undefined);
		await settle();
		A.detach();
		release();
		await pending;
		await settle();
		assert.equal(t.cm.engine.messagesFor('execute').length, 0, "the detached realm's request never reaches the engine");
	});
	await tt.test('logout', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		const release = t.cm.holdApiKey();
		st.after(() => release());
		t.cm.emit('shell:login', { user: {} });
		const before = t.cm.engine.received.length;
		const pending = clientRequest(A, dap('rrext_get_task_status', { token: run.token }));
		await settle();
		t.cm.emit('shell:logout', {});
		release();
		assertDenied(await pending, 'capability', 'a status request sent before logout');
		assert.equal(t.cm.engine.received.length, before, "nothing is sent for the earlier session's run");
	});
});

test('R-ledger an expired run no longer counts its monitor keys against the quota', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const first = await startRun(A);
	const second = await startRun(A, 'chat_2');
	const types = Array.from({ length: 16 }, (_, i) => `t${i}`);
	await A.request('client.addMonitor', { key: { token: first.token }, types });
	await assertDeniedOp(A.request('client.addMonitor', { key: { token: second.token }, types: ['extra'] }), 'quota', 'a 17th monitor key while the first run lives');
	t.cm.engine.setStatus({ completed: true });
	assert.equal((await clientRequest(A, dap('rrext_get_task_status', { token: first.token }))).ok, true, 'the completing status is delivered');
	t.clock.advance(121_000);
	assert.equal((await outcome(A.request('client.addMonitor', { key: { token: second.token }, types: ['extra'] }))).ok, true, 'the expired run holds no monitor slots');
});
