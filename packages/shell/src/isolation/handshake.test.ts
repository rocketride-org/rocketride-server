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
// HANDSHAKE TESTS — T51 (the parent-side state machine, PR2b)
// =============================================================================
//
// Seam pinned here (plan section 3.3 `handshake.ts`, "pure state machine:
// `onWindowMessage`, `onFrameLoad` (every `load` after the first detaches),
// `onPortClosed`"):
//
//   createHandshake(deps: IHandshakeDeps): IHandshake
//
//   IHandshake.onWindowMessage(ev: { source, origin, data })
//   IHandshake.onFrameLoad()
//   IHandshake.onPortClosed()
//   IHandshake.state(): 'waiting' | 'attached' | 'detached'
//
//   IHandshakeDeps = {
//     origin: string;                          // the app origin the frame must come from
//     isFrameSource(source): boolean;          // e.source === iframe.contentWindow
//     now(): number;                           // ms
//     admit(range: {protoMin, protoMax}): { init: BridgeInit; port: unknown };
//                                              // attach the realm + build the init
//                                              // through the choke point; throws on denial
//     post(init, targetOrigin: string, transfer: unknown[]): void;
//     detach(reason: HandshakeDetachReason): void;
//   }
//
// Nothing here touches a DOM: the machine is driven by plain objects.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

const ORIGIN = 'http://a1234567890123456789012345.apps.localhost:5565';
const FRAME = { frame: true };
const PORT = { port: 2 };

/** The module is loaded per test so a missing module fails the test, not the file. */
async function load(): Promise<typeof import('./handshake')> {
	return await import('./handshake');
}

interface IRig {
	hs: import('./handshake').IHandshake;
	admits: Array<{ protoMin: number; protoMax: number }>;
	posts: Array<{ init: unknown; targetOrigin: string; transfer: unknown[] }>;
	detaches: string[];
	clock: { t: number };
	ready(extra?: Partial<{ source: unknown; origin: string; data: unknown }>): void;
}

async function rig(opts: { admitThrows?: boolean } = {}): Promise<IRig> {
	const { createHandshake } = await load();
	const admits: IRig['admits'] = [];
	const posts: IRig['posts'] = [];
	const detaches: string[] = [];
	const clock = { t: 1_000_000 };
	const init = { type: 'rr:bridge:init', proto: 1 };
	const hs = createHandshake({
		origin: ORIGIN,
		isFrameSource: (s: unknown) => s === FRAME,
		now: () => clock.t,
		admit: (range: { protoMin: number; protoMax: number }) => {
			admits.push(range);
			if (opts.admitThrows) throw new Error('credential');
			return { init: init as never, port: PORT };
		},
		post: (i: unknown, targetOrigin: string, transfer: unknown[]) => void posts.push({ init: i, targetOrigin, transfer }),
		detach: (reason: string) => void detaches.push(reason),
	} as never);
	return {
		hs,
		admits,
		posts,
		detaches,
		clock,
		ready: (extra = {}) => hs.onWindowMessage({ source: FRAME, origin: ORIGIN, data: { type: 'rr:frame:ready', protoMin: 1, protoMax: 1 }, ...extra } as never),
	};
}

test('T51 a ready from the frame window at the app origin attaches once and posts the init to exactly that origin with the port transferred', async () => {
	const r = await rig();
	assert.equal(r.hs.state(), 'waiting');
	r.ready();
	assert.deepEqual(r.admits, [{ protoMin: 1, protoMax: 1 }]);
	assert.equal(r.posts.length, 1);
	assert.equal(r.posts[0].targetOrigin, ORIGIN, 'never "*"');
	assert.deepEqual(r.posts[0].transfer, [PORT], 'the guest port rides along, nothing else');
	assert.equal(r.hs.state(), 'attached');
	assert.deepEqual(r.detaches, []);
});

test('T51 a ready from another window, another origin or with a bad shape is ignored and attaches nothing', async () => {
	const r = await rig();
	const bad: Array<Partial<{ source: unknown; origin: string; data: unknown }>> = [{ source: { frame: false } }, { source: null }, { origin: 'http://evil.example' }, { origin: 'null' }, { origin: '' }, { origin: `${ORIGIN}.evil.example` }, { origin: ORIGIN.replace('http:', 'https:') }, { origin: `${ORIGIN}/` }, { data: null }, { data: 'rr:frame:ready' }, { data: { type: 'rr:frame:ready' } }, { data: { type: 'rr:frame:ready', protoMin: '1', protoMax: 1 } }, { data: { type: 'rr:frame:ready', protoMin: 0, protoMax: 1 } }, { data: { type: 'rr:frame:ready', protoMin: 2, protoMax: 1 } }, { data: { type: 'rr:frame:ready', protoMin: 1.5, protoMax: 2 } }, { data: { type: 'rr:bridge:init', protoMin: 1, protoMax: 1 } }];
	for (const extra of bad) r.ready(extra);
	assert.deepEqual(r.admits, [], 'nothing was admitted');
	assert.deepEqual(r.posts, []);
	assert.equal(r.hs.state(), 'waiting', "a stranger cannot spoil the real frame's handshake");
	// Messages from the right window and origin count against the 5-per-minute budget even when malformed.
	r.clock.t += 61_000;
	r.ready();
	assert.equal(r.posts.length, 1, 'and the real ready still works afterwards');
});

test('T51 a protocol range that does not include 1 is not attached', async () => {
	const r = await rig();
	r.ready({ data: { type: 'rr:frame:ready', protoMin: 2, protoMax: 3 } });
	assert.deepEqual(r.admits, []);
	assert.deepEqual(r.posts, []);
});

test('T51 at most 5 readies per minute are looked at; the window slides', async () => {
	const r = await rig();
	// Five readies that are ignored for another reason still count against the budget.
	for (let i = 0; i < 5; i++) r.ready({ data: { type: 'rr:frame:ready', protoMin: 2, protoMax: 3 } });
	r.ready();
	assert.deepEqual(r.admits, [], 'the 6th ready inside one minute is refused unread');
	r.clock.t += 61_000;
	r.ready();
	assert.equal(r.posts.length, 1, 'a minute later a ready is looked at again');
});

test('T51 a second ready after attach detaches (and never posts a second init)', async () => {
	const r = await rig();
	r.ready();
	r.ready();
	assert.equal(r.posts.length, 1);
	assert.deepEqual(r.detaches, ['second-ready']);
	assert.equal(r.hs.state(), 'detached');
});

test('T51 every load after the first detaches; the first is the frame the machine was made for', async () => {
	const r = await rig();
	r.hs.onFrameLoad();
	assert.deepEqual(r.detaches, [], 'the first load is the guest document itself');
	r.ready();
	r.hs.onFrameLoad();
	assert.deepEqual(r.detaches, ['reload'], 'a navigation inside the frame ends the realm');
	assert.equal(r.hs.state(), 'detached');
});

test('T51 a closed port detaches, and detaching is idempotent', async () => {
	const r = await rig();
	r.ready();
	r.hs.onPortClosed();
	r.hs.onPortClosed();
	r.hs.onFrameLoad();
	r.hs.onFrameLoad();
	assert.deepEqual(r.detaches, ['port-closed'], 'one detach, whatever follows');
});

test('T51 once detached nothing re-attaches: a Reload builds a new machine (a fresh /apps/frame grant)', async () => {
	const r = await rig();
	r.ready();
	r.hs.onPortClosed();
	const admitted = r.admits.length;
	r.ready();
	assert.equal(r.admits.length, admitted, 'a ready after a detach is ignored');
	assert.equal(r.posts.length, 1);
});

test('T51 an init the choke point refuses is not posted: the realm is detached', async () => {
	const r = await rig({ admitThrows: true });
	r.ready();
	assert.deepEqual(r.posts, [], 'nothing reached the frame');
	assert.deepEqual(r.detaches, ['denied']);
	assert.equal(r.hs.state(), 'detached');
});

test('T51 a throwing post detaches rather than leaving an attached realm no frame can reach', async () => {
	const { createHandshake } = await load();
	const detaches: string[] = [];
	const hs = createHandshake({
		origin: ORIGIN,
		isFrameSource: (s: unknown) => s === FRAME,
		now: () => 1,
		admit: () => ({ init: {} as never, port: PORT }),
		post: () => {
			throw new Error('detached window');
		},
		detach: (reason: string) => void detaches.push(reason),
	} as never);
	hs.onWindowMessage({ source: FRAME, origin: ORIGIN, data: { type: 'rr:frame:ready', protoMin: 1, protoMax: 1 } } as never);
	assert.deepEqual(detaches, ['denied']);
});
