// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarMainProvider — Unified RocketRide sidebar webview provider.
 *
 * Replaces PageConnectionProvider + SidebarFilesProvider with a single
 * webview containing navigation, active tasks list, and connection status.
 */

import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import type { DashboardResponse, DashboardTask } from 'rocketride';
import { ConfigManager } from '../config';
import { ConnectionManager } from '../connection/connection';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { ConnectionState } from '../shared/types';

// =============================================================================
// CONSTANTS
// =============================================================================

const POLL_INTERVAL_MS = 5_000;

// =============================================================================
// PROVIDER
// =============================================================================

export class SidebarMainProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.sidebar.main';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastTasks: DashboardTask[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.setupEventListeners();
	}

	// =========================================================================
	// WEBVIEW LIFECYCLE
	// =========================================================================

	public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		const html = this.getHtmlForWebview(webviewView.webview);
		console.log('[SidebarMainProvider] HTML length:', html.length, 'first 200 chars:', html.substring(0, 200));
		webviewView.webview.html = html;

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready':
						await this.sendFullUpdate();
						if (this.connectionManager.isConnected()) {
							this.startPolling();
						}
						break;
					case 'connect':
						await this.connectionManager.connect();
						break;
					case 'disconnect':
						await this.connectionManager.disconnect();
						break;
					case 'command':
						vscode.commands.executeCommand(message.command);
						break;
					case 'runTask':
						// TODO: implement run via client
						break;
					case 'stopTask':
						this.stopTask(message.projectId, message.source);
						break;
				}
			} catch (error) {
				console.error('[SidebarMainProvider] Message handling error:', error);
			}
		});

		webviewView.onDidDispose(() => {
			this._view = undefined;
			this.stopPolling();
		});
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	private setupEventListeners(): void {
		const connState = this.connectionManager.on('connectionStateChanged', () => {
			this.sendFullUpdate();
		});
		const connected = this.connectionManager.on('connected', () => {
			this.sendFullUpdate();
			this.startPolling();
		});
		const disconnected = this.connectionManager.on('disconnected', () => {
			this.lastTasks = [];
			this.sendFullUpdate();
			this.stopPolling();
		});
		const error = this.connectionManager.on('error', () => {
			this.sendFullUpdate();
		});
		const configChange = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('rocketride')) {
				this.sendFullUpdate();
			}
		});

		this.disposables.push(connState, connected, disconnected, error, configChange);

		// Listen for server events that update task state
		this.connectionManager.on('event', (event: any) => {
			if (event?.event === 'apaevt_dashboard' || event?.event === 'apaevt_task') {
				this.fetchTasks();
			}
		});
	}

	// =========================================================================
	// DATA
	// =========================================================================

	private async sendFullUpdate(): Promise<void> {
		if (!this._view) return;

		const status = this.connectionManager.getConnectionStatus();
		const config = this.configManager.getConfig();

		let cloudUserName = '';
		if (config.connectionMode === 'cloud') {
			cloudUserName = await CloudAuthProvider.getInstance().getUserName();
		}

		this._view.webview.postMessage({
			type: 'update',
			data: {
				connectionState: status.state,
				connectionMode: config.connectionMode,
				cloudUserName,
				tasks: this.lastTasks,
			},
		});
	}

	private async fetchTasks(): Promise<void> {
		if (!this._view || !this.connectionManager.isConnected()) return;

		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			const dashboard: DashboardResponse = await client.getDashboard();
			if (dashboard?.tasks) {
				this.lastTasks = dashboard.tasks;
				this._view.webview.postMessage({
					type: 'tasksUpdate',
					tasks: this.lastTasks,
				});
			}
		} catch {
			// Silently ignore — dashboard may not be available yet
		}
	}

	private startPolling(): void {
		this.stopPolling();
		this.fetchTasks();
		this.pollTimer = setInterval(() => this.fetchTasks(), POLL_INTERVAL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	// =========================================================================
	// TASK ACTIONS
	// =========================================================================

	private async stopTask(projectId: string, source: string): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			const token = await client.getTaskToken({ projectId, source });
			if (token) await client.terminate(token);
		} catch (err) {
			console.error('[SidebarMainProvider] stopTask failed:', err);
		}
	}

	// =========================================================================
	// HTML
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'sidebar-main.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading sidebar: ${error}</p></body></html>`;
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
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		this.stopPolling();
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
