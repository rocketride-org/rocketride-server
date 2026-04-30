// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Monitor Page Provider for Server Monitor
 *
 * Creates and manages a webview panel showing the <ServerMonitor /> component.
 * Handles SDK communication (getDashboard polling + apaevt_dashboard events)
 * and bridges data to the React webview via postMessage.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';
import { ConnectionStatus, ConnectionState, GenericEvent } from '../shared/types';
import type { DashboardResponse } from 'rocketride';

const POLL_INTERVAL_MS = 5_000;

export class PageMonitorProvider {
	private panel: vscode.WebviewPanel | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private disposables: vscode.Disposable[] = [];
	private logger = getLogger();
	private connectionManager = ConnectionManager.getInstance();
	private hasWildcardMonitor = false;
	private fetchInProgress = false;
	private fetchPending = false;

	constructor(private context: vscode.ExtensionContext) {
		this.setupEventListeners();
		this.registerCommands();
	}

	// =========================================================================
	// Commands
	// =========================================================================

	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.page.monitor.open', () => {
			this.show();
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// Show / Reveal
	// =========================================================================

	public show(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel('rocketride.pageMonitor', 'Server Monitor', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		this.panel = panel;
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Handle messages from webview
		panel.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready':
						// Send initial connection state so the webview knows if we're connected
						await panel.webview.postMessage({
							type: 'shell:init',
							theme: {},
							isConnected: this.connectionManager.isConnected(),
						});
						await this.fetchAndPost();
						this.subscribeDashboardEvents().catch((err) => {
							this.logger.error(`[PageMonitorProvider] Event subscription error: ${err}`);
						});
						this.startPolling();
						break;
					case 'monitor:refresh':
						await this.fetchAndPost();
						break;
				}
			} catch (error) {
				this.logger.error(`[PageMonitorProvider] Message handling error: ${error}`);
			}
		});

		// Cleanup on dispose
		panel.onDidDispose(() => {
			this.stopPolling();
			this.unsubscribeDashboardEvents();
			this.panel = null;
		});
	}

	// =========================================================================
	// Data Fetching
	// =========================================================================

	private async fetchAndPost(): Promise<void> {
		if (!this.panel || !this.connectionManager.isConnected()) return;

		// Coalesce overlapping requests: if a fetch is already running,
		// mark pending and let the in-flight request trigger a follow-up.
		if (this.fetchInProgress) {
			this.fetchPending = true;
			return;
		}

		this.fetchInProgress = true;
		try {
			const client = this.connectionManager.getClient();
			if (!client) {
				this.logger.error(`[PageMonitorProvider] No client available for dashboard`);
				return;
			}
			const dashboard = await client.getDashboard();
			await this.panel.webview.postMessage({ type: 'monitor:dashboard', data: dashboard as DashboardResponse });
		} catch (error) {
			this.logger.error(`[PageMonitorProvider] Failed to fetch dashboard: ${error}`);
		} finally {
			this.fetchInProgress = false;
			if (this.fetchPending) {
				this.fetchPending = false;
				this.fetchAndPost().catch((err) => {
					this.logger.error(`[PageMonitorProvider] Coalesced fetch error: ${err}`);
				});
			}
		}
	}

	private async subscribeDashboardEvents(): Promise<void> {
		if (this.hasWildcardMonitor) return;
		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			await client.addMonitor({ token: '*' }, ['task', 'summary', 'dashboard']);
			this.hasWildcardMonitor = true;
		} catch (error) {
			this.logger.error(`[PageMonitorProvider] Failed to subscribe dashboard events: ${error}`);
		}
	}

	private async unsubscribeDashboardEvents(): Promise<void> {
		if (!this.hasWildcardMonitor) return;
		try {
			const client = this.connectionManager.getClient();
			if (client) await client.removeMonitor({ token: '*' }, ['task', 'summary', 'dashboard']);
		} catch {
			// Best-effort; connection may already be gone
		}
		this.hasWildcardMonitor = false;
	}

	// =========================================================================
	// Polling
	// =========================================================================

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			this.fetchAndPost().catch((error) => {
				this.logger.error(`[PageMonitorProvider] Poll error: ${error}`);
			});
		}, POLL_INTERVAL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	// =========================================================================
	// Event Listeners
	// =========================================================================

	private setupEventListeners(): void {
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', (status: ConnectionStatus) => {
			this.handleConnectionStateChange(status).catch((error) => {
				this.logger.error(`[PageMonitorProvider] Connection state change error: ${error}`);
			});
		});

		const eventListener = this.connectionManager.on('event', (event: GenericEvent) => {
			this.handleEvent(event);
		});

		this.disposables.push(connectionStateListener, eventListener);
	}

	private async handleConnectionStateChange(status: ConnectionStatus): Promise<void> {
		if (!this.panel) return;

		await this.panel.webview.postMessage({ type: 'shell:connectionChange', isConnected: status.state === ConnectionState.CONNECTED });

		if (status.state === ConnectionState.CONNECTED) {
			// SDK replays monitor subscriptions automatically on reconnect;
			// just refresh data and restart polling.
			await this.fetchAndPost();
			this.startPolling();
		} else if (status.state === ConnectionState.DISCONNECTED) {
			this.stopPolling();
		}
	}

	private handleEvent(event: GenericEvent): void {
		if (!this.panel) return;

		if (event.event === 'apaevt_task' || event.event === 'apaevt_dashboard') {
			this.panel.webview.postMessage({ type: 'server:event', event }).then(undefined, (err: unknown) => {
				this.logger.error(`[PageMonitorProvider] Failed to post server event: ${err}`);
			});
		}
	}

	// =========================================================================
	// HTML Generation
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-monitor.html');

		try {
			let htmlContent = readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Server Monitor</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
                <p>Expected: <code>${htmlPath.fsPath}</code></p>
            </body></html>`;
		}
	}

	private generateNonce(): string {
		return crypto.randomBytes(32).toString('base64url');
	}

	// =========================================================================
	// Disposal
	// =========================================================================

	public dispose(): void {
		this.stopPolling();
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		if (this.panel) {
			this.panel.dispose();
			this.panel = null;
		}
	}
}
