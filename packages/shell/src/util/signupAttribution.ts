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

import { isEmbeddedDevShell } from './devGate';
import { normalizeSignupProperties, type SignupProperties } from 'rocketride';
import { CONSENT_KEY, parseConsent, privacySignalOn } from 'rocketride/analytics';

/** Tab-scoped, single-use signup context retained across the native OAuth redirect. */
export const SIGNUP_CONTEXT_KEY = 'rr:auth:signup';

const MAX_STORED_CONTEXT_LENGTH = 2048;

function hasConsent(): boolean {
	try {
		// The ONE privacy-signal read and the ONE consent-record parser
		// (rocketride/analytics): signals, key, version, TTL and clock-skew
		// rules live there, nowhere else.
		if (privacySignalOn()) return false;
		return parseConsent(localStorage.getItem(CONSENT_KEY), Date.now())?.choice === 'accepted';
	} catch {
		return false;
	}
}

/**
 * Recheck consent, privacy signals and expiry at each asynchronous auth boundary.
 *
 * @param value - Untrusted signup properties to validate under current consent.
 * @returns Valid context, or null when consent, privacy, expiry or the dev gate disallows it.
 */
export function currentSignupProperties(value: unknown): SignupProperties | null {
	if (isEmbeddedDevShell()) return null;
	if (!hasConsent()) return null;
	return normalizeSignupProperties(value);
}

/**
 * Retain optional context across a native redirect without putting metadata in the IdP URL.
 *
 * @param value - Candidate context; absent or invalid context clears a stale pending signup.
 * @returns The retained context, or null when consent, validation or storage disallows it.
 */
export function stashSignupProperties(value: unknown): SignupProperties | null {
	if (isEmbeddedDevShell()) return null;
	try {
		sessionStorage.removeItem(SIGNUP_CONTEXT_KEY);
		const context = currentSignupProperties(value);
		if (context) {
			sessionStorage.setItem(SIGNUP_CONTEXT_KEY, JSON.stringify(context));
		}
		return context;
	} catch {
		return null;
	}
}

/**
 * Discard pending analytics context without reading or validating it.
 *
 * @returns Nothing; unavailable optional storage does not interrupt authentication.
 */
export function clearSignupProperties(): void {
	if (isEmbeddedDevShell()) return;
	try {
		sessionStorage.removeItem(SIGNUP_CONTEXT_KEY);
	} catch {
		// Optional analytics storage must not prevent authentication.
	}
}

/**
 * Consume pending context once after the identity provider round trip and recheck consent.
 *
 * @returns Valid context, or null when storage, consent or validation disallows it.
 */
export function takeSignupProperties(): SignupProperties | null {
	if (isEmbeddedDevShell()) return null;
	try {
		const raw = sessionStorage.getItem(SIGNUP_CONTEXT_KEY);
		sessionStorage.removeItem(SIGNUP_CONTEXT_KEY);
		if (!raw) return null;
		if (raw.length > MAX_STORED_CONTEXT_LENGTH) return null;
		return currentSignupProperties(JSON.parse(raw));
	} catch {
		return null;
	}
}
