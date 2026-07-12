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
 *   AccountProvider (Node.js) ↔ postMessage ↔ AccountWebview (browser) → AccountView (pure UI)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { ConnectionManager } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';
import { ConfigManager } from '../config';
import { ConnectionState } from '../shared/types';
import type { ConnectionStatus } from '../shared/types';
import type { ConnectResult, TeamDetail } from 'rocketride';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { PIPE_BUILDER_APP_ID } from '../shared/types';

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
	appId?: string;
	packId?: string;
	priceId?: string;
	newPriceId?: string;
	orgId?: string;
	subscriptionId?: string;
	promotionCode?: string;
	code?: string;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class AccountProvider {
	/** Singleton panel reference — prevents duplicate panels. */
	private static panel: vscode.WebviewPanel | null = null;

	/** Tracks the last section the webview navigated to, so we know what to
	 *  reload when a server-pushed account update arrives. */
	private static currentSection: string = 'profile';

	/** Tracks the currently viewed team detail, so we can reload it when
	 *  a server-pushed account update arrives (e.g. permission changes). */
	private static activeTeamId: string | null = null;

	private disposables: vscode.Disposable[] = [];

	private connectionManager = ConnectionManager.getInstance();
	private configManager = ConfigManager.getInstance();

	/**
	 * Creates the AccountProvider, registers the open command, and sets up
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
		if (AccountProvider.panel) {
			AccountProvider.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Step 2: create a new webview panel.
		const panel = vscode.window.createWebviewPanel('rocketride.pageAccount', 'Account', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		AccountProvider.panel = panel;
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Step 3: handle incoming messages from the webview.
		panel.webview.onDidReceiveMessage(async (message: AccountWebviewMessage) => {
			try {
				await this.handleWebviewMessage(panel, message);
			} catch (error) {
				console.error(`[AccountProvider] Message handling error: ${error}`);
				this.postError(panel, String(error));
			}
		});

		// Step 4: clean up on dispose.
		panel.onDidDispose(() => {
			AccountProvider.panel = null;
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

			case 'account:setDefaultOrg':
				await this.handleSetDefaultOrg(panel, message.orgId as string);
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

			case 'account:resendInvite':
				await this.handleResendInvite(panel, message.userId as string);
				break;

			// -- Teams ------------------------------------------------------------
			case 'account:createTeam':
				await this.handleCreateTeam(panel, message.name as string);
				break;

			case 'account:deleteTeam':
				await this.handleDeleteTeam(panel, message.teamId as string);
				break;

			case 'account:loadTeamDetail':
				AccountProvider.activeTeamId = message.teamId as string;
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

			// -- Billing ----------------------------------------------------------
			case 'billing:cancel':
				await this.handleCancelSubscription(panel, message.appId as string);
				break;

			case 'billing:portal':
				await this.handleOpenPortal();
				break;

			case 'billing:purchaseTopup':
				await this.handlePurchaseTopup(panel, message.priceId as string);
				break;

			case 'billing:upgrade':
				await this.handleUpgradeSubscription(panel, message.appId as string, message.newPriceId as string);
				break;

			// -- Checkout flow (embedded Stripe Elements in the Account webview) ---
			case 'checkout:fetchPlans':
				await this.handleCheckoutFetchPlans(panel);
				break;

			case 'checkout:createSession':
				await this.handleCheckoutCreateSession(panel, message);
				break;

			case 'checkout:confirmPending':
				await this.handleCheckoutConfirmPending(panel, message);
				break;

			case 'checkout:validatePromo':
				await this.handleCheckoutValidatePromo(panel, message);
				break;

			case 'checkout:redeemPromo':
				await this.handleCheckoutRedeemPromo(panel, message);
				break;

			// Environment variables removed — now handled by EnvironmentProvider.

			// -- Section navigation (lazy loading) --------------------------------
			case 'account:sectionChange':
				AccountProvider.currentSection = message.section as string;
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
		const { client, accountInfo, orgId } = this.resolveClient();
		const isConnected = client !== undefined;

		// Fetch all account data upfront in parallel so every tab has data
		// immediately (badges, counts, billing) without waiting for the user
		// to click into each section.
		let profile: ConnectResult | null = accountInfo ?? null;
		let org = null;
		let members: any[] = [];
		let teams: any[] = [];
		let keys: any[] = [];

		if (client && isConnected) {
			const results = await Promise.all([
				client.account.getProfile().catch(() => null),
				orgId ? client.account.getOrg(orgId).catch(() => null) : null,
				orgId ? client.account.listMembers(orgId).catch(() => []) : [],
				orgId ? client.account.listTeams(orgId).catch(() => []) : [],
				client.account.listKeys().catch(() => []),
			]);
			if (results[0]) profile = results[0];
			org = results[1];
			members = results[2] as any[];
			teams = results[3] as any[];
			keys = results[4] as any[];
		}

		await panel.webview.postMessage({
			type: 'account:init',
			isConnected,
			profile,
			authUser: accountInfo ?? null,
			org,
			members,
			teams,
			keys,
		});

		// Also fetch billing data immediately
		await this.fetchBillingData(panel);
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
	 * Mirrors the shell-ui pattern of lazy per-section loading.
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
				// If a team detail is currently being viewed, reload it too
				// so permission/member changes are reflected
				if (AccountProvider.activeTeamId) {
					await this.handleLoadTeamDetail(panel, AccountProvider.activeTeamId);
				}
				break;
			case 'billing':
				await this.fetchBillingData(panel);
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

		// Step 2: the server pushes a refreshed ConnectResult to all connections
		// via push_account_update. The SDK updates getAccountInfo() automatically.
		// Post both profile and authUser so the UI reflects the new default.
		const profile = await client.account.getProfile().catch(() => null);
		const authUser = client.getAccountInfo();
		await panel.webview.postMessage({ type: 'account:profile', profile: profile || authUser || null });
		await panel.webview.postMessage({ type: 'account:authUser', authUser });
	}

	/**
	 * Switches the user's active organization.
	 *
	 * @param panel - The webview panel.
	 * @param orgId - The org ID to switch to.
	 */
	private async handleSetDefaultOrg(panel: vscode.WebviewPanel, orgId: string): Promise<void> {
		const { client } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		// Step 1: send the set_default_org request.
		await client.account.setDefaultOrg(orgId);

		// Step 2: the server pushes a refreshed ConnectResult to all connections.
		// Re-fetch profile and authUser so the UI reflects the new active org.
		const profile = await client.account.getProfile().catch(() => null);
		const authUser = client.getAccountInfo();
		await panel.webview.postMessage({ type: 'account:profile', profile: profile || authUser || null });
		await panel.webview.postMessage({ type: 'account:authUser', authUser });
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
	 * Resends the initialization email for a pending org member.
	 *
	 * @param panel  - The webview panel.
	 * @param userId - The pending member's user ID.
	 */
	private async handleResendInvite(panel: vscode.WebviewPanel, userId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client) {
			this.postError(panel, 'Not connected');
			return;
		}

		await client.account.resendInvite(orgId!, userId);
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
		const connectionStateListener = this.connectionManager.on('shell:statusChange', (status: ConnectionStatus) => {
			this.handleConnectionStateChange(status).catch((error) => {
				console.error(`[AccountProvider] Connection state change error: ${error}`);
			});
		});

		// Re-fetch data when the server pushes an account update
		const accountEventListener = this.connectionManager.on('shell:accountUpdate', () => {
			if (AccountProvider.panel) {
				const panel = AccountProvider.panel;
				// Refresh profile (always needed — identity/permissions may have changed)
				this.refreshProfile(panel).catch((error) => {
					console.error(`[AccountProvider] Account update error: ${error}`);
				});
				// Re-fetch the currently visible section's data (teams, members, etc.)
				this.handleSectionChange(panel, AccountProvider.currentSection).catch((error) => {
					console.error(`[AccountProvider] Section reload error: ${error}`);
				});
				// Notify the webview that account data has changed
				panel.webview.postMessage({ type: 'account:accountUpdate' }).then(undefined, (err: unknown) => {
					console.error(`[AccountProvider] Failed to post accountUpdate: ${err}`);
				});
			}
		});

		// Subscribe to billing monitor and re-fetch on billing ledger events
		const client = this.connectionManager.getClient();
		if (client) {
			client.addMonitor({ token: '*' }, ['billing']).catch(() => {});
		}
		const billingEventListener = this.connectionManager.on('shell:event' as any, ({ event }: any) => {
			if (event?.event === 'apaext_billing_update' && AccountProvider.panel) {
				this.fetchBillingData(AccountProvider.panel).catch(() => {});
			}
		});

		this.disposables.push(connectionStateListener, accountEventListener, billingEventListener);
	}

	/**
	 * Handles a connection state change by notifying the webview and
	 * re-fetching data on reconnect.
	 *
	 * @param status - The new connection status.
	 */
	private async handleConnectionStateChange(status: ConnectionStatus): Promise<void> {
		if (!AccountProvider.panel) return;

		// Step 1: notify the webview of the connection change.
		await AccountProvider.panel.webview.postMessage({
			type: 'shell:connectionChange',
			isConnected: status.state === ConnectionState.CONNECTED,
		});

		// Step 2: re-fetch all data on reconnect.
		if (status.state === ConnectionState.CONNECTED) {
			await this.sendInitialData(AccountProvider.panel);
		}
	}

	// =========================================================================
	// BILLING HANDLERS
	// =========================================================================

	/**
	 * Fetches all billing data (subscriptions, credit balance, credit packs)
	 * and posts the combined result to the webview.
	 */
	private async fetchBillingData(panel: vscode.WebviewPanel): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) {
			await panel.webview.postMessage({
				type: 'account:billing',
				subscriptions: [],
				creditBalance: null,
				billingLoading: false,
				billingError: 'No organisation found. Please sign in first.',
			});
			return;
		}

		// Post loading state
		await panel.webview.postMessage({
			type: 'account:billing',
			subscriptions: [],
			creditBalance: null,
			billingLoading: true,
			billingError: null,
		});

		try {
			// Fetch all billing data in parallel — all from local DB, no Stripe calls
			const [subscriptions, creditBalance, allPlans, transactions, usageByUser, usageByTeam] = await Promise.all([
				client.billing.getDetails(orgId),
				client.billing.getCreditBalance(orgId),
				client.billing.getProductPrices(PIPE_BUILDER_APP_ID).catch(() => []),
				client.billing.getTransactions(orgId, { page: 1, pageSize: 20 }).catch(() => null),
				client.billing.getUsageByUser(orgId).catch(() => []),
				client.billing.getUsageByTeam(orgId).catch(() => []),
			]);

			// Split plans into topups for the billing dashboard
			const topupPlans = (allPlans as any[]).filter((p: any) => p.metadata?.kind === 'topup');

			await panel.webview.postMessage({
				type: 'account:billing',
				subscriptions,
				creditBalance,
				topupPlans,
				allPlans,
				transactions,
				usageByUser,
				usageByTeam,
				billingLoading: false,
				billingError: null,
			});
		} catch (error) {
			console.error(`[AccountProvider] Failed to fetch billing data: ${error}`);
			await panel.webview.postMessage({
				type: 'account:billing',
				subscriptions: [],
				creditBalance: null,
				transactions: null,
				usageByUser: [],
				usageByTeam: [],
				billingLoading: false,
				billingError: `Failed to load billing data: ${error}`,
			});
		}
	}

	/**
	 * Cancels a subscription and re-fetches billing data.
	 *
	 * @param panel - The webview panel.
	 * @param appId - The app whose subscription to cancel.
	 */
	private async handleCancelSubscription(panel: vscode.WebviewPanel, appId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) return;

		try {
			await client.billing.cancelSubscription(orgId, appId);
			// Re-fetch so the UI reflects the change
			await this.fetchBillingData(panel);
		} catch (error) {
			console.error(`[AccountProvider] Failed to cancel subscription: ${error}`);
			this.postError(panel, `Failed to cancel subscription: ${error}`);
		}
	}

	/**
	 * Fetches available subscription plans for the checkout modal.
	 *
	 * @param panel - The webview panel to post the result to.
	 */
	private async handleCheckoutFetchPlans(panel: vscode.WebviewPanel): Promise<void> {
		try {
			const { client } = this.resolveClient();
			if (!client) throw new Error('Not connected');
			const plans = await client.billing.getProductPrices(PIPE_BUILDER_APP_ID);
			await panel.webview.postMessage({ type: 'checkout:plansResult', plans, error: null });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			await panel.webview.postMessage({ type: 'checkout:plansResult', plans: [], error: msg });
		}
	}

	/**
	 * Creates a Stripe checkout session and returns the client secret.
	 *
	 * @param panel   - The webview panel to post the result to.
	 * @param message - The incoming message containing the priceId.
	 */
	private async handleCheckoutCreateSession(panel: vscode.WebviewPanel, message: AccountWebviewMessage): Promise<void> {
		try {
			const { client, orgId } = this.resolveClient();
			if (!client) throw new Error('Not connected');
			if (!orgId) throw new Error('No organisation found');
			// clientSecret is null for a $0 first invoice (100%-off promo code) —
			// the webview must treat that as "no payment step", not an error.
			const result = await client.billing.createCheckoutSession(
				orgId,
				PIPE_BUILDER_APP_ID,
				message.priceId as string,
				message.promotionCode as string | undefined,
			);
			await panel.webview.postMessage({ type: 'checkout:sessionResult', ...result, error: null });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			await panel.webview.postMessage({ type: 'checkout:sessionResult', clientSecret: '', subscriptionId: '', error: msg });
		}
	}

	/**
	 * Resolves a promo code (read-only) and posts the validation result.
	 *
	 * @param panel   - The webview panel to post the result to.
	 * @param message - The incoming message containing code and optional priceId.
	 */
	private async handleCheckoutValidatePromo(panel: vscode.WebviewPanel, message: AccountWebviewMessage): Promise<void> {
		try {
			const { client, orgId } = this.resolveClient();
			if (!client) throw new Error('Not connected');
			if (!orgId) throw new Error('No organisation found');
			const result = await client.billing.validatePromoCode(orgId, message.code as string, message.priceId as string | undefined);
			await panel.webview.postMessage({ type: 'checkout:validatePromoResult', result, error: null });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			await panel.webview.postMessage({ type: 'checkout:validatePromoResult', result: null, error: msg });
		}
	}

	/**
	 * Redeems a credit-grant (hackathon) code and refreshes billing data so
	 * the new subscription and credits appear immediately.
	 *
	 * @param panel   - The webview panel to post the result to.
	 * @param message - The incoming message containing the code.
	 */
	private async handleCheckoutRedeemPromo(panel: vscode.WebviewPanel, message: AccountWebviewMessage): Promise<void> {
		try {
			const { client, orgId } = this.resolveClient();
			if (!client) throw new Error('Not connected');
			if (!orgId) throw new Error('No organisation found');
			const result = await client.billing.redeemPromoCode(orgId, message.code as string);
			await panel.webview.postMessage({ type: 'checkout:redeemPromoResult', result, error: null });
			// Refresh subscriptions + credit balance so the grant shows up
			await this.fetchBillingData(panel);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			await panel.webview.postMessage({ type: 'checkout:redeemPromoResult', result: null, error: msg });
		}
	}

	/**
	 * Notifies the server that Stripe payment was confirmed client-side.
	 *
	 * @param panel   - The webview panel to post the result to.
	 * @param message - The incoming message containing subscriptionId and priceId.
	 */
	private async handleCheckoutConfirmPending(panel: vscode.WebviewPanel, message: AccountWebviewMessage): Promise<void> {
		try {
			const { client } = this.resolveClient();
			if (!client) throw new Error('Not connected');
			await (client as any).dapRequest('rrext_account_billing', {
				subcommand: 'confirm_pending',
				appId: PIPE_BUILDER_APP_ID,
				subscriptionId: message.subscriptionId,
				priceId: message.priceId,
			});
			await panel.webview.postMessage({ type: 'checkout:confirmResult', error: null });
		} catch (err: unknown) {
			// Non-fatal -- the webhook will still update the DB, but surface the error
			const msg = err instanceof Error ? err.message : String(err);
			await panel.webview.postMessage({ type: 'checkout:confirmResult', error: msg });
		}
	}

	/**
	 * Creates a Stripe portal session and opens the URL in the user's browser.
	 */
	private async handleOpenPortal(): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) return;

		try {
			const { url } = await client.billing.createPortalSession(orgId, 'https://rocketride.ai');
			await vscode.env.openExternal(vscode.Uri.parse(url));
		} catch (error) {
			console.error(`[AccountProvider] Failed to open billing portal: ${error}`);
		}
	}

	/**
	 * Purchases a top-up pack by charging the customer's card on file.
	 * Posts the result back to the webview for the TopUpModal to handle.
	 */
	private async handlePurchaseTopup(panel: vscode.WebviewPanel, priceId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) {
			await panel.webview.postMessage({ type: 'billing:topupResult', error: 'Not connected' });
			return;
		}
		try {
			const result = await client.billing.purchaseTopup(orgId, priceId);
			await panel.webview.postMessage({ type: 'billing:topupResult', result });
			// Re-fetch billing data to reflect the new balance
			if (result.status === 'succeeded') {
				await this.fetchBillingData(panel);
			}
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			await panel.webview.postMessage({ type: 'billing:topupResult', error: msg });
		}
	}

	/**
	 * Handles an upgrade/downgrade subscription request from the webview.
	 *
	 * Calls the SDK to change the subscription plan on the server, then
	 * re-fetches billing data and sends the result back to the webview.
	 *
	 * @param panel      - The webview panel to post the result to.
	 * @param appId      - The app whose subscription is being changed.
	 * @param newPriceId - Stripe price_* identifier for the target plan.
	 */
	private async handleUpgradeSubscription(panel: vscode.WebviewPanel, appId: string, newPriceId: string): Promise<void> {
		const { client, orgId } = this.resolveClient();
		if (!client || !orgId) {
			await panel.webview.postMessage({ type: 'billing:upgradeResult', error: 'Not connected' });
			return;
		}
		try {
			await client.billing.upgradeSubscription(orgId, appId, newPriceId);
			await panel.webview.postMessage({ type: 'billing:upgradeResult' });
			// Re-fetch billing data to reflect the updated subscription
			await this.fetchBillingData(panel);
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			await panel.webview.postMessage({ type: 'billing:upgradeResult', error: msg });
		}
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	/**
	 * Resolves the best available client by checking which connection is
	 * actually cloud-connected.  Dev takes priority; if dev is not cloud,
	 * falls back to deploy.  Local/docker/service connections don't have
	 * real cloud account info and should not be used for account operations.
	 *
	 * @returns The client, its account info, and the orgId (if available).
	 */
	private resolveClient(): { client: any | undefined; accountInfo: any | undefined; orgId: string | undefined } {
		const config = this.configManager.getConfig();

		const devClient = this.connectionManager.getClient();
		const devInfo = devClient?.getAccountInfo();
		const deployClient = DeployManager.getDeployInstance().getClient();
		const deployInfo = deployClient?.getAccountInfo();

		// Prefer whichever connection is cloud-connected (dev first).
		const accountInfo =
			(config.development.connectionMode === 'cloud' ? devInfo : null) ??
			(config.deployment.connectionMode === 'cloud' ? deployInfo : null);

		const client =
			(config.development.connectionMode === 'cloud' && devClient ? devClient : null) ??
			(config.deployment.connectionMode === 'cloud' && deployClient ? deployClient : null);

		const orgId = accountInfo?.organization?.id;
		return { client: client ?? undefined, accountInfo: accountInfo ?? undefined, orgId };
	}

	/**
	 * Posts an error message to the webview.
	 *
	 * @param panel   - The webview panel.
	 * @param message - The error description.
	 */
	private postError(panel: vscode.WebviewPanel, message: string): void {
		panel.webview.postMessage({ type: 'account:error', error: message }).then(undefined, (err: unknown) => {
			console.error(`[AccountProvider] Failed to post error: ${err}`);
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
		if (AccountProvider.panel) {
			AccountProvider.panel.dispose();
			AccountProvider.panel = null;
		}
	}
}
