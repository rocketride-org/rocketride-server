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
// CONNECTION MANAGER — class-based singleton for shell-ui (browser)
// =============================================================================
//
// Mirrors the VSCode extension's ConnectionManager class pattern:
//   - Singleton via static getInstance()
//   - Typed event bus (emit/on) with debug log and wildcard listeners
//   - Delegates connection backend to RemoteManager (BaseManager subclass)
//   - Promise-based concurrency guards (connectPromise/disconnectPromise)
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

import { RocketRideClient, ConnectResult } from 'rocketride';
import type { ShellConnectionEventMap, IConnectionManager, IAuthProvider } from 'shared';
import { ConnectionState, ConnectionStatus } from 'shared';
import type { ConnectionMode } from 'shared';
import { BaseManager } from './base-manager';
import { RemoteManager } from './remote-manager';
import { getStoredVerifier, clearStoredVerifier } from '../util/pkce';
import {
	LS_TOKEN,
	SS_APP_ID,
	SS_PENDING_APP_ID,
	DEBUG_LOG_MAX,
	DEFAULT_CLIENT_NAME,
	DEFAULT_WORKSPACE_DIR,
	MAX_RETRY_ATTEMPTS,
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

// =============================================================================
// CONNECTION MANAGER CLASS
// =============================================================================

/**
 * Centralized connection manager for shell-ui.
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
 * import { ConnectionManager } from 'shell-ui';
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
	 * a duplicated copy of the shell-ui module gets its own class object with its
	 * own static field, so its emit() lands on a different instance than the one
	 * the Shell host registered listeners on — events vanish silently. Anchoring
	 * the instance on globalThis makes getInstance() return the same object
	 * regardless of how many module copies exist in the page.
	 */
	private static readonly GLOBAL_KEY = Symbol.for('rocketride.connectionManager');

	/** Returns the singleton ConnectionManager instance. */
	public static getInstance(): ConnectionManager {
		const g = globalThis as unknown as Record<symbol, ConnectionManager | undefined>;
		if (!g[ConnectionManager.GLOBAL_KEY]) {
			g[ConnectionManager.GLOBAL_KEY] = new ConnectionManager();
		}
		return g[ConnectionManager.GLOBAL_KEY]!;
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

	/** In-flight connect guard — prevents concurrent connect() calls. */
	private connectPromise: Promise<ConnectResult | null> | undefined;

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
	private cachedServicesError: string | null = null;
	private servicesRefreshPromise: Promise<void> | null = null;

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
			env: options?.env,

			// Fired for every push event received from the server over WebSocket
			onEvent: async (message) => {
				// Transform apaext_account into shell:accountUpdate to avoid
				// duplicate handling downstream
				if (message.event === 'apaext_account' && message.body) {
					this.emit('shell:accountUpdate', message.body as ConnectResult);
					return;
				}
				// Broadcast all other server events
				this.emit('shell:event', { event: message });
			},

			// Fired once the WebSocket handshake completes and auth succeeds
			onConnected: async () => {
				this.updateConnectionStatus({
					state: ConnectionState.CONNECTED,
					lastConnected: new Date(),
					lastError: undefined,
					retryAttempt: 0,
					progressMessage: undefined,
				});
				this.emit('shell:connected', {});
				this.emit('shell:statusMessage', { message: null });

				// Fetch and cache services list on connect
				this.refreshServices().catch((err) => {
					console.error('[ConnectionManager] Failed to refresh services on connect:', err);
				});
			},

			// Fired when the WebSocket closes for any reason
			onDisconnected: async (reason, hasError) => {
				this.clearServicesCache();
				// Don't overwrite AUTH_FAILED state
				if (this.connectionStatus.state !== ConnectionState.AUTH_FAILED) {
					this.updateConnectionStatus({ state: ConnectionState.CONNECTING });
				}
				this.emit('shell:disconnected', { reason: reason ?? 'unknown', hasError: hasError ?? false });
			},

			// Fired on each failed connection attempt before SDK retries
			onConnectError: () => {
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
		this._attachPromise = this.client.attach().catch((err) => {
			console.error('[ConnectionManager] Failed to attach:', err);
		});

		// When the user presses Back from Zitadel, the browser restores this page
		// from the back/forward cache — the singleton (and its `oauthStarted`
		// one-shot guard) is frozen and restored as-is, so a fresh "Get Started"
		// click would hit the guard and do nothing. Release it on bfcache restore
		// so the button works again without a manual page refresh.
		if (typeof window !== 'undefined') {
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
	 * @param register - If true, requests Zitadel's sign-up form (prompt=create)
	 *                   instead of the default sign-in form.
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

		// Ensure the transport is attached before any login attempt
		await this._attachPromise;

		const params = new URLSearchParams(window.location.search);
		const code = params.get('code');
		const sessionAppId = this.getSessionAppId();

		// ── OAuth callback — exchange authorization code for a session ────
		if (code) {
			const verifier = getStoredVerifier();
			clearStoredVerifier();
			// Strip the ?code= from the URL so refreshes don't re-exchange
			window.history.replaceState({}, '', window.location.pathname);

			if (!verifier) {
				// Missing verifier — can't exchange this code. This is the
				// back-button case: now that we use assign(), the auth chain
				// stays in history, so a stale ?code entry can be revisited.
				// Prefer the stored token over bouncing into another round-trip.
				const staleToken = this.loadToken();
				if (staleToken) {
					try {
						const result = await this.client.login(staleToken);
						return await this.finishConnect(result, sessionAppId, config);
					} catch {
						this.clearToken();
					}
				}
				// No usable token — restart auth only for session-locked apps.
				if (sessionAppId) { await this.startOAuth(); return null; }
				return null;
			}

			const result = await this.client.login({ code, verifier, redirectUri: window.location.origin });
			return await this.finishConnect(result, sessionAppId, config);
		}

		// ── Session-locked app — reconnect with stored token ─────────────
		if (sessionAppId) {
			const token = this.loadToken();
			if (token) {
				try {
					const result = await this.client.login(token);
					return await this.finishConnect(result, sessionAppId, config);
				} catch {
					// Token expired or invalid — clear and restart OAuth
					this.clearToken();
					await this.startOAuth();
					return null;
				}
			}
			// No token — redirect to OAuth
			await this.startOAuth();
			return null;
		}

		// ── Home flow (no session lock) — try token with timeout ─────────
		const token = this.loadToken();
		if (token) {
			try {
				const result = await Promise.race([
					this.client.login(token),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('timeout')), 8000),
					),
				]);
				return await this.finishConnect(result, '', config);
			} catch (err) {
				// Connect failed — clear stale token
				this.clearToken();
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
	): Promise<{ result: ConnectResult; appId: string }> {
		// Persist the token for future page loads
		if (result.userToken) this.saveToken(result.userToken);

		// Cache the account info
		this.accountInfo = result;

		// Publish identity to all listeners
		this.emit('shell:login', { user: result });

		// Restore saved theme from workspace file
		if (config?.onThemeChange) {
			try {
				const dir = config.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
				const global = await this.client!.fsReadJson<{ shellPrefs?: { theme?: string } }>(`${dir}/global.json`);
				if (global?.shellPrefs?.theme) config.onThemeChange(global.shellPrefs.theme);
			} catch { /* theme read failed — not critical */ }
		}

		// Resolve the target app — check pending app ID from OAuth flow
		const pendingAppId = this.getPendingAppId();
		const resolvedAppId = appId || pendingAppId;

		// Notify the workspace to switch to the target app
		if (resolvedAppId) {
			this.emit('shell:switchApp', { appId: resolvedAppId });
		}

		return { result, appId: resolvedAppId };
	}

	// =========================================================================
	// CONNECT / DISCONNECT (mirrors VSCode pattern)
	// =========================================================================

	/**
	 * Connect to the server using the provided credential.
	 *
	 * Deduplicates concurrent calls — if a connect is already in flight,
	 * returns the same promise (same pattern as VSCode's connectPromise).
	 *
	 * @param credential - Token string or PKCE exchange object.
	 * @returns The ConnectResult on success, or null if deduplicated.
	 */
	public connect(credential?: unknown): Promise<ConnectResult | null> {
		// Deduplicate: if a connect is already in flight, return the same promise
		if (this.connectPromise) {
			return this.connectPromise;
		}

		const promise = this._connect(credential).finally(() => {
			// Only clear if we're still the active promise
			if (this.connectPromise === promise) {
				this.connectPromise = undefined;
			}
		});
		this.connectPromise = promise;
		return promise;
	}

	/**
	 * Internal connect implementation.
	 */
	private async _connect(credential?: unknown): Promise<ConnectResult | null> {
		if (!this.client) {
			throw new Error('Client not initialized — call initialize() first.');
		}

		if (!credential) {
			throw new Error('No credential provided for connection.');
		}

		this.updateConnectionStatus({
			state: ConnectionState.CONNECTING,
			lastError: undefined,
		});

		try {
			// Create manager if needed (same pattern as VSCode)
			if (!this.manager) {
				this.manager = new RemoteManager();
			}

			// Delegate connection to the manager (handles timeout internally)
			await this.manager.connect(this.client, {
				uri: this.serverUri,
				credential: credential as string | { code: string; verifier: string; redirectUri: string },
			});

			// Get the connect result from the client
			const result = this.client.getAccountInfo() as ConnectResult;
			this.accountInfo = result;

			// Persist token
			if (result.userToken) {
				this.saveToken(result.userToken);
			}

			// Emit login event
			this.emit('shell:login', { user: result });

			return result;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			// Determine if this is an auth failure vs network failure
			const isAuthError = errorMessage.includes('Authentication failed') ||
				errorMessage.includes('unknown user') ||
				errorMessage.includes('invalid credentials');

			this.updateConnectionStatus({
				state: isAuthError ? ConnectionState.AUTH_FAILED : ConnectionState.FAILED,
				lastError: errorMessage,
				progressMessage: undefined,
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
		// Clear in-flight connect guard
		this.connectPromise = undefined;

		if (this.manager && this.client) {
			await this.manager.disconnect(this.client);
			this.manager = null;
		}

		this.clearServicesCache();
		this.updateConnectionStatus({
			state: ConnectionState.DISCONNECTED,
			progressMessage: undefined,
		});
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

	/**
	 * Logout: clear auth state, disconnect, and emit shell:logout.
	 */
	public async logout(): Promise<void> {
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

	/** Persist a user token to sessionStorage. */
	public saveToken(token: string): void {
		try { sessionStorage.setItem(LS_TOKEN, token); } catch (e) {
			console.error('[ConnectionManager] Failed to save token:', e);
		}
	}

	/** Load token from sessionStorage. Returns empty string if unavailable. */
	public loadToken(): string {
		try { return sessionStorage.getItem(LS_TOKEN) ?? ''; } catch { return ''; }
	}

	/** Clear the persisted token. */
	public clearToken(): void {
		try { sessionStorage.removeItem(LS_TOKEN); } catch (e) {
			console.error('[ConnectionManager] Failed to clear token:', e);
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
	 */
	public getCachedServices(): { services: Record<string, unknown>; servicesError?: string } {
		if (!this.isConnected()) {
			return { services: {}, servicesError: 'Not connected' };
		}
		// Lazy fetch on first access
		if (this.cachedServices === null && !this.cachedServicesError && !this.servicesRefreshPromise) {
			this.refreshServices();
		}
		if (this.cachedServicesError) {
			return { services: this.cachedServices ?? {}, servicesError: this.cachedServicesError };
		}
		return { services: this.cachedServices ?? {} };
	}

	/**
	 * Fetches the service catalog from the server and updates the cache.
	 * Deduplicates concurrent calls.
	 */
	public async refreshServices(): Promise<void> {
		if (!this.isConnected() || !this.client) {
			this.clearServicesCache();
			this.emit('shell:servicesUpdated', { services: {}, servicesError: 'Not connected' });
			return;
		}

		// Deduplicate concurrent calls
		if (this.servicesRefreshPromise) {
			return this.servicesRefreshPromise;
		}

		this.servicesRefreshPromise = (async () => {
			try {
				const body = await this.client!.getServices();
				const services: Record<string, unknown> = body.services ?? {};
				this.cachedServices = services;
				this.cachedServicesError = null;
				this.emit('shell:servicesUpdated', { services, servicesError: undefined });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				this.cachedServices = null;
				this.cachedServicesError = msg;
				this.emit('shell:servicesUpdated', { services: {}, servicesError: msg });
			} finally {
				this.servicesRefreshPromise = null;
			}
		})();

		return this.servicesRefreshPromise;
	}

	/** Clear all services cache state. */
	private clearServicesCache(): void {
		this.cachedServices = null;
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
		this.emit('shell:statusChange' as keyof ShellConnectionEventMap, this.connectionStatus as any);

		// Also emit statusMessage for simple UI consumers
		const message = this.connectionStatus.progressMessage ?? null;
		this.emit('shell:statusMessage', { message });
	}
}
