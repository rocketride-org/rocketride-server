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
// BUILD MODE
// =============================================================================

/**
 * Whether this bundle is a DEVELOPMENT build: `rsbuild dev`, or the dev
 * FLAVOR stitched beside the production assets (scripts/stitch-flavors.mjs).
 * The bundler bakes `process.env.NODE_ENV` as a literal, so in a production
 * bundle this is the constant `false` — it is the ONLY input to the dev
 * gate, and nothing a page URL, sessionStorage or an opener/embedder can
 * supply is ever consulted.
 *
 * @returns True in a development build, false in a production build.
 */
function isDevBuild(): boolean {
	return process.env.NODE_ENV !== 'production';
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
		// A dev tab is a tab whose dev HOOKS are installed — and a production
		// build never installs them, so no URL / persisted copy makes a
		// production build "dev" (see isDevHooksEnabled). The picker (which
		// reads the same URL / copy pre-bundle) is what routes such a tab to
		// the dev flavor; this build only reports facts it will honour.
		dev: isDevBuild() && (dev || persisted.dev === true),
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
 * vetted by isTrustedEmbedderMessage(), and the credential-persisting dev
 * conveniences (`#rrtoken`, the sign-in relay) additionally require a
 * loopback-served shell (isLoopbackShell(); the relay a still narrower one,
 * isRelayBounceTarget()).
 *
 * Read once at first call and cached.
 *
 * @returns True when dev hooks should be installed.
 */
export function isDevHooksEnabled(): boolean {
	if (gateResult === undefined) {
		gateResult = isDevBuild();
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
 * Dev-gated, top-level and only on a shell the relay bounce can return to
 * (isRelayBounceTarget).
 *
 * @returns The relay origin, or '' (production, framed, a shell the bounce
 *          cannot return to, or never given).
 */
export function devRelayOrigin(): string {
	// Only where the bounce that completes the relay can land: the relay
	// exists for a dev server on a random localhost port, so a shell served
	// from anywhere else — the production origin, reached by a bare
	// `?rrdev=1&rrauthorigin=` link — has no use for it and must not let a URL
	// steer its sign-in redirect. (Framed shells sign in via rrdev:auth.)
	if (!isDevHooksEnabled() || isFramedShell()) return '';
	try {
		return isRelayBounceTarget(window.location.origin) ? tabSession().authOrigin : '';
	} catch {
		return '';
	}
}

/**
 * Whether `origin` is a dev origin the sign-in relay's BOUNCE will send an
 * OAuth code back to: exactly `http://localhost[:port]` or
 * `http://127.0.0.1[:port]`. The bounce (ConnectionManager.bootstrap and the
 * flavor picker in scripts/stitch-flavors.mjs, which keeps its own inline copy
 * of this pattern because it runs before the bundle loads) accepts only these
 * targets so the registered web origin never becomes an open redirector.
 * devRelayOrigin() arms the relay only on such shells; a wider loopback shell
 * (`https://localhost`, `[::1]`, `*.localhost`, 127/8) would start a sign-in
 * whose code the bounce then refuses to deliver.
 *
 * @param origin - A shell origin, or the `rrdev:<origin>` state payload.
 * @returns True when the relay bounce accepts it as a target.
 */
export function isRelayBounceTarget(origin: string): boolean {
	return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

// =============================================================================
// TRUSTED EMBEDDER (WHO MAY DRIVE THE DEV HOOKS)
// =============================================================================
//
// The `rrdev:*` protocol (rrdev:auth hands the shell a SESSION TOKEN,
// rrdev:registerRemote makes it load and run a script) is a privileged
// channel, and `postMessage` reaches ANY window that holds a reference to the
// shell: a page that opened it (window.opener) or framed it (window.parent)
// is the sender, and the browser — not the sender — fills in `e.origin`.
// So a message is trusted only when BOTH facts hold: its SOURCE has the right
// relation to this window AND its ORIGIN is in a closed set.
//
// The legitimate senders (the complete list in this repo):
//
//   1. VS Code App Builder preview (apps/vscode AppWebview.tsx PreviewFrame):
//      the shell is an iframe inside the `vscode-webview://<id>` App Builder
//      page, so the sender is the PARENT and e.origin is `vscode-webview://<id>`.
//      The shell itself is served from the extension's loopback dev proxy
//      (`http://localhost:<port>`) or any engine — but the SENDER is never a
//      loopback page.
//   2. Web App Builder preview (apps/rocket-ui AppBuilderProvider.tsx): the
//      builder is a page of the shell's OWN origin and posts `rrdev:auth` to
//      (a) its preview iframe — the sender is the PARENT, e.origin is the
//      shell's own origin (the preview is a blob: page, which inherits its
//      creator's origin) — and (b) the debug tab it opened with window.open —
//      the sender is the OPENER, e.origin again the shell's own origin.
//
// Nobody else is a sender. A SAME-ORIGIN sender is safe to trust because the
// attacker's page cannot be same-origin: e.origin is the origin of the
// sender's document as the browser knows it, an attacker page on another
// site has a different one, and one that can run script ON the shell's origin
// has already won (it can read the session token from localStorage itself).
//
// The closed set is therefore exactly: `vscode-webview://<id>` as PARENT only,
// and the shell's own origin as PARENT or OPENER. The opener relation is
// accepted ONLY from the shell's own origin (flow 2b): a page that merely
// window.open()s the shell is its opener, so "is the opener" alone proves
// nothing. Loopback origins are not senders (see isAllowedEmbedderOrigin).
//
// Known compatibility cost of a closed set (each is refused, by design):
// browser-hosted VS Code / Codespaces (webview origins `*.vscode-cdn.net`),
// code-server (a webview origin on its own host), and any other embedder that
// is neither `vscode-webview://` nor the shell's own origin.

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
 * Parses a `MessageEvent.origin` / `location.origin` style value that must BE
 * an http(s) tuple origin — not a URL that merely starts like one, not an
 * opaque 'null', not another scheme.
 *
 * @param origin - The origin string as reported by the browser.
 * @returns The parsed URL, or null when it is not an http(s) origin.
 */
function parseHttpOrigin(origin: unknown): URL | null {
	if (typeof origin !== 'string' || !origin || origin === 'null') return null;
	let url: URL;
	try { url = new URL(origin); } catch { return null; }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	return url.origin === origin ? url : null;
}

/**
 * Whether `origin` is a loopback http(s) origin (any port).
 *
 * @param origin - An origin string such as `location.origin`.
 * @returns True for `http(s)://localhost|127.x.x.x|[::1]` (with optional port).
 */
function isLoopbackOrigin(origin: string): boolean {
	const url = parseHttpOrigin(origin);
	return url !== null && isLoopbackHostname(url.hostname);
}

/**
 * Whether THIS shell is served from a loopback origin — the only place the
 * credential-persisting dev conveniences (`#rrtoken` seeding; the sign-in
 * relay on the narrower isRelayBounceTarget set) make sense: they exist for
 * `rocketride app dev` / `pnpm start`, whose shell is a dev server on
 * localhost. A shell served from anywhere else (the production origin
 * included, and a dev server reached by LAN IP or a forwarded hostname) never
 * honours them, whatever its URL says.
 *
 * @returns True when `window.location.origin` is a loopback http(s) origin.
 */
export function isLoopbackShell(): boolean {
	try { return isLoopbackOrigin(window.location.origin); } catch { return false; }
}

/**
 * Whether `origin` (a `MessageEvent.origin`) belongs to the closed set of
 * expected dev embedders of a shell served from `shellOrigin` — exactly two
 * members:
 *   - `vscode-webview://<id>` (the VS Code extension's webview), whichever
 *     engine serves the shell;
 *   - the shell's OWN origin (the web App Builder; see the section comment).
 * A loopback origin is NOT a member, not even for a loopback-served shell: no
 * sender in this repo is one (VS Code is `vscode-webview://`, the web builder
 * is same-origin, the terminal host sends no messages), and trusting
 * "any other localhost port" would let any page on any local server drive a
 * dev shell whose localStorage holds the token `rocketride app dev` seeded.
 * Opaque origins ('null'), an opaque/unparsable shell origin (so `'null' ===
 * 'null'` can never read as "same origin"), unparsable values and everything
 * else are refused.
 *
 * @param origin - The sender's origin as reported by the browser.
 * @param shellOrigin - This shell's own origin (`window.location.origin`).
 * @returns True when the origin may drive the dev hooks.
 */
export function isAllowedEmbedderOrigin(origin: string, shellOrigin: string): boolean {
	if (typeof origin !== 'string' || !origin || origin === 'null') return false;
	let url: URL;
	try { url = new URL(origin); } catch { return false; }
	// Non-special scheme: the URL parser reports origin 'null', so compare the
	// string itself — it must be exactly `vscode-webview://<host>`, no path.
	if (url.protocol === 'vscode-webview:') return url.host.length > 0 && origin === `vscode-webview://${url.host}`;
	const sender = parseHttpOrigin(origin);
	const shell = parseHttpOrigin(shellOrigin);
	return sender !== null && shell !== null && sender.origin === shell.origin;
}

/**
 * How a message sender relates to this window, or null when it is neither.
 *   - 'parent': this shell is framed (`self !== top`) and the sender is the
 *     frame that embeds it (not a sibling, not a child, not an ancestor above
 *     the parent);
 *   - 'opener': this shell is a top-level tab and the sender is the window
 *     that opened it with window.open().
 * A top-level window's `window.parent` is itself, so a self-post is neither.
 *
 * @param source - `MessageEvent.source`.
 * @returns The relation, or null.
 */
function senderRelation(source: unknown): 'parent' | 'opener' | null {
	if (!source) return null;
	if (window.self !== window.top) return source === window.parent ? 'parent' : null;
	return window.opener != null && source === window.opener ? 'opener' : null;
}

/**
 * Whether a postMessage may drive the dev hooks (`rrdev:*`). All of:
 *   1. dev hooks are enabled in this build (never true in production);
 *   2. the sender is this shell's PARENT (framed shell) or its OPENER (a
 *      top-level tab) — never a sibling, a child frame or a stranger;
 *   3. its origin is an expected embedder (isAllowedEmbedderOrigin) — and for
 *      the OPENER relation, specifically the shell's OWN origin (the web App
 *      Builder's debug tab): no cross-origin opener is ever an embedder.
 *
 * @param e - The message event (only `origin` and `source` are read).
 * @returns True when the message came from the trusted embedder.
 */
export function isTrustedEmbedderMessage(e: { origin: string; source: unknown }): boolean {
	try {
		if (!isDevHooksEnabled()) return false;
		const relation = senderRelation(e.source);
		if (!relation) return false;
		const shellOrigin = window.location.origin;
		if (relation === 'opener') {
			const sender = parseHttpOrigin(e.origin);
			const shell = parseHttpOrigin(shellOrigin);
			return sender !== null && shell !== null && sender.origin === shell.origin;
		}
		return isAllowedEmbedderOrigin(e.origin, shellOrigin);
	} catch { return false; }
}

/**
 * The embedder's origin as far as it can be VERIFIED, or '' when unknown. Used
 * to AIM outbound dev traffic (console forwarding, whose rows carry hrefs —
 * an OAuth `?code=` after a redirect included) at the embedder instead of
 * broadcasting it to whoever happens to be the parent.
 *   - same-origin parent: its location is readable (a cross-origin parent's
 *     throws), so the shell's own origin is ground truth;
 *   - otherwise `ancestorOrigins` where supported, else the referrer, and
 *     only if that origin is in the allowed set.
 *
 * @returns The parent frame's origin when it is an allowed embedder, else ''.
 */
export function trustedParentOrigin(): string {
	try {
		if (!isDevHooksEnabled() || window.self === window.top) return '';
		if (isSameOriginEmbed()) return parseHttpOrigin(window.location.origin) ? window.location.origin : '';
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
 * Canonicalises a dev-remote entry URL (`rrdev:registerRemote`, or the
 * URL-convention self-registration) if — and only if — the shell may load it:
 * an ABSOLUTE http(s) URL, no credentials, on a loopback host — the
 * embedder's own rsbuild dev server. Protocol-relative (`//host/x.js`),
 * `javascript:`, `data:`, relative and non-loopback hosts are refused. Callers
 * register the RETURNED string, not the input, so what was vetted is exactly
 * what the loader fetches (no parser differential).
 *
 * @param entry - The remoteEntry.js URL as received.
 * @returns The canonical URL, or null when the shell must not load it.
 */
export function normalizeDevRemoteEntry(entry: unknown): string | null {
	if (typeof entry !== 'string') return null;
	let url: URL;
	try { url = new URL(entry); } catch { return null; }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password) return null;
	return isLoopbackHostname(url.hostname) ? url.href : null;
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
