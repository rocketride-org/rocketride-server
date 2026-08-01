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
		} catch { /* no window/location (tests) — build-mode gate only */ }
		gateResult = process.env.NODE_ENV !== 'production' || urlFlag;
	}
	return gateResult;
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

	// Embedded previews: accept dev-remote registrations from the embedder.
	// The App Builder panel KNOWS its rsbuild dev server's address — it posts
	// it here and this shell wires the remote itself. No server overlay, no
	// environment coupling: whatever shell the preview shows, it previews.
	window.addEventListener('message', (e: MessageEvent) => {
		const data = e.data as { type?: string; appId?: string; moduleId?: string; name?: string; entry?: string } | undefined;
		if (data?.type !== 'rrdev:registerRemote') return;
		if (!data.appId || !data.moduleId || !data.entry) return;
		registerDevRemote(data.appId, data.moduleId, data.name || data.appId, data.entry);
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
		console.log(`[devMode] boot href=${window.location.href} referrer=${document.referrer || '(none)'}`);
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
