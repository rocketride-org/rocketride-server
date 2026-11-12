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

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

// Its own file on purpose: these tests decide on the page's ONE consent store
// (consentState.ts), and node:test runs each file in its own process, so that
// decision never leaks into another suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SignupProperties } from 'rocketride';
import { currentSignupProperties } from './signupAttribution.ts';
import { consentDecisionUnsaved, decideConsent } from '../telemetry/consentState.ts';

/** A valid signup context, live for 30 minutes from now. */
function signupContext(): SignupProperties {
	const exposedAt = Date.now();
	return {
		schema_version: 1,
		experiment: 'homepage-roulette-r1',
		experiment_revision: 'r1',
		variant_id: 'mh-1',
		assignment_id: '11111111-1111-4111-8111-111111111111',
		exposure_id: '22222222-2222-4222-8222-222222222222',
		landing_message_revision: '0123456789abcdef',
		exposed_at: exposedAt,
		expires_at: exposedAt + 30 * 60 * 1000,
		consent_version: 1,
	};
}

/** Run `fn` with a localStorage holding `records`, restoring the global after. */
function withLocalStorage(records: Array<[string, string]>, fn: () => void): void {
	const data = new Map<string, string>(records);
	const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } },
	});
	try {
		fn();
	} finally {
		if (original) Object.defineProperty(globalThis, 'localStorage', original);
		else delete (globalThis as { localStorage?: unknown }).localStorage;
	}
}

test('a decision this page could not store fails closed: no cookieless or consented context rides the redirect', () => {
	const consented = signupContext();
	const cookieless: SignupProperties = { ...consented, consent_state: 'undecided' };
	const accepted: Array<[string, string]> = [['rr:consent', JSON.stringify({ v: 1, choice: 'accepted', at: Date.now() })]];

	// Step 1: before any decision on this page, the stored record decides.
	assert.equal(consentDecisionUnsaved(), false);
	withLocalStorage([], () => {
		assert.deepEqual(currentSignupProperties(cookieless), cookieless, 'undecided: the cookieless context is allowed');
	});
	withLocalStorage(accepted, () => {
		assert.deepEqual(currentSignupProperties(consented), consented, 'accepted: the consented context is allowed');
	});

	// Step 2: the visitor declines, but the page's store has no usable storage (node: no localStorage at its
	// construction), so the decision lives in memory only, exactly like a failed write.
	decideConsent('rejected');
	assert.equal(consentDecisionUnsaved(), true);

	// Step 3: storage reads as undecided (nothing stored) or as a stale acceptance; neither may override the decline.
	withLocalStorage([], () => {
		assert.equal(currentSignupProperties(cookieless), null, 'the decline is not read back as undecided');
	});
	withLocalStorage(accepted, () => {
		assert.equal(currentSignupProperties(consented), null, 'a stale stored acceptance does not carry a consented context');
	});
});
