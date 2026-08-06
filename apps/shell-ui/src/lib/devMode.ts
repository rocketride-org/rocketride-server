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

/**
 * Dev-mode hooks for app development (the App Builder inner loop).
 *
 * Gives embedders (the web App Builder's same-origin preview iframe, the
 * VSCode preview, or a developer at the browser console) a supported way to:
 *   - inject a locally built/linked app into the running shell WITHOUT
 *     Module Federation (registerLocalApp),
 *   - evict a cached descriptor so the app remounts fresh (invalidateApp),
 *   - obtain the host's live shared modules (getShareScope) so a dev-linked
 *     app resolves react/shell-ui/shared to the SAME instances a bundled
 *     app would get from the MF share scope.
 *
 * Everything here is inert unless dev hooks are enabled: a development build
 * (NODE_ENV !== 'production') or an explicit `rrdev=1` URL parameter. The
 * URL form exists so the App Builder previews can enable hooks against a
 * production-built shell served by a local engine.
 */

import React from 'react';
import * as ReactDom from 'react-dom';
import { ConnectionManager } from '../connection/connection';
import { registerLocalApp, unregisterLocalApp, invalidateAppDescriptor, registerDevRemote } from './appLoader';

// =============================================================================
// TYPES
// =============================================================================

/**
 * The dev API installed on window.__rrShellDev when dev hooks are enabled.
 * Consumed by same-origin embedders via iframe.contentWindow.__rrShellDev.
 */
export interface RrShellDevApi {
	/** API version — bump on breaking changes so embedders can feature-gate. */
	version: 1;
	/** Registers a local descriptor loader for an app (see appLoader). */
	registerLocalApp: typeof registerLocalApp;
	/** Removes a local descriptor loader (see appLoader). */
	unregisterLocalApp: typeof unregisterLocalApp;
	/** Evicts an app's cached descriptor; active apps reload + remount. */
	invalidateApp: typeof invalidateAppDescriptor;
	/** Returns the host's live shared modules (react, react-dom, shell-ui, shared). */
	getShareScope: () => Record<string, unknown> | undefined;
}

declare global {
	interface Window {
		/** Dev hooks API — present only when dev hooks are enabled. */
		__rrShellDev?: RrShellDevApi;
	}
}

// =============================================================================
// DEV GATE
// =============================================================================

// Computed once on first read, never re-read (the gate must not flip while
// the shell runs — a mid-session change would strand half-installed hooks).
let gateResult: boolean | undefined;

/**
 * Whether dev hooks are enabled for this shell session.
 *
 * True when this is a development build (NODE_ENV !== 'production') OR the
 * page URL carries `rrdev=1`. Read once at first call and cached.
 *
 * @returns True when dev hooks should be installed.
 */
export function isDevHooksEnabled(): boolean {
	if (gateResult === undefined) {
		let urlFlag = false;
		try {
			urlFlag = new URLSearchParams(window.location.search).get('rrdev') === '1';
			// The OAuth redirect URI is the bare origin, so `rrdev=1` does not
			// survive the round trip — index.html's flavor picker persists the
			// choice per tab ('rr:dev'), and the gate honors the same flag so
			// the flavor and the hooks can never disagree.
			if (!urlFlag) urlFlag = sessionStorage.getItem('rr:dev') === '1';
		} catch { /* no window/location (tests) — build-mode gate only */ }
		gateResult = process.env.NODE_ENV !== 'production' || urlFlag;
	}
	return gateResult;
}

// =============================================================================
// EMBEDDED SESSION HANDSHAKE
// =============================================================================

// The embedder answers this shell's `shell:devReady` with its definitive
// session state (`rrdev:auth` — a token to adopt, or empty for "no session").
// The FIRST such answer lands while the shell still shows its loading screen:
// bootstrap holds behind waitForEmbeddedSession() so the initial boot comes up
// already authenticated instead of flashing the sign-in gate and rebooting
// when the token arrives. The promise is created synchronously in
// installDevHooks() BEFORE anything is posted to the embedder, so an answer
// can never race the shell's wait.

/** Resolves the boot-window answer; null once the window has closed. */
let bootAnswerResolve: ((token: string | null) => void) | null = null;
/** The pending boot-window answer; null until installDevHooks() runs. */
let bootAnswerPromise: Promise<string | null> | null = null;

/**
 * Settles the boot-window answer exactly once.
 *
 * @param token - The adopted token, or null for "no session".
 * @returns True when this call closed the boot window; false when it was
 *          already closed (the caller must reconcile by other means).
 */
function settleBootAnswer(token: string | null): boolean {
	if (!bootAnswerResolve) return false;
	const resolve = bootAnswerResolve;
	bootAnswerResolve = null;
	resolve(token);
	return true;
}

/**
 * Waits for the embedder's session answer before the first boot.
 *
 * Resolves with the adopted token, or null when the embedder answered "no
 * session" — or when the fallback timeout fires (an embedder that does not
 * speak the App Builder protocol never answers). The timeout CLOSES the boot
 * window: a late answer must then reload into its state (the boot already
 * completed without it) rather than being silently swallowed.
 *
 * Resolves immediately when this shell is not an embedded dev preview.
 *
 * @param timeoutMs - Grace period for protocol-less embedders.
 * @returns The embedder-supplied token, or null.
 */
export function waitForEmbeddedSession(timeoutMs: number): Promise<string | null> {
	// Not framed, hooks off, or hooks not installed — nothing will answer.
	if (!isDevHooksEnabled() || window.self === window.top || !bootAnswerPromise) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		// Fallback for embedders without the protocol: close the window and
		// proceed unauthenticated after the grace period.
		const timer = window.setTimeout(() => {
			settleBootAnswer(null);
		}, timeoutMs);
		void bootAnswerPromise?.then((token) => {
			window.clearTimeout(timer);
			resolve(token);
		});
	});
}

// =============================================================================
// DEV SHARE SCOPE + WINDOW API INSTALL
// =============================================================================

/**
 * Global key for the dev share scope. Anchored on globalThis with the same
 * idiom as the ConnectionManager singleton (connection.ts): under Module
 * Federation a duplicated copy of this module would otherwise hold its own
 * module-level scope object, and embedders reading through a different copy
 * would see nothing. Reflect accepts symbol keys without unsafe casts.
 */
const DEV_SHARE_SCOPE_KEY = Symbol.for('rocketride.devShareScope');

/**
 * Installs the dev hooks: anchors the dev share scope, exposes
 * window.__rrShellDev, and notifies a parent embedder via postMessage.
 *
 * No-ops (and exposes nothing on window/globalThis) when the dev gate is
 * off. Called once from bootstrap after the probe registers the app
 * manifest. The barrels are imported dynamically so the install stays fully
 * async and the gate check costs nothing in production flows.
 */
export async function installDevHooks(): Promise<void> {
	// Gate: everything below is dev-only surface.
	if (!isDevHooksEnabled()) return;

	// Open the boot-window answer BEFORE the first await: bootstrap may call
	// waitForEmbeddedSession() as soon as React mounts, and the promise must
	// exist by then (see the handshake section above).
	if (!bootAnswerPromise) {
		bootAnswerPromise = new Promise((resolve) => { bootAnswerResolve = resolve; });
	}

	// Resolve the SAME live modules the MF share scope hands to real apps:
	// shell-ui's public barrel (src/index.ts — the module rsbuild shares as
	// 'shell-ui') and the shared-ui barrel. A dev-linked app and a bundled
	// app must see identical API objects.
	const [shellUi, shared] = await Promise.all([
		import('../index'),
		import('shared'),
	]);

	// Anchor the share scope on globalThis (see DEV_SHARE_SCOPE_KEY note).
	const scope: Record<string, unknown> = {
		'react': React,
		'react-dom': ReactDom,
		'shell-ui': shellUi,
		'shared': shared,
	};
	Reflect.set(globalThis, DEV_SHARE_SCOPE_KEY, scope);

	// Expose the dev API for same-origin embedders and the browser console.
	window.__rrShellDev = {
		version: 1,
		registerLocalApp,
		unregisterLocalApp,
		invalidateApp: invalidateAppDescriptor,
		getShareScope: () => Reflect.get(globalThis, DEV_SHARE_SCOPE_KEY) as Record<string, unknown> | undefined,
	};

	// Embedded previews: mirror this shell's console + errors to the parent
	// embedder so hosts without same-origin access (the VSCode webview) can
	// render them in the App Builder's Console/Errors panes. postMessage is
	// origin-agnostic, so this is the one channel that works everywhere.
	installConsoleForwarding();

	// Embedded previews: accept dev-remote registrations and session state
	// from the embedder. The App Builder panel KNOWS its rsbuild dev server's
	// address — it posts it here and this shell wires the remote itself.
	// rrdev:auth carries the embedder's DEFINITIVE session state: a token to
	// adopt (the VSCode host's own credential) or empty for "no session"
	// (signed out, or Inherit Auth off). One message covers grant and revoke —
	// there is no separate clear message.
	window.addEventListener('message', (e: MessageEvent) => {
		const data = e.data as { type?: string; appId?: string; moduleId?: string; name?: string; entry?: string; token?: string } | undefined;
		if (data?.type === 'rrdev:registerRemote') {
			if (!data.appId || !data.moduleId || !data.entry) return;
			registerDevRemote(data.appId, data.moduleId, data.name || data.appId, data.entry);
		} else if (data?.type === 'rrdev:auth' && typeof data.token === 'string') {
			const cm = ConnectionManager.getInstance();
			// loadToken() yields '' when absent, so '' compares as "no session"
			// on both sides of the protocol.
			if (cm.loadToken() === data.token) {
				// Already in the answered state — just release a pending boot
				// wait; on later re-answers (re-inject, toggle no-op) this is
				// a no-op.
				settleBootAnswer(data.token || null);
				return;
			}
			if (data.token) cm.saveToken(data.token); else cm.clearToken();
			if (settleBootAnswer(data.token || null)) {
				// Boot-window answer: bootstrap is still holding behind the
				// loading screen and proceeds straight into the new state —
				// no reload, no sign-in flash.
				console.log(`[devMode] embedder session ${data.token ? 'received' : 'empty'} — continuing boot`);
			} else {
				// Post-boot change (Inherit Auth toggled, explicit sign-in,
				// late credential): reboot into the new state exactly once —
				// after the reload the states match and this is a no-op.
				console.log(`[devMode] embedder session ${data.token ? 'received' : 'cleared'} — rebooting`);
				window.location.reload();
			}
		}
	});

	// Tell a parent embedder the hooks are ready so it doesn't have to poll.
	try {
		window.parent?.postMessage({ type: 'shell:devReady' }, '*');
	} catch { /* sandboxed/parentless — console users just call the API */ }

	console.log('[devMode] Dev hooks installed (window.__rrShellDev)');

	// Boot forensics for embedded previews: the href reveals WHY this boot
	// happened (?code= OAuth return, stripped params, plain reload) and the
	// unload hook reveals WHEN something navigates the page away — both
	// mirrored to the embedder's Console pane by the forwarding above.
	if (window.parent !== window) {
		// flavor= identifies WHICH shell build booted (dev = development React
		// with refresh hooks) — the first thing to check when HMR misbehaves.
		console.log(`[devMode] boot flavor=${process.env.NODE_ENV} href=${window.location.href} referrer=${document.referrer || '(none)'}`);
		window.addEventListener('beforeunload', () => {
			console.warn(`[devMode] page unloading from ${window.location.href}`);
		});
	}
}

// =============================================================================
// CONSOLE FORWARDING (EMBEDDED PREVIEWS)
// =============================================================================

/**
 * Wraps console.log/warn/error and taps window error events, forwarding each
 * entry to the parent embedder as `shell:devConsole` / `shell:devError`
 * postMessages. Installed only when dev hooks are on AND the shell is
 * actually embedded (window.parent !== window) — a top-level dev shell
 * forwards nothing.
 */
function installConsoleForwarding(): void {
	if (window.parent === window) return;

	/** Serializes one console argument (objects JSON-ified, cycles tagged). */
	const asText = (value: unknown): string => {
		if (typeof value === 'string') return value;
		// Errors JSON-stringify to {} — their message/stack are non-enumerable.
		// Losing them cost a debugging session; never again.
		if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return String(value);
		}
	};

	/** Posts one row to the embedder; never throws into app code. */
	const forward = (type: string, payload: Record<string, unknown>): void => {
		try {
			window.parent.postMessage({ type, ...payload }, '*');
		} catch { /* embedder gone — drop the row */ }
	};

	// Wrap the three mirrored levels; every other console method stays native
	for (const level of ['log', 'warn', 'error'] as const) {
		const native = console[level].bind(console);
		console[level] = (...args: unknown[]): void => {
			native(...args);
			forward('shell:devConsole', { level, text: args.map(asText).join(' ').slice(0, 2000) });
		};
	}

	// Uncaught errors + unhandled rejections → the Errors pane
	window.addEventListener('error', (e) => {
		forward('shell:devError', { message: e.message, source: e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : undefined });
	});
	window.addEventListener('unhandledrejection', (e) => {
		forward('shell:devError', { message: `Unhandled rejection: ${asText(e.reason instanceof Error ? e.reason.message : e.reason)}` });
	});
}
