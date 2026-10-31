// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// RETAINED-TOPIC TESTS — the bus's third lane (registry + bridged port)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetainedRegistry, localRetainedPort } from './retained';
import { createOpBus } from './busOps';
import { attachRealmToRoot, createBusRouter, createLocalEndpointPair } from './busBridge';

/** Flushes queued microtasks + macrotask hops (async delivery + endpoints). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

// =============================================================================
// REGISTRY (in-realm)
// =============================================================================

test('publish then subscribe replays the current snapshot', async () => {
	const reg = createRetainedRegistry();
	reg.publish('t:a', { v: 1 });
	const seen: unknown[] = [];
	reg.subscribe('t:a', (s) => seen.push(s));
	await settle();
	assert.deepEqual(seen, [{ v: 1 }]);
});

test('subscribe before first publish fires on that publish (no phantom call)', async () => {
	const reg = createRetainedRegistry();
	const seen: unknown[] = [];
	reg.subscribe('t:a', (s) => seen.push(s));
	await settle();
	assert.deepEqual(seen, []); // registered, silent — no value yet
	reg.publish('t:a', 'first');
	await settle();
	assert.deepEqual(seen, ['first']);
});

test('publish replaces: late subscriber sees only the last value', async () => {
	const reg = createRetainedRegistry();
	reg.publish('t:a', 1);
	reg.publish('t:a', 2);
	const seen: unknown[] = [];
	reg.subscribe('t:a', (s) => seen.push(s));
	await settle();
	assert.deepEqual(seen, [2]);
});

test('retract (publish undefined) deletes and notifies', async () => {
	const reg = createRetainedRegistry();
	reg.publish('t:a', 1);
	const seen: unknown[] = [];
	reg.subscribe('t:a', (s) => seen.push(s));
	await settle();
	reg.publish('t:a', undefined);
	await settle();
	assert.deepEqual(seen, [1, undefined]);
	assert.equal(reg.read('t:a'), undefined);
	// A fresh subscriber replays nothing after retraction.
	const late: unknown[] = [];
	reg.subscribe('t:a', (s) => late.push(s));
	await settle();
	assert.deepEqual(late, []);
});

test('unsubscribe stops delivery; delivery is never synchronous', async () => {
	const reg = createRetainedRegistry();
	const seen: unknown[] = [];
	const off = reg.subscribe('t:a', (s) => seen.push(s));
	reg.publish('t:a', 1);
	assert.deepEqual(seen, []); // async by contract — nothing inside publish()
	await settle();
	off();
	reg.publish('t:a', 2);
	await settle();
	assert.deepEqual(seen, [1]);
});

test('localRetainedPort read answers the current snapshot', async () => {
	const reg = createRetainedRegistry();
	const port = localRetainedPort(reg);
	port.publish('t:a', 'x');
	assert.equal(await port.read('t:a'), 'x');
	assert.equal(await port.read('t:none'), undefined);
});

// =============================================================================
// BRIDGED (realm <-> root over the router)
// =============================================================================

function bridged() {
	const rootBus = createOpBus();
	const retained = createRetainedRegistry();
	const router = createBusRouter(rootBus, { retained });
	const realmBus = createOpBus();
	const [rootEnd, realmEnd] = createLocalEndpointPair();
	router.addRealm(rootEnd, 'test-realm');
	const attachment = attachRealmToRoot(realmBus, realmEnd);
	return { retained, realm: attachment.retained, realmBus, router };
}

test('bridged subscribe replays the root snapshot and receives live updates', async () => {
	const { retained, realm } = bridged();
	retained.publish('shell:x', 'seed');
	await settle();
	const seen: unknown[] = [];
	realm.subscribe('shell:x', (s) => seen.push(s));
	await settle();
	assert.deepEqual(seen, ['seed']);
	retained.publish('shell:x', 'live');
	await settle();
	assert.deepEqual(seen, ['seed', 'live']);
});

test('bridged publish lands in the root registry and fans to other realms', async () => {
	const { retained, realm } = bridged();
	realm.publish('tool:state', { sel: 'a' });
	await settle();
	assert.deepEqual(retained.read('tool:state'), { sel: 'a' });
});

test('bridged read rides the request lane', async () => {
	const { retained, realm } = bridged();
	retained.publish('shell:x', 42);
	assert.equal(await realm.read('shell:x'), 42);
	assert.equal(await realm.read('shell:none'), undefined);
});

test('subscribe-before-first-publish works across the bridge', async () => {
	const { retained, realm } = bridged();
	const seen: unknown[] = [];
	realm.subscribe('shell:late', (s) => seen.push(s));
	await settle();
	assert.deepEqual(seen, []);
	retained.publish('shell:late', 'now');
	await settle();
	assert.deepEqual(seen, ['now']);
});
