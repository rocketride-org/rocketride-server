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
import { tabSession, updateTabSession, devRelayOrigin, isLoopbackShell, resetDevGateForTests } from './devGate';

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
async function withBoot(search: string, session: ReturnType<typeof fakeSession>, run: () => void | Promise<void>, opts: { framed?: boolean; origin?: string; nodeEnv?: string } = {}): Promise<void> {
	// The dev relay serves loopback dev servers: stage one unless a test says otherwise.
	const win: Record<string, unknown> = { location: { search, pathname: '/', origin: opts.origin ?? 'http://localhost:5565' } };
	const originalNodeEnv = process.env.NODE_ENV;
	if (opts.nodeEnv) process.env.NODE_ENV = opts.nodeEnv;
	win.self = win;
	win.top = opts.framed ? {} : win;
	const originals = (['window', 'sessionStorage'] as const).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
	Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session.storage });
	resetDevGateForTests();
	try {
		await run();
	} finally {
		process.env.NODE_ENV = originalNodeEnv;
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

// =============================================================================
// PRODUCTION BUILD + RELAY POLICY (rocketride-saas#1020)
// =============================================================================

test('a production build is never a dev tab: neither the URL nor the persisted copy makes tabSession().dev true', async () => {
	const persisted = [['rr:tab', JSON.stringify({ dev: true, appId: 'local.alarm', authOrigin: 'http://localhost:5565' })]] as Array<[string, string]>;
	for (const [search, initial] of [['?rrdev=1', []], ['?appid=local.alarm&rrdev=1&rrauthorigin=http%3A%2F%2Flocalhost%3A5565', []], ['', persisted], ['?code=abc', persisted]] as Array<[string, Array<[string, string]>]>) {
		const session = fakeSession(initial);
		await withBoot(search, session, () => {
			assert.equal(tabSession().dev, false, `${search || '(bare)'} ${initial.length ? 'with a persisted dev copy' : ''}`);
			assert.equal(devRelayOrigin(), '', 'and it has no relay');
		}, { nodeEnv: 'production' });
	}
	// The facts a production tab keeps are the identity ones (deep links still lock the app).
	await withBoot('?appid=local.alarm&rrdev=1', fakeSession(), () => {
		assert.equal(tabSession().appId, 'local.alarm');
	}, { nodeEnv: 'production' });
});

test('the dev relay is honoured only by a top-level shell served from a loopback origin', async () => {
	const url = '?appid=local.alarm&rrdev=1&rrauthorigin=https%3A%2F%2Frocketride.ai';
	for (const origin of ['http://localhost:3013', 'http://127.0.0.1:3013', 'http://[::1]:3013']) {
		await withBoot(url, fakeSession(), () => {
			assert.equal(devRelayOrigin(), 'https://rocketride.ai', origin);
		}, { origin });
	}
	// A dev flavor served from a real origin (the production origin behind `?rrdev=1`) must not
	// let a link steer its sign-in redirect; lookalikes and an opaque origin are not loopback.
	for (const origin of ['https://cloud.rocketride.example', 'http://cloud.rocketride.example', 'http://localhost.evil.test:3013', 'https://127.0.0.1.evil.test', 'null', '']) {
		await withBoot(url, fakeSession(), () => {
			assert.equal(devRelayOrigin(), '', JSON.stringify(origin));
		}, { origin });
	}
});

test('isLoopbackShell: loopback hosts only — a host that merely ENDS WITH "localhost" (no dot) or embeds it is not loopback', async () => {
	for (const origin of ['http://localhost:3013', 'https://localhost', 'http://127.0.0.1:3013', 'http://127.1.2.3', 'http://[::1]:3013', 'http://app.localhost:3013']) {
		await withBoot('', fakeSession(), () => { assert.equal(isLoopbackShell(), true, origin); }, { origin });
	}
	for (const origin of ['http://evillocalhost:3013', 'http://notlocalhost:3013', 'https://xlocalhost', 'http://evil-localhost', 'http://localhost.evil.test:3013', 'http://127.0.0.1.evil.test', 'https://cloud.rocketride.example', 'null', '']) {
		await withBoot('', fakeSession(), () => { assert.equal(isLoopbackShell(), false, JSON.stringify(origin)); }, { origin });
	}
});

test('the dev relay is ignored by a FRAMED shell, loopback-served or not (framed previews sign in via rrdev:auth)', async () => {
	const url = '?appid=local.alarm&rrdev=1&rrauthorigin=https%3A%2F%2Frocketride.ai';
	// the same page, top-level: the relay is armed (control)
	await withBoot(url, fakeSession(), () => { assert.equal(devRelayOrigin(), 'https://rocketride.ai'); }, { origin: 'http://localhost:3013' });
	for (const origin of ['http://localhost:3013', 'http://127.0.0.1:3013']) {
		await withBoot(url, fakeSession(), () => {
			assert.equal(tabSession().authOrigin, 'https://rocketride.ai', 'the URL fact is read...');
			assert.equal(devRelayOrigin(), '', `...but a framed shell never relays (${origin})`);
		}, { origin, framed: true });
	}
});
