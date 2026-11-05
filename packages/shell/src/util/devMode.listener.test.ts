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
// pre-fix listener and passes on the fixed one.
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
	opener: object;
	posted: Array<{ message: { type?: string }; target: string }>;
	reloads: () => number;
	localStorageData: Map<string, string>;
}

/** A permissive stand-in for DOM objects the shell barrel touches while loading. */
const anyStub = (): object => new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : anyStub()), apply: () => anyStub(), construct: () => anyStub() });
/** A document whose unknown members are permissive stubs; `referrer` is real. */
const stubDocument = (): object => new Proxy({ referrer: '', getElementById: () => null, cookie: '', currentScript: null, readyState: 'complete', querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : anyStub()) });

/** Installs a stub browser on globalThis; `listeners` collects window `message` listeners. */
function stubBrowser(opts: { framed: boolean; origin: string; ancestorOrigin?: string }, listeners: Listener[]): { parent: LivePage['parent']; opener: object; posted: LivePage['posted']; reloads: () => number; mem: Map<string, string> } {
	const posted: LivePage['posted'] = [];
	let reloads = 0;
	const self = {};
	const parent = { postMessage: (message: { type?: string }, target: string): void => { posted.push({ message, target }); } };
	const opener = { postMessage: () => {} };
	// localStorage (the SHARED token slot) and sessionStorage (the tab session —
	// the shell writes its `rr:tab` boot identity there) are separate areas, as
	// in a browser: the "nothing touched the token slot" assertions below must
	// not be confused by the tab-session write.
	const mem = new Map<string, string>();
	const sessionMem = new Map<string, string>();
	const storageOver = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } });
	Reflect.set(globalThis, 'window', {
		self,
		top: opts.framed ? parent : self,
		parent: opts.framed ? parent : self,
		opener,
		location: { search: '?rrdev=1', origin: opts.origin, pathname: '/', href: `${opts.origin}/?rrdev=1`, ancestorOrigins: opts.ancestorOrigin ? [opts.ancestorOrigin] : [], reload: () => { reloads++; } },
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
	return { parent, opener, posted, reloads: () => reloads, mem };
}

/** Removes the stub browser. */
function clearBrowser(): void {
	for (const key of ['window', 'document', 'sessionStorage', 'localStorage']) Reflect.deleteProperty(globalThis, key);
}

/** Boots the dev hooks (development build) on a stub page and returns the page. */
async function bootShell(opts: { framed: boolean; origin?: string; ancestorOrigin?: string }): Promise<LivePage> {
	process.env.NODE_ENV = 'development';
	const listeners: Listener[] = [];
	const b = stubBrowser({ ...opts, origin: opts.origin ?? CLOUD }, listeners);
	gate.resetDevGateForTests();
	await hooks.installDevHooks();
	assert.ok(listeners.length >= 1, 'the real listener was installed');
	return { listeners, parent: b.parent, opener: b.opener, posted: b.posted, reloads: b.reloads, localStorageData: b.mem };
}

/** Delivers a message to every listener the shell registered. */
function deliver(page: LivePage, data: unknown, origin: string, source: unknown): void {
	for (const l of page.listeners) l({ data, origin, source });
}

afterEach(() => {
	console.log = NATIVE_CONSOLE.log;
	console.warn = NATIVE_CONSOLE.warn;
	console.error = NATIVE_CONSOLE.error;
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
