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

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationException, DAPException } from 'rocketride';
import type { DAPMessage } from 'rocketride';
import { RocketRideClientProxy } from './RocketRideClientProxy';
import type { IProxyTransport } from './RocketRideClientProxy';
import { captureEnvelope } from './errorWire';
import { registerShellHostOps } from '../ops/hostOps';
import { createOpBus } from '../ops/busOps';
import { decodeMessageData, encodeMessageData } from './binaryWire';

/**
 * A root that serves `client.request` from a plain function standing in for
 * the server, with the SAME framing the real root applies — and crossing a
 * JSON hop in between, which is what a VS Code webview does to every payload.
 *
 * The JSON round trip is the point of the fixture: an in-process stub would
 * pass Errors and typed arrays by reference, and every assertion below would
 * hold while the bridged host stayed broken.
 *
 * `serve` returns the RESPONSE BODY for a successful call, or throws to stand
 * in for a transport-level failure.
 */
function rootServing(serve: (message: DAPMessage) => unknown): { transport: IProxyTransport; seen: DAPMessage[] } {
	const seen: DAPMessage[] = [];
	const transport: IProxyTransport = {
		async request(op, params) {
			assert.equal(op, 'client.request');
			const wire = JSON.parse(JSON.stringify(params)) as { message: DAPMessage; timeout?: number };
			const message = decodeMessageData(wire.message);
			seen.push(message);
			const envelope = await captureEnvelope(() => {
				const body = serve(message);
				// A DAP response as the server shapes it; `call()` reads
				// `success` and `body`, `fsRead` reads `arguments.data`.
				const response: DAPMessage = { type: 'response', seq: 1, success: true, ...(body as object) };
				return encodeMessageData(response);
			});
			return JSON.parse(JSON.stringify(envelope));
		},
	};
	return { transport, seen };
}

void test('a realm call reaches the root and its body comes back', async () => {
	const { transport, seen } = rootServing((m) => ({ body: { echoed: m.command, got: m.arguments?.name } }));
	const client = new RocketRideClientProxy(transport);

	const body = await client.call('rrext_account_me', { name: 'rod' });

	assert.deepEqual(body, { echoed: 'rrext_account_me', got: 'rod' });
	assert.equal(seen[0].command, 'rrext_account_me');
	assert.deepEqual(seen[0].arguments?.name, 'rod');
});

void test('a namespace method the proxy never overrode still works', async () => {
	// The whole reason for overriding the transport rather than listing
	// methods: `account.getProfile()` is SDK code the proxy never heard of.
	const { transport, seen } = rootServing(() => ({ body: { user: { id: 'u1' } } }));
	const client = new RocketRideClientProxy(transport);

	await client.account.getProfile();

	assert.equal(seen.length, 1);
	assert.match(String(seen[0].command), /^rrext_/);
});

void test('a server-reported failure throws locally, from the SDK’s own code', async () => {
	// `call()` checks `success === false` and throws — in the REALM, because
	// the override sits beneath it. Nothing had to be taught to do this.
	const { transport } = rootServing(() => ({ success: false, message: 'no such pipeline' }));
	const client = new RocketRideClientProxy(transport);

	await assert.rejects(() => client.call('rrext_get_pipeline'), /no such pipeline/);
});

void test('an exception keeps its class across a JSON hop', async () => {
	const { transport } = rootServing(() => {
		throw new AuthenticationException({ message: 'Session expired', code: 'AUTH_EXPIRED' } as never);
	});
	const client = new RocketRideClientProxy(transport);

	await assert.rejects(
		() => client.call('rrext_account_me'),
		(err: unknown) => {
			// Each assertion is a DIFFERENT thing app code does with the
			// error, and a plain structured clone would fail all three.
			assert.ok(err instanceof AuthenticationException, 'subclass identity');
			assert.ok(err instanceof DAPException, 'the hierarchy above it');
			assert.equal((err as { code?: string }).code, 'AUTH_EXPIRED', 'the field apps classify on');
			return true;
		}
	);
});

void test('an unrecognised error class degrades to Error with its name kept', async () => {
	class SomeFutureException extends Error {
		constructor() {
			super('from a newer SDK');
			this.name = 'SomeFutureException';
		}
	}
	const { transport } = rootServing(() => {
		throw new SomeFutureException();
	});
	const client = new RocketRideClientProxy(transport);

	await assert.rejects(
		() => client.call('rrext_whatever'),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.equal((err as Error).name, 'SomeFutureException');
			assert.equal((err as Error).message, 'from a newer SDK');
			return true;
		}
	);
});

void test('a file WRITE carries its bytes to the root intact', async () => {
	// `fsWrite` puts a Uint8Array in `arguments.data` (client.ts:2553), the
	// one member the protocol allows it in. Unframed, JSON turns it into
	// {"0":104,…} and the server stores garbage — silently.
	const payload = new Uint8Array([104, 105, 0, 255]);
	const { transport, seen } = rootServing(() => ({ body: { bytesWritten: 4 } }));
	const client = new RocketRideClientProxy(transport);

	const written = await client.fsWrite('handle-1', payload);

	assert.equal(written, 4);
	assert.ok(seen[0].arguments?.data instanceof Uint8Array, 'bytes, not an index-keyed object');
	assert.deepEqual(Array.from(seen[0].arguments?.data as Uint8Array), [104, 105, 0, 255]);
	assert.equal(seen[0].arguments?.handle, 'handle-1', 'the rest of the message is untouched');
});

void test('a file READ brings its bytes back from the root intact', async () => {
	// `fsRead` bypasses call() precisely because the bytes come back in
	// `response.arguments.data` rather than the body (client.ts:2529) — so
	// the return leg needs the same framing as the send leg.
	const { transport } = rootServing(() => ({ arguments: { data: new Uint8Array([1, 2, 253, 254]) } }));
	const client = new RocketRideClientProxy(transport);

	const bytes = await client.fsRead('handle-1');

	assert.ok(bytes instanceof Uint8Array, 'bytes, not an index-keyed object');
	assert.deepEqual(Array.from(bytes), [1, 2, 253, 254]);
});

void test('a non-binary `data` member is left exactly as it was', async () => {
	// A string and a plain object are both legal in the member and both
	// JSON-safe; the transport has its own handling for each
	// (TransportWebSocket.ts:589-595). Framing them would be a lie about
	// what the caller passed.
	const { transport, seen } = rootServing(() => ({ body: {} }));
	const client = new RocketRideClientProxy(transport);

	await client.call('rrext_process', { data: 'plain text' });
	await client.call('rrext_process', { data: { nested: 1 } });

	assert.equal(seen[0].arguments?.data, 'plain text');
	assert.deepEqual(seen[1].arguments?.data, { nested: 1 });
});

void test('an explicit SDK timeout outlasts itself on the bus', async () => {
	// Reversed, the bus expires first and the caller is told the bus timed
	// out rather than what the engine was doing.
	let saw: number | undefined;
	const transport: IProxyTransport = {
		async request(_op, _params, timeoutMs) {
			saw = timeoutMs;
			return { ok: true, value: { type: 'response', seq: 1, success: true, body: {} } };
		},
	};
	const client = new RocketRideClientProxy(transport);

	await client.call('rrext_slow', undefined, { timeout: 30_000 });

	assert.ok(saw !== undefined && saw > 30_000, `bus timeout ${String(saw)} must exceed the SDK's 30000`);
});

void test('the shared socket cannot be driven from a realm', async () => {
	const { transport } = rootServing(() => null);
	const client = new RocketRideClientProxy(transport);

	// Synchronous throws, so assert.throws — not rejects.
	for (const run of [() => client.connect(), () => client.disconnect(), () => client.ping(), () => client.identify('x')]) {
		assert.throws(run, /only in the root realm/);
	}
});

void test('getApiKey names the hook that replaces it', async () => {
	const { transport } = rootServing(() => null);
	const client = new RocketRideClientProxy(transport);

	assert.throws(() => client.getApiKey(), /useShellApiKey/);
});

void test('only the SSE argument is refused, not the whole pipe', async () => {
	const { transport } = rootServing(() => ({ body: {} }));
	const client = new RocketRideClientProxy(transport);

	// Engine EVENTS are dispatched by the root's client into its own
	// `_ssePipeCallbacks` map, so a realm's callback would never fire —
	// better to say so than to accept it and go quiet.
	assert.throws(() => client.pipe('t1', {}, undefined, undefined, async () => {}), /only in the root realm/);
	assert.throws(() => client.send('t1', 'data', {}, undefined, async () => {}), /only in the root realm/);

	// Without a callback it is plain request/response, and works.
	await assert.doesNotReject(() => client.pipe('t1'));
});

void test('the credential op answers from the root, including a legitimate "none"', async () => {
	// Null is an ANSWER (token auth holds no key), not a failure — a caller
	// that cannot tell those apart silently takes the unauthenticated path.
	const bus = createOpBus();
	registerShellHostOps(bus, { getClient: () => ({ getApiKey: () => 'rr_secret' }) });
	assert.deepEqual(await bus.request('host.apiKey', {}), { apiKey: 'rr_secret' });

	const empty = createOpBus();
	registerShellHostOps(empty, { getClient: () => null });
	assert.deepEqual(await empty.request('host.apiKey', {}), { apiKey: null });
});

void test('a host that keeps the key elsewhere wins over the shell default', async () => {
	// VS Code holds the credential in its ConfigManager, not the client.
	// Specific-before-shared is the bus's composition rule.
	const bus = createOpBus();
	bus.handle('host.apiKey', () => ({ apiKey: 'from-the-extension-host' }));
	registerShellHostOps(bus, { getClient: () => ({ getApiKey: () => 'from-the-client' }) });

	assert.deepEqual(await bus.request('host.apiKey', {}), { apiKey: 'from-the-extension-host' });
});

void test('an engine event pushed from the root dispatches in the realm', async () => {
	// The counter-flow: nothing requested this, so no request op could carry
	// it. Going through the SDK's own onEvent means everything hanging off an
	// event works locally without being re-implemented.
	const received: DAPMessage[] = [];
	const { transport } = rootServing(() => ({ body: {} }));
	const client = new RocketRideClientProxy(transport, { onEvent: async (m) => void received.push(m) });

	// Crosses a JSON hop, exactly as the broadcast does.
	const wire = JSON.parse(JSON.stringify({ type: 'event', seq: 9, event: 'apaevt_status', body: { pct: 50 } })) as DAPMessage;
	await client.receiveEvent(wire);

	assert.equal(received.length, 1);
	assert.equal(received[0].event, 'apaevt_status');
	assert.deepEqual(received[0].body, { pct: 50 });
});

void test('an account refresh event updates the realm client’s own accessors', async () => {
	// `onEvent` caches apaext_account into _connectResult — SDK code, running
	// locally, so getOrgId() moves without the mirror having to say anything.
	const { transport } = rootServing(() => ({ body: {} }));
	const client = new RocketRideClientProxy(transport);
	client.applyIdentity({ connected: true, accountInfo: { organization: { id: 'org-old' } } as never });
	assert.equal(client.getOrgId(), 'org-old');

	await client.receiveEvent({ type: 'event', seq: 1, event: 'apaext_account', body: { organization: { id: 'org-new' } } } as DAPMessage);

	assert.equal(client.getOrgId(), 'org-new');
});

void test('monitors are forwarded to the root, never run locally', async () => {
	// `_monitorKeys` is a PER-INSTANCE refcount map feeding _syncMonitor with
	// a merged type list — run locally, the last realm to sync would cancel
	// every other realm's subscription.
	const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
	const transport: IProxyTransport = {
		async request(op, params) {
			calls.push({ op, params });
			return { ok: true, value: { type: 'response', seq: 1, success: true, body: {} } };
		},
	};
	const client = new RocketRideClientProxy(transport);

	await client.addMonitor({ token: 'tok-1' }, ['apaevt_status']);
	await client.removeMonitor({ token: 'tok-1' }, ['apaevt_status']);

	assert.deepEqual(calls.map((c) => c.op), ['client.addMonitor', 'client.removeMonitor']);
	assert.deepEqual(calls[0].params, { key: { token: 'tok-1' }, types: ['apaevt_status'] });

	// Unscoped teardown would drop OTHER realms' subscriptions too.
	assert.throws(() => client.clearAllMonitors(), /only in the root realm/);
});
