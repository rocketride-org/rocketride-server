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

// Security regression suite for the dev-hook surface (rocketride-saas#1020):
// a production build must never enable dev hooks from the URL or
// sessionStorage, and the `rrdev:*` postMessage channel (session token,
// remote entry) must answer only to the embedding App Builder.

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { handleEmbedderMessage, installDevHooks } from './devMode';
import type { EmbedderMessageDeps } from './devMode';
import { isAllowedDevRemoteEntry, isAllowedEmbedderOrigin, isDevHooksEnabled, isEmbeddedDevShell, resetDevGateForTests, tokenStore } from './devGate';
import { isDevPreviewPage } from './appLoader';

const SHELL_ORIGIN = 'https://cloud.example.test';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

interface Page {
	/** Messages the page registered listeners for. */
	listeners: Array<(e: unknown) => void>;
	/** The window the shell believes is its parent embedder. */
	parent: object;
	/** The window that opened this one (an attacker's page, in the hostile cases). */
	opener: object;
}

/**
 * Stages a shell page: build mode, URL, sessionStorage flag and whether the
 * page is framed (self !== top) or a top-level tab.
 */
function stagePage(opts: { nodeEnv: 'production' | 'development'; search?: string; sessionDev?: boolean; framed: boolean }): Page {
	process.env.NODE_ENV = opts.nodeEnv;
	resetDevGateForTests();
	const listeners: Array<(e: unknown) => void> = [];
	const self = {};
	const parent = {};
	const opener = {};
	const win = {
		self,
		top: opts.framed ? parent : self,
		parent: opts.framed ? parent : self,
		opener,
		location: { search: opts.search ?? '', origin: SHELL_ORIGIN, pathname: '/' },
		addEventListener: (type: string, listener: (e: unknown) => void) => {
			if (type === 'message') listeners.push(listener);
		},
	};
	Reflect.set(globalThis, 'window', win);
	Reflect.set(globalThis, 'document', { referrer: '' });
	const store = new Map<string, string>(opts.sessionDev ? [['rr:dev', '1']] : []);
	Reflect.set(globalThis, 'sessionStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	Reflect.set(globalThis, 'localStorage', { __marker: 'localStorage' });
	return { listeners, parent: parent === win.self ? {} : parent, opener };
}

/** Recording collaborators for handleEmbedderMessage. */
function recordingDeps(initialToken = '') {
	const calls = { register: [] as string[][], saved: [] as string[], cleared: 0, reloads: 0 };
	let token = initialToken;
	const deps: EmbedderMessageDeps = {
		registerRemote: ((appId: string, moduleId: string, name: string, entry: string) => void calls.register.push([appId, moduleId, name, entry])) as EmbedderMessageDeps['registerRemote'],
		connection: () => ({
			loadToken: () => token,
			saveToken: (t: string) => { token = t; calls.saved.push(t); },
			clearToken: () => { token = ''; calls.cleared++; },
		}),
		reload: () => { calls.reloads++; },
	};
	return { deps, calls };
}

afterEach(() => {
	mock.restoreAll();
	process.env.NODE_ENV = ORIGINAL_NODE_ENV;
	resetDevGateForTests();
	for (const key of ['window', 'document', 'sessionStorage', 'localStorage']) Reflect.deleteProperty(globalThis, key);
});

// ---------------------------------------------------------------------------
// The gate: a build-time capability, never a URL / sessionStorage one
// ---------------------------------------------------------------------------

test('a production build ignores ?rrdev=1: the gate is closed and no hooks are installed', async () => {
	const page = stagePage({ nodeEnv: 'production', search: '?rrdev=1&appid=org.victim', framed: true });
	assert.equal(isDevHooksEnabled(), false);
	assert.equal(isEmbeddedDevShell(), false);
	assert.equal(isDevPreviewPage(), false, 'a production build is never a dev preview, whatever the URL says');
	await installDevHooks();
	assert.equal(page.listeners.length, 0, 'no message listener was registered');
	assert.equal(Reflect.get(window, '__rrShellDev'), undefined, 'window.__rrShellDev was not exposed');
	assert.equal(tokenStore(), localStorage, 'the token still lives in the shared localStorage slot');
});

test('a production build ignores the sessionStorage rr:dev flag (what the flavor picker persists)', async () => {
	const page = stagePage({ nodeEnv: 'production', sessionDev: true, framed: true });
	assert.equal(isDevHooksEnabled(), false);
	assert.equal(isEmbeddedDevShell(), false);
	assert.equal(isDevPreviewPage(), false);
	await installDevHooks();
	assert.equal(page.listeners.length, 0);
	assert.equal(Reflect.get(window, '__rrShellDev'), undefined);
});

test('a production build refuses rrdev messages even from a well-formed embedder', () => {
	const page = stagePage({ nodeEnv: 'production', search: '?rrdev=1', sessionDev: true, framed: true });
	const { deps, calls } = recordingDeps();
	mock.method(console, 'warn', () => {});
	handleEmbedderMessage({ data: { type: 'rrdev:auth', token: 'attacker-token' }, origin: 'vscode-webview://abc', source: page.parent as MessageEventSource }, deps);
	handleEmbedderMessage({ data: { type: 'rrdev:registerRemote', appId: 'a.b', moduleId: 'a_b', entry: 'http://localhost:3001/remoteEntry.js' }, origin: 'vscode-webview://abc', source: page.parent as MessageEventSource }, deps);
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

test('a development build keeps the gate open without any URL flag', () => {
	stagePage({ nodeEnv: 'development', framed: true });
	assert.equal(isDevHooksEnabled(), true);
	assert.equal(isEmbeddedDevShell(), true);
});

// ---------------------------------------------------------------------------
// The message channel: only the embedding App Builder may drive it
// ---------------------------------------------------------------------------

const AUTH = { type: 'rrdev:auth', token: 'attacker-token' };
const REGISTER = { type: 'rrdev:registerRemote', appId: 'org.app', moduleId: 'org_app', name: 'App', entry: 'http://localhost:3001/remoteEntry.js' };

test('messages from an unexpected origin are ignored, even from the parent window', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	for (const origin of ['https://attacker.example', 'https://evil.test', 'null', '', 'http://localhost.attacker.example', 'http://127.0.0.1.attacker.example', 'file://', 'https://cloud.example.test.attacker.example']) {
		handleEmbedderMessage({ data: AUTH, origin, source: page.parent as MessageEventSource }, deps);
		handleEmbedderMessage({ data: REGISTER, origin, source: page.parent as MessageEventSource }, deps);
	}
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

test('a hostile window.opener is ignored even when it claims an allowed origin', () => {
	const page = stagePage({ nodeEnv: 'development', framed: false });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	// The attacker opened this tab (window.open): it is the opener, never the parent.
	handleEmbedderMessage({ data: AUTH, origin: 'https://attacker.example', source: page.opener as MessageEventSource }, deps);
	handleEmbedderMessage({ data: REGISTER, origin: 'https://attacker.example', source: page.opener as MessageEventSource }, deps);
	// Spoofing an allowed origin string does not help: the source is not the parent.
	handleEmbedderMessage({ data: AUTH, origin: SHELL_ORIGIN, source: page.opener as MessageEventSource }, deps);
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

test('a hostile framing parent (foreign origin) is ignored', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	handleEmbedderMessage({ data: AUTH, origin: 'https://attacker.example', source: page.parent as MessageEventSource }, deps);
	handleEmbedderMessage({ data: REGISTER, origin: 'https://attacker.example', source: page.parent as MessageEventSource }, deps);
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

test('a sibling or child frame (not the parent) is ignored even from an allowed origin', () => {
	stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	handleEmbedderMessage({ data: AUTH, origin: SHELL_ORIGIN, source: {} as MessageEventSource }, deps);
	handleEmbedderMessage({ data: AUTH, origin: SHELL_ORIGIN, source: null }, deps);
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

test('rrdev:auth and rrdev:registerRemote are ignored by a top-level (not embedded) shell', () => {
	const page = stagePage({ nodeEnv: 'development', framed: false });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	// Top level: window.parent === window itself; a same-origin sender is still no embedder.
	const self = Reflect.get(window, 'self');
	handleEmbedderMessage({ data: AUTH, origin: SHELL_ORIGIN, source: self }, deps);
	handleEmbedderMessage({ data: REGISTER, origin: SHELL_ORIGIN, source: self }, deps);
	handleEmbedderMessage({ data: AUTH, origin: 'http://localhost:5173', source: page.opener as MessageEventSource }, deps);
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

test('registerRemote entries outside the loopback dev servers are rejected', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps();
	mock.method(console, 'warn', () => {});
	for (const entry of ['https://attacker.example/remoteEntry.js', '//attacker.example/remoteEntry.js', 'javascript:alert(1)', 'data:text/javascript,alert(1)', 'http://localhost.attacker.example/remoteEntry.js', 'http://localhost@attacker.example/remoteEntry.js', 'http://user:pw@localhost:3001/remoteEntry.js', '/remoteEntry.js', 'remoteEntry.js', 'ws://localhost:3001/x', 'http://10.0.0.5:3001/remoteEntry.js']) {
		handleEmbedderMessage({ data: { ...REGISTER, entry }, origin: 'vscode-webview://abc', source: page.parent as MessageEventSource }, deps);
	}
	assert.deepEqual(calls.register, [], 'the embedder-trusted channel still refuses non-dev-server entries');
});

test('the legitimate local preview still works: VS Code webview embedder, loopback and same-origin embedders', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps();
	for (const origin of ['vscode-webview://0123abcd-ef01', 'http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:3000', SHELL_ORIGIN]) {
		handleEmbedderMessage({ data: REGISTER, origin, source: page.parent as MessageEventSource }, deps);
	}
	assert.equal(calls.register.length, 5);
	assert.deepEqual(calls.register[0], ['org.app', 'org_app', 'App', 'http://localhost:3001/remoteEntry.js']);

	// rrdev:auth: adopt a token, then clear it (post-boot changes reboot the page once).
	handleEmbedderMessage({ data: { type: 'rrdev:auth', token: 'host-token' }, origin: 'vscode-webview://0123abcd-ef01', source: page.parent as MessageEventSource }, deps);
	assert.deepEqual(calls.saved, ['host-token']);
	assert.equal(calls.reloads, 1);
	handleEmbedderMessage({ data: { type: 'rrdev:auth', token: 'host-token' }, origin: 'vscode-webview://0123abcd-ef01', source: page.parent as MessageEventSource }, deps);
	assert.equal(calls.reloads, 1, 're-answering the same state is a no-op');
	handleEmbedderMessage({ data: { type: 'rrdev:auth', token: '' }, origin: 'vscode-webview://0123abcd-ef01', source: page.parent as MessageEventSource }, deps);
	assert.equal(calls.cleared, 1);
});

test('unrelated window messages are ignored silently', () => {
	stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps();
	const warn = mock.method(console, 'warn', () => {});
	handleEmbedderMessage({ data: { type: 'something-else' }, origin: 'https://attacker.example', source: null }, deps);
	handleEmbedderMessage({ data: 'text', origin: 'https://attacker.example', source: null }, deps);
	handleEmbedderMessage({ data: undefined, origin: 'https://attacker.example', source: null }, deps);
	assert.equal(warn.mock.callCount(), 0);
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

// ---------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------

test('isAllowedEmbedderOrigin accepts only the shell, vscode-webview and loopback origins', () => {
	const ok = ['vscode-webview://abc-123', 'http://localhost:5173', 'https://localhost', 'http://127.0.0.1:3000', 'http://127.1.2.3:3000', 'http://[::1]:3000', 'http://app.localhost:3000', SHELL_ORIGIN];
	const bad = ['', 'null', 'https://attacker.example', 'http://localhost.attacker.example', 'http://127.0.0.1.attacker.example', 'vscode-webview://', 'vscode-webview://abc/extra', 'http://localhost:5173/path', 'ftp://localhost', 'javascript:alert(1)', 'not a url', 'http://10.0.0.1', 'https://cloud.example.test.attacker.example'];
	for (const o of ok) assert.equal(isAllowedEmbedderOrigin(o, SHELL_ORIGIN), true, o);
	for (const o of bad) assert.equal(isAllowedEmbedderOrigin(o, SHELL_ORIGIN), false, JSON.stringify(o));
});

test('isAllowedDevRemoteEntry accepts only absolute http(s) loopback URLs without credentials', () => {
	for (const e of ['http://localhost:3001/remoteEntry.js?t=1', 'http://127.0.0.1:5173/remoteEntry.js', 'http://[::1]:3000/remoteEntry.js', 'https://app.localhost/remoteEntry.js']) assert.equal(isAllowedDevRemoteEntry(e), true, e);
	for (const e of ['https://attacker.example/x.js', '//attacker.example/x.js', 'javascript:alert(1)', 'data:text/javascript,1', '', '/x.js', 'http://localhost.evil.test/x.js', 'http://localhost:1@evil.test/x.js', 'http://u:p@localhost/x.js']) assert.equal(isAllowedDevRemoteEntry(e), false, e);
});
