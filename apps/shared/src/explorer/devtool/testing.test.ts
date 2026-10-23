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
// EXPLORER DEV TOOL — THE HARNESS ITSELF (it must reproduce the real platform)
// =============================================================================
//
// The harness is only worth something if it IS the platform: these checks pin
// the busPeer quirks the dev-tool design works around, over the real modules,
// so a harness that drifted into a hand-written fake would fail here first.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolOpMap, ToolOpSpec } from 'shell';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import type { Reply } from './reply';
import { account, assertJsonSafe, assertSidebarSubscribers, createDevToolHarness, createFakeSocketlessRealm, findToolFactoryImports, makeBus, settle, shellProtocol, spyPeer } from './testing';

describe('assertJsonSafe', () => {
	it('accepts plain JSON data', () => {
		for (const ok of [null, true, 0, -1.5, 'text', [], {}, [1, 'a', null, { b: [true] }], { nested: { list: [{ x: 1 }] } }, Object.create(null) as object]) {
			assert.doesNotThrow(() => assertJsonSafe(ok), JSON.stringify(ok));
		}
	});

	it('rejects everything a JSON round trip changes or drops', () => {
		class Point { x = 1; }
		const cases: Array<[string, unknown]> = [
			['Map', new Map([['a', 1]])],
			['Set', new Set([1])],
			['function', () => 1],
			['nested function', { run: () => 1 }],
			['class instance', new Point()],
			['Date', new Date(0)],
			['Error', new Error('x')],
			['typed array', new Uint8Array([1, 2])],
			['ArrayBuffer', new ArrayBuffer(2)],
			['undefined', undefined],
			['undefined in an array', [1, undefined]],
			['undefined property', { a: undefined }],
			['NaN', Number.NaN],
			['Infinity', { n: Number.POSITIVE_INFINITY }],
			['-0', -0],
			['bigint', { n: BigInt(1) }],
			['symbol', { s: Symbol('x') }],
			['sparse array', new Array(2)],
		];
		for (const [label, value] of cases) {
			assert.throws(() => assertJsonSafe(value, label), Error, label);
		}
	});

	it('names where the problem is', () => {
		assert.throws(() => assertJsonSafe({ rows: [[1, new Map()]] }, 'result'), /result\.rows\[0\]\[1\]/);
	});
});

describe('the JSON wire (what VS Code postMessage does to every payload)', () => {
	it('makeBus({ json: true }) delivers the JSON image of each signal and publish, and records what JSON changed', async () => {
		const { bus, registry, violations } = makeBus(undefined, { json: true });
		const seen: unknown[] = [];
		bus.subscribe('t', (value) => seen.push(value));
		const sent = { a: 1, gone: undefined, nested: { at: new Date(0) } };
		bus.signal('t', sent);
		await settle();
		assert.deepEqual(seen, [{ a: 1, nested: { at: '1970-01-01T00:00:00.000Z' } }]);
		assert.notEqual(seen[0], sent, 'a copy, as across postMessage');
		assert.equal(violations.length, 1);
		assert.equal(violations[0].topic, 't');
		assert.match(violations[0].message, /t\.gone/);
		bus.publish('r', { rows: [[1, 2]] });
		assert.deepEqual(registry.read('r'), { rows: [[1, 2]] });
		assert.equal(violations.length, 1, 'a JSON-safe payload is not a violation');
	});

	it('the harness serialises by default; { json: false } models the in-process rocket-ui realm', async () => {
		const strict = createDevToolHarness();
		const loose = createDevToolHarness('tool.test', { json: false });
		for (const h of [strict, loose]) {
			const seen: unknown[] = [];
			h.sidebarPeer.subscribe((m) => seen.push(m));
			const frame = h.newFramePeer();
			frame.subscribe(() => undefined);
			await settle();
			frame.post({ __rrtool: 'call', id: 'x:1', op: 't.op', args: { gone: undefined } });
			await settle();
			assert.equal('gone' in ((seen.at(-1) as { args: object }).args), h === loose);
		}
		assert.equal(strict.violations.length, 1);
		assert.deepEqual(loose.violations, []);
	});
});

describe('the harness runs the REAL busPeer (fidelity checks)', () => {
	it('quirk 1: the sidebar peer keeps ONE live subscriber; calls reach the last one', async () => {
		const h = createDevToolHarness();
		const first: unknown[] = [];
		const second: unknown[] = [];
		h.sidebarPeer.subscribe((m) => first.push(m));
		h.sidebarPeer.subscribe((m) => second.push(m));
		const frame = h.newFramePeer();
		frame.subscribe(() => undefined);
		await settle();
		frame.post({ __rrtool: 'call', id: 'x:1', op: 't.op', args: {} });
		await settle();
		assert.equal(first.length, 0);
		assert.equal(second.length, 1);
	});

	it('quirk 2: the live subscriber hears a frame event twice (signal + retained slot)', async () => {
		const h = createDevToolHarness();
		const seen: unknown[] = [];
		h.sidebarPeer.subscribe((m) => seen.push(m));
		const frame = h.newFramePeer();
		const channel = shellProtocol.createToolChannel(frame);
		await settle();
		channel.sendEvent('active', 'k');
		await settle();
		assert.equal(seen.filter((m) => (m as { name?: string }).name === 'active').length, 2);
	});

	it('quirk 6: with no sidebar subscriber, a call is held and delivered synchronously to the next subscriber', async () => {
		const h = createDevToolHarness();
		const frame = h.newFramePeer();
		frame.subscribe(() => undefined);
		await settle();
		frame.post({ __rrtool: 'call', id: 'x:1', op: 't.op', args: {} });
		await settle();
		const seen: unknown[] = [];
		h.sidebarPeer.subscribe((m) => seen.push(m));
		assert.equal(seen.length, 1, 'delivered inside subscribe(), before any handler could be registered');
	});

	it('records every topic write, and the summon op', async () => {
		const h = createDevToolHarness();
		h.sidebarPeer.post({ __rrtool: 'event', name: 'open', payload: 'x' });
		await settle();
		assert.deepEqual(h.emitted, [{ op: 'host.openToolPanel', params: { appId: h.appId } }]);
		h.setHostConnection(false);
		assert.ok(h.wire.some((entry) => entry.topic === shellProtocol.HOST_CONNECTION_TOPIC));
	});
});

describe('the fake realms follow connection.ts', () => {
	it('a socketless realm ignores a falsy account snapshot but its topic carries it', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(account('u'));
		await settle();
		realm.root.accountChanged(null);
		await settle();
		assert.equal((realm.cm.getAccountInfo() as { userId?: string }).userId, 'u');
		assert.equal(await realm.cm.read('shell:account'), null);
	});
});

describe('the second-subscriber guard (quirk 1) a lane copies into its own mount test', () => {
	interface GuardOps extends ToolOpMap {
		'g.read': ToolOpSpec<IDeadline, Reply<number>>;
	}

	/**
	 * Mount a controller the way a lane does, over a spied sidebar peer.
	 *
	 * @param withHostChannel - Build the host channel first (both real hosts do).
	 * @returns The spy and the mount.
	 */
	function mount(withHostChannel: boolean) {
		const h = createDevToolHarness();
		const spy = spyPeer(h.sidebarPeer);
		const channel = withHostChannel ? shellProtocol.createToolChannel(spy.peer) : undefined;
		const attach = () => attachController<GuardOps>({
			peer: spy.peer,
			...(channel ? { channel } : {}),
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'g.read': () => 1 },
		});
		return { h, spy, attach };
	}

	it('passes for a correct mount, StrictMode remount included (channel + op server)', () => {
		for (const withHostChannel of [true, false]) {
			const { spy, attach } = mount(withHostChannel);
			attach().dispose();
			const live = attach();
			assert.doesNotThrow(() => assertSidebarSubscribers(spy, 'mount'));
			assert.equal(spy.active, 2);
			live.dispose();
		}
	});

	it('fails for a stray subscriber after the mount (a channel built in render), which really does steal every call', async () => {
		const { h, spy, attach } = mount(true);
		const live = attach();
		shellProtocol.createToolChannel(spy.peer);
		assert.throws(() => assertSidebarSubscribers(spy, 'sql sidebar'), /sql sidebar: the sidebar peer has 3 live subscribers/);
		const call = shellProtocol.createToolController<GuardOps>(h.newFramePeer());
		await settle();
		await assert.rejects(call('g.read', { deadlineAt: Date.now() + 60_000 }, { timeoutMs: 100 }), /did not answer/);
		live.dispose();
	});

	it('findToolFactoryImports lists the modules that import a protocol factory as a VALUE from shell', () => {
		const found = findToolFactoryImports([
			{ path: 'src/devtool/wiring.ts', text: "import { createToolOpServer, typedToolChannel } from 'shell';" },
			{ path: 'src/Sidebar.tsx', text: "import {\n\tConnectionManager,\n\tcreateToolChannel,\n} from 'shell';" },
			{ path: 'src/types.ts', text: "import type { ToolChannel, IToolOpServer } from 'shell';" },
			{ path: 'src/frame.ts', text: "import { createToolController as makeController } from 'shell';" },
			{ path: 'src/other.ts', text: "import { useToolState } from 'shell';\n// createToolChannel is mentioned in a comment only" },
		]);
		assert.deepEqual(found, ['src/devtool/wiring.ts', 'src/Sidebar.tsx', 'src/frame.ts']);
	});
});

describe('round 3 — the JSON wire judges payloads, not the envelope (CE-1)', () => {
	it("a payload-less sendEvent is no violation, and an undefined INSIDE a payload still is", async () => {
		const h = createDevToolHarness();
		const sidebar = shellProtocol.createToolChannel(h.sidebarPeer);
		const frame = shellProtocol.createToolChannel(h.newFramePeer());
		const got: unknown[] = [];
		sidebar.onEvent('refresh', (payload) => got.push(payload));
		await settle();
		frame.sendEvent('refresh');
		await settle();
		assert.deepEqual(got, [undefined, undefined]);
		assert.equal(h.violations.length, 0, "the envelope's own optional field is not the tool's data");
		frame.sendEvent('active', { key: 'k', gone: undefined });
		await settle();
		assert.equal(h.violations.length, 2, 'the frame event crosses twice: the retained slot and the signal');
		for (const violation of h.violations) assert.match(violation.message, /payload\.gone/);
	});

	it('a call without args and a void reply without a result carry no violation either', async () => {
		const h = createDevToolHarness();
		interface VoidOps extends ToolOpMap {
			't.void': ToolOpSpec<undefined, undefined>;
		}
		const server = shellProtocol.createToolOpServer<VoidOps>(h.sidebarPeer);
		server.serve('t.void', () => undefined);
		const call = shellProtocol.createToolController<VoidOps>(h.newFramePeer());
		await settle();
		assert.equal(await call('t.void', undefined, { timeoutMs: 2_000 }), undefined);
		assert.deepEqual(h.violations, []);
		server.dispose();
	});
});

describe('round 3 — findToolFactoryImports catches every import form (CE-7; an accident guard, not a security boundary)', () => {
	it('namespace, default, re-export, star re-export, dynamic import and double quotes', () => {
		const files = [
			{ path: 'ns.ts', text: "import * as shell from 'shell';\nexport const c = shell.createToolChannel(peer);" },
			{ path: 'dq.ts', text: 'import { createToolChannel } from "shell";' },
			{ path: 'reexport.ts', text: "export { createToolOpServer } from 'shell';" },
			{ path: 'star.ts', text: "export * from 'shell';" },
			{ path: 'dyn.ts', text: "const m = await import('shell'); m.createToolController(peer);" },
			{ path: 'default.ts', text: "import shell, { foo } from 'shell'; shell.createToolChannel(peer);" },
			{ path: 'clean-ns.ts', text: "import * as shell from 'shell';\nshell.useToolState(channel, 'x');" },
			{ path: 'types-only.ts', text: "import type { ToolChannel } from \"shell\";\nexport type { IToolOpServer } from 'shell';" },
		];
		assert.deepEqual(findToolFactoryImports(files), ['ns.ts', 'dq.ts', 'reexport.ts', 'star.ts', 'dyn.ts', 'default.ts']);
	});
});

