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

import assert from 'node:assert/strict';
import test from 'node:test';
import { RocketRideClient, type ConnectResult } from 'rocketride';
import { ConnectionState, type ConnectionStatus } from 'shared/types/connection';
import { ConnectionManager } from './connection.js';
import { ConnectionFailure, withTimeout } from './errors.js';
import { RemoteManager } from './remote-manager.js';
import { CONNECT_TIMEOUT_MS, LS_TOKEN } from '../constants.js';

type EmittedEvent = { event: string; payload: unknown };

type ConnectionManagerTestAdapter = {
	finishConnect(
		result: ConnectResult,
		appId: string,
		config?: { apps?: Array<{ id: string }>; workspaceDir?: string; onThemeChange?: (theme: string) => void },
	): Promise<{ result: ConnectResult; appId: string }>;
	handleStoredTokenFailure(error: unknown): boolean;
	updateConnectionStatus(updates: Partial<ConnectionStatus>): void;
	connectionStatus: ConnectionStatus;
	accountInfo?: ConnectResult;
	clearToken(): void;
	emit(event: string, payload: unknown): void;
	saveToken(token: string): void;
	getPendingAppId(): string;
	initialize(): void;
	loginWithStoredToken(token: string): Promise<ConnectResult>;
	loginWithTimeout(credential: string | { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult>;
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
	defaultTeam: '',
	organization: null,
	apps: [],
	capabilities: [],
};

function createTestManager(lastFailure?: ConnectionStatus['lastFailure']) {
	const emitted: EmittedEvent[] = [];
	const savedTokens: string[] = [];
	const manager = Object.create(ConnectionManager.prototype) as ConnectionManagerTestAdapter;
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
	return { manager, emitted, savedTokens };
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

test('clearToken removes current and legacy stored tokens', () => {
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
		assert.deepEqual(removedSessionKeys, ['rr:user_token']);
	} finally {
		if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
		if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
		else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
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
		(manager as unknown as { pendingEvents: Map<string, unknown> }).pendingEvents = new Map();
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
		(manager as unknown as { pendingEvents: Map<string, unknown> }).pendingEvents = new Map();
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

test('stored-token login leaves request timeout unset for the outer cancellation guard', async () => {
	const loginCalls: unknown[][] = [];
	const { manager } = createTestManager();
	(manager as unknown as { client: Pick<RocketRideClient, 'login'> }).client = {
		login: async (...args: unknown[]) => {
			loginCalls.push(args);
			return authenticatedResult;
		},
	};

	await manager.loginWithStoredToken('rr_test-token');

	assert.deepEqual(loginCalls, [['rr_test-token']]);
});

test('ConnectionManager whole-login timeout detaches before rejecting and forwards token and OAuth credentials unchanged', async () => {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let timeoutCallback: (() => void) | undefined;
	let releaseDetach: (() => void) | undefined;
	let resolveLogin: ((result: ConnectResult) => void) | undefined;
	let detached = false;
	let settled = false;
	const loginCalls: unknown[][] = [];
	const oauthCredential = { code: 'code', verifier: 'verifier', redirectUri: 'https://shell.example.test' };
	const { manager } = createTestManager();

	globalThis.setTimeout = ((callback: () => void) => {
		timeoutCallback = callback;
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
	(manager as unknown as { client: Pick<RocketRideClient, 'login' | 'detach'> }).client = {
		login: async (...args: unknown[]) => {
			loginCalls.push(args);
			if (loginCalls.length === 1) return await new Promise<ConnectResult>((resolve) => { resolveLogin = resolve; });
			return authenticatedResult;
		},
		detach: async () => {
			detached = true;
			await new Promise<void>((resolve) => { releaseDetach = resolve; });
		},
	};

	try {
		const timedLogin = manager.loginWithTimeout('rr_test-token');
		void timedLogin.then(
			() => { settled = true; },
			() => { settled = true; },
		);

		timeoutCallback!();
		await Promise.resolve();
		assert.equal(detached, true);
		assert.equal(settled, false);

		resolveLogin!(authenticatedResult);
		await Promise.resolve();
		assert.equal(settled, false);

		releaseDetach!();
		await assert.rejects(timedLogin, (error: unknown) => error instanceof ConnectionFailure && error.kind === 'network');
		assert.equal(settled, true);

		assert.equal(await manager.loginWithTimeout(oauthCredential), authenticatedResult);
		assert.deepEqual(loginCalls, [['rr_test-token'], [oauthCredential]]);
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test('onConnected ignores stale callbacks but accepts the active authenticated connection', async () => {
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
		(manager as unknown as { pendingEvents: Map<string, unknown> }).pendingEvents = new Map();
		manager.initialize();
		const client = (manager as unknown as { client: { _callerOnConnected: () => Promise<void> } }).client;

		RocketRideClient.prototype.isAttached = () => false;
		RocketRideClient.prototype.isAuthenticated = () => true;
		await client._callerOnConnected();

		RocketRideClient.prototype.isAttached = () => true;
		RocketRideClient.prototype.isAuthenticated = () => false;
		await client._callerOnConnected();

		RocketRideClient.prototype.isAuthenticated = () => true;
		(manager as unknown as { suppressConnected: boolean }).suppressConnected = true;
		await client._callerOnConnected();

		assert.equal(manager.connectionStatus.state, ConnectionState.DISCONNECTED);
		assert.equal(emitted.some(({ event }) => event === 'shell:connected'), false);

		(manager as unknown as { suppressConnected: boolean }).suppressConnected = false;
		(manager as unknown as { refreshServices: () => Promise<void> }).refreshServices = async () => {};
		await client._callerOnConnected();

		assert.equal(manager.connectionStatus.state, ConnectionState.CONNECTED);
		assert.equal(emitted.filter(({ event }) => event === 'shell:connected').length, 1);
	} finally {
		RocketRideClient.prototype.attach = originalAttach;
		RocketRideClient.prototype.isAttached = originalIsAttached;
		RocketRideClient.prototype.isAuthenticated = originalIsAuthenticated;
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
