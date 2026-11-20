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
// EXPLORER DEV TOOL — WIRING OVER THE REAL SHELL MODULES (T3, T5, T13)
// =============================================================================
//
// Everything here runs over the shell's REAL busPeer, toolOps and toolChannel
// on the shell's REAL retained registry (see testing.ts), with the JSON wire ON:
// every payload crosses as its JSON image, as VS Code's postMessage carries it,
// and anything JSON would change is recorded in `h.violations` (R4). The lanes
// reuse these shapes for their own op maps.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IToolOpServer, ToolChannel, ToolOpMap, ToolOpSpec } from 'shell';
import { ExplorerToolError } from '../errors';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import { createFrameCaller } from './frame';
import { CONTROLLER_STATE_TOPIC } from './realm';
import { toReply } from './reply';
import type { Reply } from './reply';
import { assertJsonSafe, createDevToolHarness, manualNow, settle, shellProtocol } from './testing';

interface WireOps extends ToolOpMap {
	'w.read': ToolOpSpec<IDeadline & { key: string; text: string }, Reply<{ columns: string[]; rows: unknown[][] }>>;
	'w.write': ToolOpSpec<IDeadline & { key: string; text: string }, Reply<{ affected: number }>>;
	'w.delete': ToolOpSpec<IDeadline & { key: string }, Reply<null>>;
}

/**
 * The frame-side primitives over a new frame mount: ONE host channel, as the host builds it.
 *
 * @param h - The harness.
 * @returns Options for createFrameCaller.
 */
function frameOf(h: ReturnType<typeof createDevToolHarness>) {
	return { channel: shellProtocol.createToolChannel(h.newFramePeer()), createToolOpClient: shellProtocol.createToolOpClient };
}

/** Counts op servers over the real factory. */
function countingServers() {
	const counts = { created: 0, disposed: 0 };
	const factory = (channel: ToolChannel): IToolOpServer<WireOps> => {
		counts.created += 1;
		const server = shellProtocol.createToolOpServer<WireOps>(channel);
		return { serve: (op, handler) => server.serve(op, handler), dispose: () => { counts.disposed += 1; server.dispose(); } };
	};
	return { counts, factory };
}

describe('T3 — every op round-trips JSON-safe; failures come back as equal ExplorerToolErrors', () => {
	it('args, results and Reply errors all survive a JSON round trip, on the wire and at both ends', async () => {
		const h = createDevToolHarness('tool.test', { json: true });
		h.setHostConnection(true);
		const handled: unknown[] = [];
		const failure = new ExplorerToolError({ kind: 'raised', tool: 'execute', code: 'TASK_STOPPED', message: 'Task stopped\nIt was restarted' });
		const attached = attachController<WireOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: {
				'w.read': (params) => toReply(() => { handled.push(params); return { columns: ['id', 'name'], rows: [[1, 'a'], [2, null]] }; }),
				'w.write': (params) => toReply(() => { handled.push(params); throw failure; }),
			},
		});
		const caller = createFrameCaller<WireOps>({ ...frameOf(h) });
		await settle();

		const value = await caller.callReply('w.read', { key: 'k1|dev|user|u1|t|p|tools=tools_1|db_1', text: 'select 1' }, { timeoutMs: 5_000 });
		assert.deepEqual(value, { columns: ['id', 'name'], rows: [[1, 'a'], [2, null]] });
		assertJsonSafe(value, 'result');

		await assert.rejects(caller.callReply('w.write', { key: 'k1', text: 'delete' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.deepEqual(error, failure);
			assert.equal(error.code, 'TASK_STOPPED');
			return true;
		});

		for (const [i, params] of handled.entries()) assertJsonSafe(params, `args #${i}`);
		assert.ok(h.wire.length > 0);
		for (const [i, entry] of h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
		const replies = h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'reply');
		assert.equal(replies.length, 2);
		const errorReply = (replies[1].value as { result: Reply<unknown> }).result;
		assert.deepEqual(errorReply, { ok: false, error: { kind: 'raised', code: 'TASK_STOPPED', tool: 'execute', message: 'Task stopped\nIt was restarted', detail: 'It was restarted' } });
		assert.deepEqual(h.violations, [], 'nothing JSON would change crossed the wire');

		caller.dispose();
		attached.dispose();
	});

	it('a void op answers Reply<null> through the JSON wire, whether the handler returns nothing or uses toReply', async () => {
		const h = createDevToolHarness('tool.test', { json: true });
		const deleted: string[] = [];
		let viaToReply = false;
		const attached = attachController<WireOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: {
				'w.delete': (params) => {
					deleted.push(params.key);
					if (viaToReply) return toReply(() => undefined);
				},
			},
		});
		const caller = createFrameCaller<WireOps>({ ...frameOf(h) });
		await settle();
		assert.equal(await caller.callReply('w.delete', { key: 'a' }, { timeoutMs: 5_000 }), null);
		viaToReply = true;
		assert.equal(await caller.callReply('w.delete', { key: 'b' }, { timeoutMs: 5_000 }), null);
		assert.deepEqual(deleted, ['a', 'b']);
		assert.deepEqual(h.violations, []);
		caller.dispose();
		attached.dispose();
	});

	it('a bus timeout inside the controller comes back to the frame as kind timeout', async () => {
		const h = createDevToolHarness('tool.test', { json: true });
		const attached = attachController<WireOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'w.read': () => toReply(() => { throw new Error("Op 'client.request' timed out after 66000ms (bridged)"); }, { tool: 'get_data' }) },
		});
		const caller = createFrameCaller<WireOps>({ ...frameOf(h) });
		await settle();
		await assert.rejects(caller.callReply('w.read', { key: 'k', text: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'timeout');
			assert.equal(error.tool, 'get_data');
			return true;
		});
		caller.dispose();
		attached.dispose();
	});
});

describe('R3 applied uniformly — whatever a handler does, the frame gets a Reply', () => {
	/**
	 * A controller whose only handler is `handler`, and a frame to call it.
	 *
	 * @param handler - The 'w.write' handler.
	 * @returns The harness pieces.
	 */
	async function rig(handler: (params: IDeadline & { key: string; text: string }) => unknown) {
		const h = createDevToolHarness('tool.test', { json: true });
		const attached = attachController<WireOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'w.write': handler as never },
		});
		const caller = createFrameCaller<WireOps>({ ...frameOf(h) });
		await settle();
		return { h, caller, done: () => { caller.dispose(); attached.dispose(); } };
	}

	it('a handler that THROWS an ExplorerToolError (no toReply) reaches the frame with kind and code intact', async () => {
		const failure = new ExplorerToolError({ kind: 'raised', tool: 'execute', code: 'TASK_STOPPED', message: 'Task stopped' });
		const { h, caller, done } = await rig(() => { throw failure; });
		await assert.rejects(caller.callReply('w.write', { key: 'k', text: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError, 'rebuilt, not a plain Error');
			assert.deepEqual(error, failure);
			return true;
		});
		assert.deepEqual(h.violations, []);
		done();
	});

	it('a plain return value is answered as replyOk(value)', async () => {
		const { caller, done } = await rig(() => ({ affected: 3 }));
		assert.deepEqual(await caller.call('w.write', { key: 'k', text: 'x' }, { timeoutMs: 5_000 }), { ok: true, value: { affected: 3 } });
		done();
	});

	it('a foreign failure escaping a handler becomes Reply data (a lane timeout text is kind timeout)', async () => {
		const { caller, done } = await rig(async () => { throw new Error("Op 'client.request' timed out after 66000ms"); });
		await assert.rejects(caller.callReply('w.write', { key: 'k', text: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'timeout');
			assert.equal(error.tool, 'w.write', 'the frame names the op when the failure names no tool');
			return true;
		});
		done();
	});

	it('a programming error is still thrown, never dressed up as data: the frame gets a plain Error', async () => {
		const { caller, done } = await rig(() => { throw new TypeError('x is not a function'); });
		await assert.rejects(caller.callReply('w.write', { key: 'k', text: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error instanceof ExplorerToolError, false);
			assert.equal(error.message, 'x is not a function');
			return true;
		});
		done();
	});
});

describe('T5 — mount -> dispose -> mount leaves one live op server; replays execute nothing', () => {
	it('ops are answered and channel events delivered (the host channel, rocket-ui and VS Code alike)', async () => {
		const h = createDevToolHarness('tool.test', { json: true });
		const hostChannel = shellProtocol.createToolChannel(h.sidebarPeer);
		const servers = countingServers();
		const runs: string[] = [];
		const mount = () => attachController<WireOps>({
			channel: hostChannel,
			createToolOpServer: servers.factory,
			handlers: {
				'w.read': (params) => toReply(() => { runs.push(`read:${params.text}`); return { columns: [], rows: [] }; }),
				'w.write': (params) => toReply(() => { runs.push(`write:${params.text}`); return { affected: 1 }; }),
			},
		});

		// StrictMode: mount, cleanup, mount.
		const first = mount();
		first.dispose();
		const second = mount();
		assert.equal(servers.counts.created - servers.counts.disposed, 1, 'exactly one live op server');

		const actives: unknown[] = [];
		second.channel.onEvent('active', (payload) => actives.push(payload));

		const frameChannel = shellProtocol.createToolChannel(h.newFramePeer());
		const caller = createFrameCaller<WireOps>({ channel: frameChannel, createToolOpClient: shellProtocol.createToolOpClient });
		await settle();

		// Ops are answered, once each.
		await caller.callReply('w.write', { key: 'k', text: 'one' }, { timeoutMs: 5_000 });
		assert.deepEqual(runs, ['write:one']);

		// A channel event reaches the controller's channel (it can arrive twice: the live signal and the retained last-payload slot).
		frameChannel.sendEvent('active', 'workbench:k');
		await settle();
		assert.ok(actives.length >= 1 && actives.every((payload) => payload === 'workbench:k'));

		// Remount: the retained last frame payload replays into the channel and executes nothing.
		second.dispose();
		const third = mount();
		await settle();
		assert.equal(servers.counts.created - servers.counts.disposed, 1);
		assert.deepEqual(runs, ['write:one']);

		// And the remounted controller still answers.
		await caller.callReply('w.read', { key: 'k', text: 'two' }, { timeoutMs: 5_000 });
		assert.deepEqual(runs, ['write:one', 'read:two']);
		assert.deepEqual(h.violations, []);

		caller.dispose();
		third.dispose();
	});
});

describe('T13 — a call to a controller that has gone away is dropped, never run later', () => {
	it('the channel stays subscribed with no handlers, so the call is dropped; the frame gives up and a later mount runs nothing', async () => {
		const h = createDevToolHarness('tool.test', { json: true });
		const clock = manualNow(1_000_000);
		const runs: string[] = [];
		const hostChannel = shellProtocol.createToolChannel(h.sidebarPeer);
		const mount = () => attachController<WireOps>({
			channel: hostChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			now: clock.now,
			handlers: { 'w.write': (params) => toReply(() => { runs.push(params.text); return { affected: 1 }; }) },
		});
		const caller = createFrameCaller<WireOps>({ ...frameOf(h), now: clock.now });

		const first = mount();
		await settle();
		const late = caller.callReply('w.write', { key: 'k', text: 'late' }, { timeoutMs: 40 });
		first.dispose();
		await assert.rejects(late, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
		assert.equal(caller.pending(), 0, 'the frame gave up');

		clock.advance(5 * 60_000);
		const again = mount();
		await settle();
		assert.deepEqual(runs, [], 'the dropped write never ran');
		again.dispose();
		caller.dispose();
	});

	it('a call that reaches a live controller after its deadline is refused without running (R2)', async () => {
		const h = createDevToolHarness('tool.test', { json: true });
		const clock = manualNow(1_000_000);
		const runs: string[] = [];
		const refused: string[] = [];
		const attached = attachController<WireOps>({
			channel: shellProtocol.createToolChannel(h.sidebarPeer),
			createToolOpServer: shellProtocol.createToolOpServer,
			now: clock.now,
			onRefused: (error) => refused.push(`${error.op}:${error.reason}`),
			handlers: { 'w.write': (params) => toReply(() => { runs.push(params.text); return { affected: 1 }; }) },
		});
		const call = shellProtocol.createToolOpClient<WireOps>(shellProtocol.createToolChannel(h.newFramePeer()));
		await settle();
		await assert.rejects(call('w.write', { key: 'k', text: 'old', deadlineAt: clock.now() - 1 }, { timeoutMs: 1_000 }), /deadline/);
		assert.deepEqual(runs, []);
		assert.deepEqual(refused, ['w.write:expired']);
		attached.dispose();
	});
});

describe('readiness — a call made in the render -> effect window (CE-9)', () => {
	/**
	 * The handler log and a mount over the harness.
	 *
	 * @param h - The harness.
	 * @param channel - The host channel.
	 * @returns The runs and the mount function.
	 */
	function lane(h: ReturnType<typeof createDevToolHarness>, channel: ReturnType<typeof shellProtocol.createToolChannel>) {
		const runs: string[] = [];
		const mount = () => attachController<WireOps>({
			channel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'w.write': (params) => { runs.push(params.text); return { affected: 1 }; } },
		});
		return { runs, mount };
	}

	it('the host channel subscribes at render (DevToolSidebarMount.tsx), before the controller effect: a call made then is held until readiness and succeeds', async () => {
		const h = createDevToolHarness();
		const hostChannel = shellProtocol.createToolChannel(h.sidebarPeer);
		const { runs, mount } = lane(h, hostChannel);
		const caller = createFrameCaller<WireOps>({ ...frameOf(h) });
		await settle();
		const call = caller.callReply('w.write', { key: 'k', text: 'reload' }, { timeoutMs: 2_000 });
		await settle();
		const attached = mount();
		assert.deepEqual(await call, { affected: 1 });
		assert.deepEqual(runs, ['reload']);
		assert.deepEqual(h.violations, []);
		caller.dispose();
		attached.dispose();
	});

	it('a stale ready left by a dead controller is still bounded by the deadline', async () => {
		const h = createDevToolHarness();
		const hostChannel = shellProtocol.createToolChannel(h.sidebarPeer);
		// A controller whose realm died without its dispose running: its last word was "ready".
		hostChannel.publishState(CONTROLLER_STATE_TOPIC, { ready: 'dead-controller' });
		const caller = createFrameCaller<WireOps>({ ...frameOf(h) });
		await settle();
		assert.equal(caller.controllerReady(), true);
		await assert.rejects(caller.callReply('w.write', { key: 'k', text: 'lost' }, { timeoutMs: 80 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
		assert.equal(caller.pending(), 0);
		caller.dispose();
	});
});
