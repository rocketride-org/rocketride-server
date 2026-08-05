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
import { RocketRideClient } from 'rocketride';
import { isShadowedByAnyScope, isUnchanged } from './shared/util/workspaceOverride';

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

	/** Local engine configuration */
	local: {
		/** Engine version: 'latest', 'prerelease', or a specific tag */
		engineVersion: string;
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

	/** Default idle-timeout (seconds) for runs without a per-pipeline override; 0 = no timeout. */
	pipelineTtl: number;

	/** Default trace verbosity for runs without a per-pipeline override. */
	pipelineTraceLevel: 'none' | 'metadata' | 'summary' | 'full';

	/** Additional command-line arguments passed to each pipeline task via `.use`. */
	taskArguments: string;

	/** Enable full debug output for pipeline tasks (--trace=debugOut via `.use` args). */
	pipelineDebugOutput: boolean;
}

/** Per-group settings sent from the Settings UI on save. */
export interface ConnectionGroupSnapshot {
	connectionMode: ConnectionMode | null;
	hostUrl: string;
	apiKey: string;
	local: {
		engineVersion: string;
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
	pipelineTtl: number;
	pipelineTraceLevel: 'none' | 'metadata' | 'summary' | 'full';
	taskArguments: string;
	pipelineDebugOutput: boolean;
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
	private disposables: vscode.Disposable[] = [];
	/** While true, config-change listeners are suppressed (inside applyAllSettings). */
	private isBatchApplying: boolean = false;

	/** Default per-group config. */
	private static readonly DEFAULT_GROUP: ConnectionGroupConfig = {
		connectionMode: 'local',
		hostUrl: '',
		apiKey: '',
		local: { engineVersion: 'latest' },
	};

	// Cached configuration
	private config: ConfigManagerInfo = {
		development: { ...ConfigManager.DEFAULT_GROUP, connectionMode: 'local' },
		deployment: { ...ConfigManager.DEFAULT_GROUP, connectionMode: null },
		defaultPipelinePath: '',
		pipelineRestartBehavior: 'prompt',
		pipelineTtl: 900,
		pipelineTraceLevel: 'full',
		taskArguments: '',
		pipelineDebugOutput: false,
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

		// Load initial config
		await this.refreshConfig();

		// Listen for configuration changes (suppressed during applyAllSettings)
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(async (event) => {
				if (this.isBatchApplying) return;
				if (event.affectsConfiguration(this.configSection)) {
					await this.refreshConfig();
				}
			})
		);

		// Listen for secret storage changes (suppressed during applyAllSettings)
		this.disposables.push(
			context.secrets.onDidChange(async (event) => {
				if (this.isBatchApplying) return;
				if (event.key === 'rocketride.development.apiKey' || event.key === 'rocketride.deployment.apiKey') {
					await this.refreshConfig();
				}
			})
		);

		// Listen for workspace folder changes
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(async () => {
				await this.refreshConfig();
			})
		);
	}

	/**
	 * Refreshes a single group's config from VS Code settings + secure storage.
	 * Applies identical fallback logic for both groups:
	 *   - docker/service → localhost + default API key
	 *   - cloud → build-time ROCKETRIDE_URI fallback
	 */
	private async refreshGroupConfig(group: ConnectionGroup): Promise<ConnectionGroupConfig> {
		const gc = vscode.workspace.getConfiguration(`${this.configSection}.${group}`);
		const defaultMode = group === 'development' ? 'local' : null;
		const connectionMode = gc.get<ConnectionMode | null>('connectionMode', defaultMode);
		let hostUrl = gc.get<string>('hostUrl', '');
		let apiKey = await this.getApiKeyFromStorage(group);

		// Cloud: build-time URI — ignore any stale hostUrl from other modes
		if (connectionMode === 'cloud') {
			hostUrl = process.env.ROCKETRIDE_URI || 'https://api.rocketride.ai';
		}

		return {
			connectionMode,
			hostUrl,
			apiKey,
			local: {
				engineVersion: gc.get<string>('local.engineVersion', 'latest'),
			},
		};
	}

	/**
	 * Refreshes the cached configuration from all sources (VS Code settings
	 * and secure storage). Public so that callers like applyAllSettings() and
	 * EngineRegistry can force a cache refresh after external writes.
	 */
	public async refreshConfig(): Promise<void> {
		const config = vscode.workspace.getConfiguration(this.configSection);

		this.config = {
			development: await this.refreshGroupConfig('development'),
			deployment: await this.refreshGroupConfig('deployment'),
			defaultPipelinePath: config.get('defaultPipelinePath', 'pipelines'),
			pipelineRestartBehavior: config.get('pipelineRestartBehavior', 'prompt'),
			pipelineTtl: config.get('pipelineTTL', 900),
			pipelineTraceLevel: config.get('pipelineTraceLevel', 'full'),
			taskArguments: config.get('taskArguments', ''),
			pipelineDebugOutput: config.get('pipelineDebugOutput', false),
		};
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
			pipelineTtl: this.config.pipelineTtl,
			pipelineTraceLevel: this.config.pipelineTraceLevel,
			taskArguments: this.config.taskArguments,
			pipelineDebugOutput: this.config.pipelineDebugOutput,
		};
	}

	/**
	 * Returns a numeric checksum (DJB2 hash) of a group's config.
	 * Used by the EngineRegistry reconciler to detect config changes
	 * (API key, host URL, connection mode, etc.) without carrying
	 * around sensitive values. When the checksum changes between
	 * reconcile cycles, the registry restarts the affected engine.
	 *
	 * @param group - Which connection group to checksum.
	 * @returns A 32-bit integer hash of the serialized group config.
	 */
	public getGroupChecksum(group: ConnectionGroup): number {
		const gc = this.config[group];
		// Serialize the full group config to a stable string for hashing.
		// JSON.stringify order is deterministic for objects created by us.
		const str = JSON.stringify(gc);
		// DJB2 hash — fast, good distribution for short strings
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
		}
		return hash;
	}

	/**
	 * Gets the development API key (SYNC - from cache).
	 */
	public getApiKey(): string {
		return this.config.development.apiKey;
	}

	/**
	 * Checks if development API key is stored (SYNC)
	 */
	public hasApiKey(): boolean {
		return this.getApiKey().length > 0;
	}

	/**
	 * Returns the per-task arguments passed to `.use` when executing a pipe,
	 * injecting --trace=debugOut if pipeline debug output is enabled and the
	 * user hasn't specified their own --trace.
	 *
	 * Note: taskArguments is passed as a single string intentionally. The
	 * backend engine splits all arguments according to shell parsing rules
	 * (handling quoted paths, escaped spaces, etc.). Naive whitespace splitting
	 * here would break arguments like --path='C:\Program Files\RocketRide'.
	 */
	public getTaskArgs(): string[] {
		const cfg = this.getConfig();
		const argsStr = String(cfg.taskArguments || '');
		const hasTrace = argsStr.includes('--trace=');

		const result: string[] = [];
		if (argsStr.trim()) {
			result.push(argsStr.trim());
		}
		if (cfg.pipelineDebugOutput && !hasTrace) {
			result.push('--trace=debugOut');
		}
		return result;
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
					errors.push(`${label}: Cloud URL must be a valid URL (e.g., https://api.rocketride.ai)`);
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
	 * 2. Persists VS Code settings and secure-storage keys.
	 * 3. Refreshes the in-memory cache once from the final state.
	 *
	 * The caller is responsible for explicitly driving connection transitions
	 * after this method returns (the normal debounced handlers are suppressed).
	 *
	 * Keys whose submitted value already matches the effective one are skipped
	 * entirely: the UI round-trips every key on save, and writing an untouched
	 * one would persist a workspace-pinned value into the user's Global settings.
	 *
	 * @returns `shadowedKeys` — the keys whose Global write is masked by a
	 *   conflicting workspace or workspace-folder value, so the change will not
	 *   take effect in this window. The masking value lives in the workspace's
	 *   `.code-workspace` file or in a folder's `.vscode/settings.json`,
	 *   depending on which scope set it. The caller surfaces this to the user
	 *   instead of a misleading "saved" confirmation.
	 */
	public async applyAllSettings(s: SettingsSnapshot): Promise<{ shadowedKeys: string[] }> {
		if (!this.context) {
			throw new Error('ConfigManager not initialized with context');
		}

		this.isBatchApplying = true;
		try {
			const wc = vscode.workspace.getConfiguration(this.configSection);
			const shadowedKeys: string[] = [];

			// An unscoped getConfiguration() cannot resolve folder-level settings,
			// so inspect each workspace folder as well — otherwise a `.vscode/`
			// override in a multi-root workspace masks the write unreported.
			const folders = vscode.workspace.workspaceFolders ?? [];
			const inspectAllScopes = (key: string) => [wc.inspect(key), ...folders.map((folder) => vscode.workspace.getConfiguration(this.configSection, folder.uri).inspect(key))];

			const write = async (key: string, value: unknown): Promise<void> => {
				// A key the caller never supplied (the Welcome page renders a subset
				// of the Settings page) arrives as undefined, and `update(key,
				// undefined)` *removes* the user's value. Never let a form erase a
				// setting it does not show. `null` is a real value here — a null
				// deployment.connectionMode means "share the development one".
				if (value === undefined) {
					return;
				}
				// The Settings UI is populated with effective values, so untouched
				// keys round-trip back here unchanged. Writing them would copy a
				// workspace-pinned value into the user's Global settings and change
				// it for every other window — the divergence this feature prevents.
				if (isUnchanged(wc.get(key), value)) {
					return;
				}
				// Record when a conflicting workspace-level value masks the write.
				if (isShadowedByAnyScope(inspectAllScopes(key), value)) {
					shadowedKeys.push(`${this.configSection}.${key}`);
				}
				await wc.update(key, value, vscode.ConfigurationTarget.Global);
			};

			// --- Development group ---
			await write('development.connectionMode', s.development.connectionMode);
			await write('development.hostUrl', s.development.hostUrl);
			await write('development.local.engineVersion', s.development.local.engineVersion);

			// --- Deployment group ---
			await write('deployment.connectionMode', s.deployment.connectionMode);
			await write('deployment.hostUrl', s.deployment.hostUrl);
			await write('deployment.local.engineVersion', s.deployment.local.engineVersion);

			// --- Global settings ---
			await write('defaultPipelinePath', s.defaultPipelinePath);
			await write('pipelineRestartBehavior', s.pipelineRestartBehavior);

			// --- Pipeline execution defaults ---
			await write('pipelineTTL', s.pipelineTtl);
			await write('pipelineTraceLevel', s.pipelineTraceLevel);
			await write('taskArguments', s.taskArguments);
			await write('pipelineDebugOutput', s.pipelineDebugOutput);

			// --- Integration settings ---
			await write('integrations.autoAgentIntegration', s.autoAgentIntegration);
			await write('integrations.copilot', s.integrationCopilot);
			await write('integrations.claudeCode', s.integrationClaudeCode);
			await write('integrations.cursor', s.integrationCursor);
			await write('integrations.windsurf', s.integrationWindsurf);
			await write('integrations.claudeMd', s.integrationClaudeMd);
			await write('integrations.agentsMd', s.integrationAgentsMd);

			// --- Secure storage (per-group API keys) ---
			await this.setApiKey('development', s.development.apiKey);
			await this.setApiKey('deployment', s.deployment.apiKey);

			// --- Single cache refresh from final state ---
			await this.refreshConfig();

			return { shadowedKeys };
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
	 * Mark as disposing to prevent operations during shutdown
	 */
	public dispose(): void {
		this.isDisposing = true;

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
