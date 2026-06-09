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

/**
 * ConnectionManager — centralized connection manager for the RocketRide VS Code
 * extension.
 *
 * Owns a single persistent RocketRideClient (created once, never destroyed
 * except at dispose). The SDK's persist mode handles all reconnection and
 * monitor resubscription automatically.
 *
 * Delegates backend lifecycle to a BaseManager subclass per mode:
 *   LocalManager  — install/start engine, connect client with retries
 *   RemoteManager — validate credentials, connect client
 *
 * Subclass pattern:
 *   DeployManager extends this class with its own singleton, overriding the
 *   getEffective*() config accessors to read deploy-specific settings
 *   (deployTargetMode, deployHostUrl, deployApiKey, etc.).  Both singletons
 *   coexist — one for the dev connection, one for the deploy connection.
 *
 * Members marked `protected` are intended for DeployManager overrides.
 * Members marked `private` are internal implementation details.
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { RocketRideClient, DAPMessage, TraceType, AuthenticationException } from 'rocketride';
import { ConfigManager, type ConnectionMode, type ConnectionGroup, type ConnectionGroupConfig } from '../config';
import { EngineRegistry, EngineManager, type EngineStatusEvent } from '../engine';
import { getUserConfigDir, getSystemInstallDir } from '../engine/config/config-migration';
import { getLogger, safeJSONStringify } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { ConnectionStatus, ConnectionState } from '../shared/types';
import { connectionModeRequiresApiKey, connectionModeUsesOAuth } from '../shared/util/connectionModeAuth';
import { getIdeName } from '../shared/util/ide';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';

export class ConnectionManager extends EventEmitter {
	private static instance: ConnectionManager;

	// Core connection components
	protected client!: RocketRideClient;
	protected engineRegistry?: EngineRegistry;
	/** URI provided by engine when ready. */
	protected engineUri?: string;
	/** The engine mode we're currently connected to (set on connect, cleared on disconnect). */
	protected connectedMode?: ConnectionMode;
	protected configManager = ConfigManager.getInstance();
	protected logger = getLogger();

	// Connection state tracking
	protected connectionStatus: ConnectionStatus = {
		state: ConnectionState.DISCONNECTED,
		connectionMode: 'local',
		hasCredentials: false,
		retryAttempt: 0,
		maxRetryAttempts: 120,
	};

	// Debounce timer for configuration changes
	private configChangeTimeout?: NodeJS.Timeout;
	private engineStatusHandler?: (event: EngineStatusEvent & { mode?: ConnectionMode }) => void;

	// Resource cleanup tracking
	protected disposables: vscode.Disposable[] = [];
	protected isDisposing: boolean = false;

	// Services list cache
	private cachedServices: Record<string, unknown> | null = null;
	private cachedServicesError: string | null = null;
	private servicesRefreshPromise: Promise<void> | null = null;

	/** Which settings group this connection reads from. */
	public readonly group: ConnectionGroup;

	protected constructor(group: ConnectionGroup = 'development') {
		super();
		this.group = group;
		this.client = this.createClient();
		this.setupConfigurationListener();
	}

	public static getInstance(): ConnectionManager {
		if (!ConnectionManager.instance) {
			ConnectionManager.instance = new ConnectionManager('development');
		}
		return ConnectionManager.instance;
	}

	/**
	 * Sets the shared engine registry. Called by extension activation.
	 */
	public setEngineRegistry(registry: EngineRegistry): void {
		this.engineRegistry = registry;
		// Listen for engine status events from any engine in the registry
		this.engineStatusHandler = (event: EngineStatusEvent & { mode?: ConnectionMode }) => {
			this.handleEngineStatus(event);
		};
		this.engineRegistry.on('status', this.engineStatusHandler);
	}


	/**
	 * Tears down and disconnects. Called on extension deactivation.
	 */
	public async stop(): Promise<void> {
		await this.disconnect();
		// Registry disposal is handled by extension.ts, not here
	}

	/** Returns the engine registry. */
	public getEngineRegistry(): EngineRegistry | undefined {
		return this.engineRegistry;
	}

	/**
	 * Whether this manager should react to engine status events.
	 * Overridden by DeployManager to return false in shared mode.
	 */
	protected shouldHandleEngineStatus(): boolean {
		return true;
	}

	/**
	 * Handles status events from EngineManager.
	 * When engine is 'ready', initiates WebSocket connection.
	 * When engine errors or goes idle, updates connection status.
	 */
	private handleEngineStatus(event: EngineStatusEvent & { mode?: ConnectionMode }): void {
		if (this.isDisposing) return;
		if (!this.shouldHandleEngineStatus()) return;

		switch (event.phase) {
			case 'working': {
				// Show engine progress (downloading, extracting, starting) in connection status.
				// Only for events targeting this CM's configured mode.
				const targetMode = this.getGroupConfig().connectionMode
					?? this.configManager.getConfig().development.connectionMode
					?? 'local';
				if (event.mode === targetMode) {
					this.updateConnectionStatus({
						state: ConnectionState.CONNECTING,
						progressMessage: event.message,
						progressLogLine: event.logLine,
					});
				}
				break;
			}

			case 'idle':
			case 'error':
				// Only act if this event is for the engine we're currently connected to.
				// Ignore events from other modes (e.g., docker event while connected to local).
				if (!this.connectedMode || event.mode !== this.connectedMode) return;

				this.connectedMode = undefined;
				this.engineUri = undefined;
				if (this.client?.isConnected()) {
					this.client.disconnect().catch(() => { /* best effort */ });
				}
				if (event.phase === 'error') {
					this.updateConnectionStatus({
						state: ConnectionState.DISCONNECTED,
						lastError: event.error ?? event.message,
						progressLogLine: undefined,
					});
				} else {
					this.updateConnectionStatus({
						state: ConnectionState.DISCONNECTED,
						progressLogLine: undefined,
					});
				}
				break;

			case 'ready': {
				// Only connect if this 'ready' event is for the engine mode we're
				// configured to use. The registry may manage multiple engines but
				// each CM only cares about its own group's active mode.
				const rawMode = this.getGroupConfig().connectionMode;
				const effectiveMode = rawMode
					?? this.configManager.getConfig().development.connectionMode
					?? 'local';

				if (event.mode !== effectiveMode) return;
				if (!event.uri) return;

				// Already connected to this URI — no-op
				if (this.engineUri === event.uri && this.client?.isConnected()) return;

				this.connectedMode = event.mode;
				this.engineUri = event.uri;
				this.connectToEngine(event.uri).catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.output(`${icons.error} Failed to connect to engine: ${msg}`);
					this.connectedMode = undefined;
					this.updateConnectionStatus({
						state: ConnectionState.DISCONNECTED,
						lastError: msg,
					});
				});
				break;
			}
		}
	}

	/**
	 * Connects the WebSocket client to the engine at the given URI.
	 *
	 * Auth resolution strategy (in priority order):
	 *   1. Cloud mode -> OAuth token from CloudAuthProvider
	 *   2. On-prem mode -> API key from secure storage
	 *   3. Local/docker/service -> default key (self-hosted, no real auth)
	 *
	 * @param uri - The WebSocket URI to connect to (from EngineManager 'ready' event).
	 * @throws If cloud mode and no token is available (user must sign in).
	 */
	private async connectToEngine(uri: string): Promise<void> {
		this.updateConnectionStatus({ state: ConnectionState.CONNECTING, progressMessage: 'Connecting...' });

		const groupConfig = this.getGroupConfig();
		const mode = groupConfig.connectionMode ?? 'local';

		// Resolve auth credential — each mode has different auth requirements
		let auth: string;
		if (connectionModeUsesOAuth(mode)) {
			const cloudAuth = CloudAuthProvider.getInstance();
			const token = await cloudAuth.getToken();
			if (!token) throw new Error('Please sign in to RocketRide Cloud to connect.');
			auth = token;
		} else if (connectionModeRequiresApiKey(mode) && groupConfig.apiKey) {
			auth = groupConfig.apiKey;
		} else {
			// Local, service, docker: use default key
			auth = groupConfig.apiKey || 'MYAPIKEY';
		}

		await this.client.connect(auth, { uri });
		// onConnected callback in createClient() handles state update
	}

	// =========================================================================
	// CONFIGURATION
	// =========================================================================

	protected setupConfigurationListener(): void {
		const disposable = this.configManager.onConfigurationChanged((_config) => {
			if (this.isDisposing) {
				return;
			}

			// Debounce: handles direct settings.json edits or individual
			// config changes from outside the Settings UI.
			if (this.configChangeTimeout) {
				clearTimeout(this.configChangeTimeout);
			}
			this.configChangeTimeout = setTimeout(() => {
				this.configChangeTimeout = undefined;
				this.handleConfigurationChanged();
			}, 300);
		});

		this.disposables.push(disposable);
	}

	protected async handleConfigurationChanged(): Promise<void> {
		if (this.isDisposing) {
			return;
		}

		this.logger.output(`${icons.info} Configuration changed, reconnecting...`);
		await this.updateCredentialsStatus();

		// Full cycle: disconnect old manager → validate config → reconcile
		await this.disconnect();
		await this.initialize();

		// Ask the registry to reconcile — for config-only changes (e.g.,
		// rotating credentials) the engine may already be 'ready' and will
		// re-emit its status, triggering handleEngineStatus → connectToEngine.
		if (this.engineRegistry) {
			await this.engineRegistry.reconcile();
		}
	}

	/**
	 * Cancels any pending debounced config-change handler.
	 *
	 * Called by SettingsProvider and WelcomeProvider after applyAllSettings()
	 * but before reconcile, so the debounced handler (which fires from the
	 * welcomeDismissed write) doesn't race with the reconciler's engine
	 * restart and CM reconnection sequence.
	 */
	public cancelPendingConfigChange(): void {
		if (this.configChangeTimeout) {
			clearTimeout(this.configChangeTimeout);
			this.configChangeTimeout = undefined;
		}
	}

	// =========================================================================
	// CONFIG ACCESSORS (reads from this.group — no overrides needed)
	// =========================================================================

	/** Returns the per-group config for this connection. */
	public getGroupConfig(): ConnectionGroupConfig {
		return this.configManager.getConfig()[this.group];
	}

	/** Returns the connection mode for this connection's group. */
	public getConnectionMode(): ConnectionMode | null {
		return this.getGroupConfig().connectionMode;
	}

	/** Returns the host URL for this connection's group. */
	public getHostUrl(): string {
		return this.getGroupConfig().hostUrl;
	}

	/** Returns the API key for this connection's group. */
	public getApiKey(): string {
		return this.getGroupConfig().apiKey;
	}

	// =========================================================================
	// INITIALIZATION
	// =========================================================================

	/**
	 * Validates config and updates credential status.
	 * Does NOT start engines or connect — the EngineRegistry reconciler
	 * handles engine lifecycle, and handleEngineStatus() connects the
	 * WebSocket when an engine emits 'ready'.
	 */
	public async initialize(): Promise<void> {
		if (this.isDisposing) return;

		await this.updateCredentialsStatus();

		const errors = this.configManager.validateGroupConfig(this.group);
		if (errors.length > 0) {
			this.logger.output(`${icons.error} Configuration errors: ${errors.join(', ')}`);
			this.updateConnectionStatus({
				state: ConnectionState.DISCONNECTED,
				lastError: errors.join(', '),
			});
			return;
		}

		this.updateConnectionStatus({
			connectionMode: this.getConnectionMode() ?? 'local',
		});
	}

	// =========================================================================
	// CLIENT (created once, lives forever, persist: true)
	// =========================================================================

	protected createClient(): RocketRideClient {
		const client = new RocketRideClient({
			persist: true,
			module: 'CONN-EXT',
			clientName: getIdeName(),
			clientVersion: vscode.extensions.getExtension('rocketride.rocketride')?.packageJSON?.version,
			onTrace: (traceType: number, message: any) => {
				if (traceType === TraceType.Request) {
					this.logger.output(`${icons.send} ${message.command} ${safeJSONStringify(message.arguments ?? {})}`);
				} else if (traceType === TraceType.Success) {
					this.logger.output(`${icons.receive} ${message.command} ${safeJSONStringify(message.body ?? {})}`);
				} else {
					this.logger.output(`${icons.error} ${message.command} ${message.message ?? 'failed'}`);
				}
			},
			onEvent: async (message: DAPMessage) => {
				if (message.event === 'output') {
					const body = message.body;
					if (body?.output) {
						const text = String(body.output).trimEnd();
						if (text) {
							const source = body.__id ? `[${body.__id}] ` : '';
							this.logger.console(`    ${source}${text}`);
						}
					}
				} else if (message.event?.startsWith('apaevt_')) {
					this.logger.output(`${icons.info} ${message.event}: ${safeJSONStringify(message.body)}`);
				}

				// Transform apaext_account into a dedicated shell:accountUpdate
				// event — don't also emit it as a generic shell:event to avoid
				// duplicate handling downstream
				if (message.event === 'apaext_account' && message.body) {
					this.emit('shell:accountUpdate', message.body);
					return;
				}

				this.emit('shell:event', message);
			},
			onConnected: async () => {
				this.updateConnectionStatus({
					state: ConnectionState.CONNECTED,
					lastConnected: new Date(),
					lastError: undefined,
					retryAttempt: 0,
					progressMessage: undefined,
					progressLogLine: undefined,
				});
				this.logger.output(`${icons.success} Connected to RocketRide server`);
				this.emit('shell:connected');

				// Fetch and cache services list
				this.refreshServices().catch((err) => {
					this.logger.error(`Failed to fetch services on connect: ${err}`);
				});
			},
			onDisconnected: async (reason?: string, hasError?: boolean) => {
				this.logger.output(`${icons.warning} WebSocket disconnected (reason: ${reason ?? 'unknown'}, error: ${hasError ?? false})`);
				this.clearServicesCache();
				// Don't overwrite AUTH_FAILED — the user needs to see the sign-in prompt,
				// not a misleading "Connecting..." spinner.
				if (this.connectionStatus.state !== ConnectionState.AUTH_FAILED) {
					this.updateConnectionStatus({ state: ConnectionState.CONNECTING });
				}
				this.emit('shell:disconnected');
			},
			onConnectError: async (error: Error) => {
				// Auth rejection: stop retrying, clear stale credentials, and
				// open the auth page so the user can fix them.
				if (error instanceof AuthenticationException) {
					this.logger.output(`${icons.error} Authentication failed: ${error.message}`);
					const mode = this.connectionStatus.connectionMode;

					// Stop the client's auto-reconnect loop so it doesn't keep
					// retrying with stale credentials. The reconcile path will
					// call connectToEngine() with fresh credentials after the
					// user fixes them in Settings and saves.
					this.client.disconnect().catch(() => { /* best effort */ });

					// Only clear the cloud token — on-prem/docker/service keys
					// live in config, not SecretStorage.
					if (connectionModeUsesOAuth(mode)) {
						await CloudAuthProvider.getInstance().signOut();
					}

					this.updateConnectionStatus({
						state: ConnectionState.AUTH_FAILED,
						lastError: error.message,
						progressMessage: undefined,
						progressLogLine: undefined,
					});

					// Open the settings page focused on the failing group so the user can fix credentials
					vscode.commands.executeCommand('rocketride.page.settings.open', this.group, error.message);
					return;
				}
				this.logger.output(`${icons.info} Reconnect attempt failed: ${error.message}`);
				this.updateConnectionStatus({
					progressMessage: 'Reconnecting...',
				});
			},
		});

		return client;
	}

	// =========================================================================
	// CONNECT / DISCONNECT
	// =========================================================================

	/**
	 * Connects the WebSocket to the engine if a URI is available.
	 * Does NOT start engines — that's the EngineRegistry's responsibility.
	 * If no engine URI is set, this is a no-op; handleEngineStatus() will
	 * call connectToEngine() automatically when it receives a 'ready' event.
	 */
	public async connect(): Promise<void> {
		if (this.engineUri && !this.client?.isConnected()) {
			await this.connectToEngine(this.engineUri);
		}
	}

	/**
	 * Disconnects the WebSocket client. Does NOT stop engines.
	 * Does NOT clear the engine URI — the engine is still running,
	 * so connect() or handleEngineStatus() can reconnect to it.
	 */
	public async disconnect(): Promise<void> {
		this.logger.output(`${icons.warning} Disconnecting WebSocket...`);

		if (this.client?.isConnected()) {
			await this.client.disconnect();
		}

		this.clearServicesCache();

		this.updateConnectionStatus({
			state: ConnectionState.DISCONNECTED,
			progressMessage: undefined,
			progressLogLine: undefined,
		});
	}

	// =========================================================================
	// STATIC ENGINE STATUS — queries state without needing a connection
	// =========================================================================

	/**
	 * Queries the actual state of the specified engine mode.
	 * Static — no instance or active connection needed. Directly checks
	 * the OS service manager, Docker daemon, filesystem, or probes a remote server.
	 *
	 * @param mode - Which engine mode to query.
	 * @param hostUrl - Host URL for cloud/onprem probe (optional).
	 */
	static async getEngineStatus(mode: ConnectionMode, hostUrl?: string): Promise<import('../engine/engine-backend').EngineBackendStatus> {
		return EngineManager.getEngineStatus(mode, {
			localParentDir: getUserConfigDir(),
			serviceInstallDir: getSystemInstallDir(),
		}, hostUrl);
	}

	// Engine lifecycle operations (install, start, stop, remove) are managed
	// by the EngineRegistry directly — ConnectionManager doesn't start or stop
	// engines. It only connects/disconnects the WebSocket when the registry
	// emits 'ready' or 'idle' events.

	// =========================================================================
	// PUBLIC ACCESSORS
	// =========================================================================

	public getClient(): RocketRideClient | undefined {
		return this.client;
	}

	public isConnected(): boolean {
		return this.connectionStatus.state === 'connected' && this.client?.isConnected() === true;
	}

	public isConnecting(): boolean {
		return this.connectionStatus.state === 'starting-engine' || this.connectionStatus.state === 'connecting';
	}

	public isDisconnected(): boolean {
		return this.connectionStatus.state === ConnectionState.DISCONNECTED || this.connectionStatus.state === ConnectionState.ENGINE_STARTUP_FAILED;
	}

	public hasCredentials(): boolean {
		return this.connectionStatus.hasCredentials;
	}

	public getConnectionStatus(): ConnectionStatus {
		return { ...this.connectionStatus };
	}

	/**
	 * Returns the HTTP/HTTPS URL for this connection's server.
	 * Local mode uses the actual engine port; remote modes derive
	 * the URL from the group's configured hostUrl.
	 */
	/**
	 * Returns the HTTP/HTTPS URL for this connection's server.
	 * Uses the engine URI provided by EngineManager when available,
	 * otherwise derives from the group's configured hostUrl.
	 */
	public getHttpUrl(): string {
		if (this.engineUri) {
			const normalized = RocketRideClient.normalizeUri(this.engineUri);
			const url = new URL(normalized);
			const httpProtocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
			return `${httpProtocol}//${url.hostname}:${url.port || (httpProtocol === 'https:' ? '443' : '80')}`;
		}
		const hostUrl = this.getGroupConfig().hostUrl;
		if (!hostUrl) return 'http://localhost:5565';
		const url = new URL(RocketRideClient.normalizeUri(hostUrl));
		const port = url.port || (url.protocol === 'https:' ? '443' : '80');
		return `${url.protocol}//${url.hostname}:${port}`;
	}

	/**
	 * Returns the WebSocket URL for this connection's DAP service.
	 * Derives from the engine URI or the group's configured hostUrl.
	 */
	public getWebSocketUrl(): string {
		if (this.engineUri) {
			const url = new URL(this.engineUri);
			const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
			const port = url.port || (url.protocol === 'https:' ? '443' : '80');
			return `${wsProtocol}//${url.hostname}:${port}/task/service`;
		}
		const hostUrl = this.getGroupConfig().hostUrl;
		if (!hostUrl) return 'ws://localhost:5565/task/service';
		const url = new URL(RocketRideClient.normalizeUri(hostUrl));
		const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const port = url.port || (url.protocol === 'https:' ? '443' : '80');
		return `${wsProtocol}//${url.hostname}:${port}/task/service`;
	}

	/** Returns engine version info from the EngineManager, or null. */
	/** Returns engine version info for the current connection mode. */
	public getEngineInfo(): { version: string | null; publishedAt: string | null } {
		const mode = this.getGroupConfig().connectionMode ?? 'local';
		const engine = this.engineRegistry?.getEngine(mode);
		const info = engine?.getInfo();
		return {
			version: info?.version ?? null,
			publishedAt: info?.publishedAt ?? null,
		};
	}

	// =========================================================================
	// SERVICES CACHE
	// =========================================================================

	public getCachedServices(): { services: Record<string, unknown>; servicesError?: string } {
		if (!this.isConnected()) {
			return { services: {}, servicesError: 'Not connected' };
		}
		if (this.cachedServicesError) {
			return { services: this.cachedServices ?? {}, servicesError: this.cachedServicesError };
		}
		return { services: this.cachedServices ?? {} };
	}

	public async refreshServices(): Promise<void> {
		if (!this.isConnected() || !this.client) {
			this.clearServicesCache();
			this.emit('shell:servicesUpdated', { services: {}, servicesError: 'Not connected' });
			return;
		}

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

	protected clearServicesCache(): void {
		this.cachedServices = null;
		this.cachedServicesError = null;
		this.servicesRefreshPromise = null;
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	protected updateConnectionStatus(updates: Partial<ConnectionStatus>): void {
		if (this.isDisposing) {
			return;
		}
		Object.assign(this.connectionStatus, updates);
		this.emit('shell:statusChange', this.connectionStatus);

		// Also emit the simple status message for UI consumers that don't
		// need the full ConnectionStatus object
		const message = this.connectionStatus.progressMessage ?? null;
		this.emit('shell:statusMessage', { message });
	}

	protected async updateCredentialsStatus(): Promise<void> {
		if (this.isDisposing) {
			return;
		}
		const gc = this.getGroupConfig();
		const mode = gc.connectionMode ?? 'local';
		let hasCredentials: boolean;

		if (connectionModeUsesOAuth(mode)) {
			// Cloud mode: check if we have a stored cloud token
			hasCredentials = await CloudAuthProvider.getInstance().isSignedIn();
		} else if (connectionModeRequiresApiKey(mode)) {
			// On-prem: need both API key and host URL
			hasCredentials = !!(gc.apiKey && gc.hostUrl);
		} else if (mode === 'onprem') {
			// On-prem without required key: just need host URL
			hasCredentials = !!gc.hostUrl;
		} else {
			// Docker, service, local: always have credentials
			hasCredentials = true;
		}

		this.updateConnectionStatus({ hasCredentials });
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public async dispose(): Promise<void> {
		this.isDisposing = true;

		if (this.configChangeTimeout) {
			clearTimeout(this.configChangeTimeout);
			this.configChangeTimeout = undefined;
		}

		if (this.engineRegistry && this.engineStatusHandler) {
			this.engineRegistry.removeListener('status', this.engineStatusHandler);
			this.engineStatusHandler = undefined;
		}

		if (this.client?.isConnected()) {
			await this.client.disconnect();
		}
		if (this.engineRegistry) {
			await this.engineRegistry.disposeAll();
		}
		this.clearServicesCache();

		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		this.configManager.dispose();
		this.removeAllListeners();
	}
}

// =============================================================================
// CLOUD CONNECTION HELPER
// =============================================================================

/**
 * Returns whichever connection (dev or deploy) is in cloud mode and connected.
 * Used for account/billing operations where either cloud connection works.
 */
export function getCloudConnection(): ConnectionManager | undefined {
	// Import lazily to avoid circular dependency
	const { DeployManager } = require('./deploy-manager');
	const dev = ConnectionManager.getInstance();
	if (dev.getConnectionMode() === 'cloud' && dev.isConnected()) return dev;
	const deploy = DeployManager.getDeployInstance();
	if (!deploy.isSharedMode() && deploy.getConnectionMode() === 'cloud' && deploy.isConnected()) return deploy;
	return undefined;
}

/**
 * Returns true if at least one connection is in cloud mode and connected.
 */
export function isCloudConnected(): boolean {
	return getCloudConnection() !== undefined;
}
