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
import { consentDecisionUnsaved } from '../telemetry/consentState';

/** Tab-scoped, single-use signup context retained across the native OAuth redirect. */
export const SIGNUP_CONTEXT_KEY = 'rr:auth:signup';

const MAX_STORED_CONTEXT_LENGTH = 2048;
// Version of the OAuth state envelope `{ v, signup }` that carries a cookieless context.
const SIGNUP_STATE_VERSION = 1;

function hasPrivacySignal(): boolean {
	try {
		// The ONE privacy-signal read (rocketride/analytics): DNT, GPC and
		// their vendor spellings are decided there, nowhere else.
		return privacySignalOn();
	} catch {
		return true;
	}
}

/**
 * The visitor's choice on the SaaS consent banner, read from its record.
 *
 * The ONE consent-record parser (rocketride/analytics) owns the key, version,
 * TTL and clock-skew rules; a record it rejects reads as undecided. This page's
 * own decision comes first: one whose write failed (or that had no storage to
 * go to) lives in memory only, the stored record no longer reflects it, and it
 * would not survive the redirect either, so it shows no usable choice.
 *
 * @returns The choice of a valid, current record; 'undecided' when the record is missing, malformed or expired;
 *          null when storage cannot be read or this page's decision is not stored, which shows neither a choice
 *          nor its absence.
 */
function consentChoice(): 'accepted' | 'rejected' | 'undecided' | null {
	// Step 1: a decision this page could not store fails closed (a stored-looking 'undecided' would be a lie).
	try {
		if (consentDecisionUnsaved()) return null;
	} catch {
		return null;
	}
	// Step 2: the stored record, through the one parser.
	let raw: string | null;
	try {
		raw = localStorage.getItem(CONSENT_KEY);
	} catch {
		return null;
	}
	return parseConsent(raw, Date.now())?.choice ?? 'undecided';
}

function hasConsent(): boolean {
	if (hasPrivacySignal()) return false;
	return consentChoice() === 'accepted';
}

/**
 * Recheck consent, privacy signals and expiry at each asynchronous auth boundary.
 *
 * @param value - Untrusted signup properties to validate under current consent.
 * @returns Valid context, or null when consent, privacy, expiry or the dev gate disallows it. A cookieless
 *          context (consent_state set) is valid only while the visitor is undecided: no privacy signal and no
 *          valid, current consent record.
 */
export function currentSignupProperties(value: unknown): SignupProperties | null {
	if (isEmbeddedDevShell()) return null;
	const context = normalizeSignupProperties(value);
	if (!context) return null;
	// A cookieless context needs no opt-in, but any choice on the banner or a privacy signal drops it.
	if (context.consent_state) {
		if (hasPrivacySignal()) return null;
		if (consentChoice() !== 'undecided') return null;
		return context;
	}
	if (!hasConsent()) return null;
	return context;
}

/**
 * Retain optional context across a native redirect. Consented context stays in session storage, out of the IdP
 * URL. Cookieless context is not written to site storage; it rides the OAuth state instead (signupState), which
 * is part of the authorize URL.
 *
 * @param value - Candidate context; absent or invalid context clears a stale pending signup.
 * @returns The retained context, or null when consent, validation or storage disallows it.
 */
export function stashSignupProperties(value: unknown): SignupProperties | null {
	if (isEmbeddedDevShell()) return null;
	try {
		sessionStorage.removeItem(SIGNUP_CONTEXT_KEY);
		const context = currentSignupProperties(value);
		if (context && !context.consent_state) {
			sessionStorage.setItem(SIGNUP_CONTEXT_KEY, JSON.stringify(context));
		}
		return context;
	} catch {
		return null;
	}
}

/**
 * The OAuth state that carries a cookieless context through the identity provider and back.
 *
 * The state is base64 JSON `{ v: 1, signup }`. It is readable and unsigned: PKCE already prevents a forged
 * callback, so a forged state can only change attribution. A nonce can be added later under the same envelope.
 * Nothing is written to site storage, but the authorize URL, state included, stays in this browser's history
 * (sign-in keeps that entry with assign()) and reaches the identity provider's request logs.
 *
 * @param context - Context returned by stashSignupProperties.
 * @returns The state for a cookieless context; undefined for none or a consented one (which stays in storage).
 */
export function signupState(context: SignupProperties | null): string | undefined {
	if (!context?.consent_state) return undefined;
	return btoa(JSON.stringify({ v: SIGNUP_STATE_VERSION, signup: context }));
}

/**
 * Read a cookieless context back from the callback's OAuth state envelope (see signupState) and recheck it.
 *
 * @param state - The callback's `state` query value.
 * @returns Valid cookieless context, or null; a consented context is never accepted from the URL.
 */
export function signupFromState(state: string | null): SignupProperties | null {
	if (isEmbeddedDevShell()) return null;
	try {
		if (!state || state.length > MAX_STORED_CONTEXT_LENGTH) return null;
		const envelope = JSON.parse(atob(state));
		if (envelope?.v !== SIGNUP_STATE_VERSION) return null;
		const context = currentSignupProperties(envelope.signup);
		if (!context?.consent_state) return null;
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
