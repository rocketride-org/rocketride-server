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
 * PageAuthProvider — authentication recovery page.
 *
 * Opened automatically when a connection attempt fails with an
 * AuthenticationException. Shows the appropriate credential form based on
 * the active connection mode (Cloud sign-in, On-prem API key, etc.).
 *
 * After the user fixes their credentials, "Save & Connect" persists them
 * and triggers an immediate reconnect via connectionManager.settingsApplied().
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../config';
import { getConnectionManager } from '../extension';
import { ConnectionMessageHandler } from './shared/connection-message-handler';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';

// =============================================================================
// PROVIDER
// =============================================================================

export class PageAuthProvider {
	private disposables: vscode.Disposable[] = [];
	private configManager: ConfigManager;
	private connHandler: ConnectionMessageHandler;
	private panel: vscode.WebviewPanel | undefined;
	private pendingConnectionMode: string | undefined;
	private pendingErrorMessage: string | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri
	) {
		this.configManager = ConfigManager.getInstance();
		this.connHandler = new ConnectionMessageHandler({
			extensionFsPath: extensionUri.fsPath,
			getActiveWebviews: () => (this.panel ? [this.panel.webview] : []),
		});
		this.registerCommands();
	}

	// =========================================================================
	// COMMANDS
	// =========================================================================

	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.page.auth.open', async (connectionMode?: string, errorMessage?: string) => {
			this.pendingConnectionMode = connectionMode;
			this.pendingErrorMessage = errorMessage;
			await this.show();
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// SHOW / LIFECYCLE
	// =========================================================================

	/**
	 * Creates or reveals the auth panel.
	 */
	public async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			// Re-send init in case mode/error changed
			this.sendInit();
			return;
		}

		this.panel = vscode.window.createWebviewPanel('rocketrideAuth', 'RocketRide: Sign In', vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
			retainContextWhenHidden: false,
		});

		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

		// --- Message handler -----------------------------------------------------
		const messageDisposable = this.panel.webview.onDidReceiveMessage(async (message) => {
			if (!this.panel) return;
			try {
				switch (message.type) {
					case 'view:ready':
						this.sendInit();
						break;

					case 'saveCredentials':
						await this.saveAndConnect(message);
						break;

					default: {
						// Delegate cloud auth messages (cloud:signIn, cloud:signOut, cloud:getStatus, fetchTeams)
						const handled = await this.connHandler.handleMessage(message, this.panel.webview);
						if (handled) break;
						console.warn('[PageAuthProvider] Unhandled message type:', message.type);
						break;
					}
				}
			} catch (error) {
				console.error('[PageAuthProvider] Message handling error:', error);
				this.panel?.webview.postMessage({ type: 'showMessage', level: 'error', message: `Error: ${error}` });
			}
		});
		this.disposables.push(messageDisposable);

		// Listen for cloud auth changes (e.g. PKCE callback completes)
		const panelWebview = this.panel.webview;
		const cleanupCloudAuth = this.connHandler.registerCloudAuthListener(panelWebview);

		// When PKCE sign-in completes (cloud mode), auto-reconnect and close.
		const cloudAuth = CloudAuthProvider.getInstance();
		const onAuthChanged = async () => {
			try {
				const signedIn = await cloudAuth.isSignedIn();
				if (signedIn) {
					this.panel?.dispose();
					const connectionManager = getConnectionManager();
					if (connectionManager) {
						await connectionManager.settingsApplied();
					}
				}
			} catch (error) {
				console.error('[PageAuthProvider] Reconnect after sign-in failed:', error);
			}
		};
		cloudAuth.onDidChange.on('changed', onAuthChanged);

		this.panel.onDidDispose(() => {
			cleanupCloudAuth();
			cloudAuth.onDidChange.removeListener('changed', onAuthChanged);
			this.panel = undefined;
			const index = this.disposables.indexOf(messageDisposable);
			if (index !== -1) {
				this.disposables.splice(index, 1);
			}
		});
	}

	// =========================================================================
	// MESSAGING
	// =========================================================================

	/**
	 * Send the initial state to the webview so it knows which mode to render.
	 */
	private sendInit(): void {
		if (!this.panel) return;

		const config = this.configManager.getConfig();
		const connectionMode = this.pendingConnectionMode || config.connectionMode;

		let apiKey = '';
		if (this.configManager.hasApiKey()) {
			try {
				apiKey = config.apiKey || '';
			} catch {
				/* ignore */
			}
		}

		this.panel.webview.postMessage({
			type: 'init',
			connectionMode,
			errorMessage: this.pendingErrorMessage || 'Authentication failed',
			hostUrl: config.hostUrl,
			apiKey,
		});

		// Also send cloud auth status so CloudPanel knows the state
		this.connHandler.sendCloudStatus(this.panel.webview);
	}

	// =========================================================================
	// SAVE & CONNECT
	// =========================================================================

	/**
	 * Persist new credentials and trigger a reconnect.
	 * On success, close the auth panel.
	 */
	private async saveAndConnect(message: Record<string, unknown>): Promise<void> {
		try {
			// Persist API key if provided (on-prem, docker, service)
			if (typeof message.apiKey === 'string') {
				if (message.apiKey.trim() !== '') {
					await this.configManager.setApiKey(message.apiKey.trim());
				} else {
					await this.configManager.deleteApiKey();
				}
			}

			// Persist host URL if provided (on-prem)
			if (typeof message.hostUrl === 'string') {
				const workspaceConfig = vscode.workspace.getConfiguration('rocketride');
				await workspaceConfig.update('hostUrl', message.hostUrl, vscode.ConfigurationTarget.Global);
			}

			// Close the panel before reconnecting
			this.panel?.dispose();

			// Trigger reconnect with updated credentials
			const connectionManager = getConnectionManager();
			if (connectionManager) {
				await connectionManager.settingsApplied();
			}
		} catch (error) {
			console.error('[PageAuthProvider] Failed to save credentials:', error);
			this.panel?.webview.postMessage({ type: 'showMessage', level: 'error', message: `Failed to save: ${error}` });
		}
	}

	// =========================================================================
	// HTML
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'page-auth.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			console.error('Error loading auth HTML:', error);
			return `<!DOCTYPE html>
			<html lang="en">
			<head><meta charset="UTF-8"><title>Auth Error</title></head>
			<body>
				<div style="padding: 20px; color: #f44336;">
					<h3>Error Loading Auth View</h3>
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

	// =========================================================================
	// DISPOSE
	// =========================================================================

	public dispose(): void {
		this.connHandler.dispose();
		this.panel?.dispose();
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
	}
}
