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
 * Settings Page Provider for Extension Configuration
 *
 * Provides a full-page settings interface with multiple configuration sections:
 * - Connection settings with cloud/local mode support
 * - Pipeline configuration and default paths
 * - Local engine settings for self-hosted instances
 * - Debugging configuration options
 *
 * Manages secure storage of API keys and validates connection settings.
 */

import * as vscode from 'vscode';
import { ConfigManager, SettingsSnapshot } from '../config';
import { getConnectionManager } from '../extension';
import { AgentManager } from '../agents/agent-manager';
import { DeployManager } from '../connection/deploy-manager';
import { ConnectionMessageHandler } from './shared/connection-message-handler';

export class PageSettingsProvider {
	private disposables: vscode.Disposable[] = [];
	private configManager: ConfigManager;
	private activeWebviews: Set<vscode.Webview> = new Set();
	private connHandler: ConnectionMessageHandler;
	private _isSaving = false;
	private panel: vscode.WebviewPanel | undefined;

	/**
	 * Creates a new PageSettingsProvider
	 *
	 * @param extensionUri Extension URI for resource loading
	 */
	constructor(private readonly extensionUri: vscode.Uri) {
		this.configManager = ConfigManager.getInstance();
		this.connHandler = new ConnectionMessageHandler({
			extensionFsPath: extensionUri.fsPath,
			getActiveWebviews: () => this.activeWebviews,
		});
		this.registerCommands();
		this.setupEnvChangeListener();
	}

	/**
	 * Sets up a listener for environment variable changes
	 */
	private setupEnvChangeListener(): void {
		const envChangeListener = this.configManager.onEnvVarsChanged(() => {
			if (this._isSaving) return;
			// Reload settings in all active webviews
			this.activeWebviews.forEach((webview) => {
				this.loadAllSettings(webview);
			});
		});

		this.disposables.push(envChangeListener);
	}

	/**
	 * Registers all commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.page.settings.open', async (focus?: string) => {
				await this.openSettings(focus);
			}),

			vscode.commands.registerCommand('rocketride.page.settings.setupCredentials', async () => {
				await this.openSettings();
			}),

			vscode.commands.registerCommand('rocketride.page.settings.updateApiKey', async () => {
				await this.openSettings();
			}),

			vscode.commands.registerCommand('rocketride.page.settings.clearApiKey', async () => {
				const result = await vscode.window.showWarningMessage('Are you sure you want to clear the stored API key?', 'Yes', 'No');

				if (result === 'Yes') {
					await this.configManager.deleteApiKey();

					const connectionManager = getConnectionManager();

					// Disconnect since credentials are now invalid
					connectionManager?.disconnect();
				}
			}),
		];

		this.disposables.push(...commands);
	}

	/**
	 * Opens the settings page, or reveals it if already open
	 */
	/** Pending focus section — sent to webview after view:ready. */
	private pendingFocus?: string;

	/**
	 * Opens the settings page, optionally focused on a single section.
	 * @param focus - If set ('development' or 'deployment'), shows only that section.
	 */
	public async openSettings(focus?: string): Promise<void> {
		this.pendingFocus = focus;
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			// Panel already open — send focus update directly
			if (focus) {
				this.panel.webview.postMessage({ type: 'setFocus', focus });
			}
			return;
		}

		const panel = vscode.window.createWebviewPanel('rocketride.page.settings', 'RocketRide Settings', vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
			retainContextWhenHidden: true,
		});

		this.panel = panel;
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Track this webview for updates
		this.activeWebviews.add(panel.webview);

		// Handle messages from the webview
		const messageDisposable = panel.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready':
						await this.loadAllSettings(panel.webview);
						await this.connHandler.probeServerInfo(panel.webview);
						if (this.pendingFocus) {
							panel.webview.postMessage({ type: 'setFocus', focus: this.pendingFocus });
							this.pendingFocus = undefined;
						}
						await this.connHandler.startStatusPolling();
						break;

					case 'saveSettings':
						await this.saveAllSettings(message.settings, panel.webview);
						break;

					case 'clearCredentials':
						await this.clearCredentials(panel.webview);
						break;

					default: {
						// Delegate connection messages (cloud, docker, service, test, engine versions, sudo)
						const handled = await this.connHandler.handleMessage(message, panel.webview);
						if (handled) break;
						break;
					}
				}
			} catch (error) {
				console.error('[PageSettingsProvider] Message handling error:', error);
				const msgType = message.type as string;
				if (msgType.startsWith('docker')) {
					panel.webview.postMessage({ type: 'dockerError', message: `${error}` });
				} else if (msgType.startsWith('service')) {
					panel.webview.postMessage({ type: 'serviceError', message: `${error}` });
				} else {
					this.showMessage(panel.webview, 'error', `Error: ${error}`);
				}
			}
		});

		this.disposables.push(messageDisposable);

		const panelWebview = panel.webview;

		// Listen for cloud auth changes
		const cleanupCloudAuth = this.connHandler.registerCloudAuthListener(panelWebview);

		// Clean up when panel is disposed
		panel.onDidDispose(() => {
			cleanupCloudAuth();
			this.panel = undefined;
			this.activeWebviews.delete(panelWebview);
			this.connHandler.stopStatusPolling();

			const index = this.disposables.indexOf(messageDisposable);
			if (index !== -1) {
				this.disposables.splice(index, 1);
			}
		});
	}

	/**
	 * Loads all settings from configuration and sends to webview
	 */
	private async loadAllSettings(webview: vscode.Webview): Promise<void> {
		const config = this.configManager.getConfig();
		const hasApiKey = this.configManager.hasApiKey();
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');

		// Fetch the actual API key for editing (if it exists)
		let apiKey = '';
		if (hasApiKey) {
			try {
				apiKey = config.apiKey || '';
			} catch (error) {
				console.warn('Could not load API key for editing:', error);
			}
		}

		// Get environment variables
		const envVars = this.configManager.getEnvVars();

		const allSettings = {
			// Connection settings from package.json
			hostUrl: workspaceConfig.get('hostUrl', 'http://localhost:5565'),
			connectionMode: workspaceConfig.get('connectionMode', 'local'),
			hasApiKey: hasApiKey,
			apiKey: apiKey, // Include the actual API key for form editing
			// Pipeline settings
			defaultPipelinePath: workspaceConfig.get('defaultPipelinePath', 'pipelines'),

			// Local engine settings
			localEngineVersion: workspaceConfig.get('local.engineVersion', 'latest'),
			localDebugOutput: workspaceConfig.get('local.debugOutput', false),
			localEngineArgs: workspaceConfig.get('engineArgs', ''),

			// Debugging settings
			pipelineRestartBehavior: workspaceConfig.get('pipelineRestartBehavior', 'prompt'),

			// Development team / Deploy target
			developmentTeamId: workspaceConfig.get('developmentTeamId', ''),
			deployTargetMode: workspaceConfig.get('deployTargetMode', null),
			deployTargetTeamId: workspaceConfig.get('deployTargetTeamId', ''),
			deployHostUrl: workspaceConfig.get('deployHostUrl', ''),
			deployApiKey: config.deployApiKey || '',
			// Environment variables
			envVars: envVars,

			// Integration settings
			autoAgentIntegration: workspaceConfig.get('integrations.autoAgentIntegration', true),
			integrationCopilot: workspaceConfig.get('integrations.copilot', false),
			integrationClaudeCode: workspaceConfig.get('integrations.claudeCode', false),
			integrationCursor: workspaceConfig.get('integrations.cursor', false),
			integrationWindsurf: workspaceConfig.get('integrations.windsurf', false),
			integrationClaudeMd: workspaceConfig.get('integrations.claudeMd', false),
			integrationAgentsMd: workspaceConfig.get('integrations.agentsMd', false),
		};

		webview.postMessage({
			type: 'settingsLoaded',
			settings: allSettings,
		});

		// Fetch teams: try the active connection first, fall back to a temp cloud connection
		await this.connHandler.fetchCloudTeams(webview);
	}

	/**
	 * Saves all settings atomically, then drives each connection manager
	 * into its new desired state in sequence.
	 *
	 * Flow:
	 *   1. ConfigManager.applyAllSettings() — writes everything, suppresses
	 *      intermediate change events, refreshes cache once.
	 *   2. Dev connection — settingsApplied() → disconnect old → initialize new.
	 *   3. Deploy connection — settingsApplied() → transition shared/independent.
	 *   4. Reload webview with the authoritative cached config.
	 */
	private async saveAllSettings(settings: Record<string, unknown>, webview: vscode.Webview): Promise<void> {
		this._isSaving = true;
		try {
			// Cast to the typed snapshot (webview sends the full SettingsData shape)
			const snapshot = settings as unknown as SettingsSnapshot;

			// 1. Write everything atomically — no listeners fire during this
			await this.configManager.applyAllSettings(snapshot);

			// 2. Dev connection: disconnect old mode, connect with new config
			const connectionManager = getConnectionManager();
			if (connectionManager) {
				await connectionManager.settingsApplied();
			}

			// 3. Deploy connection: transition shared↔independent as needed
			const deployManager = DeployManager.getDeployInstance();
			await deployManager.settingsApplied();

			// 4. Reload webview from authoritative cache
			this.showMessage(webview, 'success', 'Settings saved successfully!');
			for (const w of this.activeWebviews) {
				await this.loadAllSettings(w);
			}

			// Install agent stubs for any newly checked integrations
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (workspaceFolder) {
				try {
					const agentManager = new AgentManager();
					await agentManager.installFromSettings(this.extensionUri.fsPath, workspaceFolder.uri);
				} catch (agentErr) {
					vscode.window.showWarningMessage(`Agent documentation install failed: ${agentErr}`);
				}
			}
		} catch (error) {
			console.error('[PageSettingsProvider] Failed to save settings:', error);
			this.showMessage(webview, 'error', `Failed to save settings: ${error}`);
		} finally {
			this._isSaving = false;
		}
	}

	private async clearCredentials(webview: vscode.Webview): Promise<void> {
		try {
			// Clear the API key from secure storage
			await this.configManager.deleteApiKey();

			// Verify it was actually cleared
			const hasApiKey = this.configManager.hasApiKey();
			if (!hasApiKey) {
				this.showMessage(webview, 'success', 'API Key cleared successfully and removed from secure storage');
			} else {
				this.showMessage(webview, 'error', 'API Key may not have been fully cleared - please try again');
			}

			// Force reload of all settings to update the UI
			await this.loadAllSettings(webview);
		} catch (error) {
			console.error('[PageSettingsProvider] Failed to clear API key:', error);
			this.showMessage(webview, 'error', `Failed to clear API key: ${error}`);
		}
	}

	/**
	 * Sends a message to the webview.
	 * @param context When 'development', the message is shown inside that section's box; otherwise shown in the global message area.
	 */
	private showMessage(webview: vscode.Webview, level: string, message: string, context?: 'development'): void {
		webview.postMessage({
			type: 'showMessage',
			level: level,
			message: message,
			...(context && { context }),
		});
	}

	/**
	 * Generates HTML content for the webview
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'page-settings.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			// Replace template placeholders
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Convert resource URLs to webview URIs
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			console.error('Error loading settings HTML:', error);
			return this.getErrorHtml(error, htmlPath.fsPath);
		}
	}

	/**
	 * Generates fallback HTML for when the main HTML file can't be loaded
	 */
	private getErrorHtml(error: unknown, expectedPath: string): string {
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Settings View Error</title>
		</head>
		<body>
			<div style="padding: 20px; color: #f44336;">
				<h3>Error Loading Settings View</h3>
				<p><strong>Error:</strong> ${error}</p>
				<p>Run <code>npm run build:webview</code> to build the webview.</p>
				<p>Expected: <code>${expectedPath}</code></p>
			</div>
		</body>
		</html>`;
	}

	/**
	 * Generates a random nonce for Content Security Policy
	 */
	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	/**
	 * Cleans up event listeners and resources
	 */
	public dispose(): void {
		this.connHandler.dispose();
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
		this.activeWebviews.clear();
	}
}
