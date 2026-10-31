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
 * The dev gate and the token-scope policy derived from it.
 *
 * A LEAF module (no shell imports): the ConnectionManager and the dev-mode
 * hooks both need these predicates, and devMode.ts already imports the
 * ConnectionManager — the gate lives below both so neither import direction
 * can cycle.
 */

// =============================================================================
// INJECTED DEV BOOT CONFIG
// =============================================================================

/**
 * The dev boot config an AUTHORING embedder injects into the page it serves —
 * the web App Builder's blob-authored preview pages (iframe and debug tab),
 * and any dev server that templates the HTML it proxies. Presence of the
 * config IS the dev signal: no `rrdev=1`, no URL convention, no probe — the
 * party that serves the page states the facts in the page.
 */
export interface DevBootConfig {
	/** The app under development — the page's session-locked identity. */
	appId: string;
}

declare global {
	interface Window {
		/** Injected dev boot config — present only on authored dev pages. */
		__rrDevBoot?: DevBootConfig;
	}
}

/**
 * The injected dev boot config, or null when this page was not authored by
 * a dev embedder. Validated shape: a non-empty string appId.
 *
 * @returns The config, or null.
 */
export function devBootConfig(): DevBootConfig | null {
	try {
		const raw = window.__rrDevBoot;
		if (raw && typeof raw === 'object' && typeof raw.appId === 'string' && raw.appId) return raw;
	} catch { /* no window (tests) */ }
	return null;
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
 * True when this is a development build (NODE_ENV !== 'production'), the
 * page URL carries `rrdev=1`, or the page carries an injected dev boot
 * config (an authored preview page). Read once at first call and cached.
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
		gateResult = process.env.NODE_ENV !== 'production' || urlFlag || devBootConfig() !== null;
	}
	return gateResult;
}

/**
 * TEST-ONLY: forget the cached gate so a test can stage its own
 * window/`rrdev` environment. Production code never calls this — the gate
 * must stay frozen for the life of a real shell session.
 */
export function resetDevGateForTests(): void {
	gateResult = undefined;
}

// =============================================================================
// FRAMED SHELL
// =============================================================================

/**
 * Whether this shell runs FRAMED (inside a same-origin iframe) — the App
 * Builder previews (live AND built) are the platform's framed shells. The
 * built preview matters here: it boots WITHOUT rrdev (a production shell
 * serving an immutable version), so the dev gate cannot identify it — but
 * it still shares the tab's sessionStorage with the top shell, and tab
 * session state it writes (session lock, pending app, version override)
 * would leak into the top shell's next boot exactly like the dev preview's.
 *
 * @returns True when the shell is not the top-level browsing context.
 */
export function isFramedShell(): boolean {
	try {
		return window.self !== window.top;
	} catch { return true; }
}

// =============================================================================
// EMBEDDED DEV SHELL
// =============================================================================

/**
 * Whether this shell is an EMBEDDED dev preview — the App Builder's iframe
 * (web or VSCode) — as opposed to a top-level tab that merely has dev hooks
 * on (shell:dev in a browser, an F5 external-browser preview).
 *
 * The distinction matters because an embedded preview takes its session from
 * its embedder: the `rrdev:auth` answer is definitive, which changes the
 * session-scope rules (see tokenStore).
 *
 * @returns True when dev hooks are on AND the shell runs framed.
 */
export function isEmbeddedDevShell(): boolean {
	try {
		return isDevHooksEnabled() && window.self !== window.top;
	} catch { return false; }
}

/**
 * Whether this shell is framed by a SAME-ORIGIN embedder (the web App
 * Builder's preview iframe lives on the cloud shell's own origin). A
 * cross-origin embedder (the VS Code webview framing the preview served
 * from its app's dev-proxy origin) makes the parent's location unreadable —
 * the throw IS the signal.
 *
 * The distinction gates origin-wide side effects: a same-origin embed
 * shares the embedding user's cookie jar and must not stamp it, while a
 * cross-origin embed owns its jar outright.
 *
 * @returns True when framed and the embedder shares this page's origin.
 */
export function isSameOriginEmbed(): boolean {
	try {
		return window.self !== window.top && window.parent.location.origin === window.location.origin;
	} catch { return false; }
}

// =============================================================================
// TOKEN STORAGE SCOPE
// =============================================================================

/**
 * Builds a frame-local Storage shim. Deliberately NOT sessionStorage: per
 * WHATWG, same-origin sibling iframes inside one top-level browsing context
 * SHARE a session storage area, so two frames on one page could still
 * overwrite or clear each other's state there. A module-level map is scoped
 * to this frame's JS realm — the only truly per-frame slot the platform
 * offers — and dies with the frame's document.
 */
function createFrameStore(): Storage {
	const data = new Map<string, string>();
	return {
		get length(): number { return data.size; },
		clear: (): void => { data.clear(); },
		getItem: (key: string): string | null => data.get(key) ?? null,
		key: (index: number): string | null => Array.from(data.keys())[index] ?? null,
		removeItem: (key: string): void => { data.delete(key); },
		setItem: (key: string, value: string): void => { data.set(key, value); },
	};
}

// Frame-local token slot for embedded dev previews. Needs no persistence:
// the embedder re-answers `rrdev:auth` on every boot, so a reloaded frame
// re-adopts its session instead of reading it back from storage.
const frameTokenStore: Storage = createFrameStore();

// Frame-local tab-session slot for FRAMED shells (see sessionScopedStore).
const frameSessionStore: Storage = createFrameStore();

/**
 * The storage backing this shell's session token.
 *
 * Embedded dev previews keep a FRAME-LOCAL in-memory copy: each panel's
 * embedder is the sole session authority, so panels must neither share nor
 * be able to clear another context's token — two panels with divergent
 * auth states writing one shared slot cross-fire each other's storage
 * watchers and reload each other forever, and even sessionStorage is
 * shared between same-origin sibling iframes in one top-level browsing
 * context (see frameTokenStore). Real tabs keep the shared localStorage
 * slot so a sign-in propagates across tabs and survives restarts.
 *
 * @returns The Storage object all token reads/writes must go through.
 */
export function tokenStore(): Storage {
	return isEmbeddedDevShell() ? frameTokenStore : localStorage;
}

/**
 * The storage backing TAB-SESSION state (session-locked app id, pending
 * OAuth app id, version overrides).
 *
 * FRAMED shells get a frame-local in-memory copy: the tab's sessionStorage
 * is shared across every same-origin frame, so a preview iframe writing
 * these keys stamps the TOP shell's next boot — a working-copy session
 * lock resolves to "App not found", and a built-preview `?version=` seed
 * silently outranks the top shell's (and the live preview's) dev overlay.
 * A framed shell needs none of the persistence these keys exist for: its
 * identity rides its URL, which survives every iframe reload.
 *
 * Top-level shells keep real sessionStorage so deep links and the OAuth
 * redirect round-trip behave exactly as before.
 *
 * @returns The Storage object tab-session reads/writes must go through.
 */
export function sessionScopedStore(): Storage {
	return isFramedShell() ? frameSessionStore : sessionStorage;
}
