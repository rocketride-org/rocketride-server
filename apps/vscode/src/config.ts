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
 * config.ts - RocketRide Extension Configuration Management with Secure Storage and Webview Integration
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { RocketRideClient } from 'rocketride';
import { buildEffectiveEngineArgs } from './shared/util/engineArgs';

export type ConnectionMode = 'cloud' | 'onprem' | 'local';

export interface ConfigManagerInfo {
	/** Connection mode: cloud (RocketRide.ai), onprem (your server), or local (localhost port) */
	connectionMode: ConnectionMode;

	/** API key for authentication (retrieved from secure storage) */
	apiKey: string;

	/** overall url  */
	hostUrl: string;

	/** Default path for creating new pipeline files */
	defaultPipelinePath: string;

	/** Additional engine arguments as a single string (passed to engine subprocess) */
	engineArgs: string;

	/** Local configuration */
	local: {
		/** Engine version to download: 'latest', 'prerelease', or a specific tag */
		engineVersion: string;
		/** Enable full debug output (--trace=servicePython) */
		debugOutput: boolean;
	};

	/** General settings */
	autoConnect: boolean;

	/** Pipeline restart behavior when .pipe files change */
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';

	/** Environment variables loaded from .env file */
	env: Record<string, string>;
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
	private envRawText: string = '';
	private envChangeEmitter = new vscode.EventEmitter<Record<string, string>>();
	public readonly onEnvVarsChanged = this.envChangeEmitter.event;

	// Cached configuration
	private config: ConfigManagerInfo = {
		connectionMode: 'local',
		apiKey: '',
		hostUrl: 'http://localhost:5565',
		defaultPipelinePath: '',
		engineArgs: '',
		local: {
			engineVersion: 'latest',
			debugOutput: false,
		},
		autoConnect: true,
		pipelineRestartBehavior: 'prompt',
		env: {},
	};

	private constructor() {}

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
			vscode.workspace.onDidChangeConfiguration(async (event) => {
				if (event.affectsConfiguration(this.configSection)) {
					await this.refreshConfig();

					// If hostUrl or connectionMode changed, sync to .env
					if (event.affectsConfiguration(`${this.configSection}.hostUrl`) || event.affectsConfiguration(`${this.configSection}.connectionMode`)) {
						await this.syncSettingsToEnv();
					}
				}
			})
		);

		// Listen for secret storage changes (API key changes)
		this.disposables.push(
			context.secrets.onDidChange(async (event) => {
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
			defaultPipelinePath: config.get('defaultPipelinePath', 'pipelines'),
			engineArgs: config.get('engineArgs', ''),
			local: {
				engineVersion: config.get('local.engineVersion', 'latest'),
				debugOutput: config.get('local.debugOutput', false),
			},
			autoConnect: config.get('autoConnect', true),
			pipelineRestartBehavior: config.get('pipelineRestartBehavior', 'prompt'),
			env: this.config?.env || {},
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
			this.loadEnvFile()
				.then(async () => {
					await this.refreshConfig();
					// Ensure required vars are present after manual edit
					await this.ensureEnvFileSync();
					// Notify listeners that env vars have changed
					this.envChangeEmitter.fire(this.getEnvVars());
				})
				.catch((error) => {
					console.error('Failed to reload .env file:', error);
				});
		});

		// Watch for creation
		this.envFileWatcher.onDidCreate(() => {
			this.loadEnvFile()
				.then(async () => {
					await this.refreshConfig();
					// Ensure required vars are present in new file
					await this.ensureEnvFileSync();
					// Notify listeners that env vars have changed
					this.envChangeEmitter.fire(this.getEnvVars());
				})
				.catch((error) => {
					console.error('Failed to load .env file after creation:', error);
				});
		});

		// Watch for deletion
		this.envFileWatcher.onDidDelete(() => {
			this.envRawText = '';
			if (this.config) {
				this.config.env = {};
			}
			this.refreshConfig()
				.then(async () => {
					// Recreate .env file with required vars
					await this.ensureEnvFileSync();
					// Notify listeners that env vars have changed
					this.envChangeEmitter.fire(this.getEnvVars());
				})
				.catch((error) => {
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
				this.envRawText = '';
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
				this.envRawText = envText;
				const parsedEnv = this.parseEnvFile(envText);

				if (this.config) {
					this.config.env = parsedEnv;
				}
			} catch {
				// .env file doesn't exist or can't be read
				this.envRawText = '';
				if (this.config) {
					this.config.env = {};
				}
			}
		} catch (error) {
			console.error('Error loading .env file:', error);
			this.envRawText = '';
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
				if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
			return obj.map((item) => this.processEnvSubstitution(item, env));
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
			env: { ...this.config.env },
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
		const url = new URL(RocketRideClient.normalizeUri(this.config.hostUrl));
		const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsPort = url.port || (url.protocol === 'https:' ? '443' : '80');

		return `${wsProtocol}//${url.hostname}:${wsPort}/task/service`;
	}

	/**
	 * Gets the HTTP/HTTPS URL based on current configuration (SYNC)
	 */
	public getHttpUrl(): string {
		const url = new URL(RocketRideClient.normalizeUri(this.config.hostUrl));
		const httpProtocol = url.protocol;
		const httpPort = url.port || (url.protocol === 'https:' ? '443' : '80');

		return `${httpProtocol}//${url.hostname}:${httpPort}`;
	}

	/**
	 * Returns the effective engine args as an argv-style array, injecting
	 * --trace=servicePython if debug output is enabled and the user hasn't
	 * specified their own --trace. Quoted paths and escaped spaces are preserved.
	 */
	public getEffectiveEngineArgs(): string[] {
		const config = this.getConfig();
		return buildEffectiveEngineArgs(config.engineArgs, config.local.debugOutput);
	}

	/**
	 * Gets the API host URL for dynamic parameter replacement (SYNC)
	 */
	public getApiHost(): string {
		const config = this.getConfig();

		if (config.connectionMode === 'cloud' || config.connectionMode === 'onprem') {
			return config.hostUrl;
		}
		// Local mode — always return the loopback fallback for .env sync;
		// runtime resolution is handled by ConnectionManager.
		return 'http://localhost:5565';
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
					new URL(RocketRideClient.normalizeUri(config.hostUrl));
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
					new URL(RocketRideClient.normalizeUri(config.hostUrl));
				} catch {
					errors.push('Host URL must be a valid URL');
				}
			}
			if (!config.apiKey) {
				errors.push('API key is required when using on-prem mode');
			}
		} else {
			// local — port is dynamically assigned, no validation needed
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
		return vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration(this.configSection)) {
				await this.refreshConfig();
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
	 * Saves environment variables from the Settings UI.
	 * Merges with existing raw text to preserve comments and formatting.
	 * Keys present in the previous config.env but absent from envVars are treated
	 * as user-deleted and removed from the file.
	 * Ensures ROCKETRIDE_URI and ROCKETRIDE_APIKEY are always present.
	 *
	 * @param envVars Complete set of environment variables from the UI
	 */
	public async saveAllEnvVars(envVars: Record<string, string>): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error('No workspace folder open');
			}

			const updates = { ...envVars };

			// Ensure ROCKETRIDE_URI is always present
			if (!('ROCKETRIDE_URI' in updates)) {
				updates['ROCKETRIDE_URI'] = this.getApiHost();
			}

			// Ensure ROCKETRIDE_APIKEY is always present
			if (!('ROCKETRIDE_APIKEY' in updates)) {
				updates['ROCKETRIDE_APIKEY'] = this.getApiKey();
			}

			// Keys in the old config but absent from the incoming set were deleted in the UI
			const keysToRemove = new Set<string>();
			for (const key of Object.keys(this.config.env)) {
				if (!(key in updates)) {
					keysToRemove.add(key);
				}
			}

			this.config.env = updates;
			this.envRawText = this.updateEnvRawText(updates, keysToRemove);
			await this.saveEnvFile();

			this.envChangeEmitter.fire(this.getEnvVars());
		} catch (error) {
			console.error('[ConfigManager] Failed to save environment variables:', error);
		}
	}

	/**
	 * Flushes envRawText to the .env file on disk.
	 * If no raw text exists yet (new file), generates from config.env.
	 */
	private async saveEnvFile(): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error('No workspace folder open');
			}

			const workspaceRoot = workspaceFolders[0].uri.fsPath;
			const envPath = vscode.Uri.file(path.join(workspaceRoot, '.env'));

			// New file — generate from scratch
			if (!this.envRawText && Object.keys(this.config.env).length > 0) {
				const lines: string[] = [];
				for (const [key, value] of Object.entries(this.config.env)) {
					const needsQuotes = /[\s#=]/.test(value);
					const quotedValue = needsQuotes ? `"${value}"` : value;
					lines.push(`${key}=${quotedValue}`);
				}
				this.envRawText = lines.join('\n');
			}

			await vscode.workspace.fs.writeFile(envPath, Buffer.from(this.envRawText || '', 'utf8'));
		} catch (error) {
			console.error('Error saving .env file:', error);
			throw new Error(`Failed to save .env file: ${error}`);
		}
	}

	/**
	 * Patches envRawText by updating, adding, or removing keys while preserving
	 * comments, blank lines, and formatting.
	 */
	private updateEnvRawText(updates: Record<string, string>, keysToRemove?: Set<string>): string {
		const lines = this.envRawText.split('\n');
		const consumedKeys = new Set<string>();
		const resultLines: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();

			// Preserve blank lines and comments as-is
			if (!trimmed || trimmed.startsWith('#')) {
				resultLines.push(line);
				continue;
			}

			// Try to parse KEY=VALUE
			const match = trimmed.match(/^([^=]+)=(.*)$/);
			if (!match) {
				resultLines.push(line);
				continue;
			}

			const key = match[1].trim();

			// Should this key be removed?
			if (keysToRemove && keysToRemove.has(key)) {
				continue;
			}

			// Should this key be updated?
			if (key in updates) {
				const value = updates[key];
				const needsQuotes = /[\s#=]/.test(value);
				const quotedValue = needsQuotes ? `"${value}"` : value;
				resultLines.push(`${key}=${quotedValue}`);
				consumedKeys.add(key);
			} else {
				resultLines.push(line);
			}
		}

		// Append any new keys that weren't found in existing lines
		const newKeys = Object.keys(updates).filter((k) => !consumedKeys.has(k));
		if (newKeys.length > 0) {
			const lastLine = resultLines[resultLines.length - 1];
			if (lastLine !== undefined && lastLine.trim() !== '') {
				resultLines.push('');
			}
			for (const key of newKeys) {
				const value = updates[key];
				const needsQuotes = /[\s#=]/.test(value);
				const quotedValue = needsQuotes ? `"${value}"` : value;
				resultLines.push(`${key}=${quotedValue}`);
			}
		}

		return resultLines.join('\n');
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

			// Build updates for truly missing keys (use `in` — empty string is valid)
			const updates: Record<string, string> = {};

			if (!fileExists) {
				updates['ROCKETRIDE_URI'] = this.getApiHost();
				updates['ROCKETRIDE_APIKEY'] = this.getApiKey();
			} else {
				if (!('ROCKETRIDE_URI' in this.config.env)) {
					updates['ROCKETRIDE_URI'] = this.getApiHost();
				}
				if (!('ROCKETRIDE_APIKEY' in this.config.env)) {
					updates['ROCKETRIDE_APIKEY'] = this.getApiKey();
				}
			}

			if (Object.keys(updates).length > 0) {
				Object.assign(this.config.env, updates);
				this.envRawText = this.updateEnvRawText(updates);
				await this.saveEnvFile();
			}
		} catch (_error) {
			// Silently handle env file sync errors
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

			const updates: Record<string, string> = {};

			if (this.config.env['ROCKETRIDE_URI'] !== uri) {
				updates['ROCKETRIDE_URI'] = uri;
			}
			if (this.config.env['ROCKETRIDE_APIKEY'] !== apiKey) {
				updates['ROCKETRIDE_APIKEY'] = apiKey;
			}

			if (Object.keys(updates).length > 0) {
				Object.assign(this.config.env, updates);
				this.envRawText = this.updateEnvRawText(updates);
				await this.saveEnvFile();
				this.envChangeEmitter.fire(this.getEnvVars());
			}
		} catch (_error) {
			// Silently handle settings sync errors
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
		this.disposables.forEach((disposable) => {
			try {
				disposable.dispose();
			} catch (error) {
				console.error('Error disposing ConfigManager resource:', error);
			}
		});
		this.disposables = [];
	}
}
