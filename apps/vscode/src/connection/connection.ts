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
 * This class wraps a RocketRideClient from the shared TypeScript client SDK,
 * exposing the same EventEmitter-based API that all providers consume.
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { RocketRideClient, DAPMessage, AuthenticationException } from 'rocketride';
import { ConfigManager } from '../config';
import { BaseManager } from './base-manager';
import { EngineManager } from './engine-manager';
import { CloudManager } from './cloud-manager';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { ConnectionStatus, ConnectionState, GenericResponse } from '../shared/types';

export class ConnectionManager extends EventEmitter {
	private static instance: ConnectionManager;

	// Core connection components
	private client?: RocketRideClient;
	private manager?: BaseManager;
	private enginesRoot?: string;
	private localEnginePort?: number;
	private configManager = ConfigManager.getInstance();
	private logger = getLogger();

	// Connection state tracking
	private connectionStatus: ConnectionStatus = {
		state: ConnectionState.DISCONNECTED,
		connectionMode: 'local',
		hasCredentials: false,
		retryAttempt: 0,
		maxRetryAttempts: 120
	};

	// Reconnection management (exponential backoff: 1s -> 5s cap)
	private static readonly BACKOFF_MIN_MS = 1000;
	private static readonly BACKOFF_MAX_MS = 5000;
	private reconnectTimeout?: NodeJS.Timeout;
	private retryingMessageShown = false;
	private isManualDisconnect = false;

	// Debounce timer for configuration changes (saveAllSettings writes each
	// setting individually, firing onDidChangeConfiguration for each one)
	private configChangeTimeout?: NodeJS.Timeout;

	// Engine install cancellation (cancelled on disconnect/config change)
	private engineCts?: vscode.CancellationTokenSource;

	// Resource cleanup tracking
	private disposables: vscode.Disposable[] = [];
	private isDisposing: boolean = false;

	// Services list cache (populated on connect, refreshed when opening page editor)
	private cachedServices: Record<string, unknown> | null = null;
	private cachedServicesError: string | null = null;
	private servicesRefreshPromise: Promise<void> | null = null;

	private constructor() {
		super();
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

	private setupConfigurationListener(): void {
		const disposable = this.configManager.onConfigurationChanged((_config) => {
			// Don't process configuration changes during disposal
			if (this.isDisposing) {
				return;
			}

			// Debounce: the settings page saves each setting individually, firing
			// this event for each one. Wait until the burst of changes settles
			// before running a single disconnect/reconnect cycle.
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

		await this.disconnect();

		this.connectionStatus.retryAttempt = 0;
		this.retryingMessageShown = false;

		await this.initialize();

		// Now safe to clear the manual disconnect flag
		this.isManualDisconnect = false;
	}

	private resetRetryState(): void {
		this.connectionStatus.retryAttempt = 0;
		this.retryingMessageShown = false;
		this.isManualDisconnect = false;
	}

	private updateConnectionStatus(updates: Partial<ConnectionStatus>): void {
		// Don't update state during disposal
		if (this.isDisposing) {
			return;
		}

		Object.assign(this.connectionStatus, updates);
		this.emit('connectionStateChanged', this.connectionStatus);
	}

	public async initialize(): Promise<void> {
		// Don't initialize during disposal
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
				lastError: errors.join(', ')
			});
			return;
		}

		this.updateConnectionStatus({
			connectionMode: config.connectionMode
		});

		if (config.autoConnect && this.canAttemptConnection()) {
			await this.connect();
		}
	}

	private async updateCredentialsStatus(): Promise<void> {
		// Don't update during disposal
		if (this.isDisposing) {
			return;
		}

		const config = this.configManager.getConfig();

		const hasCredentials = (config.connectionMode === 'cloud' || config.connectionMode === 'onprem')
			? !!(config.apiKey && config.hostUrl)
			: true; // local mode: engine is auto-downloaded, always ready

		this.updateConnectionStatus({ hasCredentials });
	}

	private canAttemptConnection(): boolean {
		return this.connectionStatus.hasCredentials &&
			(this.connectionStatus.state === ConnectionState.DISCONNECTED ||
				this.connectionStatus.state === ConnectionState.ENGINE_STARTUP_FAILED);
	}

	public getHttpUrl(): string {
		if (this.connectionStatus.connectionMode === 'local' && this.localEnginePort) {
			return `http://localhost:${this.localEnginePort}`;
		}
		return this.configManager.getHttpUrl();
	}

	public getWebSocketUrl(): string {
		if (this.connectionStatus.connectionMode === 'local' && this.localEnginePort) {
			return `ws://localhost:${this.localEnginePort}/task/service`;
		}
		return this.configManager.getWebSocketUrl();
	}

	public async connect(): Promise<void> {
		// Don't connect during disposal; allow connect when disconnected or engine-startup-failed
		if (this.isDisposing || !this.canAttemptConnection()) {
			return;
		}

		this.logger.output(`${icons.connecting} Connecting...`);

		this.updateConnectionStatus({
			state: ConnectionState.CONNECTING,
			lastError: undefined
		});

		await this._connect();
	}

	private async _connect(): Promise<void> {
		const config = this.configManager.getConfig();

		const errors = await this.configManager.validateConfig();
		if (errors.length > 0) {
			const errorMessage = `Configuration errors: ${errors.join(', ')}`;
			this.updateConnectionStatus({
				state: ConnectionState.DISCONNECTED,
				lastError: errorMessage
			});
			vscode.window.showErrorMessage(`Cannot connect: ${errorMessage}`);
			return;
		}

		try {
			// Stop any existing manager (engine process) before creating a new one
			await this.stopManager();

			// Create the appropriate manager based on connection mode
			this.createManager(config.connectionMode);

			// Listen for status updates from the manager
			this.manager!.on('status', (msg: string) => {
				this.updateConnectionStatus({ progressMessage: msg });
			});
			this.manager!.on('terminated', (details: { code: number | null; signal: string | null }) => {
				this.logger.output(`${icons.warning} Local server terminated (code=${details.code}, signal=${details.signal})`);
				this.handleConnectionLoss();
			});

			// Cancel any in-flight operation from a previous connection attempt
			this.engineCts?.cancel();
			this.engineCts?.dispose();
			this.engineCts = new vscode.CancellationTokenSource();

			this.updateConnectionStatus({ state: ConnectionState.DOWNLOADING_ENGINE });
			await this.manager!.start(config, this.engineCts.token);
			this.updateConnectionStatus({ progressMessage: undefined });

			// Capture the dynamically assigned port from the engine
			if (config.connectionMode === 'local' && this.manager instanceof EngineManager) {
				this.localEnginePort = this.manager.getActualPort();
			}

			// Connect the WebSocket client
			if (config.connectionMode === 'local') {
				await this._connectClientWithRetries();
			} else {
				await this._connectClient();
			}
		} catch (error) {
			await this.handleConnectionError(error);
		}
	}

	/**
	 * Creates the appropriate backend manager based on connection mode.
	 */
	private createManager(connectionMode: string): void {
		if (connectionMode === 'local') {
			if (!this.enginesRoot) {
				throw new Error('Engines root path not set. Cannot create EngineManager.');
			}
			this.manager = new EngineManager(this.enginesRoot);
		} else {
			this.manager = new CloudManager();
		}
	}

	/**
	 * Stops and clears the current backend manager if one exists.
	 */
	private async stopManager(): Promise<void> {
		if (this.manager) {
			this.manager.removeAllListeners();
			await this.manager.stop();
			this.manager = undefined;
		}
	}

	private createClient(): RocketRideClient {
		const config = this.configManager.getConfig();
		const auth = (config.connectionMode === 'cloud' || config.connectionMode === 'onprem') ? config.apiKey : 'MYAPIKEY';
		const uri = (config.connectionMode === 'local' && this.localEnginePort)
			? `http://localhost:${this.localEnginePort}`
			: this.configManager.getHttpUrl();

		const client = new RocketRideClient({
			auth,
			uri,
			module: 'CONN-EXT',
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
			onDisconnected: async (reason?: string, hasError?: boolean) => {
				const isStale = this.client !== client;
				// Ignore stale callbacks from a client that has been replaced or cleaned up
				if (isStale) { return; }
				this.logger.output(`${icons.warning} WebSocket disconnected (reason: ${reason ?? 'unknown'}, error: ${hasError ?? false})`);
				this.handleConnectionLoss();
			},
		});

		return client;
	}

	private async _connectClientWithRetries(): Promise<void> {
		this.updateConnectionStatus({
			state: ConnectionState.CONNECTING,
			progressMessage: undefined
		});

		// Clean up any previous client
		if (this.client) {
			await this.client.disconnect();
			this.client = undefined;
		}

		let attempts = 0;
		const maxAttempts = 120;

		while (attempts < maxAttempts && this.connectionStatus.state === 'connecting') {
			try {
				if (attempts > 0) {
					this.updateConnectionStatus({ progressMessage: 'Attempting connection...' });
				}
				this.client = this.createClient();
				await this.client.connect(5000);
				this.onConnectionEstablished();
				return;
			} catch (error: unknown) {
				attempts++;
				this.updateConnectionStatus({ retryAttempt: attempts });

				// Clean up failed client
				if (this.client) {
					try { await this.client.disconnect(); } catch { /* ignore */ }
					this.client = undefined;
				}

				if (attempts >= maxAttempts) {
					const msg = error instanceof Error ? error.message : String(error);
					this.logger.output(`${icons.error} Connection failed after ${maxAttempts} attempts: ${msg}`);
					throw new Error(`Connection failed after ${maxAttempts} attempts: ${msg}`);
				}

				if (this.connectionStatus.state === 'connecting') {
					const delayMs = this.getBackoffDelayMs(attempts - 1);
					const delaySec = Math.round(delayMs / 1000);
					this.logger.output(`${icons.info} Connection attempt ${attempts} failed, waiting ${delaySec}s...`);
					this.updateConnectionStatus({
						progressMessage: `Waiting ${delaySec}s before next attempt`
					});
					await this.delay(delayMs);
				}
			}
		}
	}

	private async _connectClient(): Promise<void> {
		// Clean up any previous client
		if (this.client) {
			await this.client.disconnect();
			this.client = undefined;
		}

		this.client = this.createClient();
		await this.client.connect();
		this.onConnectionEstablished();
	}

	private onConnectionEstablished(): void {
		this.updateConnectionStatus({
			state: ConnectionState.CONNECTED,
			lastConnected: new Date(),
			lastError: undefined,
			retryAttempt: 0,
			progressMessage: undefined
		});

		this.resetRetryState();
		this.logger.output(`${icons.success} Connected to RocketRide server`);
		this.emit('connected');

		// Register global monitors for task lifecycle, output, and SSE events
		this.request('rrext_monitor', {
			types: ['task', 'output']
		}, '*').catch(err => {
			this.logger.error(`Failed to register global monitors: ${err}`);
		});

		// Fetch and cache services list during connection phase
		this.refreshServices().catch(err => {
			this.logger.error(`Failed to fetch services on connect: ${err}`);
		});
	}

	private async handleConnectionLoss(): Promise<void> {
		// Don't process connection loss during disposal
		if (this.isDisposing) {
			return;
		}

		const shouldReconnect = !this.isManualDisconnect &&
			this.connectionStatus.hasCredentials &&
			this.connectionStatus.retryAttempt < this.connectionStatus.maxRetryAttempts;


		if (shouldReconnect && this.connectionStatus.state === ConnectionState.CONNECTED) {
			this.updateConnectionStatus({ state: ConnectionState.CONNECTING });
		} else if (!shouldReconnect) {
			this.updateConnectionStatus({ state: ConnectionState.DISCONNECTED });
		}

		await this.cleanup();
		this.emit('disconnected');

		if (shouldReconnect) {
			this.scheduleReconnect();
		}
	}

	private async handleConnectionError(error: unknown): Promise<void> {
		// Don't process errors during disposal
		if (this.isDisposing) {
			return;
		}

		const errorMessage = error instanceof Error ? error.message : String(error);
		this.logger.output(`${icons.error} ${errorMessage}`);

		// Engine startup failure: status already set in startEngine() catch; do not retry
		if (this.connectionStatus.state === ConnectionState.ENGINE_STARTUP_FAILED) {
			await this.cleanup();
			this.emit('error', error);
			return;
		}

		// Do not retry on auth failure or rate limit (user action required)
		const errorMsg = error instanceof Error ? error.message : String(error);
		const isRateLimit = errorMsg.toLowerCase().includes('rate limit');
		const shouldReconnect = !this.isManualDisconnect &&
			this.connectionStatus.hasCredentials &&
			!(error instanceof AuthenticationException) &&
			!isRateLimit &&
			this.connectionStatus.retryAttempt < this.connectionStatus.maxRetryAttempts;


		if (!shouldReconnect) {
			this.updateConnectionStatus({
				state: ConnectionState.DISCONNECTED,
				lastError: errorMessage
			});
		} else {
			this.updateConnectionStatus({
				state: ConnectionState.CONNECTING,
				lastError: errorMessage
			});
		}

		await this.cleanup();
		this.emit('error', error);

		if (shouldReconnect) {
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.connectionStatus.retryAttempt >= this.connectionStatus.maxRetryAttempts) {
			this.logger.output(`${icons.warning} Automatic reconnection disabled. Reconnect manually when server is available.`);
			this.updateConnectionStatus({ state: ConnectionState.DISCONNECTED });
			return;
		}

		const delayMs = this.getBackoffDelayMs(this.connectionStatus.retryAttempt);
		const delaySec = Math.round(delayMs / 1000);
		this.logger.output(`${icons.info} Waiting ${delaySec}s before retrying...`);
		this.updateConnectionStatus({
			progressMessage: `Waiting ${delaySec}s before next attempt`
		});
		this.reconnectTimeout = setTimeout(async () => {
			if (this.connectionStatus.state === 'connecting' && !this.isManualDisconnect && !this.isDisposing) {
				this.logger.output(`${icons.connecting} Reconnecting...`);
				this.updateConnectionStatus({
					retryAttempt: this.connectionStatus.retryAttempt + 1,
					progressMessage: 'Attempting connection...'
				});

				try {
					await this._connect();
				} catch {
					// Error handled within _connect()
				}
			}
		}, delayMs);
	}

	/**
	 * Get the underlying RocketRideClient instance for providers that want
	 * direct access to typed SDK methods (chat, file upload, etc.).
	 */
	public getClient(): RocketRideClient | undefined {
		return this.client;
	}

	public isConnected(): boolean {
		return this.connectionStatus.state === 'connected' && this.client?.isConnected() === true;
	}

	public isConnecting(): boolean {
		return this.connectionStatus.state === 'starting-engine' ||
			this.connectionStatus.state === 'connecting';
	}

	public isDisconnected(): boolean {
		return this.connectionStatus.state === ConnectionState.DISCONNECTED ||
			this.connectionStatus.state === ConnectionState.ENGINE_STARTUP_FAILED;
	}

	public hasCredentials(): boolean {
		return this.connectionStatus.hasCredentials;
	}

	public getConnectionStatus(): ConnectionStatus {
		return { ...this.connectionStatus };
	}

	public async request(command: string, args?: Record<string, unknown>, token?: string): Promise<GenericResponse | undefined> {
		if (!this.client || !this.client.isConnected()) {
			return undefined;
		}
		try {
			this.logger.output(`${icons.send} ${command} ${JSON.stringify(args ?? {})}`);
			const response = await this.client.dapRequest(command, args, token);
			this.logger.output(`${icons.receive} ${command} ${JSON.stringify(response ?? {})}`);
			return response as unknown as GenericResponse;
		} catch (err) {
			this.logger.output(`${icons.error} ${command} failed: ${err}`);
			return undefined;
		}
	}

	/**
	 * Returns the cached services list for the pipeline editor.
	 * Use this when opening a page editor so the UI can show immediately.
	 * Call refreshServices() to update the cache in the background.
	 */
	public getEngineInfo(): { version: string | null; publishedAt: string | null } {
		const info = this.manager?.getInfo();
		return {
			version: info?.version ?? null,
			publishedAt: info?.publishedAt ?? null
		};
	}

	public getCachedServices(): { services: Record<string, unknown>; servicesError?: string } {
		if (!this.isConnected()) {
			return { services: {}, servicesError: 'Not connected' };
		}
		if (this.cachedServicesError) {
			return { services: this.cachedServices ?? {}, servicesError: this.cachedServicesError };
		}
		return { services: this.cachedServices ?? {} };
	}

	/**
	 * Fetches the services list from the server and updates the cache.
	 * Emits 'servicesUpdated' when done so open page editors can refresh.
	 * Single-flight: concurrent calls share the same in-flight request.
	 */
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
				const response = await this.client!.dapRequest('rrext_services', {});
				if (response?.success === false) {
					const msg = response?.message ?? 'Failed to load services';
					this.cachedServices = null;
					this.cachedServicesError = msg;
					this.emit('servicesUpdated', { services: {}, servicesError: msg });
					return;
				}
				const body = response?.body;
				const services = (typeof body === 'object' && body !== null && 'services' in body)
					? (body.services as Record<string, unknown>)
					: {};
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

	public async disconnect(): Promise<void> {
		this.logger.output(`${icons.warning} Disconnected from RocketRide by request`);
		this.isManualDisconnect = true;

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = undefined;
		}

		await this.cleanup();

		this.updateConnectionStatus({
			state: ConnectionState.DISCONNECTED,
			retryAttempt: 0
		});

		// Only reset retry counters — keep isManualDisconnect true to prevent
		// stale onDisconnected callbacks from triggering reconnection.
		// The flag is cleared on next successful connection (onConnectionEstablished
		// → resetRetryState) or by explicit caller action (e.g. config change handler).
		this.connectionStatus.retryAttempt = 0;
		this.retryingMessageShown = false;
	}

	public async reconnect(): Promise<void> {
		await this.disconnect();
		await this.connect();
	}

	private async cleanup(): Promise<void> {
		// Cancel any in-flight engine download
		this.engineCts?.cancel();
		this.engineCts?.dispose();
		this.engineCts = undefined;

		this.cleanupClient();
		await this.stopManager();
		this.localEnginePort = undefined;
		this.clearServicesCache();
	}

	private cleanupClient(): void {
		if (this.client) {
			// Fire-and-forget disconnect; don't await to avoid blocking disposal
			this.client.disconnect().catch(() => { /* ignore */ });
			this.client = undefined;
		}
	}

	/** Exponential backoff: 1s, 2s, 4s, 8s, 15s (cap), 15s, ... */
	private getBackoffDelayMs(attempt: number): number {
		const delay = ConnectionManager.BACKOFF_MIN_MS * Math.pow(2, attempt);
		return Math.min(delay, ConnectionManager.BACKOFF_MAX_MS);
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	public async dispose(): Promise<void> {
		// Set disposing flag first to prevent any operations
		this.isDisposing = true;

		// Disconnect and cleanup
		this.isManualDisconnect = true;

		if (this.configChangeTimeout) {
			clearTimeout(this.configChangeTimeout);
			this.configChangeTimeout = undefined;
		}

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = undefined;
		}

		await this.cleanup();

		// Clean up configuration listeners
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];

		// Dispose config manager
		this.configManager.dispose();

		// Remove all event listeners
		this.removeAllListeners();
	}
}
