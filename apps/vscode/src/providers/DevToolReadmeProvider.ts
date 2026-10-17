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
 * Dev Tool Details (README) Provider
 *
 * The modules flow's detail page — VS Code extension-page style: a row in
 * the sidebar's Dev Tools list opens this panel showing the tool's identity
 * header (icon, name, publisher, version), Install/Remove actions, and the
 * app's README markdown. Install pins the tool to the strip; Remove unpins
 * it AND closes the tool's open frame panel.
 *
 * Architecture:
 *   DevToolReadmeProvider (Node.js) ↔ postMessage ↔ DevToolReadmeWebview (browser)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { ConnectionManager } from '../connection/connection';
import { DevToolStore } from './DevToolStore';
import type { ReadmeToolInfo, ReadmeWebviewToHost } from './types/devToolReadmeTypes';

// =============================================================================
// PROVIDER
// =============================================================================

export class DevToolReadmeProvider {
	/** Open detail panels, one per tool app id. */
	private panels = new Map<string, vscode.WebviewPanel>();

	/** Fetched icons as data: URIs, by source URL. */
	private iconCache = new Map<string, string>();

	/** Subscriptions and listeners to clean up on dispose. */
	private disposables: vscode.Disposable[] = [];

	/** Dev connection singleton — the source of the app catalog. */
	private connectionManager = ConnectionManager.getInstance();

	/**
	 * Creates the provider and registers the details command.
	 *
	 * @param context - The VS Code extension context for subscriptions and URIs.
	 * @param devTools - The pinned-tools store Install/Remove acts on.
	 * @param closeToolPanel - Closes a tool's open frame panel (Remove flow).
	 */
	constructor(private context: vscode.ExtensionContext, private devTools: DevToolStore, private closeToolPanel: (appId: string) => void) {
		const cmd = vscode.commands.registerCommand('rocketride.devtool.readme', (appId?: string) => {
			if (typeof appId === 'string' && appId) this.show(appId);
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);

		// Install/Remove (from any surface) and connection changes refresh
		// every open detail page's button state and catalog facts.
		const push = () => {
			for (const [appId, panel] of this.panels) {
				void this.sendInit(appId, panel).catch(() => {});
			}
		};
		this.disposables.push(this.devTools.onDidChange(push));
		const statusListener = this.connectionManager.on('shell:statusChange', push);
		const accountListener = this.connectionManager.on('shell:accountUpdate', push);
		this.disposables.push(statusListener as any, accountListener as any);
	}

	// =========================================================================
	// SHOW / REVEAL
	// =========================================================================

	/**
	 * Opens (or reveals) the details panel for one tool.
	 *
	 * @param appId - The tool's app id.
	 */
	public show(appId: string): void {
		const existing = this.panels.get(appId);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		const row = this.findApp(appId);
		const panel = vscode.window.createWebviewPanel('rocketride.pageDevToolReadme', `Dev Tool: ${row?.name ?? appId}`, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		this.panels.set(appId, panel);
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		panel.webview.onDidReceiveMessage(async (message: ReadmeWebviewToHost) => {
			try {
				switch (message.type) {
					case 'view:ready':
						await this.sendInit(appId, panel);
						break;
					case 'readme:install':
						// Pin — the store change fans out (tab strip, this page's
						// button state) through the store's change event.
						this.devTools.add(message.appId);
						break;
					case 'readme:remove':
						// Unpin AND retire the tool's open frame panel; this
						// details page stays (VS Code keeps the extension page
						// open after uninstall too).
						this.devTools.remove(message.appId);
						this.closeToolPanel(message.appId);
						break;
				}
			} catch (error) {
				console.error(`[DevToolReadmeProvider] Message handling error: ${error}`);
			}
		});

		panel.onDidDispose(() => {
			this.panels.delete(appId);
		});
	}

	// =========================================================================
	// INIT PAYLOAD
	// =========================================================================

	/** One account-payload app row, as this provider reads it. */
	private findApp(appId: string): { id: string; name: string; version?: string; publisher?: string; description?: string; categories?: string[]; icon?: string; readme?: string } | undefined {
		const client = this.connectionManager.getClient();
		const apps = (client?.getAccountInfo()?.apps ?? []) as Array<{ id: string; name: string; version?: string; publisher?: string; description?: string; categories?: string[]; icon?: string; readme?: string }>;
		return apps.find((a) => a?.id === appId);
	}

	/** Fetches an engine-served icon and inlines it as a data: URI. */
	private async iconDataUri(url: string): Promise<string | undefined> {
		const cached = this.iconCache.get(url);
		if (cached) return cached;
		try {
			const res = await fetch(url);
			if (!res.ok) return undefined;
			const contentType = res.headers.get('content-type')?.split(';')[0] || 'image/svg+xml';
			const dataUri = `data:${contentType};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
			this.iconCache.set(url, dataUri);
			return dataUri;
		} catch {
			return undefined;
		}
	}

	/**
	 * Posts the `readme:init` payload for one tool.
	 *
	 * @param appId - The tool's app id.
	 * @param panel - The panel to post to.
	 */
	private async sendInit(appId: string, panel: vscode.WebviewPanel): Promise<void> {
		const connected = this.connectionManager.isConnected();
		const row = connected ? this.findApp(appId) : undefined;
		let tool: ReadmeToolInfo | null = null;
		if (row) {
			const base = (this.connectionManager.getHttpUrl() || '').replace(/\/$/, '');
			const iconUrl = row.icon ? (row.icon.startsWith('/') && base ? `${base}${row.icon}` : row.icon) : undefined;
			tool = {
				id: row.id,
				name: row.name,
				version: row.version,
				publisher: row.publisher,
				description: row.description,
				categories: row.categories,
				iconDataUri: iconUrl ? await this.iconDataUri(iconUrl) : undefined,
				// README from the manifest; the description is the fallback so
				// the page is never an empty sheet.
				readme: row.readme || row.description || '',
			};
			panel.title = `Dev Tool: ${row.name}`;
		}
		await panel.webview.postMessage({
			type: 'readme:init',
			payload: { tool, installed: this.devTools.getAll().includes(appId), connected },
		});
	}

	// =========================================================================
	// WEBVIEW HTML
	// =========================================================================

	/**
	 * Reads the Rsbuild-generated HTML for the details page, injects the CSP
	 * nonce, and converts resource URIs to webview-safe URIs. README images
	 * may reference any http(s) origin — widen img-src accordingly.
	 *
	 * @param webview - The webview to generate HTML for.
	 * @returns The HTML string to set as `webview.html`.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(32).toString('base64url');
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-devtool-readme.html');

		try {
			let htmlContent = readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);
			htmlContent = htmlContent.replace(/img-src /, 'img-src http: https: ');
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Dev Tool Page</h3>
                <p>Could not load the dev-tool details webview. Please try reloading the window.</p>
                <pre>${error}</pre>
            </body></html>`;
		}
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Disposes all subscriptions and closes every open panel. */
	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		for (const panel of this.panels.values()) panel.dispose();
		this.panels.clear();
	}
}
