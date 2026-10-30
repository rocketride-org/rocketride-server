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

/** Tab-scoped, single-use signup context retained across the native OAuth redirect. */
export const SIGNUP_CONTEXT_KEY = 'rr:auth:signup';

// Written by the SaaS consent banner in localStorage. Shared schema:
// { v: 1, choice: 'accepted' | 'rejected', at: number (milliseconds since epoch) }.
// Coordinate changes with rocketride-saas; this shell only reads the record.
const CONSENT_STORAGE_KEY = 'rr_consent_v1';
const CONSENT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const CONSENT_CLOCK_SKEW_MS = 60 * 1000;
const MAX_STORED_CONTEXT_LENGTH = 2048;

function isPrivacySignal(value: unknown): boolean {
	return value === true || value === 1 || value === '1' || value === 'yes';
}

function hasConsent(): boolean {
	try {
		const browserNavigator = navigator as Navigator & { globalPrivacyControl?: unknown; msDoNotTrack?: unknown };
		const browserWindow = window as Window & { doNotTrack?: unknown };
		if (isPrivacySignal(browserNavigator.doNotTrack)) return false;
		if (isPrivacySignal(browserNavigator.msDoNotTrack)) return false;
		if (isPrivacySignal(browserNavigator.globalPrivacyControl)) return false;
		if (isPrivacySignal(browserWindow.doNotTrack)) return false;

		const consent = JSON.parse(localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null');
		if (consent?.v !== 1) return false;
		if (consent.choice !== 'accepted') return false;
		if (typeof consent.at !== 'number') return false;
		if (!Number.isFinite(consent.at)) return false;
		const now = Date.now();
		if (now - consent.at > CONSENT_LIFETIME_MS) return false;
		if (consent.at > now + CONSENT_CLOCK_SKEW_MS) return false;
		return true;
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
