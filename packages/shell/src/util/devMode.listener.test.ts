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

// The shell tsconfig deliberately keeps the browser surface node-free

// Behavioural security suite for rocketride-saas#1020: drives the REAL
// `message` listener that installDevHooks() registers (no injected
// collaborators), against the real ConnectionManager token slot and the real
// registerDevRemote. Each hostile case asserts an observable effect (token,
// reload, registered remote, forwarded console rows), so it fails on the
// pre-fix listener and passes on the fixed one. The legitimate flows (the VS
// Code App Builder preview, the web App Builder's preview iframe and debug
// tab, the terminal host's URL-convention self-registration) are replayed as
// the exact message sequences their senders produce, so a regression that
// breaks one fails here.
//
// installDevHooks() dynamically imports the shell barrel (src/index.ts),
// which pulls in component CSS that plain node cannot load. The CSS-like
// extensions are therefore stubbed (CommonJS `require` hook, which tsx's
// transpiled output uses) BEFORE devMode is imported — no runner preload
// needed; the imports below are deliberately dynamic.

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { afterEach, before } from 'node:test';
import { init } from '@module-federation/runtime';

type Listener = (e: unknown) => void;
type Hooks = typeof import('./devMode');
type Gate = typeof import('./devGate');
type Loader = typeof import('./appLoader');
type Connection = typeof import('../connection/connection');

let hooks: Hooks;
let gate: Gate;
let loader: Loader;
let connection: Connection;

// A host instance for registerDevRemote's registerRemotes (the rsbuild MF
// plugin creates it in the browser).
init({ name: 'shell_listener_test', remotes: [] });

before(async () => {
	const nodeRequire = createRequire(import.meta.url);
	const Module = nodeRequire('module') as { _extensions: Record<string, (m: { exports: unknown }) => void> };
	for (const ext of ['.css', '.scss', '.svg', '.png', '.woff2', '.woff']) Module._extensions[ext] = (m) => { m.exports = {}; };
	hooks = await import('./devMode');
	gate = await import('./devGate');
	loader = await import('./appLoader');
	connection = await import('../connection/connection');
	// Warm the shell barrel (installDevHooks imports it) against a throwaway
	// window: some of its dependencies (prism) register their own `message`
	// listeners on load, which must not be mistaken for the dev hooks'.
	stubBrowser({ framed: true, origin: CLOUD }, []);
	await import('../index');
	clearBrowser();
});

const CLOUD = 'https://cloud.example.test';
const NATIVE_CONSOLE = { log: console.log, warn: console.warn, error: console.error };
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

interface LivePage {
	listeners: Listener[];
	parent: { postMessage: (m: { type?: string }, target: string) => void };
	opener: { postMessage: (m: { type?: string }, target: string) => void };
	/** Everything posted to the parent window. */
	posted: Array<{ message: { type?: string }; target: string }>;
	/** Everything posted to the opener window. */
	postedToOpener: Array<{ message: { type?: string }; target: string }>;
	reloads: () => number;
	localStorageData: Map<string, string>;
}

/** A permissive stand-in for DOM objects the shell barrel touches while loading. */
const anyStub = (): object => new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : anyStub()), apply: () => anyStub(), construct: () => anyStub() });
/** A document whose unknown members are permissive stubs; `referrer` is real. */
const stubDocument = (): object => new Proxy({ referrer: '', getElementById: () => null, cookie: '', currentScript: null, readyState: 'complete', querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : anyStub()) });

interface BrowserOpts {
	framed: boolean;
	origin: string;
	/** The browser-reported ancestor origin (Chromium `location.ancestorOrigins[0]`). */
	ancestorOrigin?: string;
	/** The framing parent shares the shell's origin (its `location` is readable). */
	sameOriginParent?: boolean;
	/** The page URL's query string. */
	search?: string;
}

/** Installs a stub browser on globalThis; `listeners` collects window `message` listeners. */
function stubBrowser(opts: BrowserOpts, listeners: Listener[]): { parent: LivePage['parent']; opener: LivePage['opener']; posted: LivePage['posted']; postedToOpener: LivePage['postedToOpener']; reloads: () => number; mem: Map<string, string> } {
	const posted: LivePage['posted'] = [];
	const postedToOpener: LivePage['postedToOpener'] = [];
	let reloads = 0;
	const self = {};
	const parent: LivePage['parent'] = { postMessage: (message: { type?: string }, target: string): void => { posted.push({ message, target }); } };
	// A cross-origin parent's `location` is unreadable in a browser (the access
	// throws); a same-origin parent's is readable.
	if (opts.sameOriginParent) Reflect.set(parent, 'location', { origin: opts.origin });
	else Object.defineProperty(parent, 'location', { get: () => { throw new Error('SecurityError: cross-origin parent'); } });
	const opener: LivePage['opener'] = { postMessage: (message: { type?: string }, target: string): void => { postedToOpener.push({ message, target }); } };
	// localStorage (the SHARED token slot) and sessionStorage (the tab session —
	// the shell writes its `rr:tab` boot identity there) are separate areas, as
	// in a browser: the "nothing touched the token slot" assertions below must
	// not be confused by the tab-session write.
	const mem = new Map<string, string>();
	const sessionMem = new Map<string, string>();
	const storageOver = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } });
	const search = opts.search ?? '?rrdev=1';
	Reflect.set(globalThis, 'window', {
		self,
		top: opts.framed ? parent : self,
		parent: opts.framed ? parent : self,
		// A framed page has no opener (only top-level browsing contexts do).
		opener: opts.framed ? null : opener,
		location: { search, origin: opts.origin, pathname: '/', href: `${opts.origin}/${search}`, ancestorOrigins: opts.ancestorOrigin ? [opts.ancestorOrigin] : [], reload: () => { reloads++; } },
		addEventListener: (type: string, listener: Listener) => { if (type === 'message') listeners.push(listener); },
		removeEventListener: () => {},
		setTimeout, clearTimeout, setInterval, clearInterval,
		requestAnimationFrame: () => 0,
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		navigator: { userAgent: 'node' },
	});
	Reflect.set(globalThis, 'document', stubDocument());
	Reflect.set(globalThis, 'sessionStorage', storageOver(sessionMem));
	Reflect.set(globalThis, 'localStorage', storageOver(mem));
	return { parent, opener, posted, postedToOpener, reloads: () => reloads, mem };
}

/** Removes the stub browser. */
function clearBrowser(): void {
	for (const key of ['window', 'document', 'sessionStorage', 'localStorage']) Reflect.deleteProperty(globalThis, key);
}

/** Boots the dev hooks (development build) on a stub page and returns the page. */
async function bootShell(opts: { framed: boolean; origin?: string; ancestorOrigin?: string; sameOriginParent?: boolean; search?: string; nodeEnv?: string }): Promise<LivePage> {
	process.env.NODE_ENV = opts.nodeEnv ?? 'development';
	const listeners: Listener[] = [];
	const b = stubBrowser({ ...opts, origin: opts.origin ?? CLOUD }, listeners);
	gate.resetDevGateForTests();
	await hooks.installDevHooks();
	if (process.env.NODE_ENV !== 'production') assert.ok(listeners.length >= 1, 'the real listener was installed');
	return { listeners, parent: b.parent, opener: b.opener, posted: b.posted, postedToOpener: b.postedToOpener, reloads: b.reloads, localStorageData: b.mem };
}

/** Delivers a message to every listener the shell registered. */
function deliver(page: LivePage, data: unknown, origin: string, source: unknown): void {
	for (const l of page.listeners) l({ data, origin, source });
}

const NATIVE_FETCH = globalThis.fetch;

afterEach(() => {
	console.log = NATIVE_CONSOLE.log;
	console.warn = NATIVE_CONSOLE.warn;
	console.error = NATIVE_CONSOLE.error;
	globalThis.fetch = NATIVE_FETCH;
	process.env.NODE_ENV = ORIGINAL_NODE_ENV;
	gate.resetDevGateForTests();
	clearBrowser();
});

const registerRemoteOf = (moduleId: string) => ({ type: 'rrdev:registerRemote', appId: `org.${moduleId}`, moduleId, name: 'X', entry: 'http://localhost:3001/remoteEntry.js' });

test('a foreign framing parent cannot replace the session token (real listener)', async () => {
	const page = await bootShell({ framed: true });
	const cm = connection.ConnectionManager.getInstance();
	const before = cm.loadToken();
	deliver(page, { type: 'rrdev:auth', token: 'attacker-token' }, 'https://attacker.example', page.parent);
	assert.equal(cm.loadToken(), before, 'the attacker token was not adopted');
	assert.notEqual(cm.loadToken(), 'attacker-token');
	assert.equal(page.reloads(), 0, 'no reload');
});

test('a foreign framing parent cannot register a dev remote (real listener)', async () => {
	const page = await bootShell({ framed: true });
	deliver(page, registerRemoteOf('org_foreign'), 'https://attacker.example', page.parent);
	assert.equal(loader.isDevRemote('org_foreign'), false, 'no remote was registered');
	// Even a trusted-looking sender cannot point the shell at a non-loopback script.
	deliver(page, { ...registerRemoteOf('org_remote'), entry: 'https://attacker.example/remoteEntry.js' }, 'vscode-webview://abc', page.parent);
	assert.equal(loader.isDevRemote('org_remote'), false, 'a non-loopback entry was refused');
});

test('a window.opener cannot write the token of a top-level tab (real listener)', async () => {
	const page = await bootShell({ framed: false });
	const cm = connection.ConnectionManager.getInstance();
	const before = cm.loadToken();
	deliver(page, { type: 'rrdev:auth', token: 'attacker-token' }, 'https://attacker.example', page.opener);
	deliver(page, { type: 'rrdev:auth', token: '' }, 'https://attacker.example', page.opener);
	assert.equal(cm.loadToken(), before, 'the shared localStorage token is untouched');
	assert.equal(page.localStorageData.size, 0, 'nothing was written to or cleared from localStorage');
	assert.equal(page.reloads(), 0);
	deliver(page, registerRemoteOf('org_opener'), 'https://attacker.example', page.opener);
	assert.equal(loader.isDevRemote('org_opener'), false);
});

test('a loopback parent cannot drive a cloud-served shell (real listener)', async () => {
	const page = await bootShell({ framed: true });
	const cm = connection.ConnectionManager.getInstance();
	const before = cm.loadToken();
	deliver(page, { type: 'rrdev:auth', token: 'attacker-token' }, 'http://localhost:5173', page.parent);
	deliver(page, registerRemoteOf('org_loopback'), 'http://localhost:5173', page.parent);
	assert.equal(cm.loadToken(), before);
	assert.equal(page.reloads(), 0);
	assert.equal(loader.isDevRemote('org_loopback'), false);
});

test('console rows are never forwarded to a foreign parent, and go to the VS Code embedder origin only', async () => {
	const foreign = await bootShell({ framed: true, ancestorOrigin: 'https://attacker.example' });
	console.log('row with href ?code=FAKE');
	assert.deepEqual(foreign.posted.filter((p) => p.message.type === 'shell:devConsole'), [], 'nothing forwarded to a foreign parent');
	console.log = NATIVE_CONSOLE.log; console.warn = NATIVE_CONSOLE.warn; console.error = NATIVE_CONSOLE.error;

	const vscode = await bootShell({ framed: true, ancestorOrigin: 'vscode-webview://abc' });
	console.log('row for the embedder');
	const rows = vscode.posted.filter((p) => p.message.type === 'shell:devConsole');
	assert.ok(rows.length >= 1, 'rows reach the VS Code embedder');
	assert.ok(rows.every((r) => r.target === 'vscode-webview://abc'), 'aimed at the verified origin, never "*"');
});

test('positive control: the VS Code webview parent still drives the real listener', async () => {
	const page = await bootShell({ framed: true });
	const cm = connection.ConnectionManager.getInstance();
	deliver(page, { type: 'rrdev:auth', token: 'host-token' }, 'vscode-webview://abc', page.parent);
	assert.equal(cm.loadToken(), 'host-token', 'the embedder token was adopted');
	deliver(page, registerRemoteOf('org_vscode'), 'vscode-webview://abc', page.parent);
	assert.equal(loader.isDevRemote('org_vscode'), true, 'the loopback remote was registered');
	deliver(page, { type: 'rrdev:auth', token: '' }, 'vscode-webview://abc', page.parent);
	assert.equal(cm.loadToken(), '', 'an empty answer clears the session');
});

// ---------------------------------------------------------------------------
// The legitimate flows, replayed as the exact sequences their senders produce
// ---------------------------------------------------------------------------

const rows = (page: LivePage, type: string): LivePage['posted'] => page.posted.filter((p) => p.message.type === type);
const restoreConsole = (): void => { console.log = NATIVE_CONSOLE.log; console.warn = NATIVE_CONSOLE.warn; console.error = NATIVE_CONSOLE.error; };

test('VS Code App Builder preview, exact sequence: a vscode-webview parent drives the loopback dev-proxy shell it frames', async () => {
	// apps/vscode AppWebview.tsx PreviewFrame: the shell is served from the
	// extension's dev proxy (http://localhost:<port>) inside an iframe of the
	// vscode-webview://<id> App Builder page.
	const PROXY = 'http://localhost:3013';
	const VSCODE = 'vscode-webview://0f3c-aa11';
	const page = await bootShell({ framed: true, origin: PROXY, ancestorOrigin: VSCODE, search: '?appid=org.vsc&rrdev=1' });
	const cm = connection.ConnectionManager.getInstance();
	// 1. the shell announces itself to its parent, which waits for it
	assert.ok(rows(page, 'shell:devReady').length === 1, 'shell:devReady reached the VS Code parent');
	// 2. the extension answers the handshake with the host credential
	deliver(page, { type: 'rrdev:auth', token: 'vscode-host-token' }, VSCODE, page.parent);
	assert.equal(cm.loadToken(), 'vscode-host-token');
	// 3. then injects the dev server's remote together with the workspace manifest
	const entry = `${PROXY}/apps/org.vsc/dev/remoteEntry.js?t=1730000000000`;
	deliver(page, { type: 'rrdev:registerRemote', appId: 'org.vsc', moduleId: 'org_vsc', name: 'VSC', entry, manifest: { id: 'org.vsc', name: 'From The Manifest', version: '1.2.3' } }, VSCODE, page.parent);
	assert.equal(loader.isDevRemote('org_vsc'), true, 'the dev remote was registered');
	assert.equal(loader.getLocalAppEntries().find((e) => e.id === 'org.vsc')?.name, 'From The Manifest', 'the manifest rode the registration');
	// 4. console rows reach the extension, aimed at its origin
	console.log('preview row');
	const forwarded = rows(page, 'shell:devConsole');
	assert.ok(forwarded.length >= 1 && forwarded.every((r) => r.target === VSCODE), 'rows are aimed at the verified VS Code origin, never "*"');
	// 5. Inherit Auth off: the empty answer revokes the session
	restoreConsole();
	deliver(page, { type: 'rrdev:auth', token: '' }, VSCODE, page.parent);
	assert.equal(cm.loadToken(), '');
	assert.ok(page.reloads() >= 1, 'a post-boot change reboots the preview once');
});

test('web App Builder preview iframe, exact sequence: the same-origin builder answers the blob-authored preview', async () => {
	// apps/rocket-ui AppBuilderProvider.tsx: the preview is a blob: page minted
	// by the builder, so it shares the builder's (= the shell's own) origin and
	// the builder is its parent. The builder posts rrdev:auth with target
	// origin window.location.origin; e.origin at the shell is that same origin.
	for (const ancestorOrigin of [CLOUD, undefined]) {
		const page = await bootShell({ framed: true, origin: CLOUD, sameOriginParent: true, ancestorOrigin, search: '' });
		const cm = connection.ConnectionManager.getInstance();
		assert.equal(rows(page, 'shell:devReady').length, 1, 'shell:devReady reached the builder');
		// the definitive answer to the handshake: Inherit Auth on -> the builder's session
		deliver(page, { type: 'rrdev:auth', token: 'builder-session' }, CLOUD, page.parent);
		assert.equal(cm.loadToken(), 'builder-session');
		// Inherit Auth toggled off -> empty answer revokes
		deliver(page, { type: 'rrdev:auth', token: '' }, CLOUD, page.parent);
		assert.equal(cm.loadToken(), '');
		// an explicit preview sign-in -> the preview principal's token
		deliver(page, { type: 'rrdev:auth', token: 'preview-principal' }, CLOUD, page.parent);
		assert.equal(cm.loadToken(), 'preview-principal');
		// console/error rows reach the builder (devSession.handlePreviewMessage), aimed at its origin
		console.log('preview row');
		const forwarded = rows(page, 'shell:devConsole');
		assert.ok(forwarded.length >= 1 && forwarded.every((r) => r.target === CLOUD), `rows reach the same-origin builder (ancestorOrigins ${ancestorOrigin ?? 'unavailable'})`);
		restoreConsole();
	}
});

test('web App Builder debug tab, exact sequence: a top-level shell opened by the same-origin builder', async () => {
	// AppBuilderProvider opens the blob preview with window.open: the debug tab
	// is TOP-LEVEL, the builder is its opener and answers shell:devReady there.
	const page = await bootShell({ framed: false, origin: CLOUD, search: '' });
	const cm = connection.ConnectionManager.getInstance();
	assert.equal(page.postedToOpener.filter((p) => p.message.type === 'shell:devReady').length, 1, 'shell:devReady went to the opener');
	deliver(page, { type: 'rrdev:auth', token: 'builder-session' }, CLOUD, page.opener);
	assert.equal(cm.loadToken(), 'builder-session', 'the opener\'s answer was adopted');
	deliver(page, { type: 'rrdev:auth', token: '' }, CLOUD, page.opener);
	assert.equal(cm.loadToken(), '');
	// the same tab ignores a cross-origin window that holds the same opener reference
	// (e.g. the builder navigated away and an attacker page now sits behind it)
	deliver(page, { type: 'rrdev:auth', token: 'attacker-token' }, 'https://attacker.example', page.opener);
	assert.equal(cm.loadToken(), '', 'a cross-origin opener is refused');
	console.log('top-level row');
	assert.deepEqual(page.posted, [], 'a top-level tab forwards no console rows');
	restoreConsole();
});

test('a foreign page that frames a dev shell served from the cloud origin gets nothing: no token, no remote, no console rows, no handshake data', async () => {
	const page = await bootShell({ framed: true, origin: CLOUD, ancestorOrigin: 'https://attacker.example', search: '?rrdev=1&appid=org.victim' });
	const cm = connection.ConnectionManager.getInstance();
	const before = cm.loadToken();
	deliver(page, { type: 'rrdev:auth', token: 'attacker-token' }, 'https://attacker.example', page.parent);
	deliver(page, { type: 'rrdev:auth', token: '' }, 'https://attacker.example', page.parent);
	deliver(page, registerRemoteOf('org_victim_remote'), 'https://attacker.example', page.parent);
	// the shell's own console output (it prints its href, OAuth ?code= included) is not forwarded
	console.log('boot href ?code=FAKE-OAUTH-CODE');
	restoreConsole();
	assert.equal(cm.loadToken(), before);
	assert.equal(loader.isDevRemote('org_victim_remote'), false);
	assert.deepEqual(rows(page, 'shell:devConsole'), []);
	assert.deepEqual(rows(page, 'shell:devError'), []);
	// Every other message the shell posted to this parent carries no data (the
	// payload-free shell:devReady announcement).
	for (const p of page.posted) assert.deepEqual(Object.keys(p.message), ['type'], `only payload-free messages reach an unverified parent (${p.message.type})`);
});

test('a production build served on the production origin installs nothing and answers nobody (real listener)', async () => {
	const page = await bootShell({ framed: true, origin: CLOUD, nodeEnv: 'production', sameOriginParent: true, ancestorOrigin: 'vscode-webview://abc', search: '?rrdev=1&appid=org.victim' });
	assert.equal(page.listeners.length, 0, 'no message listener at all');
	assert.equal(Reflect.get(window, '__rrShellDev'), undefined);
	assert.deepEqual(page.posted, [], 'not even shell:devReady');
	assert.deepEqual(page.postedToOpener, []);
});

test('terminal host (rocketride app dev), exact sequence: a top-level loopback dev-proxy shell self-registers by URL convention', async () => {
	const fetched: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		fetched.push(String(input));
		return { ok: true, status: 200, json: async () => ({ version: '0.0.1', appManifest: { id: 'org.term', moduleId: 'org_term', name: 'Terminal App' } }) };
	}) as unknown as typeof fetch;
	await bootShell({ framed: false, origin: 'http://localhost:3013', search: '?appid=org.term&rrdev=1' });
	for (let i = 0; i < 50 && !loader.isDevRemote('org_term'); i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(fetched, ['/apps/org.term/dev/package.json']);
	assert.equal(loader.isDevRemote('org_term'), true, 'the dev app registered itself from its own loopback origin');
});

test('a dev flavor served from the cloud origin never self-registers from its URL (no probe, the hold fails at once)', async () => {
	const fetched: string[] = [];
	globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
	await bootShell({ framed: false, origin: CLOUD, search: '?appid=org.bare&rrdev=1' });
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(fetched, [], 'no request was made');
	assert.equal(loader.isDevRemote('org_bare'), false);
	await assert.rejects(loader.waitForDevRemote('org.bare'), /loopback dev server/, 'the hold falls into its published fallback instead of waiting 30s');
});

test('a page on another loopback port gets nothing from a loopback dev shell that holds the seeded token (real listener)', async () => {
	// The terminal host seeds `rocketride app dev`'s credential into the dev
	// proxy shell on http://localhost:<port>; any page on ANY loopback origin
	// (another local server, evil.localhost) that frames it must stay a stranger.
	const SHELL = 'http://localhost:7201';
	for (const attacker of ['http://127.0.0.1:7202', 'http://evil.localhost:7202', 'http://[::1]:7202']) {
		const page = await bootShell({ framed: true, origin: SHELL, ancestorOrigin: attacker, search: '?appid=org.vsc&rrdev=1' });
		const cm = connection.ConnectionManager.getInstance();
		cm.saveToken('seeded-by-rocketride-app-dev');
		deliver(page, { type: 'rrdev:auth', token: 'attacker-token' }, attacker, page.parent);
		deliver(page, { type: 'rrdev:auth', token: '' }, attacker, page.parent);
		deliver(page, registerRemoteOf('org_loopback_attacker'), attacker, page.parent);
		console.log('boot href ?code=FAKE-OAUTH-CODE');
		restoreConsole();
		assert.equal(cm.loadToken(), 'seeded-by-rocketride-app-dev', `${attacker}: the token is untouched`);
		assert.equal(loader.isDevRemote('org_loopback_attacker'), false, `${attacker}: no remote`);
		assert.deepEqual(rows(page, 'shell:devConsole'), [], `${attacker}: no console rows`);
		assert.equal(page.reloads(), 0, attacker);
	}
});
