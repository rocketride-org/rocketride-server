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
// GUEST INIT — T54 (acceptance) and the guest half of T55 (refresh)
// =============================================================================
//
// Seams pinned here (plan section 3.4 `guest/index.ts`, section 4.1):
//
//   src/guest/acceptInit.ts
//     parseShellOrigins(content: string | null | undefined) -> string[]
//         the `<meta name="rr-shell-origins">` value: http(s) origins only, space
//         or comma separated; anything else is dropped (no origin = nothing accepted).
//     readyMessages(origins: string[]) -> Array<{ targetOrigin: string; message }>
//         one `rr:frame:ready {protoMin: 1, protoMax: 1}` per shell origin,
//         each with THAT origin as targetOrigin (never '*').
//     createInitAcceptor({ origins, parent }) -> { accept(ev) -> { init, port } | null }
//         ev = { source, origin, data, ports }. Exactly ONE init is ever accepted.
//
//   src/guest/refresh.ts
//     startFrameRefresh({ expiresAt, now, request, setTimer, clearTimer, apply, failed })
//         -> { stop() }
//         ONE `shell.frameToken.refresh` 120 s before `expiresAt`; the root
//         retries, so the guest never retries or backs off itself.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { BridgeInit } from '../isolation/types';

const SHELL = 'https://app.rocketride.ai';
const PARENT = { parent: true };
const PORT = { port: true };

async function load(): Promise<typeof import('./acceptInit')> {
	return await import('./acceptInit');
}

function init(over: Record<string, unknown> = {}): BridgeInit {
	return {
		type: 'rr:bridge:init',
		proto: 1,
		entryPrefix: '/_t/v1.k1.AAAA.BBBB/v3/',
		expiresAt: 1_700_000_900_000,
		theme: {},
		identity: null,
		props: { isConnected: true, activeView: 'v', activeActivity: null, sidePanelOpen: false, theme: 'dark' },
		capabilities: ['core'],
		appId: 'acme.alpha',
		appKey: 'a' + 'q'.repeat(24),
		moduleId: 'acme_alpha',
		viewId: 'v',
		engineHttpUrl: 'https://engine.example',
		...over,
	} as BridgeInit;
}

const ev = (over: Record<string, unknown> = {}) => ({ source: PARENT, origin: SHELL, data: init(), ports: [PORT], ...over });

test('T54 the shell origins come only from the meta list and only as http(s) origins', async () => {
	const { parseShellOrigins } = await load();
	assert.deepEqual(parseShellOrigins('https://app.rocketride.ai http://localhost:5565'), ['https://app.rocketride.ai', 'http://localhost:5565']);
	assert.deepEqual(parseShellOrigins('https://a.example,https://b.example'), ['https://a.example', 'https://b.example']);
	assert.deepEqual(parseShellOrigins('*'), []);
	assert.deepEqual(parseShellOrigins('javascript:alert(1) https://ok.example data:text/html,x ftp://x.example'), ['https://ok.example']);
	assert.deepEqual(parseShellOrigins('https://ok.example/path https://u:p@x.example'), [], 'an origin has no path or userinfo');
	assert.deepEqual(parseShellOrigins(null), []);
	assert.deepEqual(parseShellOrigins(''), []);
});

test('T54 the ready message goes to each shell origin as its own targetOrigin, never "*"', async () => {
	const { readyMessages } = await load();
	const out = readyMessages([SHELL, 'http://localhost:5565']);
	assert.deepEqual(
		out.map((m) => m.targetOrigin),
		[SHELL, 'http://localhost:5565']
	);
	for (const m of out) assert.deepEqual(m.message, { type: 'rr:frame:ready', protoMin: 1, protoMax: 1 });
	assert.deepEqual(readyMessages([]), [], 'no origin, no message');
});

test('T54 the first valid init from the parent at a listed shell origin with one port is accepted', async () => {
	const { createInitAcceptor } = await load();
	const accept = createInitAcceptor({ origins: [SHELL], parent: PARENT });
	const got = accept.accept(ev());
	assert.ok(got);
	assert.equal(got.port, PORT);
	assert.equal(got.init.appId, 'acme.alpha');
});

test('T54 exactly one init is accepted: a second valid one is ignored', async () => {
	const { createInitAcceptor } = await load();
	const accept = createInitAcceptor({ origins: [SHELL], parent: PARENT });
	assert.ok(accept.accept(ev()));
	assert.equal(accept.accept(ev({ data: init({ appId: 'acme.other' }) })), null);
});

test('T54 an init from another window, an unlisted origin or without exactly one port is ignored, and does not use up the one acceptance', async () => {
	const { createInitAcceptor } = await load();
	const accept = createInitAcceptor({ origins: [SHELL], parent: PARENT });
	assert.equal(accept.accept(ev({ source: { parent: false } })), null, 'not the parent');
	assert.equal(accept.accept(ev({ source: null })), null);
	for (const origin of ['https://evil.example', 'null', '', SHELL + '.evil.example', 'http://app.rocketride.ai', SHELL + '/']) assert.equal(accept.accept(ev({ origin })), null, origin);
	assert.equal(accept.accept(ev({ ports: [] })), null, 'no port');
	assert.equal(accept.accept(ev({ ports: [PORT, PORT] })), null, 'two ports');
	assert.equal(accept.accept(ev({ ports: undefined })), null);
	assert.ok(accept.accept(ev()), 'the real init still works afterwards');
});

test('T54 a malformed init is refused whatever its origin: wrong type or proto, bad prefix, a url with userinfo, query or key', async () => {
	const { createInitAcceptor } = await load();
	const bad: Array<Record<string, unknown>> = [
		{ type: 'rr:bridge:init2' },
		{ proto: 2 },
		{ proto: '1' },
		{ entryPrefix: 'https://evil.example/_t/x/v1/' },
		{ entryPrefix: '/_t/x/v1/../../' },
		{ entryPrefix: '/other/' },
		{ entryPrefix: 5 },
		{ expiresAt: 'soon' },
		{ appId: '' },
		{ appId: 5 },
		{ moduleId: undefined },
		{ capabilities: 'core' },
		{ engineHttpUrl: 'https://user:pw@engine.example' },
		{ engineHttpUrl: 'https://engine.example/?key=abc' },
		{ engineHttpUrl: 'https://engine.example/#x' },
		{ engineHttpUrl: 'javascript:alert(1)' },
		{ engineHttpUrl: '' },
	];
	for (const over of bad) {
		const accept = createInitAcceptor({ origins: [SHELL], parent: PARENT });
		assert.equal(accept.accept(ev({ data: init(over) })), null, JSON.stringify(over));
	}
	for (const data of [null, undefined, 'rr:bridge:init', 7, []]) {
		const accept = createInitAcceptor({ origins: [SHELL], parent: PARENT });
		assert.equal(accept.accept(ev({ data })), null);
	}
});

test('T54 without any shell origin nothing is accepted (an empty meta list fails closed)', async () => {
	const { createInitAcceptor } = await load();
	assert.equal(createInitAcceptor({ origins: [], parent: PARENT }).accept(ev()), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// T55 guest side: one refresh, 120 s before expiry
// ─────────────────────────────────────────────────────────────────────────────

interface IRig {
	timers: Array<{ cb: () => void; ms: number; cleared: boolean }>;
	requests: number;
	applied: string[];
	failures: unknown[];
	clock: { t: number };
}

async function refreshRig(reply: () => Promise<{ entryPrefix: string; expiresAt: number }>, expiresAt: number, nowMs = 1_000_000) {
	const { startFrameRefresh } = await import('./refresh');
	const rig: IRig = { timers: [], requests: 0, applied: [], failures: [], clock: { t: nowMs } };
	const handle = startFrameRefresh({
		expiresAt,
		now: () => rig.clock.t,
		request: () => {
			rig.requests++;
			return reply();
		},
		setTimer: (cb: () => void, ms: number) => {
			const timer = { cb, ms, cleared: false };
			rig.timers.push(timer);
			return timer;
		},
		clearTimer: (timer: { cleared: boolean }) => void (timer.cleared = true),
		apply: (prefix: string) => void rig.applied.push(prefix),
		failed: (err: unknown) => void rig.failures.push(err),
	} as never);
	return { rig, handle };
}

test('T55 the single refresh is scheduled 120 s before expiresAt and asks the root once', async () => {
	const { rig } = await refreshRig(async () => ({ entryPrefix: '/_t/new/v3/', expiresAt: 9_000_000 }), 1_000_000 + 900_000);
	assert.equal(rig.timers.length, 1);
	assert.equal(rig.timers[0].ms, 900_000 - 120_000);
	rig.timers[0].cb();
	await new Promise((r) => setImmediate(r));
	assert.equal(rig.requests, 1);
	assert.deepEqual(rig.applied, ['/_t/new/v3/'], 'the new prefix replaces the old');
});

test('T55 after a reply the next cycle is scheduled from the NEW expiresAt', async () => {
	const { rig } = await refreshRig(async () => ({ entryPrefix: '/_t/new/v3/', expiresAt: 1_000_000 + 1_800_000 }), 1_000_000 + 900_000);
	rig.timers[0].cb();
	await new Promise((r) => setImmediate(r));
	const next = rig.timers.filter((t) => !t.cleared).at(-1)!;
	assert.equal(next.ms, 1_800_000 - 120_000);
});

test('T55 a failure is reported, not retried: the root already retried, and the tile is the next step', async () => {
	const { rig } = await refreshRig(async () => {
		throw new Error('Session ended');
	}, 1_000_000 + 900_000);
	rig.timers[0].cb();
	await new Promise((r) => setImmediate(r));
	assert.equal(rig.requests, 1);
	assert.equal(rig.failures.length, 1);
	assert.equal(rig.timers.filter((t) => !t.cleared).length, 1, 'no second timer was set');
});

test('T55 an expiry closer than 120 s fires at once (never a negative delay), and stop() cancels the pending timer', async () => {
	const near = await refreshRig(async () => ({ entryPrefix: '/_t/n/v1/', expiresAt: 5_000_000 }), 1_000_000 + 60_000);
	assert.equal(near.rig.timers[0].ms, 0);
	const far = await refreshRig(async () => ({ entryPrefix: '/_t/n/v1/', expiresAt: 5_000_000 }), 1_000_000 + 900_000);
	far.handle.stop();
	assert.equal(far.rig.timers[0].cleared, true);
});
