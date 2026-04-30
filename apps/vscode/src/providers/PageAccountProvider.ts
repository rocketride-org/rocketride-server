// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Account Page Provider for Account Management
 *
 * Creates and manages a webview panel showing the <AccountView /> component.
 * Handles all account-related operations via the SDK's client.account.*
 * namespace and bridges data to the React webview via postMessage.
 *
 * Architecture:
 *   PageAccountProvider (Node.js) ↔ postMessage ↔ AccountWebview (browser) → AccountView (pure UI)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { ConnectionManager } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';
import { ConnectionState } from '../shared/types';
import type { ConnectionStatus } from '../shared/types';
import type { ConnectResult, TeamDetail } from 'rocketride';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';

// =============================================================================
// INTERFACES
// =============================================================================

/** Shape of every message the Account webview can send to the extension host. */
interface AccountWebviewMessage {
	type: string;
	fields?: Record<string, string>;
	teamId?: string;
	keyId?: string;
	name?: string;
	userId?: string;
	role?: string;
	section?: string;
	params?: Record<string, unknown>;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class PageAccountProvider {
	/** Singleton panel reference — prevents duplicate panels. */
	private static panel: vscode.WebviewPanel | null = null;

	private disposables: vscode.Disposable[] = [];

	private connectionManager = ConnectionManager.getInstance();

	/**
	 * Creates the PageAccountProvider, registers the open command, and sets up
	 * connection-state listeners so the webview stays in sync.
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

	/** Registers the `rocketride.page.account.open` command. */
	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.page.account.open', () => {
			this.show();
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// SHOW / REVEAL
	// =========================================================================

	/** Opens (or reveals) the Account webview panel. */
	public show(): void {
		// Step 1: reveal existing panel if one is already open.
		if (PageAccountProvider.panel) {
			PageAccountProvider.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Step 2: create a new webview panel.
		const panel = vscode.window.createWebviewPanel('rocketride.pageAccount', 'Account', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		PageAccountProvider.panel = panel;
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Step 3: handle incoming messages from the webview.
		panel.webview.onDidReceiveMessage(async (message: AccountWebviewMessage) => {
			try {
				await this.handleWebviewMessage(panel, message);
			} catch (error) {
				console.error(`[PageAccountProvider] Message handling error: ${error}`);
				this.postError(panel, String(error));
			}
		});

		// Step 4: clean up on dispose.
		panel.onDidDispose(() => {
			PageAccountProvider.panel = null;
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
	private async handleWebviewMessage(panel: vscode.WebviewPanel, message: AccountWebviewMessage): Promise<void> {
		switch (message.type) {
			// -- Lifecycle --------------------------------------------------------
			case 'view:ready':
				await this.sendInitialData(panel);
				break;

			// -- Profile ----------------------------------------------------------
			case 'account:saveProfile':
				await this.handleSaveProfile(panel, message.fields as Record<string, string>);
				break;

			case 'account:setDefaultTeam':
				await this.handleSetDefaultTeam(panel, message.teamId as string);
				break;

			// -- API Keys ---------------------------------------------------------
			case 'account:createKey':
				await this.handleCreateKey(panel, message.params as { name: string; teamId: string; permissions: string[]; expiresAt?: string });
				break;

			case 'account:revokeKey':
				await this.handleRevokeKey(panel, message.keyId as string);
				break;

			// -- Organization -----------------------------------------------------
			case 'account:saveOrgName':
				await this.handleSaveOrgName(panel, message.name as string);
				break;

			// -- Members ----------------------------------------------------------
			case 'account:inviteMember':
				await this.handleInviteMember(panel, message.params as { email: string; givenName: string; familyName: string; role: string });
				break;

			case 'account:updateRole':
				await this.handleUpdateRole(panel, message.userId as string, message.role as string);
				break;

			case 'account:removeMember':
				await this.handleRemoveMember(panel, message.userId as string);
				break;

			// -- Teams ------------------------------------------------------------
			case 'account:createTeam':
				await this.handleCreateTeam(panel, message.name as string);
				break;

			case 'account:deleteTeam':
				await this.handleDeleteTeam(panel, message.teamId as string);
				break;

			case 'account:loadTeamDetail':
				await this.handleLoadTeamDetail(panel, message.teamId as string);
				break;

			case 'account:addTeamMember':
				await this.handleAddTeamMember(panel, message.params as { teamId: string; userId: string; permissions: string[] });
				break;

			case 'account:editPerms':
				await this.handleEditPerms(panel, message.params as { teamId: string; userId: string; permissions: string[] });
				break;

			case 'account:removeTeamMember':
				await this.handleRemoveTeamMember(panel, message.params as { teamId: string; userId: string });
				break;

			// -- Auth / Danger Zone -----------------------------------------------
			case 'account:logout':
				await this.handleLogout();
				break;

			case 'account:deleteAccount':
				await this.handleDeleteAccount(panel);
				break;

			// -- Section navigation (lazy loading) --------------------------------
			case 'account:sectionChange':
				await this.handleSectionChange(panel, message.section as string);
				break;
		}
	}

	// =========================================================================
	// INITIAL DATA
	// =========================================================================

	/**
	 * Fetches all account data and sends a single `account:init` message to the
	 * webview so it can populate every section in one shot.
	 *
	 * @param panel - The webview panel to post the init payload to.
	 */
	private async sendInitialData(panel: vscode.WebviewPanel): Promise<void> {
		// Resolve the best available client (dev → deploy cascade).
		const { client, accountInfo } = this.resolveClient();
		const isConnected = client !== undefined;

		// Fetch profile for the default tab; other sections load on demand.
		let profile: ConnectResult | null = accountInfo ?? null;
		if (client && isConnected) {
			const fresh = await client.account.getProfile().catch(() => null);
			if (fresh) profile = fresh;
		}

		// Post init with profile only — org/members/teams/keys load lazily.
		await panel.webview.postMessage({
			type: 'account:init',
			isConnected,
			profile,
			org: null,
			members: [],
			teams: [],
			keys: [],
		});
	}

	/**
	 * Fetches the profile and posts it to the webview.
	 * Called when the server pushes an `apaext_account` event.
	 */
	private async refreshProfile(panel: vscode.WebviewPanel): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) return;
		const profile = await client.account.getProfile().catch(() => null);
		await panel.webview.postMessage({ type: 'account:profile', profile });
	}

	/**
	 * Loads only the data needed for the requested section tab.
	 * Mirrors the cloud-ui pattern of lazy per-section loading.
	 */
	private async handleSectionChange(panel: vscode.WebviewPanel, section: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) return;

		switch (section) {
			case 'profile':
				await this.refreshProfile(panel);
				break;
			case 'api-keys':
				await this.refreshProfile(panel);
				await this.refreshKeys(panel);
				break;
			case 'organization':
				await this.refreshOrg(panel);
				break;
			case 'members':
				await this.refreshOrg(panel);
				await this.refreshMembers(panel);
				break;
			case 'teams':
				await this.refreshOrg(panel);
				await this.refreshTeams(panel);
				break;
		}
	}

	// =========================================================================
	// PROFILE HANDLERS
	// =========================================================================

	/**
	 * Persists updated profile fields and posts the refreshed profile.
	 *
	 * @param panel  - The webview panel.
	 * @param fields - The profile fields to update.
	 */
	private async handleSaveProfile(panel: vscode.WebviewPanel, fields: Record<string, string>): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: send the update request.
		await client.account.updateProfile(fields);

		// Step 2: fetch the refreshed profile and post it back to the webview.
		const profile = await client.account.getProfile().catch(() => null);
		await panel.webview.postMessage({ type: 'account:profile', profile: profile || client.getAccountInfo() || null });
	}

	/**
	 * Sets the user's default team and posts the refreshed profile.
	 *
	 * @param panel  - The webview panel.
	 * @param teamId - The team ID to set as default.
	 */
	private async handleSetDefaultTeam(panel: vscode.WebviewPanel, teamId: string): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: send the set_default_team request.
		await client.account.setDefaultTeam(teamId);

		// Step 2: fetch the refreshed profile and post it back to the webview.
		const profile = await client.account.getProfile().catch(() => null);
		await panel.webview.postMessage({ type: 'account:profile', profile: profile || client.getAccountInfo() || null });
	}

	// =========================================================================
	// API KEY HANDLERS
	// =========================================================================

	/**
	 * Creates a new API key and posts the key value and refreshed list.
	 *
	 * @param panel  - The webview panel.
	 * @param params - Key creation parameters (name, teamId, permissions, expiresAt).
	 */
	private async handleCreateKey(panel: vscode.WebviewPanel, params: { name: string; teamId: string; permissions: string[]; expiresAt?: string }): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: create the key.
		const { key } = await client.account.createKey(params);

		// Step 2: post the raw key value so the reveal modal can display it.
		await panel.webview.postMessage({ type: 'account:keyCreated', key });

		// Step 3: refresh the full key list.
		await this.refreshKeys(panel);
	}

	/**
	 * Revokes an API key and refreshes the key list.
	 *
	 * @param panel - The webview panel.
	 * @param keyId - The ID of the key to revoke.
	 */
	private async handleRevokeKey(panel: vscode.WebviewPanel, keyId: string): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: revoke the key.
		await client.account.revokeKey(keyId);

		// Step 2: refresh the key list.
		await this.refreshKeys(panel);
	}

	/**
	 * Fetches the current API key list and posts it to the webview.
	 *
	 * @param panel - The webview panel.
	 */
	private async refreshKeys(panel: vscode.WebviewPanel): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) return;

		// Fetch the key list via the SDK.
		const keys = await client.account.listKeys();
		await panel.webview.postMessage({ type: 'account:keys', keys });
	}

	// =========================================================================
	// ORGANIZATION HANDLERS
	// =========================================================================

	/**
	 * Saves the organization name and refreshes the org detail.
	 *
	 * @param panel - The webview panel.
	 * @param name  - The new organization name.
	 */
	private async handleSaveOrgName(panel: vscode.WebviewPanel, name: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: update the org name.
		await client.account.updateOrgName(orgId!, name);

		// Step 2: refresh org detail.
		await this.refreshOrg(panel);
	}

	/**
	 * Fetches the current org detail and posts it to the webview.
	 *
	 * @param panel - The webview panel.
	 */
	private async refreshOrg(panel: vscode.WebviewPanel): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) return;

		// Fetch org detail via the SDK.
		const org = await client.account.getOrg(orgId);
		await panel.webview.postMessage({ type: 'account:org', org: org || null });
	}

	// =========================================================================
	// MEMBER HANDLERS
	// =========================================================================

	/**
	 * Invites a new organization member and refreshes the member list.
	 *
	 * @param panel  - The webview panel.
	 * @param params - Invitation parameters (email, givenName, familyName, role).
	 */
	private async handleInviteMember(panel: vscode.WebviewPanel, params: { email: string; givenName: string; familyName: string; role: string }): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: send the invite.
		await client.account.inviteMember(orgId!, params);

		// Step 2: refresh the member list.
		await this.refreshMembers(panel);
	}

	/**
	 * Updates an organization member's role and refreshes the member list.
	 *
	 * @param panel  - The webview panel.
	 * @param userId - The user whose role is changing.
	 * @param role   - The new role string.
	 */
	private async handleUpdateRole(panel: vscode.WebviewPanel, userId: string, role: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: update the role.
		await client.account.updateMemberRole(orgId!, userId, role);

		// Step 2: refresh the member list.
		await this.refreshMembers(panel);
	}

	/**
	 * Removes an organization member and refreshes the member list.
	 *
	 * @param panel  - The webview panel.
	 * @param userId - The user to remove.
	 */
	private async handleRemoveMember(panel: vscode.WebviewPanel, userId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: remove the member.
		await client.account.removeMember(orgId!, userId);

		// Step 2: refresh the member list.
		await this.refreshMembers(panel);
	}

	/**
	 * Fetches the current member list and posts it to the webview.
	 *
	 * @param panel - The webview panel.
	 */
	private async refreshMembers(panel: vscode.WebviewPanel): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) return;

		// Fetch member list via the SDK.
		const members = await client.account.listMembers(orgId!);
		await panel.webview.postMessage({ type: 'account:members', members });
	}

	// =========================================================================
	// TEAM HANDLERS
	// =========================================================================

	/**
	 * Creates a new team and refreshes the team list.
	 *
	 * @param panel - The webview panel.
	 * @param name  - The name for the new team.
	 */
	private async handleCreateTeam(panel: vscode.WebviewPanel, name: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: create the team.
		await client.account.createTeam(orgId!, name);

		// Step 2: refresh the team list.
		await this.refreshTeams(panel);
	}

	/**
	 * Deletes a team and refreshes the team list.
	 *
	 * @param panel  - The webview panel.
	 * @param teamId - The ID of the team to delete.
	 */
	private async handleDeleteTeam(panel: vscode.WebviewPanel, teamId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: delete the team.
		await client.account.deleteTeam(orgId!, teamId);

		// Step 2: refresh the team list.
		await this.refreshTeams(panel);
	}

	/**
	 * Fetches detail for a specific team and posts it to the webview.
	 *
	 * @param panel  - The webview panel.
	 * @param teamId - The ID of the team to load.
	 */
	private async handleLoadTeamDetail(panel: vscode.WebviewPanel, teamId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Fetch team detail via the SDK.
		const teamDetail: TeamDetail = await client.account.getTeamDetail(orgId!, teamId);
		await panel.webview.postMessage({ type: 'account:teamDetail', teamDetail: teamDetail || null });
	}

	/**
	 * Adds a member to a team and refreshes the team detail.
	 *
	 * @param panel  - The webview panel.
	 * @param params - Parameters (teamId, userId, permissions).
	 */
	private async handleAddTeamMember(panel: vscode.WebviewPanel, params: { teamId: string; userId: string; permissions: string[] }): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: add the member.
		await client.account.addTeamMember(orgId!, params);

		// Step 2: refresh the team detail.
		await this.handleLoadTeamDetail(panel, params.teamId);
	}

	/**
	 * Edits a team member's permissions and refreshes the team detail.
	 *
	 * @param panel  - The webview panel.
	 * @param params - Parameters (teamId, userId, permissions).
	 */
	private async handleEditPerms(panel: vscode.WebviewPanel, params: { teamId: string; userId: string; permissions: string[] }): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: update permissions.
		await client.account.updateTeamMemberPerms(orgId!, params);

		// Step 2: refresh the team detail.
		await this.handleLoadTeamDetail(panel, params.teamId);
	}

	/**
	 * Removes a member from a team and refreshes the team detail.
	 *
	 * @param panel  - The webview panel.
	 * @param params - Parameters (teamId, userId).
	 */
	private async handleRemoveTeamMember(panel: vscode.WebviewPanel, params: { teamId: string; userId: string }): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: remove the team member.
		await client.account.removeTeamMember(orgId!, params);

		// Step 2: refresh the team detail.
		await this.handleLoadTeamDetail(panel, params.teamId);
	}

	/**
	 * Fetches the current team list and posts it to the webview.
	 *
	 * @param panel - The webview panel.
	 */
	private async refreshTeams(panel: vscode.WebviewPanel): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) return;

		// Fetch team list via the SDK.
		const teams = await client.account.listTeams(orgId!);
		await panel.webview.postMessage({ type: 'account:teams', teams });
	}

	// =========================================================================
	// AUTH / DANGER ZONE
	// =========================================================================

	/** Signs the user out via CloudAuthProvider. */
	private async handleLogout(): Promise<void> {
		const cloudAuth = CloudAuthProvider.getInstance();
		await cloudAuth.signOut();
	}

	/**
	 * Deletes the user's account.
	 *
	 * @param panel - The webview panel.
	 */
	private async handleDeleteAccount(panel: vscode.WebviewPanel): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: delete the account on the server.
		await client.account.deleteAccount();

		// Step 2: sign out locally after account deletion.
		await this.handleLogout();
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	/** Subscribes to connection state changes and account update events. */
	private setupEventListeners(): void {
		// Re-sync webview when connection state changes
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', (status: ConnectionStatus) => {
			this.handleConnectionStateChange(status).catch((error) => {
				console.error(`[PageAccountProvider] Connection state change error: ${error}`);
			});
		});

		// Re-fetch profile when the server pushes an account update event
		const accountEventListener = this.connectionManager.on('event', (event: any) => {
			if (event?.event === 'apaext_account' && PageAccountProvider.panel) {
				this.refreshProfile(PageAccountProvider.panel).catch((error) => {
					console.error(`[PageAccountProvider] Account update error: ${error}`);
				});
			}
		});

		this.disposables.push(connectionStateListener, accountEventListener);
	}

	/**
	 * Handles a connection state change by notifying the webview and
	 * re-fetching data on reconnect.
	 *
	 * @param status - The new connection status.
	 */
	private async handleConnectionStateChange(status: ConnectionStatus): Promise<void> {
		if (!PageAccountProvider.panel) return;

		// Step 1: notify the webview of the connection change.
		await PageAccountProvider.panel.webview.postMessage({
			type: 'shell:connectionChange',
			isConnected: status.state === ConnectionState.CONNECTED,
		});

		// Step 2: re-fetch all data on reconnect.
		if (status.state === ConnectionState.CONNECTED) {
			await this.sendInitialData(PageAccountProvider.panel);
		}
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	/**
	 * Resolves the best available client using dev → deploy cascade.
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

	/**
	 * Posts an error message to the webview.
	 *
	 * @param panel   - The webview panel.
	 * @param message - The error description.
	 */
	private postError(panel: vscode.WebviewPanel, message: string): void {
		panel.webview.postMessage({ type: 'account:error', error: message }).then(undefined, (err: unknown) => {
			console.error(`[PageAccountProvider] Failed to post error: ${err}`);
		});
	}

	// =========================================================================
	// HTML GENERATION
	// =========================================================================

	/**
	 * Reads the pre-built HTML template and injects nonce + webview URIs.
	 *
	 * @param webview - The webview to generate HTML for.
	 * @returns The full HTML string.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-account.html');

		try {
			let htmlContent = readFileSync(htmlPath.fsPath, 'utf8');

			// Step 1: replace template placeholders.
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Step 2: convert resource URLs to webview URIs.
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Account Page</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
                <p>Expected: <code>${htmlPath.fsPath}</code></p>
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
		if (PageAccountProvider.panel) {
			PageAccountProvider.panel.dispose();
			PageAccountProvider.panel = null;
		}
	}
}
