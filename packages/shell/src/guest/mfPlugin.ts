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

// =============================================================================
// GUEST MF PLUGIN — chunk URLs follow the current frame token (PR2b, plan §3.4)
// =============================================================================
//
// The app's dist is served under `/_t/<frame token>/v<N>/`, and the token
// lasts at most 15 minutes. A chunk the remote asks for after a refresh still
// names the token it was loaded with, so the guest re-bases every same-origin
// `/_t/<token>/v<N>/<rest>` URL onto the CURRENT `entryPrefix`. Anything else
// (another origin, a traversal) is left as it is: it is never pulled onto the
// app's own prefix. The runtime hooks used here are pinned to the Module
// Federation runtime version in the lockfile (T71).
// =============================================================================

/** The `@module-federation/runtime` version this plugin was written against. */
export const MF_RUNTIME_PIN = '2.5.1';

const TOKEN_PATH_RE = /^\/_t\/[A-Za-z0-9._-]+\/v[0-9]{1,9}\/(.*)$/;

/** Re-bases a `/_t/<token>/v<N>/<rest>` path onto `entryPrefix`; anything else is unchanged. */
export function rewriteChunkUrl(url: string, entryPrefix: string): string {
	const m = TOKEN_PATH_RE.exec(url);
	if (!m) return url;
	const rest = m[1];
	if (rest.split(/[/?#]/).some((seg) => seg === '..' || seg === '.')) return url;
	return entryPrefix + rest;
}

/** Throws unless the lockfile names `@module-federation/runtime` at exactly `installed`. */
export function assertRuntimeVersion(lockfileText: string, installed: string): void {
	const versions = new Set<string>();
	for (const m of String(lockfileText).matchAll(/@module-federation\/runtime@(\d+\.\d+\.\d+)/g)) versions.add(m[1]);
	if (versions.size === 0) throw new Error('@module-federation/runtime is not named in the lockfile');
	if (!versions.has(installed)) throw new Error(`@module-federation/runtime ${installed} is not the locked version (${[...versions].join(', ')})`);
}

/**
 * The guest's runtime plugin: every script and stylesheet the runtime creates
 * for the app is re-based onto the current prefix.
 *
 * @param currentPrefix - Reads the latest `entryPrefix`.
 * @returns A Module Federation runtime plugin.
 */
export function createGuestMfPlugin(currentPrefix: () => string): { name: string; createScript(args: { url: string; attrs?: Record<string, unknown> }): HTMLScriptElement | void; createLink(args: { url: string; attrs?: Record<string, unknown> }): HTMLLinkElement | void } {
	const rebase = (url: string): string | null => {
		try {
			const u = new URL(url, window.location.href);
			if (u.origin !== window.location.origin) return null;
			const next = rewriteChunkUrl(u.pathname, currentPrefix());
			return next === u.pathname ? null : next + u.search;
		} catch {
			return null;
		}
	};
	return {
		name: 'rocketride-guest-chunks',
		createScript({ url, attrs }) {
			const next = rebase(url);
			if (next === null) return;
			const script = document.createElement('script');
			script.src = next;
			for (const [k, v] of Object.entries(attrs ?? {})) if (typeof v === 'string') script.setAttribute(k, v);
			return script;
		},
		createLink({ url, attrs }) {
			const next = rebase(url);
			if (next === null) return;
			const link = document.createElement('link');
			link.href = next;
			for (const [k, v] of Object.entries(attrs ?? {})) if (typeof v === 'string') link.setAttribute(k, v);
			return link;
		},
	};
}
