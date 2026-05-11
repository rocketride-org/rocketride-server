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

export type ConnectionMode = 'cloud' | 'docker' | 'service' | 'onprem' | 'local';

/** Which settings group a connection reads from. */
export type ConnectionGroup = 'development' | 'deployment';

/** Symmetric per-group connection config. Both groups have identical shape. */
export interface ConnectionGroupConfig {
	/** Connection mode (null only valid for deployment = shared with dev) */
	connectionMode: ConnectionMode | null;

	/** Server host URL */
	hostUrl: string;

	/** API key for authentication (from secure storage) */
	apiKey: string;

	/** Cloud team ID */
	teamId: string;

	/** Local engine configuration */
	local: {
		/** Engine version: 'latest', 'prerelease', or a specific tag */
		engineVersion: string;
		/** Enable full debug output (--trace=debugOut) */
		debugOutput: boolean;
		/** Additional engine arguments (passed to engine subprocess) */
		engineArgs: string;
	};
}

/** Top-level cached config with nested per-group settings. */
export interface ConfigManagerInfo {
	/** Development connection settings */
	development: ConnectionGroupConfig;

	/** Deployment connection settings (connectionMode=null means shared with dev) */
	deployment: ConnectionGroupConfig;

	/** Default path for creating new pipeline files */
	defaultPipelinePath: string;

	/** Pipeline restart behavior when .pipe files change */
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';

	/** Environment variables loaded from .env file */
	env: Record<string, string>;
}

/** Per-group settings sent from the Settings UI on save. */
export interface ConnectionGroupSnapshot {
	connectionMode: ConnectionMode | null;
	hostUrl: string;
	apiKey: string;
	teamId: string;
	local: {
		engineVersion: string;
		debugOutput: boolean;
		engineArgs: string;
	};
}

/**
 * Full settings snapshot sent from the Settings UI on save.
 * Maps 1:1 with SettingsData from the webview.  ConfigManager writes all
 * fields atomically and refreshes its cache once.
 */
export interface SettingsSnapshot {
	development: ConnectionGroupSnapshot;
	deployment: ConnectionGroupSnapshot;
	defaultPipelinePath: string;
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';
	envVars?: Record<string, string>;
	autoAgentIntegration: boolean;
	integrationCopilot: boolean;
	integrationClaudeCode: boolean;
	integrationCursor: boolean;
	integrationWindsurf: boolean;
	integrationClaudeMd: boolean;
	integrationAgentsMd: boolean;
}

/**
 * Configuration manager class providing centralized access to RocketRide settings
 */
export class ConfigManager {
	private static instance: ConfigManager;
	private readonly configSection = 'rocketride';

	private context?: vscode.ExtensionContext;
	private isDisposing: boolean = false;
	private envFileWatcher?: vscode.FileSystemWatcher;
	private disposables: vscode.Disposable[] = [];
	private envRawText: string = '';
	/** While true, config-change listeners are suppressed (inside applyAllSettings). */
	private isBatchApplying: boolean = false;
	private envChangeEmitter = new vscode.EventEmitter<Record<string, string>>();
	public readonly onEnvVarsChanged = this.envChangeEmitter.event;

	/** Default per-group config. */
	private static readonly DEFAULT_GROUP: ConnectionGroupConfig = {
		connectionMode: 'local',
		hostUrl: '',
		apiKey: '',
		teamId: '',
		local: { engineVersion: 'latest', debugOutput: false, engineArgs: '' },
	};

	// Cached configuration
	private config: ConfigManagerInfo = {
		development: { ...ConfigManager.DEFAULT_GROUP, connectionMode: 'local' },
		deployment: { ...ConfigManager.DEFAULT_GROUP, connectionMode: null },
		defaultPipelinePath: '',
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

		// Listen for configuration changes (suppressed during applyAllSettings)
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(async (event) => {
				if (this.isBatchApplying) return;
				if (event.affectsConfiguration(this.configSection)) {
					await this.refreshConfig();

					// If dev hostUrl changed, sync to .env
					if (event.affectsConfiguration(`${this.configSection}.development.hostUrl`) || event.affectsConfiguration(`${this.configSection}.development.connectionMode`)) {
						await this.syncSettingsToEnv();
					}
				}
			})
		);

		// Listen for secret storage changes (suppressed during applyAllSettings)
		this.disposables.push(
			context.secrets.onDidChange(async (event) => {
				if (this.isBatchApplying) return;
				if (event.key === 'rocketride.development.apiKey') {
					await this.refreshConfig();
					// API key changed, sync to .env
					await this.syncSettingsToEnv();
				}
				if (event.key === 'rocketride.deployment.apiKey') {
					await this.refreshConfig();
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
	 * Refreshes a single group's config from VS Code settings + secure storage.
	 * Applies identical fallback logic for both groups:
	 *   - docker/service → localhost + env API key
	 *   - cloud → ROCKETRIDE_URI fallback
	 */
	private async refreshGroupConfig(group: ConnectionGroup): Promise<ConnectionGroupConfig> {
		const gc = vscode.workspace.getConfiguration(`${this.configSection}.${group}`);
		const defaultMode = group === 'development' ? 'local' : null;
		const connectionMode = gc.get<ConnectionMode | null>('connectionMode', defaultMode);
		let hostUrl = gc.get<string>('hostUrl', '');
		let apiKey = await this.getApiKeyFromStorage(group);
		const env = this.config?.env || {};

		// Docker/Service: fixed URL and API key from env
		if (connectionMode === 'docker' || connectionMode === 'service') {
			hostUrl = 'http://localhost:5565';
			apiKey = env.ROCKETRIDE_APIKEY || 'MYAPIKEY';
		}

		// Cloud: fall back to ROCKETRIDE_URI when hostUrl is not set
		if (connectionMode === 'cloud' && !hostUrl) {
			hostUrl = env.ROCKETRIDE_URI || 'http://localhost:5565';
		}

		return {
			connectionMode,
			hostUrl,
			apiKey,
			teamId: gc.get<string>('teamId', ''),
			local: {
				engineVersion: gc.get<string>('local.engineVersion', 'latest'),
				debugOutput: gc.get<boolean>('local.debugOutput', false),
				engineArgs: gc.get<string>('local.engineArgs', ''),
			},
		};
	}

	/**
	 * Refreshes the cached configuration from all sources.
	 */
	private async refreshConfig(): Promise<void> {
		// Ensure env is loaded (preserve existing env if already loaded)
		const existingEnv = this.config?.env || {};
		if (Object.keys(existingEnv).length === 0) {
			await this.loadEnvFile();
		}

		const config = vscode.workspace.getConfiguration(this.configSection);

		this.config = {
			development: await this.refreshGroupConfig('development'),
			deployment: await this.refreshGroupConfig('deployment'),
			defaultPipelinePath: config.get('defaultPipelinePath', 'pipelines'),
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
					this.refreshConfig();
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
					this.refreshConfig();
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
	 * Gets the API key from secure storage for the given group.
	 */
	private async getApiKeyFromStorage(group: ConnectionGroup): Promise<string> {
		if (this.isDisposing) return '';
		if (!this.context) {
			console.warn('ConfigManager not initialized with context - cannot access secure storage');
			return '';
		}
		try {
			const key = `rocketride.${group}.apiKey`;
			return (await this.context.secrets.get(key)) || '';
		} catch (error: unknown) {
			if (error instanceof Error && error.name === 'Canceled') return '';
			console.error(`Failed to retrieve ${group} API key from secure storage:`, error);
			return '';
		}
	}

	/**
	 * Gets the current RocketRide configuration (SYNC)
	 */
	public getConfig(): ConfigManagerInfo {
		// Return a deep copy to prevent external modifications
		return {
			development: { ...this.config.development, local: { ...this.config.development.local } },
			deployment: { ...this.config.deployment, local: { ...this.config.deployment.local } },
			defaultPipelinePath: this.config.defaultPipelinePath,
			pipelineRestartBehavior: this.config.pipelineRestartBehavior,
			env: { ...this.config.env },
		};
	}

	/**
	 * Gets the development API key (SYNC - from cache).
	 * Used for .env sync and backward-compatible accessors.
	 */
	public getApiKey(): string {
		return this.config.development.apiKey;
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
	 * Checks if development API key is stored (SYNC)
	 */
	public hasApiKey(): boolean {
		return this.getApiKey().length > 0;
	}

	/**
	 * Gets the WebSocket URL based on development connection config (SYNC)
	 */
	public getWebSocketUrl(): string {
		const url = new URL(RocketRideClient.normalizeUri(this.config.development.hostUrl));
		const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsPort = url.port || (url.protocol === 'https:' ? '443' : '80');

		return `${wsProtocol}//${url.hostname}:${wsPort}/task/service`;
	}

	/**
	 * Gets the HTTP/HTTPS URL based on development connection config (SYNC)
	 */
	public getHttpUrl(): string {
		const url = new URL(RocketRideClient.normalizeUri(this.config.development.hostUrl));
		const httpProtocol = url.protocol;
		const httpPort = url.port || (url.protocol === 'https:' ? '443' : '80');

		return `${httpProtocol}//${url.hostname}:${httpPort}`;
	}

	/**
	 * Returns the engine args as an array for the given group, injecting
	 * --trace=debugOut if debug output is enabled and the user hasn't
	 * specified their own --trace.
	 *
	 * Note: engineArgs is passed as a single string intentionally. The backend
	 * engine splits all arguments according to shell parsing rules (handling
	 * quoted paths, escaped spaces, etc.). Naive whitespace splitting here
	 * would break arguments like --path='C:\Program Files\RocketRide'.
	 */
	public getEngineArgs(group: ConnectionGroup = 'development'): string[] {
		const gc = this.getConfig()[group];
		const rawArgs = gc.local.engineArgs;
		const argsStr = Array.isArray(rawArgs) ? rawArgs.join(' ') : String(rawArgs || '');
		const hasTrace = argsStr.includes('--trace=');

		const result: string[] = [];
		if (argsStr.trim()) {
			result.push(argsStr.trim());
		}
		if (gc.local.debugOutput && !hasTrace) {
			result.push('--trace=debugOut');
		}
		return result;
	}

	/**
	 * Gets the development API host URL for .env sync and dynamic parameter
	 * replacement (SYNC).
	 */
	public getApiHost(): string {
		const dev = this.config.development;
		// On-prem always uses the user-provided hostUrl.
		// All other modes fall back to ROCKETRIDE_URI when hostUrl is empty.
		return dev.hostUrl || (dev.connectionMode === 'onprem' ? '' : this.config.env.ROCKETRIDE_URI || 'http://localhost:5565');
	}

	/**
	 * Validates a group's configuration (SYNC).
	 * @returns Array of validation error messages, empty if valid
	 */
	public validateGroupConfig(group: ConnectionGroup = 'development'): string[] {
		const gc = this.getConfig()[group];
		const errors: string[] = [];
		const label = group === 'development' ? 'Development' : 'Deployment';

		if (gc.connectionMode === 'cloud') {
			if (!gc.hostUrl) {
				errors.push(`${label}: Cloud URL is required when using cloud mode`);
			} else {
				try {
					new URL(RocketRideClient.normalizeUri(gc.hostUrl));
				} catch {
					errors.push(`${label}: Cloud URL must be a valid URL (e.g., https://cloud.rocketride.ai)`);
				}
			}
		} else if (gc.connectionMode === 'onprem') {
			if (!gc.hostUrl) {
				errors.push(`${label}: Host URL is required when using on-prem mode`);
			} else {
				try {
					new URL(RocketRideClient.normalizeUri(gc.hostUrl));
				} catch {
					errors.push(`${label}: Host URL must be a valid URL`);
				}
			}
		}
		// local/docker/service — no validation needed

		return errors;
	}

	/**
	 * Stores the API key in secure storage for the given group.
	 */
	public async setApiKey(group: ConnectionGroup, apiKey: string): Promise<void> {
		if (this.isDisposing) return;
		if (!this.context) {
			throw new Error('ConfigManager not initialized with context - cannot access secure storage');
		}

		const key = `rocketride.${group}.apiKey`;
		try {
			if (apiKey.trim()) {
				await this.context.secrets.store(key, apiKey.trim());
			} else {
				await this.context.secrets.delete(key);
			}
			// Update cache immediately
			if (this.config) {
				this.config[group].apiKey = apiKey.trim();
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.name === 'Canceled') return;
			console.error(`Failed to store ${group} API key in secure storage:`, error);
			throw new Error(`Failed to store ${group} API key securely`);
		}
	}

	/**
	 * Deletes the API key from secure storage for the given group.
	 */
	public async deleteApiKey(group: ConnectionGroup): Promise<void> {
		if (this.isDisposing) return;
		if (!this.context) {
			throw new Error('ConfigManager not initialized with context');
		}

		const key = `rocketride.${group}.apiKey`;
		try {
			await this.context.secrets.delete(key);
			if (this.config) {
				this.config[group].apiKey = '';
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.name === 'Canceled') return;
			console.error(`Failed to delete ${group} API key from secure storage:`, error);
			throw new Error(`Failed to delete ${group} API key`);
		}
	}

	// =========================================================================
	// ATOMIC SETTINGS APPLY (used by Settings UI save)
	// =========================================================================

	/**
	 * Writes every setting from the Settings UI in one transaction.
	 *
	 * 1. Suppresses all intermediate config-change listeners so no
	 *    connection manager reacts to half-written state.
	 * 2. Persists VS Code settings, secure-storage keys, and .env file.
	 * 3. Refreshes the in-memory cache once from the final state.
	 * 4. Syncs .env with final hostUrl/apiKey.
	 *
	 * The caller is responsible for explicitly driving connection transitions
	 * after this method returns (the normal debounced handlers are suppressed).
	 */
	public async applyAllSettings(s: SettingsSnapshot): Promise<void> {
		if (!this.context) {
			throw new Error('ConfigManager not initialized with context');
		}

		this.isBatchApplying = true;
		try {
			const wc = vscode.workspace.getConfiguration(this.configSection);

			// --- Development group ---
			await wc.update('development.connectionMode', s.development.connectionMode, vscode.ConfigurationTarget.Global);
			await wc.update('development.hostUrl', s.development.hostUrl, vscode.ConfigurationTarget.Global);
			await wc.update('development.teamId', s.development.teamId, vscode.ConfigurationTarget.Global);
			await wc.update('development.local.engineVersion', s.development.local.engineVersion, vscode.ConfigurationTarget.Global);
			await wc.update('development.local.debugOutput', s.development.local.debugOutput, vscode.ConfigurationTarget.Global);
			await wc.update('development.local.engineArgs', s.development.local.engineArgs, vscode.ConfigurationTarget.Global);

			// --- Deployment group ---
			await wc.update('deployment.connectionMode', s.deployment.connectionMode, vscode.ConfigurationTarget.Global);
			await wc.update('deployment.hostUrl', s.deployment.hostUrl, vscode.ConfigurationTarget.Global);
			await wc.update('deployment.teamId', s.deployment.teamId, vscode.ConfigurationTarget.Global);
			await wc.update('deployment.local.engineVersion', s.deployment.local.engineVersion, vscode.ConfigurationTarget.Global);
			await wc.update('deployment.local.debugOutput', s.deployment.local.debugOutput, vscode.ConfigurationTarget.Global);
			await wc.update('deployment.local.engineArgs', s.deployment.local.engineArgs, vscode.ConfigurationTarget.Global);

			// --- Global settings ---
			await wc.update('defaultPipelinePath', s.defaultPipelinePath, vscode.ConfigurationTarget.Global);
			await wc.update('pipelineRestartBehavior', s.pipelineRestartBehavior, vscode.ConfigurationTarget.Global);

			// --- Integration settings ---
			await wc.update('integrations.autoAgentIntegration', s.autoAgentIntegration, vscode.ConfigurationTarget.Global);
			await wc.update('integrations.copilot', s.integrationCopilot, vscode.ConfigurationTarget.Global);
			await wc.update('integrations.claudeCode', s.integrationClaudeCode, vscode.ConfigurationTarget.Global);
			await wc.update('integrations.cursor', s.integrationCursor, vscode.ConfigurationTarget.Global);
			await wc.update('integrations.windsurf', s.integrationWindsurf, vscode.ConfigurationTarget.Global);
			await wc.update('integrations.claudeMd', s.integrationClaudeMd, vscode.ConfigurationTarget.Global);
			await wc.update('integrations.agentsMd', s.integrationAgentsMd, vscode.ConfigurationTarget.Global);

			// --- Secure storage (per-group API keys) ---
			await this.setApiKey('development', s.development.apiKey);
			await this.setApiKey('deployment', s.deployment.apiKey);

			// --- .env file ---
			if (s.envVars !== undefined) {
				await this.saveAllEnvVars(s.envVars);
			}

			// --- Single cache refresh from final state ---
			await this.refreshConfig();

			// --- Sync .env with final hostUrl/apiKey ---
			await this.syncSettingsToEnv();
		} catch (error) {
			// Refresh cache even on failure so subsequent reads see persisted writes
			await this.refreshConfig();
			throw error;
		} finally {
			this.isBatchApplying = false;
		}
	}

	/**
	 * Opens the RocketRide configuration settings page
	 */
	public async openSettings(): Promise<void> {
		await vscode.commands.executeCommand('rocketride.page.settings.open');
	}

	/**
	 * Updates the host URL for a group (ASYNC).
	 */
	public async updateHostUrl(group: ConnectionGroup, hostUrl: string): Promise<void> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		await config.update(`${group}.hostUrl`, hostUrl, vscode.ConfigurationTarget.Global);
	}

	/**
	 * Updates the connection mode for a group (ASYNC).
	 */
	public async updateConnectionMode(group: ConnectionGroup, connectionMode: ConnectionMode | null): Promise<void> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		await config.update(`${group}.connectionMode`, connectionMode, vscode.ConfigurationTarget.Global);
	}

	/**
	 * Sets the team ID in cache only for a group (runtime, not persisted).
	 * Use when the sidebar changes the team at runtime.
	 */
	public setTeamId(group: ConnectionGroup, teamId: string): void {
		this.config[group].teamId = teamId;
	}

	/**
	 * Updates the team ID for a group (ASYNC - updates both cache and storage).
	 */
	public async updateTeamId(group: ConnectionGroup, teamId: string): Promise<void> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		await config.update(`${group}.teamId`, teamId, vscode.ConfigurationTarget.Global);
	}

	/**
	 * Sets up a configuration change listener
	 * @param callback Function to call when configuration changes
	 * @returns Disposable for cleanup
	 */
	public onConfigurationChanged(callback: (config: ConfigManagerInfo) => void): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (this.isBatchApplying) return;
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
			return;
		}
	}

	/**
	 * Syncs ROCKETRIDE_URI and ROCKETRIDE_APIKEY in .env from the development
	 * connection settings.  Preserves all other environment variables.
	 */
	private async syncSettingsToEnv(): Promise<void> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				return;
			}

			const uri = this.getApiHost();
			const apiKey = this.config.development.apiKey;

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
			return;
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
