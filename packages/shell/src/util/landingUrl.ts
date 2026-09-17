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

// Landing-URL snapshot — the URL this document was opened with.
//
// The shell destroys the landing URL as it boots: the OAuth callback strips
// `?code=` (auth/CloudAuthProvider.ts) and the connect path rewrites the query
// string (connection/connection.ts), both via history.replaceState. Anything
// that needs to read what the visitor arrived with — a referral code, a
// campaign reference, a deep-link target — has to read it before that, and
// only shell code runs that early: a remote's modules are not fetched until
// after <Shell /> renders.
//
// So the shell takes ONE unopinionated snapshot in bootstrap and hands it out.
// It does not interpret it, allowlist it, or know what any parameter means;
// consumers pick out what they care about. Nothing is persisted — the snapshot
// lives in module memory for the life of the document, same as
// util/prerenderFallback.ts.
//
// Consumers that act on it are responsible for their own privacy posture: this
// module captures unconditionally, so a consumer honouring Global Privacy
// Control or skipping automated browsers must check that on the READ side.

/** Immutable snapshot of the URL a document was opened with. */
export interface LandingUrl {
	/** Path only, no query or fragment (e.g. `/pricing`). */
	readonly pathname: string;
	/** Raw query string including the leading `?`, or `''`. */
	readonly search: string;
	/** Raw fragment including the leading `#`, or `''`. */
	readonly hash: string;
	/** Parsed query parameters. Repeated keys keep the LAST value. */
	readonly params: Readonly<Record<string, string>>;
}

const EMPTY: LandingUrl = Object.freeze({
	pathname: '',
	search: '',
	hash: '',
	params: Object.freeze({}),
});

let captured: LandingUrl | null = null;

/**
 * Snapshot `window.location` before anything rewrites it.
 *
 * Called once, as early as possible in bootstrap. IDEMPOTENT: a second call is
 * a no-op, so a React effect that double-invokes (StrictMode) cannot replace a
 * true landing URL with a post-navigation one. Never throws — a malformed URL
 * is not worth a broken boot.
 */
export function captureLandingUrl(): void {
	if (captured !== null) return;
	try {
		const { pathname, search, hash } = window.location;
		const params: Record<string, string> = {};
		for (const [key, value] of new URLSearchParams(search)) params[key] = value;
		captured = Object.freeze({
			pathname,
			search,
			hash,
			params: Object.freeze(params),
		});
	} catch {
		captured = EMPTY;
	}
}

/**
 * The snapshot taken at boot.
 *
 * Returns an EMPTY snapshot when nothing was captured (no DOM, or a caller
 * that ran before bootstrap) rather than reading `window.location` late — a
 * late read would silently return a URL the visitor never arrived on, which is
 * worse than returning nothing.
 */
export function getLandingUrl(): LandingUrl {
	return captured ?? EMPTY;
}

/** Test hook: forget the snapshot. */
export function resetLandingUrlForTests(): void {
	captured = null;
}
