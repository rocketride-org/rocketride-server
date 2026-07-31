// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppScreenProvider — one App Builder panel per app (page-app webview).
 *
 * Modeled on StatusProvider: WebviewPanels keyed in a Map (by appId),
 * reveal-or-create, retainContextWhenHidden, the shared nonce+CSP HTML
 * pipeline. The webview is THIN (decision D7) — it mounts the shared
 * AppBuilderScreen and bridges every action over postMessage; this provider
 * answers the bridge: init payload (app facts + preview URL + capability
 * flags), F5 debug, reveal-in-explorer, and forwards shell events + watch
 * status into the webview's feed panes.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { GenericEvent } from '../shared/types';
import { scanWorkspaceApps } from '../appdev/appScan';
import type { ScannedApp } from '../appdev/appScan';
import { ensureWatch, getWatchManager } from '../appdev/watchManager';

// =============================================================================
// TYPES
// =============================================================================

/** Watch status shape forwarded to the webview DEV badge. */
export interface AppWatchStatus {
	state: 'idle' | 'building' | 'ok' | 'error';
	durationMs?: number;
	target?: string;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class AppScreenProvider {
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
	 * Show or create the App Builder panel for an app.
	 *
	 * @param appId - The app id (appManifest.id).
	 */
	public async show(appId: string): Promise<void> {
		// Reuse existing panel if already open
		const existing = this.panels.get(appId);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		// Resolve the app's facts from the workspace binding
		const apps = await scanWorkspaceApps();
		const app = apps.find((a) => a.id === appId);
		const title = app?.name ?? appId;

		const panel = vscode.window.createWebviewPanel('rocketride.pageApp', title, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});
		this.panels.set(appId, panel);
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Bridge: answer the webview's messages
		panel.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready': {
						await panel.webview.postMessage({
							type: 'appdev:init',
							app: this.buildAppSummary(appId, app),
							previewUrl: this.buildPreviewUrl(appId),
							// VSCode variant: files are native, F5 debugs, no Code pane
							capabilities: { hasCodePane: false, hasNativeFiles: true, canDebug: true },
							stage: this.context.workspaceState.get(`appdev.stage.${appId}`) ?? 'develop',
						});
						break;
					}

					case 'appdev:stage':
						// Persist the active view per app (survives panel close)
						await this.context.workspaceState.update(`appdev.stage.${appId}`, message.stage);
						break;

					case 'appdev:debug':
						await vscode.commands.executeCommand('rocketride.app.debug', appId);
						break;

					case 'appdev:reveal': {
						// Reveal the bound folder in the OS file explorer; inside
						// the workspace the VSCode explorer is a better target.
						if (app?.folder) {
							await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(app.folder));
						}
						break;
					}
				}
			} catch (error) {
				console.error('[AppScreenProvider] Message handling error:', error);
			}
		});

		panel.onDidDispose(() => {
			this.panels.delete(appId);
			// The App Screen owns the watch lifecycle: closing it ends the
			// session and drops the dev overlay (shell returns to published).
			void getWatchManager()?.stop(appId);
		});

		// Start the inner loop (setting-gated by rocketride.appdev.autoWatch)
		if (app) void ensureWatch(app);
	}

	/**
	 * Push a watch/build status update into an app's panel (DEV badge).
	 *
	 * @param appId - The app whose watch state changed.
	 * @param status - The new watch status.
	 */
	public notifyWatch(appId: string, status: AppWatchStatus): void {
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:watch', status });
	}

	/**
	 * Trigger a preview reload in an app's panel (successful rebuild).
	 *
	 * @param appId - The app whose bundle was rebuilt.
	 */
	public notifyReload(appId: string): void {
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:reload' });
	}

	// =========================================================================
	// INIT PAYLOAD HELPERS
	// =========================================================================

	/** Builds the AppSummary the shared screen renders (header + trailing note). */
	private buildAppSummary(appId: string, app: ScannedApp | undefined): Record<string, unknown> {
		return {
			id: appId,
			moduleId: app?.moduleId ?? appId.replace(/[.-]/g, '_'),
			name: app?.name ?? appId,
			version: app?.version,
			description: app?.description,
			// Workspace-bound with no server record = 'local'; server statuses
			// (draft/pending/...) arrive with the marketplace wiring (M5).
			status: 'local',
		};
	}

	/**
	 * Builds the preview URL: the Development Mode engine's shell with the
	 * app locked + dev hooks on. `rocketride.appdev.shellUrl` overrides the
	 * base for monorepo devs running the shell dev server.
	 */
	private buildPreviewUrl(appId: string): string {
		const override = vscode.workspace.getConfiguration('rocketride.appdev').get<string>('shellUrl', '');
		const base = override || this.connectionManager.getHttpUrl?.() || 'http://localhost:5565';
		return `${base.replace(/\/$/, '')}/?appid=${encodeURIComponent(appId)}&rrdev=1`;
	}

	// =========================================================================
	// EVENT FORWARDING — shell events into the Events pane
	// =========================================================================

	/** Renders a wall-clock time as the feed rows' HH:MM:SS stamp. */
	private static feedTime(): string {
		return new Date().toLocaleTimeString(undefined, { hour12: false });
	}

	/** Forward connection + server events to every open App Builder panel. */
	private setupEventListeners(): void {
		// Server push events → Events pane rows
		const onEvent = this.connectionManager.on('shell:event', (event: GenericEvent) => {
			if (!event?.event) return;
			const row = {
				time: AppScreenProvider.feedTime(),
				name: String(event.event),
				payload: event.body ? JSON.stringify(event.body).slice(0, 200) : undefined,
			};
			for (const panel of this.panels.values()) {
				panel.webview.postMessage({ type: 'appdev:event', row });
			}
		});
		this.disposables.push(onEvent);

		// Connection status changes are feed-worthy context too
		const onStatus = this.connectionManager.on('shell:statusChange', () => {
			const row = {
				time: AppScreenProvider.feedTime(),
				name: 'shell:statusChange',
				payload: this.connectionManager.isConnected() ? 'connected' : 'disconnected',
			};
			for (const panel of this.panels.values()) {
				panel.webview.postMessage({ type: 'appdev:event', row });
			}
		});
		this.disposables.push(onStatus);
	}

	// =========================================================================
	// HTML
	// =========================================================================

	/** Load page-app.html via the shared nonce+CSP+static-rewrite pipeline. */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-app.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading App Builder: ${error}</p></body></html>`;
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
