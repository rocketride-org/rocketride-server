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
// DEV GATE
// =============================================================================

// Computed once on first read, never re-read (the gate must not flip while
// the shell runs — a mid-session change would strand half-installed hooks).
let gateResult: boolean | undefined;

/**
 * Whether dev hooks are enabled for this shell session.
 *
 * A BUILD-TIME capability and nothing else: true only in a development build
 * (NODE_ENV !== 'production' — `rsbuild dev`, or the stitched dev FLAVOR that
 * the App Builder previews run). A production build bakes NODE_ENV to
 * 'production', so this is constant-false there: no URL parameter
 * (`?rrdev=1`) and no sessionStorage flag ('rr:dev') can turn the hooks on.
 * Those only SELECT the dev flavor's assets in index.html's flavor picker
 * (scripts/stitch-flavors.mjs); they are never read as a capability here.
 * Even when the hooks are on, every inbound `rrdev:*` message is still
 * vetted by isTrustedEmbedderMessage().
 *
 * Read once at first call and cached.
 *
 * @returns True when dev hooks should be installed.
 */
export function isDevHooksEnabled(): boolean {
	if (gateResult === undefined) {
		gateResult = process.env.NODE_ENV !== 'production';
	}
	return gateResult;
}

/**
 * TEST-ONLY: forget the cached gate so a test can stage its own
 * build mode. Production code never calls this — the gate must stay frozen
 * for the life of a real shell session.
 */
export function resetDevGateForTests(): void {
	gateResult = undefined;
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

// =============================================================================
// TRUSTED EMBEDDER (WHO MAY DRIVE THE DEV HOOKS)
// =============================================================================
//
// The `rrdev:*` protocol (rrdev:auth hands the shell a SESSION TOKEN,
// rrdev:registerRemote makes it load and run a script) is a privileged
// channel. The legitimate senders are exactly two:
//   - the VS Code extension's App Builder webview (apps/vscode,
//     AppWebview.tsx → PreviewFrame): the shell is an iframe inside a
//     `vscode-webview://<id>` document; and
//   - the web App Builder's same-origin preview iframe (parent origin ==
//     the shell's own origin).
// Both embed the shell, so the sender is always `window.parent`. A loopback
// origin (a locally served embedder, e.g. a dev server on localhost) is also
// accepted. Anything else — any website that opened this page (window.opener),
// framed it from another origin, or merely knows the URL — is hostile.

/**
 * Whether a hostname is loopback: `localhost`, `*.localhost`, 127.0.0.0/8 or
 * [::1]. Anchored on the WHOLE hostname so `localhost.evil.test` and
 * `127.0.0.1.evil.test` do not match.
 */
function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether `origin` (a `MessageEvent.origin`) is an expected dev embedder for
 * a shell served from `shellOrigin`:
 *   - the shell's own origin (the web App Builder's same-origin preview);
 *   - `vscode-webview://<id>` (the VS Code extension's webview);
 *   - a loopback http(s) origin on any port (a locally served embedder).
 * Opaque origins ('null'), unparsable values and everything else are refused.
 *
 * @param origin - The sender's origin as reported by the browser.
 * @param shellOrigin - This shell's own origin (`window.location.origin`).
 * @returns True when the origin may drive the dev hooks.
 */
export function isAllowedEmbedderOrigin(origin: string, shellOrigin: string): boolean {
	if (!origin || origin === 'null') return false;
	if (shellOrigin && shellOrigin !== 'null' && origin === shellOrigin) return true;
	let url: URL;
	try { url = new URL(origin); } catch { return false; }
	// Non-special scheme: the URL parser reports origin 'null', so compare the
	// string itself — it must be exactly `vscode-webview://<host>`, no path.
	if (url.protocol === 'vscode-webview:') return url.host.length > 0 && origin === `vscode-webview://${url.host}`;
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	// `origin` must BE an origin, not a URL that merely starts like one.
	if (url.origin !== origin) return false;
	return isLoopbackHostname(url.hostname);
}

/**
 * Whether a postMessage may drive the dev hooks (`rrdev:*`). All of:
 *   1. dev hooks are enabled in this build (never true in production);
 *   2. this shell is EMBEDDED (`window.self !== window.top`) — a top-level tab
 *      has no embedder, so a message there can only come from an opener or a
 *      frame the page itself created;
 *   3. the sender is this shell's PARENT window — not window.opener, not a
 *      sibling, not a child frame;
 *   4. the sender's origin is an expected embedder (isAllowedEmbedderOrigin).
 *
 * @param e - The message event (only `origin` and `source` are read).
 * @returns True when the message came from the trusted embedder.
 */
export function isTrustedEmbedderMessage(e: { origin: string; source: unknown }): boolean {
	try {
		if (!isDevHooksEnabled()) return false;
		if (window.self === window.top) return false;
		if (!e.source || e.source !== window.parent) return false;
		return isAllowedEmbedderOrigin(e.origin, window.location.origin);
	} catch { return false; }
}

/**
 * The embedder's origin as far as the browser reveals it (`ancestorOrigins`
 * where supported, else the referrer), or '' when unknown. Used to AIM
 * outbound dev traffic (console forwarding) at the embedder instead of
 * broadcasting it to whoever happens to be the parent.
 *
 * @returns The parent frame's origin when it is an allowed embedder, else ''.
 */
export function trustedParentOrigin(): string {
	try {
		if (!isDevHooksEnabled() || window.self === window.top) return '';
		const ancestors = (window.location as { ancestorOrigins?: ArrayLike<string> }).ancestorOrigins;
		let origin = ancestors && ancestors.length > 0 ? ancestors[0] : '';
		if (!origin && document.referrer) origin = new URL(document.referrer).origin;
		return isAllowedEmbedderOrigin(origin, window.location.origin) ? origin : '';
	} catch { return ''; }
}

/**
 * Whether a dev-remote entry URL (`rrdev:registerRemote`) may be loaded: an
 * ABSOLUTE http(s) URL, no credentials, on a loopback host — the embedder's
 * own rsbuild dev server. Protocol-relative (`//host/x.js`), `javascript:`,
 * `data:`, relative and non-loopback hosts are refused.
 *
 * @param entry - The remoteEntry.js URL as received.
 * @returns True when the shell may register it as a Module Federation remote.
 */
export function isAllowedDevRemoteEntry(entry: string): boolean {
	if (typeof entry !== 'string') return false;
	let url: URL;
	try { url = new URL(entry); } catch { return false; }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	if (url.username || url.password) return false;
	return isLoopbackHostname(url.hostname);
}

// =============================================================================
// TOKEN STORAGE SCOPE
// =============================================================================

// Frame-local token slot for embedded dev previews. Deliberately NOT
// sessionStorage: per WHATWG, same-origin sibling iframes inside one
// top-level browsing context SHARE a session storage area, so two preview
// panels on one page could still overwrite or clear each other's token
// there. A module-level map is scoped to this frame's JS realm — the only
// truly per-frame slot the platform offers — and needs no persistence:
// the embedder re-answers `rrdev:auth` on every boot, so a reloaded frame
// re-adopts its session instead of reading it back from storage.
const frameTokenStore: Storage = (() => {
	const data = new Map<string, string>();
	return {
		get length(): number { return data.size; },
		clear: (): void => { data.clear(); },
		getItem: (key: string): string | null => data.get(key) ?? null,
		key: (index: number): string | null => Array.from(data.keys())[index] ?? null,
		removeItem: (key: string): void => { data.delete(key); },
		setItem: (key: string, value: string): void => { data.set(key, value); },
	};
})();

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
