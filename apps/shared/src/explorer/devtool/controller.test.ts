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
import { attachController } from './controller';
import type { RequiredControllerHandlers } from './controller';
import type { IDeadline } from './deadline';
import type { DevToolPeer } from './realm';
import type { Reply } from './reply';
import { CONTROLLER_STATE_TOPIC, RESERVED_STATE_PREFIX } from './realm';
import { createDevToolHarness, manualNow, settle, shellProtocol, spyPeer } from './testing';

interface TestOps extends ToolOpMap {
	't.echo': ToolOpSpec<IDeadline & { x: number }, Reply<number>>;
	't.other': ToolOpSpec<IDeadline, Reply<string>>;
}

/** Counts op servers the controller creates and disposes, over the real factory. */
function countingServers(order: string[] = []) {
	const counts = { created: 0, disposed: 0 };
	const factory = (peer: DevToolPeer): IToolOpServer<TestOps> => {
		order.push('opServer');
		counts.created += 1;
		const server = shellProtocol.createToolOpServer<TestOps>(peer);
		return { serve: (op, handler) => server.serve(op, handler), dispose: () => { counts.disposed += 1; server.dispose(); } };
	};
	return { counts, factory };
}

/** Counts channels built over the real factory. */
function countingChannels(order: string[] = []) {
	const counts = { created: 0 };
	const factory = (peer: DevToolPeer): ToolChannel => {
		order.push('channel');
		counts.created += 1;
		return shellProtocol.createToolChannel(peer);
	};
	return { counts, factory };
}

describe('attachController — subscription order and lifetime (R6)', () => {
	it('with no host channel: ONE channel per peer, created BEFORE the op server, which is created last', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.sidebarPeer);
		const order: string[] = [];
		const channels = countingChannels(order);
		const servers = countingServers(order);
		const first = attachController<TestOps>({ peer: spy.peer, createToolChannel: channels.factory, createToolOpServer: servers.factory, handlers: {} });
		assert.deepEqual(order, ['channel', 'opServer']);
		assert.equal(spy.subscribes, 2, 'the channel and the op server — the controller itself never subscribes');
		first.dispose();
		const second = attachController<TestOps>({ peer: spy.peer, createToolChannel: channels.factory, createToolOpServer: servers.factory, handlers: {} });
		assert.equal(channels.counts.created, 1, 'the channel is cached per peer: a remount adds no channel subscription');
		assert.equal(second.channel, first.channel);
		assert.equal(spy.subscribes, 3);
		second.dispose();
	});

	it('uses the host channel when given and never builds one', () => {
		const h = createDevToolHarness();
		const host = shellProtocol.createToolChannel(h.sidebarPeer);
		const channels = countingChannels();
		const servers = countingServers();
		const attached = attachController<TestOps>({ peer: h.sidebarPeer, channel: host, createToolChannel: channels.factory, createToolOpServer: servers.factory, handlers: {} });
		assert.equal(attached.channel, host);
		assert.equal(channels.counts.created, 0);
		attached.dispose();
	});

	it('leaves exactly one live op server per peer, even if a previous mount was never disposed', () => {
		const h = createDevToolHarness();
		const servers = countingServers();
		const a = attachController<TestOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: servers.factory, handlers: {} });
		attachController<TestOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: servers.factory, handlers: {} });
		assert.equal(servers.counts.created - servers.counts.disposed, 1);
		a.dispose();
		assert.equal(servers.counts.created - servers.counts.disposed, 1, 'disposing a superseded mount twice is a no-op');
	});

	it('posts no event and no call while mounting, only its retained readiness state (a quiet sidebar, R7)', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.sidebarPeer);
		const attached = attachController<TestOps>({
			peer: spy.peer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => x },
		});
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
		const attached = attachController<PlainOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
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
		// @ts-expect-error -- `any` would let a plain result and a missing deadline through
		attachController<AnyOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} }).dispose();
		// @ts-expect-error -- a `never` result is not a Reply (an op that never answers is Reply<never>)
		attachController<NeverOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} }).dispose();
	});

	it('RequiredControllerHandlers makes production wiring name every op (round 3)', () => {
		const all: RequiredControllerHandlers<TestOps> = { 't.echo': ({ x }) => x, 't.other': () => 'o' };
		// @ts-expect-error -- 't.other' is missing
		const some: RequiredControllerHandlers<TestOps> = { 't.echo': ({ x }) => x };
		const h = createDevToolHarness();
		attachController<TestOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: all }).dispose();
		assert.equal(typeof some, 'object');
	});
});

describe('attachController — every handler is served through the deadline guard (R2)', () => {
	it('answers an on-time call, refuses a late one and one without a deadline, and opens activation on the first accepted op', async () => {
		const h = createDevToolHarness();
		const clock = manualNow(1_000);
		const ran: number[] = [];
		const firstOps: string[] = [];
		const attached = attachController<TestOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => { ran.push(x); return x * 10; } },
			now: clock.now,
			onFirstOp: (op) => firstOps.push(op),
		});
		const frame = h.newFramePeer();
		const call = shellProtocol.createToolController<TestOps>(frame);
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
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.other': () => { ran += 1; return 'x'; } },
		});
		attached.dispose();
		attached.dispose();
		const call = shellProtocol.createToolController<TestOps>(h.newFramePeer());
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
		const first = attachController<TestOps>({ peer: h.sidebarPeer, channel, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		first.dispose();
		const second = attachController<TestOps>({ peer: h.sidebarPeer, channel, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
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
		const stale = attachController<TestOps>({ peer: h.sidebarPeer, channel, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		const live = attachController<TestOps>({ peer: h.sidebarPeer, channel, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		const ready = (last as { ready: string | null }).ready;
		stale.dispose();
		assert.deepEqual(last, { ready });
		live.dispose();
		assert.deepEqual(last, { ready: null });
	});
});

