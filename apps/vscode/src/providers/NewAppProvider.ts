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
 * New App Wizard Provider
 *
 * Creates and manages the New App wizard webview panel — the single-page
 * form that replaced the native QuickPick/InputBox flow of
 * `rocketride.app.create`. The panel is a stateless, fire-once form:
 * closing it writes nothing; Create runs one scaffold pass and, on success,
 * the panel disposes and the App Builder opens.
 *
 * Identity resolution lives HERE, not in the webview: the developer id is
 * read from the connected server's account info (organization.developerId)
 * at init AND again at submit time, falling back to 'local' when the org has
 * none or the connection is local/offline. The webview only ever sends the
 * app-name half.
 *
 * Architecture:
 *   NewAppProvider (Node.js) ↔ postMessage ↔ NewAppWebview (browser)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { ConnectionManager } from '../connection/connection';
import { listAppFolders, scaffoldApp } from '../appdev/scaffolder';
import type { NewAppIdentity, NewAppWebviewToHost } from './types/newAppTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The developer id applied when the org has none or the connection is local/offline. */
const DEFAULT_DEVELOPER_ID = 'local';

// =============================================================================
// PROVIDER
// =============================================================================

export class NewAppProvider {
	/** Singleton webview panel — only one New App wizard can be open. */
	private static panel: vscode.WebviewPanel | null = null;

	/** Subscriptions and listeners to clean up on dispose. */
	private disposables: vscode.Disposable[] = [];

	/** Dev connection singleton — the source of the developer id. */
	private connectionManager = ConnectionManager.getInstance();

	/**
	 * Creates the NewAppProvider, registers the create command, and
	 * subscribes to connection events so the open wizard tracks the live
	 * developer id.
	 *
	 * @param context - The VS Code extension context for subscriptions and URIs.
	 */
	constructor(private context: vscode.ExtensionContext) {
		this.setupEventListeners();
		this.registerCommands();
	}

	// =========================================================================
	// COMMANDS
	// =========================================================================

	/** Registers the `rocketride.app.create` command. */
	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.app.create', () => {
			this.show();
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// SHOW / REVEAL
	// =========================================================================

	/** Opens (or reveals) the New App wizard panel. */
	public show(): void {
		// Step 1: reveal existing panel if one is already open.
		if (NewAppProvider.panel) {
			NewAppProvider.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Step 2: create a new webview panel.
		const panel = vscode.window.createWebviewPanel('rocketride.pageNewApp', 'New App', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		NewAppProvider.panel = panel;

		// Load the Rsbuild-generated HTML for the page-newapp entry point.
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Step 3: handle incoming messages from the webview.
		panel.webview.onDidReceiveMessage(async (message: NewAppWebviewToHost) => {
			try {
				await this.handleWebviewMessage(panel, message);
			} catch (error) {
				console.error(`[NewAppProvider] Message handling error: ${error}`);
				this.postError(panel, String(error));
			}
		});

		// Step 4: clean up on dispose.
		panel.onDidDispose(() => {
			NewAppProvider.panel = null;
		});
	}

	// =========================================================================
	// MESSAGE HANDLING
	// =========================================================================

	/**
	 * Dispatches a single incoming webview message to the appropriate handler.
	 *
	 * @param panel   - The webview panel to post responses to.
	 * @param message - The incoming message from the webview.
	 */
	private async handleWebviewMessage(panel: vscode.WebviewPanel, message: NewAppWebviewToHost): Promise<void> {
		switch (message.type) {
			// -- Lifecycle --------------------------------------------------------
			case 'view:ready':
				await this.sendInitialData(panel);
				break;

			// -- Create the app ---------------------------------------------------
			case 'newapp:create': {
				try {
					// Resolve the developer id NOW — the panel is modeless, so the
					// form may have been open across a login/logout.
					const developerId = this.resolveDeveloperId().developerId;

					// One scaffold pass; scaffoldApp re-validates id + folder.
					await scaffoldApp({
						appId: `${developerId}.${message.appName}`,
						appName: message.displayName,
						frame: message.frame,
					});

					// Success — the app exists on disk and the App Builder is
					// open; the fire-once form is done.
					panel.dispose();
				} catch (err: unknown) {
					this.postError(panel, err instanceof Error ? err.message : String(err));
				}
				break;
			}

			// -- Close without creating -------------------------------------------
			case 'newapp:cancel':
				panel.dispose();
				break;
		}
	}

	// =========================================================================
	// INITIAL DATA
	// =========================================================================

	/**
	 * Sends the initial `newapp:init` message with the live identity snapshot.
	 *
	 * @param panel - The webview panel to post the init payload to.
	 */
	private async sendInitialData(panel: vscode.WebviewPanel): Promise<void> {
		await panel.webview.postMessage({ type: 'newapp:init', identity: await this.buildIdentity() });
	}

	// =========================================================================
	// IDENTITY
	// =========================================================================

	/**
	 * Resolves the developer id from the connected server's account info.
	 *
	 * Falls back to 'local' when there is no connection, the server reports
	 * no organization, or the organization has no developer id set — which
	 * matches the historical hard-coded appManifest.publisher.
	 *
	 * @returns The developer id and its provenance.
	 */
	private resolveDeveloperId(): { developerId: string; source: 'organization' | 'default' } {
		// step: only a live, authenticated connection can carry an org profile
		const client = this.connectionManager.getClient();
		if (!client || !this.connectionManager.isConnected()) {
			return { developerId: DEFAULT_DEVELOPER_ID, source: 'default' };
		}

		// step: read organization.developerId off the cached account info
		const accountInfo = client.getAccountInfo() as { organization?: { developerId?: string } } | null;
		const developerId = accountInfo?.organization?.developerId;
		return developerId ? { developerId, source: 'organization' } : { developerId: DEFAULT_DEVELOPER_ID, source: 'default' };
	}

	/**
	 * Builds the full identity snapshot for the webview: developer id,
	 * provenance, workspace availability, and existing app folders for live
	 * collision validation.
	 *
	 * @returns A serialisable identity snapshot.
	 */
	private async buildIdentity(): Promise<NewAppIdentity> {
		const { developerId, source } = this.resolveDeveloperId();
		return {
			developerId,
			source,
			workspaceOpen: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
			existingFolders: await listAppFolders(),
		};
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	/**
	 * Subscribes to connection state and account update events so an open
	 * wizard always shows the live developer id (login/logout while the
	 * modeless panel sits open changes the linkage name).
	 */
	private setupEventListeners(): void {
		const statusListener = this.connectionManager.on('shell:statusChange', () => {
			this.pushIdentityUpdate();
		});
		const accountListener = this.connectionManager.on('shell:accountUpdate', () => {
			this.pushIdentityUpdate();
		});
		this.disposables.push(statusListener as any, accountListener as any);
	}

	/** Pushes a `newapp:identityUpdate` message to the open wizard, if any. */
	private pushIdentityUpdate(): void {
		if (!NewAppProvider.panel) return;

		const panel = NewAppProvider.panel;
		void this.buildIdentity()
			.then((identity) => panel.webview.postMessage({ type: 'newapp:identityUpdate', identity }))
			.catch((err: unknown) => {
				console.error(`[NewAppProvider] Failed to push identity update: ${err}`);
			});
	}

	// =========================================================================
	// ERROR HELPER
	// =========================================================================

	/**
	 * Posts a `newapp:error` message to the webview.
	 *
	 * @param panel   - The webview panel.
	 * @param message - The error description.
	 */
	private postError(panel: vscode.WebviewPanel, message: string): void {
		panel.webview.postMessage({ type: 'newapp:error', error: message }).then(undefined, (err: unknown) => {
			console.error(`[NewAppProvider] Failed to post error: ${err}`);
		});
	}

	// =========================================================================
	// WEBVIEW HTML
	// =========================================================================

	/**
	 * Reads the Rsbuild-generated HTML template for the New App page,
	 * injects a CSP nonce, and converts resource URIs to webview-safe URIs.
	 *
	 * @param webview - The webview to generate HTML for.
	 * @returns The HTML string to set as `webview.html`.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Generate a unique nonce for the Content Security Policy
		const nonce = this.generateNonce();

		// Path to the Rsbuild-generated HTML for the page-newapp entry
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-newapp.html');

		try {
			let htmlContent = readFileSync(htmlPath.fsPath, 'utf8');

			// Step 1: replace template placeholders with the nonce and CSP source.
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Step 2: convert resource URLs to webview-safe URIs.
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			// Fallback error page if the HTML template cannot be loaded
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading New App Page</h3>
                <p>Could not load the New App webview. Please try reloading the window.</p>
                <pre>${error}</pre>
            </body></html>`;
		}
	}

	/**
	 * Generates a cryptographically random nonce for CSP.
	 *
	 * @returns A base64url-encoded nonce string.
	 */
	private generateNonce(): string {
		return crypto.randomBytes(32).toString('base64url');
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Disposes all subscriptions and closes the panel if open. */
	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		if (NewAppProvider.panel) {
			NewAppProvider.panel.dispose();
			NewAppProvider.panel = null;
		}
	}
}
