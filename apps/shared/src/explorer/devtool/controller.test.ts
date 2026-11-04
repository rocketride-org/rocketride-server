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
// EXPLORER DEV TOOL — CONTROLLER WIRING (R6 order, one op server, R2 guard)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IToolOpServer, ToolChannel, ToolOpMap, ToolOpSpec } from 'shell';
import { assertNoOpEventCollisions, attachController, MAX_OP_BUDGET_MS } from './controller';
import { frameOpTimeoutMs, toolCallBudgetMs } from './timeouts';
import type { RequiredControllerHandlers } from './controller';
import type { IDeadline } from './deadline';
import type { Reply } from './reply';
import { CONTROLLER_STATE_TOPIC, RESERVED_STATE_PREFIX } from './realm';
import { createDevToolHarness, manualNow, settle, shellProtocol, spyPeer } from './testing';

interface TestOps extends ToolOpMap {
	't.echo': ToolOpSpec<IDeadline & { x: number }, Reply<number>>;
	't.other': ToolOpSpec<IDeadline, Reply<string>>;
}

/** Counts op servers the controller creates and disposes, over the real factory. */
function countingServers() {
	const counts = { created: 0, disposed: 0 };
	const factory = (channel: ToolChannel): IToolOpServer<TestOps> => {
		counts.created += 1;
		const server = shellProtocol.createToolOpServer<TestOps>(channel);
		return { serve: (op, handler) => server.serve(op, handler), dispose: () => { counts.disposed += 1; server.dispose(); } };
	};
	return { counts, factory };
}

describe('attachController — the host channel is the only subscriber (R6)', () => {
	it('subscribes nothing itself: the host channel is the sidebar peer\'s one subscription, before and after a mount', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.sidebarPeer);
		const channel = shellProtocol.createToolChannel(spy.peer);
		const before = spy.subscribes;
		const attached = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: { 't.echo': ({ x }) => x } });
		assert.equal(spy.subscribes, before, 'the controller never subscribes the peer');
		assert.equal(attached.channel, channel);
		attached.dispose();
		attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} }).dispose();
		assert.equal(spy.subscribes, before, 'a remount adds no subscription either');
	});

	it('leaves exactly one live op server per channel, even if a previous mount was never disposed', () => {
		const h = createDevToolHarness();
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		const servers = countingServers();
		const a = attachController<TestOps>({ channel, createToolOpServer: servers.factory, handlers: {} });
		attachController<TestOps>({ channel, createToolOpServer: servers.factory, handlers: {} });
		assert.equal(servers.counts.created - servers.counts.disposed, 1);
		a.dispose();
		assert.equal(servers.counts.created - servers.counts.disposed, 1, 'disposing a superseded mount twice is a no-op');
	});

	it('posts no event and no call while mounting, only its retained readiness state (a quiet sidebar, R7)', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.sidebarPeer);
		const channel = shellProtocol.createToolChannel(spy.peer);
		const attached = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: { 't.echo': ({ x }) => x } });
		assert.equal(spy.posts.length, 1);
		const post = spy.posts[0] as { __rrtool: string; topic: string; snapshot: { ready: unknown } };
		assert.equal(post.__rrtool, 'state', 'a retained state publish, which R7 allows');
		assert.equal(post.topic, CONTROLLER_STATE_TOPIC);
		assert.deepEqual(h.emitted, [], 'and summons nothing');
		attached.dispose();
	});
});

describe('attachController — every op answers a Reply (R3)', () => {
	it('refuses, at compile time, an op map whose results are not Replies', () => {
		interface PlainOps extends ToolOpMap {
			'p.count': ToolOpSpec<IDeadline, number>;
		}
		const h = createDevToolHarness();
		// @ts-expect-error -- every controller op answers a Reply; a plain result type is refused
		const attached = attachController<PlainOps>({ channel: shellProtocol.createToolChannel(h.sidebarPeer), createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		attached.dispose();
	});

	it('refuses, at compile time, `any` params or results and a `never` result (round 3)', () => {
		interface AnyOps extends ToolOpMap {
			'x.any': ToolOpSpec<any, any>;
		}
		interface NeverOps extends ToolOpMap {
			'x.never': ToolOpSpec<IDeadline, never>;
		}
		const h = createDevToolHarness();
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		// @ts-expect-error -- `any` would let a plain result and a missing deadline through
		attachController<AnyOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} }).dispose();
		// @ts-expect-error -- a `never` result is not a Reply (an op that never answers is Reply<never>)
		attachController<NeverOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} }).dispose();
	});

	it('RequiredControllerHandlers makes production wiring name every op (round 3)', () => {
		const all: RequiredControllerHandlers<TestOps> = { 't.echo': ({ x }) => x, 't.other': () => 'o' };
		// @ts-expect-error -- 't.other' is missing
		const some: RequiredControllerHandlers<TestOps> = { 't.echo': ({ x }) => x };
		const h = createDevToolHarness();
		attachController<TestOps>({ channel: shellProtocol.createToolChannel(h.sidebarPeer), createToolOpServer: shellProtocol.createToolOpServer, handlers: all }).dispose();
		assert.equal(typeof some, 'object');
	});
});

describe('attachController — every handler is served through the deadline guard (R2)', () => {
	it('answers an on-time call, refuses a late one and one without a deadline, and reports the first accepted op', async () => {
		const h = createDevToolHarness();
		const clock = manualNow(1_000);
		const ran: number[] = [];
		const firstOps: string[] = [];
		const attached = attachController<TestOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => { ran.push(x); return x * 10; } },
			now: clock.now,
			onFirstOp: (op) => firstOps.push(op),
		});
		const call = shellProtocol.createToolOpClient<TestOps>(shellProtocol.createToolChannel(h.newFramePeer()));
		await settle();

		await assert.rejects(call('t.echo', { x: 1 } as TestOps['t.echo']['params'], { timeoutMs: 1_000 }), /deadlineAt/);
		await assert.rejects(call('t.echo', { x: 2, deadlineAt: 999 }, { timeoutMs: 1_000 }), /deadline/);
		assert.deepEqual(await call('t.echo', { x: 3, deadlineAt: 5_000 }, { timeoutMs: 1_000 }), { ok: true, value: 30 });
		assert.deepEqual(await call('t.echo', { x: 4, deadlineAt: 5_000 }, { timeoutMs: 1_000 }), { ok: true, value: 40 });
		assert.deepEqual(ran, [3, 4]);
		assert.deepEqual(firstOps, ['t.echo'], 'once, on the first op that was accepted');
		attached.dispose();
	});

	it('dispose stops serving: a later call is not executed', async () => {
		const h = createDevToolHarness();
		let ran = 0;
		const attached = attachController<TestOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.other': () => { ran += 1; return 'x'; } },
		});
		attached.dispose();
		attached.dispose();
		const call = shellProtocol.createToolOpClient<TestOps>(shellProtocol.createToolChannel(h.newFramePeer()));
		await settle();
		await assert.rejects(call('t.other', { deadlineAt: Date.now() + 60_000 }, { timeoutMs: 50 }), /did not answer/);
		assert.equal(ran, 0);
	});
});

describe('attachController — readiness (CE-9)', () => {
	it('publishes { ready: <nonce> } on the reserved topic once its handlers are served, and { ready: null } on dispose', () => {
		assert.ok(CONTROLLER_STATE_TOPIC.startsWith(RESERVED_STATE_PREFIX));
		const h = createDevToolHarness();
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		const seen: unknown[] = [];
		channel.onState(CONTROLLER_STATE_TOPIC, (snapshot) => seen.push(snapshot));
		const first = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		first.dispose();
		const second = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		const readies = seen.map((snapshot) => (snapshot as { ready: string | null }).ready);
		assert.equal(readies.length, 3);
		assert.equal(typeof readies[0], 'string');
		assert.equal(readies[1], null);
		assert.equal(typeof readies[2], 'string');
		assert.notEqual(readies[2], readies[0], 'a fresh nonce per mount');
		second.dispose();
	});

	it("a superseded mount's late dispose does not retract the live mount's readiness", () => {
		const h = createDevToolHarness();
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		let last: unknown;
		channel.onState(CONTROLLER_STATE_TOPIC, (snapshot) => { last = snapshot; });
		const stale = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		const live = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		const ready = (last as { ready: string | null }).ready;
		stale.dispose();
		assert.deepEqual(last, { ready });
		live.dispose();
		assert.deepEqual(last, { ready: null });
	});
});

describe('events never run a handler (DA-R1-01)', () => {
	it('R1-A: one op-named EVENT (even with a live deadlineAt) runs nothing, however many times the platform delivers it', async () => {
		const h = createDevToolHarness('tool.da', { json: true });
		const writes: number[] = [];
		const refused: string[] = [];
		const attached = attachController<TestOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => { writes.push(x); return x; } },
			onRefused: (error) => refused.push(error.reason),
		});
		const frame = shellProtocol.createToolChannel(h.newFramePeer());
		await settle();
		frame.sendEvent('t.echo', { x: 1, deadlineAt: Date.now() + 60_000 });
		await settle();
		assert.deepEqual(writes, []);
		assert.ok(refused.length >= 1 && refused.every((reason) => reason === 'event'), 'refused as an event, every delivery');
		attached.dispose();
	});

	it('R1-B: one far-future event is not re-run by any later controller mount (the retained last-payload slot replays it)', async () => {
		const h = createDevToolHarness('tool.db', { json: true });
		const writes: number[] = [];
		const frame = shellProtocol.createToolChannel(h.newFramePeer());
		await settle();
		frame.sendEvent('t.echo', { x: 7, deadlineAt: Number.MAX_SAFE_INTEGER });
		await settle();
		for (let mount = 0; mount < 3; mount += 1) {
			const channel = shellProtocol.createToolChannel(h.sidebarPeer);
			const attached = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: { 't.echo': ({ x }) => { writes.push(x); return x; } } });
			await settle();
			attached.dispose();
		}
		assert.deepEqual(writes, []);
	});

	it('R1-F: a CALL still runs, once, after refused events (only correlated calls reach a handler)', async () => {
		const h = createDevToolHarness('tool.df', { json: true });
		const runs: number[] = [];
		const attached = attachController<TestOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => { runs.push(x); return x; } },
		});
		const frameChannel = shellProtocol.createToolChannel(h.newFramePeer());
		const call = shellProtocol.createToolOpClient<TestOps>(frameChannel);
		await settle();
		frameChannel.sendEvent('t.echo', { x: 1, deadlineAt: Date.now() + 60_000 });
		await settle();
		assert.deepEqual(await call('t.echo', { x: 2, deadlineAt: Date.now() + 60_000 }, { timeoutMs: 2_000 }), { ok: true, value: 2 });
		assert.deepEqual(runs, [2]);
		attached.dispose();
	});

	it('an event with no payload, or none usable, is refused by the deadline guard', async () => {
		const h = createDevToolHarness();
		const refused: string[] = [];
		const attached = attachController<TestOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => x },
			onRefused: (error) => refused.push(error.reason),
		});
		const frame = shellProtocol.createToolChannel(h.newFramePeer());
		await settle();
		frame.sendEvent('t.echo', undefined);
		frame.sendEvent('t.echo', 5);
		await settle();
		assert.ok(refused.length >= 2 && refused.every((reason) => reason === 'missing'));
		attached.dispose();
	});

	it('a deadline further ahead than the op\'s largest budget is refused (a replayed payload cannot live indefinitely)', async () => {
		const h = createDevToolHarness();
		const clock = manualNow(1_000);
		const ran: number[] = [];
		const refused: string[] = [];
		const attached = attachController<TestOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => { ran.push(x); return x; } },
			maxBudgetMs: { 't.echo': 10_000 },
			now: clock.now,
			onRefused: (error) => refused.push(error.reason),
		});
		const call = shellProtocol.createToolOpClient<TestOps>(shellProtocol.createToolChannel(h.newFramePeer()));
		await settle();
		await assert.rejects(call('t.echo', { x: 1, deadlineAt: 1_000 + 10_001 }, { timeoutMs: 1_000 }), /further ahead/);
		assert.deepEqual(await call('t.echo', { x: 2, deadlineAt: 1_000 + 10_000 }, { timeoutMs: 1_000 }), { ok: true, value: 2 });
		assert.deepEqual(ran, [2]);
		assert.deepEqual(refused, ['horizon']);
		attached.dispose();
	});

	it('the default horizon admits the largest legal frame budget (an unbounded tool call) and nothing beyond', () => {
		assert.ok(MAX_OP_BUDGET_MS >= frameOpTimeoutMs(toolCallBudgetMs(null)));
		assert.ok(MAX_OP_BUDGET_MS < 2 * 24 * 60 * 60 * 1000);
	});

	it('attach throws when a lane names an event like a served op, and does nothing else', () => {
		const h = createDevToolHarness();
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		assert.throws(() => attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: { 't.echo': ({ x }) => x }, events: ['refresh', 't.echo'] }), /t\.echo/);
		const ok = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: { 't.echo': ({ x }) => x }, events: ['refresh'] });
		ok.dispose();
	});

	it('assertNoOpEventCollisions names every event that shares an op\'s name', () => {
		assert.deepEqual(assertNoOpEventCollisions(['t.echo', 't.other'], ['refresh', 't.other', `${RESERVED_STATE_PREFIX}summon`]), ['t.other']);
		assert.deepEqual(assertNoOpEventCollisions(['t.echo'], ['refresh']), []);
	});
});

describe('platform behavior (documented, so a shell fix shows up here) — held calls', () => {
	it('a call the sidebar peer HELD for an unmounted controller is dropped when the host builds the channel before the controller serves (toolChannel.ts: no registry, no answer)', async () => {
		const h = createDevToolHarness();
		const frame = shellProtocol.createToolChannel(h.newFramePeer());
		await settle();
		const lost = frame.call('t.echo', { x: 1, deadlineAt: Date.now() + 60_000 }, { timeoutMs: 150 });
		await settle();
		assert.deepEqual(h.emitted.map((e) => e.op), ['host.mountToolSidebar'], 'the peer held it and asked the host to mount the controller');
		// The host's render builds the channel: the held call is flushed into a channel with no handler yet.
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		await settle();
		// The controller's effect then serves; the call is already gone.
		const attached = attachController<TestOps>({ channel, createToolOpServer: shellProtocol.createToolOpServer, handlers: { 't.echo': ({ x }) => x } });
		await assert.rejects(lost, /did not answer/);
		attached.dispose();
	});
});
