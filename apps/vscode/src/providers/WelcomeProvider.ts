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
 * Welcome Page Provider
 *
 * Shows a branded welcome/setup page on first install. Delays engine download
 * and connection until the user explicitly configures and confirms their setup.
 *
 * The page auto-opens until the user unchecks "Show welcome page on startup".
 * The user setting 'rocketride.welcomeDismissed' persists this preference.
 *
 * Connection-related messages (cloud auth, docker/service lifecycle, engine
 * versions, test connection) are delegated to the shared ConnectionMessageHandler.
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../config';
import { getConnectionManager, getEngineRegistry } from '../extension';
import { ConnectionMessageHandler } from './shared/connection-message-handler';

const DISMISSED_KEY = 'welcomeDismissed';

export class WelcomeProvider {
	private disposables: vscode.Disposable[] = [];
	private configManager: ConfigManager;
	private connHandler: ConnectionMessageHandler;
	private panel: vscode.WebviewPanel | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri
	) {
		this.configManager = ConfigManager.getInstance();
		this.connHandler = new ConnectionMessageHandler({
			extensionFsPath: extensionUri.fsPath,
			getActiveWebviews: () => (this.panel ? [this.panel.webview] : []),
			getConnectionManager,
			getEngineRegistry,
		});
		this.registerCommands();
	}

	/** Whether the user has already dismissed the welcome page */
	public isDismissed(): boolean {
		return vscode.workspace.getConfiguration('rocketride').get<boolean>(DISMISSED_KEY, false);
	}

	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.page.welcome.open', async () => {
			await this.show();
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	/** Creates or reveals the welcome panel */
	public async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		this.panel = vscode.window.createWebviewPanel('rocketrideWelcome', 'Welcome to RocketRide', vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
			retainContextWhenHidden: true,
		});

		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

		const messageDisposable = this.panel.webview.onDidReceiveMessage(async (message) => {
			if (!this.panel) return;
			try {
				switch (message.type) {
					case 'view:ready':
						await this.sendCurrentSettings();
						// Server probe is triggered by CloudPanel when cloud mode is selected
						await this.connHandler.startStatusPolling();
						break;

					case 'saveAndConnect':
						await this.saveAndConnect(message.settings);
						break;

					case 'openSettings':
						this.panel?.dispose();
						vscode.commands.executeCommand('rocketride.page.settings.open');
						break;

					case 'openExternal':
						if (message.url) {
							vscode.env.openExternal(vscode.Uri.parse(message.url));
						}
						break;

					default: {
						// Delegate connection messages (cloud, docker, service, test, engine versions, sudo)
						const handled = await this.connHandler.handleMessage(message, this.panel.webview);
						if (handled) break;

						console.warn('[WelcomeProvider] Unhandled message type:', message.type);
						break;
					}
				}
			} catch (error) {
				console.error('[WelcomeProvider] Message handling error:', error);
				const msgType = message.type as string;
				if (msgType.startsWith('docker')) {
					this.panel?.webview.postMessage({ type: 'dockerError', message: `${error}` });
				} else if (msgType.startsWith('service')) {
					this.panel?.webview.postMessage({ type: 'serviceError', message: `${error}` });
				} else {
					this.panel?.webview.postMessage({ type: 'showMessage', level: 'error', message: `Error: ${error}` });
				}
			}
		});

		this.disposables.push(messageDisposable);

		const panelWebview = this.panel.webview;
		const cleanupCloudAuth = this.connHandler.registerCloudAuthListener(panelWebview);

		this.panel.onDidDispose(() => {
			cleanupCloudAuth();
			this.connHandler.stopStatusPolling();
			this.panel = undefined;
			const index = this.disposables.indexOf(messageDisposable);
			if (index !== -1) {
				this.disposables.splice(index, 1);
			}
		});
	}

	/** Send current config to the webview so the form is pre-populated */
	private async sendCurrentSettings(): Promise<void> {
		if (!this.panel) return;

		const config = this.configManager.getConfig();
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');

		let apiKey = '';
		if (this.configManager.hasApiKey()) {
			try {
				apiKey = config.development.apiKey || '';
			} catch {
				/* ignore */
			}
		}

		const logoDarkUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'rocketride-dark-icon.png'));
		const logoLightUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'rocketride-light-icon.png'));

		// Send nested structure matching the webview SettingsData type
		this.panel.webview.postMessage({
			type: 'settingsLoaded',
			logoDarkUri: logoDarkUri.toString(),
			logoLightUri: logoLightUri.toString(),
			settings: {
				development: {
					connectionMode: config.development.connectionMode,
					hostUrl: config.development.hostUrl,
					apiKey,
					hasApiKey: this.configManager.hasApiKey(),
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
				defaultPipelinePath: config.defaultPipelinePath,
				pipelineRestartBehavior: config.pipelineRestartBehavior,
				autoAgentIntegration: workspaceConfig.get('integrations.autoAgentIntegration', true),
				integrationCopilot: workspaceConfig.get('integrations.copilot', false),
				integrationClaudeCode: workspaceConfig.get('integrations.claudeCode', false),
				integrationCursor: workspaceConfig.get('integrations.cursor', false),
				integrationWindsurf: workspaceConfig.get('integrations.windsurf', false),
				integrationClaudeMd: workspaceConfig.get('integrations.claudeMd', false),
				integrationAgentsMd: workspaceConfig.get('integrations.agentsMd', false),
			},
		});
	}

	/**
	 * Persist the user's welcome-page settings and kick off the first connection.
	 *
	 * Sequence mirrors SettingsProvider.saveAllSettings():
	 *   1. Atomic config write (listeners suppressed)
	 *   2. Mark welcome as dismissed so it won't re-open
	 *   3. Cancel stale debounced handlers that would race with reconcile
	 *   4. Initialize CMs (validates creds, sets mode)
	 *   5. Reconcile engines (downloads/starts, CMs auto-connect on 'ready')
	 *   6. Close the welcome panel
	 *
	 * @param settings - The full settings snapshot from the welcome form.
	 */
	private async saveAndConnect(settings: Record<string, unknown>): Promise<void> {
		try {
			// Step 1: Atomic write — suppresses config-change listeners during the batch
			await this.configManager.applyAllSettings(settings as any);

			// Step 2: Persist dismissal so the welcome page doesn't re-open on next activation
			await vscode.workspace.getConfiguration('rocketride').update(DISMISSED_KEY, true, vscode.ConfigurationTarget.Global);

			// Step 3: The welcomeDismissed write above fires a config-change event
			// AFTER the batch flag is cleared. Cancel it so it doesn't race with
			// the reconcile we're about to trigger.
			const connectionManager = getConnectionManager();
			connectionManager?.cancelPendingConfigChange();

			// Step 4-5: Initialize CMs then reconcile — same order as normal activation
			if (connectionManager) await connectionManager.initialize();

			const registry = getEngineRegistry();
			if (registry) await registry.reconcile();

			// Step 6: Close panel — engines are starting, CMs will auto-connect
			this.panel?.dispose();
		} catch (error) {
			console.error('[WelcomeProvider] Failed to save settings:', error);
			this.panel?.webview.postMessage({ type: 'showMessage', level: 'error', message: `Failed to save settings: ${error}` });
		}
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'page-welcome.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			console.error('Error loading welcome HTML:', error);
			return `<!DOCTYPE html>
			<html lang="en">
			<head><meta charset="UTF-8"><title>Welcome Error</title></head>
			<body>
				<div style="padding: 20px; color: #f44336;">
					<h3>Error Loading Welcome View</h3>
					<p><strong>Error:</strong> ${error}</p>
					<p>Run <code>pnpm run build</code> to build the webview.</p>
					<p>Expected: <code>${htmlPath.fsPath}</code></p>
				</div>
			</body>
			</html>`;
		}
	}

	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	public dispose(): void {
		this.connHandler.dispose();
		this.panel?.dispose();
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
	}
}
