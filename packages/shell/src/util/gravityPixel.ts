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

// Gravity ad pixel — consent-gated loader.
//
// Split load (see rocketride-saas#663):
//   * index.html <head> carries only the queue shim: it defines
//     window.gravity as a call queue, makes no request, and names no
//     advertiser — so the bundle stays byte-identical across environments.
//   * bootstrap.tsx calls configureGravityPixel() with the advertiser ID from
//     the server probe. Only when THAT server advertises one, AND the visitor
//     has granted marketing consent, is the CDN script injected and init
//     queued. gr-pix.js drains window.gravity.q when it loads.
//
// Headless browsers (navigator.webdriver — the SEO prerenderer among them)
// never load the pixel or see the banner: a prerender capture freezes the
// whole document, and a baked-in script tag would ship to every visitor
// without the init that makes it work.

import { getMarketingConsent, subscribeMarketingConsent } from './marketingConsent';

export const GRAVITY_PIXEL_SRC = 'https://code.trygravity.ai/gr-pix.js';

/**
 * `<html data-rr-consent="available">` — set when this environment runs a
 * consent-gated pixel, so pages rendered by remotes (the home-ui footer's
 * "Privacy choices" link) can show consent controls without importing shell
 * internals. Absent in environments with nothing to consent to.
 */
export const CONSENT_AVAILABLE_VALUE = 'available';

/**
 * DOM event (dispatched on window) that reopens the consent banner. Remotes
 * fire it from a "Privacy choices" link; the shell's MarketingConsent owns
 * the response.
 */
export const PRIVACY_CHOICES_EVENT = 'rr:privacy-choices';

// How long to wait for the CDN script before giving up (ad blockers usually
// fire onerror at once; this covers a request that simply hangs).
const LOAD_TIMEOUT_MS = 10_000;
// After onload, how long gr-pix.js may take to expose window.gravityPixel.
const API_POLL_MS = 200;
const API_POLL_LIMIT_MS = 5_000;

type GravityFn = ((...args: unknown[]) => void) & { q?: unknown[][]; l?: number };

interface GravityWindow {
	gravity?: GravityFn;
	GravityPixelObject?: string;
	gravityPixel?: { getCAPIData?: () => unknown };
}

let advertiserId: string | null = null;
let loadState: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle';
let readyWaiters: Array<(ok: boolean) => void> = [];

function gw(): GravityWindow {
	return window as unknown as GravityWindow;
}

function isAutomatedBrowser(): boolean {
	try {
		return typeof navigator !== 'undefined' && navigator.webdriver === true;
	} catch {
		return false;
	}
}

// Same shape as the index.html shim — installed here only if the template
// lost it, so an init call is never dropped.
function ensureQueueShim(): GravityFn {
	const w = gw();
	if (typeof w.gravity !== 'function') {
		const shim: GravityFn = (...args: unknown[]) => {
			(shim.q = shim.q || []).push(args);
		};
		shim.l = Date.now();
		w.GravityPixelObject = 'gravity';
		w.gravity = shim;
	}
	return w.gravity as GravityFn;
}

function settleReady(ok: boolean): void {
	const waiters = readyWaiters;
	readyWaiters = [];
	waiters.forEach((resolve) => resolve(ok));
}

function loadPixel(): void {
	if (loadState !== 'idle' || !advertiserId) return;
	loadState = 'loading';
	ensureQueueShim()('init', advertiserId);
	try {
		const script = document.createElement('script');
		script.async = true;
		script.src = GRAVITY_PIXEL_SRC;
		script.onload = () => {
			loadState = 'loaded';
			settleReady(true);
		};
		script.onerror = () => {
			loadState = 'failed';
			settleReady(false);
		};
		document.head.appendChild(script);
	} catch {
		loadState = 'failed';
		settleReady(false);
	}
}

/**
 * Wire the pixel for this page. Called once by bootstrap with the probe's
 * `gravityAdvertiserId`; a missing ID (staging, OSS) or an automated browser
 * leaves everything off. Otherwise the script loads as soon as — and only
 * if — marketing consent is granted, now or later in the session.
 */
export function configureGravityPixel(id: string | undefined): void {
	if (!id || isAutomatedBrowser()) return;
	advertiserId = id;
	try {
		document.documentElement.dataset.rrConsent = CONSENT_AVAILABLE_VALUE;
	} catch {
		// No DOM to mark — remotes simply will not offer the link.
	}
	subscribeMarketingConsent(() => {
		if (getMarketingConsent() === 'granted') loadPixel();
	});
	if (getMarketingConsent() === 'granted') loadPixel();
}

/** True when this environment runs the pixel (and so needs a consent banner). */
export function isGravityPixelConfigured(): boolean {
	return advertiserId !== null;
}

/**
 * True once the CDN script has been injected into this page. A loaded
 * third-party script cannot be unloaded, so withdrawing consent after this
 * point needs a reload to actually stop it.
 */
export function hasGravityPixelStarted(): boolean {
	return loadState !== 'idle';
}

/**
 * Resolve once gr-pix.js has loaded and exposed `getCAPIData`, so the
 * attribution blob is readable. Resolves false when the pixel is not
 * loading (no consent / not configured), fails, or never exposes the API.
 */
export function whenGravityPixelReady(): Promise<boolean> {
	const apiReady = (): boolean => typeof gw().gravityPixel?.getCAPIData === 'function';

	const pollForApi = (): Promise<boolean> =>
		new Promise((resolve) => {
			if (apiReady()) return resolve(true);
			const started = Date.now();
			const timer = setInterval(() => {
				if (apiReady()) {
					clearInterval(timer);
					resolve(true);
				} else if (Date.now() - started >= API_POLL_LIMIT_MS) {
					clearInterval(timer);
					resolve(false);
				}
			}, API_POLL_MS);
		});

	if (loadState === 'loaded') return pollForApi();
	if (loadState !== 'loading') return Promise.resolve(false);

	return new Promise<boolean>((resolve) => {
		const timeout = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
		readyWaiters.push((ok) => {
			clearTimeout(timeout);
			if (!ok) return resolve(false);
			void pollForApi().then(resolve);
		});
	});
}

/**
 * The pixel's attribution blob (`{ user_data, client_context }`) for the
 * server's conversion events, or null when unavailable. Never throws.
 */
export function getGravityCAPIData(): Record<string, unknown> | null {
	try {
		const data = gw().gravityPixel?.getCAPIData?.();
		return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Test hook: forget the advertiser and load state. */
export function resetGravityPixelForTests(): void {
	advertiserId = null;
	loadState = 'idle';
	readyWaiters = [];
}
