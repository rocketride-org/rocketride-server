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
// BUS OPS + BRIDGE TESTS — the addressed-op lane and the hub-and-spoke router
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpBus, typedBusOps, BusNoHandlerError } from './busOps';
import type { ShellOpMap, ShellOpSpec } from './busOps';
import { attachRealmToRoot, createBusRouter, createLocalEndpointPair } from './busBridge';

/** Flushes queued microtasks + macrotask hops used by the local endpoints. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

// =============================================================================
// IN-REALM
// =============================================================================

test('request resolves a local handler with its result', async () => {
	const bus = createOpBus();
	bus.handle('math.add', (p) => (p as { a: number; b: number }).a + (p as { a: number; b: number }).b);
	assert.equal(await bus.request('math.add', { a: 2, b: 3 }), 5);
});

test('request rejects with BusNoHandlerError when nothing is registered', async () => {
	const bus = createOpBus();
	await assert.rejects(bus.request('ghost.op', {}), BusNoHandlerError);
});

test('double registration throws; unregister frees the name', () => {
	const bus = createOpBus();
	const off = bus.handle('x.y', () => 1);
	assert.throws(() => bus.handle('x.y', () => 2));
	off();
	assert.doesNotThrow(() => bus.handle('x.y', () => 3));
});

test('emitOp runs the same handler fire-and-forget', async () => {
	const bus = createOpBus();
	let got: unknown = null;
	bus.handle('log.note', (p) => {
		got = p;
		return 'discarded';
	});
	bus.emitOp('log.note', { msg: 'hi' });
	await settle();
	assert.deepEqual(got, { msg: 'hi' });
});

test('a handler error rejects the request with the message intact', async () => {
	const bus = createOpBus();
	bus.handle('boom.now', () => {
		throw new Error('kaput');
	});
	await assert.rejects(bus.request('boom.now', {}), /kaput/);
});

test('a hung handler rejects at the timeout', async () => {
	const bus = createOpBus();
	bus.handle('hang.forever', () => new Promise(() => { /* never */ }));
	await assert.rejects(bus.request('hang.forever', {}, { timeoutMs: 30 }), /timed out/);
});

test('typedBusOps carries the op map end to end', async () => {
	interface TestOps extends ShellOpMap {
		'echo.back': ShellOpSpec<{ s: string }, string>;
	}
	const bus = createOpBus();
	const ops = typedBusOps<TestOps>(bus);
	ops.handle('echo.back', ({ s }) => s.toUpperCase());
	assert.equal(await ops.request('echo.back', { s: 'ab' }), 'AB');
});

// =============================================================================
// BRIDGED — realm ↔ root
// =============================================================================

/** One root + one attached realm over a local endpoint pair. */
function bridgedPair() {
	const rootBus = createOpBus();
	const realmBus = createOpBus();
	const router = createBusRouter(rootBus);
	const [rootEnd, realmEnd] = createLocalEndpointPair();
	const detachRealm = router.addRealm(rootEnd, 'test-realm');
	const detachBridge = attachRealmToRoot(realmBus, realmEnd).detach;
	return { rootBus, realmBus, router, detachRealm, detachBridge };
}

test('realm request resolves against a ROOT handler (client.* broker shape)', async () => {
	const { rootBus, realmBus } = bridgedPair();
	rootBus.handle('client.ping', () => 'pong');
	assert.equal(await realmBus.request('client.ping', {}), 'pong');
});

test('root request resolves against a REALM handler (tool controller shape)', async () => {
	const { rootBus, realmBus } = bridgedPair();
	realmBus.handle('explorer.listDir', (p) => [`${(p as { path: string }).path}/a`]);
	await settle(); // registration announcement crosses the endpoint
	assert.deepEqual(await rootBus.request('explorer.listDir', { path: '@' }), ['@/a']);
});

test('handler errors cross the bridge as rejections', async () => {
	const { rootBus, realmBus } = bridgedPair();
	rootBus.handle('client.explode', () => {
		throw new Error('server said no');
	});
	await assert.rejects(realmBus.request('client.explode', {}), /server said no/);
});

test('an unregistered op rejects across the bridge (no silent drop)', async () => {
	const { realmBus } = bridgedPair();
	await assert.rejects(realmBus.request('nobody.home', {}), /No handler registered/);
});

test('emitOp from the realm reaches the root handler', async () => {
	const { rootBus, realmBus } = bridgedPair();
	let seen: unknown = null;
	rootBus.handle('client.note', (p) => {
		seen = p;
	});
	realmBus.emitOp('client.note', { n: 7 });
	await settle();
	assert.deepEqual(seen, { n: 7 });
});

test('unregister withdraws the routing entry at the root', async () => {
	const { rootBus, realmBus } = bridgedPair();
	const off = realmBus.handle('temp.op', () => 1);
	await settle();
	assert.equal(await rootBus.request('temp.op', {}), 1);
	off();
	await settle();
	await assert.rejects(rootBus.request('temp.op', {}), /No handler registered/);
});

test('realm death rejects in-flight requests routed to it and clears its ops', async () => {
	const { rootBus, realmBus, detachRealm } = bridgedPair();
	realmBus.handle('slow.op', () => new Promise(() => { /* never answers */ }));
	await settle();
	const inflight = rootBus.request('slow.op', {}, { timeoutMs: 5_000 });
	await settle();
	detachRealm();
	await assert.rejects(inflight, /detached/);
	await assert.rejects(rootBus.request('slow.op', {}), /No handler registered/);
});

test('bridge detach rejects the realm side in-flight outbound', async () => {
	const { rootBus, realmBus, detachBridge } = bridgedPair();
	rootBus.handle('slow.root', () => new Promise(() => { /* never */ }));
	const inflight = realmBus.request('slow.root', {}, { timeoutMs: 5_000 });
	await settle();
	detachBridge();
	await assert.rejects(inflight, /detached/);
});

test('cross-realm: one realm requests an op another realm registered', async () => {
	const rootBus = createOpBus();
	const router = createBusRouter(rootBus);
	const busA = createOpBus();
	const busB = createOpBus();
	const [rootEndA, realmEndA] = createLocalEndpointPair();
	const [rootEndB, realmEndB] = createLocalEndpointPair();
	router.addRealm(rootEndA, 'A');
	router.addRealm(rootEndB, 'B');
	attachRealmToRoot(busA, realmEndA);
	attachRealmToRoot(busB, realmEndB);
	busB.handle('b.whoami', () => 'realm B');
	await settle();
	assert.equal(await busA.request('b.whoami', {}), 'realm B');
});

// =============================================================================
// SUMMON
// =============================================================================

test('summon activates a dormant owner, waits for registration, then delivers the request', async () => {
	const rootBus = createOpBus();
	const dormantBus = createOpBus();
	const [rootEnd, realmEnd] = createLocalEndpointPair();

	let activated = 0;
	const router = createBusRouter(rootBus, {
		summon: (op) => (op.startsWith('appdev:') ? () => {
			activated++;
			// Activation mounts the controller, which registers its ops.
			setTimeout(() => dormantBus.handle('appdev:openApp', (p) => `opened:${(p as { appId: string }).appId}`), 20);
		} : null),
	});
	router.addRealm(rootEnd, 'sidebar');
	attachRealmToRoot(dormantBus, realmEnd);

	const result = await rootBus.request('appdev:openApp', { appId: 'x1' }, { timeoutMs: 5_000 });
	assert.equal(result, 'opened:x1');
	assert.equal(activated, 1);
});

test('summon on the emit lane buffers and delivers on registration', async () => {
	const rootBus = createOpBus();
	const dormantBus = createOpBus();
	const [rootEnd, realmEnd] = createLocalEndpointPair();
	const got: unknown[] = [];

	const router = createBusRouter(rootBus, {
		summon: (op) => (op === 'appdev:openApp' ? () => {
			setTimeout(() => dormantBus.handle('appdev:openApp', (p) => {
				got.push(p);
			}), 20);
		} : null),
	});
	router.addRealm(rootEnd, 'sidebar');
	attachRealmToRoot(dormantBus, realmEnd);

	rootBus.emitOp('appdev:openApp', { appId: 'y1' });
	rootBus.emitOp('appdev:openApp', { appId: 'y2' });
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(got, [{ appId: 'y1' }, { appId: 'y2' }]);
});

test('an uninstalled namespace rejects — summon never installs', async () => {
	const rootBus = createOpBus();
	const router = createBusRouter(rootBus, { summon: () => null });
	assert.ok(router);
	await assert.rejects(rootBus.request('uninstalled:thing', {}), /No handler registered/);
});
