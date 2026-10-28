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
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationException, LoginAttemptCancelledError, RocketRideClient, type ConnectResult } from 'rocketride';
import { ConnectionState } from '../types/connection';
import type { ConnectionStatus } from '../types/connection';
import { ConnectionManager } from './connection';
import { ConnectionFailure, withTimeout } from './errors';
import { RemoteManager } from './remote-manager';
import { ApiKeyAuthProvider } from '../auth/ApiKeyAuthProvider';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { CONNECT_TIMEOUT_MS, LS_TOKEN } from '../constants';
import { resetDevGateForTests } from '../util/devGate';
import { TELEMETRY_STORAGE_KEY, type TelemetryFact } from '../util/telemetryChannel';

type EmittedEvent = { event: string; payload: unknown };

type TestCredential = string | { code: string; verifier: string; redirectUri: string };
type TestClient = Pick<RocketRideClient, 'login' | 'getAccountInfo' | 'isConnected'> &
	Partial<Pick<RocketRideClient, 'detach' | 'disconnect' | 'getServices'>>;
type TestOperation = {
	key: string;
	generation: number;
	credential: TestCredential;
	cancellationReason?: LoginAttemptCancelledError['reason'];
	promise: Promise<ConnectResult | null>;
	connectedPublished: boolean;
};

type ConnectionManagerTestAdapter = {
	client: TestClient | RocketRideClient | null;
	manager: { disconnect(client: RocketRideClient): Promise<void> } | null;
	_attachPromise: Promise<void>;
	serverUri: string;
	pendingEvents: Map<string, unknown>;
	lifecycleOwner?: TestOperation;
	connectionOperation?: TestOperation;
	connectionGeneration: number;
	refreshServices: () => Promise<void>;
	finishConnect(
		result: ConnectResult,
		appId: string,
		config?: { apps?: Array<{ id: string }>; workspaceDir?: string; onThemeChange?: (theme: string) => void },
	): Promise<{ result: ConnectResult; appId: string }>;
	connectForBootstrap(
		credential: TestCredential,
		appId: string,
		config?: { apps?: Array<{ id: string }>; workspaceDir?: string; onThemeChange?: (theme: string) => void },
	): Promise<{ result: ConnectResult; appId: string } | null>;
	handleStoredTokenFailure(error: unknown): boolean;
	updateConnectionStatus(updates: Partial<ConnectionStatus>): void;
	connectionStatus: ConnectionStatus;
	accountInfo?: ConnectResult;
	clearToken(): void;
	clearSessionAppId(): void;
	loadToken(): string;
	emit(event: string, payload: unknown): void;
	saveToken(token: string): void;
	getPendingAppId(): string;
	initialize(): void;
	connect(credential?: unknown): Promise<ConnectResult | null>;
	bootstrap(): Promise<{ result: ConnectResult; appId: string } | null>;
	disconnect(): Promise<void>;
	logout(): Promise<void>;
	reportTelemetry(event: string, props: Record<string, unknown>): void;
	drainTelemetry(): TelemetryFact[];
	on(event: 'shell:telemetry', handler: (fact: TelemetryFact) => void): () => void;
	on(event: 'shell:myApps', handler: () => void): () => void;
	getDebugLog(): Array<{ event: string; payload: unknown }>;
	startOAuth(register?: boolean, context?: { appId?: string; auto?: boolean }): Promise<void>;
	authProvider: { signIn(appId?: string, register?: boolean): Promise<void> } | null;
	dropRejectedCredential(): void;
};

const authenticatedResult: ConnectResult = {
	userToken: 'rr_test-token',
	userId: 'user-123',
	displayName: 'Test User',
	givenName: 'Test',
	familyName: 'User',
	preferredUsername: 'test-user',
	email: 'test@example.com',
	emailVerified: true,
	phoneNumber: '',
	phoneNumberVerified: false,
	locale: 'en-US',
	devTeam: '',
	organization: null,
	apps: [],
	capabilities: [],
};

/**
 * A ConnectionManager from its own (empty, private) constructor, so every field holds its initial value:
 * emitted events and saved tokens are recorded; telemetry is held as the staged globals allow (in memory
 * without a sessionStorage).
 */
function createTestManager(lastFailure?: ConnectionStatus['lastFailure']) {
	const emitted: EmittedEvent[] = [];
	const savedTokens: string[] = [];
	const manager: ConnectionManagerTestAdapter = Reflect.construct(ConnectionManager, []);
	manager.connectionStatus = {
		state: ConnectionState.DISCONNECTED,
		connectionMode: 'cloud',
		hasCredentials: false,
		retryAttempt: 0,
		maxRetryAttempts: 3,
		lastFailure,
	};
	manager.emit = (event, payload) => emitted.push({ event, payload });
	manager.saveToken = (token) => savedTokens.push(token);
	manager.getPendingAppId = () => '';
	manager.pendingEvents = new Map();
	manager.connectionGeneration = 0;
	return { manager, emitted, savedTokens };
}

function testClient(overrides: Partial<TestClient> = {}): TestClient {
	return {
		login: async () => authenticatedResult,
		getAccountInfo: () => authenticatedResult,
		isConnected: () => true,
		getServices: async () => ({ services: {} }),
		...overrides,
	};
}

/**
 * Narrow a client to one whose SDK-internal onConnected callback is reachable.
 * The narrowed shape is structural (NOT `RocketRideClient & {...}`): the SDK
 * class declares `_callerOnConnected` as private, so intersecting the class
 * with a public member of the same name reduces the type to `never`.
 */
function hasConnectedCallback(client: TestClient | RocketRideClient | null): client is TestClient & {
	_callerOnConnected: () => Promise<void>;
} {
	return client !== null && '_callerOnConnected' in client;
}

test('updateConnectionStatus retains auth failures and clears network failures after CONNECTED', () => {
	const authFailure = { kind: 'auth' as const, lastError: 'session expired' };
	const auth = createTestManager(authFailure);
	auth.manager.updateConnectionStatus({ state: ConnectionState.CONNECTED });
	assert.deepEqual(auth.manager.connectionStatus.lastFailure, authFailure);

	const network = createTestManager({ kind: 'network', lastError: 'offline' });
	network.manager.updateConnectionStatus({ state: ConnectionState.CONNECTED });
	assert.equal(network.manager.connectionStatus.lastFailure, undefined);
});

test('finishConnect rejects results without a non-empty userId before authentication side effects', async () => {
	for (const invalidResult of [
		null,
		undefined,
		{ ...authenticatedResult, userId: '' },
		(() => {
			const { userId: _userId, ...withoutUserId } = authenticatedResult;
			return withoutUserId;
		})(),
	]) {
		const previousAccount = { ...authenticatedResult, userId: 'previous-user' };
		const { manager, emitted, savedTokens } = createTestManager({ kind: 'auth', lastError: 'expired' });
		manager.accountInfo = previousAccount;
		const previousFailure = manager.connectionStatus.lastFailure;

		await assert.rejects(
			manager.finishConnect(invalidResult as unknown as ConnectResult, ''),
			(error: unknown) => error instanceof ConnectionFailure && error.kind === 'auth',
		);

		assert.deepEqual(savedTokens, []);
		assert.equal(manager.connectionStatus.lastFailure, previousFailure);
		assert.equal(manager.accountInfo, previousAccount);
		assert.equal(emitted.some(({ event }) => event === 'shell:login'), false);
	}
});

test('finishConnect clears a latched failure and emits login for an authenticated result', async () => {
	const { manager, emitted, savedTokens } = createTestManager({ kind: 'auth', lastError: 'expired' });

	const completed = await manager.finishConnect(authenticatedResult, 'rocketride.home');

	assert.equal(completed.result, authenticatedResult);
	assert.equal(completed.appId, 'rocketride.home');
	assert.deepEqual(savedTokens, ['rr_test-token']);
	assert.equal(manager.connectionStatus.lastFailure, undefined);
	assert.equal(manager.accountInfo, authenticatedResult);
	assert.deepEqual(
		emitted.filter(({ event }) => event === 'shell:login'),
		[{ event: 'shell:login', payload: { user: authenticatedResult } }],
	);
});

test('handleStoredTokenFailure preserves credentials for retryable server failures', () => {
	const { manager } = createTestManager();

	const shouldClearToken = manager.handleStoredTokenFailure(new ConnectionFailure('server unavailable', 'server'));

	assert.equal(shouldClearToken, false);
	assert.equal(manager.connectionStatus.state, ConnectionState.FAILED);
	assert.deepEqual(manager.connectionStatus.lastFailure, {
		kind: 'network',
		lastError: 'server unavailable',
		errorKind: undefined,
	});
});

test('handleStoredTokenFailure downgrades a network latch to session expiry when a same-origin probe answers', async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
	let probed: string | undefined;
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		value: async (input: unknown) => {
			probed = String(input);
			return { ok: true, json: async () => ({ status: 'OK', data: { version: '3.3.0' } }) };
		},
	});

	try {
		const { manager } = createTestManager();

		const shouldClearToken = manager.handleStoredTokenFailure(new ConnectionFailure('Failed to fetch', 'network'));

		// The network failure latches synchronously so recovery UI can render it.
		assert.equal(shouldClearToken, false);
		assert.equal(manager.connectionStatus.lastFailure?.kind, 'network');

		// The same-origin probe answering proves the server is reachable, so the
		// latched failure downgrades to session expiry instead of a false outage.
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(probed, '/version');
		assert.equal(manager.connectionStatus.state, ConnectionState.AUTH_FAILED);
		assert.deepEqual(manager.connectionStatus.lastFailure, {
			kind: 'auth',
			lastError: 'Your session has expired. Please sign in again.',
			errorKind: 'session',
		});
	} finally {
		if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
});

test('handleStoredTokenFailure keeps the network latch when the same-origin probe fails too', async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		value: async () => {
			throw new TypeError('Failed to fetch');
		},
	});

	try {
		const { manager } = createTestManager();

		manager.handleStoredTokenFailure(new ConnectionFailure('Failed to fetch', 'network'));
		await new Promise((resolve) => setImmediate(resolve));

		// Both requests dead: genuinely unreachable, the network banner stands.
		assert.equal(manager.connectionStatus.state, ConnectionState.FAILED);
		assert.equal(manager.connectionStatus.lastFailure?.kind, 'network');
	} finally {
		if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
});

test('handleStoredTokenFailure does not let a stale probe downgrade a newer network failure in the same generation', async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
	let calls = 0;
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		value: async () => {
			calls += 1;
			// The first (older) failure's probe finds the server reachable; the
			// second (newer) failure's probe finds it genuinely down.
			if (calls === 1) return { ok: true, json: async () => ({ status: 'OK', data: { version: '3.3.0' } }) };
			throw new TypeError('Failed to fetch');
		},
	});

	try {
		const { manager } = createTestManager();

		// Two network failures latch back to back in the same generation, each
		// firing its own probe. The older probe resolves ok, but by the time it
		// does a newer network failure is latched — keying the downgrade on the
		// exact latched object (not just kind === 'network') is what stops the
		// older probe from clobbering the newer failure into a false session
		// expiry.
		manager.handleStoredTokenFailure(new ConnectionFailure('Failed to fetch', 'network'));
		manager.handleStoredTokenFailure(new ConnectionFailure('Failed to fetch', 'network'));

		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		// The newer failure's own probe failed, so the network banner stands.
		assert.equal(calls, 2);
		assert.equal(manager.connectionStatus.state, ConnectionState.FAILED);
		assert.equal(manager.connectionStatus.lastFailure?.kind, 'network');
	} finally {
		if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
});

test('handleStoredTokenFailure keeps the network latch when the probe answers 200 but not the /version contract', async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		// A page origin that merely returns 200 for /version without the server's
		// own contract — e.g. a cross-origin serverUri whose real backend is down,
		// while the page host answers /version with something unrelated.
		value: async () => ({ ok: true, json: async () => ({ hello: 'not rocketride' }) }),
	});

	try {
		const { manager } = createTestManager();

		manager.handleStoredTokenFailure(new ConnectionFailure('Failed to fetch', 'network'));
		await new Promise((resolve) => setImmediate(resolve));

		// The probe did not prove the backend is reachable, so the network banner
		// stands rather than being downgraded to a false session expiry.
		assert.equal(manager.connectionStatus.state, ConnectionState.FAILED);
		assert.equal(manager.connectionStatus.lastFailure?.kind, 'network');
	} finally {
		if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
});

/** Stage browser globals for one test and restore them afterwards; the dev gate recomputes from the staged window. */
async function withGlobals(globals: Record<string, unknown>, run: () => void | Promise<void>): Promise<void> {
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
	resetDevGateForTests();
	try {
		await run();
	} finally {
		resetDevGateForTests();
		for (const [key, original] of originals) {
			if (original) Object.defineProperty(globalThis, key, original);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
}

/** A sessionStorage double over a Map that records every write and removal. */
function recordingSession(initial: Array<[string, string]> = []) {
	const data = new Map<string, string>(initial);
	const writes: string[] = [];
	const storage = {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => { writes.push(`set:${k}`); data.set(k, v); },
		removeItem: (k: string) => { writes.push(`remove:${k}`); data.delete(k); },
	};
	return { data, writes, storage };
}

/** A top-level tab: self and top are the same window. */
function topLevelWindow(extra: Record<string, unknown>): Record<string, unknown> {
	const win: Record<string, unknown> = { ...extra };
	win.self = win;
	win.top = win;
	return win;
}

/** startOAuth's round-trip stamp: shell-internal, read and removed by the callback that completes the sign-in. */
const AUTH_START_STAMP = 'rr:shell:auth_start_ts';

/** An OAuth callback page load (`?code=abc`) whose PKCE verifier is stored, with the given entries in sessionStorage. */
function callbackPage(entries: Array<[string, string]> = []) {
	const session = recordingSession([['rr:pkce_verifier', 'verifier-1'], ...entries]);
	const win = topLevelWindow({
		location: { search: '?code=abc', pathname: '/', origin: 'https://shell.example.test' },
		history: { state: null, replaceState: () => {} },
	});
	return { session, globals: { window: win, sessionStorage: session.storage } };
}

/** A manager whose code exchange resolves `result`, ready for bootstrap() on a callback page load. */
function callbackManager(result: ConnectResult = authenticatedResult) {
	const { manager } = createTestManager();
	manager.client = testClient();
	manager._attachPromise = Promise.resolve();
	const exchanged: TestCredential[] = [];
	manager.connectForBootstrap = async (credential) => {
		exchanged.push(credential);
		return { result, appId: '' };
	};
	return { manager, exchanged };
}

test('a stored credential the server rejects drops the held telemetry facts and the round-trip stamp', async () => {
	const session = recordingSession([[AUTH_START_STAMP, '123']]);
	await withGlobals({ window: topLevelWindow({ location: { search: '', pathname: '/' } }), sessionStorage: session.storage }, async () => {
		const { manager } = createTestManager();
		manager.reportTelemetry('auth:complete', { is_new: true, waitlisted: false, source: 'shell' });
		assert.ok(session.data.has(TELEMETRY_STORAGE_KEY), 'nobody listens: the fact is held and mirrored');
		manager.client = testClient();
		manager._attachPromise = Promise.resolve();
		manager.loadToken = () => 'stored-token';
		manager.clearToken = () => {};
		manager.connectForBootstrap = async () => {
			throw new AuthenticationException({ message: 'Invalid or revoked API key' });
		};

		assert.equal(await manager.bootstrap(), null);

		assert.deepEqual(manager.drainTelemetry(), [], 'no held fact survives the rejected credential');
		assert.equal(session.data.has(TELEMETRY_STORAGE_KEY), false, 'the mirror is removed');
		assert.equal(session.data.has(AUTH_START_STAMP), false, 'the round-trip stamp is removed');
	});
});

test('logout drops held telemetry facts and the round-trip stamp, so the next account cannot inherit them', async () => {
	const session = recordingSession([[AUTH_START_STAMP, '123']]);
	await withGlobals({ window: topLevelWindow({ location: { search: '', pathname: '/' } }), sessionStorage: session.storage }, async () => {
		const { manager, emitted } = createTestManager();
		// logout's own side effects beyond telemetry (the token, the session app, the transport) are not under test
		manager.clearToken = () => {};
		manager.clearSessionAppId = () => {};
		manager.disconnect = async () => {};
		// nobody listens: the facts of this session are held and mirrored
		manager.reportTelemetry('auth:start', { register: false, auto: true });
		manager.reportTelemetry('auth:complete', { is_new: false, waitlisted: false, source: 'shell' });
		assert.ok(session.data.has(TELEMETRY_STORAGE_KEY), 'held facts are mirrored before the sign-out');

		await manager.logout();

		assert.deepEqual(manager.drainTelemetry(), [], 'no held fact survives the sign-out');
		assert.equal(session.data.has(TELEMETRY_STORAGE_KEY), false, 'the mirror is removed');
		assert.equal(session.data.has(AUTH_START_STAMP), false, 'the round-trip stamp is removed');
		assert.ok(emitted.some((e) => e.event === 'shell:logout'), 'logout still emits shell:logout');
	});
});

test('reportTelemetry delivers a fact live to a shell:telemetry listener and holds it when nobody listens', async () => {
	const { manager } = createTestManager();
	delete (manager as { emit?: unknown }).emit; // the shell's own event bus, so the test holds however reportTelemetry dispatches
	const received: TelemetryFact[] = [];
	const leave = manager.on('shell:telemetry', (fact) => received.push(fact));
	manager.reportTelemetry('auth:start', { register: true });
	await Promise.resolve(); // delivered on a microtask, like every shell event
	assert.equal(received.length, 1, 'delivered once, live');
	const fact = received[0];
	assert.equal(fact.event, 'auth:start');
	assert.deepEqual(fact.props, { register: true });
	assert.ok(fact.ts > 0 && fact.id.length > 0, 'carries its time and a once-per-fact id');
	assert.ok(
		manager.getDebugLog().some((e) => e.event === 'shell:telemetry' && (e.payload as TelemetryFact).id === fact.id),
		'the live fact is in the debug log, like every shell event',
	);
	assert.deepEqual(manager.drainTelemetry(), [], 'a delivered fact is not held for a later drain');

	leave();
	manager.reportTelemetry('auth:complete', { is_new: null, waitlisted: false, source: 'shell' });
	await Promise.resolve();
	assert.equal(received.length, 1, 'nobody listens: nothing more is delivered');
	assert.deepEqual(
		manager.drainTelemetry().map((f) => [f.event, f.props]),
		[['auth:complete', { is_new: null, waitlisted: false, source: 'shell' }]],
		'held, then handed over',
	);
	assert.deepEqual(manager.drainTelemetry(), [], 'a drain hands each fact over only once');
});

test('a listener that throws is logged and the next one still runs, for emit and for a telemetry fact alike', async () => {
	const { manager } = createTestManager();
	delete (manager as { emit?: unknown }).emit; // the shell's own event bus
	const reached: string[] = [];
	manager.on('shell:telemetry', () => { throw new Error('boom'); });
	manager.on('shell:telemetry', (fact) => reached.push(fact.event));
	manager.on('shell:myApps', () => { throw new Error('boom'); });
	manager.on('shell:myApps', () => reached.push('shell:myApps'));
	const logged: unknown[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => { logged.push(args[0]); };
	try {
		manager.reportTelemetry('auth:start', { register: false, auto: false });
		manager.emit('shell:myApps', {});
		await Promise.resolve();
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(reached, ['auth:start', 'shell:myApps'], 'the second listener of each event ran');
	assert.deepEqual(logged, ["[ConnectionManager] Handler for 'shell:telemetry' threw:", "[ConnectionManager] Handler for 'shell:myApps' threw:"]);
});

test('a fact held because nobody listens is in the debug log too, so the ALT+D panel shows every fact', () => {
	const { manager } = createTestManager();
	manager.reportTelemetry('auth:complete', { is_new: true, waitlisted: true, source: 'shell' });
	const [held] = manager.drainTelemetry();
	assert.ok(held, 'held for the next drain');
	assert.deepEqual(
		manager.getDebugLog().filter((e) => e.event === 'shell:telemetry').map((e) => (e.payload as TelemetryFact).id),
		[held.id],
		'logged once, as the fact the drain hands over',
	);
});

test('a fact whose listener leaves before the dispatch is held as logged, id included, unless the held facts are dropped first', async () => {
	const { manager } = createTestManager();
	delete (manager as { emit?: unknown }).emit; // the shell's own event bus, so the test holds however reportTelemetry dispatches
	const received: TelemetryFact[] = [];

	const leave = manager.on('shell:telemetry', (fact) => received.push(fact));
	manager.reportTelemetry('auth:complete', { is_new: true, waitlisted: false, source: 'shell' });
	leave(); // the forwarding app unmounts in the same tick (an app switch)
	await Promise.resolve();
	assert.equal(received.length, 0, 'nobody was listening by the dispatch');
	const held = manager.drainTelemetry();
	assert.deepEqual(held.map((f) => [f.event, f.props]), [['auth:complete', { is_new: true, waitlisted: false, source: 'shell' }]], 'held for the next drain, not lost');
	assert.deepEqual(
		manager.getDebugLog().filter((e) => e.event === 'shell:telemetry').map((e) => (e.payload as TelemetryFact).id),
		[held[0].id],
		'the drained fact carries the id the debug log shows',
	);

	const leaveAgain = manager.on('shell:telemetry', (fact) => received.push(fact));
	manager.reportTelemetry('auth:start', { register: false, auto: false });
	leaveAgain();
	manager.dropRejectedCredential(); // a rejected credential (or a sign-out) in the same tick
	await Promise.resolve();
	assert.equal(received.length, 0, 'still nobody listening');
	assert.deepEqual(manager.drainTelemetry(), [], 'a fact raised before a drop is not held after it');
});

test('facts on their way to a listener keep their order and are delivered or held exactly once', async () => {
	const { manager } = createTestManager();
	delete (manager as { emit?: unknown }).emit; // the shell's own event bus, so the test holds however reportTelemetry dispatches
	const received: TelemetryFact[] = [];

	// the listener leaves, then a second fact is raised in the same tick: both are held, in the order raised
	const leave = manager.on('shell:telemetry', (fact) => received.push(fact));
	manager.reportTelemetry('auth:start', { register: false, auto: false });
	leave();
	manager.reportTelemetry('auth:complete', { is_new: false, waitlisted: false, source: 'shell' });
	await Promise.resolve();
	assert.equal(received.length, 0, 'nobody was listening by the dispatch');
	assert.deepEqual(manager.drainTelemetry().map((f) => f.event), ['auth:start', 'auth:complete'], 'held in the order raised');

	// a remount in the same tick (StrictMode cleanup and mount): the new listener receives the fact, nothing is held
	const first = manager.on('shell:telemetry', (fact) => received.push(fact));
	manager.reportTelemetry('auth:start', { register: true, auto: false });
	first();
	manager.on('shell:telemetry', (fact) => received.push(fact));
	await Promise.resolve();
	assert.deepEqual(received.map((f) => f.event), ['auth:start'], 'delivered once, to the listener subscribed by the dispatch');
	assert.deepEqual(manager.drainTelemetry(), [], 'delivered, so not held');

	// a drop while the listener stays: the fact raised before it still reaches that listener, and nothing is held
	manager.reportTelemetry('auth:complete', { is_new: true, waitlisted: false, source: 'shell' });
	manager.dropRejectedCredential();
	await Promise.resolve();
	assert.deepEqual(received.map((f) => f.event), ['auth:start', 'auth:complete'], 'delivered live');
	assert.deepEqual(manager.drainTelemetry(), [], 'nothing held');
});

test('startOAuth raises auth:start once per page load, past its one-shot guard, and stamps the round trip', async () => {
	const session = recordingSession();
	await withGlobals({ window: topLevelWindow({ location: { search: '', pathname: '/pricing' } }), sessionStorage: session.storage }, async () => {
		const { manager } = createTestManager();
		let signIns = 0;
		manager.authProvider = { signIn: async () => { signIns++; } };
		await manager.startOAuth(true, { appId: 'rocketride.home' });
		await manager.startOAuth(true, { appId: 'rocketride.home' });
		assert.equal(signIns, 1, 'the guard lets one redirect start per page load');
		assert.deepEqual(
			manager.drainTelemetry().map((f) => [f.event, f.props]),
			[['auth:start', { register: true, app_id: 'rocketride.home', from_path: '/pricing', auto: false }]],
			'one auth:start, raised past the guard',
		);
		assert.ok(Number(session.data.get(AUTH_START_STAMP)) > 0, 'the round-trip stamp is set');
	});
});

test('a start that does not redirect releases the guard, so the retry raises auth:start again', async () => {
	const session = recordingSession();
	await withGlobals({ window: topLevelWindow({ location: { search: '', pathname: '/' } }), sessionStorage: session.storage }, async () => {
		const { manager, emitted } = createTestManager();
		// no auth provider and no Zitadel configuration: the start reports an error and does not navigate
		manager.authProvider = null;
		const originalError = console.error;
		console.error = () => {};
		try {
			await manager.startOAuth(false);
			await manager.startOAuth(false);
		} finally {
			console.error = originalError;
		}
		assert.equal(emitted.filter((e) => e.event === 'shell:error').length, 2, 'each attempt failed without a redirect');
		assert.deepEqual(manager.drainTelemetry().map((f) => f.event), ['auth:start', 'auth:start'], 'each attempt is reported');
	});
});

test('a callback that completes the sign-in raises auth:complete once, with is_new null when the provider does not know', async () => {
	for (const [isNewUser, expected] of [[undefined, null], [true, true]] as const) {
		const page = callbackPage();
		await withGlobals(page.globals, async () => {
			let result = authenticatedResult;
			if (isNewUser !== undefined) {
				result = { ...authenticatedResult, isNewUser };
			}
			const { manager, exchanged } = callbackManager(result);

			const completed = await manager.bootstrap();

			assert.equal(completed?.result, result);
			assert.deepEqual(exchanged, [{ code: 'abc', verifier: 'verifier-1', redirectUri: 'https://shell.example.test' }]);
			assert.deepEqual(
				manager.drainTelemetry().map((f) => [f.event, f.props]),
				[['auth:complete', { is_new: expected, waitlisted: false, source: 'shell', duration_ms: null }]],
				isNewUser === undefined ? 'unknown is reported as null, never as an existing user' : 'a known new account is reported as new',
			);
		});
	}
});

test('auth:complete carries the round trip since startOAuth as duration_ms, and the stamp is gone once read', async () => {
	const page = callbackPage([[AUTH_START_STAMP, String(Date.now() - 41_000)]]);
	await withGlobals(page.globals, async () => {
		const { manager } = callbackManager();
		await manager.bootstrap();
		const [complete] = manager.drainTelemetry();
		const duration = complete.props.duration_ms;
		assert.equal(typeof duration, 'number');
		assert.ok(Number(duration) >= 41_000 && Number(duration) < 51_000, `about 41 s, got ${String(duration)}`);
		assert.equal(page.session.data.has(AUTH_START_STAMP), false, 'read once and removed, so a later completion cannot reuse it');
	});
});

test('auth:complete reports no duration for a stamp that is not this round trip', async () => {
	const cases: Array<[string, string]> = [
		['from the future (another clock)', String(Date.now() + 60_000)],
		['over an hour old (an abandoned start)', String(Date.now() - 60 * 60 * 1000 - 1000)],
		['not a number', 'garbage'],
		['empty', ''],
	];
	for (const [label, stamp] of cases) {
		const page = callbackPage([[AUTH_START_STAMP, stamp]]);
		await withGlobals(page.globals, async () => {
			const { manager } = callbackManager();
			await manager.bootstrap();
			assert.equal(manager.drainTelemetry()[0].props.duration_ms, null, label);
			assert.equal(page.session.data.has(AUTH_START_STAMP), false, `${label}: removed all the same`);
		});
	}
});

test("an embedded dev preview holds telemetry in memory only and never touches the host tab's mirror or stamp", async () => {
	const hostFact = { event: 'auth:complete', props: { is_new: true, waitlisted: false, source: 'shell' }, ts: Date.now(), id: 'host-1' };
	const hostEntries: Array<[string, string]> = [[TELEMETRY_STORAGE_KEY, JSON.stringify([hostFact])], [AUTH_START_STAMP, '123']];

	// Control: a tab's manager inherits the facts its tab's earlier page load left.
	const tab = recordingSession(hostEntries);
	await withGlobals({ window: topLevelWindow({ location: { search: '', pathname: '/' } }), sessionStorage: tab.storage }, () => {
		const { manager } = createTestManager();
		assert.deepEqual(manager.drainTelemetry().map((f) => f.id), ['host-1'], "a tab inherits its own tab's held facts");
	});

	// A framed window carrying rrdev=1 is an embedded dev preview (see the token tests below).
	const session = recordingSession(hostEntries);
	await withGlobals({ window: { self: {}, top: {}, location: { search: '?rrdev=1', pathname: '/' } }, sessionStorage: session.storage }, async () => {
		const { manager } = createTestManager();
		manager.authProvider = { signIn: async () => {} };

		await manager.startOAuth(false);
		manager.reportTelemetry('auth:complete', { is_new: null, waitlisted: false, source: 'shell' });
		assert.deepEqual(
			manager.drainTelemetry().map((f) => f.event),
			['auth:start', 'auth:complete'],
			"the preview hands over its own facts, never the host tab's",
		);
		manager.reportTelemetry('auth:start', { register: false, auto: true });
		manager.dropRejectedCredential();
		assert.deepEqual(manager.drainTelemetry(), [], "the preview's own held facts are dropped");
		assert.deepEqual(session.writes, [], 'nothing was written to or removed from the shared sessionStorage');
		assert.equal(session.data.get(TELEMETRY_STORAGE_KEY), JSON.stringify([hostFact]), "the host tab's mirror is intact");
		assert.equal(session.data.get(AUTH_START_STAMP), '123', "the host tab's round-trip stamp is intact");
	});
});

test('clearToken removes the stored token from localStorage only', () => {
	const removedLocalKeys: string[] = [];
	const removedSessionKeys: string[] = [];
	const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { removeItem: (key: string) => removedLocalKeys.push(key) },
	});
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: { removeItem: (key: string) => removedSessionKeys.push(key) },
	});

	try {
		createTestManager().manager.clearToken();
		assert.deepEqual(removedLocalKeys, ['rr:user_token']);
		// The legacy sessionStorage slot is gone — clearing must not touch it.
		assert.deepEqual(removedSessionKeys, []);
	} finally {
		if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
		if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
		else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
	}
});

test('auth providers sign out by removing the stored token from localStorage only', async () => {
	const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

	try {
		for (const provider of [ApiKeyAuthProvider.getInstance(), CloudAuthProvider.getInstance()]) {
			const removedLocalKeys: string[] = [];
			const removedSessionKeys: string[] = [];
			Object.defineProperty(globalThis, 'localStorage', {
				configurable: true,
				value: { removeItem: (key: string) => removedLocalKeys.push(key) },
			});
			Object.defineProperty(globalThis, 'sessionStorage', {
				configurable: true,
				value: { removeItem: (key: string) => removedSessionKeys.push(key) },
			});

			await provider.signOut();

			assert.deepEqual(removedLocalKeys, [LS_TOKEN]);
			// The legacy sessionStorage slot is gone — sign-out must not touch it.
			assert.deepEqual(removedSessionKeys, []);
		}
	} finally {
		if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
		if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
		else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
	}
});

test('token methods use frame-local memory in embedded dev shells', () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
	const localTouches: string[] = [];
	const sessionTouches: string[] = [];
	const fetchCalls: string[] = [];

	// A framed window (self !== top) carrying rrdev=1 marks this shell as an
	// embedded dev preview — its token must live in frame-local memory
	// (sessionStorage is shared between same-origin sibling iframes in one
	// top-level browsing context, so it cannot isolate panels either). The
	// gate cache is reset so it recomputes from this staged environment (the
	// test runner builds with NODE_ENV=production, so the URL flag is the
	// live path).
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { self: {}, top: {}, location: { search: '?rrdev=1' } },
	});
	resetDevGateForTests();
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			setItem: (key: string) => localTouches.push(`set:${key}`),
			getItem: (key: string) => { localTouches.push(`get:${key}`); return null; },
			removeItem: (key: string) => localTouches.push(`remove:${key}`),
		},
	});
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			setItem: (key: string) => sessionTouches.push(`set:${key}`),
			getItem: (key: string) => { sessionTouches.push(`get:${key}`); return null; },
			removeItem: (key: string) => sessionTouches.push(`remove:${key}`),
		},
	});
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		value: (url: string) => { fetchCalls.push(url); return Promise.resolve({}); },
	});

	try {
		const { manager } = createTestManager();
		// The helper stubs saveToken to a recorder; this test exercises the
		// real storage path, so restore the prototype method.
		manager.saveToken = ConnectionManager.prototype.saveToken;
		manager.saveToken('rr_panel-token');
		assert.equal(manager.loadToken(), 'rr_panel-token');
		manager.clearToken();
		assert.equal(manager.loadToken(), '');
		// Neither shared slot was touched: a preview can neither leak its
		// token into an origin-wide store nor clear another context's
		// session through one.
		assert.deepEqual(localTouches, []);
		assert.deepEqual(sessionTouches, []);
		// And the HOST-WIDE /apps cookie was never primed: the cookie jar is
		// shared by every same-origin frame, so a panel's injected session
		// must not replace the embedding user's bundle credentials.
		assert.deepEqual(fetchCalls, []);
	} finally {
		resetDevGateForTests();
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
		if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
		if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
		else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
		if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
});

test('saveToken primes the /apps cookie for real tabs', () => {
	const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
	const stored = new Map<string, string>();
	const fetchCalls: string[] = [];

	// No window global at all — not framed, so this is the real-tab path:
	// the token lands in localStorage and the /apps cookie prime fires.
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			setItem: (key: string, value: string) => stored.set(key, value),
			getItem: (key: string) => stored.get(key) ?? null,
			removeItem: (key: string) => stored.delete(key),
		},
	});
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		value: (url: string) => { fetchCalls.push(url); return Promise.resolve({}); },
	});

	try {
		const { manager } = createTestManager();
		manager.saveToken = ConnectionManager.prototype.saveToken;
		manager.saveToken('rr_tab-token');
		assert.equal(stored.get(LS_TOKEN), 'rr_tab-token');
		assert.deepEqual(fetchCalls, ['/apps/session']);
	} finally {
		if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
		if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
});

test('initialize ignores cross-context token churn in embedded dev shells', () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalAttach = RocketRideClient.prototype.attach;
	const listeners = new Map<string, (event: StorageEvent) => void>();
	const localStorage = {} as Storage;
	let tokenCleared = false;
	let reloaded = false;

	// Framed + rrdev=1 → embedded dev preview: the embedder is the sole
	// session authority, so the same removal event that signs out a real tab
	// (see the localStorage-removals test below) must neither clear nor
	// reload here. The gate cache is reset to recompute from this staging.
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			self: {},
			top: {},
			location: { origin: 'https://shell.example.test', search: '?rrdev=1', reload: () => { reloaded = true; } },
			localStorage,
			addEventListener: (type: string, listener: (event: StorageEvent) => void) => listeners.set(type, listener),
		},
	});
	resetDevGateForTests();
	RocketRideClient.prototype.attach = async () => {};

	try {
		const { manager } = createTestManager();
		manager.clearToken = () => { tokenCleared = true; };
		manager.initialize();

		listeners.get('storage')!({
			key: LS_TOKEN,
			oldValue: 'old-token',
			newValue: null,
			storageArea: localStorage,
		} as StorageEvent);

		assert.equal(tokenCleared, false);
		assert.equal(reloaded, false);
	} finally {
		resetDevGateForTests();
		RocketRideClient.prototype.attach = originalAttach;
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
	}
});

test('initialize handles LS_TOKEN removals only from localStorage', () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalAttach = RocketRideClient.prototype.attach;
	const listeners = new Map<string, (event: StorageEvent) => void>();
	const localStorage = {} as Storage;
	const sessionStorage = {} as Storage;
	let tokenCleared = false;
	let reloaded = false;

	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			location: { origin: 'https://shell.example.test', reload: () => { reloaded = true; } },
			localStorage,
			addEventListener: (type: string, listener: (event: StorageEvent) => void) => listeners.set(type, listener),
		},
	});
	RocketRideClient.prototype.attach = async () => {};

	try {
		const { manager } = createTestManager();
		manager.clearToken = () => { tokenCleared = true; };
		manager.initialize();

		listeners.get('storage')!({
			key: LS_TOKEN,
			oldValue: 'old-token',
			newValue: null,
			storageArea: sessionStorage,
		} as StorageEvent);

		assert.equal(tokenCleared, false);
		assert.equal(reloaded, false);

		listeners.get('storage')!({
			key: LS_TOKEN,
			oldValue: 'old-token',
			newValue: null,
			storageArea: localStorage,
		} as StorageEvent);

		assert.equal(tokenCleared, true);
		assert.equal(reloaded, true);
	} finally {
		RocketRideClient.prototype.attach = originalAttach;
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
	}
});

test('initialize ignores storage events when localStorage cannot be read', () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalAttach = RocketRideClient.prototype.attach;
	const listeners = new Map<string, (event: StorageEvent) => void>();

	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			location: { origin: 'https://shell.example.test', reload: () => {} },
			addEventListener: (type: string, listener: (event: StorageEvent) => void) => listeners.set(type, listener),
		},
	});
	Object.defineProperty(globalThis.window, 'localStorage', {
		configurable: true,
		get: () => { throw new Error('storage unavailable'); },
	});
	RocketRideClient.prototype.attach = async () => {};

	try {
		const { manager } = createTestManager();
		manager.initialize();

		assert.doesNotThrow(() => listeners.get('storage')!({
			key: LS_TOKEN,
			oldValue: 'old-token',
			newValue: null,
			storageArea: {} as Storage,
		} as StorageEvent));
	} finally {
		RocketRideClient.prototype.attach = originalAttach;
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
	}
});

test('initialize attaches with the native handshake timeout', () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalAttach = RocketRideClient.prototype.attach;
	const attachCalls: Array<[string | undefined, { timeout?: number } | undefined]> = [];

	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			location: { origin: 'https://shell.example.test' },
			addEventListener: () => {},
		},
	});
	RocketRideClient.prototype.attach = async (uri, options) => { attachCalls.push([uri, options]); };

	try {
		createTestManager().manager.initialize();
		assert.deepEqual(attachCalls, [[undefined, { timeout: 10000 }]]);
	} finally {
		RocketRideClient.prototype.attach = originalAttach;
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
	}
});

test('onConnected ignores stale callbacks, accepts the active connection, and preserves an auth latch', async () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalAttach = RocketRideClient.prototype.attach;
	const originalIsAttached = RocketRideClient.prototype.isAttached;
	const originalIsAuthenticated = RocketRideClient.prototype.isAuthenticated;

	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { location: { origin: 'https://shell.example.test' }, addEventListener: () => {} },
	});
	RocketRideClient.prototype.attach = async () => {};

	try {
		const { manager, emitted } = createTestManager();
		manager.initialize();
		assert.ok(hasConnectedCallback(manager.client));
		const client = manager.client;
		manager.lifecycleOwner = {
			key: 'active', generation: 0, credential: 'token', promise: Promise.resolve(null), connectedPublished: false,
		};
		manager.connectionStatus.lastFailure = { kind: 'auth', lastError: 'expired' };

		RocketRideClient.prototype.isAttached = () => false;
		RocketRideClient.prototype.isAuthenticated = () => true;
		await client._callerOnConnected();

		RocketRideClient.prototype.isAttached = () => true;
		RocketRideClient.prototype.isAuthenticated = () => false;
		await client._callerOnConnected();

		RocketRideClient.prototype.isAuthenticated = () => true;
		manager.refreshServices = async () => {};
		await client._callerOnConnected();

		assert.equal(manager.connectionStatus.state, ConnectionState.CONNECTED);
		assert.equal(emitted.filter(({ event }) => event === 'shell:connected').length, 1);

		// The SDK's isAuthenticated() reports transport-level auth, which is also
		// true for the anonymous connects the landing page makes — so publishing
		// CONNECTED must NOT retire an auth latch, or a "session expired" banner
		// would vanish before the user acts on it. Only an authenticated login
		// path clears it (covered by the auth-recovery test below).
		assert.deepEqual(manager.connectionStatus.lastFailure, { kind: 'auth', lastError: 'expired' });

		// A network latch, by contrast, is retired the moment we reconnect.
		manager.connectionStatus.lastFailure = { kind: 'network', lastError: 'unreachable' };
		manager.lifecycleOwner.connectedPublished = false;
		await client._callerOnConnected();
		assert.equal(manager.connectionStatus.lastFailure, undefined);
	} finally {
		RocketRideClient.prototype.attach = originalAttach;
		RocketRideClient.prototype.isAttached = originalIsAttached;
		RocketRideClient.prototype.isAuthenticated = originalIsAuthenticated;
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
	}
});

test('onConnectError latches a session-expired auth failure when a background re-login is rejected', async () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const originalAttach = RocketRideClient.prototype.attach;

	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { location: { origin: 'https://shell.example.test' }, addEventListener: () => {} },
	});
	RocketRideClient.prototype.attach = async () => {};

	try {
		const { manager, emitted } = createTestManager();
		const clearedTokens: number[] = [];
		manager.clearToken = () => { clearedTokens.push(1); };
		manager.initialize();
		const client = manager.client;
		assert.ok(client !== null && '_callerOnConnectError' in client);
		const onConnectError = (client as unknown as {
			_callerOnConnectError: (error: Error) => Promise<void> | void;
		})._callerOnConnectError;

		manager.lifecycleOwner = {
			key: 'active', generation: 0, credential: 'token', promise: Promise.resolve(null), connectedPublished: true,
		};
		manager.accountInfo = { userId: 'user-1' } as ConnectResult;

		// The SDK reports a terminal background auth rejection and stops
		// retrying — the shell must latch the session-expired banner, clear
		// the dead token, and drop the stale identity.
		await onConnectError(new AuthenticationException({ message: 'Invalid or revoked API key' }));
		assert.equal(manager.connectionStatus.state, ConnectionState.AUTH_FAILED);
		assert.deepEqual(manager.connectionStatus.lastFailure, {
			kind: 'auth',
			lastError: 'Your session has expired. Please sign in again.',
			errorKind: 'session',
		});
		assert.equal(clearedTokens.length, 1);
		assert.equal(manager.accountInfo, undefined);
		assert.equal(manager.connectionStatus.retryAttempt, 0);

		// A plain transport failure keeps the existing retry messaging.
		manager.connectionStatus.lastFailure = undefined;
		manager.connectionStatus.state = ConnectionState.CONNECTING;
		await onConnectError(new Error('socket hang up'));
		assert.equal(manager.connectionStatus.retryAttempt, 1);
		assert.equal(manager.connectionStatus.progressMessage, 'Reconnecting…');
		assert.equal(clearedTokens.length, 1);
		assert.ok(emitted.some(({ event, payload }) =>
			event === 'shell:statusMessage' && (payload as { message: string | null }).message === 'Reconnecting…'));
	} finally {
		RocketRideClient.prototype.attach = originalAttach;
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
	}
});

test('withTimeout waits for cancellation before rejecting and suppresses late login completion', async () => {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let timeoutCallback: (() => void) | undefined;
	let releaseCleanup: (() => void) | undefined;
	let resolveLogin: (() => void) | undefined;
	let settled = false;
	const events: string[] = [];

	globalThis.setTimeout = ((callback: () => void) => {
		timeoutCallback = callback;
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

	try {
		const login = new Promise<void>((resolve) => { resolveLogin = resolve; });
		const timed = withTimeout(
			login,
			CONNECT_TIMEOUT_MS,
			new ConnectionFailure('timeout', 'network'),
			async () => {
				events.push('detach started');
				await new Promise<void>((resolve) => { releaseCleanup = resolve; });
				events.push('detach finished');
			},
		);
		void timed.then(
			() => { settled = true; },
			() => { settled = true; },
		);

		timeoutCallback!();
		await Promise.resolve();
		assert.deepEqual(events, ['detach started']);
		assert.equal(settled, false);

		resolveLogin!();
		await Promise.resolve();
		assert.equal(settled, false);

		releaseCleanup!();
		await assert.rejects(
			Promise.race([
				timed,
				new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error('test safety timer fired')), 200)),
			]),
			(error: unknown) => error instanceof ConnectionFailure && error.kind === 'network',
		);
		assert.deepEqual(events, ['detach started', 'detach finished']);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test('RemoteManager.connect detaches before returning a network timeout failure', async () => {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let timeoutCallback: (() => void) | undefined;
	let releaseDetach: (() => void) | undefined;
	let detachCalls = 0;
	let rejected = false;
	let timeoutNotified = false;
	const loginCalls: unknown[][] = [];

	globalThis.setTimeout = ((callback: () => void) => {
		timeoutCallback = callback;
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

	try {
		const client = {
			login: async (...args: unknown[]) => {
				loginCalls.push(args);
				return await new Promise<ConnectResult>(() => {});
			},
			detach: async () => {
				detachCalls++;
				await new Promise<void>((resolve) => { releaseDetach = resolve; });
			},
		} as unknown as RocketRideClient;
		const connect = new RemoteManager(() => { timeoutNotified = true; }).connect(client, { uri: 'https://shell.example.test', credential: 'rr_test-token' });
		void connect.catch(() => { rejected = true; });
		assert.deepEqual(loginCalls, [['rr_test-token']]);

		timeoutCallback!();
		await Promise.resolve();
		assert.equal(timeoutNotified, true);
		assert.equal(detachCalls, 1);
		assert.equal(rejected, false);

		releaseDetach!();
		await assert.rejects(
			Promise.race([
				connect,
				new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error('test safety timer fired')), 200)),
			]),
			(error: unknown) => error instanceof ConnectionFailure && error.kind === 'network',
		);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test('connect coalesces identical credential operations and supersedes stale credential publication', async () => {
	let resolveFirstLogin: ((result: ConnectResult) => void) | undefined;
	let account = authenticatedResult;
	let loginCount = 0;
	const { manager, emitted } = createTestManager();
	manager.serverUri = 'shell.example.test';
	manager.client = testClient({
		login: async () => {
			loginCount++;
			if (loginCount === 1) return await new Promise<ConnectResult>((resolve) => { resolveFirstLogin = resolve; });
			account = { ...authenticatedResult, userId: 'new-user', userToken: 'new-token' };
			return account;
		},
		getAccountInfo: () => account,
	});

	const first = manager.connect('first-token');
	const joined = manager.connect('first-token');
	assert.equal(joined, first);

	const replacement = manager.connect('second-token');
	assert.notEqual(replacement, first);
	assert.equal((await replacement)!.userId, 'new-user');

	resolveFirstLogin!(authenticatedResult);
	assert.equal(await first, null);
	assert.deepEqual(
		emitted.filter(({ event }) => event === 'shell:login'),
		[{ event: 'shell:login', payload: { user: account } }],
	);
});

test('connect distinguishes string and PKCE credentials when coalescing', async () => {
	const resolvers: Array<(result: ConnectResult) => void> = [];
	const { manager } = createTestManager();
	manager.serverUri = 'https://shell.example.test';
	manager.client = testClient({
		login: async () => await new Promise<ConnectResult>((resolve) => { resolvers.push(resolve); }),
	});

	const stringOperation = manager.connect('credential');
	const pkceOperation = manager.connect({ code: 'credential', verifier: 'verifier', redirectUri: 'https://shell.example.test' });
	assert.notEqual(stringOperation, pkceOperation);

	resolvers[1]!(authenticatedResult);
	assert.equal((await pkceOperation)!.userId, authenticatedResult.userId);
	resolvers[0]!(authenticatedResult);
	assert.equal(await stringOperation, null);
});

test('connect joins PKCE credentials with fields supplied in a different order', async () => {
	let resolveLogin: ((result: ConnectResult) => void) | undefined;
	const { manager } = createTestManager();
	manager.serverUri = 'https://shell.example.test';
	manager.client = testClient({
		login: async () => await new Promise<ConnectResult>((resolve) => { resolveLogin = resolve; }),
	});

	const first = manager.connect({ code: 'code', verifier: 'verifier', redirectUri: 'https://shell.example.test' });
	const joined = manager.connect({ redirectUri: 'https://shell.example.test', verifier: 'verifier', code: 'code' });

	assert.equal(joined, first);
	resolveLogin!(authenticatedResult);
	assert.equal((await first)!.userId, authenticatedResult.userId);
});

test('public connect resolves intentional SDK cancellations silently for every reason', async () => {
	for (const reason of ['superseded', 'logout', 'detached'] as const) {
		const { manager, emitted } = createTestManager();
		let clearTokenCalls = 0;
		manager.serverUri = 'https://shell.example.test';
		manager.clearToken = () => { clearTokenCalls++; };
		manager.client = testClient({
			login: async () => { throw new LoginAttemptCancelledError(reason); },
		});

		assert.equal(await manager.connect('token'), null);
		assert.equal(clearTokenCalls, 0);
		assert.equal(manager.connectionStatus.lastFailure, undefined);
		assert.equal(emitted.some(({ event }) => event === 'shell:error'), false);
	}
});

test('non-cancellation failures remain failures and auth recovery clears its latch', async () => {
	const { manager, emitted } = createTestManager();
	let clearTokenCalls = 0;
	manager.serverUri = 'https://shell.example.test';
	manager.clearToken = () => { clearTokenCalls++; };
	manager.client = testClient({
		login: async () => { throw new AuthenticationException({ message: 'invalid credential' }); },
	});

	await assert.rejects(manager.connect('token'));
	assert.equal(clearTokenCalls, 1);
	assert.equal(manager.connectionStatus.state, ConnectionState.AUTH_FAILED);
	assert.equal(manager.connectionStatus.lastFailure?.kind, 'auth');
	assert.equal(emitted.some(({ event }) => event === 'shell:error'), true);

	manager.client.login = async () => authenticatedResult;
	await manager.connect('fresh-token');
	assert.equal(manager.connectionStatus.lastFailure, undefined);
});

test('a disconnected transport error is a normal network failure, not a cancellation', async () => {
	const { manager, emitted } = createTestManager();
	manager.serverUri = 'https://shell.example.test';
	manager.client = testClient({ login: async () => { throw new Error('disconnected'); } });

	await assert.rejects(
		manager.connect('token'),
		(error: unknown) => error instanceof ConnectionFailure && error.kind === 'network',
	);
	assert.equal(manager.connectionStatus.lastFailure?.kind, 'network');
	assert.equal(emitted.some(({ event }) => event === 'shell:error'), true);
});

test('disconnect and logout invalidate an in-flight operation before client cleanup', async () => {
	for (const action of ['disconnect', 'logout'] as const) {
		let resolveLogin: ((result: ConnectResult) => void) | undefined;
		let disconnectCalls = 0;
		const { manager, emitted } = createTestManager();
		manager.serverUri = 'https://shell.example.test';
		manager.clearToken = () => {};
		manager.clearSessionAppId = () => {};
		manager.client = testClient({
			login: async () => await new Promise<ConnectResult>((resolve) => { resolveLogin = resolve; }),
			disconnect: async () => { disconnectCalls++; },
		});

		const connecting = manager.connect('token');
		await manager[action]();
		resolveLogin!(authenticatedResult);
		assert.equal(await connecting, null);
		assert.equal(disconnectCalls, 1);
		assert.deepEqual(
			emitted.filter(({ event }) => event === 'shell:disconnected'),
			[{ event: 'shell:disconnected', payload: { reason: 'Disconnected by request', hasError: false } }],
		);
	}
});

test('disconnect does not publish an intentional disconnected event after a newer generation takes ownership', async () => {
	const { manager, emitted } = createTestManager();
	let disconnectCalls = 0;
	manager.client = testClient();
	manager.manager = {
		disconnect: async () => {
			disconnectCalls++;
			manager.connectionGeneration++;
		},
	};

	await manager.disconnect();

	assert.equal(disconnectCalls, 1);
	assert.deepEqual(emitted.filter(({ event }) => event === 'shell:disconnected'), []);
});

test('bootstrap stored-token login publishes through the accepted operation once', async () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const { manager, emitted } = createTestManager();
	manager.serverUri = 'https://shell.example.test';
	manager.client = testClient();
	manager._attachPromise = Promise.resolve();
	manager.loadToken = () => 'stored-token';
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { location: { search: '' } },
	});

	try {
		const completed = await manager.bootstrap();

		assert.equal(completed?.result, authenticatedResult);
		assert.equal(completed?.appId, '');
		assert.deepEqual(
			emitted.filter(({ event }) => event === 'shell:login'),
			[{ event: 'shell:login', payload: { user: authenticatedResult } }],
		);
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else delete (globalThis as { window?: Window }).window;
	}
});

test('bootstrap cannot finish an old login under a replacement operation', async () => {
	let resolveLogin: ((result: ConnectResult) => void) | undefined;
	let finishConnectCalls = 0;
	const { manager } = createTestManager();
	const oldOperation: TestOperation = {
		key: 'old',
		generation: 1,
		credential: 'old-token',
		promise: Promise.resolve(null),
		connectedPublished: false,
	};
	const replacementOperation: TestOperation = {
		key: 'replacement',
		generation: 2,
		credential: 'new-token',
		promise: Promise.resolve(null),
		connectedPublished: false,
	};
	const login = new Promise<ConnectResult>((resolve) => { resolveLogin = resolve; });
	void login.then(() => {
		manager.connectionGeneration = replacementOperation.generation;
		manager.lifecycleOwner = replacementOperation;
		manager.connectionOperation = replacementOperation;
	});
	manager.connect = () => {
		manager.connectionGeneration = oldOperation.generation;
		manager.lifecycleOwner = oldOperation;
		manager.connectionOperation = oldOperation;
		return login;
	};
	manager.finishConnect = async () => {
		finishConnectCalls++;
		return { result: authenticatedResult, appId: '' };
	};

	const completing = manager.connectForBootstrap('old-token', '');
	resolveLogin!(authenticatedResult);

	assert.equal(await completing, null);
	assert.equal(finishConnectCalls, 0);
});

test('timeout cleanup leaves a replacement shell operation attached', async () => {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let timeoutCallback: (() => void) | undefined;
	let detachCalls = 0;
	globalThis.setTimeout = ((callback: () => void) => {
		timeoutCallback = callback;
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

	try {
		const client = {
			login: async () => await new Promise<ConnectResult>(() => {}),
			detach: async () => { detachCalls++; },
		} as unknown as RocketRideClient;
		const connect = new RemoteManager(() => false).connect(client, {
			uri: 'https://shell.example.test',
			credential: 'token',
		});
		timeoutCallback!();
		await assert.rejects(connect, (error: unknown) => error instanceof ConnectionFailure && error.kind === 'network');
		assert.equal(detachCalls, 0);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});
