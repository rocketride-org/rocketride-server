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
import test, { beforeEach } from 'node:test';
import { CONSENT_STORAGE_KEY, resetMarketingConsentForTests, setMarketingConsent } from './marketingConsent';
import { GRAVITY_PIXEL_SRC, configureGravityPixel, getGravityCAPIData, hasGravityPixelStarted, isGravityPixelConfigured, resetGravityPixelForTests, whenGravityPixelReady } from './gravityPixel';

const ADVERTISER = '0b3c9a52-7d0e-4f2a-9c11-5e6f7a8b9c0d';

interface FakeScript {
	src: string;
	async: boolean;
	onload: (() => void) | null;
	onerror: (() => void) | null;
}

interface Env {
	appended: FakeScript[];
	calls: unknown[][];
	dataset: Record<string, string>;
	win: Record<string, unknown>;
}

// Browser stand-ins: a document that records appended <script>s, a window
// carrying the index.html queue shim (records every gravity(...) call), and
// a navigator whose `webdriver` flag models a headless prerenderer.
function installBrowser({ consent, webdriver = false }: { consent?: string; webdriver?: boolean } = {}): Env {
	const appended: FakeScript[] = [];
	const calls: unknown[][] = [];
	const dataset: Record<string, string> = {};
	const store = new Map<string, string>(consent ? [[CONSENT_STORAGE_KEY, consent]] : []);
	const win: Record<string, unknown> = {
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
			removeItem: (k: string) => {
				store.delete(k);
			},
		},
		addEventListener: () => undefined,
		gravity: (...args: unknown[]) => {
			calls.push(args);
		},
	};
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = {
		documentElement: { dataset },
		head: {
			appendChild: (el: FakeScript) => {
				appended.push(el);
				return el;
			},
		},
		createElement: () => ({ src: '', async: false, onload: null, onerror: null }),
	};
	Object.defineProperty(globalThis, 'navigator', { value: { webdriver }, configurable: true, writable: true });
	return { appended, calls, dataset, win };
}

beforeEach(() => {
	resetMarketingConsentForTests();
	resetGravityPixelForTests();
});

test('without an advertiser ID nothing is configured and nothing loads', () => {
	const env = installBrowser({ consent: 'granted' });
	configureGravityPixel(undefined);
	assert.equal(isGravityPixelConfigured(), false);
	assert.equal(env.appended.length, 0);
	assert.equal(env.dataset.rrConsent, undefined);
});

test('a headless/automated browser (the prerenderer) never loads the pixel', () => {
	const env = installBrowser({ consent: 'granted', webdriver: true });
	configureGravityPixel(ADVERTISER);
	assert.equal(isGravityPixelConfigured(), false);
	assert.equal(env.appended.length, 0);
	assert.equal(env.dataset.rrConsent, undefined);
});

test('configured but consent unset: marks consent available, loads nothing', () => {
	const env = installBrowser();
	configureGravityPixel(ADVERTISER);
	assert.equal(isGravityPixelConfigured(), true);
	assert.equal(env.dataset.rrConsent, 'available');
	assert.equal(env.appended.length, 0);
	assert.deepEqual(env.calls, []);
});

test('consent already granted: injects the CDN script once and inits', () => {
	const env = installBrowser({ consent: 'granted' });
	configureGravityPixel(ADVERTISER);
	assert.equal(env.appended.length, 1);
	assert.equal(env.appended[0].src, GRAVITY_PIXEL_SRC);
	assert.equal(env.appended[0].async, true);
	assert.deepEqual(env.calls, [['init', ADVERTISER]]);
});

test('granting consent later loads the pixel; repeat grants do not double-load', () => {
	const env = installBrowser();
	configureGravityPixel(ADVERTISER);
	setMarketingConsent('granted');
	setMarketingConsent('granted');
	assert.equal(env.appended.length, 1);
	assert.deepEqual(env.calls, [['init', ADVERTISER]]);
});

test('denying consent loads nothing', () => {
	const env = installBrowser();
	configureGravityPixel(ADVERTISER);
	setMarketingConsent('denied');
	assert.equal(env.appended.length, 0);
	assert.equal(hasGravityPixelStarted(), false);
});

test('hasGravityPixelStarted flips once the script is injected', () => {
	installBrowser();
	configureGravityPixel(ADVERTISER);
	assert.equal(hasGravityPixelStarted(), false);
	setMarketingConsent('granted');
	assert.equal(hasGravityPixelStarted(), true);
});

test('installs the queue shim itself if index.html did not', () => {
	const env = installBrowser({ consent: 'granted' });
	delete env.win.gravity;
	configureGravityPixel(ADVERTISER);
	const shim = env.win.gravity as { q?: unknown[][] };
	assert.equal(typeof shim, 'function');
	assert.deepEqual(
		shim.q?.map((a) => Array.from(a)),
		[['init', ADVERTISER]]
	);
});

test('getGravityCAPIData returns the pixel blob, or null when absent or broken', () => {
	const env = installBrowser();
	assert.equal(getGravityCAPIData(), null);
	env.win.gravityPixel = { getCAPIData: () => ({ user_data: { grclid: 'x' }, client_context: {} }) };
	assert.deepEqual(getGravityCAPIData(), { user_data: { grclid: 'x' }, client_context: {} });
	env.win.gravityPixel = { getCAPIData: () => 'not-an-object' };
	assert.equal(getGravityCAPIData(), null);
	env.win.gravityPixel = {
		getCAPIData: () => {
			throw new Error('pixel bug');
		},
	};
	assert.equal(getGravityCAPIData(), null);
});

test('whenGravityPixelReady resolves false when the pixel never loads', async () => {
	installBrowser();
	configureGravityPixel(ADVERTISER);
	assert.equal(await whenGravityPixelReady(), false);
});

test('whenGravityPixelReady resolves true once the script loads and exposes getCAPIData', async () => {
	const env = installBrowser({ consent: 'granted' });
	configureGravityPixel(ADVERTISER);
	const ready = whenGravityPixelReady();
	env.win.gravityPixel = { getCAPIData: () => ({}) };
	env.appended[0].onload?.();
	assert.equal(await ready, true);
});

test('whenGravityPixelReady resolves false when the CDN script fails to load', async () => {
	const env = installBrowser({ consent: 'granted' });
	configureGravityPixel(ADVERTISER);
	const ready = whenGravityPixelReady();
	env.appended[0].onerror?.();
	assert.equal(await ready, false);
});
