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
import { AuthenticationException, LoginAttemptCancelledError, RocketRideClient, type ConnectResult } from 'rocketride';
import { ConnectionState, type ConnectionStatus } from 'shared/types/connection';
import { ConnectionManager } from './connection.js';
import { ConnectionFailure, withTimeout } from './errors.js';
import { RemoteManager } from './remote-manager.js';
import { ApiKeyAuthProvider } from '../auth/ApiKeyAuthProvider.js';
import { CloudAuthProvider } from '../auth/CloudAuthProvider.js';
import { CONNECT_TIMEOUT_MS, LS_TOKEN } from '../constants.js';

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

function hasConnectedCallback(client: TestClient | RocketRideClient | null): client is RocketRideClient & {
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

test('auth providers sign out by removing current and legacy stored tokens', async () => {
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
			assert.deepEqual(removedSessionKeys, [LS_TOKEN]);
		}
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
		assert.equal(manager.connectionStatus.lastFailure, undefined);
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
