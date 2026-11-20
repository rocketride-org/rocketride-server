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

/** Hostnames (as `URL.hostname` reports them, trailing dot removed) that may be framed over plain http. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The only shell-origin paths a webview may frame: the engine's chat and dropper pages. */
const SHELL_ORIGIN_PREFIXES = ['/chat/', '/dropper/'];

/** App bundles (`/apps/...`) on the engine are never framed: they belong in the shell's own loader. */
const APPS_PATH = /^\/apps(\/|$)/;

/** Percent-encoded dot, slash or backslash: a traversal the URL parser leaves for the server to decode. */
const ENCODED_PATH_SEPARATOR = /%2e|%2f|%5c/i;

/** An http(s) origin reduced to the parts that decide "same server". */
interface Endpoint {
	protocol: string;
	host: string;
	port: string;
}

/**
 * Reduce an http(s) URL to protocol, host (lowercase, trailing dot removed) and effective port.
 *
 * @param url - A parsed URL.
 * @returns The endpoint, or null for any other scheme.
 */
function endpointOf(url: URL): Endpoint | null {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	return {
		protocol: url.protocol,
		host: url.hostname.toLowerCase().replace(/\.$/, ''),
		port: url.port || (url.protocol === 'https:' ? '443' : '80'),
	};
}

/**
 * Whether two endpoints are the same server: the same origin (ignoring a
 * trailing dot), or two loopback names on the same port.
 *
 * @param a - The framed URL's endpoint.
 * @param b - The shell's endpoint.
 * @returns True when `a` must be treated as the shell itself.
 */
function isSameServer(a: Endpoint, b: Endpoint): boolean {
	if (a.port !== b.port) return false;
	if (LOOPBACK_HOSTS.has(a.host) && LOOPBACK_HOSTS.has(b.host)) return true;
	return a.protocol === b.protocol && a.host === b.host;
}

/**
 * Whether a URL on the engine is one of its first-party chat or dropper pages.
 *
 * @param url - A parsed URL already known to be on the engine.
 * @returns True for /chat/ or /dropper/ paths with no app-bundle prefix and no encoded separator left.
 */
function isEngineChatPage(url: URL): boolean {
	if (APPS_PATH.test(url.pathname) || ENCODED_PATH_SEPARATOR.test(url.pathname)) return false;
	return SHELL_ORIGIN_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/**
 * The isolated apps' host suffix from `RR_APP_ORIGIN_TEMPLATE` (`apps.example`
 * for `https://{label}.apps.example`), or '' when there is none.
 *
 * @param template - The origin template, if isolation is on.
 */
function appSuffixOf(template: string | null | undefined): string {
	if (!template || !template.includes('{label}')) return '';
	try {
		const host = new URL(template.replace('{label}', 'x')).hostname.toLowerCase().replace(/\.+$/, '');
		return host.startsWith('x.') ? host.slice(2) : '';
	} catch {
		return '';
	}
}

/**
 * Decide whether a `webview:` document may frame a URL.
 *
 * Only absolute http(s) URLs without credentials are considered (relative and
 * protocol-relative input would resolve against the shell). A URL on the
 * shell's own server (same origin, a trailing-dot variant of it, or another
 * loopback name on the shell's port) is accepted only under /chat/ or
 * /dropper/ (never /apps/), after the parser has normalised `.` and `..`
 * segments and with no encoded separator left in its path, over whatever
 * scheme the shell itself uses. Any other URL must be https, or http on a
 * loopback host.
 *
 * A shell without an http(s) origin (a VS Code webview, a file:// page, an
 * opaque or unparsable origin) cannot tell which server is the engine, so it
 * treats every loopback URL as possibly the engine (only /chat/ and /dropper/
 * are framed there), refuses /apps/ on any host, and frames other https
 * URLs.
 *
 * @param raw - The URL taken from the `webview:` document URI.
 * @param shellOrigin - The shell's own origin (`window.location.origin`).
 * @param shellHref - The shell document's URL (`window.location.href`), which the iframe resolves `src` against; defaults to the origin.
 * @param appOriginTemplate - `getIsolation()?.originTemplate`: hosts under its suffix are refused (#1022, E7).
 * @returns True when the URL may be framed.
 */
export function isAllowedWebviewUrl(raw: string, shellOrigin: string, shellHref: string = shellOrigin, appOriginTemplate?: string | null): boolean {
	return resolveWebviewUrl(raw, shellOrigin, shellHref, appOriginTemplate) !== null;
}

/**
 * Resolve a `webview:` URL the way the iframe will, and apply the framing rule to that URL.
 *
 * The iframe resolves `src` against the shell document, so input such as
 * `https:host/../apps/x` (a special scheme with no `//`) lands on the shell's
 * origin even though parsing it alone names another host. Such base-dependent
 * input is refused, and the returned canonical `href` is what the iframe must
 * be given, so the URL that was checked is the URL that loads.
 *
 * @param raw - The URL taken from the `webview:` document URI.
 * @param shellOrigin - The shell's own origin (`window.location.origin`).
 * @param shellHref - The shell document's URL (`window.location.href`); defaults to the origin.
 * @param appOriginTemplate - `getIsolation()?.originTemplate`: hosts under its suffix are refused (#1022, E7).
 * @returns The canonical URL to frame, or null when it must not be framed.
 */
export function resolveWebviewUrl(
	raw: string,
	shellOrigin: string,
	shellHref: string = shellOrigin,
	appOriginTemplate?: string | null
): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	try {
		// Same answer with and without the shell as base, or the input depends on the shell.
		if (new URL(raw, shellHref).href !== url.href) return null;
	} catch {
		// Opaque or unparsable shell URL: nothing to resolve against.
	}
	return isAllowedUrl(url, shellOrigin, appOriginTemplate) ? url.href : null;
}

/**
 * Apply the framing rule to an already-resolved URL.
 *
 * @param url - The absolute URL the iframe will load.
 * @param shellOrigin - The shell's own origin.
 * @param appOriginTemplate - The isolated apps' origin template, if isolation is on.
 * @returns True when it may be framed.
 */
function isAllowedUrl(url: URL, shellOrigin: string, appOriginTemplate?: string | null): boolean {
	const target = endpointOf(url);
	if (!target || url.username || url.password) return false;
	// E7 (#1022): never a host under the isolated apps' origin suffix.
	const suffix = appSuffixOf(appOriginTemplate);
	if (suffix) {
		const host = url.hostname.toLowerCase().replace(/\.+$/, '');
		if (host === suffix || host.endsWith(`.${suffix}`)) return false;
	}

	let shell: Endpoint | null = null;
	try {
		shell = endpointOf(new URL(shellOrigin));
	} catch {
		// Opaque ('null') or unparsable: no http(s) URL can share its authority.
	}
	if (!shell) {
		// No own server to compare with: the engine may be on any loopback port.
		if (APPS_PATH.test(url.pathname)) return false;
		if (LOOPBACK_HOSTS.has(target.host)) return isEngineChatPage(url);
		return target.protocol === 'https:';
	}
	if (isSameServer(target, shell)) return isEngineChatPage(url);
	return target.protocol === 'https:' || LOOPBACK_HOSTS.has(target.host);
}
