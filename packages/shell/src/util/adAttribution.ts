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

// Cookieless ad attribution — first-party capture, no third-party script.
//
// The ad network's pixel is deliberately NOT used (rocketride-ai/rocketride-saas#663):
// it sets cookies, writes localStorage and fingerprints the browser (canvas,
// WebGL, fonts, audio) with no way to turn any of it off. All we actually need
// is the ad-click reference the ad already put in the landing URL.
//
// So: read the allowlisted click params out of location.search into MEMORY,
// carry them across the OAuth redirect inside the `state` parameter (which
// round-trips verbatim, so nothing is written to the device), and hand them to
// the server once the user is signed in and has granted marketing consent. The
// server reports conversions itself (Conversions API).
//
// NOTHING here touches cookies, localStorage or sessionStorage. The only thing
// the shell persists is the consent decision itself (see marketingConsent.ts).
//
// The visitor is opted out entirely — no capture, no banner — when the browser
// is automated (the SEO prerenderer) or sends Global Privacy Control.

/**
 * `<html data-rr-consent="available">` — set where this environment runs ad
 * attribution, so pages rendered by remotes (the home-ui footer's "Privacy
 * choices" link) can offer consent controls without importing shell internals.
 */
export const CONSENT_AVAILABLE_VALUE = 'available';

/**
 * DOM event (dispatched on window) that reopens the consent banner. Remotes
 * fire it from a "Privacy choices" link; the shell's MarketingConsent owns the
 * response.
 */
export const PRIVACY_CHOICES_EVENT = 'rr:privacy-choices';

/**
 * The ad-click parameters we carry. Exactly the keys the provider's own pixel
 * reads off the landing URL — nothing derived from the device.
 */
const CLICK_PARAM_KEYS = ['grclid', 'grcpid', 'grpuid', 'gradid', 'grsig', 'graid'] as const;

// Opaque provider-issued references: url-safe token characters only. Anything
// else is not one of theirs, so it is dropped rather than relayed onward.
const VALUE_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,256}$/;

export type ClickParams = Partial<Record<(typeof CLICK_PARAM_KEYS)[number], string>>;

let provider: string | null = null;
let clickParams: ClickParams = {};

function isOptedOutBrowser(): boolean {
	try {
		if (typeof navigator === 'undefined') return false;
		// Headless/automation (the prerenderer): never capture, never render a
		// banner — a capture freezes the whole document and would ship it.
		if (navigator.webdriver === true) return true;
		// Global Privacy Control — a legally recognised opt-out signal in some
		// US states. Treat it as a standing refusal.
		return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
	} catch {
		return false;
	}
}

function pickClickParams(params: URLSearchParams): ClickParams {
	const picked: ClickParams = {};
	for (const key of CLICK_PARAM_KEYS) {
		const value = params.get(key);
		if (value && VALUE_PATTERN.test(value)) picked[key] = value;
	}
	return picked;
}

/**
 * Wire attribution for this page. Called once from bootstrap with the probe's
 * `attributionProvider`; absent (staging, OSS) or an opted-out browser leaves
 * everything off, banner included.
 */
export function configureAttribution(name: string | undefined): void {
	if (!name || isOptedOutBrowser()) return;
	provider = name;
	try {
		document.documentElement.dataset.rrConsent = CONSENT_AVAILABLE_VALUE;
	} catch {
		// No DOM to mark — remotes simply will not offer the link.
	}
}

/** True where this environment runs ad attribution (and so needs a banner). */
export function isAttributionConfigured(): boolean {
	return provider !== null;
}

/** The attribution provider's name, or null. */
export function getAttributionProvider(): string | null {
	return provider;
}

/**
 * Read the ad-click reference into memory.
 *
 * Runs in bootstrap BEFORE the OAuth callback strips the query string, and
 * handles both arrivals: a fresh ad click (params on the landing URL) and the
 * return leg from the identity provider (`?state=`). Params already captured
 * on this page are never overwritten, so an in-app navigation cannot erase
 * them. Never throws.
 */
export function captureClickParams(): void {
	if (isOptedOutBrowser()) return;
	try {
		const params = new URLSearchParams(window.location.search);
		const fromUrl = pickClickParams(params);
		if (Object.keys(fromUrl).length > 0) {
			if (Object.keys(clickParams).length === 0) clickParams = fromUrl;
			return;
		}
		const state = params.get('state');
		if (state && Object.keys(clickParams).length === 0) {
			clickParams = decodeAttributionState(state);
		}
	} catch {
		// A malformed URL is not worth a broken boot.
	}
}

/** The captured ad-click reference for this page (possibly empty). */
export function getClickParams(): ClickParams {
	return { ...clickParams };
}

/**
 * Encode the captured params for the OAuth `state` parameter, or null when
 * there is nothing to carry. `state` round-trips verbatim through the identity
 * provider, which is how the reference survives the redirect with no storage.
 */
export function encodeAttributionState(): string | null {
	if (Object.keys(clickParams).length === 0) return null;
	try {
		const json = JSON.stringify(clickParams);
		// base64url so the value is opaque and needs no extra URL escaping.
		return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	} catch {
		return null;
	}
}

/**
 * Decode an OAuth `state` value back into click params.
 *
 * `state` comes back through the browser, so it is treated as untrusted input:
 * the same allowlist and value pattern apply, and anything malformed decodes
 * to an empty object rather than throwing.
 */
export function decodeAttributionState(state: string): ClickParams {
	try {
		const padded = state.replace(/-/g, '+').replace(/_/g, '/');
		const decoded = JSON.parse(atob(padded)) as Record<string, unknown>;
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(decoded)) {
			if (typeof value === 'string') params.set(key, value);
		}
		return pickClickParams(params);
	} catch {
		return {};
	}
}

/** Test hook: forget the provider and any captured params. */
export function resetAdAttributionForTests(): void {
	provider = null;
	clickParams = {};
}
