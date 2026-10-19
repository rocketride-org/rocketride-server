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
// ACCOUNT VIEW — thin shell wrapper around shared AccountView.
//
// Owns all account/billing data fetching and event wiring; passes pure data
// and async callbacks down to the host-agnostic AccountView.
//
// REALM-AGNOSTIC BY CONSTRUCTION: every engine call is a brokered bus op
// (`request('client.account.*' / 'client.billing.*')`) and every gate is
// `isConnected` — never the client object. At a framework root the request
// resolves in-process against the real client; in a socketless webview
// realm it rides the bridge to the root broker. Identity falls back from
// ShellIdentityContext (cloud Shell) to the realm's mirrored account info,
// and the workspace manifest is optional, so the SAME component renders in
// the cloud overlay and in a VS Code page webview unchanged.
// =============================================================================

import React, { useState, useEffect, useCallback, CSSProperties } from 'react';
import AccountView from '../modules/account/AccountView';
import type { IDataGridPageRequest } from '../components/data-grid/DataGrid';
import type { ConnectResult, AccountSection, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, ProfileUpdate, BillingDetail, CreditBalance, TransactionsResult, UsageRollup } from 'rocketride';
import { useShellConnection } from '../connection/ConnectionContext';
import { useAuthUser, useLogout } from '../hooks/useAuthUser';
import { ConnectionManager } from '../connection/connection';
import { useOptionalWorkspace } from '../components/workspace/WorkspaceContext';

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
// BUS FACADE
// =============================================================================

/** Typed request against the brokered client surface — works in any realm. */
const req = <T,>(op: string, params?: unknown): Promise<T> => ConnectionManager.getInstance().request(op, params ?? {}) as Promise<T>;

// =============================================================================
// COMPONENT
// =============================================================================

/** Optional host wiring. */
export interface IAccountProviderProps {
	/** Starts a subscription flow (e.g. emit shell:subscribe toward a mounted
	 *  CheckoutFlow). Absent = no subscribe CTA, matching prior behavior. */
	onSubscribe?: () => void;
}

/**
 * AccountView wrapper for any framework realm.
 *
 * Fetches account data via brokered `client.account.*` / `client.billing.*`
 * bus ops and delegates all rendering to the shared AccountView. Listens for
 * `shell:accountUpdate` events to keep the profile in sync with
 * server-pushed updates (socket-fed at a root; mirror-fed in a spoke realm).
 */
const AccountProvider: React.FC<IAccountProviderProps> = ({ onSubscribe }) => {
	const { isConnected } = useShellConnection();
	const ctxUser = useAuthUser();
	const logout = useLogout();
	const appManifest = useOptionalWorkspace()?.appManifest ?? [];

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

	// Identity: the cloud Shell injects it via context; a page realm has no
	// Shell in its tree, so fall back to the mirrored/cached account info.
	const [mirrorUser, setMirrorUser] = useState<ConnectResult | null>(() => ConnectionManager.getInstance().getAccountInfo() ?? null);
	const authUser = ctxUser ?? mirrorUser;

	// ── Billing data ────────────────────────────────────────────────────────
	const [subscriptions, setSubscriptions] = useState<BillingDetail[]>([]);
	const [billingLoading, setBillingLoading] = useState(true);
	const [billingError, setBillingError] = useState<string | null>(null);
	const [creditBalance, setCreditBalance] = useState<CreditBalance | null>((authUser as { credits?: CreditBalance })?.credits ?? null);
	const [allPlans, setAllPlans] = useState<any[]>([]);
	const [transactions, setTransactions] = useState<TransactionsResult | null>(null);
	const [usageByUser, setUsageByUser] = useState<UsageRollup[]>([]);
	const [usageByTeam, setUsageByTeam] = useState<UsageRollup[]>([]);
	const [dashboardLoading, setDashboardLoading] = useState(false);

	// ── Section load error ──────────────────────────────────────────────────
	const [sectionError, setSectionError] = useState<string | null>(null);

	// Keep profile in sync with server-pushed account updates and bump the
	// reload counter to re-fetch the active section
	useEffect(
		() =>
			ConnectionManager.getInstance().on('shell:accountUpdate', (data) => {
				setProfile(data);
				setMirrorUser(data);
				setReloadCounter((n) => n + 1);
			}),
		[]
	);

	// Bumped by shell:accountUpdate — added to section-load effect deps so
	// the currently visible section re-fetches its data (teams, members, etc.)
	const [reloadCounter, setReloadCounter] = useState(0);

	// ── Data loaders ────────────────────────────────────────────────────────

	/** Derives the orgId from the auth user's organization. */
	const orgId = authUser?.organization?.id ?? '';

	/** Extracts a human-readable message from a thrown value. */
	const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

	/** Fetches the current user's profile from the server. */
	const loadProfile = useCallback(async () => {
		if (!isConnected) return;
		try {
			const body = await req<ConnectResult>('client.account.getProfile');
			setProfile(body);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [isConnected]);

	/** Fetches the list of API keys owned by the current user. */
	const loadKeys = useCallback(async () => {
		if (!isConnected) return;
		try {
			const keys = await req<ApiKeyRecord[]>('client.account.listKeys');
			setKeys(keys);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [isConnected]);

	/** Fetches the organization detail. */
	const loadOrg = useCallback(async () => {
		if (!isConnected || !orgId) return;
		try {
			const body = await req<OrgDetail>('client.account.getOrg', { orgId });
			setOrg(body);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [isConnected, orgId]);

	/** Fetches the flat list of organization members. */
	const loadMembers = useCallback(async () => {
		if (!isConnected || !orgId) return;
		try {
			const members = await req<MemberRecord[]>('client.account.listMembers', { orgId });
			setMembers(members);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [isConnected, orgId]);

	/** Fetches the flat list of teams in the organization. */
	const loadTeams = useCallback(async () => {
		if (!isConnected || !orgId) return;
		try {
			const teams = await req<TeamRecord[]>('client.account.listTeams', { orgId });
			setTeams(teams);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [isConnected, orgId]);

	/**
	 * Fetches full detail (including member list) for a specific team.
	 * @param teamId - The unique identifier of the team to load.
	 */
	const loadTeamDetail = useCallback(
		async (teamId: string) => {
			if (!isConnected || !orgId) return;
			try {
				const body = await req<TeamDetail>('client.account.getTeamDetail', { orgId, teamId });
				setTeamDetail(body);
			} catch (e) {
				setSectionError(errMsg(e));
			}
		},
		[isConnected, orgId]
	);

	// ── Load billing data ───────────────────────────────────────────────────

	/** Fetches all billing data in one shot: subscriptions, balance, plans, transactions, usage. */
	const loadBilling = useCallback(async () => {
		if (!isConnected || !orgId) {
			setBillingLoading(false);
			return;
		}
		setBillingError(null);
		try {
			const [subs, balance, plans, tx, byUser, byTeam] = await Promise.all([
				req<BillingDetail[]>('client.billing.getDetails', { orgId }).catch((err: any) => {
					setBillingError(err.message ?? 'Failed to load subscriptions');
					return [] as BillingDetail[];
				}),
				req<CreditBalance | null>('client.billing.getCreditBalance', { orgId }).catch(() => null),
				req<any[]>('client.billing.getProductPrices', { appId: 'rocketride.pipeBuilder' }).catch(() => []),
				req<TransactionsResult | null>('client.billing.getTransactions', { orgId, options: { page: 1, pageSize: 20 } }).catch(() => null),
				req<UsageRollup[]>('client.billing.getUsageByUser', { orgId }).catch(() => [] as UsageRollup[]),
				req<UsageRollup[]>('client.billing.getUsageByTeam', { orgId }).catch(() => [] as UsageRollup[]),
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
	}, [isConnected, orgId]);

	/** Fetches just the transactions page (legacy pagination callback). */
	const handleTransactionPage = useCallback(
		async (page: number) => {
			if (!isConnected || !orgId) return;
			const tx = await req<TransactionsResult | null>('client.billing.getTransactions', { orgId, options: { page, pageSize: 20 } }).catch(() => null);
			if (tx) {
				setTransactions(tx);
			}
		},
		[isConnected, orgId]
	);

	/**
	 * Direct ledger query for the transaction log grid: the grid's full
	 * list-convention request — page, size, sorters, header-filter values,
	 * search — forwards to the server verbatim, so filtering / sorting /
	 * search work against the WHOLE ledger, not just the loaded page. A
	 * failure resolves null and the grid keeps its prior rows.
	 */
	const fetchTransactions = useCallback(
		async (reqst: IDataGridPageRequest): Promise<TransactionsResult | null> => {
			if (!isConnected || !orgId) return null;
			return req<TransactionsResult>('client.billing.getTransactions', {
				orgId,
				options: {
					page: reqst.page,
					pageSize: reqst.size,
					sort: reqst.sort,
					filters: reqst.filters,
					search: reqst.search,
				},
			}).catch(() => null);
		},
		[isConnected, orgId]
	);

	/**
	 * Org-scoped distinct ledger values for the transaction grid's enum
	 * checklists (Type / Resource). A failure surfaces as an empty checklist.
	 */
	const fetchTransactionDistinct = useCallback(
		async (field: string): Promise<(string | number | boolean)[]> => {
			if (!isConnected || !orgId) return [];
			return req<(string | number | boolean)[]>('client.billing.getTransactionDistinct', { orgId, field }).catch(() => []);
		},
		[isConnected, orgId]
	);

	/** Purchase a top-up pack by charging the card on file. */
	const handlePurchaseTopup = useCallback(
		async (plan: any) => {
			if (!isConnected || !orgId) throw new Error('Not connected');
			const result = await req<{ status: string; clientSecret?: string }>('client.billing.purchaseTopup', { orgId, priceId: plan.stripePriceId });
			if (result.status === 'succeeded') {
				// Re-fetch billing data to reflect the new balance
				loadBilling();
			}
			return result;
		},
		[isConnected, orgId, loadBilling]
	);

	/** Upgrade or downgrade an existing subscription to a new plan. */
	const handleUpgradeSubscription = useCallback(
		async (appId: string, newPriceId: string) => {
			if (!isConnected || !orgId) throw new Error('Not connected');
			await req('client.billing.upgradeSubscription', { orgId, appId, newPriceId });
			// Re-fetch billing data to reflect the updated subscription
			loadBilling();
		},
		[isConnected, orgId, loadBilling]
	);

	// ── Load ALL data upfront on connect (badges, counts, billing) ──────────
	useEffect(() => {
		if (!isConnected) return;
		loadProfile();
		loadKeys();
		loadOrg();
		loadMembers();
		loadTeams();
		loadBilling();
	}, [isConnected, orgId]);

	// ── Subscribe to billing events when billing tab is active ──────────────
	useEffect(() => {
		if (!isConnected || section !== 'billing') return;
		// Subscribe to billing ledger events via the wildcard monitor (the
		// root broker refcounts across realms; only edges reach the engine).
		req('client.addMonitor', { key: { token: '*' }, types: ['billing'] }).catch(() => {});
		// Listen for billing update events via ConnectionManager and re-fetch
		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: any) => {
			if (event?.event === 'apaext_billing_update') {
				loadBilling();
			}
		});
		return () => {
			req('client.removeMonitor', { key: { token: '*' }, types: ['billing'] }).catch(() => {});
			unsub();
		};
	}, [section, isConnected]);

	// ── Reload current section on refresh signal ─────────────────────────────
	useEffect(() => {
		if (!reloadCounter || !isConnected) return;
		setSectionError(null);
		if (section === 'profile') loadProfile();
		else if (section === 'billing') loadBilling();
		else if (section === 'api-keys') {
			loadProfile();
			loadKeys();
		} else if (section === 'organization') loadOrg();
		else if (section === 'members') {
			loadOrg();
			loadMembers();
		} else if (section === 'teams') {
			loadOrg();
			loadTeams();
		}
	}, [reloadCounter]);

	// ── Load team detail when a team is selected or data changes ────────────
	useEffect(() => {
		if (!activeTeamId || !isConnected) return;
		loadTeamDetail(activeTeamId);
		loadMembers();
	}, [activeTeamId, isConnected, reloadCounter]);

	// ── Callbacks ────────────────────────────────────────────────────────────

	/** Persists updated profile fields. */
	const handleSaveProfile = useCallback(
		async (fields: ProfileUpdate) => {
			if (!isConnected) return;
			await req('client.account.updateProfile', { fields });
			// Server pushes an updated ConnectResult via shell:accountUpdate
		},
		[isConnected]
	);

	/** Sets the user's dev team (dev-run billing + env layer). */
	const handleSetDevTeam = useCallback(
		async (teamId: string) => {
			if (!isConnected) return;
			await req('client.account.setDevTeam', { teamId });
		},
		[isConnected]
	);

	/** Switches the user's active organization. */
	const handleSetDefaultOrg = useCallback(
		async (orgId: string) => {
			if (!isConnected) return;
			await req('client.account.setDefaultOrg', { orgId });
		},
		[isConnected]
	);

	/** Deletes the user account. */
	const handleDeleteAccount = useCallback(async () => {
		if (!isConnected) return;
		await req('client.account.deleteAccount');
	}, [isConnected]);

	/** Persists an updated organization name. */
	const handleSaveOrgName = useCallback(
		async (name: string) => {
			if (!isConnected || !orgId) return;
			await req('client.account.updateOrgName', { orgId, name });
			// Optimistically update the in-memory org record
			setOrg((c) => (c ? { ...c, name } : c));
		},
		[isConnected, orgId]
	);

	/** Creates a new API key and returns the raw key string. */
	const handleCreateKey = useCallback(
		async (params: { name: string; permissions: string[]; expiresAt?: string; teamId?: string }) => {
			if (!isConnected) throw new Error('Not connected');
			// Forward the full params (incl. teamId) so a team-scoped key is created
			// team-scoped rather than silently falling back to org-wide.
			const { key } = await req<{ key: string }>('client.account.createKey', { params });
			await loadKeys();
			return { key };
		},
		[isConnected, loadKeys]
	);

	/** Revokes an API key by ID. */
	const handleRevokeKey = useCallback(
		async (keyId: string) => {
			if (!isConnected) return;
			await req('client.account.revokeKey', { keyId });
			await loadKeys();
		},
		[isConnected, loadKeys]
	);

	/** Sends an invitation to a new organization member. */
	const handleInviteMember = useCallback(
		async (params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> }) => {
			if (!isConnected || !orgId) return;
			await req('client.account.inviteMember', { orgId, params });
			await loadMembers();
		},
		[isConnected, orgId, loadMembers]
	);

	/** Updates an organization member's role. */
	const handleUpdateMemberRole = useCallback(
		async (userId: string, role: string) => {
			if (!isConnected || !orgId) return;
			await req('client.account.updateMemberRole', { orgId, userId, role });
			await loadMembers();
		},
		[isConnected, orgId, loadMembers]
	);

	/** Removes an organization member. */
	const handleRemoveMember = useCallback(
		async (userId: string) => {
			if (!isConnected || !orgId) return;
			await req('client.account.removeMember', { orgId, userId });
			await loadMembers();
		},
		[isConnected, orgId, loadMembers]
	);

	/** Resends the initialization email for a pending member. */
	const handleResendInvite = useCallback(
		async (userId: string) => {
			if (!isConnected || !orgId) return;
			await req('client.account.resendInvite', { orgId, userId });
		},
		[isConnected, orgId]
	);

	/** Creates a new team. */
	const handleCreateTeam = useCallback(
		async (name: string) => {
			if (!isConnected || !orgId) return;
			await req('client.account.createTeam', { orgId, name });
			await loadTeams();
		},
		[isConnected, orgId, loadTeams]
	);

	/** Deletes a team. */
	const handleDeleteTeam = useCallback(
		async (teamId: string) => {
			if (!isConnected || !orgId) return;
			await req('client.account.deleteTeam', { orgId, teamId });
			setActiveTeamId(null);
			await loadTeams();
		},
		[isConnected, orgId, loadTeams]
	);

	/** Adds a member to a team with specified permissions. */
	const handleAddTeamMember = useCallback(
		async (params: { teamId: string; userId: string; permissions: string[] }) => {
			if (!isConnected || !orgId) return;
			await req('client.account.addTeamMember', { orgId, params });
			await loadTeamDetail(params.teamId);
		},
		[isConnected, orgId, loadTeamDetail]
	);

	/** Updates a team member's permissions. */
	const handleEditTeamMemberPerms = useCallback(
		async (params: { teamId: string; userId: string; permissions: string[] }) => {
			if (!isConnected || !orgId) return;
			await req('client.account.updateTeamMemberPerms', { orgId, params });
			await loadTeamDetail(params.teamId);
		},
		[isConnected, orgId, loadTeamDetail]
	);

	/** Removes a member from a team. */
	const handleRemoveTeamMember = useCallback(
		async (params: { teamId: string; userId: string }) => {
			if (!isConnected || !orgId) return;
			await req('client.account.removeTeamMember', { orgId, params });
			await loadTeamDetail(params.teamId);
		},
		[isConnected, orgId, loadTeamDetail]
	);

	/** Requests loading of full detail for a specific team. */
	const handleLoadTeamDetail = useCallback(
		(teamId: string) => {
			loadTeamDetail(teamId);
			loadMembers();
		},
		[loadTeamDetail, loadMembers]
	);

	// ── Billing callbacks ────────────────────────────────────────────────────

	/**
	 * Cancels a subscription and re-fetches the updated list.
	 * @param appId - The app whose subscription to cancel.
	 */
	const handleCancelSubscription = useCallback(
		async (appId: string) => {
			if (!isConnected || !orgId) return;
			await req('client.billing.cancelSubscription', { orgId, appId });
			const updated = await req<BillingDetail[]>('client.billing.getDetails', { orgId });
			setSubscriptions(updated);
		},
		[isConnected, orgId]
	);

	/** Opens the Stripe customer portal for payment method management.
	 *  The return URL is HOST POLICY (the broker fills it in), and the open
	 *  itself is a host op — a webview realm cannot reach the real browser. */
	const handleOpenPortal = useCallback(async () => {
		if (!isConnected || !orgId) return;
		const { url } = await req<{ url: string }>('client.billing.createPortalSession', { orgId });
		await req('host.openExternal', { url });
	}, [isConnected, orgId]);

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
				onSubscribe={onSubscribe}
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
				fetchTransactions={fetchTransactions}
				fetchTransactionDistinct={fetchTransactionDistinct}
				section={section}
				onSectionChange={setSection}
				activeTeamId={activeTeamId}
				onActiveTeamIdChange={setActiveTeamId}
				onSaveProfile={handleSaveProfile}
				onSetDevTeam={handleSetDevTeam}
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
			/>
		</div>
	);
};

export default AccountProvider;
