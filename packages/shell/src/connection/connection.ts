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

// =============================================================================
// CONNECTION MANAGER — class-based singleton for shell (browser)
// =============================================================================
//
// Mirrors the VSCode extension's ConnectionManager class pattern:
//   - Singleton via static getInstance()
//   - Typed event bus (emit/on) with debug log and wildcard listeners
//   - Delegates connection backend to RemoteManager (BaseManager subclass)
//   - Credential-keyed, generation-owned connection operations
//   - ConnectionStatus state machine with proper enum states
//
// Auth is decoupled into CloudAuthProvider / ApiKeyAuthProvider — this class
// only deals with connecting using a token/credential, not obtaining it.
//
// Shell-UI-specific additions over VSCode:
//   - Debug log circular buffer + onAny() for the ALT+D debug panel
//   - UI coordination events (shell:switchApp, shell:themeChange, etc.)
//   - Browser-specific session storage for auth phase tracking
// =============================================================================

import { RocketRideClient, ConnectResult, AuthenticationException, LoginAttemptCancelledError } from 'rocketride';
import type { ShellConnectionEventMap, IConnectionManager } from '../types/shell';
import type { IAuthProvider } from '../types/connection';
// ConnectionState is the one runtime value; the rest are type-only so
// node:test loads no more than the types module at runtime.
import { ConnectionState } from '../types/connection';
import type { ConnectionMode, ConnectionStatus } from '../types/connection';
import { BaseManager } from './base-manager';
import { RemoteManager } from './remote-manager';
import { AUTH_REJECTED_MESSAGE, ConnectionFailure } from './errors';
import { shouldReloadForTokenStorageUpdate } from './tokenStorageUpdate';
import { getStoredVerifier, clearStoredVerifier } from '../util/pkce';
import {
	LS_TOKEN,
	SS_APP_ID,
	SS_PENDING_APP_ID,
	DEBUG_LOG_MAX,
	DEFAULT_CLIENT_NAME,
	DEFAULT_WORKSPACE_DIR,
	MAX_RETRY_ATTEMPTS,
	SERVICES_CHANGED_EVENT,
	SERVICES_REFRESH_JITTER_MS,
} from '../constants';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for ConnectionManager.initialize().
 */
export interface InitOptions {
	/** WebSocket / HTTP base URI. Defaults to window.location.origin. */
	uri?: string;
	/** Human-readable client name sent to the server. */
	clientName?: string;
	/** Arbitrary environment metadata forwarded during handshake. */
	env?: Record<string, unknown>;
	/** Server connection mode (determines auth strategy). */
	connectionMode?: ConnectionMode;
	/**
	 * Auth provider for OAuth sign-in and callback handling.
	 * When set, ConnectionManager delegates all OAuth operations to it
	 * instead of managing PKCE flows internally.
	 */
	authProvider?: IAuthProvider;
	/** @deprecated Use ``authProvider`` instead. Zitadel OAuth2 authority URL. */
	zitadelUrl?: string;
	/** @deprecated Use ``authProvider`` instead. Zitadel OAuth2 client ID. */
	zitadelClientId?: string;
}

/**
 * A single entry in the debug event log.
 */
export interface DebugLogEntry {
	/** ISO 8601 timestamp when the event was emitted. */
	timestamp: string;
	/** The event name (e.g. 'shell:login'). */
	event: string;
	/** The raw payload passed to emit. */
	payload: unknown;
}

/** Handler type for a specific event's payload. */
type Handler<T = unknown> = (payload: T) => void;

/** Handler type for wildcard listeners (debug panel). */
type WildcardHandler = (event: string, payload: unknown) => void;

type ConnectionCredential = string | { code: string; verifier: string; redirectUri: string };

interface ShellConnectionOperation {
	key: string;
	generation: number;
	credential: ConnectionCredential;
	cancellationReason?: LoginAttemptCancelledError['reason'];
	promise: Promise<ConnectResult | null>;
	connectedPublished: boolean;
}

function isConnectionCredential(credential: unknown): credential is ConnectionCredential {
	return typeof credential === 'string' || (
		typeof credential === 'object' &&
		credential !== null &&
		typeof (credential as Record<string, unknown>).code === 'string' &&
		typeof (credential as Record<string, unknown>).verifier === 'string' &&
		typeof (credential as Record<string, unknown>).redirectUri === 'string'
	);
}

function connectionCredentialKey(credential: ConnectionCredential): string {
	if (typeof credential === 'string') return `token:${credential}`;
	return `pkce:${JSON.stringify({
		code: credential.code,
		verifier: credential.verifier,
		redirectUri: credential.redirectUri,
	})}`;
}

/**
 * Runtime type guard narrowing an untyped DAP event body to a ConnectResult.
 *
 * The `apaext_account` push event carries a full ConnectResult payload, but
 * the transport types every event body as an untyped record. Confirming the
 * identifying fields (`userId`, `userToken`) are present lets us emit the
 * typed `shell:accountUpdate` event without an unsafe cast.
 *
 * @param body - The raw event body from a DAP message, or undefined.
 * @returns True when `body` carries the ConnectResult identity fields.
 */
function isConnectResult(body: unknown): body is ConnectResult {
	// Presence alone is not enough — { userId: undefined } must not pass, so
	// both identity fields are checked to actually be strings.
	return (
		typeof body === 'object' &&
		body !== null &&
		typeof (body as Record<string, unknown>).userId === 'string' &&
		typeof (body as Record<string, unknown>).userToken === 'string'
	);
}

/**
 * Normalizes caller-supplied env metadata to the string map the SDK expects.
 *
 * `InitOptions.env` is the frozen `Record<string, unknown>` shape, while
 * `RocketRideClientConfig.env` copies values verbatim as strings — so strings
 * pass through, primitives (number / boolean) are stringified, and anything
 * else (objects, functions, null, undefined) is dropped rather than cast.
 *
 * @param env - Raw env metadata from InitOptions, or undefined.
 * @returns A string-valued env map, or undefined when none was given.
 */
function normalizeEnv(env: Record<string, unknown> | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === 'string') out[key] = value;
		else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
	}
	return out;
}

// =============================================================================
// CONNECTION MANAGER CLASS
// =============================================================================

/**
 * Centralized connection manager for shell.
 *
 * Owns a single persistent RocketRideClient (created at initialize(), lives
 * for the page lifetime). The SDK's persist mode handles reconnection
 * automatically.
 *
 * Delegates connection backend to RemoteManager (mirrors VSCode's BaseManager
 * pattern). Auth is handled externally by CloudAuthProvider/ApiKeyAuthProvider.
 *
 * @example
 * ```ts
 * import { ConnectionManager } from 'shell';
 *
 * const cm = ConnectionManager.getInstance();
 * cm.on('shell:event', ({ event }) => console.log('Server pushed:', event));
 * cm.emit('shell:switchApp', { appId: 'rocketride.home' });
 * ```
 */
export class ConnectionManager implements IConnectionManager {
	// =========================================================================
	// SINGLETON
	// =========================================================================

	/**
	 * Global key for the singleton. A plain `private static instance` is NOT a
	 * true singleton under Module Federation: a remote (e.g. home-ui) that loads
	 * a duplicated copy of the shell module gets its own class object with its
	 * own static field, so its emit() lands on a different instance than the one
	 * the Shell host registered listeners on — events vanish silently. Anchoring
	 * the instance on globalThis makes getInstance() return the same object
	 * regardless of how many module copies exist in the page.
	 */
	private static readonly GLOBAL_KEY = Symbol.for('rocketride.connectionManager');

	/** Returns the singleton ConnectionManager instance. */
	public static getInstance(): ConnectionManager {
		// Read/write the instance under a registry symbol on globalThis. Reflect
		// accepts symbol keys and returns `any`, so we avoid an unsafe cast of
		// globalThis (which has no symbol index signature) just to index it.
		let instance: ConnectionManager | undefined = Reflect.get(globalThis, ConnectionManager.GLOBAL_KEY);
		if (!instance) {
			instance = new ConnectionManager();
			Reflect.set(globalThis, ConnectionManager.GLOBAL_KEY, instance);
		}
		return instance;
	}

	private constructor() {}

	// =========================================================================
	// PRIVATE STATE
	// =========================================================================

	/** The shared RocketRideClient instance. */
	private client: RocketRideClient | null = null;
	private _attachPromise: Promise<void> | undefined;

	/** Active backend manager (RemoteManager). */
	private manager: BaseManager | null = null;

	/** Current in-flight shell operation, keyed by endpoint and credential. */
	private connectionOperation: ShellConnectionOperation | undefined;
	/** Latest operation allowed to publish SDK lifecycle state. */
	private lifecycleOwner: ShellConnectionOperation | undefined;
	/** Monotonic shell lifecycle generation, invalidated before SDK cleanup. */
	private connectionGeneration = 0;

	/** Connection status state machine. */
	private connectionStatus: ConnectionStatus = {
		state: ConnectionState.DISCONNECTED,
		connectionMode: 'cloud',
		hasCredentials: false,
		retryAttempt: 0,
		maxRetryAttempts: MAX_RETRY_ATTEMPTS,
	};

	/** Cached ConnectResult from the most recent successful connect. */
	private accountInfo: ConnectResult | undefined;

	/** Server URI resolved at initialize(). */
	private serverUri = '';

	// --- Services cache ---
	private cachedServices: Record<string, unknown> | null = null;
	private cachedServiceIcons: Record<string, string> | null = null;
	private cachedServicesError: string | null = null;
	private servicesRefreshPromise: Promise<void> | null = null;
	// The ONE pending jittered-refresh timer for services-changed pushes: a
	// burst of pushes restarts it (coalescing to a single fetch) and
	// dispose() cancels it so the callback cannot outlive the manager.
	private servicesRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Event bus ---
	private listeners = new Map<string, Set<Handler>>();
	private wildcardListeners = new Set<WildcardHandler>();
	private debugLog: DebugLogEntry[] = [];

	/**
	 * User-intent control events that must not be silently dropped if emitted
	 * while no listener is registered (e.g. the Shell listener is mid-remount, or
	 * a remote emits before the host's listener useEffect has run). These are
	 * buffered (latest payload wins) and replayed to the first matching handler
	 * that registers via on(). Status/lifecycle events are intentionally NOT
	 * replayable — replaying a stale 'shell:disconnected' would be wrong.
	 */
	private static readonly REPLAYABLE_EVENTS = new Set<string>([
		'shell:loginRequest',
		'shell:subscribe',
	]);

	/** Latest buffered payload per replayable event, awaiting a listener. */
	private pendingEvents = new Map<string, unknown>();

	// =========================================================================
	// INITIALIZATION
	// =========================================================================

	/**
	 * Initialize the ConnectionManager with server URI and create the
	 * RocketRideClient.
	 *
	 * Idempotent — calling multiple times is safe (subsequent calls are no-ops).
	 * Must be called before connect().
	 *
	 * @param options - Client and connection configuration.
	 */
	public initialize(options?: InitOptions): void {
		// Guard: do not create a second client
		if (this.client) return;

		// Resolve server URI
		this.serverUri = options?.uri || (typeof window !== 'undefined' ? window.location.origin : '');

		// Update connection mode if specified
		if (options?.connectionMode) {
			this.updateConnectionStatus({ connectionMode: options.connectionMode });
		}

		// Create the client with lifecycle callbacks that emit shell events.
		// persist:true instructs the SDK to automatically attempt reconnection.
		this.client = new RocketRideClient({
			uri: this.serverUri,
			clientName: options?.clientName || DEFAULT_CLIENT_NAME,
			persist: true,
			// The caller-facing option type is the frozen Record<string, unknown>;
			// normalize to the string map the SDK copies verbatim instead of casting.
			env: normalizeEnv(options?.env),

			// Fired for every push event received from the server over WebSocket
			onEvent: async (message) => {
				if (!this.hasCurrentLifecycleOwner()) return;
				// Transform apaext_account into shell:accountUpdate to avoid
				// duplicate handling downstream. The guard narrows the untyped
				// push body to a ConnectResult without a cast.
				if (message.event === 'apaext_account' && isConnectResult(message.body)) {
					this.emit('shell:accountUpdate', message.body);
					return;
				}
				// Typed pass-throughs for app-platform push events — the server
				// emits these names on the wire (dev overlay changes, review
				// decisions, store writes); re-emit them typed so consumers
				// subscribe via ShellConnectionEventMap instead of parsing the
				// generic shell:event envelope.
				if (message.event === 'shell:manifestRefresh') {
					this.emit('shell:manifestRefresh', (message.body ?? { source: 'server' }) as ShellConnectionEventMap['shell:manifestRefresh']);
					return;
				}
				if (message.event === 'app:statusChanged') {
					this.emit('app:statusChanged', (message.body ?? {}) as ShellConnectionEventMap['app:statusChanged']);
					return;
				}
				if (message.event === 'store:changed') {
					this.emit('store:changed', (message.body ?? {}) as ShellConnectionEventMap['store:changed']);
					return;
				}
				// The service catalog changed server-side: re-fetch the summary
				// cache after a random delay — the push is a broadcast, and the
				// jitter keeps the whole fleet from refetching in the same
				// instant. A single pending timer is held: a burst of pushes
				// restarts it instead of stacking one fetch per push, so K
				// rapid-fire changes cost one getServices() round trip.
				// refreshServices() no-ops safely if the connection turned over
				// during the delay, and its shell:servicesUpdated fanout
				// delivers the fresh catalog to every subscriber.
				if (message.event === SERVICES_CHANGED_EVENT) {
					if (this.servicesRefreshTimer !== null) {
						clearTimeout(this.servicesRefreshTimer);
					}
					this.servicesRefreshTimer = setTimeout(() => {
						this.servicesRefreshTimer = null;
						void this.refreshServices().catch(() => {});
					}, Math.random() * SERVICES_REFRESH_JITTER_MS);
					return;
				}
				// Broadcast all other server events
				this.emit('shell:event', { event: message });
			},

			// Fired once the WebSocket handshake completes and auth succeeds
			onConnected: async () => {
				if (!this.hasCurrentLifecycleOwner()) return;
				if (!this.client?.isAttached() || !this.client.isAuthenticated()) return;
				this.publishConnected(this.lifecycleOwner!);
			},

			// Fired when the WebSocket closes for any reason
			onDisconnected: async (reason, hasError) => {
				if (!this.hasCurrentLifecycleOwner()) return;
				this.lifecycleOwner!.connectedPublished = false;
				this.clearServicesCache();
				// Don't overwrite AUTH_FAILED state
				if (this.connectionStatus.state !== ConnectionState.AUTH_FAILED) {
					this.updateConnectionStatus({ state: ConnectionState.CONNECTING, errorKind: undefined });
				}
				this.emit('shell:disconnected', { reason: reason ?? 'unknown', hasError: hasError ?? false });
			},

			// Fired on each failed connection attempt before SDK retries
			onConnectError: (error) => {
				if (!this.hasCurrentLifecycleOwner()) return;
				// A background re-login rejection is terminal: the SDK downgrades
				// to an anonymous attachment and stops retrying. Without latching
				// here, a token revoked mid-session leaves the UI showing
				// "Reconnecting\u2026" forever with a dead token still stored.
				if (error instanceof AuthenticationException) {
					if (this.handleStoredTokenFailure(error)) this.clearToken();
					this.accountInfo = undefined;
					this.emit('shell:statusMessage', { message: null });
					return;
				}
				this.updateConnectionStatus({
					progressMessage: 'Reconnecting\u2026',
					retryAttempt: this.connectionStatus.retryAttempt + 1,
				});
				this.emit('shell:statusMessage', { message: 'Reconnecting\u2026' });
			},
		});

		// Store auth provider (preferred) or legacy OAuth config
		if (options?.authProvider) {
			this.authProvider = options.authProvider;
		}
		this.zitadelUrl = options?.zitadelUrl ?? '';
		this.zitadelClientId = options?.zitadelClientId ?? '';

		// Attach immediately so public APIs (rrext_public_*) work before login.
		// The promise is stored so bootstrap() can await it before login().
		this._attachPromise = this.client.attach(undefined, { timeout: 10000 });
		void this._attachPromise.catch((err) => {
			console.error('[ConnectionManager] Failed to attach:', err);
		});

		// When the user presses Back from Zitadel, the browser restores this page
		// from the back/forward cache — the singleton (and its `oauthStarted`
		// one-shot guard) is frozen and restored as-is, so a fresh "Get Started"
		// click would hit the guard and do nothing. Release it on bfcache restore
		// so the button works again without a manual page refresh.
		if (typeof window !== 'undefined') {
			window.addEventListener('storage', (event) => {
				try {
					const localStorage = window.localStorage;
					if (event.key !== LS_TOKEN || event.storageArea !== localStorage) return;

					if (event.newValue === null) {
						this.clearToken();
						this.accountInfo = undefined;
						this.pendingEvents.clear();
						this.clearServicesCache();
						this.updateConnectionStatus({
							state: ConnectionState.DISCONNECTED,
							hasCredentials: false,
							lastError: undefined,
							progressMessage: undefined,
						});
						window.location.reload();
						return;
					}

					if (shouldReloadForTokenStorageUpdate({
						oldValue: event.oldValue,
						newValue: event.newValue,
						currentUserToken: this.accountInfo?.userToken,
						hasAccountInfo: Boolean(this.accountInfo),
					})) {
						window.location.reload();
					}
				} catch {
					return;
				}
			});

			window.addEventListener('pageshow', (e) => {
				if ((e as PageTransitionEvent).persisted) {
					this.oauthStarted = false;
					// Back from Zitadel without signing in: if still unauthenticated,
					// drop any pending app so a later refresh can't re-seed the auth
					// gate and bounce the user back to login. Guard on token — a
					// signed-in user's last-active-app restore reuses rr:appId via
					// persistActiveApp, so it must survive for them.
					if (!this.loadToken()) this.clearPendingAppId();
				}
			});
		}
	}

	/**
	 * Alias for initialize() — preserves the old API.
	 */
	public init(options?: InitOptions): void {
		this.initialize(options);
	}

	// =========================================================================
	// OAUTH — PKCE redirect flow (SaaS mode)
	// =========================================================================

	/** Auth provider for OAuth sign-in (set via init options). */
	private authProvider: IAuthProvider | null = null;

	/** @deprecated Legacy Zitadel config — use authProvider instead. */
	private zitadelUrl = '';
	/** @deprecated Legacy Zitadel config — use authProvider instead. */
	private zitadelClientId = '';

	/** Cached in-flight/settled bootstrap promise — dedupes repeat bootstrap() calls
	 *  (StrictMode double-invoke in dev, a Shell remount, MF host re-init) so every caller
	 *  gets the SAME result instead of a null that the shell would misread as "logged out". */
	private bootPromise: Promise<{ result: ConnectResult; appId: string } | null> | null = null;

	/** One-shot guard: startOAuth always ends in a full-page redirect, so it must
	 *  never run twice in one page load (double authorize → Zitadel invalidates the
	 *  first code → PKCE 400 → re-auth loop). */
	private oauthStarted = false;

	/**
	 * Redirect the browser to the OAuth provider for authorization.
	 *
	 * Delegates to the auth provider's ``signIn()`` method. Falls back to
	 * the legacy PKCE flow if no auth provider is configured.
	 *
	 * @param register - Retained for compatibility; no longer changes the
	 *                   destination. All flows land on Zitadel's login page
	 *                   (prompt=login), which offers a Register link.
	 */
	public async startOAuth(register?: boolean): Promise<void> {
		// One-shot: a redirect is coming; never start a second authorize in the
		// same page load (that invalidates the first code and 400s the exchange).
		// The guard is released on any path that does NOT actually navigate, so a
		// failed initiation can still be retried within the same page load.
		if (this.oauthStarted) return;
		this.oauthStarted = true;
		try {
			if (this.authProvider) {
				await this.authProvider.signIn(undefined, register);
				return;
			}
			// Legacy fallback — remove once all callers pass authProvider
			if (!this.zitadelUrl || !this.zitadelClientId) {
				console.error('[ConnectionManager] Zitadel not configured');
				this.emit('shell:error', { error: new Error('Zitadel not configured') });
				this.oauthStarted = false; // no redirect happened — allow a retry
				return;
			}
			const { generatePkce, buildAuthUrl } = await import('../util/pkce');
			const { challenge } = await generatePkce();
			const url = buildAuthUrl(this.zitadelUrl, this.zitadelClientId, window.location.origin, challenge, register);
			// assign() (not replace()) keeps the landing page reachable via the
			// browser back button — matches CloudAuthProvider.signIn().
			window.location.assign(url);
		} catch (err) {
			// Initiation threw before any redirect (signIn rejected, PKCE/crypto
			// failure, etc.) — release the guard so a later attempt can retry.
			this.oauthStarted = false;
			throw err;
		}
	}

	/**
	 * Run the one-time auth bootstrap sequence.
	 *
	 * Reads auth state and takes the appropriate action:
	 * - ?code= in URL → exchange PKCE code → connect
	 * - stored token → reconnect
	 * - nothing → show shell unauthenticated
	 *
	 * @param config - Optional config for theme restore and app resolution.
	 * @returns The connect result and resolved app ID, or null.
	 */
	public async bootstrap(config?: {
		apps?: Array<{ id: string }>;
		workspaceDir?: string;
		onThemeChange?: (theme: string) => void;
	}): Promise<{ result: ConnectResult; appId: string } | null> {
		// Dedupe: bootstrap can be invoked more than once per page load (StrictMode
		// double-invoke in dev, a Shell remount, or MF host re-init). Returning null on
		// the 2nd call made the shell flip to renderPhase='shell' with a null identity —
		// flashing the logged-out landing page until the real (in-flight) bootstrap
		// resolved. Hand every caller the SAME promise so they all settle on the real
		// authenticated result and the shell never sees a spurious null.
		if (this.bootPromise) return this.bootPromise;
		this.bootPromise = this._bootstrap(config);
		return this.bootPromise;
	}

	private async _bootstrap(config?: {
		apps?: Array<{ id: string }>;
		workspaceDir?: string;
		onThemeChange?: (theme: string) => void;
	}): Promise<{ result: ConnectResult; appId: string } | null> {
		if (!this.client) throw new Error('Client not initialized — call init() first.');
		const bootstrapGeneration = this.connectionGeneration;

		// Ensure the transport is attached before any login attempt. The native
		// attach timeout closes a timed-out handshake before this promise rejects.
		try {
			await this._attachPromise!;
		} catch (error) {
			if (this.connectionGeneration !== bootstrapGeneration) return null;
			// Transport attach failures are network problems by definition.
			this.handleStoredTokenFailure(
				error instanceof ConnectionFailure
					? error
					: new ConnectionFailure(error instanceof Error ? error.message : String(error), 'network'),
			);
			return null;
		}
		if (this.connectionGeneration !== bootstrapGeneration) return null;

		const params = new URLSearchParams(window.location.search);
		const code = params.get('code');
		// Only honor `auth_error`: it is set exclusively by our own OAuth
		// callback (the registered redirect_uri is the server callback, which
		// wraps every Zitadel failure as `auth_error` before redirecting here).
		// The generic OAuth `error`/`error_description` params never legitimately
		// reach the app this way, so reading them would let any unrelated app
		// deep-link (`/app?error=…`) hijack bootstrap into a false sign-in banner.
		const errorDescription = params.get('auth_error');

		if (errorDescription) {
			if (this.connectionGeneration !== bootstrapGeneration) return null;
			// Strip the query string but keep any existing history state (e.g. the
			// rrHome snapshot / appId) so an OAuth failure does not lose navigation.
			window.history.replaceState({ ...(window.history.state ?? {}) }, '', window.location.pathname);
			this.updateConnectionStatus({
				state: ConnectionState.AUTH_FAILED,
				lastError: errorDescription,
				progressMessage: undefined,
				errorKind: 'oauth-callback',
				lastFailure: { kind: 'auth', lastError: errorDescription, errorKind: 'oauth-callback' },
			});
			this.clearPendingAppId();
			return null;
		}

		const sessionAppId = this.getSessionAppId();

		// ── OAuth callback — exchange authorization code for a session ────
		if (code) {
			const verifier = getStoredVerifier();
			clearStoredVerifier();
			// Strip the ?code= from the URL so refreshes don't re-exchange.
			// Carry the existing `history.state` across — it is shared with the
			// home-ui remote (which keeps its snapshot under `rrHome`), so it must
			// be merged, never replaced; only the query string is being dropped.
			window.history.replaceState({ ...(window.history.state ?? {}) }, '', window.location.pathname);

			if (!verifier) {
				// Missing verifier — can't exchange this code. This is the
				// back-button case: now that we use assign(), the auth chain
				// stays in history, so a stale ?code entry can be revisited.
				// Prefer the stored token over bouncing into another round-trip.
				const staleToken = this.loadToken();
				if (staleToken) {
					try {
						return await this.connectForBootstrap(staleToken, sessionAppId, config);
					} catch (error) {
						if (this.handleStoredTokenFailure(error)) this.clearToken();
						else return null;
					}
				}
				// No usable token — render unauthenticated and let the shell's
				// auth gate decide (see the session-locked branch below for why
				// bootstrap never starts a login flow itself).
				return null;
			}

			try {
				return await this.connectForBootstrap({ code, verifier, redirectUri: window.location.origin }, sessionAppId, config);
			} catch (error) {
				// The code is single-use and already stripped from the URL, so
				// recovery always goes through a fresh flow — classify and latch
				// instead of letting the failure escape bootstrap unhandled.
				if (error instanceof AuthenticationException || (error instanceof ConnectionFailure && error.kind === 'auth')) {
					const lastError = error.message;
					this.updateConnectionStatus({
						state: ConnectionState.AUTH_FAILED,
						lastError,
						progressMessage: undefined,
						errorKind: 'oauth-callback',
						lastFailure: { kind: 'auth', lastError, errorKind: 'oauth-callback' },
					});
				} else {
					this.handleStoredTokenFailure(
						error instanceof ConnectionFailure
							? error
							: new ConnectionFailure(error instanceof Error ? error.message : String(error), 'network'),
					);
				}
				return null;
			}
		}

		// ── Session-locked app — reconnect with stored token ─────────────
		if (sessionAppId) {
			const token = this.loadToken();
			if (token) {
				try {
					return await this.connectForBootstrap(token, sessionAppId, config);
				} catch (error) {
					// Token expired or invalid — clear it and fall through to
					// the unauthenticated render below (the shell's auth gate
					// owns starting a login flow, edition-aware). A network
					// failure keeps the token so the recovery banner can retry
					// with it once the server is reachable again.
					if (this.handleStoredTokenFailure(error)) this.clearToken();
				}
			}
			// Unauthenticated session-locked visit: bootstrap deliberately does
			// NOT start a login flow. The shell's auth gate (ShellLayout) emits
			// shell:loginRequest only when the app EXISTS in the manifest and
			// requires auth, and the Shell handler dispatches edition-aware
			// (saas -> Zitadel OAuth, OSS -> the in-shell API-key screen).
			// Starting OAuth here bounced anonymous visitors to Zitadel even
			// for app ids this server does not have (which now render the
			// App-not-found panel instead) and even on OSS, which has no
			// Zitadel at all. NOTE: if pre-auth manifest filtering by
			// permission ever lands, hidden-but-real apps will need a probe
			// signal here to still reach the login flow.
			return null;
		}

		// ── Home flow (no session lock) — try stored token ────────────────
		const token = this.loadToken();
		if (token) {
			try {
				return await this.connectForBootstrap(token, '', config);
			} catch (err) {
				// Connect failed — retain the token when the server is unreachable.
				if (this.handleStoredTokenFailure(err)) this.clearToken();
				return null;
			}
		}

		// No code, no session lock, no token — an unauthenticated home load. If a
		// pending app survived an abandoned OAuth round-trip (user pressed Back from
		// the Zitadel login instead of signing in), drop it now. Otherwise Shell
		// re-seeds startupAppId from it and the ShellLayout auth gate re-fires
		// shell:loginRequest → startOAuth, bouncing the user straight back to Zitadel.
		this.clearPendingAppId();
		// Show shell unauthenticated (transport is attached, public APIs work)
		return null;
	}

	/** Reject login results that do not identify an authenticated account. */
	private requireAuthenticatedResult(result: ConnectResult | null | undefined): ConnectResult {
		if (!result?.userId) {
			throw new ConnectionFailure(AUTH_REJECTED_MESSAGE, 'auth');
		}
		return result;
	}

	/**
	 * Internal helper called after a successful connect.
	 *
	 * Persists the token, emits shell:login, restores saved theme,
	 * and resolves the target app ID.
	 */
	private async finishConnect(
		result: ConnectResult,
		appId: string,
		config?: {
			apps?: Array<{ id: string }>;
			workspaceDir?: string;
			onThemeChange?: (theme: string) => void;
		},
		operation?: ShellConnectionOperation,
	): Promise<{ result: ConnectResult; appId: string }> {
		this.requireAuthenticatedResult(result);
		if (operation) this.assertCurrentOperation(operation);

		// Direct callers retain the original helper behaviour. Foreground connect()
		// has already published identity before bootstrap restores shell-only state.
		if (!operation) {
			if (result.userToken) this.saveToken(result.userToken);
			this.clearLatchedFailure();
			this.accountInfo = result;
			this.emit('shell:login', { user: result });
		}

		// Restore saved theme from workspace file
		if (config?.onThemeChange) {
			try {
				const dir = config.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
				const global = await this.client!.fsReadJson<{ shellPrefs?: { theme?: string } }>(`${dir}/global.json`);
				if (operation) this.assertCurrentOperation(operation);
				if (global?.shellPrefs?.theme) config.onThemeChange(global.shellPrefs.theme);
			} catch (error) {
				if (error instanceof LoginAttemptCancelledError) throw error;
				// Theme restore is best-effort.
			}
		}

		// Resolve the target app — check pending app ID from OAuth flow
		const pendingAppId = this.getPendingAppId();
		const resolvedAppId = appId || pendingAppId;

		// Notify the workspace to switch to the target app
		if (resolvedAppId) {
			if (operation) this.assertCurrentOperation(operation);
			this.emit('shell:switchApp', { appId: resolvedAppId });
		}

		return { result, appId: resolvedAppId };
	}

	/** Finish bootstrap-only effects after the shared foreground operation succeeds. */
	private async connectForBootstrap(
		credential: ConnectionCredential,
		appId: string,
		config?: {
			apps?: Array<{ id: string }>;
			workspaceDir?: string;
			onThemeChange?: (theme: string) => void;
		},
	): Promise<{ result: ConnectResult; appId: string } | null> {
		const connection = this.connect(credential);
		const operation = this.connectionOperation;
		const result = await connection;
		if (!operation || !this.isCurrentOperation(operation)) return null;
		if (!result) return null;
		try {
			return await this.finishConnect(result, appId, config, operation);
		} catch (error) {
			if (error instanceof LoginAttemptCancelledError) return null;
			throw error;
		}
	}

	private isCurrentOperation(operation: ShellConnectionOperation): boolean {
		return this.lifecycleOwner === operation &&
			this.connectionGeneration === operation.generation &&
			operation.cancellationReason === undefined;
	}

	private hasCurrentLifecycleOwner(): boolean {
		return this.lifecycleOwner !== undefined && this.isCurrentOperation(this.lifecycleOwner);
	}

	private assertCurrentOperation(operation: ShellConnectionOperation): void {
		if (!this.isCurrentOperation(operation)) {
			throw new LoginAttemptCancelledError(operation.cancellationReason ?? 'superseded');
		}
	}

	private invalidateLifecycle(reason: LoginAttemptCancelledError['reason']): void {
		if (this.lifecycleOwner) this.lifecycleOwner.cancellationReason = reason;
		this.connectionGeneration++;
		this.connectionOperation = undefined;
		this.lifecycleOwner = undefined;
	}

	/**
	 * Retire a latched failure after an authenticated connect. Anonymous
	 * connects must NOT call this: a public connect following a session expiry
	 * would otherwise erase the recovery banner before the user acts on it.
	 */
	private clearLatchedFailure(): void {
		if (this.connectionStatus.lastFailure) this.updateConnectionStatus({ lastFailure: undefined });
	}

	private publishConnected(operation: ShellConnectionOperation): void {
		if (!this.isCurrentOperation(operation) || operation.connectedPublished) return;
		operation.connectedPublished = true;
		// NB: no `lastFailure: undefined` here. This publisher runs for every
		// CONNECTED transition including anonymous/public connects, so clearing
		// unconditionally would wipe a "session expired" banner before the user
		// could act on it. updateConnectionStatus() clears network latches on
		// CONNECTED; an auth latch is cleared only by an authenticated connect
		// (see clearLatchedFailure callers).
		this.updateConnectionStatus({
			state: ConnectionState.CONNECTED,
			lastConnected: new Date(),
			lastError: undefined,
			errorKind: undefined,
			retryAttempt: 0,
			progressMessage: undefined,
		});
		this.emit('shell:connected', {});
		void this.refreshServices().catch((error: unknown) => {
			console.error('[ConnectionManager] Failed to refresh services on connect:', error);
		});
	}

	// =========================================================================
	// CONNECT / DISCONNECT (mirrors VSCode pattern)
	// =========================================================================

	/**
	 * Connect to the server using the provided credential.
	 *
	 * Deduplicates concurrent calls for the same normalized endpoint and
	 * credential. A different credential supersedes publication by the old call.
	 *
	 * @param credential - Token string or PKCE exchange object.
	 * @returns The ConnectResult on success, or null if deduplicated.
	 */
	public connect(credential?: unknown): Promise<ConnectResult | null> {
		if (!isConnectionCredential(credential)) {
			return Promise.reject(new Error('No credential provided for connection.'));
		}

		const key = `${RocketRideClient.normalizeUri(this.serverUri)}\u0000${connectionCredentialKey(credential)}`;
		if (this.connectionOperation?.key === key) return this.connectionOperation.promise;

		if (this.lifecycleOwner) this.lifecycleOwner.cancellationReason = 'superseded';
		const operation: ShellConnectionOperation = {
			key,
			generation: ++this.connectionGeneration,
			credential,
			promise: Promise.resolve(null),
			connectedPublished: false,
		};
		this.lifecycleOwner = operation;
		this.connectionOperation = operation;
		const promise = this._connect(operation).catch((error: unknown) => {
			if (error instanceof LoginAttemptCancelledError) return null;
			throw error;
		}).finally(() => {
			if (this.connectionOperation === operation) this.connectionOperation = undefined;
		});
		operation.promise = promise;
		return promise;
	}

	/**
	 * Internal connect implementation.
	 */
	private async _connect(operation: ShellConnectionOperation): Promise<ConnectResult | null> {
		if (!this.client) {
			throw new Error('Client not initialized — call initialize() first.');
		}
		this.assertCurrentOperation(operation);
		this.updateConnectionStatus({
			state: ConnectionState.CONNECTING,
			lastError: undefined,
			errorKind: undefined,
		});

		try {
			const manager = new RemoteManager(() => this.isCurrentOperation(operation));
			this.manager = manager;

			// Delegate connection to the manager (handles timeout internally)
			await manager.connect(this.client, {
				uri: this.serverUri,
				credential: operation.credential,
			});
			this.assertCurrentOperation(operation);

			// Get the connect result from the client
			const result = this.requireAuthenticatedResult(this.client.getAccountInfo());
			this.assertCurrentOperation(operation);
			this.updateConnectionStatus({ lastFailure: undefined });
			this.assertCurrentOperation(operation);
			this.accountInfo = result;
			// Identity established — this is the only signal that retires an
			// auth latch (publishConnected deliberately no longer does).
			this.clearLatchedFailure();

			// Persist token
			if (result.userToken) {
				this.assertCurrentOperation(operation);
				this.saveToken(result.userToken);
			}

			// Emit login event
			this.assertCurrentOperation(operation);
			this.emit('shell:login', { user: result });
			this.assertCurrentOperation(operation);
			this.publishConnected(operation);

			return result;
		} catch (error) {
			if (!this.isCurrentOperation(operation)) {
				throw new LoginAttemptCancelledError(operation.cancellationReason ?? 'superseded');
			}
			if (error instanceof LoginAttemptCancelledError) throw error;
			const errorMessage = error instanceof Error ? error.message : String(error);
			const state = this.getConnectionFailureState(error);
			const isAuthFailure = state === ConnectionState.AUTH_FAILED;
			if (isAuthFailure) {
				this.clearToken();
				this.accountInfo = undefined;
			}

			this.updateConnectionStatus({
				state,
				lastError: errorMessage,
				progressMessage: undefined,
				errorKind: undefined,
				lastFailure: {
					kind: isAuthFailure ? 'auth' : 'network',
					lastError: errorMessage,
					errorKind: undefined,
				},
			});

			this.emit('shell:error', { error });
			throw error;
		}
	}

	/**
	 * Disconnect from the server gracefully.
	 * Safe to call when already disconnected.
	 */
	public async disconnect(): Promise<void> {
		this.invalidateLifecycle('detached');
		const generation = this.connectionGeneration;
		const manager = this.manager;
		const client = this.client;

		if (manager && client) {
			await manager.disconnect(client);
			if (this.manager === manager) this.manager = null;
		}
		if (this.connectionGeneration !== generation) return;

		this.clearServicesCache();
		this.updateConnectionStatus({
			state: ConnectionState.DISCONNECTED,
			progressMessage: undefined,
			errorKind: undefined,
		});
		this.emit('shell:disconnected', { reason: 'Disconnected by request', hasError: false });
	}

	/**
	 * Disconnect and reconnect.
	 */
	public async reconnect(): Promise<void> {
		const token = this.loadToken();
		await this.disconnect();
		if (token) {
			await this.connect(token);
		}
	}

	/** Map a connection failure to the status state that determines recovery UI. */
	private getConnectionFailureState(error: unknown): ConnectionState {
		if (error instanceof ConnectionFailure) {
			switch (error.kind) {
				case 'auth': return ConnectionState.AUTH_FAILED;
				case 'network': return ConnectionState.FAILED;
				case 'server': return ConnectionState.FAILED;
			}
		}

		// The SDK types auth rejections (invalid/revoked/expired credentials).
		if (error instanceof AuthenticationException) return ConnectionState.AUTH_FAILED;

		const errorMessage = error instanceof Error ? error.message : String(error);
		// Legacy fallback for untyped errors from older connection paths.
		const isAuthError = errorMessage.includes('Authentication failed') ||
			errorMessage.includes('unknown user') ||
			errorMessage.includes('invalid credentials');
		return isAuthError ? ConnectionState.AUTH_FAILED : ConnectionState.FAILED;
	}

	/** Surface a stored-token failure and return whether the token should be cleared. */
	private handleStoredTokenFailure(error: unknown): boolean {
		const state = this.getConnectionFailureState(error);
		const isAuthFailure = state === ConnectionState.AUTH_FAILED;
		const isNetworkFailure = error instanceof ConnectionFailure && error.kind === 'network';
		const lastError = isNetworkFailure
			? 'Can\'t reach the server — check your connection and retry.'
			: isAuthFailure
				? 'Your session has expired — please sign in again.'
				: error instanceof Error ? error.message : String(error);
		this.updateConnectionStatus({
			state,
			lastError,
			progressMessage: undefined,
			errorKind: isAuthFailure ? 'session' : undefined,
			// Latched so the SDK's reconnect churn (CONNECTING) and anonymous
			// connects can't erase the failure before recovery UI renders it.
			lastFailure: {
				kind: isAuthFailure ? 'auth' : 'network',
				lastError,
				errorKind: isAuthFailure ? 'session' : undefined,
			},
		});
		// A CORS-blocked or proxy-dropped request and a dead server both surface
		// as the same opaque network TypeError, but only one means the server is
		// down. Disambiguate with a same-origin probe, which every topology
		// serves: single-host deployments answer /version on the page origin and
		// CDN-split ones proxy it through the edge. When the probe answers, the
		// server is reachable and the stored token simply couldn't be validated,
		// so recovery is sign-in, not retry; re-latch as a session failure so the
		// signed-out landing gets the sign-in banner instead of a false outage.
		if (isNetworkFailure) {
			const generation = this.connectionGeneration;
			// Capture the exact failure object this probe is disambiguating.
			// updateConnectionStatus latches a fresh object per failure, so a
			// newer network failure — even one in this same generation — replaces
			// the reference. Identity, not kind, is what proves the latch is still
			// the one this probe was launched for.
			const latchedFailure = this.connectionStatus.lastFailure;
			void fetch('/version', { cache: 'no-store' }).then((res) => {
				if (!res.ok) return;
				if (this.connectionGeneration !== generation) return;
				// Only downgrade the specific failure this probe latched. A newer
				// failure (including another network one) or a reconnect that
				// cleared the latch swaps the reference, and must not be
				// overwritten with a session downgrade.
				if (this.connectionStatus.lastFailure !== latchedFailure) return;
				const message = 'Your session has expired — please sign in again.';
				this.updateConnectionStatus({
					state: ConnectionState.AUTH_FAILED,
					lastError: message,
					progressMessage: undefined,
					errorKind: 'session',
					lastFailure: { kind: 'auth', lastError: message, errorKind: 'session' },
				});
			}).catch(() => {
				// Probe failed too: genuinely unreachable, keep the network banner.
			});
		}
		return isAuthFailure;
	}

	/**
	 * Logout: clear auth state, disconnect, and emit shell:logout.
	 */
	public async logout(): Promise<void> {
		this.invalidateLifecycle('logout');
		// Clear persisted auth state
		this.clearToken();
		this.clearSessionAppId();
		this.accountInfo = undefined;
		// Drop any buffered user-intent events so a stale shell:subscribe /
		// shell:loginRequest can't replay into the next session.
		this.pendingEvents.clear();

		// Emit logout before disconnecting so listeners can clean up
		this.emit('shell:logout', {});

		// Gracefully close the connection
		await this.disconnect();
	}

	/**
	 * Clean up all resources. Called on page unload.
	 */
	public async dispose(): Promise<void> {
		await this.disconnect();
		// Cancel any pending jittered services refresh — the callback holds a
		// reference to this manager and must not fire after disposal.
		if (this.servicesRefreshTimer !== null) {
			clearTimeout(this.servicesRefreshTimer);
			this.servicesRefreshTimer = null;
		}
		this.listeners.clear();
		this.wildcardListeners.clear();
		this.pendingEvents.clear();
		this.debugLog.length = 0;
	}

	// =========================================================================
	// PUBLIC ACCESSORS (matches VSCode API)
	// =========================================================================

	/** Returns the RocketRideClient instance, or null if not initialized. */
	public getClient(): RocketRideClient | null {
		return this.client;
	}

	/** Returns true if the WebSocket is authenticated and connected. */
	public isConnected(): boolean {
		return this.connectionStatus.state === ConnectionState.CONNECTED &&
			(this.client?.isConnected() ?? false);
	}

	/** Returns true if a connection attempt is in progress. */
	public isConnecting(): boolean {
		return this.connectionStatus.state === ConnectionState.CONNECTING;
	}

	/** Returns true if disconnected (not connecting or connected). */
	public isDisconnected(): boolean {
		return this.connectionStatus.state === ConnectionState.DISCONNECTED;
	}

	/** Returns true if we have credentials to attempt connection. */
	public hasCredentials(): boolean {
		return this.connectionStatus.hasCredentials;
	}

	/** Returns a copy of the current connection status. */
	public getConnectionStatus(): ConnectionStatus {
		return { ...this.connectionStatus };
	}

	/** Returns the cached ConnectResult from the most recent successful connect. */
	public getAccountInfo(): ConnectResult | undefined {
		return this.accountInfo ?? this.client?.getAccountInfo() as ConnectResult | undefined;
	}

	/** Returns the resolved server HTTP URL. */
	public getHttpUrl(): string {
		return this.serverUri;
	}

	// =========================================================================
	// TOKEN STORAGE
	// =========================================================================

	/** Persist a user token to localStorage. */
	public saveToken(token: string): void {
		try { localStorage.setItem(LS_TOKEN, token); } catch (e) {
			console.error('[ConnectionManager] Failed to save token:', e);
		}
	}

	/** Load token from localStorage. Migrates the old sessionStorage value once. */
	public loadToken(): string {
		try {
			const token = localStorage.getItem(LS_TOKEN);
			if (token !== null) return token;

			const sessionToken = sessionStorage.getItem(LS_TOKEN);
			if (sessionToken === null) return '';

			localStorage.setItem(LS_TOKEN, sessionToken);
			sessionStorage.removeItem(LS_TOKEN);
			return sessionToken;
		} catch { return ''; }
	}

	/** Clear the persisted token. */
	public clearToken(): void {
		try { localStorage.removeItem(LS_TOKEN); } catch (e) {
			console.error('[ConnectionManager] Failed to clear token:', e);
		}
		try { sessionStorage.removeItem(LS_TOKEN); } catch (e) {
			console.error('[ConnectionManager] Failed to clear legacy session token:', e);
		}
	}

	/** Update the hasCredentials flag based on token availability. */
	public updateCredentialsStatus(): void {
		const token = this.loadToken();
		this.updateConnectionStatus({ hasCredentials: token.length > 0 });
	}

	// =========================================================================
	// SESSION STORAGE HELPERS
	// =========================================================================

	/** Read session-locked app ID from sessionStorage. */
	public getSessionAppId(): string {
		try { return sessionStorage.getItem(SS_APP_ID) ?? ''; } catch { return ''; }
	}

	/** Save session-locked app ID to sessionStorage. */
	public setSessionAppId(id: string): void {
		try { sessionStorage.setItem(SS_APP_ID, id); } catch (e) {
			console.error('[ConnectionManager] Failed to set session app ID:', e);
		}
	}

	/** Clear session app ID. */
	private clearSessionAppId(): void {
		try {
			sessionStorage.removeItem(SS_APP_ID);
			sessionStorage.removeItem(SS_PENDING_APP_ID);
		} catch (e) {
			console.error('[ConnectionManager] Failed to clear session storage:', e);
		}
	}

	/** Read the pending app ID (set before OAuth redirect). */
	public getPendingAppId(): string {
		try { return sessionStorage.getItem(SS_PENDING_APP_ID) ?? ''; } catch { return ''; }
	}

	/** Clear the pending app ID. Called when an OAuth round-trip is abandoned
	 *  (user pressed Back from Zitadel) so the stale target can't re-seed the
	 *  auth gate on the next load and bounce them straight back to login. */
	public clearPendingAppId(): void {
		try { sessionStorage.removeItem(SS_PENDING_APP_ID); } catch { /* storage unavailable */ }
	}

	/** Save pending app ID (for retrieval after OAuth callback). */
	public setPendingAppId(id: string): void {
		try { sessionStorage.setItem(SS_PENDING_APP_ID, id); } catch (e) {
			console.error('[ConnectionManager] Failed to set pending app ID:', e);
		}
	}

	// =========================================================================
	// SERVICES CACHE (identical to VSCode pattern)
	// =========================================================================

	/**
	 * Returns the cached service catalog, triggering a lazy fetch on first access.
	 *
	 * The summary response's deduplicated icon table rides along so consumers
	 * (the canvas icon registry) never need a fetch of their own.
	 */
	public getCachedServices(): { services: Record<string, unknown>; icons?: Record<string, string>; servicesError?: string } {
		if (!this.isConnected()) {
			return { services: {}, icons: {}, servicesError: 'Not connected' };
		}
		// Lazy fetch on first access — fire-and-forget with the same rejection
		// guard the other refreshServices() call sites use.
		if (this.cachedServices === null && !this.cachedServicesError && !this.servicesRefreshPromise) {
			void this.refreshServices().catch(() => {});
		}
		if (this.cachedServicesError) {
			return { services: this.cachedServices ?? {}, icons: this.cachedServiceIcons ?? {}, servicesError: this.cachedServicesError };
		}
		return { services: this.cachedServices ?? {}, icons: this.cachedServiceIcons ?? {} };
	}

	/**
	 * Fetches the service catalog from the server and updates the cache.
	 * Deduplicates concurrent calls.
	 */
	public async refreshServices(): Promise<void> {
		const owner = this.lifecycleOwner;
		if (!owner || !this.isCurrentOperation(owner)) return;
		if (!this.isConnected() || !this.client) {
			if (this.isCurrentOperation(owner)) {
				this.clearServicesCache();
				this.emit('shell:servicesUpdated', { services: {}, servicesError: 'Not connected' });
			}
			return;
		}

		// Deduplicate concurrent calls
		if (this.servicesRefreshPromise) {
			return this.servicesRefreshPromise;
		}

		const refreshPromise = (async () => {
			try {
				const body = await this.client!.getServices();
				if (!this.isCurrentOperation(owner)) return;
				const services: Record<string, unknown> = body.services ?? {};
				const icons: Record<string, string> = body.icons ?? {};
				this.cachedServices = services;
				this.cachedServiceIcons = icons;
				this.cachedServicesError = null;
				this.emit('shell:servicesUpdated', { services, icons, servicesError: undefined });
			} catch (err: unknown) {
				if (!this.isCurrentOperation(owner)) return;
				const msg = err instanceof Error ? err.message : String(err);
				this.cachedServices = null;
				this.cachedServiceIcons = null;
				this.cachedServicesError = msg;
				this.emit('shell:servicesUpdated', { services: {}, icons: {}, servicesError: msg });
			}
		})();
		this.servicesRefreshPromise = refreshPromise;
		void refreshPromise.finally(() => {
			if (this.servicesRefreshPromise === refreshPromise) this.servicesRefreshPromise = null;
		});

		return refreshPromise;
	}

	/** Clear all services cache state. */
	private clearServicesCache(): void {
		this.cachedServices = null;
		this.cachedServiceIcons = null;
		this.cachedServicesError = null;
		this.servicesRefreshPromise = null;
	}

	// =========================================================================
	// EVENT BUS (typed, with debug log + wildcard support)
	// =========================================================================

	/**
	 * Emit a typed shell event, dispatching to all registered handlers.
	 * Also pushes to the debug log for the ALT+D panel.
	 *
	 * @param event   - The event name from ShellConnectionEventMap.
	 * @param payload - The payload matching the event's type.
	 */
	public emit<K extends keyof ShellConnectionEventMap>(event: K, payload: ShellConnectionEventMap[K]): void {
		// Push into debug log
		this.logDebug(event as string, payload);

		// Dispatch to registered handlers via microtask. An unsubscribed handler
		// leaves an empty Set behind, so check size — not just presence.
		const handlers = this.listeners.get(event as string);
		if (handlers && handlers.size > 0) {
			Promise.resolve().then(() => {
				for (const fn of handlers) {
					try {
						fn(payload);
					} catch (err) {
						console.error(`[ConnectionManager] Handler for '${event as string}' threw:`, err);
					}
				}
			});
			return;
		}

		// No live listener. For user-intent control events, buffer the payload so
		// it can be replayed to the next listener that registers (see on()).
		// Without this, a click whose listener isn't yet/no-longer mounted is
		// silently swallowed — the prod "Get Started does nothing" symptom.
		if (ConnectionManager.REPLAYABLE_EVENTS.has(event as string)) {
			this.pendingEvents.set(event as string, payload);
			console.warn(
				`[ConnectionManager] '${event as string}' emitted with no listener — buffered for replay.`,
			);
		}
	}

	/**
	 * Register a typed handler for a shell event.
	 *
	 * @param event   - The event name from ShellConnectionEventMap.
	 * @param handler - Callback invoked when the event fires.
	 * @returns An unsubscribe function.
	 */
	public on<K extends keyof ShellConnectionEventMap>(
		event: K,
		handler: (payload: ShellConnectionEventMap[K]) => void,
	): () => void {
		const key = event as string;
		if (!this.listeners.has(key)) this.listeners.set(key, new Set());
		const set = this.listeners.get(key)!;
		set.add(handler as Handler);

		// Replay a buffered user-intent event to a fresh listener (see emit()).
		// Deferred to a microtask AND dispatched to the LIVE listener set at that
		// time — not the captured handler — because under React StrictMode
		// (mount→cleanup→mount) or any remount the registering handler may
		// unsubscribe before the microtask runs. The buffered payload is consumed
		// only once a live listener actually receives it, so the intent is never
		// lost to a dead handler.
		if (this.pendingEvents.has(key)) {
			Promise.resolve().then(() => {
				const live = this.listeners.get(key);
				if (!this.pendingEvents.has(key) || !live || live.size === 0) return;
				const payload = this.pendingEvents.get(key);
				this.pendingEvents.delete(key);
				for (const fn of live) {
					try {
						fn(payload);
					} catch (err) {
						console.error(`[ConnectionManager] Replay handler for '${key}' threw:`, err);
					}
				}
			});
		}

		// Warn if a single event has too many listeners — likely a leak
		if (set.size > 25) {
			console.warn(
				`[ConnectionManager] Possible listener leak: '${key}' has ${set.size} handlers. ` +
				'Make sure useEffect cleanup is calling the unsubscribe function.',
			);
		}

		return () => set.delete(handler as Handler);
	}

	/**
	 * Register a wildcard listener called for every emitted event.
	 * Used by the debug panel to display all events in real time.
	 *
	 * @param handler - Callback receiving the event name and payload.
	 * @returns An unsubscribe function.
	 */
	public onAny(handler: WildcardHandler): () => void {
		this.wildcardListeners.add(handler);
		return () => this.wildcardListeners.delete(handler);
	}

	// =========================================================================
	// DEBUG LOG
	// =========================================================================

	/** Returns a snapshot of the debug log (newest last). */
	public getDebugLog(): DebugLogEntry[] {
		return [...this.debugLog];
	}

	/** Clears all entries from the debug log. */
	public clearDebugLog(): void {
		this.debugLog.length = 0;
	}

	/** Append an entry to the debug log, evicting oldest if at capacity. */
	private logDebug(event: string, payload: unknown): void {
		if (this.debugLog.length >= DEBUG_LOG_MAX) this.debugLog.shift();
		this.debugLog.push({ timestamp: new Date().toISOString(), event, payload });

		// Notify wildcard listeners
		for (const fn of this.wildcardListeners) {
			try {
				fn(event, payload);
			} catch (err) {
				console.error('[ConnectionManager] Wildcard listener threw:', err);
			}
		}
	}

	// =========================================================================
	// CONNECTION STATUS (mirrors VSCode updateConnectionStatus pattern)
	// =========================================================================

	/** Update connection status and emit shell:statusChange. */
	private updateConnectionStatus(updates: Partial<ConnectionStatus>): void {
		Object.assign(this.connectionStatus, updates);

		// Latch failures across later transitions. The SDK's persist mode keeps
		// the state cycling through CONNECTING while it retries, and a
		// post-failure anonymous connect reports CONNECTED — either would erase
		// a purely state-driven failure before recovery UI could render it.
		// A network failure clears once a connection is re-established; an
		// auth failure persists until the user acts on it (sign-in navigates).
		if (
			updates.state === ConnectionState.CONNECTED &&
			this.connectionStatus.lastFailure?.kind === 'network'
		) {
			this.connectionStatus.lastFailure = undefined;
		}

		this.emit('shell:statusChange' as keyof ShellConnectionEventMap, this.connectionStatus as any);

		// Also emit statusMessage for simple UI consumers
		const message = this.connectionStatus.progressMessage ?? null;
		this.emit('shell:statusMessage', { message });
	}
}
