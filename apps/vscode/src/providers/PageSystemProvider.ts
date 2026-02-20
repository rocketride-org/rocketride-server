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
 * System Performance Page Provider
 * 
 * Provides a system performance monitoring dashboard using a webview-based interface including:
 * - Real-time CPU, memory, and disk utilization
 * - Historical performance charts with rolling data
 * - GPU information and system platform details
 * - Path-specific disk usage (cache, control, data, log)
 * 
 * Uses the DAP command 'apaext_sysinfo' to poll system information at regular intervals
 * and provides visualization through Chart.js-based rolling charts.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';
import { ConnectionStatus, ConnectionState } from '../shared/types';
import type { PageSystemIncomingMessage, PageSystemOutgoingMessage, SystemInfo } from '../shared/types/pageSystem';

/**
 * System performance page provider for monitoring system resources
 */
export class PageSystemProvider {
	private webviewPanel?: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];
	private logger = getLogger();
	private connectionManager = ConnectionManager.getInstance();
	private pollingInterval?: NodeJS.Timeout;
	private isMonitoring: boolean = false;
	private isDisposed: boolean = false;
	
	// Polling configuration
	private readonly POLL_INTERVAL_MS = 2000; // Poll every 2 seconds

	/**
	 * Creates a new PageSystemProvider
	 * 
	 * @param context VS Code extension context for command registration
	 */
	constructor(private context: vscode.ExtensionContext) {
		this.setupEventListeners();
		this.registerCommands();
	}

	/**
	 * Registers all commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.page.system.open', async () => {
				try {
					await this.show();
				} catch (error) {
					this.logger.error(`Opening system performance page: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.page.system.close', () => {
				try {
					this.close();
				} catch (error) {
					this.logger.error(`Closing system performance page: ${error}`);
				}
			})
		];

		// Store disposables and add to context subscriptions
		this.disposables.push(...commands);
		commands.forEach(command => this.context.subscriptions.push(command));
	}

	/**
	 * Sets up event listeners for connection and DAP events
	 */
	private setupEventListeners(): void {
		// Listen for connection state changes
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', (connectionStatus: ConnectionStatus) => {
			this.handleConnectionStateChange(connectionStatus).catch(error => {
				this.logger.error(`Handle connectionStateChange: ${error}`);
			});
		});

		// Keep track of disposables
		this.disposables.push(connectionStateListener);
	}

	/**
	 * Handles connection state changes
	 * 
	 * @param connectionStatus The new connection status
	 */
	private async handleConnectionStateChange(connectionStatus: ConnectionStatus): Promise<void> {
		if (connectionStatus.state === ConnectionState.CONNECTED) {
			// Start polling when connected
			if (this.webviewPanel && !this.isDisposed) {
				await this.startPolling();
			}
		} else {
			// Stop polling when disconnected
			await this.stopPolling();
		}

		// Notify webview of connection state change
		if (this.webviewPanel && !this.isDisposed) {
			const message: PageSystemIncomingMessage = {
				type: 'connectionState',
				state: connectionStatus.state
			};

			try {
				await this.webviewPanel.webview.postMessage(message);
			} catch (error) {
				this.logger.error(`Posting connection state to webview: ${error}`);
			}
		}
	}

	/**
	 * Starts polling for system information
	 */
	private async startPolling(): Promise<void> {
		if (this.isMonitoring || !this.connectionManager.isConnected()) {
			return;
		}

		this.isMonitoring = true;

		// Immediate first poll
		await this.pollSystemInfo();

		// Set up recurring polling
		this.pollingInterval = setInterval(() => {
			this.pollSystemInfo().catch(error => {
				this.logger.error(`Polling system info: ${error}`);
			});
		}, this.POLL_INTERVAL_MS);
	}

	/**
	 * Stops polling for system information
	 */
	private async stopPolling(): Promise<void> {
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval);
			this.pollingInterval = undefined;
		}
		this.isMonitoring = false;
	}

	/**
	 * Polls system information using DAP command
	 */
	private async pollSystemInfo(): Promise<void> {
		if (!this.connectionManager.isConnected() || this.isDisposed || !this.webviewPanel) {
			return;
		}

		try {
			const response = await this.connectionManager.request('apaext_sysinfo', {});
			
			// Check if the response was successful
			if (response && response.success === false) {
				// Server returned an error
				const errorMessage = response.message || 'Unknown error from server';
				this.logger.error(`System info error from server: ${errorMessage}`);
				
				// Send error to webview
				const message: PageSystemIncomingMessage = {
					type: 'error',
					error: errorMessage,
					state: ConnectionState.CONNECTED
				};
				
				await this.webviewPanel.webview.postMessage(message);
				return;
			}
			
			// The system info is directly in response.body, not response.body.sysinfo
			if (response?.body) {
				const systemInfo: SystemInfo = response.body as SystemInfo;
				
				// Send update to webview
				const message: PageSystemIncomingMessage = {
					type: 'update',
					systemInfo: systemInfo,
					state: ConnectionState.CONNECTED
				};

				await this.webviewPanel.webview.postMessage(message);
			} else {
				this.logger.error('System info response missing body');
			}
		} catch (error) {
			this.logger.error(`Fetching system info: ${error}`);
			
			// Send error to webview
			if (this.webviewPanel && !this.isDisposed) {
				const message: PageSystemIncomingMessage = {
					type: 'error',
					error: `Failed to fetch system info: ${error}`,
					state: ConnectionState.CONNECTED
				};
				
				await this.webviewPanel.webview.postMessage(message);
			}
		}
	}

	/**
	 * Shows or creates the system performance page
	 */
	public async show(): Promise<void> {
		// If panel already exists, just reveal it
		if (this.webviewPanel) {
			this.webviewPanel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Create new webview panel
		this.webviewPanel = vscode.window.createWebviewPanel(
			'rocketrideSystemPerformance',
			'System Performance',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))
				]
			}
		);

		// Set HTML content
		this.webviewPanel.webview.html = this.getHtmlForWebview(this.webviewPanel.webview);

		// Handle messages from webview
		this.webviewPanel.webview.onDidReceiveMessage(
			async (message: PageSystemOutgoingMessage) => {
				switch (message.type) {
					case 'ready':
						// Webview is ready, send initial state
						await this.sendInitialState();
						break;
				}
			},
			undefined,
			this.disposables
		);

		// Handle panel disposal
		this.webviewPanel.onDidDispose(
			() => {
				this.handlePanelDisposed();
			},
			null,
			this.disposables
		);

		// Start polling if connected
		if (this.connectionManager.isConnected()) {
			await this.startPolling();
		}

		this.isDisposed = false;
	}

	/**
	 * Sends initial state to the webview
	 */
	private async sendInitialState(): Promise<void> {
		if (!this.webviewPanel || this.isDisposed) {
			return;
		}

		const connectionState = this.connectionManager.isConnected() 
			? ConnectionState.CONNECTED 
			: ConnectionState.DISCONNECTED;

		const message: PageSystemIncomingMessage = {
			type: 'connectionState',
			state: connectionState
		};

		try {
			await this.webviewPanel.webview.postMessage(message);
		} catch (error) {
			this.logger.error(`Sending initial state: ${error}`);
		}

		// If connected, immediately poll for data
		if (connectionState === ConnectionState.CONNECTED) {
			await this.pollSystemInfo();
		}
	}

	/**
	 * Handles panel disposal
	 */
	private handlePanelDisposed(): void {
		this.isDisposed = true;
		this.stopPolling();
		this.webviewPanel = undefined;
	}

	/**
	 * Closes the system performance page
	 */
	public close(): void {
		if (this.webviewPanel) {
			this.webviewPanel.dispose();
		}
	}

	/**
	 * Disposes of all resources
	 */
	public dispose(): void {
		this.close();
		this.stopPolling();
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}

	/**
	 * Generates HTML content for the webview
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-system.html');

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
						vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath)
					);
					return match.replace(relativePath, resourceUri.toString());
				}
			);
		} catch (error) {
			this.logger.error(`Loading system page HTML: ${error}`);
			return this.getErrorHtml(error, htmlPath.fsPath);
		}
	}

	/**
	 * Generates error HTML when page fails to load
	 */
	private getErrorHtml(error: unknown, htmlPath: string): string {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Error Loading Page</title>
				<style>
					body {
						font-family: var(--vscode-font-family);
						padding: 20px;
						color: var(--vscode-foreground);
						background-color: var(--vscode-editor-background);
					}
					.error {
						color: var(--vscode-errorForeground);
						padding: 10px;
						border: 1px solid var(--vscode-errorBorder);
						background-color: var(--vscode-inputValidation-errorBackground);
						border-radius: 4px;
					}
					pre {
						background-color: var(--vscode-textCodeBlock-background);
						padding: 10px;
						border-radius: 4px;
						overflow-x: auto;
					}
				</style>
			</head>
			<body>
				<h1>Failed to Load System Performance Page</h1>
				<div class="error">
					<strong>Error:</strong> ${String(error)}
				</div>
				<p>Expected HTML path: <code>${htmlPath}</code></p>
				<p>Please ensure the extension is built correctly:</p>
				<pre>pnpm run build</pre>
			</body>
			</html>`;
	}

	/**
	 * Generates a nonce for CSP
	 */
	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}
}

