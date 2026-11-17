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

// =============================================================================
// WEBVIEW URL RULE — which URLs a `webview:` document may frame
// =============================================================================
//
// The webview iframe runs with `allow-scripts allow-same-origin`, so a page on
// the shell's own origin would run with the shell's full authority (#1022).
// Only https, loopback http, and the engine's first-party /chat/ and /dropper/
// pages on the shell origin (what pipeline links open) may be framed.
// =============================================================================

/** Hostnames (as `URL.hostname` reports them) that may be framed over plain http. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The only shell-origin paths a webview may frame: the engine's chat and dropper pages. */
const SHELL_ORIGIN_PREFIXES = ['/chat/', '/dropper/'];

/** Percent-encoded dot, slash or backslash: a traversal the URL parser leaves for the server to decode. */
const ENCODED_PATH_SEPARATOR = /%2e|%2f|%5c/i;

/**
 * Decide whether a `webview:` document may frame a URL.
 *
 * Only absolute URLs are accepted (relative and protocol-relative input would
 * resolve against the shell). A URL with credentials is refused. A URL on the
 * shell origin is accepted only under /chat/ or /dropper/ after the parser has
 * normalised `.` and `..` segments, and never with an encoded separator left
 * in its path. Any other URL must be https, or http on a loopback host.
 *
 * @param raw - The URL taken from the `webview:` document URI.
 * @param shellOrigin - The shell's own origin (`window.location.origin`).
 * @returns True when the URL may be framed.
 */
export function isAllowedWebviewUrl(raw: string, shellOrigin: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.username || url.password) return false;
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return false;

	let shell: string;
	try {
		shell = new URL(shellOrigin).origin;
	} catch {
		// No usable shell origin to compare with: refuse rather than guess.
		return false;
	}
	if (url.origin !== shell) return true;
	if (ENCODED_PATH_SEPARATOR.test(url.pathname)) return false;
	return SHELL_ORIGIN_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}
