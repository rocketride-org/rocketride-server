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
import { getConnectionManager, getEngineRegistry } from '../extension';
import { AgentManager } from '../agents/agent-manager';
import { DeployManager } from '../connection/deploy-manager';
import { ConnectionMessageHandler } from './shared/connection-message-handler';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { PIPE_BUILDER_APP_ID } from '../shared/types';

export class SettingsProvider {
	private disposables: vscode.Disposable[] = [];
	private configManager: ConfigManager;
	private activeWebviews: Set<vscode.Webview> = new Set();
	private connHandler: ConnectionMessageHandler;
	private _isSaving = false;
	private panel: vscode.WebviewPanel | undefined;

	/**
	 * Creates a new SettingsProvider
	 *
	 * @param extensionUri Extension URI for resource loading
	 */
	constructor(private readonly extensionUri: vscode.Uri) {
		this.configManager = ConfigManager.getInstance();
		this.connHandler = new ConnectionMessageHandler({
			extensionFsPath: extensionUri.fsPath,
			getActiveWebviews: () => this.activeWebviews,
			getConnectionManager,
			getEngineRegistry,
		});
		this.registerCommands();
	}

	/**
	 * Registers all commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.page.settings.open', async (focus?: string, authError?: string) => {
				await this.openSettings(focus, authError);
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
					await this.configManager.deleteApiKey('development');

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
	/** Pending auth error — shown as a banner when the page opens due to auth failure. */
	private pendingAuthError?: string;

	/**
	 * Opens the settings page, optionally focused on a single section.
	 * @param focus - If set ('development' or 'deployment'), shows only that section.
	 * @param authError - If set, displays an auth-failure banner that clears on successful test.
	 */
	public async openSettings(focus?: string, authError?: string): Promise<void> {
		this.pendingFocus = focus;
		this.pendingAuthError = authError;
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			// Panel already open — send focus update directly
			if (focus) {
				this.panel.webview.postMessage({ type: 'setFocus', focus });
			}
			if (authError) {
				this.panel.webview.postMessage({ type: 'authError', message: authError });
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
						// Server probe is triggered by CloudPanel when cloud mode is selected
						if (this.pendingFocus) {
							panel.webview.postMessage({ type: 'setFocus', focus: this.pendingFocus });
							this.pendingFocus = undefined;
						}
						if (this.pendingAuthError) {
							panel.webview.postMessage({ type: 'authError', message: this.pendingAuthError });
							this.pendingAuthError = undefined;
						}
						await this.connHandler.startStatusPolling();
						break;

					case 'saveSettings':
						await this.saveAllSettings(message.settings, panel.webview);
						break;

					case 'clearCredentials':
						await this.clearCredentials(panel.webview);
						break;

					// -- Checkout flow (embedded Stripe Elements) --------------------
					case 'checkout:fetchPlans': {
						try {
							const billingClient = getConnectionManager()?.getClient();
							if (!billingClient) throw new Error('Not connected');
							const plans = await billingClient.billing.getProductPrices(PIPE_BUILDER_APP_ID);
							panel.webview.postMessage({ type: 'checkout:plansResult', plans, error: null });
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							panel.webview.postMessage({ type: 'checkout:plansResult', plans: [], error: msg });
						}
						break;
					}

					case 'checkout:createSession': {
						try {
							const billingClient = getConnectionManager()?.getClient();
							if (!billingClient) throw new Error('Not connected');
							const orgId = billingClient.getAccountInfo()?.organization?.id;
							if (!orgId) throw new Error('No organisation found');
							const result = await billingClient.billing.createCheckoutSession(orgId, PIPE_BUILDER_APP_ID, message.priceId as string);
							panel.webview.postMessage({ type: 'checkout:sessionResult', ...result, error: null });
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							panel.webview.postMessage({ type: 'checkout:sessionResult', clientSecret: '', subscriptionId: '', error: msg });
						}
						break;
					}

					case 'checkout:confirmPending': {
						try {
							const billingClient = getConnectionManager()?.getClient();
							if (!billingClient) throw new Error('Not connected');
							await (billingClient as any).dapRequest('rrext_account_billing', {
								subcommand: 'confirm_pending',
								appId: PIPE_BUILDER_APP_ID,
								subscriptionId: message.subscriptionId,
								priceId: message.priceId,
							});
							panel.webview.postMessage({ type: 'checkout:confirmResult', error: null });
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							panel.webview.postMessage({ type: 'checkout:confirmResult', error: msg });
						}
						break;
					}

					default: {
						// Delegate connection messages (cloud, docker, service, test, engine versions, sudo)
						const handled = await this.connHandler.handleMessage(message, panel.webview);
						if (handled) break;
						break;
					}
				}
			} catch (error) {
				console.error('[SettingsProvider] Message handling error:', error);
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
				apiKey = config.development.apiKey || '';
			} catch (error) {
				console.warn('Could not load API key for editing:', error);
			}
		}

		// Send nested structure matching the webview SettingsData type
		const allSettings = {
			// Connection groups
			development: {
				connectionMode: config.development.connectionMode,
				hostUrl: config.development.hostUrl,
				hasApiKey: hasApiKey,
				apiKey: apiKey,
				teamId: config.development.teamId,
				local: {
					engineVersion: config.development.local.engineVersion,
					debugOutput: config.development.local.debugOutput,
					engineArgs: config.development.local.engineArgs,
				},
			},
			deployment: {
				connectionMode: config.deployment.connectionMode,
				hostUrl: config.deployment.hostUrl,
				hasApiKey: !!config.deployment.apiKey,
				apiKey: config.deployment.apiKey || '',
				teamId: config.deployment.teamId,
				local: {
					engineVersion: config.deployment.local.engineVersion,
					debugOutput: config.deployment.local.debugOutput,
					engineArgs: config.deployment.local.engineArgs,
				},
			},

			// Top-level settings
			defaultPipelinePath: config.defaultPipelinePath,
			pipelineRestartBehavior: config.pipelineRestartBehavior,

			// Integration settings
			autoAgentIntegration: workspaceConfig.get('integrations.autoAgentIntegration', true),
			integrationCopilot: workspaceConfig.get('integrations.copilot', false),
			integrationClaudeCode: workspaceConfig.get('integrations.claudeCode', false),
			integrationCursor: workspaceConfig.get('integrations.cursor', false),
			integrationWindsurf: workspaceConfig.get('integrations.windsurf', false),
			integrationClaudeMd: workspaceConfig.get('integrations.claudeMd', false),
			integrationAgentsMd: workspaceConfig.get('integrations.agentsMd', false),
		};

		// Include subscription status with settings so it's always in sync
		const cm = getConnectionManager();
		const client = cm?.getClient();
		webview.postMessage({
			type: 'settingsLoaded',
			settings: allSettings,
			isSubscribed: isSubscribed(client, PIPE_BUILDER_APP_ID),
		});

		// Teams are fetched by CloudPanel after it confirms the server is SaaS
	}

	/**
	 * Saves all settings atomically, then reconciles engines.
	 *
	 * Flow:
	 *   1. ConfigManager.applyAllSettings() — writes everything atomically.
	 *   2. Cancel debounced config-change handlers on CMs (prevents race).
	 *   3. Reconcile engines — checksums detect config changes, restarts
	 *      affected engines, CMs reconnect with fresh credentials.
	 *   4. Reload webview with the authoritative cached config.
	 */
	private async saveAllSettings(settings: Record<string, unknown>, webview: vscode.Webview): Promise<void> {
		this._isSaving = true;
		try {
			// Cast to the typed snapshot (webview sends the full SettingsData shape)
			const snapshot = settings as unknown as SettingsSnapshot;

			// Validate: cloud mode requires a team selection
			if (snapshot.development.connectionMode === 'cloud' && !snapshot.development.teamId) {
				this.showMessage(webview, 'error', 'Please select a team for the development cloud connection.');
				return;
			}
			if (snapshot.deployment.connectionMode === 'cloud' && !snapshot.deployment.teamId) {
				this.showMessage(webview, 'error', 'Please select a team for the deployment cloud connection.');
				return;
			}

			// Step 1: Write everything atomically — ConfigManager suppresses all
			// intermediate config-change listeners during the batch so no CM reacts
			// to half-written state (e.g., new API key without new host URL).
			await this.configManager.applyAllSettings(snapshot);

			// Mark welcome as dismissed — user has configured settings
			await vscode.workspace.getConfiguration('rocketride').update('welcomeDismissed', true, vscode.ConfigurationTarget.Global);

			// Step 2: Confirm save to the user immediately — don't wait for engine ops
			this.showMessage(webview, 'success', 'Settings saved successfully!', 'save');
			for (const w of this.activeWebviews) {
				await this.loadAllSettings(w);
			}

			// Step 3: Cancel any pending debounced config-change handlers so they
			// don't race with the reconcile triggered by the explicit save.
			const cm = getConnectionManager();
			cm?.cancelPendingConfigChange();

			// Reconcile engines — compares config checksums to detect changes
			// (API key, host URL, connection mode, etc.) and restarts affected engines.
			// Runs after the UI has updated so downloads don't block the "Saved" feedback.
			const registry = getEngineRegistry();
			if (registry) {
				await registry.reconcile();
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
			console.error('[SettingsProvider] Failed to save settings:', error);
			this.showMessage(webview, 'error', `Failed to save settings: ${error}`);
		} finally {
			this._isSaving = false;
		}
	}

	private async clearCredentials(webview: vscode.Webview): Promise<void> {
		try {
			// Clear the API key from secure storage
			await this.configManager.deleteApiKey('development');

			// Verify it was actually cleared
			const hasApiKey = this.configManager.hasApiKey();
			if (hasApiKey) {
				this.showMessage(webview, 'error', 'API Key may not have been fully cleared - please try again');
			}

			// Force reload of all settings to update the UI
			await this.loadAllSettings(webview);
		} catch (error) {
			console.error('[SettingsProvider] Failed to clear API key:', error);
			this.showMessage(webview, 'error', `Failed to clear API key: ${error}`);
		}
	}

	/**
	 * Sends a message to the webview.
	 * @param context When 'development', the message is shown inside that section's box; otherwise shown in the global message area.
	 */
	private showMessage(webview: vscode.Webview, level: string, message: string, context?: 'development' | 'save'): void {
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
