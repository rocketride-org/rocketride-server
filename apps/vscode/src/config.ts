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
 * config.ts - RocketRide Extension Configuration Management with Secure Storage and Webview Integration
 */

import * as vscode from 'vscode';
import * as path from 'path';

export type ConnectionMode = 'cloud' | 'onprem' | 'local';

export interface ConfigManagerInfo {
	/** Connection mode: cloud (RocketRide.ai), onprem (your server), or local (localhost port) */
	connectionMode: ConnectionMode;

	/** API key for authentication (retrieved from secure storage) */
	apiKey: string;

	/** overall url  */
	hostUrl: string;

	/** Deploy API base URL (for Deploy to RocketRide.ai) */
	deployUrl: string;

	/** Default path for creating new pipeline files */
	defaultPipelinePath: string;

	/** Local configuration */
	local: {
		/** Local host address (default: 'localhost') */
		host: string;
		/** Local port (default: 5565) */
		port: number;
		/** Additional engine arguments */
		engineArgs: string[];
		/** Engine version to download: 'latest', 'prerelease', or a specific tag */
		engineVersion: string;
	};

	/** General settings */
	autoConnect: boolean;

	/** Pipeline restart behavior when pipe.json files change */
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';

	/** Environment variables loaded from .env file */
	env: Record<string, string>;

	/** Integration settings */
	copilotIntegration: boolean;
	cursorIntegration: boolean;
}

/**
 * Configuration manager class providing centralized access to RocketRide settings
 */
export class ConfigManager {
	private static instance: ConfigManager;
	private readonly configSection = 'rocketride';
	private readonly API_KEY_SECRET_KEY = 'rocketride.apiKey';

	private context?: vscode.ExtensionContext;
	private isDisposing: boolean = false;
	private envFileWatcher?: vscode.FileSystemWatcher;
	private disposables: vscode.Disposable[] = [];
	private envChangeEmitter = new vscode.EventEmitter<Record<string, string>>();
	public readonly onEnvVarsChanged = this.envChangeEmitter.event;

	// Cached configuration
	private config: ConfigManagerInfo = {
		connectionMode: 'local',
		apiKey: '',
		hostUrl: 'http://localhost:5565',
		deployUrl: '',
		defaultPipelinePath: '',
		local: {
			host: '',
			port: 5565,
			engineArgs: [],
			engineVersion: 'latest',
		},
		autoConnect: true,
		pipelineRestartBehavior: 'prompt',
		env: {},
		copilotIntegration: false,
		cursorIntegration: false
	};

	private constructor() { }

	public static getInstance(): ConfigManager {
		if (!ConfigManager.instance) {
			ConfigManager.instance = new ConfigManager();
		}
		return ConfigManager.instance;
	}

	/**
	 * Initialize with extension context for secure storage
	 */
	public async initialize(context: vscode.ExtensionContext): Promise<void> {
		this.context = context;
		this.isDisposing = false;

		// Set up .env file watcher
		this.setupEnvFileWatcher();

		// Load initial config (includes env file)
		await this.refreshConfig();

		// Ensure .env file exists with current settings if workspace is open
		await this.ensureEnvFileSync();

		// Listen for configuration changes
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(async event => {
				if (event.affectsConfiguration(this.configSection)) {
					await this.refreshConfig();
					
					// If hostUrl changed, sync to .env
					if (event.affectsConfiguration(`${this.configSection}.hostUrl`)) {
						await this.syncSettingsToEnv();
					}
				}
			})
		);

		// Listen for secret storage changes (API key changes)
		this.disposables.push(
			context.secrets.onDidChange(async event => {
				if (event.key === this.API_KEY_SECRET_KEY) {
					await this.refreshConfig();
					// API key changed, sync to .env
					await this.syncSettingsToEnv();
				}
			})
		);

		// Listen for workspace folder changes to ensure .env exists in new workspace
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(async () => {
				// Workspace changed - reload env and ensure sync
				await this.loadEnvFile();
				await this.refreshConfig();
				await this.ensureEnvFileSync();
			})
		);
	}

	/**
	 * Refreshes the cached configuration from all sources
	 */
	private async refreshConfig(): Promise<void> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		const hostUrl = config.get('hostUrl', 'http://localhost:5565');
		const deployUrl = config.get('deployUrl', 'https://cloud.rocketride.ai');

		// Parse host and port from the hostUrl - host will always be localhost
		const parsedHost = 'localhost';
		let parsedPort = 5565;

		try {
			const url = new URL(hostUrl);
			parsedPort = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
		} catch (error) {
			console.warn('Failed to parse hostUrl, using defaults:', error);
		}

		// Get API key from secure storage
		const apiKey = await this.getApiKeyFromStorage();

		// Ensure env is loaded (preserve existing env if already loaded)
		const existingEnv = this.config?.env || {};
		if (Object.keys(existingEnv).length === 0) {
			await this.loadEnvFile();
		}

		this.config = {
			connectionMode: config.get('connectionMode', 'local') as ConnectionMode,
			apiKey: apiKey,
			hostUrl: hostUrl,
			deployUrl: deployUrl,
			defaultPipelinePath: config.get('defaultPipelinePath', 'pipelines'),
			local: {
				host: parsedHost,
				port: parsedPort,
				engineArgs: config.get('local.engineArgs', []),
				engineVersion: config.get('local.engineVersion', 'latest')
			},
			autoConnect: config.get('autoConnect', true),
			pipelineRestartBehavior: config.get('pipelineRestartBehavior', 'prompt'),
			env: this.config?.env || {},
			copilotIntegration: config.get('copilotIntegration', false),
			cursorIntegration: config.get('cursorIntegration', false)
		};
	}

	/**
	 * Sets up a file watcher for the .env file
	 */
	private setupEnvFileWatcher(): void {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return;
		}

		// Create a file watcher for .env file in the workspace root
		const pattern = new vscode.RelativePattern(workspaceFolders[0], '.env');
		this.envFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

		// Watch for changes
		this.envFileWatcher.onDidChange(() => {
			this.loadEnvFile().then(async () => {
				this.refreshConfig();
				// Ensure required vars are present after manual edit
				await this.ensureEnvFileSync();
				// Notify listeners that env vars have changed
				this.envChangeEmitter.fire(this.getEnvVars());
			}).catch(error => {
				console.error('Failed to reload .env file:', error);
			});
		});

		// Watch for creation
		this.envFileWatcher.onDidCreate(() => {
			this.loadEnvFile().then(async () => {
				this.refreshConfig();
				// Ensure required vars are present in new file
				await this.ensureEnvFileSync();
				// Notify listeners that env vars have changed
				this.envChangeEmitter.fire(this.getEnvVars());
			}).catch(error => {
				console.error('Failed to load .env file after creation:', error);
			});
		});

		// Watch for deletion
		this.envFileWatcher.onDidDelete(() => {
			if (this.config) {
				this.config.env = {};
			}
			this.refreshConfig().then(async () => {
				// Recreate .env file with required vars
				await this.ensureEnvFileSync();
				// Notify listeners that env vars have changed
				this.envChangeEmitter.fire(this.getEnvVars());
			}).catch(error => {
				console.error('Failed to recreate .env file after deletion:', error);
			});
		});

		this.disposables.push(this.envFileWatcher);
	}

	/**
	 * Loads and parses the .env file from workspace root
	 */
	private async loadEnvFile(): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				if (this.config) {
					this.config.env = {};
				}
				return;
			}

			const workspaceRoot = workspaceFolders[0].uri.fsPath;
			const envPath = vscode.Uri.file(path.join(workspaceRoot, '.env'));

			try {
				// Parse the .env file
				const envContent = await vscode.workspace.fs.readFile(envPath);
				const envText = Buffer.from(envContent).toString('utf8');
				const parsedEnv = this.parseEnvFile(envText);
				
				if (this.config) {
					this.config.env = parsedEnv;
				}
			} catch {
				// .env file doesn't exist or can't be read
				if (this.config) {
					this.config.env = {};
				}
			}
		} catch (error) {
			console.error('Error loading .env file:', error);
			if (this.config) {
				this.config.env = {};
			}
		}
	}

	/**
	 * Parse .env file content into key-value pairs
	 */
	private parseEnvFile(content: string): Record<string, string> {
		const result: Record<string, string> = {};
		const lines = content.split('\n');

		for (const line of lines) {
			// Skip empty lines and comments
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}

			// Parse KEY=VALUE
			const match = trimmed.match(/^([^=]+)=(.*)$/);
			if (match) {
				const key = match[1].trim();
				let value = match[2].trim();

				// Remove surrounding quotes if present
				if ((value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1);
				}

				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Gets the API key from secure storage (internal async method)
	 */
	private async getApiKeyFromStorage(): Promise<string> {
		// Don't access storage during disposal
		if (this.isDisposing) {
			return '';
		}

		if (!this.context) {
			console.warn('ConfigManager not initialized with context - cannot access secure storage');
			return '';
		}

		try {
			const apiKey = await this.context.secrets.get(this.API_KEY_SECRET_KEY);
			return apiKey || '';
		} catch (error: unknown) {
			// Silently ignore cancellation errors during shutdown
			if (error instanceof Error && error.name === 'Canceled') {
				return '';
			}
			console.error('Failed to retrieve API key from secure storage:', error);
			return '';
		}
	}

	/**
	 * Substitute environment variables in a string.
	 * Replaces ${ROCKETRIDE_*} patterns with values from env dictionary.
	 * If variable is not found, leaves it unchanged.
	 */
	private substituteEnvVars(value: string, env: Record<string, string>): string {
		// Match ${ROCKETRIDE_*} patterns only
		return value.replace(/\$\{(ROCKETRIDE_[^}]+)\}/g, (match, varName) => {
			// Check if variable exists in env
			if (varName in env) {
				return String(env[varName]);
			}
			// If not found, leave as is
			return match;
		});
	}

	/**
	 * Recursively process an object/array to substitute environment variables.
	 * Only processes string values, leaving other types unchanged.
	 */
	private processEnvSubstitution(obj: unknown, env: Record<string, string>): unknown {
		if (typeof obj === 'string') {
			// If it's a string, perform substitution
			return this.substituteEnvVars(obj, env);
		} else if (Array.isArray(obj)) {
			// If it's an array, process each element
			return obj.map(item => this.processEnvSubstitution(item, env));
		} else if (obj !== null && typeof obj === 'object') {
			// If it's an object, process each property
			const result: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(obj)) {
				result[key] = this.processEnvSubstitution(value, env);
			}
			return result;
		}
		// For other types (number, boolean, null), return as is
		return obj;
	}

	/**
	 * Substitutes environment variables in an object (e.g., pipeline configuration) (SYNC)
	 * Returns a new object with all ${ROCKETRIDE_*} patterns replaced with their values.
	 * 
	 * @param obj The object to process (e.g., pipeline configuration)
	 * @returns A new object with environment variables substituted
	 */
	public substituteEnvVariables(obj: Record<string, unknown>): Record<string, unknown> {
		const env = this.getEnv();
		return this.processEnvSubstitution(obj, env) as Record<string, unknown>;
	}

	/**
	 * Gets the current RocketRide configuration (SYNC)
	 */
	public getConfig(): ConfigManagerInfo {
		// Return a copy to prevent external modifications
		return {
			...this.config,
			local: { ...this.config.local },
			env: { ...this.config.env }
		};
	}

	/**
	 * Gets the API key (SYNC - from cache)
	 */
	public getApiKey(): string {
		return this.config.apiKey;
	}

	/**
	 * Gets the environment variables from the .env file (SYNC)
	 */
	public getEnv(): Record<string, string> {
		if (!this.config) {
			throw new Error('ConfigManager not initialized. Call initialize() first.');
		}
		return { ...this.config.env };
	}

	/**
	 * Checks if API key is stored (SYNC)
	 */
	public hasApiKey(): boolean {
		return this.getApiKey().length > 0;
	}

	/**
	 * Gets the WebSocket URL based on current configuration (SYNC)
	 */
	public getWebSocketUrl(): string {
		const url = new URL(this.config.hostUrl);
		const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsPort = url.port || (url.protocol === 'https:' ? '443' : '80');

		return `${wsProtocol}//${url.hostname}:${wsPort}/task/service`;
	}

	/**
	 * Gets the HTTP/HTTPS URL based on current configuration (SYNC)
	 */
	public getHttpUrl(): string {
		const url = new URL(this.config.hostUrl);
		const httpProtocol = url.protocol;
		const httpPort = url.port || (url.protocol === 'https:' ? '443' : '80');

		return `${httpProtocol}//${url.hostname}:${httpPort}`;
	}

	/**
	 * Gets the API host URL for dynamic parameter replacement (SYNC)
	 */
	public getApiHost(): string {
		const config = this.getConfig();

		if (config.connectionMode === 'cloud' || config.connectionMode === 'onprem') {
			return config.hostUrl;
		}
		// Local mode - construct URL from host/port
		return `http://${config.local.host}:${config.local.port}`;
	}

	/**
	 * Validates the current configuration (SYNC)
	 * @returns Array of validation error messages, empty if valid
	 */
	public validateConfig(): string[] {
		const config = this.getConfig();
		const errors: string[] = [];

		if (config.connectionMode === 'cloud') {
			if (!config.hostUrl) {
				errors.push('Cloud URL is required when using cloud mode');
			} else {
				try {
					new URL(config.hostUrl);
				} catch {
					errors.push('Cloud URL must be a valid URL (e.g., https://cloud.rocketride.ai)');
				}
			}
			if (!config.apiKey) {
				errors.push('API key is required when using cloud mode');
			}
		} else if (config.connectionMode === 'onprem') {
			if (!config.hostUrl) {
				errors.push('Host URL is required when using on-prem mode');
			} else {
				try {
					new URL(config.hostUrl);
				} catch {
					errors.push('Host URL must be a valid URL');
				}
			}
			if (!config.apiKey) {
				errors.push('API key is required when using on-prem mode');
			}
		} else {
			// local
			if (!config.local.host) {
				errors.push('Local host is required when using local mode');
			}
			if (!config.local.port || config.local.port < 1 || config.local.port > 65535) {
				errors.push('Local port must be a valid port number (1-65535)');
			}
		}

		return errors;
	}

	/**
	 * Stores the API key in secure storage (ASYNC - updates both cache and storage)
	 */
	public async setApiKey(apiKey: string): Promise<void> {
		// Don't access storage during disposal
		if (this.isDisposing) {
			return;
		}

		if (!this.context) {
			throw new Error('ConfigManager not initialized with context - cannot access secure storage');
		}

		try {
			if (apiKey.trim()) {
				await this.context.secrets.store(this.API_KEY_SECRET_KEY, apiKey.trim());
			} else {
				await this.context.secrets.delete(this.API_KEY_SECRET_KEY);
			}

			// Update cache immediately
			if (this.config) {
				this.config.apiKey = apiKey.trim();
			}
		} catch (error: unknown) {
			// Silently ignore cancellation errors during shutdown
			if (error instanceof Error && error.name === 'Canceled') {
				return;
			}
			console.error('Failed to store API key in secure storage:', error);
			throw new Error('Failed to store API key securely');
		}
	}

	/**
	 * Deletes the API key from secure storage (ASYNC - updates both cache and storage)
	 */
	public async deleteApiKey(): Promise<void> {
		// Don't access storage during disposal
		if (this.isDisposing) {
			return;
		}

		if (!this.context) {
			throw new Error('ConfigManager not initialized with context');
		}

		try {
			await this.context.secrets.delete(this.API_KEY_SECRET_KEY);

			// Update cache immediately
			if (this.config) {
				this.config.apiKey = '';
			}
		} catch (error: unknown) {
			// Silently ignore cancellation errors during shutdown
			if (error instanceof Error && error.name === 'Canceled') {
				return;
			}
			console.error('Failed to delete API key from secure storage:', error);
			throw new Error('Failed to delete API key');
		}
	}

	/**
	 * Opens the RocketRide configuration settings page
	 */
	public async openSettings(): Promise<void> {
		await vscode.commands.executeCommand('rocketride.page.settings.open');
	}

	/**
	 * Updates the host URL in settings (ASYNC - updates both cache and storage)
	 */
	public async updateHostUrl(hostUrl: string): Promise<void> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		await config.update('hostUrl', hostUrl, vscode.ConfigurationTarget.Global);

		// Cache will be updated via onDidChangeConfiguration listener
	}

	/**
	 * Updates the connection mode in settings (ASYNC - updates both cache and storage)
	 */
	public async updateConnectionMode(connectionMode: ConnectionMode): Promise<void> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		await config.update('connectionMode', connectionMode, vscode.ConfigurationTarget.Global);

		// Cache will be updated via onDidChangeConfiguration listener
	}

	/**
	 * Sets up a configuration change listener
	 * @param callback Function to call when configuration changes
	 * @returns Disposable for cleanup
	 */
	public onConfigurationChanged(callback: (config: ConfigManagerInfo) => void): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration(async event => {
			if (event.affectsConfiguration(this.configSection)) {
				const config = this.getConfig();
				callback(config);
			}
		});
	}

	/**
	 * Gets all environment variables from the .env file (SYNC)
	 * Returns a copy of the current env
	 */
	public getEnvVars(): Record<string, string> {
		return { ...this.config.env };
	}

	/**
	 * Replaces all environment variables with the provided object (ASYNC)
	 * Completely replaces config.env and saves to .env file
	 * Ensures ROCKETRIDE_URI and ROCKETRIDE_APIKEY are always present (uses settings as defaults if missing)
	 * 
	 * @param envVars Complete set of environment variables to save
	 */
	public async saveAllEnvVars(envVars: Record<string, string>): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error('No workspace folder open');
			}

			// Copy the provided env vars
			const envToSave = { ...envVars };

			// Ensure ROCKETRIDE_URI is always present (use settings as default if missing)
			if (!envToSave['ROCKETRIDE_URI']) {
				envToSave['ROCKETRIDE_URI'] = this.getApiHost();
			}

			// Ensure ROCKETRIDE_APIKEY is always present (use settings as default if missing)
			if (!envToSave['ROCKETRIDE_APIKEY']) {
				envToSave['ROCKETRIDE_APIKEY'] = this.getApiKey();
			}

			// Replace config.env completely
			this.config.env = envToSave;

			// Save to disk
			await this.saveEnvFile();

			// Notify listeners
			this.envChangeEmitter.fire(this.getEnvVars());

			console.log('[ConfigManager] Saved all environment variables');
		} catch (error) {
			console.error('[ConfigManager] Failed to save environment variables:', error);
			throw new Error(`Failed to save environment variables: ${error}`);
		}
	}

	/**
	 * Saves the current environment variables to the .env file (ASYNC)
	 * Creates the file if it doesn't exist
	 */
	private async saveEnvFile(): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error('No workspace folder open');
			}

			const workspaceRoot = workspaceFolders[0].uri.fsPath;
			const envPath = vscode.Uri.file(path.join(workspaceRoot, '.env'));

			// Build .env file content
			const lines: string[] = [];
			for (const [key, value] of Object.entries(this.config.env)) {
				// Quote values that contain spaces or special characters
				const needsQuotes = /[\s#=]/.test(value);
				const quotedValue = needsQuotes ? `"${value}"` : value;
				lines.push(`${key}=${quotedValue}`);
			}

			// Write to file
			const content = lines.join('\n');
			await vscode.workspace.fs.writeFile(envPath, Buffer.from(content, 'utf8'));

		} catch (error) {
			console.error('Error saving .env file:', error);
			throw new Error(`Failed to save .env file: ${error}`);
		}
	}

	/**
	 * Ensures .env file exists in workspace with ROCKETRIDE_URI and ROCKETRIDE_APIKEY
	 * Creates the file if it doesn't exist, or ensures required vars are present
	 * Safe to call when no workspace is open - just returns early
	 */
	private async ensureEnvFileSync(): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				// No workspace open - this is OK, just return
				return;
			}

			const workspaceRoot = workspaceFolders[0].uri.fsPath;
			const envPath = vscode.Uri.file(path.join(workspaceRoot, '.env'));

			// Check if .env file exists
			let fileExists = false;
			try {
				await vscode.workspace.fs.stat(envPath);
				fileExists = true;
			} catch {
				fileExists = false;
			}

			let needsSave = false;

			// Create file or ensure required vars are present
			if (!fileExists) {
				console.log('[ConfigManager] Creating initial .env file');
				this.config.env['ROCKETRIDE_URI'] = this.getApiHost();
				this.config.env['ROCKETRIDE_APIKEY'] = this.getApiKey();
				needsSave = true;
			} else {
				// File exists, ensure ROCKETRIDE_URI and ROCKETRIDE_APIKEY are present
				if (!this.config.env['ROCKETRIDE_URI']) {
					console.log('[ConfigManager] Adding missing ROCKETRIDE_URI to .env file');
					this.config.env['ROCKETRIDE_URI'] = this.getApiHost();
					needsSave = true;
				}
				if (!this.config.env['ROCKETRIDE_APIKEY']) {
					console.log('[ConfigManager] Adding missing ROCKETRIDE_APIKEY to .env file');
					this.config.env['ROCKETRIDE_APIKEY'] = this.getApiKey();
					needsSave = true;
				}
			}

			if (needsSave) {
				await this.saveEnvFile();
				console.log('[ConfigManager] Ensured .env file has ROCKETRIDE_URI and ROCKETRIDE_APIKEY');
			}
		} catch (error) {
			console.error('[ConfigManager] Failed to ensure .env file sync:', error);
			// Don't throw - this shouldn't block other operations
		}
	}

	/**
	 * Updates ROCKETRIDE_URI and/or ROCKETRIDE_APIKEY in .env file when settings change
	 * Preserves all other environment variables
	 * Called when hostUrl or apiKey settings are updated
	 */
	private async syncSettingsToEnv(): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				return;
			}

			const uri = this.getApiHost();
			const apiKey = this.getApiKey();

			let needsUpdate = false;

			// Update ROCKETRIDE_URI if different
			if (this.config.env['ROCKETRIDE_URI'] !== uri) {
				this.config.env['ROCKETRIDE_URI'] = uri;
				needsUpdate = true;
			}

			// Update ROCKETRIDE_APIKEY if different
			if (this.config.env['ROCKETRIDE_APIKEY'] !== apiKey) {
				this.config.env['ROCKETRIDE_APIKEY'] = apiKey;
				needsUpdate = true;
			}

			if (needsUpdate) {
				await this.saveEnvFile();
				this.envChangeEmitter.fire(this.getEnvVars());
				console.log('[ConfigManager] Synced ROCKETRIDE_URI/APIKEY to .env file');
			}
		} catch (error) {
			console.error('[ConfigManager] Failed to sync settings to .env:', error);
		}
	}

	/**
	 * Mark as disposing to prevent operations during shutdown
	 */
	public dispose(): void {
		this.isDisposing = true;

		// Dispose the event emitter
		this.envChangeEmitter.dispose();

		// Dispose all resources
		this.disposables.forEach(disposable => {
			try {
				disposable.dispose();
			} catch (error) {
				console.error('Error disposing ConfigManager resource:', error);
			}
		});
		this.disposables = [];
	}
}
