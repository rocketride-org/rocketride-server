// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * StatusProvider — Webview panel for monitoring "Other" (unknown) tasks.
 *
 * Opens a full ProjectView panel (same as ProjectProvider) for tasks that
 * have no local .pipe file.  The pipeline is fetched live from the running task
 * via the rrext_get_pipeline DAP command.  One panel per task, keyed by
 * projectId.sourceId.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { GenericEvent } from '../shared/types';

// =============================================================================
// PROVIDER
// =============================================================================

export class StatusProvider {
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
	 * Show or create a panel for a specific "Other" task.
	 *
	 * @param projectId - Project UUID
	 * @param sourceId - Source component ID
	 * @param displayName - Display name for the panel title
	 */
	public async show(projectId: string, sourceId: string, displayName: string): Promise<void> {
		const key = `${projectId}.${sourceId}`;

		// Reuse existing panel if already open
		const existing = this.panels.get(key);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		// Step 1: fetch the unresolved pipeline from the running task
		const client = this.connectionManager.getClient();
		let pipeline: Record<string, unknown> | undefined;
		if (client) {
			try {
				const token = await client.getTaskToken({ projectId, source: sourceId });
				if (token) {
					pipeline = await client.getTaskPipeline(token);
				}
			} catch (err) {
				console.error('[StatusProvider] Could not fetch task pipeline:', err);
			}
		}

		// Step 2: fall back to a synthesized project if the fetch failed
		const project = pipeline ?? {
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

		// Step 3: create the panel using the same page-project webview
		const panel = vscode.window.createWebviewPanel('rocketride.pageStatus', displayName, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		this.panels.set(key, panel);
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Handle messages from the ProjectWebview
		panel.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready': {
						// Send project:load exactly as ProjectProvider does
						const services = this.connectionManager.getCachedServices()?.services ?? {};
						await panel.webview.postMessage({
							type: 'project:load',
							project,
							viewState: { mode: 'design' },
							prefs: {},
							services,
							isConnected: this.connectionManager.isConnected(),
							isSubscribed: true,
							isReadonly: true,
							statuses: {},
							serverHost: this.connectionManager.getHttpUrl?.() ?? '',
						});
						await panel.webview.postMessage({ type: 'project:dirtyState', isDirty: false, isNew: false });

						// Subscribe to task events
						const c = this.connectionManager.getClient();
						if (c) {
							c.addMonitor({ projectId, source: sourceId }, ['summary', 'flow']).catch((err) => {
								console.error('[StatusProvider] Failed to subscribe to task events:', err);
							});
						}
						break;
					}

					case 'status:pipelineAction': {
						// Stop is the only meaningful action (no .pipe file to run from)
						if (message.action === 'stop') {
							try {
								const c = this.connectionManager.getClient();
								if (!c) return;
								const token = await c.getTaskToken({ projectId, source: sourceId });
								if (token) await c.terminate(token);
							} catch (err) {
								console.error('[StatusProvider] Stop failed:', err);
							}
						}
						break;
					}

					case 'project:validate': {
						// Respond immediately with empty result — no file to validate against
						await panel.webview.postMessage({
							type: 'project:validateResponse',
							requestId: message.requestId,
							result: { errors: [], warnings: [] },
						});
						break;
					}

					// No file to save or persist — ignore these
					case 'project:requestSave':
					case 'project:contentChanged':
					case 'project:viewStateChange':
					case 'project:prefsChange':
						break;
				}
			} catch (error) {
				console.error('[StatusProvider] Message handling error:', error);
			}
		});

		// Cleanup on dispose
		panel.onDidDispose(() => {
			this.panels.delete(key);
			const c = this.connectionManager.getClient();
			if (c) {
				c.removeMonitor({ projectId, source: sourceId }, ['summary', 'flow']).catch(() => {});
			}
		});
	}

	// =========================================================================
	// EVENT FORWARDING
	// =========================================================================

	/** Forward connection and server events to all open panels. */
	private setupEventListeners(): void {
		const connChange = this.connectionManager.on('shell:statusChange', () => {
			const isConnected = this.connectionManager.isConnected();
			for (const panel of this.panels.values()) {
				panel.webview.postMessage({ type: 'shell:connectionChange', isConnected });
			}
		});

		this.connectionManager.on('shell:event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_status_update' || event?.event === 'apaevt_task' || event?.event === 'apaevt_flow') {
				for (const panel of this.panels.values()) {
					panel.webview.postMessage({ type: 'shell:event', event });
				}
			}
		});

		this.disposables.push(connChange);
	}

	// =========================================================================
	// HTML
	// =========================================================================

	/** Load page-project.html — the same webview used for disk-based .pipe files. */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-project.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading project viewer: ${error}</p></body></html>`;
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
