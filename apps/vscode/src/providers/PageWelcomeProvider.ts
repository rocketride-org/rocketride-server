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
 * The page auto-opens until the user dismisses it or completes setup. A
 * globalState flag ('rocketride.welcomeDismissed') persists the dismissal
 * across all workspaces so users only see the welcome once per installation.
 */

import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { ConfigManager } from '../config';
import { getConnectionManager } from '../extension';
import { connectionModeRequiresApiKey } from '../shared/util/connectionModeAuth';
import { EngineInstaller } from '../connection/engine-installer';

const DISMISSED_KEY = 'rocketride.welcomeDismissed';

export class PageWelcomeProvider {
	private disposables: vscode.Disposable[] = [];
	private configManager: ConfigManager;
	private engineInstaller: EngineInstaller;
	private panel: vscode.WebviewPanel | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri
	) {
		this.configManager = ConfigManager.getInstance();
		this.engineInstaller = new EngineInstaller(extensionUri.fsPath);
		this.registerCommands();
	}

	/** Whether the user has already dismissed the welcome page */
	public isDismissed(): boolean {
		return this.context.globalState.get<boolean>(DISMISSED_KEY, false);
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
			try {
				switch (message.type) {
					case 'view:ready':
						await this.sendCurrentSettings();
						break;

					case 'saveAndConnect':
						await this.saveAndConnect(message.settings);
						break;

					case 'dismiss':
						await this.dismiss();
						break;

					case 'testConnection':
						await this.testConnection(message.settings);
						break;

					case 'openSettings':
						await this.dismiss();
						vscode.commands.executeCommand('rocketride.page.settings.open');
						break;

					case 'openExternal':
						if (message.url) {
							vscode.env.openExternal(vscode.Uri.parse(message.url));
						}
						break;

					case 'fetchEngineVersions':
						await this.fetchEngineVersions();
						break;
				}
			} catch (error) {
				console.error('[PageWelcomeProvider] Message handling error:', error);
				this.showMessage('error', `Error: ${error}`);
			}
		});

		this.disposables.push(messageDisposable);

		this.panel.onDidDispose(() => {
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
				apiKey = config.apiKey || '';
			} catch {
				/* ignore */
			}
		}

		const logoDarkUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'rocketride-dark-icon.png'));
		const logoLightUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'rocketride-light-icon.png'));

		this.panel.webview.postMessage({
			type: 'settingsLoaded',
			logoDarkUri: logoDarkUri.toString(),
			logoLightUri: logoLightUri.toString(),
			settings: {
				connectionMode: workspaceConfig.get('connectionMode', 'local'),
				hostUrl: workspaceConfig.get('hostUrl', 'http://localhost:5565'),
				apiKey,
				hasApiKey: this.configManager.hasApiKey(),
				autoConnect: workspaceConfig.get('autoConnect', true),
				autoAgentIntegration: workspaceConfig.get('integrations.autoAgentIntegration', true),
				localEngineVersion: workspaceConfig.get('local.engineVersion', 'latest'),
			},
		});
	}

	/** Save settings, start connection, dismiss the welcome page */
	private async saveAndConnect(settings: Record<string, unknown>): Promise<void> {
		try {
			const workspaceConfig = vscode.workspace.getConfiguration('rocketride');

			if (settings.connectionMode !== undefined) {
				await workspaceConfig.update('connectionMode', settings.connectionMode, vscode.ConfigurationTarget.Global);
			}
			if (settings.hostUrl !== undefined) {
				await workspaceConfig.update('hostUrl', settings.hostUrl, vscode.ConfigurationTarget.Global);
			}
			if (settings.autoConnect !== undefined) {
				await workspaceConfig.update('autoConnect', settings.autoConnect, vscode.ConfigurationTarget.Global);
			}
			if (settings.localEngineVersion !== undefined) {
				await workspaceConfig.update('local.engineVersion', settings.localEngineVersion, vscode.ConfigurationTarget.Global);
			}
			if (settings.autoAgentIntegration !== undefined) {
				await workspaceConfig.update('integrations.autoAgentIntegration', settings.autoAgentIntegration, vscode.ConfigurationTarget.Global);
			}

			// Save API key to secure storage
			if (typeof settings.apiKey === 'string') {
				if (settings.apiKey.trim() !== '') {
					await this.configManager.setApiKey(settings.apiKey.trim());
				} else {
					await this.configManager.deleteApiKey();
				}
			}

			// Mark dismissed
			await this.context.globalState.update(DISMISSED_KEY, true);

			// Close panel
			this.panel?.dispose();

			// Start connection
			const connectionManager = getConnectionManager();
			connectionManager?.initialize().catch((error) => {
				console.error('[PageWelcomeProvider] Connection initialization failed:', error);
			});
		} catch (error) {
			console.error('[PageWelcomeProvider] Failed to save settings:', error);
			this.showMessage('error', `Failed to save settings: ${error}`);
		}
	}

	/** Dismiss without configuring */
	private async dismiss(): Promise<void> {
		await this.context.globalState.update(DISMISSED_KEY, true);
		this.panel?.dispose();
	}

	/** Test connection with provided form settings */
	private async testConnection(formSettings: Record<string, unknown>): Promise<void> {
		let testClient: RocketRideClient | undefined;

		try {
			this.showMessage('info', 'Testing connection...');

			const connectionMode = (formSettings.connectionMode as string) || 'cloud';
			let hostUrl = (formSettings.hostUrl as string)?.trim() || '';
			if (connectionMode === 'cloud' && !hostUrl) hostUrl = 'https://cloud.rocketride.ai';
			if (connectionMode === 'local' && !hostUrl) hostUrl = 'http://localhost:5565';

			// Normalize bare hostnames into parseable URLs (protocol, default port)
			hostUrl = RocketRideClient.normalizeUri(hostUrl);

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(hostUrl);
			} catch {
				this.showMessage('error', 'Invalid URL format. Please enter a valid URL or port.');
				return;
			}

			const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : parsedUrl.protocol === 'https:' ? 443 : 80;
			if (port < 1 || port > 65535) {
				this.showMessage('error', `Invalid port number: ${port}. Port must be between 1 and 65535.`);
				return;
			}

			const needsApiKey = connectionModeRequiresApiKey(connectionMode);
			let apiKey = 'MYAPIKEY';
			if (needsApiKey) {
				apiKey = typeof formSettings.apiKey === 'string' ? formSettings.apiKey.trim() : '';
				if (!apiKey) {
					const config = this.configManager.getConfig();
					apiKey = config.apiKey;
				}
				if (!apiKey) {
					this.showMessage('error', 'API key is required. Please enter your API key first.');
					return;
				}
			}

			testClient = new RocketRideClient({
				auth: apiKey,
				uri: hostUrl,
				module: 'CONN-TST',
				requestTimeout: 5000,
			});

			try {
				await testClient.connect(8000);
			} catch (connectError) {
				if (testClient) await testClient.disconnect();
				const errorMessage = connectError instanceof Error ? connectError.message : String(connectError);
				if (errorMessage.includes('ECONNREFUSED')) {
					this.showMessage('error', `Connection refused. Server is not running at ${parsedUrl.host}.`);
				} else if (errorMessage.includes('ENOTFOUND')) {
					this.showMessage('error', `Server not found at ${parsedUrl.hostname}. Please check the URL.`);
				} else if (errorMessage.includes('timeout')) {
					this.showMessage('error', `Connection timed out. Server at ${parsedUrl.host} is not responding.`);
				} else {
					this.showMessage('error', `Failed to connect: ${errorMessage}`);
				}
				return;
			}

			try {
				await testClient.ping();
			} catch (pingError) {
				await testClient.disconnect();
				const errorMessage = pingError instanceof Error ? pingError.message : String(pingError);
				this.showMessage('error', `Server connected but failed to respond: ${errorMessage}`);
				return;
			}

			await testClient.disconnect();
			this.showMessage('success', `Connection successful! ${parsedUrl.host} is responding correctly.`);
		} catch (error) {
			if (testClient)
				testClient.disconnect().catch(() => {
					/* ignore */
				});
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.showMessage('error', `Connection test failed: ${errorMessage}`);
		}
	}

	private async fetchEngineVersions(): Promise<void> {
		if (!this.panel) return;

		try {
			let githubToken: string | undefined;
			try {
				const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
				githubToken = session?.accessToken;
			} catch {
				/* ignore */
			}

			const versions = await this.engineInstaller.getReleases(undefined, githubToken);
			this.panel.webview.postMessage({ type: 'engineVersionsLoaded', versions });
		} catch (error) {
			console.error('[PageWelcomeProvider] Failed to fetch engine versions:', error);
			this.panel.webview.postMessage({ type: 'engineVersionsLoaded', versions: [] });
		}
	}

	private showMessage(level: string, message: string): void {
		this.panel?.webview.postMessage({ type: 'showMessage', level, message });
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
					<p>Run <code>npm run build:webview</code> to build the webview.</p>
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
		this.panel?.dispose();
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
	}
}
