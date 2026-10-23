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
// EXPLORER DEV TOOL — SUMMON (a frame asks its host to mount the controller)
// =============================================================================
// Over the real busPeer (#2625 9bd5d931f), which holds frame messages while no
// controller is subscribed and emits `host.mountToolSidebar` once per hold.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolOpMap, ToolOpSpec } from 'shell';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import { CONTROLLER_STATE_TOPIC, RESERVED_STATE_PREFIX } from './realm';
import { toReply } from './reply';
import type { Reply } from './reply';
import { SUMMON_EVENT, SUMMON_GRACE_MS, SUMMON_RETRY_MS, SUMMON_SETTLE_MS, createControllerSummon } from './summon';
import type { SummonState } from './summon';
import { assertJsonSafe, createDevToolHarness, settle, shellProtocol } from './testing';

const APP = 'tool.summon';

interface SummonOps extends ToolOpMap {
	's.read': ToolOpSpec<IDeadline & { key: string }, Reply<string>>;
}

/** Timers a test runs by hand: `advance(ms)` fires what falls due, in order. */
function manualTimers() {
	let now = 0;
	const due: Array<{ at: number; fn: () => void; live: boolean }> = [];
	return {
		schedule(fn: () => void, ms: number): () => void {
			const entry = { at: now + ms, fn, live: true };
			due.push(entry);
			return () => { entry.live = false; };
		},
		advance(ms: number): void {
			const until = now + ms;
			for (;;) {
				const next = due.filter((entry) => entry.live && entry.at <= until).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				next.live = false;
				now = next.at;
				next.fn();
			}
			now = until;
		},
		pending: (): number => due.filter((entry) => entry.live).length,
	};
}

/** The summon events a frame put on the wire. */
function summonsOnWire(h: ReturnType<typeof createDevToolHarness>): number {
	return h.wire.filter((entry) => entry.transient && (entry.value as { name?: unknown } | null)?.name === SUMMON_EVENT).length;
}

/** The host summons busPeer emitted. */
function mountRequests(h: ReturnType<typeof createDevToolHarness>): unknown[] {
	return h.emitted.filter((entry) => entry.op === 'host.mountToolSidebar');
}

describe('createControllerSummon', () => {
	it('the event is a reserved, non-op name and its payload is JSON-safe', () => {
		assert.ok(SUMMON_EVENT.startsWith(RESERVED_STATE_PREFIX));
		assert.equal(SUMMON_EVENT.includes('.'), false, 'op names are <tool>.<verb>');
		assertJsonSafe(null, 'summon payload');
	});

	it('with no controller mounted: one event after the settle, which busPeer turns into ONE host.mountToolSidebar; "unanswered" only after the grace', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const timers = manualTimers();
		const peer = h.newFramePeer();
		const summon = createControllerSummon({ channel: shellProtocol.createToolChannel(peer), schedule: timers.schedule });
		const seen: SummonState[] = [];
		summon.subscribe((state) => seen.push(state));
		await settle();
		assert.equal(summon.sent(), 0, 'nothing before the settle');
		assert.equal(summon.state(), 'summoning');

		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(summon.sent(), 1);
		assert.equal(summonsOnWire(h), 1);
		assert.deepEqual(mountRequests(h), [{ op: 'host.mountToolSidebar', params: { appId: APP } }]);

		timers.advance(SUMMON_GRACE_MS);
		await settle();
		assert.equal(summon.state(), 'unanswered');
		assert.deepEqual(seen, ['unanswered']);
		summon.dispose();
	});

	it('re-sends a bounded number of times while no controller answers (a sidebar peer armed late), and busPeer still asks the host once per hold', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const timers = manualTimers();
		const summon = createControllerSummon({ channel: shellProtocol.createToolChannel(h.newFramePeer()), schedule: timers.schedule });
		timers.advance(SUMMON_SETTLE_MS + SUMMON_RETRY_MS.reduce((sum, ms) => sum + ms, 0) + 60_000);
		await settle();
		assert.equal(summon.sent(), 1 + SUMMON_RETRY_MS.length);
		assert.equal(timers.pending(), 0, 'nothing left scheduled');
		assert.equal(mountRequests(h).length, 1, 'one mount request per hold period');
		summon.dispose();
	});

	it('a frame whose controller is already up sends nothing', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const attached = attachController<SummonOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 's.read': (params) => toReply(() => params.key) },
		});
		await settle();
		const timers = manualTimers();
		const summon = createControllerSummon({ channel: shellProtocol.createToolChannel(h.newFramePeer()), schedule: timers.schedule });
		await settle();
		timers.advance(60_000);
		await settle();
		assert.equal(summon.state(), 'ready');
		assert.equal(summon.sent(), 0);
		assert.equal(summonsOnWire(h), 0);
		summon.dispose();
		attached.dispose();
	});

	it('a controller that mounts on the summon executes nothing for it: the held event and its retained replay reach no handler', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const timers = manualTimers();
		const summon = createControllerSummon({ channel: shellProtocol.createToolChannel(h.newFramePeer()), schedule: timers.schedule });
		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(summon.sent(), 1);

		// The host mounts the controller as both hosts do: its channel first, then the op server.
		const handled: string[] = [];
		const refused: unknown[] = [];
		const attached = attachController<SummonOps>({
			peer: h.sidebarPeer,
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 's.read': (params) => toReply(() => { handled.push(params.key); return params.key; }) },
			onRefused: (error) => refused.push(error),
		});
		await settle();
		assert.equal(summon.state(), 'ready');
		assert.deepEqual(handled, []);
		assert.deepEqual(refused, []);
		timers.advance(60_000);
		await settle();
		assert.equal(summon.sent(), 1, 'no retry once the controller answered');
		summon.dispose();
		attached.dispose();
	});

	it('stays quiet while the host says it is disconnected, and summons once it reconnects', async () => {
		const h = createDevToolHarness(APP, { json: true });
		h.setHostConnection(false);
		const timers = manualTimers();
		const summon = createControllerSummon({ channel: shellProtocol.createToolChannel(h.newFramePeer()), schedule: timers.schedule });
		await settle();
		timers.advance(60_000);
		await settle();
		assert.equal(summon.sent(), 0);
		assert.equal(summon.state(), 'summoning', 'never "unanswered" while nothing could answer');
		h.setHostConnection(true);
		await settle();
		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(summon.sent(), 1);
		summon.dispose();
	});

	it('a controller that goes away starts a new episode', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const timers = manualTimers();
		const channel = shellProtocol.createToolChannel(h.newFramePeer());
		const summon = createControllerSummon({ channel, schedule: timers.schedule });
		const controller = shellProtocol.createToolChannel(h.sidebarPeer);
		controller.publishState(CONTROLLER_STATE_TOPIC, { ready: 'n1' });
		await settle();
		assert.equal(summon.state(), 'ready');
		controller.publishState(CONTROLLER_STATE_TOPIC, { ready: null });
		await settle();
		assert.equal(summon.state(), 'summoning');
		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(summon.sent(), 1);
		summon.dispose();
	});

	it('dispose stops every timer and listener', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const timers = manualTimers();
		const summon = createControllerSummon({ channel: shellProtocol.createToolChannel(h.newFramePeer()), schedule: timers.schedule });
		const seen: SummonState[] = [];
		summon.subscribe((state) => seen.push(state));
		summon.dispose();
		timers.advance(60_000);
		await settle();
		assert.equal(summon.sent(), 0);
		assert.deepEqual(seen, []);
	});
});
