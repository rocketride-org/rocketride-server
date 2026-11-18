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
// FRAME ATTRIBUTES — T52, T53 (plan section 3.3 `frameAttrs.ts`)
// =============================================================================
//
//   frameAttributes(origin, framePath, shellOrigins, title)
//     -> exactly { src, sandbox, allow, referrerPolicy, title } | null
//
// `null` when the app origin is same-site with a shell origin (the separation
// would be void), and also (fail closed, an addition of these tests: see the
// "Questions for the lead" of T1_PR2b.md) when `framePath` is anything but
// `/_rr/frame.html` with at most the one `c=<ticket>` query parameter.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

const SHELLS = ['https://app.rocketride.ai'];
const APP = 'https://a1234567890123456789012345.apps.rocketride-app.com';
const TICKET = 'v1.k1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

async function load(): Promise<typeof import('./frameAttrs')> {
	return await import('./frameAttrs');
}

test('T52 the attribute set is exactly src, sandbox, allow, referrerPolicy and title, with the exact values', async () => {
	const { frameAttributes } = await load();
	const attrs = frameAttributes(APP, `/_rr/frame.html?c=${TICKET}`, SHELLS, 'Acme Alpha');
	assert.deepEqual(attrs, {
		src: `${APP}/_rr/frame.html?c=${TICKET}`,
		sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads',
		allow: 'clipboard-write',
		referrerPolicy: 'no-referrer',
		title: 'Acme Alpha',
	});
});

test('T52 no attribute the plan does not list is ever present, and the sandbox never gains a navigation or popup right', async () => {
	const { frameAttributes } = await load();
	const attrs = frameAttributes(APP, '/_rr/frame.html', SHELLS, 't') as Record<string, string>;
	assert.deepEqual(Object.keys(attrs).sort(), ['allow', 'referrerPolicy', 'sandbox', 'src', 'title']);
	for (const forbidden of ['allow-top-navigation', 'allow-popups', 'allow-modals', 'allow-pointer-lock', 'allow-presentation', 'allow-orientation-lock', 'allow-popups-to-escape-sandbox', 'allow-top-navigation-by-user-activation']) {
		assert.ok(!attrs.sandbox.split(' ').includes(forbidden), forbidden);
	}
	assert.equal(attrs.allow.includes('camera'), false);
	assert.equal(attrs.allow.includes('microphone'), false);
});

test('T52 the logout sweep frame sandbox keeps a non-opaque origin so /_rr/clear sees Sec-Fetch-Site: same-origin', async () => {
	const mod = await load();
	assert.equal(mod.SWEEP_SANDBOX, 'allow-scripts allow-same-origin');
});

test('T52 an app origin that is same-site with a shell origin gets no frame at all (null)', async () => {
	const { frameAttributes } = await load();
	for (const origin of ['https://app.rocketride.ai', 'https://a1234567890123456789012345.rocketride.ai', 'https://x.app.rocketride.ai', 'https://a1234567890123456789012345.rocketride.ai:8443', 'https://rocketride.ai']) {
		assert.equal(frameAttributes(origin, '/_rr/frame.html', SHELLS, 't'), null, origin);
	}
	// a separate registrable domain is served (control)
	assert.notEqual(frameAttributes(APP, '/_rr/frame.html', SHELLS, 't'), null);
});

test('T52 the localhost development pairing (apps.localhost beside localhost) is a separate site and is served', async () => {
	const { frameAttributes } = await load();
	const attrs = frameAttributes('http://a1234567890123456789012345.apps.localhost:5565', '/_rr/frame.html?c=x', ['http://localhost:5565'], 't');
	assert.ok(attrs, 'dev pairing');
	assert.equal(attrs.src, 'http://a1234567890123456789012345.apps.localhost:5565/_rr/frame.html?c=x');
});

test('T52 every shell origin counts, not only the first', async () => {
	const { frameAttributes } = await load();
	assert.equal(frameAttributes('https://a1234567890123456789012345.shell-two.example', '/_rr/frame.html', ['https://app.rocketride.ai', 'https://www.shell-two.example'], 't'), null);
});

test('T53 the frame src holds the ticket path only: the frame token, an entryPrefix or a credential can never be put in it', async () => {
	const { frameAttributes } = await load();
	const ok = frameAttributes(APP, `/_rr/frame.html?c=${TICKET}`, SHELLS, 't')!;
	assert.ok(!ok.src.includes('/_t/'));
	assert.ok(!ok.src.includes('/_p/'));
	assert.ok(!ok.src.includes('#'), 'no fragment');
	const u = new URL(ok.src);
	assert.equal(u.origin, APP);
	assert.equal(u.pathname, '/_rr/frame.html');
	assert.deepEqual([...u.searchParams.keys()], ['c']);
	assert.equal(u.username + u.password, '');
});

test('T53 a framePath that is not the ticket path is refused (null), however it is spelled', async () => {
	const { frameAttributes } = await load();
	const bad = [
		'/_t/sometoken/v1/',
		'/_rr/frame.html?c=a&token=x',
		'/_rr/frame.html?token=x',
		'/_rr/frame.html#c=x',
		'/_rr/frame.html?c=a b',
		'/_rr/frame.html?c=%2e%2e',
		'/_rr/../frame.html?c=x',
		'//evil.example/_rr/frame.html',
		'https://evil.example/_rr/frame.html',
		'_rr/frame.html',
		'/_rr/frame.html/?c=x',
		'/_rr/clear',
		'',
		'/_rr/frame.html?c=',
	];
	for (const path of bad) assert.equal(frameAttributes(APP, path, SHELLS, 't'), null, JSON.stringify(path));
});
