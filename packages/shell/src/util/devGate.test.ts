// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// TAB SESSION BOOT MATRIX — the one-key boot identity across boot shapes
// =============================================================================
//
// The matrix that produced this module: (top-level dev tab, framed preview,
// plain tab) × (fresh boot with params, OAuth `?code=` return with the query
// stripped, bare reload). Every row must resolve the SAME identity from the
// same key, because each consumer re-deriving it from window.location with
// its own fallback rules is exactly how the dev loop broke twice.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabSession, updateTabSession, devRelayOrigin, resetDevGateForTests } from './devGate';

/** A sessionStorage double over a Map. */
function fakeSession(initial: Array<[string, string]> = []) {
	const data = new Map<string, string>(initial);
	return {
		data,
		storage: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => { data.set(k, v); },
			removeItem: (k: string) => { data.delete(k); },
		},
	};
}

/** Stage window/sessionStorage, reset the devGate caches, run, restore. */
async function withBoot(search: string, session: ReturnType<typeof fakeSession>, run: () => void | Promise<void>, opts: { framed?: boolean } = {}): Promise<void> {
	const win: Record<string, unknown> = { location: { search, pathname: '/' } };
	win.self = win;
	win.top = opts.framed ? {} : win;
	const originals = (['window', 'sessionStorage'] as const).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
	Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session.storage });
	resetDevGateForTests();
	try {
		await run();
	} finally {
		resetDevGateForTests();
		for (const [key, original] of originals) {
			if (original) Object.defineProperty(globalThis, key, original);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
}

test('fresh dev boot: URL params become the tab session and persist under rr:tab', async () => {
	const session = fakeSession();
	await withBoot('?appid=local.alarm&rrdev=1&rrauthorigin=http%3A%2F%2Flocalhost%3A5565', session, () => {
		assert.deepEqual(tabSession(), { dev: true, appId: 'local.alarm', authOrigin: 'http://localhost:5565' });
		assert.deepEqual(JSON.parse(session.data.get('rr:tab') ?? '{}'), { dev: true, appId: 'local.alarm', authOrigin: 'http://localhost:5565' });
		assert.equal(devRelayOrigin(), 'http://localhost:5565');
	});
});

test('OAuth return (?code= only) resolves the SAME identity from the persisted copy', async () => {
	const session = fakeSession([['rr:tab', JSON.stringify({ dev: true, appId: 'local.alarm', authOrigin: 'http://localhost:5565' })]]);
	await withBoot('?code=abc', session, () => {
		assert.deepEqual(tabSession(), { dev: true, appId: 'local.alarm', authOrigin: 'http://localhost:5565' });
		assert.equal(devRelayOrigin(), 'http://localhost:5565');
	});
});

test('bare reload (no params at all) keeps the tab identity', async () => {
	const session = fakeSession([['rr:tab', JSON.stringify({ dev: true, appId: 'local.alarm', authOrigin: 'http://localhost:5565' })]]);
	await withBoot('', session, () => {
		assert.deepEqual(tabSession(), { dev: true, appId: 'local.alarm', authOrigin: 'http://localhost:5565' });
	});
});

test('URL facts outrank the persisted copy field by field', async () => {
	const session = fakeSession([['rr:tab', JSON.stringify({ dev: true, appId: 'local.old', authOrigin: 'http://localhost:5565' })]]);
	await withBoot('?appid=local.new', session, () => {
		// appId comes from the URL; dev and authOrigin survive from the copy.
		assert.deepEqual(tabSession(), { dev: true, appId: 'local.new', authOrigin: 'http://localhost:5565' });
	});
});

test('a plain production tab has an all-empty session and writes nothing', async () => {
	const session = fakeSession();
	await withBoot('', session, () => {
		assert.deepEqual(tabSession(), { dev: false, appId: '', authOrigin: '' });
		assert.equal(session.data.has('rr:tab'), false, 'plain tabs leave no tab-session residue');
	});
});

test('a hostile rrauthorigin value is rejected; a non-origin URL collapses to its origin', async () => {
	const session = fakeSession();
	await withBoot('?rrdev=1&rrauthorigin=javascript%3Aalert(1)', session, () => {
		assert.equal(tabSession().authOrigin, '', 'non-http(s) schemes never become a relay origin');
	});
	const session2 = fakeSession();
	await withBoot('?rrdev=1&rrauthorigin=http%3A%2F%2Flocalhost%3A5565%2Fdeep%2Fpath%3Fx%3D1', session2, () => {
		assert.equal(tabSession().authOrigin, 'http://localhost:5565', 'paths and queries are stripped to the origin');
	});
});

test('a FRAMED shell neither reads nor stamps the tab sessionStorage copy', async () => {
	const session = fakeSession([['rr:tab', JSON.stringify({ dev: true, appId: 'local.host-tab', authOrigin: '' })]]);
	await withBoot('?appid=acme.preview&rrdev=1', session, () => {
		// Identity comes from the frame's own URL, not the tab copy…
		assert.deepEqual(tabSession(), { dev: true, appId: 'acme.preview', authOrigin: '' });
		// …and the tab copy is untouched (frame-local store absorbed the write).
		assert.deepEqual(JSON.parse(session.data.get('rr:tab') ?? '{}').appId, 'local.host-tab');
		// The relay is a top-level mechanism; framed shells sign in via rrdev:auth.
		assert.equal(devRelayOrigin(), '');
	}, { framed: true });
});

test('updateTabSession merges, persists, and updates the cache', async () => {
	const session = fakeSession();
	await withBoot('?appid=local.alarm&rrdev=1', session, () => {
		updateTabSession({ appId: '' });
		assert.deepEqual(tabSession(), { dev: true, appId: '', authOrigin: '' });
		assert.equal(JSON.parse(session.data.get('rr:tab') ?? '{}').appId, '');
		updateTabSession({ appId: 'local.other' });
		assert.equal(tabSession().appId, 'local.other');
	});
});
