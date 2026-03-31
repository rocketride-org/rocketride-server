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
import { RocketRideClient } from 'rocketride';
import { ConfigManager } from '../config';
import { getConnectionTreeProvider, getConnectionManager } from '../extension';
import { EngineInstaller } from '../connection/engine-installer';
import { connectionModeRequiresApiKey } from '../shared/util/connectionModeAuth';
import { AgentManager } from '../agents/agent-manager';

export class PageSettingsProvider {
	private disposables: vscode.Disposable[] = [];
	private configManager: ConfigManager;
	private engineInstaller: EngineInstaller;
	private activeWebviews: Set<vscode.Webview> = new Set();
	private _isSaving = false;
	private panel: vscode.WebviewPanel | undefined;

	/**
	 * Creates a new PageSettingsProvider
	 *
	 * @param extensionUri Extension URI for resource loading
	 */
	constructor(private readonly extensionUri: vscode.Uri) {
		this.configManager = ConfigManager.getInstance();
		this.engineInstaller = new EngineInstaller(extensionUri.fsPath);
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
			vscode.commands.registerCommand('rocketride.page.settings.open', async () => {
				await this.openSettings();
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

					// Import providers at runtime to avoid circular dependency
					const connectionTreeProvider = getConnectionTreeProvider();
					const connectionManager = getConnectionManager();

					connectionTreeProvider?.refresh();

					// Optionally disconnect since credentials are now invalid
					connectionManager?.disconnect();
				}
			}),
		];

		this.disposables.push(...commands);
	}

	/**
	 * Opens the settings page, or reveals it if already open
	 */
	public async openSettings(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
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
					case 'ready':
						await this.loadAllSettings(panel.webview);
						break;

					case 'saveSettings':
						await this.saveAllSettings(message.settings, panel.webview);
						break;

					case 'testConnection':
						await this.testConnection(message.settings, panel.webview);
						break;

					case 'clearCredentials':
						await this.clearCredentials(panel.webview);
						break;

					case 'fetchEngineVersions':
						await this.fetchEngineVersions(panel.webview);
						break;
				}
			} catch (error) {
				console.error('[PageSettingsProvider] Message handling error:', error);
				this.showMessage(panel.webview, 'error', `Error: ${error}`);
			}
		});

		this.disposables.push(messageDisposable);

		// Clean up when panel is disposed
		panel.onDidDispose(() => {
			this.panel = undefined;
			this.activeWebviews.delete(panel.webview);

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
			autoConnect: workspaceConfig.get('autoConnect', true),

			// Pipeline settings
			defaultPipelinePath: workspaceConfig.get('defaultPipelinePath', 'pipelines'),

			// Local engine settings
			localEngineVersion: workspaceConfig.get('local.engineVersion', 'latest'),
			localDebugOutput: workspaceConfig.get('local.debugOutput', false),
			localEngineArgs: workspaceConfig.get('engineArgs', ''),

			// Debugging settings
			pipelineRestartBehavior: workspaceConfig.get('pipelineRestartBehavior', 'prompt'),

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
	}

	/**
	 * Saves all settings to workspace configuration and secure storage
	 */
	private async saveAllSettings(settings: Record<string, unknown>, webview: vscode.Webview): Promise<void> {
		this._isSaving = true;
		try {
			const workspaceConfig = vscode.workspace.getConfiguration('rocketride');

			// Save connection settings
			if (settings.hostUrl !== undefined) {
				await workspaceConfig.update('hostUrl', settings.hostUrl, vscode.ConfigurationTarget.Global);
			}

			if (settings.connectionMode !== undefined) {
				await workspaceConfig.update('connectionMode', settings.connectionMode, vscode.ConfigurationTarget.Global);
			}

			if (settings.autoConnect !== undefined) {
				await workspaceConfig.update('autoConnect', settings.autoConnect, vscode.ConfigurationTarget.Global);
			}

			// Save pipeline settings
			if (settings.defaultPipelinePath !== undefined) {
				await workspaceConfig.update('defaultPipelinePath', settings.defaultPipelinePath, vscode.ConfigurationTarget.Global);
			}

			// Save local engine settings
			if (settings.localEngineVersion !== undefined) {
				await workspaceConfig.update('local.engineVersion', settings.localEngineVersion, vscode.ConfigurationTarget.Global);
			}
			if (settings.localDebugOutput !== undefined) {
				await workspaceConfig.update('local.debugOutput', settings.localDebugOutput, vscode.ConfigurationTarget.Global);
			}
			if (settings.localEngineArgs !== undefined) {
				await workspaceConfig.update('engineArgs', settings.localEngineArgs, vscode.ConfigurationTarget.Global);
			}

			// Save debugging settings
			if (settings.pipelineRestartBehavior !== undefined) {
				await workspaceConfig.update('pipelineRestartBehavior', settings.pipelineRestartBehavior, vscode.ConfigurationTarget.Global);
			}

			// Save integration settings
			if (settings.autoAgentIntegration !== undefined) {
				await workspaceConfig.update('integrations.autoAgentIntegration', settings.autoAgentIntegration, vscode.ConfigurationTarget.Global);
			}
			if (settings.integrationCopilot !== undefined) {
				await workspaceConfig.update('integrations.copilot', settings.integrationCopilot, vscode.ConfigurationTarget.Global);
			}
			if (settings.integrationClaudeCode !== undefined) {
				await workspaceConfig.update('integrations.claudeCode', settings.integrationClaudeCode, vscode.ConfigurationTarget.Global);
			}
			if (settings.integrationCursor !== undefined) {
				await workspaceConfig.update('integrations.cursor', settings.integrationCursor, vscode.ConfigurationTarget.Global);
			}
			if (settings.integrationWindsurf !== undefined) {
				await workspaceConfig.update('integrations.windsurf', settings.integrationWindsurf, vscode.ConfigurationTarget.Global);
			}
			if (settings.integrationClaudeMd !== undefined) {
				await workspaceConfig.update('integrations.claudeMd', settings.integrationClaudeMd, vscode.ConfigurationTarget.Global);
			}
			if (settings.integrationAgentsMd !== undefined) {
				await workspaceConfig.update('integrations.agentsMd', settings.integrationAgentsMd, vscode.ConfigurationTarget.Global);
			}

			// Save API key to secure storage whenever provided (used for cloud dev and deployment)
			if (typeof settings.apiKey === 'string') {
				if (settings.apiKey.trim() !== '') {
					await this.configManager.setApiKey(settings.apiKey.trim());
				} else {
					// If API key is empty, clear it from secure storage
					await this.configManager.deleteApiKey();
				}
			}

			// Save environment variables to .env file
			// ConfigManager will ensure ROCKETRIDE_URI and ROCKETRIDE_APIKEY are always present
			if (settings.envVars !== undefined) {
				await this.configManager.saveAllEnvVars(settings.envVars as Record<string, string>);
			}

			this.showMessage(webview, 'success', 'Settings saved successfully!');
			// Reload all active webviews now that every setting has been persisted
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

	/**
	 * Tests connection with provided settings
	 */
	private async testConnection(formSettings: Record<string, unknown>, webview: vscode.Webview): Promise<void> {
		let testClient: RocketRideClient | undefined;

		try {
			this.showMessage(webview, 'info', 'Testing connection...', 'development');

			// Use settings from the form (current UI state)
			const connectionMode = (formSettings.connectionMode as string) || 'cloud';
			let hostUrl = (formSettings.hostUrl as string) || '';
			if (connectionMode === 'cloud' && !hostUrl) hostUrl = 'https://cloud.rocketride.ai';
			if (connectionMode === 'local' && !hostUrl) hostUrl = 'http://localhost:5565';

			// Normalize bare hostnames into parseable URLs (protocol, default port)
			hostUrl = RocketRideClient.normalizeUri(hostUrl);

			// Validate URL format
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(hostUrl);
			} catch {
				this.showMessage(webview, 'error', 'Invalid URL format. Please enter a valid URL or port.', 'development');
				return;
			}

			const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : parsedUrl.protocol === 'https:' ? 443 : 80;
			if (port < 1 || port > 65535) {
				this.showMessage(webview, 'error', `Invalid port number: ${port}. Port must be between 1 and 65535.`, 'development');
				return;
			}

			// Only cloud mode requires an API key; local and self-hosted on-prem can connect without one.
			const needsApiKey = connectionModeRequiresApiKey(connectionMode);
			let apiKey = 'MYAPIKEY';
			if (needsApiKey) {
				apiKey = typeof formSettings.apiKey === 'string' ? formSettings.apiKey.trim() : '';
				if (!apiKey) {
					const config = this.configManager.getConfig();
					apiKey = config.apiKey;
				}
				if (!apiKey) {
					this.showMessage(webview, 'error', 'API key is required. Please enter your API key in the RocketRide account section.', 'development');
					return;
				}
			}

			// Create temporary test client and connect (same flow for all three modes)
			testClient = new RocketRideClient({
				auth: apiKey,
				uri: hostUrl,
				module: 'CONN-TST',
				requestTimeout: 5000,
			});

			try {
				await testClient.connect(8000);
			} catch (connectError) {
				if (testClient) {
					await testClient.disconnect();
				}
				const errorMessage = connectError instanceof Error ? connectError.message : String(connectError);
				if (errorMessage.includes('ECONNREFUSED')) {
					this.showMessage(webview, 'error', `Connection refused. Server is not running at ${parsedUrl.host} or is not accepting connections.`, 'development');
				} else if (errorMessage.includes('ENOTFOUND')) {
					this.showMessage(webview, 'error', `Server not found at ${parsedUrl.hostname}. Please check the URL.`, 'development');
				} else if (errorMessage.includes('timeout')) {
					this.showMessage(webview, 'error', `Connection timed out. Server at ${parsedUrl.host} is not responding.`, 'development');
				} else {
					this.showMessage(webview, 'error', `Failed to connect: ${errorMessage}`, 'development');
				}
				return;
			}

			const testArgs: Record<string, unknown> = {
				clientID: 'vscode-settings-test',
				clientName: 'VS Code Settings Test',
				adapterID: 'rocketride',
				pathFormat: 'path',
				linesStartAt1: true,
				columnsStartAt1: true,
				supportsVariableType: true,
				supportsVariablePaging: true,
				supportsRunInTerminalRequest: true,
			};

			let response;
			try {
				response = await testClient.dapRequest('initialize', testArgs, '', 5000);
			} catch (requestError) {
				await testClient.disconnect();
				const errorMessage = requestError instanceof Error ? requestError.message : String(requestError);
				this.showMessage(webview, 'error', `Server connected but failed to respond: ${errorMessage}`, 'development');
				return;
			}

			await testClient.disconnect();

			if (!response) {
				this.showMessage(webview, 'error', 'Server connected but returned no response.', 'development');
			} else if (response.success === false) {
				this.showMessage(webview, 'error', `Server rejected the request: ${response.message || 'Unknown error'}`, 'development');
			} else if (response.type === 'response' && response.command === 'initialize') {
				this.showMessage(webview, 'success', `Connection test successful! ${parsedUrl.host} is responding correctly.`, 'development');
			} else {
				this.showMessage(webview, 'warning', 'Server responded with an unexpected format. Connection may still work.', 'development');
			}
		} catch (error) {
			if (testClient) {
				testClient.disconnect().catch(() => {
					/* ignore */
				});
			}

			const errorMessage = error instanceof Error ? error.message : String(error);
			this.showMessage(webview, 'error', `Connection test failed: ${errorMessage}`, 'development');
		}
	}

	/**
	 * Clears stored credentials from secure storage
	 */
	private async clearCredentials(webview: vscode.Webview): Promise<void> {
		try {
			// Clear the API key from secure storage
			await this.configManager.deleteApiKey();

			// Verify it was actually cleared
			const hasApiKey = await this.configManager.hasApiKey();
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
	 * Fetches available engine versions from GitHub and sends them to the webview
	 */
	private async fetchEngineVersions(webview: vscode.Webview): Promise<void> {
		try {
			let githubToken: string | undefined;
			try {
				const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
				githubToken = session?.accessToken;
			} catch {
				// Proceed without token
			}

			const versions = await this.engineInstaller.getReleases(undefined, githubToken);
			webview.postMessage({
				type: 'engineVersionsLoaded',
				versions,
			});
		} catch (error) {
			console.error('[PageSettingsProvider] Failed to fetch engine versions:', error);
			webview.postMessage({
				type: 'engineVersionsLoaded',
				versions: [],
			});
			this.showMessage(webview, 'warning', `Could not fetch engine versions: ${error}`);
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
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
		this.activeWebviews.clear();
	}
}
