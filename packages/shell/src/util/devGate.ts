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
// TAB SESSION — the ONE boot identity of this browsing context
// =============================================================================

/**
 * The tab's boot identity: whether it is a dev tab, which app it is locked
 * to, and which registered web origin its browser sign-in relays through.
 *
 * Parsed from the URL exactly ONCE per page load (`rrdev`, `appid`/`appId`,
 * `rrauthorigin`), merged over the persisted copy, and persisted back under ONE
 * key — because an OAuth sign-in round trip strips the query string, and
 * every consumer that re-derived this state from `window.location` with its
 * own fallback rules eventually diverged from the others. The flavor picker
 * (stitch-flavors) writes the same key pre-bundle so the flavor choice and
 * the gate can never disagree.
 *
 * Frame scoping rides sessionScopedStore: framed shells get a frame-local
 * copy (their identity lives in their URL, which the embedder owns), so an
 * embedded preview can never stamp the top shell's tab identity.
 */
export interface TabSession {
	/** Dev tab: hooks installed, dev flavor, self-registration eligible. */
	dev: boolean;
	/** The app this tab is locked to ('' = none): its startup app, its
	 *  dev-registration subject, and the id the dev hold waits on. */
	appId: string;
	/** Registered web origin the dev sign-in relay uses ('' = none). */
	authOrigin: string;
	/** The locked app's display name, remembered from the last time this tab
	 *  SAW the app's manifest — the anonymous manifest omits auth-required
	 *  apps, so a signed-out surface has nothing else to brand with. */
	appName?: string;
	/** The locked app's icon URL, remembered with {@link appName}. */
	appIcon?: string;
}

/** The tab-session storage key (JSON TabSession). */
const TAB_SESSION_KEY = 'rr:tab';

// Computed once on first read, never re-read (a tab's identity must not
// flip while the shell runs — a mid-session change would strand
// half-installed hooks and half-held app loads).
let tabSessionCache: TabSession | undefined;

/**
 * This tab's boot identity (see {@link TabSession}). Cached on first read.
 *
 * @returns The tab session (all-empty on a plain production tab).
 */
export function tabSession(): TabSession {
	if (tabSessionCache) return tabSessionCache;
	let dev = false;
	let appId = '';
	let authOrigin = '';
	try {
		const params = new URLSearchParams(window.location.search);
		dev = params.get('rrdev') === '1';
		appId = params.get('appId') || params.get('appid') || '';
		const rrauth = params.get('rrauthorigin') || '';
		if (rrauth) {
			// Origin only, http(s) only — the value rides a URL parameter.
			// A hostile value cannot redirect a sign-in anywhere: Zitadel
			// only ever redirects to REGISTERED uris.
			const parsed = new URL(rrauth);
			if (parsed.protocol === 'http:' || parsed.protocol === 'https:') authOrigin = parsed.origin;
		}
	} catch { /* no window/location (tests) — persisted copy only */ }
	let persisted: Partial<TabSession> = {};
	try {
		persisted = JSON.parse(sessionScopedStore().getItem(TAB_SESSION_KEY) ?? '{}') as Partial<TabSession>;
	} catch { /* unreadable copy — URL facts only */ }
	const session: TabSession = {
		dev: dev || persisted.dev === true,
		appId: appId || (typeof persisted.appId === 'string' ? persisted.appId : ''),
		authOrigin: authOrigin || (typeof persisted.authOrigin === 'string' ? persisted.authOrigin : ''),
		// Remembered identity has no URL source — persisted copy only. Only
		// materialized when present, so a session without one keeps the
		// three-field shape.
		...(typeof persisted.appName === 'string' ? { appName: persisted.appName } : {}),
		...(typeof persisted.appIcon === 'string' ? { appIcon: persisted.appIcon } : {}),
	};
	// Persist only a session that SAYS something — plain production tabs
	// write nothing.
	if (session.dev || session.appId || session.authOrigin) {
		try { sessionScopedStore().setItem(TAB_SESSION_KEY, JSON.stringify(session)); } catch { /* storage full */ }
	}
	return (tabSessionCache = session);
}

/**
 * Updates the tab session (the deprecated get/setSessionAppId facades and
 * logout route through here). Merges, re-persists, and updates the cache.
 *
 * @param patch - Fields to change.
 */
export function updateTabSession(patch: Partial<TabSession>): void {
	const next = { ...tabSession(), ...patch };
	tabSessionCache = next;
	try { sessionScopedStore().setItem(TAB_SESSION_KEY, JSON.stringify(next)); } catch { /* storage full */ }
}

/**
 * The app id this tab is LOCKED to — the deep-app ("branded") predicate.
 *
 * Non-empty when the tab was launched for one specific app: an authored dev
 * preview page (injected boot config) or an `?appid=` deep link / dev tab.
 * A locked tab hides every platform affordance that would lead away from
 * the app (Home, Switch App, the header's go-home lockup) and drops
 * platform branding from shared surfaces like the Settings overlay.
 *
 * @returns The locked app id, or '' for a plain platform tab.
 */
export function lockedAppId(): string {
	return devBootConfig()?.appId || tabSession().appId;
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
 * A BUILD-TIME capability and nothing else: true only in a development build
 * (NODE_ENV !== 'production' — `rsbuild dev`, or the stitched dev FLAVOR that
 * the App Builder previews run). A production build bakes NODE_ENV to
 * 'production', so this is constant-false there: no URL parameter
 * (`?rrdev=1`), no persisted tab session (`rr:tab`.dev, `rr:dev`) and no
 * injected boot config (`window.__rrDevBoot`) can turn the hooks on. Those
 * only SELECT the dev flavor's assets in index.html's flavor picker
 * (scripts/stitch-flavors.mjs) and describe a dev tab's identity; they are
 * never read as a capability here.
 *
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
 * TEST-ONLY: forget the cached gate and tab session so a test can stage its
 * own build mode and window/`rrdev` environment. Production code never calls
 * this — the gate must stay frozen for the life of a real shell session.
 */
export function resetDevGateForTests(): void {
	gateResult = undefined;
	tabSessionCache = undefined;
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
// DEV RELAY ORIGIN
// =============================================================================

/**
 * The registered web origin a top-level dev shell relays its browser
 * sign-in through (CloudAuthProvider's relayOrigin), or '' when none.
 *
 * The dev host passes it as `rrauthorigin=<origin>` on the preview URL (the page
 * origin is a random dev port Zitadel cannot know; the engine's probe
 * cannot help either — through the dev proxy it resolves to the proxy
 * itself). It rides the tab session, so it survives the OAuth round trip.
 * Dev-gated and top-level only.
 *
 * @returns The relay origin, or '' (production, framed, or never given).
 */
export function devRelayOrigin(): string {
	if (!isDevHooksEnabled() || isFramedShell()) return '';
	try {
		return tabSession().authOrigin;
	} catch {
		return '';
	}
}

// =============================================================================
// TRUSTED EMBEDDER (WHO MAY DRIVE THE DEV HOOKS)
// =============================================================================
//
// The `rrdev:*` protocol (rrdev:auth hands the shell a SESSION TOKEN,
// rrdev:registerRemote makes it load and run a script) is a privileged
// channel. The one legitimate sender in this repo is the VS Code extension's
// App Builder webview (apps/vscode, AppWebview.tsx → PreviewFrame): the shell
// is an iframe inside a `vscode-webview://<id>` document, and the shell may
// be served by ANY engine, including the production cloud one. A loopback
// embedder is trusted only when the shell itself is served from loopback
// (`pnpm start` / a local engine). Anything else — any website that opened
// this page (window.opener), framed it from another origin, or merely knows
// the URL — is hostile.

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
 *   - `vscode-webview://<id>` (the VS Code extension's webview), whichever
 *     engine serves the shell;
 *   - a loopback http(s) origin on any port, but ONLY when the shell is itself
 *     served from a loopback origin — a page on localhost must not be able to
 *     drive a shell served from a real (cloud) origin.
 * Opaque origins ('null'), unparsable values and everything else are refused.
 *
 * @param origin - The sender's origin as reported by the browser.
 * @param shellOrigin - This shell's own origin (`window.location.origin`).
 * @returns True when the origin may drive the dev hooks.
 */
export function isAllowedEmbedderOrigin(origin: string, shellOrigin: string): boolean {
	if (!origin || origin === 'null') return false;
	let url: URL;
	try { url = new URL(origin); } catch { return false; }
	// Non-special scheme: the URL parser reports origin 'null', so compare the
	// string itself — it must be exactly `vscode-webview://<host>`, no path.
	if (url.protocol === 'vscode-webview:') return url.host.length > 0 && origin === `vscode-webview://${url.host}`;
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	// `origin` must BE an origin, not a URL that merely starts like one.
	if (url.origin !== origin) return false;
	if (!isLoopbackHostname(url.hostname)) return false;
	// Loopback embedder: only for a loopback-served shell.
	try { return isLoopbackHostname(new URL(shellOrigin).hostname); } catch { return false; }
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
		if (!origin && document.referrer) {
			// Non-special schemes (vscode-webview:) report origin 'null' — rebuild it.
			const ref = new URL(document.referrer);
			origin = ref.origin !== 'null' ? ref.origin : `${ref.protocol}//${ref.host}`;
		}
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
