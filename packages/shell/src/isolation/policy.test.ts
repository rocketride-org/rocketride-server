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
// POLICY TESTS — T21 to T24 (namespaces, retained allowlist, response hijack, broadcast)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatedBusRouter } from '../ops/busBridge';
import { createOpBus } from '../ops/busOps';
import { createRetainedRegistry } from '../ops/retained';
import type { RealmContext } from './types';
import { ENTRY_A, ENTRY_B, makeRoot, refAppKey } from './__test__/fixtures';
import { SEEDED_TOPICS } from './__test__/fakeCm';
import { createChannel, settle } from './__test__/realm';
import { assertDeniedOp, outcome } from './__test__/util';

const keyA = refAppKey(ENTRY_A.id);
const keyB = refAppKey(ENTRY_B.id);

test('T21 realms register only app.<ownKey>.* and requests stay inside the app namespace', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const A2 = t.open(ENTRY_A);
	const B = t.open(ENTRY_B);

	// Registrations outside the namespace are ignored.
	A.bus.handle('shell.anything', () => 'from-A');
	A.bus.handle(`app.${keyB}.x`, () => 'from-A-foreign');
	await settle();
	await assertDeniedOp(B.request('shell.anything', {}), ['unknown_op', 'namespace'], 'a request to an op registered outside app.<key>.*');
	await assertDeniedOp(B.request(`app.${keyB}.x`, {}), ['unknown_op', 'namespace'], "a foreign realm's registration of app.<otherKey>.*");

	// Own namespace works across tabs of the same app.
	A.bus.handle(`app.${keyA}.x`, () => 'own');
	await settle();
	assert.equal(await A2.request(`app.${keyA}.x`, {}), 'own', 'a second realm of the same app reaches the op');

	// A request or emitOp into another app's namespace is refused. (Asked from A2: A itself
	// holds a local handler for app.<keyB>.x, which its own bus resolves without the root.)
	await assertDeniedOp(A2.request(`app.${keyB}.x`, {}), 'namespace', 'a request into another app namespace');
	await assertDeniedOp(B.request(`app.${keyA}.x`, {}), 'namespace', 'a request from another app into this one');
	// B's real handler for its own op is unreachable from A, even over a raw port.
	let bCalls = 0;
	B.bus.handle(`app.${keyB}.y`, () => {
		bCalls++;
		return 'from-B';
	});
	await settle();
	const Araw = t.open(ENTRY_A, { raw: true });
	const raw = await Araw.rawRequest(`app.${keyB}.y`, {});
	assert.ok(raw && raw.ok === false && String(raw.error).startsWith('RR_DENIED:') && JSON.parse(String(raw.error).slice(10)).code === 'namespace', `a raw request into another app namespace is refused, got ${JSON.stringify(raw)}`);
	assert.equal(bCalls, 0, "B's handler is never called");
	A.bus.handle('client.request', () => 'hijack');
	await settle();
	const r = await outcome(B.request('client.request', { message: { type: 'request', seq: 1, command: 'rrext_ping' } }));
	assert.ok(r.ok && (r.value as { ok?: boolean }).ok === true, 'client.request must still resolve at the root');
});

test('T22 the retained lane is an allowlist; app.<key>.* topics live in a private registry', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const A2 = t.open(ENTRY_A);
	const B = t.open(ENTRY_B);
	const topicsOf = (r: { received: unknown[] }): string[] => r.received.filter((m) => (m as { __rrbus?: string }).__rrbus === 'topic').map((m) => (m as { topic: string }).topic);

	const got: Record<string, unknown[]> = {};
	const all = Object.values(SEEDED_TOPICS);
	for (const topic of all) A.retained.subscribe(topic, (s) => (got[topic] ??= []).push(s));
	await settle();
	t.cm.retained().publish(SEEDED_TOPICS.account, { marker: 'live-update' });
	await settle();

	for (const denied of [SEEDED_TOPICS.account, SEEDED_TOPICS.telemetry, SEEDED_TOPICS.mirror, SEEDED_TOPICS.prefsOther]) {
		assert.ok(!topicsOf(A).includes(denied), `${denied} must never be delivered or replayed (the realm received ${JSON.stringify(topicsOf(A))})`);
	}
	assert.ok(topicsOf(A).includes(SEEDED_TOPICS.hostConnection), 'host:connection is delivered');
	assert.ok(topicsOf(A).includes(SEEDED_TOPICS.prefsOwn), "the app's own prefs topic is delivered");

	await assertDeniedOp(A.request('bus.topic.read', { topic: SEEDED_TOPICS.account }), 'namespace', 'bus.topic.read shell:account');
	await assertDeniedOp(A.request('bus.topic.read', { topic: SEEDED_TOPICS.prefsOther }), 'namespace', "bus.topic.read another app's prefs");
	assert.deepEqual(await A.request('bus.topic.read', { topic: SEEDED_TOPICS.hostConnection }), { marker: 'host-connection-snapshot' });

	// Private topics: shared by realms of one app, invisible to others and to the root registry.
	const own = `app.${keyA}.t`;
	const seen2: unknown[] = [];
	const seenB: unknown[] = [];
	A2.retained.subscribe(own, (s) => seen2.push(s));
	B.retained.subscribe(own, (s) => seenB.push(s));
	await settle();
	A.retained.publish(own, { n: 1 });
	await settle();
	assert.deepEqual(seen2, [{ n: 1 }], 'a second realm of the same app receives the publish');
	assert.deepEqual(seenB, [], 'another app does not');
	assert.equal(t.cm.retained().read(own), undefined, "an app topic must not appear in the root's registry");

	// Writes to the shell's prefs topic are ignored.
	A.retained.publish(SEEDED_TOPICS.prefsOwn, { marker: 'overwritten' });
	await settle();
	assert.deepEqual(t.cm.retained().read(SEEDED_TOPICS.prefsOwn), { marker: 'own-prefs' }, 'a realm cannot publish to the shell prefs topic');
});

test('T23 a response from the wrong realm cannot answer a routed request (control)', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const A2 = t.open(ENTRY_A);
	const B = t.open(ENTRY_B, { raw: true });
	const op = `app.${keyA}.slow`;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	A.bus.handle(op, () => gate.then(() => 'real'));
	await settle();
	const pending = outcome(A2.request(op, {}));
	await settle();
	const hop = A.received.find((m) => (m as { __rrbus?: string; op?: string }).__rrbus === 'request' && (m as { op?: string }).op === op) as { id: string } | undefined;
	assert.ok(hop, 'the request must be routed to the owner');
	B.post({ __rrbus: 'response', id: hop.id, ok: true, result: 'forged' });
	await settle();
	release();
	const result = await pending;
	assert.ok(result.ok && result.value === 'real', `the owner's answer must win, got ${JSON.stringify(result)}`);
});

test('T24 broadcastEmitOp skips gated realms; deliver targets exactly one', async (tt) => {
	const rootBus = createOpBus();
	const router = createGatedBusRouter(rootBus, { retained: createRetainedRegistry() });
	const g1 = createChannel();
	const g2 = createChannel();
	const plain = createChannel();
	tt.after(() => [g1, g2, plain].forEach((c) => c.close()));
	const ctx = (id: string): RealmContext => ({ info: { realmId: id, label: id, appId: ENTRY_A.id, appKey: keyA, moduleId: 'm', viewId: 'v', version: 1, caps: new Set(['core']) }, handlers: createOpBus(), outbound: (m) => m });
	router.addGatedRealm(g1.a, ctx('g1'));
	router.addGatedRealm(g2.a, ctx('g2'));
	router.addRealm(plain.a, 'plain');

	const ops = (c: { received: unknown[] }): string[] => c.received.filter((m) => (m as { __rrbus?: string }).__rrbus === 'emitOp').map((m) => (m as { op: string }).op);
	router.broadcastEmitOp('mirror.event', { x: 1 });
	router.broadcastEmitOp('client.event', { y: 2 });
	await settle();
	assert.deepEqual(ops(plain), ['mirror.event', 'client.event'], 'an ungated realm receives broadcasts');
	assert.deepEqual(ops(g1), [], `a gated realm must receive no broadcast, got ${JSON.stringify(ops(g1))}`);
	assert.deepEqual(ops(g2), [], 'a gated realm must receive no broadcast');

	(router as unknown as { deliver(id: string, op: string, p: unknown): void }).deliver('g1', 'shell.event.connected', {});
	await settle();
	assert.deepEqual(ops(g1), ['shell.event.connected'], 'deliver reaches the targeted realm');
	assert.deepEqual(ops(g2), [], 'deliver reaches no other gated realm');
	assert.equal(ops(plain).length, 2, 'deliver reaches no ungated realm');
});
