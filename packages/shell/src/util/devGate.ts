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
 * The dev gate and the session-storage scope policy derived from it.
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

/**
 * TEST-ONLY: forget the cached gate so a test can stage its own
 * window/`rrdev` environment. Production code never calls this — the gate
 * must stay frozen for the life of a real shell session.
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
// TOKEN STORAGE SCOPE
// =============================================================================

/**
 * The storage backing this shell's session token.
 *
 * Embedded dev previews keep a PER-CONTEXT copy (sessionStorage): each
 * panel's embedder is the sole session authority, so panels must neither
 * share nor be able to clear the origin-wide token — two panels with
 * divergent auth states writing one shared slot cross-fire each other's
 * storage watchers and reload each other forever. Real tabs keep the shared
 * localStorage slot so a sign-in propagates across tabs and survives
 * restarts.
 *
 * @returns The Storage object all token reads/writes must go through.
 */
export function tokenStore(): Storage {
	return isEmbeddedDevShell() ? sessionStorage : localStorage;
}
