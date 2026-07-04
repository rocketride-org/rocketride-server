// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// ACCOUNT VIEW — thin shell-ui wrapper around shared-ui AccountView.
//
// Owns all DAP fetching, shell auth, and event wiring. Passes pure data
// and async callbacks down to the host-agnostic AccountView.
// =============================================================================

import React, { useState, useEffect, useCallback, useMemo, CSSProperties } from 'react';
import { AccountView } from 'shared';
import type {
	ConnectResult,
	AccountSection,
	ApiKeyRecord,
	OrgDetail,
	MemberRecord,
	TeamRecord,
	TeamDetail,
	ProfileUpdate,
	BillingDetail,
	CreditBalance,
	TransactionsResult,
	UsageRollup,
} from 'rocketride';
import { useShellConnection } from '../../connection/ConnectionContext';
import { useAuthUser, useLogout } from '../../hooks/useAuthUser';
import { ConnectionManager } from '../../connection/connection';
import { useWorkspace } from '../../workspace/WorkspaceContext';

// =============================================================================
// STYLES
// =============================================================================

const accountStyles = {
	root: {
		position: 'relative',
		width: '100%',
		height: '100%',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Cloud-UI AccountView wrapper.
 *
 * Fetches account data via DAP commands (`rrext_account_*`) and delegates
 * all rendering to the shared-ui AccountView. Listens for `shell:accountUpdate`
 * bus events to keep the profile in sync with server-pushed updates.
 */
const AccountPage: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const authUser = useAuthUser();
	const logout = useLogout();
	const { appManifest } = useWorkspace();

	// ── Navigation state ────────────────────────────────────────────────────
	const [section, setSection] = useState<AccountSection>('profile');
	const [activeTeamId, setActiveTeamId] = useState<string | null>(null);

	// ── Data ────────────────────────────────────────────────────────────────
	const [profile, setProfile] = useState<ConnectResult | null>(null);
	const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
	const [org, setOrg] = useState<OrgDetail | null>(null);
	const [members, setMembers] = useState<MemberRecord[]>([]);
	const [teams, setTeams] = useState<TeamRecord[]>([]);
	const [teamDetail, setTeamDetail] = useState<TeamDetail | null>(null);

	// ── Billing data ────────────────────────────────────────────────────────
	const [subscriptions, setSubscriptions] = useState<BillingDetail[]>([]);
	const [billingLoading, setBillingLoading] = useState(true);
	const [billingError, setBillingError] = useState<string | null>(null);
	const [creditBalance, setCreditBalance] = useState<CreditBalance | null>(
		(authUser as { credits?: CreditBalance })?.credits ?? null,
	);
	const [allPlans, setAllPlans] = useState<any[]>([]);
	const [transactions, setTransactions] = useState<TransactionsResult | null>(null);
	const [usageByUser, setUsageByUser] = useState<UsageRollup[]>([]);
	const [usageByTeam, setUsageByTeam] = useState<UsageRollup[]>([]);
	const [dashboardLoading, setDashboardLoading] = useState(false);

	// ── Refresh signal (bumped by shell:accountUpdate) ─────────────────────
	const [refreshSignal, setRefreshSignal] = useState(0);

	// ── Section load error ──────────────────────────────────────────────────
	const [sectionError, setSectionError] = useState<string | null>(null);

	// Keep profile in sync with server-pushed account updates, bump refresh
	// signal for env, and bump reload counter to re-fetch the active section
	useEffect(() => ConnectionManager.getInstance().on('shell:accountUpdate', (data) => {
		setProfile(data);
		setRefreshSignal((n) => n + 1);
		setReloadCounter((n) => n + 1);
	}), []);

	// Bumped by shell:accountUpdate — added to section-load effect deps so
	// the currently visible section re-fetches its data (teams, members, etc.)
	const [reloadCounter, setReloadCounter] = useState(0);

	// ── Data loaders ────────────────────────────────────────────────────────

	/** Derives the orgId from the auth user's organization. */
	const orgId = authUser?.organization?.id ?? '';

	/** Extracts a human-readable message from a thrown value. */
	const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

	/** Fetches the current user's profile from the server. */
	const loadProfile = useCallback(async () => {
		if (!client) return;
		try {
			const body = await client.account.getProfile();
			setProfile(body);
		} catch (e) { setSectionError(errMsg(e)); }
	}, [client]);

	/** Fetches the list of API keys owned by the current user. */
	const loadKeys = useCallback(async () => {
		if (!client) return;
		try {
			const keys = await client.account.listKeys();
			setKeys(keys);
		} catch (e) { setSectionError(errMsg(e)); }
	}, [client]);

	/** Fetches the organization detail. */
	const loadOrg = useCallback(async () => {
		if (!client || !orgId) return;
		try {
			const body = await client.account.getOrg(orgId);
			setOrg(body);
		} catch (e) { setSectionError(errMsg(e)); }
	}, [client, orgId]);

	/** Fetches the flat list of organization members. */
	const loadMembers = useCallback(async () => {
		if (!client || !orgId) return;
		try {
			const members = await client.account.listMembers(orgId);
			setMembers(members);
		} catch (e) { setSectionError(errMsg(e)); }
	}, [client, orgId]);

	/** Fetches the flat list of teams in the organization. */
	const loadTeams = useCallback(async () => {
		if (!client || !orgId) return;
		try {
			const teams = await client.account.listTeams(orgId);
			setTeams(teams);
		} catch (e) { setSectionError(errMsg(e)); }
	}, [client, orgId]);

	/**
	 * Fetches full detail (including member list) for a specific team.
	 * @param teamId - The unique identifier of the team to load.
	 */
	const loadTeamDetail = useCallback(async (teamId: string) => {
		if (!client || !orgId) return;
		try {
			const body = await client.account.getTeamDetail(orgId, teamId);
			setTeamDetail(body);
		} catch (e) { setSectionError(errMsg(e)); }
	}, [client, orgId]);


	// ── Load billing data ───────────────────────────────────────────────────

	/** Fetches subscriptions, credit balance, and credit packs in parallel. */
	/** Fetches all billing data in one shot: subscriptions, balance, plans, transactions, usage. */
	const loadBilling = useCallback(async () => {
		if (!client || !isConnected || !orgId) {
			setBillingLoading(false);
			return;
		}
		setBillingError(null);
		try {
			const [subs, balance, plans, tx, byUser, byTeam] = await Promise.all([
				client.billing.getDetails(orgId).catch((err: any) => {
					setBillingError(err.message ?? 'Failed to load subscriptions');
					return [] as BillingDetail[];
				}),
				client.billing.getCreditBalance(orgId).catch(() => null),
				client.billing.getProductPrices('rocketride.pipeBuilder').catch(() => []),
				client.billing.getTransactions(orgId, { page: 1, pageSize: 20 }).catch(() => null),
				client.billing.getUsageByUser(orgId).catch(() => [] as UsageRollup[]),
				client.billing.getUsageByTeam(orgId).catch(() => [] as UsageRollup[]),
			]);
			setSubscriptions(subs);
			setCreditBalance(balance);
			setAllPlans(plans);
			setTransactions(tx);
			setUsageByUser(byUser);
			setUsageByTeam(byTeam);
		} finally {
			setBillingLoading(false);
			setDashboardLoading(false);
		}
	}, [client, isConnected, orgId]);

	/** Fetches just the transactions page (for pagination). */
	const handleTransactionPage = useCallback(async (page: number) => {
		if (!client || !orgId) return;
		const tx = await client.billing.getTransactions(orgId, { page, pageSize: 20 }).catch(() => null);
		if (tx) { setTransactions(tx); }
	}, [client, orgId]);

	/** Purchase a top-up pack by charging the card on file. */
	const handlePurchaseTopup = useCallback(async (plan: any) => {
		if (!client || !orgId) throw new Error('Not connected');
		const result = await client.billing.purchaseTopup(orgId, plan.stripePriceId);
		if (result.status === 'succeeded') {
			// Re-fetch billing data to reflect the new balance
			loadBilling();
		}
		return result;
	}, [client, orgId, loadBilling]);

	/** Upgrade or downgrade an existing subscription to a new plan. */
	const handleUpgradeSubscription = useCallback(async (appId: string, newPriceId: string) => {
		if (!client || !orgId) throw new Error('Not connected');
		await client.billing.upgradeSubscription(orgId, appId, newPriceId);
		// Re-fetch billing data to reflect the updated subscription
		loadBilling();
	}, [client, orgId, loadBilling]);

	// ── Load ALL data upfront on connect (badges, counts, billing) ──────────
	useEffect(() => {
		if (!isConnected || !client) return;
		loadProfile();
		loadKeys();
		loadOrg();
		loadMembers();
		loadTeams();
		loadBilling();
	}, [isConnected, client]);

	// ── Subscribe to billing events when billing tab is active ──────────────
	useEffect(() => {
		if (!client || !isConnected || section !== 'billing') return;
		// Subscribe to billing ledger events via the wildcard monitor
		client.addMonitor({ token: '*' }, ['billing']).catch(() => {});
		// Listen for billing update events via ConnectionManager and re-fetch
		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: any) => {
			if (event?.event === 'apaext_billing_update') {
				loadBilling();
			}
		});
		return () => {
			client.removeMonitor({ token: '*' }, ['billing']).catch(() => {});
			unsub();
		};
	}, [section, client, isConnected]);

	// ── Reload current section on refresh signal ─────────────────────────────
	useEffect(() => {
		if (!reloadCounter || !isConnected || !client) return;
		setSectionError(null);
		if (section === 'profile') loadProfile();
		else if (section === 'billing') loadBilling();
		else if (section === 'api-keys') { loadProfile(); loadKeys(); }
		else if (section === 'organization') loadOrg();
		else if (section === 'members') { loadOrg(); loadMembers(); }
		else if (section === 'teams') { loadOrg(); loadTeams(); }
	}, [reloadCounter]);

	// ── Load team detail when a team is selected or data changes ────────────
	useEffect(() => {
		if (!activeTeamId || !isConnected) return;
		loadTeamDetail(activeTeamId);
		loadMembers();
	}, [activeTeamId, isConnected, reloadCounter]);

	// ── Callbacks ────────────────────────────────────────────────────────────

	/** Persists updated profile fields via the SDK. */
	const handleSaveProfile = useCallback(async (fields: ProfileUpdate) => {
		if (!client) return;
		await client.account.updateProfile(fields);
		// Server pushes an updated ConnectResult via shell:accountUpdate
	}, [client]);

	/** Sets the user's preferred default team. */
	const handleSetDefaultTeam = useCallback(async (teamId: string) => {
		if (!client) return;
		await client.account.setDefaultTeam(teamId);
	}, [client]);

	/** Switches the user's active organization. */
	const handleSetDefaultOrg = useCallback(async (orgId: string) => {
		if (!client) return;
		await client.account.setDefaultOrg(orgId);
	}, [client]);

	/** Deletes the user account. */
	const handleDeleteAccount = useCallback(async () => {
		if (!client) return;
		await client.account.deleteAccount();
	}, [client]);

	/** Persists an updated organization name. */
	const handleSaveOrgName = useCallback(async (name: string) => {
		if (!client || !orgId) return;
		await client.account.updateOrgName(orgId, name);
		// Optimistically update the in-memory org record
		setOrg((c) => c ? { ...c, name } : c);
	}, [client, orgId]);

	/** Creates a new API key and returns the raw key string. */
	const handleCreateKey = useCallback(async (params: { name: string; permissions: string[]; expiresAt?: string }) => {
		if (!client) throw new Error('Not connected');
		const { key } = await client.account.createKey(params);
		await loadKeys();
		return { key };
	}, [client, loadKeys]);

	/** Revokes an API key by ID. */
	const handleRevokeKey = useCallback(async (keyId: string) => {
		if (!client) return;
		await client.account.revokeKey(keyId);
		await loadKeys();
	}, [client, loadKeys]);

	/** Sends an invitation to a new organization member. */
	const handleInviteMember = useCallback(async (params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> }) => {
		if (!client || !orgId) return;
		await client.account.inviteMember(orgId, params);
		await loadMembers();
	}, [client, orgId, loadMembers]);

	/** Updates an organization member's role. */
	const handleUpdateMemberRole = useCallback(async (userId: string, role: string) => {
		if (!client || !orgId) return;
		await client.account.updateMemberRole(orgId, userId, role);
		await loadMembers();
	}, [client, orgId, loadMembers]);

	/** Removes an organization member. */
	const handleRemoveMember = useCallback(async (userId: string) => {
		if (!client || !orgId) return;
		await client.account.removeMember(orgId, userId);
		await loadMembers();
	}, [client, orgId, loadMembers]);

	/** Resends the initialization email for a pending member. */
	const handleResendInvite = useCallback(async (userId: string) => {
		if (!client || !orgId) return;
		await client.account.resendInvite(orgId, userId);
	}, [client, orgId]);

	/** Creates a new team. */
	const handleCreateTeam = useCallback(async (name: string) => {
		if (!client || !orgId) return;
		await client.account.createTeam(orgId, name);
		await loadTeams();
	}, [client, orgId, loadTeams]);

	/** Deletes a team. */
	const handleDeleteTeam = useCallback(async (teamId: string) => {
		if (!client || !orgId) return;
		await client.account.deleteTeam(orgId, teamId);
		setActiveTeamId(null);
		await loadTeams();
	}, [client, orgId, loadTeams]);

	/** Adds a member to a team with specified permissions. */
	const handleAddTeamMember = useCallback(async (params: { teamId: string; userId: string; permissions: string[] }) => {
		if (!client || !orgId) return;
		await client.account.addTeamMember(orgId, params);
		await loadTeamDetail(params.teamId);
	}, [client, orgId, loadTeamDetail]);

	/** Updates a team member's permissions. */
	const handleEditTeamMemberPerms = useCallback(async (params: { teamId: string; userId: string; permissions: string[] }) => {
		if (!client || !orgId) return;
		await client.account.updateTeamMemberPerms(orgId, params);
		await loadTeamDetail(params.teamId);
	}, [client, orgId, loadTeamDetail]);

	/** Removes a member from a team. */
	const handleRemoveTeamMember = useCallback(async (params: { teamId: string; userId: string }) => {
		if (!client || !orgId) return;
		await client.account.removeTeamMember(orgId, params);
		await loadTeamDetail(params.teamId);
	}, [client, orgId, loadTeamDetail]);

	/** Requests loading of full detail for a specific team. */
	const handleLoadTeamDetail = useCallback((teamId: string) => {
		loadTeamDetail(teamId);
		loadMembers();
	}, [loadTeamDetail, loadMembers]);

	// ── Billing callbacks ────────────────────────────────────────────────────

	/**
	 * Cancels a subscription and re-fetches the updated list.
	 * @param appId - The app whose subscription to cancel.
	 */
	const handleCancelSubscription = useCallback(async (appId: string) => {
		if (!client || !orgId) return;
		await client.billing.cancelSubscription(orgId, appId);
		const updated = await client.billing.getDetails(orgId);
		setSubscriptions(updated);
	}, [client, orgId]);

	/** Opens the Stripe customer portal for payment method management. */
	const handleOpenPortal = useCallback(async () => {
		if (!client || !orgId) return;
		const returnUrl = `${window.location.origin}${window.location.pathname}`;
		const { url } = await client.billing.createPortalSession(orgId, returnUrl);
		window.open(url, '_blank', 'noopener');
	}, [client, orgId]);

	// ── Environment callbacks ───────────────────────────────────────────────

	/**
	 * Loads environment variables for the given scope.
	 * @param scope - The env scope: 'org', 'team', or 'user'.
	 * @param scopeId - Required for 'org' and 'team' scopes.
	 * @returns The env key-value pairs, or an empty object if not connected.
	 */
	const handleLoadEnv = useCallback(async (scope: 'org' | 'team' | 'user', scopeId?: string) => {
		if (!client) return {};
		return client.account.getEnv(scope, scopeId);
	}, [client]);

	/**
	 * Persists environment variables for the given scope.
	 * @param scope - The env scope: 'org', 'team', or 'user'.
	 * @param env - The full env dict to save.
	 * @param scopeId - Required for 'org' and 'team' scopes.
	 */
	const handleSaveEnv = useCallback(async (
		scope: 'org' | 'team' | 'user',
		env: Record<string, string>,
		scopeId?: string,
	) => {
		if (!client) return;
		await client.account.setEnv(scope, env, scopeId);
	}, [client]);

	// ── Memoized lookups ────────────────────────────────────────────────────
	const memberNames = useMemo(
		() => Object.fromEntries(members.map((m: any) => [m.userId, m.displayName || m.email || m.userId])),
		[members],
	);
	const teamNames = useMemo(
		() => Object.fromEntries(teams.map((t: any) => [t.id, t.name || t.id])),
		[teams],
	);

	// ── Render ──────────────────────────────────────────────────────────────
	return (
		<div style={accountStyles.root}>
		<AccountView
			isConnected={isConnected}
			sectionError={sectionError}
			profile={profile}
			authUser={authUser}
			keys={keys}
			org={org}
			members={members}
			teams={teams}
			teamDetail={teamDetail}
			subscriptions={subscriptions}
			billingLoading={billingLoading}
			billingError={billingError}
			creditBalance={creditBalance}
			apps={appManifest}
			onCancelSubscription={handleCancelSubscription}
			onOpenPortal={handleOpenPortal}
			transactions={transactions}
			usageByUser={usageByUser}
			usageByTeam={usageByTeam}
			activeTasks={[]}
			topupPlans={allPlans.filter((p: any) => p.metadata?.kind === 'topup').map((p: any) => ({ id: p.id, stripePriceId: p.stripePriceId, nickname: p.nickname, amountCents: p.amountCents, metadata: p.metadata }))}
			allPlans={allPlans}
			onPurchaseTopup={handlePurchaseTopup}
			onUpgradeSubscription={handleUpgradeSubscription}
			dashboardLoading={dashboardLoading}
			onTransactionPage={handleTransactionPage}
			memberNames={memberNames}
			teamNames={teamNames}
			section={section}
			onSectionChange={setSection}
			activeTeamId={activeTeamId}
			onActiveTeamIdChange={setActiveTeamId}
			onSaveProfile={handleSaveProfile}
			onSetDefaultTeam={handleSetDefaultTeam}
			onSetDefaultOrg={handleSetDefaultOrg}
			onLogout={() => logout?.()}
			onDeleteAccount={handleDeleteAccount}
			onSaveOrgName={handleSaveOrgName}
			onCreateKey={handleCreateKey}
			onRevokeKey={handleRevokeKey}
			onInviteMember={handleInviteMember}
			onUpdateMemberRole={handleUpdateMemberRole}
			onRemoveMember={handleRemoveMember}
			onResendInvite={handleResendInvite}
			onCreateTeam={handleCreateTeam}
			onDeleteTeam={handleDeleteTeam}
			onAddTeamMember={handleAddTeamMember}
			onEditTeamMemberPerms={handleEditTeamMemberPerms}
			onRemoveTeamMember={handleRemoveTeamMember}
			onLoadTeamDetail={handleLoadTeamDetail}
			onLoadEnv={handleLoadEnv}
			onSaveEnv={handleSaveEnv}
			refreshSignal={refreshSignal}
		/>
		</div>
	);
};

export default AccountPage;
