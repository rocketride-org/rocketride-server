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
 * Environment Page Provider
 *
 * Creates and manages a webview panel for editing ROCKETRIDE_* environment
 * variables on connected servers.  Unlike AccountProvider (which cascades to
 * the first available client), the Environment page is **connection-aware**:
 * every message from the webview carries a `slot` field ('development' or
 * 'deployment') so we know exactly which server to talk to.
 *
 * Architecture:
 *   EnvironmentProvider (Node.js) ↔ postMessage ↔ EnvironmentWebview (browser)
 *
 * The provider listens to connection events on both ConnectionManager and
 * DeployManager and pushes live state updates to the webview whenever a
 * slot connects, disconnects, or receives updated account info.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { ConnectionManager } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';
import { ConfigManager } from '../config';
import { ConnectionState } from '../shared/types';
import type { ConnectionStatus } from '../shared/types';
import type { EnvironmentSlotState, EnvironmentWebviewToHost } from './views/environmentTypes';

// =============================================================================
// PROVIDER
// =============================================================================

export class EnvironmentProvider {
	/** Singleton webview panel — only one Environment page can be open. */
	private static panel: vscode.WebviewPanel | null = null;

	/** Missing env var keys to pre-fill in the webview (cleared after delivery). */
	private pendingPrefillKeys: string[] | null = null;

	/** Subscriptions and listeners to clean up on dispose. */
	private disposables: vscode.Disposable[] = [];

	/** Dev connection singleton. */
	private connectionManager = ConnectionManager.getInstance();

	/** Deploy connection singleton. */
	private deployManager = DeployManager.getDeployInstance();

	/**
	 * Creates the EnvironmentProvider, registers the open command, and
	 * subscribes to connection events on both dev and deploy managers.
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

	/** Registers the `rocketride.page.environment.open` command. */
	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.page.environment.open', (missingKeys?: string[]) => {
			this.show(missingKeys);
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// SHOW / REVEAL
	// =========================================================================

	/** Opens (or reveals) the Environment webview panel, optionally pre-filling missing keys. */
	public show(missingKeys?: string[]): void {
		if (missingKeys?.length) {
			this.pendingPrefillKeys = missingKeys;
		}

		// Step 1: reveal existing panel if one is already open.
		if (EnvironmentProvider.panel) {
			EnvironmentProvider.panel.reveal(vscode.ViewColumn.One);
			// Panel is already initialized — send prefill immediately
			this.flushPrefillKeys(EnvironmentProvider.panel);
			return;
		}

		// Step 2: create a new webview panel.
		const panel = vscode.window.createWebviewPanel('rocketride.pageEnvironment', 'Variables', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		EnvironmentProvider.panel = panel;

		// Load the Rsbuild-generated HTML for the page-environment entry point.
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Step 3: handle incoming messages from the webview.
		panel.webview.onDidReceiveMessage(async (message: EnvironmentWebviewToHost) => {
			try {
				await this.handleWebviewMessage(panel, message);
			} catch (error) {
				console.error(`[EnvironmentProvider] Message handling error: ${error}`);
				this.postError(panel, String(error));
			}
		});

		// Step 4: clean up on dispose.
		panel.onDidDispose(() => {
			EnvironmentProvider.panel = null;
		});
	}

	/**
	 * Sends any pending prefill keys to the webview and clears the stash.
	 */
	private flushPrefillKeys(panel: vscode.WebviewPanel): void {
		const keys = this.pendingPrefillKeys;
		if (!keys?.length) return;
		this.pendingPrefillKeys = null;

		Promise.resolve(
			panel.webview.postMessage({ type: 'env:prefill', keys })
		).catch((err: unknown) => {
			console.error(`[EnvironmentProvider] Failed to send prefill keys: ${err}`);
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
	private async handleWebviewMessage(panel: vscode.WebviewPanel, message: EnvironmentWebviewToHost): Promise<void> {
		switch (message.type) {
			// -- Lifecycle --------------------------------------------------------
			case 'view:ready':
				await this.sendInitialData(panel);
				this.flushPrefillKeys(panel);
				break;

			// -- Load env for a specific slot + scope ----------------------------
			case 'env:getEnv': {
				const ctx = { slot: message.slot, scope: message.scope, scopeId: message.scopeId };
				const resolved = this.resolveSlotClient(message.slot);
				if (!resolved) {
					this.postError(panel, `${message.slot} server is not connected`, ctx);
					break;
				}
				try {
					// Fetch env vars for the requested scope from the slot's server
					const env = await resolved.client.account.getEnv(message.scope, message.scopeId);

					// Post the loaded data back to the webview
					await panel.webview.postMessage({
						type: 'env:data',
						slot: message.slot,
						scope: message.scope,
						scopeId: message.scopeId,
						env,
					});
				} catch (err: unknown) {
					this.postError(panel, err instanceof Error ? err.message : String(err), ctx);
				}
				break;
			}

			// -- Save env for a specific slot + scope ----------------------------
			case 'env:saveEnv': {
				const ctx = { slot: message.slot, scope: message.scope, scopeId: message.scopeId };
				const resolved = this.resolveSlotClient(message.slot);
				if (!resolved) {
					this.postError(panel, `${message.slot} server is not connected`, ctx);
					break;
				}
				try {
					// Persist the full env dict on the slot's server
					await resolved.client.account.setEnv(message.scope, message.env, message.scopeId);

					// Re-fetch and send fresh data so the webview reflects the
					// server's canonical state (the server may have filtered keys).
					const freshEnv = await resolved.client.account.getEnv(message.scope, message.scopeId);
					await panel.webview.postMessage({
						type: 'env:data',
						slot: message.slot,
						scope: message.scope,
						scopeId: message.scopeId,
						env: freshEnv,
					});

					// Notify other views (e.g. canvas config panel) that env keys changed
					const manager = message.slot === 'development' ? this.connectionManager : this.deployManager;
					manager.emit('shell:envKeysChanged');
				} catch (err: unknown) {
					this.postError(panel, err instanceof Error ? err.message : String(err), ctx);
				}
				break;
			}
		}
	}

	// =========================================================================
	// INITIAL DATA
	// =========================================================================

	/**
	 * Sends the initial `env:init` message to the webview with both slots'
	 * connection state and the shared-mode flag.
	 *
	 * @param panel - The webview panel to post the init payload to.
	 */
	private async sendInitialData(panel: vscode.WebviewPanel): Promise<void> {
		// Determine whether deployment shares the development target
		const shared = this.deployManager.isSharedMode();

		// Build state for both connection slots
		const slots: EnvironmentSlotState[] = [this.buildSlotState('development'), this.buildSlotState('deployment')];

		await panel.webview.postMessage({ type: 'env:init', shared, slots });
	}

	// =========================================================================
	// SLOT STATE
	// =========================================================================

	/**
	 * Builds an {@link EnvironmentSlotState} snapshot for a given connection
	 * slot by inspecting the live connection and its account info.
	 *
	 * Detection logic:
	 * - **isSaas**: true when the server's capabilities include `'saas'`.
	 * - **isOrgAdmin**: true when the user's org permissions include `'org.admin'`.
	 * - **isTeamAdmin**: true when the user has `'team.admin'` on their default
	 *   team (or when they are an org admin, which grants implicit team admin).
	 *
	 * @param slot - Which connection slot to inspect ('development' or 'deployment').
	 * @returns A serialisable state snapshot for the webview.
	 */
	private buildSlotState(slot: 'development' | 'deployment'): EnvironmentSlotState {
		// Read the persisted connection mode from settings
		const config = ConfigManager.getInstance().getConfig();
		const connectionMode = slot === 'deployment' ? config.deployment.connectionMode : config.development.connectionMode;

		// Try to resolve a live client for this slot
		const resolved = this.resolveSlotClient(slot);
		const isConnected = resolved !== null;

		// Determine if this is a SaaS server from the capabilities array
		const capabilities: string[] = resolved?.accountInfo?.capabilities ?? [];
		const isSaas = capabilities.includes('saas');

		// Extract org info and permissions
		const org = resolved?.accountInfo?.organization;
		const orgId = org?.id;
		const orgPermissions: string[] = org?.permissions ?? [];
		const isOrgAdmin = orgPermissions.includes('org.admin');

		// Extract default team and check team-admin permission.
		// Org admins get implicit team.admin on all teams.
		const defaultTeamId = resolved?.accountInfo?.defaultTeam;
		let isTeamAdmin = isOrgAdmin; // org admin → implicit team admin
		if (!isTeamAdmin && defaultTeamId && org?.teams) {
			// Check if the user has explicit team.admin on the default team
			const team = org.teams.find((t: { id: string; permissions: string[] }) => t.id === defaultTeamId);
			isTeamAdmin = team?.permissions?.includes('team.admin') ?? false;
		}

		return {
			slot,
			isConnected,
			isSaas,
			connectionMode,
			isOrgAdmin,
			isTeamAdmin,
			orgId,
			teamId: defaultTeamId,
		};
	}

	// =========================================================================
	// CLIENT RESOLUTION
	// =========================================================================

	/**
	 * Resolves the SDK client for a specific connection slot.
	 *
	 * Unlike AccountProvider's `resolveClient()` which cascades (dev → deploy),
	 * this method targets a specific slot so the Environment page can manage
	 * each server's env independently.
	 *
	 * @param slot - Which connection slot to resolve.
	 * @returns The client and account info, or null if the slot is not connected.
	 */
	private resolveSlotClient(slot: 'development' | 'deployment'): { client: any; accountInfo: any } | null {
		if (slot === 'development') {
			// Dev slot — use the primary ConnectionManager singleton
			const client = this.connectionManager.getClient();
			if (!client || !this.connectionManager.isConnected()) return null;
			const accountInfo = client.getAccountInfo();
			return { client, accountInfo };
		} else {
			// Deploy slot — use the DeployManager singleton.
			// In shared mode, DeployManager.getClient() proxies to the dev client,
			// so this still returns the correct client transparently.
			const client = this.deployManager.getClient();
			if (!client || !this.deployManager.isConnected()) return null;
			const accountInfo = client.getAccountInfo();
			return { client, accountInfo };
		}
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	/**
	 * Subscribes to connection state changes and account update events on
	 * **both** ConnectionManager (dev) and DeployManager (deploy).
	 *
	 * When a slot's state changes, we push an `env:slotUpdate` message to
	 * the webview so it can adapt the UI (show/hide scopes, display empty
	 * state on disconnect, etc.).
	 */
	private setupEventListeners(): void {
		// ── Dev connection events ──────────────────────────────────────────
		const devStatusListener = this.connectionManager.on('shell:statusChange', (_status: ConnectionStatus) => {
			this.pushSlotUpdate('development');
		});

		const devAccountListener = this.connectionManager.on('shell:accountUpdate', () => {
			// Account info changed (permissions, org membership) — resend state
			this.pushSlotUpdate('development');
		});

		// ── Deploy connection events ───────────────────────────────────────
		const deployStatusListener = this.deployManager.on('shell:statusChange', (_status: ConnectionStatus) => {
			this.pushSlotUpdate('deployment');
		});

		const deployAccountListener = this.deployManager.on('shell:accountUpdate', () => {
			// Account info changed on the deploy server — resend state
			this.pushSlotUpdate('deployment');
		});

		this.disposables.push(devStatusListener as any, devAccountListener as any, deployStatusListener as any, deployAccountListener as any);
	}

	/**
	 * Pushes an `env:slotUpdate` message to the open webview for a specific
	 * slot.  Unlike `sendInitialData`, this does NOT clear cached env data —
	 * it only updates the slot's connection state so the UI can show/hide
	 * scope cards or display the empty state.
	 *
	 * @param slot - Which connection slot changed.
	 */
	private pushSlotUpdate(slot: 'development' | 'deployment'): void {
		if (!EnvironmentProvider.panel) return;

		const slotState = this.buildSlotState(slot);
		Promise.resolve(
			EnvironmentProvider.panel.webview.postMessage({
				type: 'env:slotUpdate',
				slot: slotState,
			})
		).catch((err: unknown) => {
			console.error(`[EnvironmentProvider] Failed to push slot update for ${slot}: ${err}`);
		});
	}

	// =========================================================================
	// ERROR HELPER
	// =========================================================================

	/**
	 * Posts an `env:error` message to the webview.
	 *
	 * @param panel   - The webview panel.
	 * @param message - The error description.
	 * @param context - Optional slot/scope context so the webview can clear
	 *                  per-card loading state for the specific key that failed.
	 */
	private postError(
		panel: vscode.WebviewPanel,
		message: string,
		context?: { slot: 'development' | 'deployment'; scope: 'org' | 'team' | 'user'; scopeId?: string },
	): void {
		panel.webview.postMessage({ type: 'env:error', error: message, ...context }).then(undefined, (err: unknown) => {
			console.error(`[EnvironmentProvider] Failed to post error: ${err}`);
		});
	}

	// =========================================================================
	// WEBVIEW HTML
	// =========================================================================

	/**
	 * Reads the Rsbuild-generated HTML template for the Environment page,
	 * injects a CSP nonce, and converts resource URIs to webview-safe URIs.
	 *
	 * @param webview - The webview to generate HTML for.
	 * @returns The HTML string to set as `webview.html`.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Generate a unique nonce for the Content Security Policy
		const nonce = this.generateNonce();

		// Path to the Rsbuild-generated HTML for the page-environment entry
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-environment.html');

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
                <h3>Error Loading Environment Page</h3>
                <p>Could not load the Environment webview. Please try reloading the window.</p>
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
		if (EnvironmentProvider.panel) {
			EnvironmentProvider.panel.dispose();
			EnvironmentProvider.panel = null;
		}
	}
}
