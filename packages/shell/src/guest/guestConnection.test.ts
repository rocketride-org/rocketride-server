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
// GUEST ConnectionManager — T58 (plan section 4.8), T70, part of T109
// =============================================================================
//
// Seams pinned here (plan sections 3.3 and 4.8):
//   * `src/isolation/guestFlag.ts`: `markGuestRealm()` / `isGuestRealm()`, a leaf
//     module. Set before the ConnectionManager is constructed.
//   * `ConnectionManager.enterGuestMode(init: BridgeInit)`.
//   * The private constructor calls `installMirrorSubscriptions()` only when
//     `!isGuestRealm()`; in the guest nothing is subscribed on the retained lane.
//
// The whole file runs as one guest realm (one process, the flag set once).
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { CapabilityDeniedError } from '../isolation/capabilityDenied';
import { ConnectionManager } from '../connection/connection';
import { RocketRideClientProxy } from '../connection/RocketRideClientProxy';
import { CLIENT_EVENT_OP } from '../ops/clientOps';
import { attachRealmToRoot } from '../ops/busBridge';
import type { IRetainedPort } from '../ops/retained';
import type { BridgeInit } from '../isolation/types';
import { ENTRY_A, GRANT_A, makeRoot } from '../isolation/__test__/fixtures';
import { createChannel, settle } from '../isolation/__test__/realm';

const USER = 'ru_AAAAAAAAAAAAAAAAAAAAAA';
const ORG = 'ro_BBBBBBBBBBBBBBBBBBBBBB';

function init(over: Partial<BridgeInit> = {}): BridgeInit {
	return {
		type: 'rr:bridge:init',
		proto: 1,
		entryPrefix: '/_t/tok/v1/',
		expiresAt: 1_700_000_900_000,
		theme: { '--rr-bg': '#000' },
		identity: { userId: USER, displayName: 'Ada', organizations: [{ id: ORG, name: 'Acme' }] },
		props: { isConnected: true, activeView: 'v1', activeActivity: null, sidePanelOpen: false, theme: 'dark' },
		capabilities: ['core'],
		appId: 'acme.alpha',
		appKey: 'a' + 'q'.repeat(24),
		moduleId: 'acme_alpha',
		viewId: 'v1',
		engineHttpUrl: 'http://localhost:5565',
		...over,
	};
}

type Guest = ConnectionManager & { enterGuestMode(i: BridgeInit): void };

/** A guest manager: the flag first (as `boot.ts` does), then a fresh private construction. */
async function guest(): Promise<Guest> {
	const flag = await import('../isolation/guestFlag');
	flag.markGuestRealm();
	assert.equal(flag.isGuestRealm(), true);
	return Reflect.construct(ConnectionManager, []) as Guest;
}

function enter(cm: Guest, i: BridgeInit): void {
	assert.equal(typeof cm.enterGuestMode, 'function', 'ConnectionManager.enterGuestMode does not exist yet (PR2b)');
	cm.enterGuestMode(i);
}

test('T58 the guest constructor subscribes to nothing on the retained lane (no denied topic is ever requested)', async () => {
	const cm = await guest();
	const topics: string[] = [];
	const port: IRetainedPort = {
		publish() {},
		signal() {},
		subscribe: (topic) => {
			topics.push(topic);
			return () => {};
		},
		read: async () => undefined,
	};
	cm.setRetainedPort(port);
	for (const denied of ['shell:status', 'shell:account', 'shell:services', 'shell:telemetry']) assert.ok(!topics.includes(denied), `${denied} must not be subscribed in a guest`);
	for (const topic of topics) assert.ok(topic === 'host:connection' || topic.startsWith('shell:prefs:app:'), `only the topics a gated realm may read: got ${topic}`);
});

test('T58 enterGuestMode seeds connected, the HTTP base and the identity, without a client or a credential', async () => {
	const cm = await guest();
	enter(cm, init());
	assert.equal(cm.isConnected(), true);
	assert.equal(cm.getHttpUrl(), 'http://localhost:5565');
	const info = cm.getAccountInfo() as Record<string, unknown> | undefined;
	assert.ok(info, 'the identity projection is the account info');
	assert.equal(info.userId, USER);
	assert.equal(info.displayName, 'Ada');
	assert.deepEqual(info.organization && { id: (info.organization as { id: string }).id }, { id: ORG });
	assert.ok(!info.userToken, 'no session token');
	assert.ok(!('apiKey' in info) && !('keys' in info));
	assert.ok(!info.apps || (info.apps as unknown[]).length === 0, 'no app list');
	assert.ok(cm.getClient() instanceof RocketRideClientProxy, 'the brokered client, never a socket client');
	assert.equal(Reflect.get(cm, 'client'), null, 'the guest creates no RocketRideClient');
});

test('T58 an anonymous init (identity null) leaves no account info', async () => {
	const cm = await guest();
	enter(cm, init({ identity: null, props: { isConnected: false, activeView: 'v', activeActivity: null, sidePanelOpen: false, theme: 'dark' } }));
	assert.equal(cm.isConnected(), false);
	assert.equal(cm.getAccountInfo(), undefined);
});

test('T58 client.event is delivered to the brokered client at once (the handler is registered with the client)', async () => {
	const cm = await guest();
	const received: unknown[] = [];
	mock.method(RocketRideClientProxy.prototype, 'receiveEvent', async (message: unknown) => void received.push(message));
	enter(cm, init());
	const message = { type: 'event', event: 'apaevt_flow', seq: 1, body: { project_id: 'rp_x' } };
	cm.ops().emitOp(CLIENT_EVENT_OP, { message });
	await settle();
	assert.deepEqual(received, [message]);
	mock.restoreAll();
});

test('T58 the shell.event.* ops update the mirror state and re-emit as the local shell:* events', async () => {
	const cm = await guest();
	enter(cm, init());
	const seen: Array<[string, unknown]> = [];
	for (const e of ['shell:connected', 'shell:disconnected', 'shell:statusChange', 'shell:themeChange', 'shell:viewActivated']) cm.on(e as never, ((p: unknown) => void seen.push([e, p])) as never);
	// emitOp handlers run on a microtask (busOps.ts), as the root's deliveries always do: settle after each.
	cm.ops().emitOp('shell.event.disconnected', { reason: 'root disconnected', hasError: false });
	await settle();
	assert.equal(cm.isConnected(), false);
	cm.ops().emitOp('shell.event.connected', {});
	await settle();
	assert.equal(cm.isConnected(), true);
	cm.ops().emitOp('shell.event.statusChange', { state: 'connected', connectionMode: 'cloud', authPhase: 'signed_in' });
	await settle();
	cm.ops().emitOp('shell.event.themeChange', { tokens: { '--rr-bg': '#fff' } });
	await settle();
	cm.ops().emitOp('shell.event.viewActivated', { viewId: 'v1' });
	await settle();
	const names = seen.map(([e]) => e);
	assert.deepEqual(names, ['shell:disconnected', 'shell:connected', 'shell:statusChange', 'shell:themeChange', 'shell:viewActivated']);
	assert.deepEqual(seen[0][1], { reason: 'root disconnected', hasError: false });
	assert.deepEqual(seen[3][1], { tokens: { '--rr-bg': '#fff' } });
	assert.deepEqual(seen[4][1], { viewId: 'v1' });
	const status = seen[2][1] as { state?: unknown; connectionMode?: unknown };
	assert.equal(status.state, 'connected', 'the guest emits a full ConnectionStatus');
	assert.equal(status.connectionMode, 'cloud');
	assert.equal(cm.getConnectionStatus().connectionMode, 'cloud', 'and keeps it');
});

test('T58 getCachedServices and refreshServices give the plan value with no request', async () => {
	const cm = await guest();
	enter(cm, init());
	const requests: string[] = [];
	mock.method(cm, 'request', (async (op: string) => void requests.push(op)) as never);
	assert.deepEqual(cm.getCachedServices(), { services: {}, servicesError: 'Not available in isolated apps' });
	const updates: unknown[] = [];
	cm.on('shell:servicesUpdated' as never, ((p: unknown) => void updates.push(p)) as never);
	await cm.refreshServices();
	assert.deepEqual(updates, [{ services: {}, servicesError: 'Not available in isolated apps' }]);
	assert.deepEqual(requests, [], 'no request was sent');
	mock.restoreAll();
});

test('T70 the guest rehydrates a denied request as CapabilityDeniedError: bus ops and the brokered client alike', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const cm = await guest();
	// Wire the guest manager to a real gated root over a real structured-clone channel.
	const channel = createChannel();
	t.root.attach(ENTRY_A, channel.a, { frame: GRANT_A.frame, capabilities: ['core'], viewId: 'v1', version: 1 });
	const attachment = attachRealmToRoot(cm.ops(), channel.b);
	cm.setRetainedPort(attachment.retained);
	enter(cm, init());
	tt.after(() => {
		attachment.detach();
		channel.close();
	});

	await assert.rejects(
		cm.request('explorer.list', {}),
		(err: unknown) => err instanceof CapabilityDeniedError && err.code === 'unknown_op',
		'a denied bus op is a CapabilityDeniedError, not an "RR_DENIED:" Error'
	);
	await assert.rejects(
		cm.getClient()!.request({ type: 'request', seq: 1, command: 'rrext_services', arguments: {} } as never),
		(err: unknown) => err instanceof CapabilityDeniedError && typeof err.code === 'string',
		'a denied client.request is one too (the services call the SDK sends through the proxy is denied)'
	);
});
