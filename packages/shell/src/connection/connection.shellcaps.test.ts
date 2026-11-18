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
// T109 (M3) — every `auth` carries shellCaps, including after a persisted reconnect
// =============================================================================
//
// Plan section 3.3 (`connection.ts`): `initialize` adds `shellCaps: SHELL_CAPS`
// to the `RocketRideClient` config, so every `auth` carries it and the server
// stores it (`task_conn.py:417`). Without it `wire_view` strips
// `registryVersion` from isolated entries after sign-in and the entry is
// dropped. The test drives the REAL SDK client over a fake WebSocket and reads
// the `auth` request's arguments, so it holds whatever field the SDK keeps the
// caps in.
//
// ENVIRONMENT NOTE: `rocketride` resolves to the SDK source checkout of the
// workspace the tests run in. The SDK half of M3 (`RocketRideClientConfig.
// shellCaps`, `DAPClient`, `authArguments`) lives in `packages/client-
// typescript`: this test can only go green with that change linked in.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { ConnectionManager } from './connection';

interface ISent {
	socket: FakeSocket;
	message: { command?: string; seq?: number; arguments?: Record<string, unknown> };
}

class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeSocket[] = [];
	static sent: ISent[] = [];
	readonly url: string;
	readyState = 0;
	binaryType = '';
	onopen: ((e: unknown) => unknown) | null = null;
	onmessage: ((e: { data: string }) => unknown) | null = null;
	onclose: ((e: unknown) => unknown) | null = null;
	onerror: ((e: unknown) => unknown) | null = null;
	constructor(url: string) {
		this.url = url;
		FakeSocket.instances.push(this);
		queueMicrotask(() => this.open());
	}
	open(): void {
		this.readyState = 1;
		void this.onopen?.({});
	}
	send(data: string): void {
		const message = JSON.parse(data) as ISent['message'];
		FakeSocket.sent.push({ socket: this, message });
		if (message.command === 'auth') this.respond(message, { userToken: 'rr_t', userId: 'u1', displayName: 'U', organization: null, apps: [], capabilities: [] });
		else this.respond(message, {});
	}
	respond(request: ISent['message'], body: Record<string, unknown>): void {
		const response = { type: 'response', seq: 10_000 + (request.seq ?? 0), request_seq: request.seq, command: request.command, success: true, body };
		queueMicrotask(() => void this.onmessage?.({ data: JSON.stringify(response) }));
	}
	close(): void {
		this.serverClose();
	}
	serverClose(code = 1006): void {
		this.readyState = 3;
		void this.onclose?.({ code, reason: '', wasClean: false });
	}
}

const saved: Record<string, PropertyDescriptor | undefined> = {};

function stage(): void {
	for (const name of ['window', 'WebSocket', 'localStorage', 'sessionStorage']) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
	const store = new Map<string, string>();
	const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 };
	Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { WebSocket: FakeSocket, location: { origin: 'http://engine.test', search: '', hash: '', pathname: '/', href: 'http://engine.test/' }, addEventListener() {}, removeEventListener() {}, localStorage: storage, sessionStorage: storage, self: {}, top: {} } });
	Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeSocket });
	Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
	Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: storage });
	FakeSocket.instances = [];
	FakeSocket.sent = [];
}

afterEach(() => {
	for (const [name, descriptor] of Object.entries(saved)) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

const authRequests = (): ISent[] => FakeSocket.sent.filter((s) => s.message.command === 'auth');

async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

test('T109 after initialize, the auth request carries shellCaps: [appIsolation:1]', async () => {
	stage();
	const cm = Reflect.construct(ConnectionManager, []) as ConnectionManager;
	cm.initialize({ uri: 'http://engine.test' } as never);
	const connecting = cm.connect('rr_key').catch(() => null);
	await until(() => authRequests().length >= 1, 'the auth request');
	const args = authRequests()[0].message.arguments ?? {};
	assert.deepEqual(args.shellCaps, ['appIsolation:1']);
	assert.equal(args.auth, 'rr_key');
	await connecting;
});

test('T109 after a persisted reconnect the NEW auth carries shellCaps again (wire_view keeps registryVersion)', async () => {
	stage();
	const cm = Reflect.construct(ConnectionManager, []) as ConnectionManager;
	cm.initialize({ uri: 'http://engine.test' } as never);
	await cm.connect('rr_key').catch(() => null);
	await until(() => authRequests().length >= 1, 'the first auth');
	FakeSocket.instances[0].serverClose(1006);
	await until(() => authRequests().length >= 2, 'the reconnect auth', 8000);
	for (const [i, req] of authRequests().entries()) assert.deepEqual(req.message.arguments?.shellCaps, ['appIsolation:1'], `auth #${i + 1}`);
});

test('T109 the guest realm never constructs a client: it never reaches the SDK constructor or the socket', async () => {
	stage();
	const flag = await import('../isolation/guestFlag');
	flag.markGuestRealm();
	const cm = Reflect.construct(ConnectionManager, []) as unknown as { enterGuestMode(i: unknown): void; getClient(): unknown };
	assert.equal(typeof cm.enterGuestMode, 'function', 'ConnectionManager.enterGuestMode does not exist yet (PR2b)');
	cm.enterGuestMode({
		type: 'rr:bridge:init',
		proto: 1,
		entryPrefix: '/_t/x/v1/',
		expiresAt: 1,
		theme: {},
		identity: null,
		props: { isConnected: true, activeView: 'v', activeActivity: null, sidePanelOpen: false, theme: 'dark' },
		capabilities: ['core'],
		appId: 'acme.a',
		appKey: 'a' + 'q'.repeat(24),
		moduleId: 'acme_a',
		viewId: 'v',
		engineHttpUrl: 'http://engine.test',
	});
	assert.equal(Reflect.get(cm, 'client'), null);
	assert.deepEqual(FakeSocket.instances, [], 'no socket was ever opened');
});
