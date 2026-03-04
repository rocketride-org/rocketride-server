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
 * Connection Webview Provider for Connection Management
 * 
 * Provides a rich webview interface for connection management with:
 * - Real-time connection status updates
 * - Visual connection state indicators
 * - Interactive connection controls
 * - Configuration status display
 * - Settings access
 */

import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { ConfigManager } from '../config';
import { ConnectionManager } from '../connection/connection';

export class PageConnectionProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.provider.connection';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();

	constructor(private readonly extensionUri: vscode.Uri) {
		this.setupEventListeners();
	}

	/**
	 * Resolves the webview view
	 */
	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		// Handle messages from the webview
		const messageDisposable = webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'ready':
						await this.sendConnectionUpdate();
						break;

					case 'connect':
						await this.connectionManager.connect();
						break;

					case 'disconnect':
						await this.connectionManager.disconnect();
						break;

					case 'reconnect':
						await this.connectionManager.reconnect();
						break;

				case 'openSettings':
					vscode.commands.executeCommand('rocketride.page.settings.open');
					break;

			case 'openDocs':
				vscode.env.openExternal(vscode.Uri.parse('https://docs.rocketride.org'));
				break;

			case 'openDeploy':
				vscode.commands.executeCommand('rocketride.page.deploy.open');
				break;

		}
		} catch (error) {
			console.error('[PageConnectionProvider] Message handling error:', error);
		}
		});

		this.disposables.push(messageDisposable);
	}

	/**
	 * Sets up event listeners for connection and configuration changes
	 */
	private setupEventListeners(): void {
		// Listen for connection state changes
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', () => {
			this.sendConnectionUpdate();
		});

		const connectedListener = this.connectionManager.on('connected', () => {
			this.sendConnectionUpdate();
		});

		const errorListener = this.connectionManager.on('error', () => {
			this.sendConnectionUpdate();
		});

		// Listen for config changes
		const configChangeListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('rocketride')) {
				this.sendConnectionUpdate();
			}
		});

		this.disposables.push(
			connectionStateListener,
			connectedListener,
			errorListener,
			configChangeListener
		);
	}

	/**
	 * Sends connection status update to webview
	 */
	private async sendConnectionUpdate(): Promise<void> {
		if (!this._view) {
			return;
		}

		try {
			const connectionState = this.connectionManager.getConnectionStatus();
			const config = this.configManager.getConfig();
			const hasApiKey = this.configManager.hasApiKey();
			const engineInfo = this.connectionManager.getEngineInfo();

			this._view.webview.postMessage({
				type: 'connectionUpdate',
				data: {
					connectionState,
					config: {
						hostUrl: RocketRideClient.normalizeUri(config.hostUrl),
						connectionMode: config.connectionMode,
						autoConnect: config.autoConnect
					},
					hasApiKey,
					engineInfo
				}
			});
		} catch (error) {
			console.error('[PageConnectionProvider] Failed to send connection update:', error);
		}
	}

	/**
	 * Generates HTML content for the webview
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'page-connection.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			// Replace template placeholders
			htmlContent = htmlContent
				.replace(/\{\{nonce\}\}/g, nonce)
				.replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Convert resource URLs to webview URIs
			return htmlContent.replace(
				/(?:src|href)="(\/static\/[^"]+)"/g,
				(match: string, relativePath: string): string => {
					const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
					const resourceUri = webview.asWebviewUri(
						vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath)
					);
					return match.replace(relativePath, resourceUri.toString());
				}
			);
		} catch (error) {
			console.error('Error loading connection HTML:', error);
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
			<title>Connection View Error</title>
		</head>
		<body>
			<div style="padding: 20px; color: #f44336;">
				<h3>Error Loading Connection View</h3>
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
	 * Public method to refresh the connection view
	 */
	public refresh(): void {
		this.sendConnectionUpdate();
	}

	/**
	 * Cleans up event listeners and resources
	 */
	public dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
		this.disposables = [];
	}
}
