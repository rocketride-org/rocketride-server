// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageStatusProvider — Standalone webview panel for viewing task status.
 *
 * Opens a status-only ProjectView for tasks that have no local .pipe file
 * (unknown tasks from the "Other" section in the sidebar).  One panel per
 * task, keyed by projectId.sourceId.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { GenericEvent } from '../shared/types';

// =============================================================================
// PROVIDER
// =============================================================================

export class PageStatusProvider {
	private panels = new Map<string, vscode.WebviewPanel>();
	private disposables: vscode.Disposable[] = [];
	private connectionManager = ConnectionManager.getInstance();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.setupEventListeners();
	}

	// =========================================================================
	// PUBLIC
	// =========================================================================

	/**
	 * Show or create a status panel for a specific task.
	 *
	 * @param projectId - Project UUID
	 * @param sourceId - Source component ID
	 * @param displayName - Display name for the panel title
	 */
	public show(projectId: string, sourceId: string, displayName: string): void {
		const key = `${projectId}.${sourceId}`;

		// Reuse existing panel if already open
		const existing = this.panels.get(key);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		// Create new panel
		const panel = vscode.window.createWebviewPanel('rocketride.pageStatus', displayName, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		this.panels.set(key, panel);
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Synthesize a minimal project for the status view
		const synthesizedProject = {
			project_id: projectId,
			components: [
				{
					id: sourceId,
					name: displayName,
					provider: 'unknown',
					config: { mode: 'Source', name: displayName },
				},
			],
		};

		// Handle messages from webview
		panel.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready': {
						await panel.webview.postMessage({
							type: 'status:init',
							project: synthesizedProject,
							isConnected: this.connectionManager.isConnected(),
							serverHost: this.connectionManager.getHttpUrl?.() ?? '',
						});
						// Subscribe to task events so the server pushes status updates
						const client = this.connectionManager.getClient();
						if (client) {
							client.addMonitor({ projectId, source: sourceId }, ['summary', 'flow']).catch((err) => {
								console.error('[PageStatusProvider] Failed to subscribe to task events:', err);
							});
						}
						break;
					}

					case 'status:pipelineAction': {
						// Only stop is meaningful for unknown tasks
						if (message.action === 'stop') {
							try {
								const client = this.connectionManager.getClient();
								if (!client) return;
								const token = await client.getTaskToken({ projectId, source: sourceId });
								if (token) await client.terminate(token);
							} catch (err) {
								console.error('[PageStatusProvider] Stop failed:', err);
							}
						}
						break;
					}
				}
			} catch (error) {
				console.error('[PageStatusProvider] Message handling error:', error);
			}
		});

		// Cleanup on dispose
		panel.onDidDispose(() => {
			this.panels.delete(key);
			const client = this.connectionManager.getClient();
			if (client) {
				client.removeMonitor({ projectId, source: sourceId }, ['summary', 'flow']).catch(() => {});
			}
		});
	}

	// =========================================================================
	// EVENT FORWARDING
	// =========================================================================

	/** Forward relevant server events to all open status panels. */
	private setupEventListeners(): void {
		const connChange = this.connectionManager.on('connectionStateChanged', () => {
			const isConnected = this.connectionManager.isConnected();
			for (const panel of this.panels.values()) {
				panel.webview.postMessage({ type: 'shell:connectionChange', isConnected });
			}
		});

		this.connectionManager.on('event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_status_update' || event?.event === 'apaevt_task' || event?.event === 'apaevt_flow') {
				for (const panel of this.panels.values()) {
					panel.webview.postMessage({ type: 'server:event', event });
				}
			}
		});

		this.disposables.push(connChange);
	}

	// =========================================================================
	// HTML
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-status.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading status viewer: ${error}</p></body></html>`;
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
		for (const panel of this.panels.values()) {
			panel.dispose();
		}
		this.panels.clear();
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
