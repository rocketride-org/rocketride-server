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
import type { ToolChannel, ToolControllerFn, ToolOpMap, ToolOpSpec } from 'shell';
import { ExplorerToolError } from '../errors';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import { createFrameCaller, HOST_CONNECTION_TOPIC } from './frame';
import type { DevToolPeer } from './realm';
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
		peer: h.sidebarPeer,
		...(now ? { now } : {}),
		...(onRefused ? { onRefused } : {}),
		createToolChannel: shellProtocol.createToolChannel,
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

/** Real primitives, counted. */
function counted() {
	const counts = { controllers: 0, channels: 0 };
	return {
		counts,
		createToolController: <O extends ToolOpMap>(peer: DevToolPeer): ToolControllerFn<O> => { counts.controllers += 1; return shellProtocol.createToolController<O>(peer); },
		createToolChannel: (peer: DevToolPeer): ToolChannel => { counts.channels += 1; return shellProtocol.createToolChannel(peer); },
	};
}

describe('createFrameCaller — calls', () => {
	it('stamps deadlineAt = now + timeoutMs on the args the controller receives', async () => {
		const h = createDevToolHarness();
		const seen: unknown[] = [];
		const clock = manualNow(50_000);
		const stop = serve(h, seen, clock.now);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted(), now: clock.now });
		await settle();
		assert.deepEqual(await caller.call('f.echo', { x: 7 }, { timeoutMs: 30_000 }), { ok: true, value: 7 });
		assert.deepEqual(seen, [{ x: 7, deadlineAt: 80_000 }]);
		caller.dispose();
		stop();
	});

	it('requires an explicit, valid timeoutMs', () => {
		const h = createDevToolHarness();
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		for (const bad of [undefined, 0, -1, Number.NaN, MAX_TIMER_MS + 1]) {
			assert.throws(() => caller.call('f.echo', { x: 1 }, { timeoutMs: bad as unknown as number }), RangeError, String(bad));
		}
		assert.throws(() => caller.call('f.echo', { x: 1 }, undefined as unknown as { timeoutMs: number }), RangeError);
		caller.dispose();
	});

	it('callReply unwraps a Reply, and a failure comes back as an equal ExplorerToolError', async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted(), now: () => 1_000_000 });
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
		const caller = createFrameCaller<FrameOps & { 'f.unknown': ToolOpSpec<IDeadline, void> }>({ peer: h.newFramePeer(), ...counted() });
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
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

	it('uses the host channel when the mount has one, and the constant matches the shell', async () => {
		assert.equal(HOST_CONNECTION_TOPIC, shellProtocol.HOST_CONNECTION_TOPIC);
		const h = createDevToolHarness();
		const frame = h.newFramePeer();
		const host = shellProtocol.createToolChannel(frame);
		const prims = counted();
		const caller = createFrameCaller<FrameOps>({ peer: frame, channel: host, ...prims });
		assert.equal(prims.counts.channels, 0);
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		await settle();
		assert.equal(caller.connected(), null);
		assert.deepEqual(await caller.callReply('f.echo', { x: 5 }, { timeoutMs: 5_000 }), 5);
		caller.dispose();
		stop();
	});
});

describe('createFrameCaller — one subscription set per peer', () => {
	it('a StrictMode double mount builds ONE controller and ONE channel for the peer', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.newFramePeer());
		const prims = counted();
		const first = createFrameCaller<FrameOps>({ peer: spy.peer, ...prims });
		first.dispose();
		const second = createFrameCaller<FrameOps>({ peer: spy.peer, ...prims });
		assert.deepEqual(prims.counts, { controllers: 1, channels: 1 });
		assert.equal(spy.subscribes, 2, 'one for the controller function, one for the channel');
		second.dispose();
	});

	it('dispose rejects what is pending as stale, refuses later calls and stops listening', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(true);
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted(), now: clock.now });
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
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
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		await settle();
		const call = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 60_000 });
		h.setHostConnection(false);
		await assert.rejects(call, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		caller.dispose();
	});

	it('waitForController: false sends at once (a frame on a controller that publishes no readiness)', async () => {
		const h = createDevToolHarness();
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted(), waitForController: false });
		await settle();
		const call = caller.callReply('f.echo', { x: 1 }, { timeoutMs: 60 });
		await settle();
		assert.equal(h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'call').length, 1);
		await assert.rejects(call, (error: unknown) => error instanceof ExplorerToolError && /did not answer/.test(error.message));
		caller.dispose();
	});
});

