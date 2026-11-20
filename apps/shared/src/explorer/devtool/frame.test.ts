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
// EXPLORER DEV TOOL — FRAME CALLER (explicit timeouts, deadlines, host:connection)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolOpMap, ToolOpSpec } from 'shell';
import { ExplorerToolError } from '../errors';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import { createFrameCaller, HOST_CONNECTION_TOPIC } from './frame';
import { replyOk, toReply } from './reply';
import type { Reply } from './reply';
import { MAX_TIMER_MS } from './timeouts';
import { DeadlineError } from './deadline';
import { createDevToolHarness, manualNow, settle, shellProtocol, spyPeer } from './testing';

interface FrameOps extends ToolOpMap {
	'f.echo': ToolOpSpec<IDeadline & { x: number }, Reply<number>>;
	'f.read': ToolOpSpec<IDeadline & { q: string }, Reply<{ rows: number[] }>>;
	'f.hang': ToolOpSpec<IDeadline, Reply<never>>;
}

/**
 * A controller serving FrameOps over the harness's sidebar peer.
 *
 * @param h - The harness.
 * @param seen - Receives every params object the controller handled.
 * @param now - The controller clock (default: real).
 * @param onRefused - Told about refused calls.
 * @returns Dispose.
 */
function serve(h: ReturnType<typeof createDevToolHarness>, seen: unknown[] = [], now?: () => number, onRefused?: (error: DeadlineError) => void): () => void {
	const attached = attachController<FrameOps>({
		channel: shellProtocol.createToolChannel(h.sidebarPeer),
		...(now ? { now } : {}),
		...(onRefused ? { onRefused } : {}),
		createToolOpServer: shellProtocol.createToolOpServer,
		handlers: {
			'f.echo': (params) => { seen.push(params); return params.x; },
			'f.read': (params) => toReply(() => {
				seen.push(params);
				if (params.q === 'bad') throw new ExplorerToolError({ kind: 'invalid', tool: 'get_data', code: 'BAD_SQL', message: 'Syntax error\nnear "selec"' });
				return { rows: [1, 2] };
			}),
			'f.hang': () => new Promise<never>(() => undefined),
		},
	});
	return () => attached.dispose();
}

/**
 * The real primitives over a new frame mount: ONE host channel, as the host builds it.
 *
 * @param h - The harness.
 * @returns Options for createFrameCaller (add `now` / `waitForController`).
 */
function frameOf(h: ReturnType<typeof createDevToolHarness>) {
	return { channel: shellProtocol.createToolChannel(h.newFramePeer()), createToolOpClient: shellProtocol.createToolOpClient };
}

describe('createFrameCaller — calls', () => {
	it('stamps deadlineAt = now + timeoutMs on the args the controller receives', async () => {
		const h = createDevToolHarness();
		const seen: unknown[] = [];
		const clock = manualNow(50_000);
		const stop = serve(h, seen, clock.now);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), now: clock.now });
		await settle();
		assert.deepEqual(await caller.call('f.echo', { x: 7 }, { timeoutMs: 30_000 }), { ok: true, value: 7 });
		assert.deepEqual(seen, [{ x: 7, deadlineAt: 80_000 }]);
		caller.dispose();
		stop();
	});

	it('requires an explicit, valid timeoutMs', () => {
		const h = createDevToolHarness();
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		for (const bad of [undefined, 0, -1, Number.NaN, MAX_TIMER_MS + 1]) {
			assert.throws(() => caller.call('f.echo', { x: 1 }, { timeoutMs: bad as unknown as number }), RangeError, String(bad));
		}
		assert.throws(() => caller.call('f.echo', { x: 1 }, undefined as unknown as { timeoutMs: number }), RangeError);
		caller.dispose();
	});

	it('callReply unwraps a Reply, and a failure comes back as an equal ExplorerToolError', async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		assert.deepEqual(await caller.callReply('f.read', { q: 'ok' }, { timeoutMs: 5_000 }), { rows: [1, 2] });
		const original = new ExplorerToolError({ kind: 'invalid', tool: 'get_data', code: 'BAD_SQL', message: 'Syntax error\nnear "selec"' });
		await assert.rejects(caller.callReply('f.read', { q: 'bad' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.deepEqual(error, original);
			return true;
		});
		caller.dispose();
		stop();
	});

	it("maps the op lane's timeout to an ExplorerToolError of kind timeout naming the op", async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		await assert.rejects(caller.call('f.hang', {}, { timeoutMs: 30 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'timeout');
			assert.equal(error.tool, 'f.hang');
			assert.match(error.message, /did not answer within/);
			return true;
		});
		assert.equal(caller.pending(), 0);
		caller.dispose();
		stop();
	});

	it("the controller's refusal of an expired call reaches a still-waiting frame as kind timeout", async () => {
		const h = createDevToolHarness();
		const refused: string[] = [];
		// The controller's clock runs a minute ahead of the frame's (e.g. timers throttled in a hidden webview).
		const stop = serve(h, [], () => 1_060_000, (error) => refused.push(error.reason));
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), now: () => 1_000_000 });
		await settle();
		await assert.rejects(caller.callReply('f.echo', { x: 1 }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError, 'not a plain protocol Error');
			assert.equal(error.kind, 'timeout');
			assert.equal(error.tool, 'f.echo');
			assert.match(error.message, /after its deadline/);
			return true;
		});
		assert.deepEqual(refused, ['expired']);
		caller.dispose();
		stop();
	});

	it('a protocol failure stays a plain Error (an op no controller serves)', async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps & { 'f.unknown': ToolOpSpec<IDeadline, void> }>({ ...frameOf(h) });
		await settle();
		await assert.rejects(caller.call('f.unknown', {}, { timeoutMs: 5_000 }), (error: unknown) => error instanceof Error && !(error instanceof ExplorerToolError) && /No handler serves/.test(error.message));
		caller.dispose();
		stop();
	});
});

describe('createFrameCaller — host:connection', () => {
	it('rejects every pending call as soon as host:connection turns false, as "may still have run"', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(true);
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		assert.equal(caller.connected(), true);
		const a = caller.call('f.hang', {}, { timeoutMs: 60_000 });
		const b = caller.call('f.hang', {}, { timeoutMs: 60_000 });
		await settle();
		assert.equal(caller.pending(), 2);
		h.setHostConnection(false);
		for (const pending of [a, b]) {
			await assert.rejects(pending, (error: unknown) => {
				assert.ok(error instanceof ExplorerToolError);
				assert.equal(error.kind, 'timeout');
				assert.equal(error.tool, 'f.hang');
				return true;
			});
		}
		assert.equal(caller.pending(), 0);
		assert.equal(caller.connected(), false);
		caller.dispose();
		stop();
	});

	it('the host channel is its transport, and the constant matches the shell', async () => {
		assert.equal(HOST_CONNECTION_TOPIC, shellProtocol.HOST_CONNECTION_TOPIC);
		const h = createDevToolHarness();
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		h.setHostConnection(false);
		await settle();
		assert.equal(caller.connected(), false);
		caller.dispose();
	});
});

describe('createFrameCaller — fail fast while the host is known to be down', () => {
	it('a call made while host:connection is already false rejects at once as unavailable, posts nothing and never runs later', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(false);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		assert.equal(caller.connected(), false);
		const callsBefore = h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'call').length;
		await assert.rejects(caller.callReply('f.echo', { x: 1 }, { timeoutMs: 60_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'unavailable');
			assert.equal(error.tool, 'f.echo');
			return true;
		});
		assert.equal(caller.pending(), 0);
		const seen: unknown[] = [];
		const stop = serve(h, seen);
		h.setHostConnection(true);
		await settle();
		assert.equal(h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'call').length, callsBefore, 'nothing was posted');
		assert.deepEqual(seen, [], 'a controller that mounts later never runs it');
		assert.equal(caller.connected(), true);
		assert.deepEqual(await caller.callReply('f.echo', { x: 2 }, { timeoutMs: 5_000 }), 2, 'calls flow again once the host is back');
		caller.dispose();
		stop();
	});

	it('null (the host never published host:connection) passes calls through', async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		assert.equal(caller.connected(), null);
		assert.deepEqual(await caller.callReply('f.echo', { x: 5 }, { timeoutMs: 5_000 }), 5);
		caller.dispose();
		stop();
	});
});

describe('createFrameCaller — it builds no subscription of its own', () => {
	it('a StrictMode double mount subscribes the frame peer ZERO times: only the host channel does', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.newFramePeer());
		const channel = shellProtocol.createToolChannel(spy.peer);
		const before = spy.subscribes;
		const first = createFrameCaller<FrameOps>({ channel, createToolOpClient: shellProtocol.createToolOpClient });
		first.dispose();
		const second = createFrameCaller<FrameOps>({ channel, createToolOpClient: shellProtocol.createToolOpClient });
		assert.equal(spy.subscribes, before);
		second.dispose();
	});

	it('dispose rejects what is pending as stale, refuses later calls and stops listening', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(true);
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		const pending = caller.call('f.hang', {}, { timeoutMs: 60_000 });
		caller.dispose();
		await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(caller.call('f.echo', { x: 1 }, { timeoutMs: 1_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		h.setHostConnection(false);
		await settle();
		assert.equal(caller.connected(), true, 'a disposed caller no longer follows host:connection');
		stop();
	});

	it('replyOk is what a Reply op resolves with on the wire', () => {
		assert.deepEqual(replyOk(1), { ok: true, value: 1 });
	});
});

describe('createFrameCaller — waits for its controller (CE-9)', () => {
	it('a call made before any controller is ready waits, then is sent within its own deadline', async () => {
		const h = createDevToolHarness();
		const seen: unknown[] = [];
		const clock = manualNow(1_000_000);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), now: clock.now });
		await settle();
		assert.equal(caller.controllerReady(), false);
		const call = caller.callReply('f.echo', { x: 3 }, { timeoutMs: 5_000 });
		await settle();
		const posted = h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'call').length;
		assert.equal(posted, 0, 'nothing is posted before the controller is ready');
		const stop = serve(h, seen, clock.now);
		assert.equal(await call, 3);
		assert.deepEqual(seen, [{ x: 3, deadlineAt: 1_005_000 }], 'the deadline is the one stamped at call time');
		assert.equal(caller.controllerReady(), true);
		caller.dispose();
		stop();
	});

	it('when readiness never comes, the call rejects as a timeout after its own timeoutMs, unsent', async () => {
		const h = createDevToolHarness();
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		await assert.rejects(caller.callReply('f.echo', { x: 1 }, { timeoutMs: 60 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'timeout');
			assert.match(error.message, /not sent/);
			return true;
		});
		assert.equal(caller.pending(), 0);
		assert.equal(h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'call').length, 0);
		caller.dispose();
	});

	it('a call still waiting for readiness when host:connection turns false is rejected as unavailable (never sent)', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(true);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		const call = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 60_000 });
		h.setHostConnection(false);
		await assert.rejects(call, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		caller.dispose();
	});

	it('waitForController: false sends at once (a frame on a controller that publishes no readiness)', async () => {
		const h = createDevToolHarness();
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), waitForController: false });
		await settle();
		// The outcome is observed from the start: settle() takes ~12 timer ticks, which on a slow
		// (Windows) runner outlasts a short call timeout, and an unobserved rejection is a crash.
		const outcome = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 400 }).then(() => null, (error: unknown) => error);
		await settle();
		assert.equal(h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'call').length, 1, 'posted at once, without waiting for readiness');
		const error = await outcome;
		assert.ok(error instanceof ExplorerToolError && /did not answer/.test(error.message), 'no controller answers it');
		caller.dispose();
	});
});

describe('createFrameCaller — identity fence (DA-R1-06)', () => {
	it('an answer to a call issued under identity A is discarded as stale once the frame is under B; a call issued under B is fine', async () => {
		const h = createDevToolHarness();
		let release: (value: number) => void = () => undefined;
		const gate = new Promise<number>((resolve) => { release = resolve; });
		const attached = attachController<FrameOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'f.echo': async (params) => (params.x === 1 ? gate : params.x) },
		});
		let identity: string | null = 'A';
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => identity });
		await settle();
		const underA = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 5_000 });
		await settle();
		identity = 'B';
		release(111);
		await assert.rejects(underA, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale' && error.tool === 'f.echo');
		assert.equal(await caller.callReply('f.echo', { x: 2 }, { timeoutMs: 5_000 }), 2);
		caller.dispose();
		attached.dispose();
	});

	it('a FAILURE that arrives after the identity changed is stale too, and without identityNow nothing changes', async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		let identity: string | null = 'A';
		const fenced = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => identity });
		const plain = createFrameCaller<FrameOps>({ ...frameOf(h) });
		await settle();
		const failing = fenced.callReply('f.read', { q: 'bad' }, { timeoutMs: 5_000 });
		identity = null;
		await assert.rejects(failing, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		assert.deepEqual(await plain.callReply('f.read', { q: 'ok' }, { timeoutMs: 5_000 }), { rows: [1, 2] });
		fenced.dispose();
		plain.dispose();
		stop();
	});
});

describe('createFrameCaller — identity fence binds to the FIRST known identity (DA-R2-01)', () => {
	/** A controller answering after `delayMs`, and a fenced frame. */
	function slowLane(delayMs: number) {
		const h = createDevToolHarness();
		const attached = attachController<FrameOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'f.echo': async (params) => { await new Promise((resolve) => setTimeout(resolve, delayMs)); return params.x; } },
		});
		return { h, attached };
	}

	it('R2-4: a call issued while the identity is unknown, answered after A arrives, is accepted (unknown -> A is not a change)', async () => {
		const { h, attached } = slowLane(60);
		let identity: string | null = null;
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => identity });
		await settle();
		const call = caller.callReply('f.echo', { x: 9 }, { timeoutMs: 5_000 });
		await new Promise((resolve) => setTimeout(resolve, 15));
		identity = 'fp-A';
		assert.equal(await call, 9);
		caller.dispose();
		attached.dispose();
	});

	it('A -> B and A -> null (a sign-out) are still stale; unknown -> A -> still A is fine', async () => {
		for (const next of ['fp-B', null] as const) {
			const { h, attached } = slowLane(40);
			let identity: string | null = 'fp-A';
			const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => identity });
			await settle();
			const call = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 5_000 });
			await new Promise((resolve) => setTimeout(resolve, 10));
			identity = next;
			await assert.rejects(call, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale', String(next));
			caller.dispose();
			attached.dispose();
		}
	});
});

describe('createFrameCaller — a call is held until an identity is known (DA-R3-03)', () => {
	function slowLane(delayMs: number) {
		const h = createDevToolHarness();
		const seen: number[] = [];
		const attached = attachController<FrameOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'f.echo': async (params) => { seen.push(params.x); await new Promise((resolve) => setTimeout(resolve, delayMs)); return params.x; } },
		});
		return { h, attached, seen };
	}

	it('R3-F1: unknown -> A -> B before the answer is stale (the call was held until A, then bound to A); unknown -> A alone is accepted', async () => {
		const { h, attached } = slowLane(80);
		let identity: string | null = null;
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => identity });
		await settle();
		const first = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 5_000 }).then(() => 'resolved', (error: { kind?: string }) => `rejected:${error.kind}`);
		setTimeout(() => { identity = 'fp-A'; }, 10);
		setTimeout(() => { identity = 'fp-B'; }, 60);
		assert.equal(await first, 'rejected:stale');
		identity = null;
		const second = caller.callReply('f.echo', { x: 2 }, { timeoutMs: 5_000 }).then(() => 'resolved', (error: { kind?: string }) => `rejected:${error.kind}`);
		setTimeout(() => { identity = 'fp-A'; }, 10);
		assert.equal(await second, 'resolved');
		caller.dispose();
		attached.dispose();
	});

	it('nothing is sent while no identity is known; if the deadline passes first it rejects as unavailable, unsent', async () => {
		const { h, attached, seen } = slowLane(5);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => null });
		await settle();
		await assert.rejects(caller.callReply('f.echo', { x: 3 }, { timeoutMs: 120 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && /not sent/.test(error.message));
		assert.deepEqual(seen, [], 'the controller never saw it');
		assert.equal(caller.pending(), 0);
		caller.dispose();
		attached.dispose();
	});

	it('dispose rejects a call that is waiting for an identity as stale and stops looking', async () => {
		const { h, attached } = slowLane(5);
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => null });
		await settle();
		const waiting = caller.callReply('f.echo', { x: 4 }, { timeoutMs: 5_000 });
		caller.dispose();
		await assert.rejects(waiting, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		attached.dispose();
	});
});

describe('createFrameCaller — the identity is captured at ISSUE (DA-R31-01, DA-R31-02)', () => {
	it('R31-1: a call issued under A that waits for the controller is refused unsent as stale when the frame is under B by the time it could go; the controller never runs it', async () => {
		const h = createDevToolHarness('t.b');
		h.setHostConnection(true);
		let identity: string | null = 'fp-A';
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => identity });
		await settle();
		const call = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 3_000 }).then(() => 'resolved', (error: { kind?: string }) => `rejected:${error.kind}`);
		identity = null;
		await new Promise((resolve) => setTimeout(resolve, 30));
		identity = 'fp-B';
		const ran: number[] = [];
		const attached = attachController<FrameOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'f.echo': ({ x }) => { ran.push(x); return x; } },
		});
		assert.equal(await call, 'rejected:stale');
		assert.deepEqual(ran, [], 'a call issued under A never ran under B');
		caller.dispose();
		attached.dispose();
	});

	it('R31-2: identity known at issue, controller not ready, identity drops to null and returns: the call goes when A is back, it does not run out its deadline', async () => {
		const h = createDevToolHarness('t.c');
		h.setHostConnection(true);
		let identity: string | null = 'fp-A';
		const caller = createFrameCaller<FrameOps>({ ...frameOf(h), identityNow: () => identity });
		await settle();
		const started = Date.now();
		const call = caller.callReply('f.echo', { x: 2 }, { timeoutMs: 800 }).then((value) => `resolved:${value}`, (error: { kind?: string }) => `rejected:${error.kind}`);
		identity = null;
		const attached = attachController<FrameOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'f.echo': ({ x }) => x },
		});
		await settle();
		identity = 'fp-A';
		assert.equal(await call, 'resolved:2');
		assert.ok(Date.now() - started < 600, 'it did not wait out its deadline');
		caller.dispose();
		attached.dispose();
	});
});
