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
// ALIAS TESTS — T105 (knownProjects, short ids, project-keyed maps and the N1-L flood case)
// =============================================================================

/// <reference types="node" />


// =============================================================================
// GATED BUS ROUTER — hop accounting between a requester and an owner realm
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatedBusRouter } from './busBridge';
import { createOpBus } from './busOps';
import { WALK_MAX_STRING_CHARS } from '../isolation/walk';
import type { RealmContext, RealmInfo } from '../isolation/types';

const KEY = 'k1';
const OP = `app.${KEY}.work`;

interface ITestRealm {
	received: Array<Record<string, unknown>>;
	send(message: Record<string, unknown>): void;
	detach: () => void;
}

/** One gated realm over a hand-made endpoint; `outbound` lets a test refuse what is posted to it. */
function attach(router: ReturnType<typeof createGatedBusRouter>, id: string, outbound: (m: unknown) => unknown = (m) => m): ITestRealm {
	const received: Array<Record<string, unknown>> = [];
	let listener: ((message: unknown) => void) | null = null;
	const info = { realmId: id, label: `app#${id}`, appId: 'acme.app', appKey: KEY, moduleId: 'm', viewId: id, version: 1, caps: new Set(['core']) } as unknown as RealmInfo;
	const ctx: RealmContext = { info, handlers: createOpBus(), outbound };
	const detach = router.addGatedRealm(
		{
			post: (message) => void received.push(message as Record<string, unknown>),
			subscribe: (cb) => {
				listener = cb;
				return () => {
					listener = null;
				};
			},
		},
		ctx
	);
	return { received, send: (message) => listener?.(message), detach };
}

const timers = (): number => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

test('a requester that detaches releases the hop it started in the owner realm', () => {
	const router = createGatedBusRouter(createOpBus());
	const owner = attach(router, 'owner');
	const requester = attach(router, 'requester');
	owner.send({ __rrbus: 'register', ops: [OP] });
	const before = timers();
	requester.send({ __rrbus: 'request', id: 'r1', op: OP, params: {}, timeoutMs: 100_000 });
	assert.equal(owner.received.filter((m) => m.__rrbus === 'request').length, 1, 'the hop reached the owner');
	assert.equal(timers(), before + 1, 'the hop holds its timeout timer');
	requester.detach();
	assert.equal(timers(), before, 'detaching the requester cancels the hop timer');
	// The owner's late answer to the dropped hop is simply unknown now.
	const hop = owner.received.find((m) => m.__rrbus === 'request')!;
	owner.send({ __rrbus: 'response', id: hop.id, ok: true, result: 'late' });
	owner.detach();
});

test('a routed request the owner realm outbound filter refuses is settled at once, not held to the timeout', () => {
	const router = createGatedBusRouter(createOpBus());
	const owner = attach(router, 'owner', (m) => {
		if ((m as { __rrbus?: string }).__rrbus === 'request') throw new Error('outbound refused');
		return m;
	});
	const requester = attach(router, 'requester');
	owner.send({ __rrbus: 'register', ops: [OP] });
	const before = timers();
	requester.send({ __rrbus: 'request', id: 'r1', op: OP, params: {}, timeoutMs: 100_000 });
	assert.equal(timers(), before, 'no hop timer is left running');
	const answer = requester.received.find((m) => m.__rrbus === 'response' && m.id === 'r1');
	assert.ok(answer && answer.ok === false, 'the requester got an answer instead of waiting 100 s');
	// The in-flight slot was released: a second burst is not stuck behind the refused ones.
	for (let i = 0; i < 40; i++) requester.send({ __rrbus: 'request', id: `b${i}`, op: OP, params: {}, timeoutMs: 100_000 });
	const answered = requester.received.filter((m) => m.__rrbus === 'response' && String(m.id).startsWith('b')).length;
	assert.equal(answered, 40, 'every refused request was answered (none held an in-flight slot)');
	requester.detach();
	owner.detach();
});

test('a request value over the walker size budget is refused as too_large, not schema', () => {
	const router = createGatedBusRouter(createOpBus());
	const owner = attach(router, 'owner');
	const requester = attach(router, 'requester');
	owner.send({ __rrbus: 'register', ops: [OP] });
	requester.send({ __rrbus: 'request', id: 'big', op: OP, params: { text: 'x'.repeat(WALK_MAX_STRING_CHARS + 1) }, timeoutMs: 1000 });
	const answer = requester.received.find((m) => m.__rrbus === 'response' && m.id === 'big');
	assert.ok(answer && answer.ok === false, 'refused');
	assert.match(String(answer.error), /too_large/, `got ${String(answer.error)}`);
	requester.send({ __rrbus: 'request', id: 'bad', op: OP, params: { f: () => 1 }, timeoutMs: 1000 });
	const bad = requester.received.find((m) => m.__rrbus === 'response' && m.id === 'bad');
	assert.match(String(bad?.error), /schema/, 'a bad shape stays schema');
	requester.detach();
	owner.detach();
});
