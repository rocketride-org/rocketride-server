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
import { CONSENT_STORAGE_KEY, getMarketingConsent, type MarketingConsent, resetMarketingConsentForTests, setMarketingConsent, subscribeMarketingConsent } from './marketingConsent';

// Minimal window stand-in: a Map-backed localStorage plus the 'storage'
// event hook the store registers for cross-tab sync.
function installWindow(initial: Record<string, string> = {}): { store: Map<string, string>; fireStorage: (key: string) => void } {
	const store = new Map(Object.entries(initial));
	const listeners: Array<(e: { key: string | null }) => void> = [];
	(globalThis as unknown as { window: unknown }).window = {
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
			removeItem: (k: string) => {
				store.delete(k);
			},
		},
		addEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
			if (type === 'storage') listeners.push(fn);
		},
	};
	return { store, fireStorage: (key) => listeners.forEach((fn) => fn({ key })) };
}

beforeEach(() => {
	resetMarketingConsentForTests();
});

test('defaults to undecided when nothing is stored (default deny: nothing loads until allowed)', () => {
	installWindow();
	assert.equal(getMarketingConsent(), null);
});

test('reads a stored decision', () => {
	installWindow({ [CONSENT_STORAGE_KEY]: 'true' });
	assert.equal(getMarketingConsent(), true);
});

test('reads a stored refusal', () => {
	installWindow({ [CONSENT_STORAGE_KEY]: 'false' });
	assert.equal(getMarketingConsent(), false);
});

test('treats an unrecognised stored value as undecided', () => {
	installWindow({ [CONSENT_STORAGE_KEY]: 'yes-please' });
	assert.equal(getMarketingConsent(), null);
});

test('the retired granted/denied strings do NOT read as a decision', () => {
	installWindow({ [CONSENT_STORAGE_KEY]: 'granted' });
	assert.equal(getMarketingConsent(), null);
	resetMarketingConsentForTests();
	installWindow({ [CONSENT_STORAGE_KEY]: 'denied' });
	assert.equal(getMarketingConsent(), null);
});

test('setMarketingConsent persists and notifies subscribers', () => {
	const { store } = installWindow();
	const seen: MarketingConsent[] = [];
	const unsubscribe = subscribeMarketingConsent(() => seen.push(getMarketingConsent()));
	setMarketingConsent(true);
	assert.equal(store.get(CONSENT_STORAGE_KEY), 'true');
	assert.deepEqual(seen, [true]);
	unsubscribe();
	setMarketingConsent(false);
	assert.deepEqual(seen, [true]);
});

test('a refusal persists as the string false, not an absent key', () => {
	const { store } = installWindow();
	setMarketingConsent(false);
	assert.equal(store.get(CONSENT_STORAGE_KEY), 'false');
	assert.equal(getMarketingConsent(), false);
});

test('a decision made in another tab propagates via the storage event', () => {
	const { store, fireStorage } = installWindow();
	const seen: MarketingConsent[] = [];
	subscribeMarketingConsent(() => seen.push(getMarketingConsent()));
	store.set(CONSENT_STORAGE_KEY, 'false');
	fireStorage(CONSENT_STORAGE_KEY);
	assert.deepEqual(seen, [false]);
});

test('storage that throws (privacy mode) reads as undecided and never throws', () => {
	(globalThis as unknown as { window: unknown }).window = {
		get localStorage(): Storage {
			throw new Error('SecurityError');
		},
		addEventListener: () => undefined,
	};
	assert.equal(getMarketingConsent(), null);
	assert.doesNotThrow(() => setMarketingConsent(true));
	// The in-memory decision still holds for this page even if it cannot persist.
	assert.equal(getMarketingConsent(), true);
});
