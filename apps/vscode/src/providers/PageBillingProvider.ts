// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Billing Page Provider for Subscription Management
 *
 * Creates and manages a webview panel showing the <BillingView /> component.
 * Fetches subscription data, credit balance, and credit packs via the SDK's
 * client.billing.* namespace and bridges data to the React webview via postMessage.
 * Handles cancel, portal, and credit purchase actions from the webview.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { ConnectionManager } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';
import { ConnectionState } from '../shared/types';
import type { ConnectionStatus } from '../shared/types';

// =============================================================================
// PROVIDER
// =============================================================================

export class PageBillingProvider {
	private panel: vscode.WebviewPanel | null = null;
	private disposables: vscode.Disposable[] = [];
	private connectionManager = ConnectionManager.getInstance();

	/**
	 * Creates a new PageBillingProvider and registers the open command.
	 *
	 * @param context - VS Code extension context for resource loading and subscriptions.
	 */
	constructor(private context: vscode.ExtensionContext) {
		this.setupEventListeners();
		this.registerCommands();
	}

	// =========================================================================
	// COMMANDS
	// =========================================================================

	/** Registers the billing page open command. */
	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.page.billing.open', () => {
			this.show();
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// SHOW / REVEAL
	// =========================================================================

	/** Opens the billing panel, or reveals it if already open. */
	public show(): void {
		// Prevent duplicate panels
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Create webview panel
		const panel = vscode.window.createWebviewPanel('rocketride.pageBilling', 'Billing', vscode.ViewColumn.One, {
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
							isConnected: this.resolveClient().client !== undefined,
						});
						// Fetch and post initial billing data
						await this.fetchAndPost();
						break;

					case 'billing:cancel':
						await this.handleCancel(message.appId);
						break;

					case 'billing:portal':
						await this.handlePortal();
						break;

					case 'billing:buyCredits':
						await this.handleBuyCredits(message.packId);
						break;

					case 'billing:refresh':
						await this.fetchAndPost();
						break;
				}
			} catch (error) {
				console.error(`[PageBillingProvider] Message handling error: ${error}`);
			}
		});

		// Cleanup on dispose
		panel.onDidDispose(() => {
			this.panel = null;
		});
	}

	// =========================================================================
	// DATA FETCHING
	// =========================================================================

	/**
	 * Fetches all billing data (subscriptions, credit balance, credit packs)
	 * and posts the combined result to the webview.
	 */
	private async fetchAndPost(): Promise<void> {
		if (!this.panel) return;

		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) {
			await this.panel.webview.postMessage({
				type: 'billing:data',
				subscriptions: [],
				creditBalance: null,
				creditPacks: [],
				loading: false,
				error: 'No organisation found. Please sign in first.',
			});
			return;
		}

		// Post loading state
		await this.panel.webview.postMessage({
			type: 'billing:data',
			subscriptions: [],
			creditBalance: null,
			creditPacks: [],
			loading: true,
			error: null,
		});

		try {
			// Fetch all billing data in parallel via the SDK
			const [subscriptions, creditBalance, creditPacks] = await Promise.all([client.billing.getDetails(orgId), client.billing.getCreditBalance(orgId), client.billing.listCreditPacks()]);

			// Post complete billing data to the webview
			await this.panel.webview.postMessage({
				type: 'billing:data',
				subscriptions,
				creditBalance,
				creditPacks,
				loading: false,
				error: null,
			});
		} catch (error) {
			console.error(`[PageBillingProvider] Failed to fetch billing data: ${error}`);
			await this.panel.webview.postMessage({
				type: 'billing:data',
				subscriptions: [],
				creditBalance: null,
				creditPacks: [],
				loading: false,
				error: `Failed to load billing data: ${error}`,
			});
		}
	}

	// =========================================================================
	// ACTION HANDLERS
	// =========================================================================

	/**
	 * Cancels a subscription and re-fetches billing data.
	 *
	 * @param appId - The app whose subscription to cancel.
	 */
	private async handleCancel(appId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) return;

		try {
			// Cancel the subscription on the server
			await client.billing.cancelSubscription(orgId, appId);

			// Re-fetch all billing data so the UI reflects the change
			await this.fetchAndPost();
		} catch (error) {
			console.error(`[PageBillingProvider] Failed to cancel subscription: ${error}`);
			if (this.panel) {
				await this.panel.webview.postMessage({
					type: 'billing:data',
					subscriptions: [],
					creditBalance: null,
					creditPacks: [],
					loading: false,
					error: `Failed to cancel subscription: ${error}`,
				});
			}
		}
	}

	/**
	 * Creates a Stripe portal session and opens the URL in the user's browser.
	 */
	private async handlePortal(): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) return;

		try {
			// Create the Stripe portal session with a placeholder return URL
			const { url } = await client.billing.createPortalSession(orgId, 'https://rocketride.ai');

			// Open the portal URL in the user's default browser
			await vscode.env.openExternal(vscode.Uri.parse(url));
		} catch (error) {
			console.error(`[PageBillingProvider] Failed to open billing portal: ${error}`);
		}
	}

	/**
	 * Creates a Stripe checkout session for a credit pack and opens the URL.
	 *
	 * @param packId - The credit pack identifier to purchase.
	 */
	private async handleBuyCredits(packId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) return;

		try {
			// Create the Stripe checkout session for the credit pack
			const { url } = await client.billing.createCreditCheckout(orgId, packId, 'https://rocketride.ai');

			// Open the checkout URL in the user's default browser
			await vscode.env.openExternal(vscode.Uri.parse(url));
		} catch (error) {
			console.error(`[PageBillingProvider] Failed to create credit checkout: ${error}`);
		}
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	/** Sets up connection state change listeners to keep the webview in sync. */
	private setupEventListeners(): void {
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', (status: ConnectionStatus) => {
			this.handleConnectionStateChange(status).catch((error) => {
				console.error(`[PageBillingProvider] Connection state change error: ${error}`);
			});
		});

		this.disposables.push(connectionStateListener);
	}

	/**
	 * Handles connection state changes — refreshes billing data on connect,
	 * notifies the webview of disconnections.
	 *
	 * @param status - New connection status from the ConnectionManager.
	 */
	private async handleConnectionStateChange(status: ConnectionStatus): Promise<void> {
		if (!this.panel) return;

		// Notify the webview of the connection state change
		await this.panel.webview.postMessage({
			type: 'shell:connectionChange',
			isConnected: status.state === ConnectionState.CONNECTED,
		});

		// Re-fetch billing data when we reconnect
		if (status.state === ConnectionState.CONNECTED) {
			await this.fetchAndPost();
		}
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	/**
	 * Resolves the best available client using dev -> deploy cascade.
	 * Prefers the dev client if it has account info (cloud mode), otherwise
	 * falls back to the deploy client.
	 *
	 * @returns The client, its account info, and the orgId (if available).
	 */
	private resolveClient(): { client: any | undefined; accountInfo: any | undefined; orgId: string | undefined } {
		// Try dev client first
		const devClient = this.connectionManager.getClient();
		const devInfo = devClient?.getAccountInfo();
		if (devInfo?.displayName) {
			const orgId = devInfo.organizations?.[0]?.id;
			return { client: devClient, accountInfo: devInfo, orgId };
		}

		// Fall back to deploy client
		const deployClient = DeployManager.getDeployInstance().getClient();
		const deployInfo = deployClient?.getAccountInfo();
		if (deployInfo?.displayName) {
			const orgId = deployInfo.organizations?.[0]?.id;
			return { client: deployClient, accountInfo: deployInfo, orgId };
		}

		// Neither has account info — return dev client anyway (may still be useful)
		const fallbackInfo = devInfo ?? deployInfo;
		const orgId = fallbackInfo?.organizations?.[0]?.id;
		return { client: devClient ?? deployClient, accountInfo: fallbackInfo, orgId };
	}

	// =========================================================================
	// HTML GENERATION
	// =========================================================================

	/**
	 * Reads the built HTML template and injects nonce/CSP values and webview URIs.
	 *
	 * @param webview - The webview to generate HTML for.
	 * @returns Complete HTML string ready for the webview.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-billing.html');

		try {
			let htmlContent = readFileSync(htmlPath.fsPath, 'utf8');

			// Replace template placeholders
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Convert resource URLs to webview URIs
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Billing</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
                <p>Expected: <code>${htmlPath.fsPath}</code></p>
            </body></html>`;
		}
	}

	/**
	 * Generates a cryptographically random nonce for Content Security Policy.
	 *
	 * @returns Base64url-encoded nonce string.
	 */
	private generateNonce(): string {
		return crypto.randomBytes(32).toString('base64url');
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Cleans up all disposables and the webview panel. */
	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		if (this.panel) {
			this.panel.dispose();
			this.panel = null;
		}
	}
}
