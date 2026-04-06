// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Monitor Page Provider for Server Monitor
 *
 * Creates and manages a webview panel showing the <ServerMonitor /> component.
 * Handles DAP communication (rrext_dashboard polling + apaevt_dashboard events)
 * and bridges data to the React webview via postMessage.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';
import { MonitorManager } from '../connection/monitor-manager';
import { ConnectionStatus, ConnectionState, GenericEvent } from '../shared/types';
import type { PageMonitorIncomingMessage } from '../shared/types/pageMonitor';
import type { DashboardResponse, DashboardEvent } from 'rocketride';

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
					case 'ready':
						await this.fetchAndPost();
						this.subscribeDashboardEvents().catch((err) => {
							this.logger.error(`[PageMonitorProvider] Event subscription error: ${err}`);
						});
						this.startPolling();
						break;
					case 'refresh':
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
			const response = await this.connectionManager.request('rrext_dashboard', {});
			if (!response) {
				this.logger.error(`[PageMonitorProvider] No response from rrext_dashboard`);
				return;
			}
			if (!response.success) {
				this.logger.error(`[PageMonitorProvider] rrext_dashboard failed: ${response.message}`);
				return;
			}
			if (response.body) {
				// response.body is GenericBody (Record<string, any>) — upcast to the
				// concrete dashboard shape returned by rrext_dashboard.
				const msg: PageMonitorIncomingMessage = {
					type: 'dashboardData',
					data: response.body as DashboardResponse,
				};
				await this.panel.webview.postMessage(msg);
			}
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
			// Subscribe via MonitorManager (reference-counted, safe for shared connection)
			await MonitorManager.getInstance().addMonitor({ token: '*' }, ['task', 'summary', 'dashboard']);
			this.hasWildcardMonitor = true;
		} catch (error) {
			this.logger.error(`[PageMonitorProvider] Failed to subscribe dashboard events: ${error}`);
		}
	}

	private async unsubscribeDashboardEvents(): Promise<void> {
		if (!this.hasWildcardMonitor) return;
		try {
			await MonitorManager.getInstance().removeMonitor({ token: '*' }, ['task', 'summary', 'dashboard']);
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

		const msg: PageMonitorIncomingMessage = { type: 'connectionState', state: status.state };
		await this.panel.webview.postMessage(msg);

		if (status.state === ConnectionState.CONNECTED) {
			await this.fetchAndPost();
			await this.subscribeDashboardEvents();
			this.startPolling();
		} else {
			this.stopPolling();
		}
	}

	private handleEvent(event: GenericEvent): void {
		if (!this.panel) return;

		if (event.event === 'apaevt_task') {
			this.fetchAndPost().catch((err) => {
				this.logger.error(`[PageMonitorProvider] Refresh error: ${err}`);
			});
			this.panel.webview.postMessage({ type: 'taskEvent', body: event.body as Record<string, unknown> }).then(undefined, (err: unknown) => {
				this.logger.error(`[PageMonitorProvider] Failed to post task event: ${err}`);
			});
		} else if (event.event === 'apaevt_dashboard') {
			this.fetchAndPost().catch((err) => {
				this.logger.error(`[PageMonitorProvider] Refresh error: ${err}`);
			});
			this.panel.webview.postMessage({ type: 'dashboardEvent', body: event.body as DashboardEvent }).then(undefined, (err: unknown) => {
				this.logger.error(`[PageMonitorProvider] Failed to post dashboard event: ${err}`);
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
