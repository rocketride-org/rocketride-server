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
// a production build must never enable dev hooks from the URL, sessionStorage
// or an injected boot config, and the `rrdev:*` postMessage channel (session
// token, remote entry) must answer only to its two legitimate embedders: the
// VS Code App Builder webview and the web App Builder (same-origin parent of
// its preview iframe, same-origin opener of its debug tab).

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { handleEmbedderMessage, installDevHooks } from './devMode';
import type { EmbedderMessageDeps } from './devMode';
import { isAllowedDevRemoteEntry, isAllowedEmbedderOrigin, isDevHooksEnabled, isEmbeddedDevShell, isTrustedEmbedderMessage, normalizeDevRemoteEntry, resetDevGateForTests, tabSession, tokenStore, trustedParentOrigin } from './devGate';
import { isDevPreviewPage } from './appLoader';

const SHELL_ORIGIN = 'https://cloud.example.test';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

interface Page {
	/** Messages the page registered listeners for. */
	listeners: Array<(e: unknown) => void>;
	/** The window the shell believes is its parent embedder (the page itself when top-level). */
	parent: object;
	/** The window that opened this one (an attacker's page, in the hostile cases). */
	opener: object;
	/** A window that is NEITHER the parent nor the opener (a sibling/child frame). */
	stranger: object;
	/** The shell's own window. */
	self: object;
	/** `window.top` (the grandparent of a nested frame; the parent / the shell itself otherwise). */
	top: object;
}

/**
 * Stages a shell page: build mode, URL, sessionStorage flag, whether the
 * page is framed (self !== top) or a top-level tab, its own origin, and — for
 * a framed page — whether the parent shares that origin (a cross-origin
 * parent's `location` is unreadable, which is how the browser reports it).
 */
function stagePage(opts: { nodeEnv: 'production' | 'development'; search?: string; sessionDev?: boolean; framed: boolean; shellOrigin?: string; parentSameOrigin?: boolean; noOpener?: boolean; nested?: boolean }): Page {
	process.env.NODE_ENV = opts.nodeEnv;
	resetDevGateForTests();
	const listeners: Array<(e: unknown) => void> = [];
	const shellOrigin = opts.shellOrigin ?? SHELL_ORIGIN;
	const self = {};
	const parent: Record<string, unknown> = {};
	if (opts.framed) {
		if (opts.parentSameOrigin) parent.location = { origin: shellOrigin };
		else Object.defineProperty(parent, 'location', { get: () => { throw new Error('SecurityError: cross-origin parent'); } });
	}
	const opener = {};
	// A nested frame has a top that is NOT its parent (shell -> middle frame -> top page).
	const top: object = opts.framed ? (opts.nested ? {} : parent) : self;
	const win = {
		self,
		top,
		parent: opts.framed ? parent : self,
		opener: opts.noOpener ? null : opener,
		location: { search: opts.search ?? '', origin: shellOrigin, pathname: '/' },
		addEventListener: (type: string, listener: (e: unknown) => void) => {
			if (type === 'message') listeners.push(listener);
		},
	};
	Reflect.set(globalThis, 'window', win);
	Reflect.set(globalThis, 'document', { referrer: '' });
	const store = new Map<string, string>(opts.sessionDev ? [['rr:dev', '1'], ['rr:tab', JSON.stringify({ dev: true, appId: 'org.victim', authOrigin: '' })]] : []);
	Reflect.set(globalThis, 'sessionStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	Reflect.set(globalThis, 'localStorage', { __marker: 'localStorage' });
	return { listeners, parent: opts.framed ? parent : {}, opener, stranger: {}, self, top };
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

test('a production build ignores the persisted tab session and rr:dev flag (what the flavor picker persists)', async () => {
	const page = stagePage({ nodeEnv: 'production', sessionDev: true, framed: true });
	assert.equal(isDevHooksEnabled(), false);
	assert.equal(isEmbeddedDevShell(), false);
	assert.equal(isDevPreviewPage(), false);
	await installDevHooks();
	assert.equal(page.listeners.length, 0);
	assert.equal(Reflect.get(window, '__rrShellDev'), undefined);
});

test('a production build ignores an injected __rrDevBoot (the web App Builder\'s authored-page signal)', async () => {
	const page = stagePage({ nodeEnv: 'production', framed: true });
	Reflect.set(window, '__rrDevBoot', { appId: 'org.victim' });
	assert.equal(isDevHooksEnabled(), false, 'an injected boot config is a page-supplied fact, not a capability');
	assert.equal(isEmbeddedDevShell(), false);
	await installDevHooks();
	assert.equal(page.listeners.length, 0);
	assert.equal(Reflect.get(window, '__rrShellDev'), undefined);
});

test('the production gate is constant: every URL / storage / boot-config combination leaves it closed', () => {
	for (const search of ['', '?rrdev=1', '?rrdev=1&appid=org.victim&rrauthorigin=https%3A%2F%2Fattacker.example', '?RRDEV=1', '?rrdev=true']) {
		for (const sessionDev of [false, true]) {
			for (const framed of [false, true]) {
				for (const bootConfig of [false, true]) {
					stagePage({ nodeEnv: 'production', search, sessionDev, framed });
					if (bootConfig) Reflect.set(window, '__rrDevBoot', { appId: 'org.victim' });
					const label = JSON.stringify({ search, sessionDev, framed, bootConfig });
					assert.equal(isDevHooksEnabled(), false, label);
					assert.equal(tabSession().dev, false, `${label}: a production build is never a dev tab`);
				}
			}
		}
	}
});

test('a production build refuses rrdev messages even from a well-formed embedder', () => {
	const page = stagePage({ nodeEnv: 'production', search: '?rrdev=1', sessionDev: true, framed: true, parentSameOrigin: true });
	const { deps, calls } = recordingDeps();
	mock.method(console, 'warn', () => {});
	for (const origin of ['vscode-webview://abc', SHELL_ORIGIN]) {
		handleEmbedderMessage({ data: { type: 'rrdev:auth', token: 'attacker-token' }, origin, source: page.parent as MessageEventSource }, deps);
		handleEmbedderMessage({ data: { type: 'rrdev:registerRemote', appId: 'a.b', moduleId: 'a_b', entry: 'http://localhost:3001/remoteEntry.js' }, origin, source: page.parent as MessageEventSource }, deps);
	}
	assert.deepEqual(calls, { register: [], saved: [], cleared: 0, reloads: 0 });
});

test('a development build keeps the gate open without any URL flag', () => {
	stagePage({ nodeEnv: 'development', framed: true });
	assert.equal(isDevHooksEnabled(), true);
	assert.equal(isEmbeddedDevShell(), true);
});

// ---------------------------------------------------------------------------
// The message channel: only the two real embedders may drive it
// ---------------------------------------------------------------------------

const AUTH = { type: 'rrdev:auth', token: 'attacker-token' };
const REGISTER = { type: 'rrdev:registerRemote', appId: 'org.app', moduleId: 'org_app', name: 'App', entry: 'http://localhost:3001/remoteEntry.js' };
const NOTHING = { register: [], saved: [], cleared: 0, reloads: 0 };

/** Delivers `data` as if the browser had dispatched it with this origin/source. */
const send = (deps: EmbedderMessageDeps, data: unknown, origin: string, source: unknown): void => handleEmbedderMessage({ data, origin, source: source as MessageEventSource | null }, deps);

test('messages from an unexpected origin are ignored, even from the parent window', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	for (const origin of ['https://attacker.example', 'https://evil.test', 'null', '', 'http://localhost.attacker.example', 'http://127.0.0.1.attacker.example', 'file://', 'https://cloud.example.test.attacker.example']) {
		send(deps, AUTH, origin, page.parent);
		send(deps, REGISTER, origin, page.parent);
	}
	assert.deepEqual(calls, NOTHING);
});

test('a hostile window.opener is ignored (the attacker window.open()s the shell)', () => {
	const page = stagePage({ nodeEnv: 'development', framed: false });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	// The attacker opened this tab (window.open): it is the opener, and its origin is its own.
	for (const origin of ['https://attacker.example', 'null', '', 'http://localhost:5173', 'vscode-webview://abc']) {
		send(deps, AUTH, origin, page.opener);
		send(deps, { type: 'rrdev:auth', token: '' }, origin, page.opener);
		send(deps, REGISTER, origin, page.opener);
	}
	assert.deepEqual(calls, NOTHING);
});

test('a hostile framing parent (foreign origin) is ignored', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	send(deps, AUTH, 'https://attacker.example', page.parent);
	send(deps, REGISTER, 'https://attacker.example', page.parent);
	assert.deepEqual(calls, NOTHING);
});

test('a sibling or child frame (not the parent) is ignored even from an allowed origin', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true, parentSameOrigin: true });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	for (const origin of [SHELL_ORIGIN, 'vscode-webview://abc']) {
		send(deps, AUTH, origin, page.stranger);
		send(deps, AUTH, origin, null);
	}
	// Framed shells have no opener relation at all.
	send(deps, AUTH, SHELL_ORIGIN, page.opener);
	assert.deepEqual(calls, NOTHING);
});

test('a top-level shell has no parent: self-posts and strangers are ignored', () => {
	const page = stagePage({ nodeEnv: 'development', framed: false });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	// Top level: window.parent === window itself; a same-origin self-post is still no embedder.
	send(deps, AUTH, SHELL_ORIGIN, page.self);
	send(deps, REGISTER, SHELL_ORIGIN, page.self);
	send(deps, AUTH, SHELL_ORIGIN, page.stranger);
	send(deps, AUTH, SHELL_ORIGIN, null);
	assert.deepEqual(calls, NOTHING);
});

test('registerRemote entries outside the loopback dev servers are rejected', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps();
	mock.method(console, 'warn', () => {});
	for (const entry of ['https://attacker.example/remoteEntry.js', '//attacker.example/remoteEntry.js', 'javascript:alert(1)', 'data:text/javascript,alert(1)', 'http://localhost.attacker.example/remoteEntry.js', 'http://localhost@attacker.example/remoteEntry.js', 'http://user:pw@localhost:3001/remoteEntry.js', '/remoteEntry.js', 'remoteEntry.js', 'ws://localhost:3001/x', 'http://10.0.0.5:3001/remoteEntry.js', 'blob:http://localhost:3001/0000', 'file:///etc/passwd']) {
		send(deps, { ...REGISTER, entry }, 'vscode-webview://abc', page.parent);
	}
	assert.deepEqual(calls.register, [], 'the embedder-trusted channel still refuses non-dev-server entries');
});

test('the VS Code preview works: a vscode-webview parent drives a loopback dev-proxy shell and a cloud-served one', () => {
	for (const shellOrigin of ['http://localhost:3013', SHELL_ORIGIN]) {
		const page = stagePage({ nodeEnv: 'development', framed: true, shellOrigin });
		const { deps, calls } = recordingDeps();
		const entry = 'http://localhost:3013/apps/org.app/dev/remoteEntry.js?t=1730000000000';
		send(deps, { ...REGISTER, entry }, 'vscode-webview://0123abcd-ef01', page.parent);
		assert.deepEqual(calls.register, [['org.app', 'org_app', 'App', entry]], shellOrigin);

		// rrdev:auth: adopt a token, then clear it (post-boot changes reboot the page once).
		send(deps, { type: 'rrdev:auth', token: 'host-token' }, 'vscode-webview://0123abcd-ef01', page.parent);
		assert.deepEqual(calls.saved, ['host-token']);
		assert.equal(calls.reloads, 1);
		send(deps, { type: 'rrdev:auth', token: 'host-token' }, 'vscode-webview://0123abcd-ef01', page.parent);
		assert.equal(calls.reloads, 1, 're-answering the same state is a no-op');
		send(deps, { type: 'rrdev:auth', token: '' }, 'vscode-webview://0123abcd-ef01', page.parent);
		assert.equal(calls.cleared, 1);
	}
});

test('the web App Builder preview works: the same-origin parent answers rrdev:auth (grant, no-op re-answer, revoke)', () => {
	// The preview is a blob: page minted by the builder, so it shares the builder's origin.
	const page = stagePage({ nodeEnv: 'development', framed: true, parentSameOrigin: true });
	const { deps, calls } = recordingDeps();
	send(deps, { type: 'rrdev:auth', token: 'builder-token' }, SHELL_ORIGIN, page.parent);
	assert.deepEqual(calls.saved, ['builder-token']);
	assert.equal(calls.reloads, 1, 'a post-boot answer reboots into the new state once');
	send(deps, { type: 'rrdev:auth', token: 'builder-token' }, SHELL_ORIGIN, page.parent);
	assert.equal(calls.reloads, 1, 're-answering the same state is a no-op');
	send(deps, { type: 'rrdev:auth', token: '' }, SHELL_ORIGIN, page.parent);
	assert.equal(calls.cleared, 1, 'Inherit Auth off: the empty answer revokes');
});

test('the web App Builder debug tab works: the same-origin OPENER of a top-level shell answers rrdev:auth', () => {
	const page = stagePage({ nodeEnv: 'development', framed: false });
	assert.equal(isEmbeddedDevShell(), false, 'the debug tab is a top-level window');
	const { deps, calls } = recordingDeps();
	send(deps, { type: 'rrdev:auth', token: 'builder-token' }, SHELL_ORIGIN, page.opener);
	assert.deepEqual(calls.saved, ['builder-token']);
	send(deps, { type: 'rrdev:auth', token: '' }, SHELL_ORIGIN, page.opener);
	assert.equal(calls.cleared, 1);
});

test('the same-origin allowance is exactly the shell\'s own origin: lookalikes, other schemes/ports and paths are refused', () => {
	for (const framed of [true, false]) {
		const page = stagePage({ nodeEnv: 'development', framed, parentSameOrigin: true });
		const { deps, calls } = recordingDeps('user-token');
		mock.method(console, 'warn', () => {});
		const source = framed ? page.parent : page.opener;
		for (const origin of ['https://cloud.example.test.evil.test', 'https://evil-cloud.example.test', 'https://sub.cloud.example.test', 'http://cloud.example.test', 'https://cloud.example.test:8443', 'https://cloud.example.test/', 'https://cloud.example.test/path', 'https://cloud.example.test@evil.test', 'HTTPS://CLOUD.EXAMPLE.TEST.evil.test', 'null', '', 'blob:https://cloud.example.test/uuid', 'about:blank', 'data:text/html,x']) {
			send(deps, AUTH, origin, source);
			send(deps, REGISTER, origin, source);
		}
		assert.deepEqual(calls, NOTHING, `framed=${framed}`);
		mock.restoreAll();
	}
});

test('an opaque shell origin never reads as "same origin" with an opaque sender', () => {
	// A sandboxed / data: shell reports location.origin === 'null', and so does
	// every sandboxed sender: 'null' === 'null' must not authorise anything.
	for (const framed of [true, false]) {
		const page = stagePage({ nodeEnv: 'development', framed, shellOrigin: 'null' });
		const { deps, calls } = recordingDeps('user-token');
		mock.method(console, 'warn', () => {});
		send(deps, AUTH, 'null', framed ? page.parent : page.opener);
		send(deps, REGISTER, 'null', framed ? page.parent : page.opener);
		assert.deepEqual(calls, NOTHING, `framed=${framed}`);
		mock.restoreAll();
	}
});

test('the OPENER relation accepts only the shell\'s own origin, never the other embedder origins', () => {
	const cloud = stagePage({ nodeEnv: 'development', framed: false });
	const a = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	send(a.deps, AUTH, 'vscode-webview://abc', cloud.opener);
	send(a.deps, AUTH, 'http://localhost:5173', cloud.opener);
	assert.deepEqual(a.calls, NOTHING);
	mock.restoreAll();
	// Even a loopback-served shell: a loopback opener on another port is not its debug window.
	const local = stagePage({ nodeEnv: 'development', framed: false, shellOrigin: 'http://localhost:5565' });
	const b = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	send(b.deps, AUTH, 'http://localhost:5173', local.opener);
	send(b.deps, AUTH, 'http://127.0.0.1:5565', local.opener);
	assert.deepEqual(b.calls, NOTHING);
});

test('a loopback origin is never a sender: denied for a cloud shell AND a loopback shell, as parent AND as opener', () => {
	// The critic's repro: any page on any loopback port (another local server,
	// `evil.localhost`) framing or opening a dev shell on `http://localhost:<port>`
	// — whose localStorage holds the token `rocketride app dev` seeded.
	const senders = ['http://localhost:5173', 'http://localhost:5565', 'http://127.0.0.1:5173', 'http://127.0.0.1:5565', 'http://127.1.2.3:8080', 'http://[::1]:3000', 'http://evil.localhost:5173', 'https://localhost:3000', 'http://localhost.evil.test:5173', 'http://127.0.0.1.evil.test'];
	for (const shellOrigin of [SHELL_ORIGIN, 'http://localhost:5565', 'http://127.0.0.1:5565']) {
		for (const framed of [true, false]) {
			const page = stagePage({ nodeEnv: 'development', framed, shellOrigin });
			const { deps, calls } = recordingDeps('user-token');
			mock.method(console, 'warn', () => {});
			const source = framed ? page.parent : page.opener;
			for (const origin of senders) {
				// A loopback sender is "the same origin" only when it IS the shell's own origin.
				if (origin === shellOrigin) continue;
				send(deps, AUTH, origin, source);
				send(deps, { type: 'rrdev:auth', token: '' }, origin, source);
				send(deps, REGISTER, origin, source);
			}
			assert.deepEqual(calls, NOTHING, `shell ${shellOrigin}, ${framed ? 'parent' : 'opener'}`);
			assert.equal(trustedParentOrigin(), '', 'and no console rows would be aimed at it');
			mock.restoreAll();
		}
	}
});

test('unrelated window messages are ignored silently', () => {
	stagePage({ nodeEnv: 'development', framed: true });
	const { deps, calls } = recordingDeps();
	const warn = mock.method(console, 'warn', () => {});
	send(deps, { type: 'something-else' }, 'https://attacker.example', null);
	send(deps, 'text', 'https://attacker.example', null);
	send(deps, undefined, 'https://attacker.example', null);
	assert.equal(warn.mock.callCount(), 0);
	assert.deepEqual(calls, NOTHING);
});

test('a top-level tab with NO opener trusts no window: a null/undefined/other source is never "the opener" (opener == null confusion)', () => {
	const page = stagePage({ nodeEnv: 'development', framed: false, noOpener: true });
	assert.equal(Reflect.get(window, 'opener'), null);
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	// `null === window.opener` would be true for a null source: it must not read as a relation.
	for (const source of [null, undefined, page.stranger, page.self, page.parent, page.opener]) {
		send(deps, AUTH, SHELL_ORIGIN, source);
		send(deps, REGISTER, SHELL_ORIGIN, source);
		assert.equal(isTrustedEmbedderMessage({ origin: SHELL_ORIGIN, source }), false, String(source));
	}
	assert.deepEqual(calls, NOTHING);
});

test('a top-level tab WITH an opener refuses a different same-origin window; only the real opener passes', () => {
	const page = stagePage({ nodeEnv: 'development', framed: false });
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	for (const source of [page.stranger, page.self, null, undefined]) {
		send(deps, AUTH, SHELL_ORIGIN, source);
		send(deps, REGISTER, SHELL_ORIGIN, source);
	}
	assert.deepEqual(calls, NOTHING, 'another same-origin window is not the opener');
	// control: the opener itself is accepted
	send(deps, { type: 'rrdev:auth', token: 'builder-session' }, SHELL_ORIGIN, page.opener);
	assert.deepEqual(calls.saved, ['builder-session']);
});

test('a nested framed shell does not accept window.top: only the PARENT, and only from an allowed origin', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true, nested: true, parentSameOrigin: true });
	assert.notEqual(page.top, page.parent, 'the fixture is a nested frame');
	const { deps, calls } = recordingDeps('user-token');
	mock.method(console, 'warn', () => {});
	for (const origin of [SHELL_ORIGIN, 'vscode-webview://abc', 'https://attacker.example']) {
		send(deps, AUTH, origin, page.top);
		send(deps, REGISTER, origin, page.top);
		assert.equal(isTrustedEmbedderMessage({ origin, source: page.top }), false, `top from ${origin}`);
	}
	assert.deepEqual(calls, NOTHING, 'the top page is neither parent nor opener');
	// control: the real parent is accepted
	send(deps, { type: 'rrdev:auth', token: 'builder-session' }, SHELL_ORIGIN, page.parent);
	assert.deepEqual(calls.saved, ['builder-session']);
});

// ---------------------------------------------------------------------------
// The policy table — one row per (shell served from, window relation, sender
// origin). Each row is ONE named test so a failure names the row.
// ---------------------------------------------------------------------------

interface PolicyRow {
	id: string;
	/** What the row is. */
	what: string;
	shell: string;
	/** 'parent' (framed shell), 'opener' (top-level shell), or a non-embedder window. */
	relation: 'parent' | 'opener' | 'stranger' | 'self';
	sender: string;
	allow: boolean;
	nodeEnv?: 'production' | 'development';
}

const CLOUD = SHELL_ORIGIN;
const LOCAL = 'http://localhost:5565';
const POLICY: PolicyRow[] = [
	{ id: 'P1', what: 'VS Code App Builder -> cloud-served shell iframe', shell: CLOUD, relation: 'parent', sender: 'vscode-webview://abc-123', allow: true },
	{ id: 'P2', what: 'VS Code App Builder -> loopback dev-proxy shell iframe', shell: 'http://localhost:3013', relation: 'parent', sender: 'vscode-webview://abc-123', allow: true },
	{ id: 'P3', what: 'web App Builder -> same-origin blob preview iframe', shell: CLOUD, relation: 'parent', sender: CLOUD, allow: true },
	{ id: 'P4', what: 'web App Builder -> same-origin debug tab (opener)', shell: CLOUD, relation: 'opener', sender: CLOUD, allow: true },
	{ id: 'P5', what: 'foreign page frames the shell', shell: CLOUD, relation: 'parent', sender: 'https://attacker.example', allow: false },
	{ id: 'P6', what: 'foreign page window.open()s the shell', shell: CLOUD, relation: 'opener', sender: 'https://attacker.example', allow: false },
	{ id: 'P7', what: 'a vscode-webview opener (only a PARENT may be one)', shell: CLOUD, relation: 'opener', sender: 'vscode-webview://abc-123', allow: false },
	{ id: 'P8', what: 'loopback page frames a CLOUD-served shell', shell: CLOUD, relation: 'parent', sender: 'http://localhost:5173', allow: false },
	{ id: 'P9', what: 'loopback page window.open()s a CLOUD-served shell', shell: CLOUD, relation: 'opener', sender: 'http://localhost:5173', allow: false },
	{ id: 'P10', what: 'loopback page frames a loopback-served shell (no in-repo sender; was trusted before, now denied)', shell: LOCAL, relation: 'parent', sender: 'http://localhost:5173', allow: false },
	{ id: 'P11', what: 'loopback page window.open()s a loopback-served shell', shell: LOCAL, relation: 'opener', sender: 'http://localhost:5173', allow: false },
	{ id: 'P12', what: 'sandboxed / opaque sender frames the shell', shell: CLOUD, relation: 'parent', sender: 'null', allow: false },
	{ id: 'P13', what: 'sandboxed / opaque sender opens the shell', shell: CLOUD, relation: 'opener', sender: 'null', allow: false },
	{ id: 'P14', what: 'same-origin sibling/child frame (not the parent)', shell: CLOUD, relation: 'stranger', sender: CLOUD, allow: false },
	{ id: 'P15', what: 'the shell posting to itself (top level)', shell: CLOUD, relation: 'self', sender: CLOUD, allow: false },
	{ id: 'P16', what: 'origin lookalike of the shell frames it', shell: CLOUD, relation: 'parent', sender: 'https://cloud.example.test.evil.test', allow: false },
	{ id: 'P17', what: 'origin lookalike of loopback frames a loopback shell', shell: LOCAL, relation: 'parent', sender: 'http://localhost.evil.test:5173', allow: false },
	{ id: 'P18', what: 'lookalike of the vscode-webview scheme frames the shell', shell: CLOUD, relation: 'parent', sender: 'https://vscode-webview.evil.test', allow: false },
	{ id: 'P19', what: 'vscode-webview opener-style origin with a path', shell: CLOUD, relation: 'parent', sender: 'vscode-webview://abc-123/index.html', allow: false },
	{ id: 'P20', what: 'production build: the VS Code parent', shell: CLOUD, relation: 'parent', sender: 'vscode-webview://abc-123', allow: false, nodeEnv: 'production' },
	{ id: 'P21', what: 'production build: the same-origin parent', shell: CLOUD, relation: 'parent', sender: CLOUD, allow: false, nodeEnv: 'production' },
	{ id: 'P22', what: 'production build: the same-origin opener', shell: CLOUD, relation: 'opener', sender: CLOUD, allow: false, nodeEnv: 'production' },
	{ id: 'P23', what: 'another loopback origin (127.0.0.1) frames a localhost-served shell', shell: 'http://localhost:7201', relation: 'parent', sender: 'http://127.0.0.1:7202', allow: false },
	{ id: 'P24', what: 'evil.localhost frames a localhost-served shell', shell: 'http://localhost:7201', relation: 'parent', sender: 'http://evil.localhost:7202', allow: false },
	{ id: 'P25', what: 'the SAME loopback origin frames a loopback-served shell (the web builder on a local engine)', shell: LOCAL, relation: 'parent', sender: LOCAL, allow: true },
	{ id: 'P26', what: 'the SAME loopback origin opens a loopback-served shell (debug tab on a local engine)', shell: LOCAL, relation: 'opener', sender: LOCAL, allow: true },
];

for (const row of POLICY) {
	test(`policy ${row.id}: ${row.what} -> ${row.allow ? 'ACCEPTED' : 'DENIED'}`, () => {
		const framed = row.relation === 'parent' || row.relation === 'stranger';
		const page = stagePage({ nodeEnv: row.nodeEnv ?? 'development', framed, shellOrigin: row.shell, parentSameOrigin: row.sender === row.shell });
		const source = { parent: page.parent, opener: page.opener, stranger: page.stranger, self: page.self }[row.relation];
		assert.equal(isTrustedEmbedderMessage({ origin: row.sender, source }), row.allow, `${row.id} ${row.what}`);
	});
}

// ---------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------

test('isAllowedEmbedderOrigin: exactly vscode-webview or the shell\'s own origin — no loopback origin is a member', () => {
	const LOCAL_SHELL = 'http://localhost:5565';
	const bad = ['', 'null', 'https://attacker.example', 'http://localhost.attacker.example', 'http://127.0.0.1.attacker.example', 'vscode-webview://', 'vscode-webview://abc/extra', 'vscode-webviewx://abc', 'vscode-webview.evil.test', 'http://localhost:5173/path', 'ftp://localhost', 'javascript:alert(1)', 'not a url', 'http://10.0.0.1', 'https://cloud.example.test.evil.test', 'http://cloud.example.test', 'https://cloud.example.test:8443', 'https://cloud.example.test/'];
	for (const shell of [SHELL_ORIGIN, LOCAL_SHELL]) assert.equal(isAllowedEmbedderOrigin('vscode-webview://abc-123', shell), true, shell);
	for (const o of bad) assert.equal(isAllowedEmbedderOrigin(o, SHELL_ORIGIN), false, `${JSON.stringify(o)} vs cloud shell`);
	for (const o of bad) assert.equal(isAllowedEmbedderOrigin(o, LOCAL_SHELL), false, `${JSON.stringify(o)} vs local shell`);
	// The shell's own origin (the web App Builder), exactly.
	assert.equal(isAllowedEmbedderOrigin(SHELL_ORIGIN, SHELL_ORIGIN), true);
	assert.equal(isAllowedEmbedderOrigin(LOCAL_SHELL, LOCAL_SHELL), true);
	assert.equal(isAllowedEmbedderOrigin(SHELL_ORIGIN, LOCAL_SHELL), false);
	assert.equal(isAllowedEmbedderOrigin(LOCAL_SHELL, SHELL_ORIGIN), false);
	// An opaque or malformed shell origin authorises nothing but vscode-webview.
	for (const shell of ['null', '', 'not a url']) {
		assert.equal(isAllowedEmbedderOrigin('null', shell), false, `null vs ${JSON.stringify(shell)}`);
		assert.equal(isAllowedEmbedderOrigin(shell, shell), false, `${JSON.stringify(shell)} vs itself`);
	}
	// No loopback origin is a sender — for either kind of shell (only the shell's OWN origin is).
	for (const o of ['http://localhost:5173', 'https://localhost', 'http://127.0.0.1:3000', 'http://127.1.2.3:3000', 'http://[::1]:3000', 'http://app.localhost:3000', 'http://127.0.0.1:5565']) {
		assert.equal(isAllowedEmbedderOrigin(o, LOCAL_SHELL), false, `${o} vs loopback shell`);
		assert.equal(isAllowedEmbedderOrigin(o, SHELL_ORIGIN), false, `${o} vs cloud shell`);
	}
});

test('trustedParentOrigin names only a trusted embedder, so console rows are never aimed at a foreign parent', () => {
	const page = stagePage({ nodeEnv: 'development', framed: true });
	const win = window as unknown as { location: { ancestorOrigins?: string[] } };
	win.location.ancestorOrigins = ['https://attacker.example'];
	assert.equal(trustedParentOrigin(), '', 'foreign parent');
	win.location.ancestorOrigins = ['http://localhost:5173'];
	assert.equal(trustedParentOrigin(), '', 'loopback parent of a cloud-served shell');
	win.location.ancestorOrigins = ['vscode-webview://abc'];
	assert.equal(trustedParentOrigin(), 'vscode-webview://abc');
	// A look-alike ancestor of the shell's own origin is not the shell.
	win.location.ancestorOrigins = ['https://cloud.example.test.evil.test'];
	assert.equal(trustedParentOrigin(), '');
	// No ancestorOrigins (Firefox): fall back to the referrer.
	win.location.ancestorOrigins = undefined;
	Reflect.set(globalThis, 'document', { referrer: 'vscode-webview://abc/index.html?id=1' });
	assert.equal(trustedParentOrigin(), 'vscode-webview://abc');
	Reflect.set(globalThis, 'document', { referrer: 'https://attacker.example/page' });
	assert.equal(trustedParentOrigin(), '');
	Reflect.set(globalThis, 'document', { referrer: '' });
	assert.equal(trustedParentOrigin(), '', 'origin unknown fails closed');
	// Top level and production: never.
	void page;
	stagePage({ nodeEnv: 'development', framed: false });
	assert.equal(trustedParentOrigin(), '');
	stagePage({ nodeEnv: 'production', framed: true, parentSameOrigin: true });
	assert.equal(trustedParentOrigin(), '');
});

test('trustedParentOrigin: a loopback ancestor is no embedder, even of a loopback-served shell', () => {
	stagePage({ nodeEnv: 'development', framed: true, shellOrigin: 'http://localhost:5565' });
	const win = window as unknown as { location: { ancestorOrigins?: string[] } };
	for (const ancestor of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://evil.localhost:5173', 'http://[::1]:5173']) {
		win.location.ancestorOrigins = [ancestor];
		assert.equal(trustedParentOrigin(), '', ancestor);
	}
	// ...and the referrer fallback agrees.
	win.location.ancestorOrigins = undefined;
	Reflect.set(globalThis, 'document', { referrer: 'http://127.0.0.1:5173/page' });
	assert.equal(trustedParentOrigin(), '');
});

test('trustedParentOrigin of a same-origin parent (the web App Builder preview) is the shell\'s own origin, with or without ancestorOrigins', () => {
	stagePage({ nodeEnv: 'development', framed: true, parentSameOrigin: true });
	const win = window as unknown as { location: { ancestorOrigins?: string[] } };
	win.location.ancestorOrigins = [SHELL_ORIGIN];
	assert.equal(trustedParentOrigin(), SHELL_ORIGIN);
	win.location.ancestorOrigins = undefined;
	assert.equal(trustedParentOrigin(), SHELL_ORIGIN, 'the parent\'s readable location is ground truth (Firefox / stripped referrer)');
	// An opaque shell origin never becomes a posting target.
	stagePage({ nodeEnv: 'development', framed: true, parentSameOrigin: true, shellOrigin: 'null' });
	assert.equal(trustedParentOrigin(), '');
});

test('normalizeDevRemoteEntry / isAllowedDevRemoteEntry accept only absolute http(s) loopback URLs without credentials, and return the canonical URL', () => {
	for (const e of ['http://localhost:3001/remoteEntry.js?t=1', 'http://127.0.0.1:5173/remoteEntry.js', 'http://[::1]:3000/remoteEntry.js', 'https://app.localhost/remoteEntry.js']) {
		assert.equal(isAllowedDevRemoteEntry(e), true, e);
		assert.equal(normalizeDevRemoteEntry(e), new URL(e).href, e);
	}
	// What was vetted is what is returned: tabs/newlines the URL parser strips never reach the loader.
	assert.equal(normalizeDevRemoteEntry('http://loc\talhost:3001/re\nmoteEntry.js'), 'http://localhost:3001/remoteEntry.js');
	for (const e of ['https://attacker.example/x.js', '//attacker.example/x.js', 'javascript:alert(1)', 'data:text/javascript,1', '', '/x.js', 'http://localhost.evil.test/x.js', 'http://localhost:1@evil.test/x.js', 'http://u:p@localhost/x.js', 'http://evillocalhost:3000/x.js', 'http://notlocalhost/x.js', 'https://xlocalhost/remoteEntry.js', 'http://evil-localhost:3000/x.js']) assert.equal(isAllowedDevRemoteEntry(e), false, e);
	// WHATWG parsing makes `\` a path separator: this host really IS localhost, and the canonical URL says so.
	assert.equal(normalizeDevRemoteEntry('http://localhost\\@evil.test/x.js'), 'http://localhost/@evil.test/x.js');
	for (const e of [undefined, null, 42, {}, ['http://localhost/x.js']]) assert.equal(normalizeDevRemoteEntry(e), null, String(e));
});
