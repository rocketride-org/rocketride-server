// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
import { EngineServer } from './engine';
import { EngineInstaller } from './engine-installer';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { ConnectionStatus, ConnectionState, GenericResponse } from '../shared/types';

export class ConnectionManager extends EventEmitter {
	private static instance: ConnectionManager;

	// Core connection components
	private client?: RocketRideClient;
	private dapServer?: EngineServer;
	private engineInstaller?: EngineInstaller;
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

	// Reconnection management (exponential backoff: 1s -> 15s cap)
	private static readonly BACKOFF_MIN_MS = 1000;
	private static readonly BACKOFF_MAX_MS = 15000;
	private reconnectTimeout?: NodeJS.Timeout;
	private retryingMessageShown = false;
	private isManualDisconnect = false;

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

	public setExtensionPath(extensionPath: string): void {
		this.engineInstaller = new EngineInstaller(extensionPath);
	}

	private setupConfigurationListener(): void {
		const disposable = this.configManager.onConfigurationChanged(async (_config) => {
			// Don't process configuration changes during disposal
			if (this.isDisposing) {
				return;
			}

			this.logger.output(`${icons.info} Configuration changed, reconnecting...`);
			await this.updateCredentialsStatus();

			this.disconnect();
			this.resetRetryState();

			setTimeout(async () => {
				await this.initialize();
			}, 500);
		});

		this.disposables.push(disposable);
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
		return this.configManager.getHttpUrl();
	}

	public getWebSocketUrl(): string {
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

		if ((config.connectionMode === 'cloud' || config.connectionMode === 'onprem') && (!config.apiKey || !config.hostUrl)) {
			await this.configManager.openSettings();
			return;
		}

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
			if (config.connectionMode === 'local') {
				await this._connectLocal();
			} else {
				await this._connectCloud();
			}
		} catch (error) {
			this.handleConnectionError(error);
		}
	}

	private async _connectLocal(): Promise<void> {
		await this.ensureEngineInstalled();
		await this.startEngine();
		await this._connectClientWithRetries();
	}

	private async ensureEngineInstalled(): Promise<void> {
		if (!this.engineInstaller) {
			throw new Error('Engine installer not initialized. Extension path not set.');
		}

		const config = this.configManager.getConfig();
		const versionSpec = config.local.engineVersion || 'latest';

		// Check if we already have the right version installed
		if (this.engineInstaller.isInstalled()) {
			if (versionSpec !== 'latest' && versionSpec !== 'prerelease') {
				const installed = this.engineInstaller.getInstalledVersion();
				if (installed === versionSpec) {
					return;
				}
				// Different version requested — need to re-download
			} else {
				return;
			}
		}

		this.updateConnectionStatus({ state: ConnectionState.DOWNLOADING_ENGINE });

		// Use existing GitHub sign-in if present (avoids 60/hr rate limit; no prompt)
		let githubToken: string | undefined;
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			githubToken = session?.accessToken;
		} catch {
			// Proceed without token; may hit rate limit
		}

		// Route progress through the connection status instead of a toast notification
		const progress: vscode.Progress<{ message?: string; increment?: number }> = {
			report: (value) => {
				if (value.message) {
					this.updateConnectionStatus({ progressMessage: value.message });
				}
			}
		};

		try {
			await this.engineInstaller.ensureEngine(versionSpec, progress, undefined, githubToken);
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			if (!githubToken && msg.toLowerCase().includes('rate limit')) {
				// Prompt user to sign into GitHub to get a higher rate limit
				this.logger.output(`${icons.info} Requesting GitHub sign-in to avoid rate limits...`);
				try {
					const session = await vscode.authentication.getSession('github', [], { createIfNone: true });
					if (session?.accessToken) {
						githubToken = session.accessToken;
						await this.engineInstaller.ensureEngine(versionSpec, progress, undefined, githubToken);
						this.updateConnectionStatus({ progressMessage: undefined });
						return;
					}
				} catch {
					// User declined sign-in
				}
				throw new Error('GitHub API rate limit exceeded. Sign into GitHub (via Accounts menu) to increase the limit, then reconnect.');
			}
			throw error;
		}
		this.updateConnectionStatus({ progressMessage: undefined });
	}

	private async _connectCloud(): Promise<void> {
		await this._connectClient();
	}

	private createClient(): RocketRideClient {
		const config = this.configManager.getConfig();
		const auth = (config.connectionMode === 'cloud' || config.connectionMode === 'onprem') ? config.apiKey : 'MYAPIKEY';
		const uri = this.configManager.getHttpUrl();

		const client = new RocketRideClient({
			auth,
			uri,
			module: 'CONN-EXT',
			onEvent: async (message: DAPMessage) => {
				this.emit('event', message);
			},
			onDisconnected: async (reason?: string, hasError?: boolean) => {
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

	private async startEngine(): Promise<void> {
		const config = this.configManager.getConfig();

		this.updateConnectionStatus({ state: ConnectionState.STARTING_ENGINE });

		const executablePath = this.engineInstaller!.getExecutablePath();

		this.logger.output(`${icons.launch} Starting local server at ${config.local.host}:${config.local.port}`);

		if (this.dapServer) {
			this.dapServer.removeAllListeners();
			this.dapServer.stopServer();
		}

		this.dapServer = new EngineServer();

		const args = [
			'--autoterm',  // Exit when VS Code closes (stdin monitoring)
			'./ai/eaas.py',
			`--host=${config.local.host}`,
			`--port=${config.local.port}`,
			...config.local.engineArgs
		];

		try {
			await this.dapServer.startServer(executablePath, args);

			this.dapServer.on('terminated', (details) => {
				this.logger.output(`${icons.warning} Local server terminated (code=${details.code}, signal=${details.signal})`);
				this.handleConnectionLoss();
			});

			this.logger.output(`${icons.success} Local server started`);
		} catch (error) {
			this.updateConnectionStatus({
				state: ConnectionState.ENGINE_STARTUP_FAILED,
				lastError: 'Error starting local engine'
			});
			throw error;
		}
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

		// Fetch and cache services list during connection phase
		this.refreshServices().catch(err => {
			this.logger.error(`Failed to fetch services on connect: ${err}`);
		});
	}

	private handleConnectionLoss(): void {
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

		this.cleanup();
		this.emit('disconnected');

		if (shouldReconnect) {
			this.scheduleReconnect();
		}
	}

	private handleConnectionError(error: unknown): void {
		// Don't process errors during disposal
		if (this.isDisposing) {
			return;
		}

		const errorMessage = error instanceof Error ? error.message : String(error);
		this.logger.output(`${icons.error} ${errorMessage}`);

		// Engine startup failure: status already set in startEngine() catch; do not retry
		if (this.connectionStatus.state === ConnectionState.ENGINE_STARTUP_FAILED) {
			this.cleanup();
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

		this.cleanup();
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
			const response = await this.client.rawRequest(command, args, token);
			return response as unknown as GenericResponse;
		} catch {
			return undefined;
		}
	}

	/**
	 * Returns the cached services list for the pipeline editor.
	 * Use this when opening a page editor so the UI can show immediately.
	 * Call refreshServices() to update the cache in the background.
	 */
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
				const response = await this.client!.rawRequest('apaext_services', {});
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

	public disconnect(): void {
		this.logger.output(`${icons.warning} Disconnected from RocketRide by request`);
		this.isManualDisconnect = true;

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = undefined;
		}

		this.cleanup();

		this.updateConnectionStatus({
			state: ConnectionState.DISCONNECTED,
			retryAttempt: 0
		});

		this.resetRetryState();
	}

	public async reconnect(): Promise<void> {
		this.disconnect();
		await this.connect();
	}

	private cleanup(): void {
		this.cleanupClient();
		this.stopEngine();
		this.clearServicesCache();
	}

	private cleanupClient(): void {
		if (this.client) {
			// Fire-and-forget disconnect; don't await to avoid blocking disposal
			this.client.disconnect().catch(() => { /* ignore */ });
			this.client = undefined;
		}
	}

	private stopEngine(): void {
		if (this.dapServer) {
			this.updateConnectionStatus({ state: ConnectionState.STOPPING_ENGINE });

			this.logger.output(`${icons.stop} Stopping local server...`);

			this.dapServer.removeAllListeners();
			this.dapServer.stopServer();
			this.dapServer = undefined;

			this.updateConnectionStatus({ state: ConnectionState.DISCONNECTED });
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

	public dispose(): void {
		// Set disposing flag first to prevent any operations
		this.isDisposing = true;

		// Disconnect and cleanup
		this.isManualDisconnect = true;

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = undefined;
		}

		this.cleanup();

		// Clean up configuration listeners
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];

		// Dispose config manager
		this.configManager.dispose();

		// Remove all event listeners
		this.removeAllListeners();
	}
}
