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
 * connection.ts - Centralized Connection Manager for RocketRide VS Code Extension
 *
 * Owns a single persistent RocketRideClient (created once, never destroyed
 * except at dispose). The SDK's persist mode handles all reconnection and
 * monitor resubscription automatically.
 *
 * Delegates backend lifecycle to a BaseManager subclass per mode:
 *   LocalManager  — install/start engine, connect client with retries
 *   RemoteManager — validate credentials, connect client
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { RocketRideClient, DAPMessage } from 'rocketride';
import { ConfigManager } from '../config';
import { BaseManager } from './base-manager';
import { LocalManager } from './local-manager';
import { RemoteManager } from './remote-manager';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { ConnectionStatus, ConnectionState } from '../shared/types';
import { connectionModeRequiresApiKey, connectionModeUsesOAuth } from '../shared/util/connectionModeAuth';
import { getIdeName } from '../shared/util/ide';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';

export class ConnectionManager extends EventEmitter {
	private static instance: ConnectionManager;

	// Core connection components — client is created once, manager is swapped on mode change
	private client!: RocketRideClient;
	private manager?: BaseManager;
	private enginesRoot?: string;
	private configManager = ConfigManager.getInstance();
	private logger = getLogger();

	// Connection state tracking
	private connectionStatus: ConnectionStatus = {
		state: ConnectionState.DISCONNECTED,
		connectionMode: 'local',
		hasCredentials: false,
		retryAttempt: 0,
		maxRetryAttempts: 120,
	};

	// Debounce timer for configuration changes
	private configChangeTimeout?: NodeJS.Timeout;

	// Engine install cancellation
	private engineCts?: vscode.CancellationTokenSource;

	// In-flight connect guard — prevents concurrent connect() calls
	private connectPromise?: Promise<void>;

	// Resource cleanup tracking
	private disposables: vscode.Disposable[] = [];
	private isDisposing: boolean = false;

	// Services list cache
	private cachedServices: Record<string, unknown> | null = null;
	private cachedServicesError: string | null = null;
	private servicesRefreshPromise: Promise<void> | null = null;

	private constructor() {
		super();
		this.client = this.createClient();
		this.setupConfigurationListener();
	}

	public static getInstance(): ConnectionManager {
		if (!ConnectionManager.instance) {
			ConnectionManager.instance = new ConnectionManager();
		}
		return ConnectionManager.instance;
	}

	public setEnginesRoot(enginesRoot: string): void {
		this.enginesRoot = enginesRoot;
	}

	// =========================================================================
	// CONFIGURATION
	// =========================================================================

	private setupConfigurationListener(): void {
		this.disposables.push(
			this.configManager.onEnvVarsChanged((env) => {
				this.client?.setEnv(env);
			})
		);

		const disposable = this.configManager.onConfigurationChanged((_config) => {
			if (this.isDisposing) {
				return;
			}

			// Debounce: the settings page saves each setting individually
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

	private async handleConfigurationChanged(): Promise<void> {
		if (this.isDisposing) {
			return;
		}

		this.logger.output(`${icons.info} Configuration changed, reconnecting...`);
		await this.updateCredentialsStatus();

		// Full cycle: disconnect old manager → create new for new mode → connect
		await this.disconnect();
		await this.initialize();
	}

	// =========================================================================
	// INITIALIZATION
	// =========================================================================

	public async initialize(): Promise<void> {
		if (this.isDisposing) {
			return;
		}

		await this.updateCredentialsStatus();

		const config = this.configManager.getConfig();
		const errors = this.configManager.validateConfig();

		if (errors.length > 0) {
			this.logger.output(`${icons.error} Configuration errors: ${errors.join(', ')}`);
			this.updateConnectionStatus({
				state: ConnectionState.DISCONNECTED,
				lastError: errors.join(', '),
			});
			return;
		}

		this.updateConnectionStatus({
			connectionMode: config.connectionMode,
		});

		if (config.autoConnect && this.connectionStatus.hasCredentials) {
			await this.connect();
		}
	}

	// =========================================================================
	// CLIENT (created once, lives forever, persist: true)
	// =========================================================================

	private createClient(): RocketRideClient {
		const client = new RocketRideClient({
			persist: true,
			env: this.configManager.getEnv(),
			module: 'CONN-EXT',
			clientName: getIdeName(),
			clientVersion: vscode.extensions.getExtension('rocketride.rocketride')?.packageJSON?.version,
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
					this.logger.output(`${icons.info} ${message.event}: ${JSON.stringify(message.body)}`);
				}
				this.emit('event', message);
			},
			onConnected: async () => {
				this.updateConnectionStatus({
					state: ConnectionState.CONNECTED,
					lastConnected: new Date(),
					lastError: undefined,
					retryAttempt: 0,
					progressMessage: undefined,
				});
				this.logger.output(`${icons.success} Connected to RocketRide server`);
				this.emit('connected');

				// Fetch and cache services list
				this.refreshServices().catch((err) => {
					this.logger.error(`Failed to fetch services on connect: ${err}`);
				});
			},
			onDisconnected: async (reason?: string, hasError?: boolean) => {
				this.logger.output(`${icons.warning} WebSocket disconnected (reason: ${reason ?? 'unknown'}, error: ${hasError ?? false})`);
				this.clearServicesCache();
				this.updateConnectionStatus({ state: ConnectionState.CONNECTING });
				this.emit('disconnected');
			},
			onConnectError: (error: Error) => {
				this.logger.output(`${icons.info} Reconnect attempt failed: ${error.message}`);
				this.updateConnectionStatus({
					progressMessage: 'Reconnecting...',
				});
			},
		});

		return client;
	}

	// =========================================================================
	// MANAGER (swapped on mode change)
	// =========================================================================

	private createManagerForMode(connectionMode: string): BaseManager {
		if (connectionMode === 'local') {
			if (!this.enginesRoot) {
				throw new Error('Engines root path not set. Cannot create LocalManager.');
			}
			return new LocalManager(this.enginesRoot);
		}
		return new RemoteManager();
	}

	private wireManagerEvents(manager: BaseManager): void {
		manager.on('status', (msg: string) => {
			this.updateConnectionStatus({ progressMessage: msg });
		});
		manager.on('terminated', (details: { code: number | null; signal: string | null }) => {
			this.logger.output(`${icons.warning} Local server terminated (code=${details.code}, signal=${details.signal})`);
		});
	}

	// =========================================================================
	// CONNECT / DISCONNECT
	// =========================================================================

	public connect(): Promise<void> {
		// Deduplicate: if a connect is already in flight, return the same promise
		if (this.connectPromise) {
			return this.connectPromise;
		}
		this.connectPromise = this._connect().finally(() => {
			this.connectPromise = undefined;
		});
		return this.connectPromise;
	}

	private async _connect(): Promise<void> {
		if (this.isDisposing) {
			return;
		}

		this.logger.output(`${icons.connecting} Connecting...`);
		this.updateConnectionStatus({
			state: ConnectionState.CONNECTING,
			lastError: undefined,
		});

		const config = this.configManager.getConfig();

		try {
			// Create manager for current mode (if we don't already have one)
			if (!this.manager) {
				this.manager = this.createManagerForMode(config.connectionMode);
				this.wireManagerEvents(this.manager);
			}

			// Cancel any in-flight engine download
			this.engineCts?.cancel();
			this.engineCts?.dispose();
			this.engineCts = new vscode.CancellationTokenSource();

			// Manager handles everything: install/start engine, validate creds, connect client
			await this.manager.connect(this.client, config, this.engineCts.token);

			// onConnected callback handles state update and 'connected' emit
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.output(`${icons.error} ${errorMessage}`);
			this.updateConnectionStatus({
				state: ConnectionState.DISCONNECTED,
				lastError: errorMessage,
			});
			this.emit('error', error);
		}
	}

	public async disconnect(): Promise<void> {
		this.logger.output(`${icons.warning} Disconnected from RocketRide by request`);

		// Cancel any in-flight engine download
		this.engineCts?.cancel();
		this.engineCts?.dispose();
		this.engineCts = undefined;

		// Manager handles everything: disconnect client, stop engine if running
		if (this.manager) {
			await this.manager.disconnect(this.client);
			this.manager.removeAllListeners();
			this.manager = undefined;
		}
		this.clearServicesCache();

		this.updateConnectionStatus({
			state: ConnectionState.DISCONNECTED,
		});
	}

	public async reconnect(): Promise<void> {
		await this.disconnect();
		await this.connect();
	}

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

	public getHttpUrl(): string {
		if (this.connectionStatus.connectionMode === 'local' && this.manager instanceof LocalManager) {
			const port = this.manager.getActualPort();
			if (port) return `http://localhost:${port}`;
		}
		return this.configManager.getHttpUrl();
	}

	public getWebSocketUrl(): string {
		if (this.connectionStatus.connectionMode === 'local' && this.manager instanceof LocalManager) {
			const port = this.manager.getActualPort();
			if (port) return `ws://localhost:${port}/task/service`;
		}
		return this.configManager.getWebSocketUrl();
	}

	public getEngineInfo(): { version: string | null; publishedAt: string | null } {
		const info = this.manager?.getInfo();
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
			this.emit('servicesUpdated', { services: {}, servicesError: 'Not connected' });
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
				this.emit('servicesUpdated', { services, servicesError: undefined });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				this.cachedServices = null;
				this.cachedServicesError = msg;
				this.emit('servicesUpdated', { services: {}, servicesError: msg });
			} finally {
				this.servicesRefreshPromise = null;
			}
		})();

		return this.servicesRefreshPromise;
	}

	private clearServicesCache(): void {
		this.cachedServices = null;
		this.cachedServicesError = null;
		this.servicesRefreshPromise = null;
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	private updateConnectionStatus(updates: Partial<ConnectionStatus>): void {
		if (this.isDisposing) {
			return;
		}
		Object.assign(this.connectionStatus, updates);
		this.emit('connectionStateChanged', this.connectionStatus);
	}

	private async updateCredentialsStatus(): Promise<void> {
		if (this.isDisposing) {
			return;
		}
		const config = this.configManager.getConfig();
		let hasCredentials: boolean;

		if (connectionModeUsesOAuth(config.connectionMode)) {
			// Cloud mode: check if we have a stored cloud token
			hasCredentials = await CloudAuthProvider.getInstance().isSignedIn();
		} else if (connectionModeRequiresApiKey(config.connectionMode)) {
			// On-prem: need both API key and host URL
			hasCredentials = !!(config.apiKey && config.hostUrl);
		} else if (config.connectionMode === 'onprem') {
			// On-prem without required key: just need host URL
			hasCredentials = !!config.hostUrl;
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

		if (this.manager) {
			await this.manager.disconnect(this.client);
			this.manager.removeAllListeners();
			this.manager = undefined;
		}
		this.clearServicesCache();

		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		this.configManager.dispose();
		this.removeAllListeners();
	}
}
