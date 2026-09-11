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
import {
	captureClickParams,
	configureAttribution,
	decodeAttributionState,
	encodeAttributionState,
	getClickParams,
	isAttributionConfigured,
	resetAdAttributionForTests,
} from './adAttribution';

// Browser stand-in. No storage is faked on purpose: this module must never
// touch cookies, localStorage or sessionStorage, so a test that passed by
// writing to one would be lying.
function installBrowser({ search = '', webdriver = false, gpc = false }: { search?: string; webdriver?: boolean; gpc?: boolean } = {}) {
	const dataset: Record<string, string> = {};
	(globalThis as unknown as Record<string, unknown>).window = { location: { search, href: `https://cloud.rocketride.ai/${search}` } };
	(globalThis as unknown as Record<string, unknown>).document = { documentElement: { dataset } };
	Object.defineProperty(globalThis, 'navigator', {
		value: { webdriver, ...(gpc ? { globalPrivacyControl: true } : {}) },
		configurable: true,
		writable: true,
	});
	return { dataset };
}

beforeEach(() => {
	resetAdAttributionForTests();
});

// ---------------------------------------------------------------------------
// configureAttribution
// ---------------------------------------------------------------------------

test('no provider: not configured, and no consent control is offered', () => {
	const { dataset } = installBrowser();
	configureAttribution(undefined);
	assert.equal(isAttributionConfigured(), false);
	assert.equal(dataset.rrConsent, undefined);
});

test('a provider marks consent available', () => {
	const { dataset } = installBrowser();
	configureAttribution('gravity');
	assert.equal(isAttributionConfigured(), true);
	assert.equal(dataset.rrConsent, 'available');
});

test('an automated browser (the prerenderer) is never configured', () => {
	const { dataset } = installBrowser({ webdriver: true });
	configureAttribution('gravity');
	assert.equal(isAttributionConfigured(), false);
	assert.equal(dataset.rrConsent, undefined);
});

test('Global Privacy Control opts the visitor out entirely', () => {
	const { dataset } = installBrowser({ gpc: true });
	configureAttribution('gravity');
	assert.equal(isAttributionConfigured(), false);
	assert.equal(dataset.rrConsent, undefined);
});

// ---------------------------------------------------------------------------
// captureClickParams
// ---------------------------------------------------------------------------

test('captures the allowlisted Gravity click params from the landing URL', () => {
	installBrowser({ search: '?grclid=abc123&grcpid=camp1&gradid=ad1&utm_source=x&foo=bar' });
	captureClickParams();
	assert.deepEqual(getClickParams(), { grclid: 'abc123', grcpid: 'camp1', gradid: 'ad1' });
});

test('a URL with no ad params yields nothing', () => {
	installBrowser({ search: '?utm_source=newsletter' });
	captureClickParams();
	assert.deepEqual(getClickParams(), {});
});

test('rejects values that are too long or carry unexpected characters', () => {
	installBrowser({ search: `?grclid=${'a'.repeat(257)}&grcpid=${encodeURIComponent('<script>')}&graid=ok-1` });
	captureClickParams();
	assert.deepEqual(getClickParams(), { graid: 'ok-1' });
});

test('a later capture does not erase params from the landing URL', () => {
	installBrowser({ search: '?grclid=abc123' });
	captureClickParams();
	installBrowser({ search: '?code=oauth-code' });
	captureClickParams();
	assert.deepEqual(getClickParams(), { grclid: 'abc123' });
});

// ---------------------------------------------------------------------------
// OAuth state round-trip — how params survive the redirect without storage
// ---------------------------------------------------------------------------

test('encodes captured params into an opaque state value, and back', () => {
	installBrowser({ search: '?grclid=abc123&grsig=sig9' });
	captureClickParams();
	const state = encodeAttributionState();
	assert.ok(state && !state.includes('grclid'), 'state should be opaque, not a query string');
	assert.deepEqual(decodeAttributionState(state), { grclid: 'abc123', grsig: 'sig9' });
});

test('no params means no state to carry', () => {
	installBrowser({ search: '' });
	captureClickParams();
	assert.equal(encodeAttributionState(), null);
});

test('recovers params from ?state= on the OAuth callback', () => {
	installBrowser({ search: '?grclid=abc123' });
	captureClickParams();
	const state = encodeAttributionState() as string;
	resetAdAttributionForTests();
	installBrowser({ search: `?code=oauth-code&state=${encodeURIComponent(state)}` });
	captureClickParams();
	assert.deepEqual(getClickParams(), { grclid: 'abc123' });
});

test('a malformed or hostile state is ignored, never thrown', () => {
	installBrowser({ search: '?code=c&state=not-base64-%%%' });
	assert.doesNotThrow(() => captureClickParams());
	assert.deepEqual(getClickParams(), {});
	resetAdAttributionForTests();
	const hostile = Buffer.from(JSON.stringify({ grclid: '<script>', evil: 'x' }), 'utf-8').toString('base64url');
	installBrowser({ search: `?state=${hostile}` });
	captureClickParams();
	assert.deepEqual(getClickParams(), {});
});
