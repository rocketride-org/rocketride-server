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
// REALM-AGNOSTIC BY CONSTRUCTION: every engine call goes through the
// realm's own RocketRideClient (`client.account.*` / `client.billing.*`).
// At a framework root that is the real client; in a socketless webview
// realm it is the realm client, whose requests ride the bridge to the
// root's socket. Identity falls back from ShellIdentityContext (cloud
// Shell) to the realm's mirrored account info, and the workspace manifest
// is optional, so the SAME component renders in the cloud overlay and in a
// VS Code page webview unchanged.
// =============================================================================

import React, { useState, useEffect, useCallback, useRef, CSSProperties } from 'react';
import AccountView from '../modules/account/AccountView';
import { parsePlanChangeOutcome, parsePlanChangePreview } from '../modules/billing/components/planChange';
import type { IDataGridPageRequest } from '../components/data-grid/DataGrid';
import type { ConnectResult, AccountSection, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, ProfileUpdate, BillingDetail, CreditBalance, TransactionsResult, UsageRollup } from 'rocketride';
import { useShellConnection } from '../connection/ConnectionContext';
import { useAuthUser, useLogout } from '../hooks/useAuthUser';
import { canManageOrganizationBilling, ConnectionManager, getAccountTransition } from '../connection/connection';
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
// COMPONENT
// =============================================================================

/** Optional host wiring. */
export interface IAccountProviderProps {
	/** Starts a subscription flow (e.g. emit shell:subscribe toward a mounted
	 *  CheckoutFlow). Absent = no subscribe CTA, matching prior behavior. */
	onSubscribe?: () => void;
	/** Render ONE collapsed pane (the Settings page's Account group) instead
	 *  of the classic 6-tab view, and load only that pane's data. */
	embeddedSection?: 'profile' | 'billing' | 'api-keys';
	/** Settings-nav navigation for embedded cross-links (workspace chip). */
	onNavigateSection?: (sectionId: string) => void;
	/** Pre-switch guard: a false return aborts a workspace switch (the
	 *  Settings page uses it so a dirty draft is never saved into the wrong
	 *  workspace — confirm-and-discard before the switch commits). */
	confirmWorkspaceSwitch?: () => boolean;
}

/**
 * AccountView wrapper for any framework realm.
 *
 * Fetches account data via brokered `client.account.*` / `client.billing.*`
 * bus ops and delegates all rendering to the shared AccountView. Listens for
 * `shell:accountUpdate` events to keep the profile in sync with
 * server-pushed updates (socket-fed at a root; mirror-fed in a spoke realm).
 */
const AccountProvider: React.FC<IAccountProviderProps> = ({ onSubscribe, embeddedSection, onNavigateSection, confirmWorkspaceSwitch }) => {
	// The realm's own client — null until connected AND (off-root) mirrored.
	const { client: shellClient, isConnected } = useShellConnection();
	const client = isConnected ? shellClient : null;
	const ctxUser = useAuthUser();
	const logout = useLogout();
	const appManifest = useOptionalWorkspace()?.appManifest ?? [];

	// ── Navigation state ────────────────────────────────────────────────────
	// Embedded mode pins the section (the Settings nav owns navigation), which
	// also keys the per-section refresh map and the billing event monitor.
	const [section, setSection] = useState<AccountSection>(embeddedSection ?? 'profile');
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
	type BillingScope = { client: NonNullable<typeof client>; orgId: string; userId: string };
	const [subscriptionSnapshot, setSubscriptionSnapshot] = useState<(BillingScope & {
		rows: BillingDetail[];
		error: string | null;
	}) | null>(null);
	const [dashboardSnapshot, setDashboardSnapshot] = useState<(BillingScope & {
		balance: CreditBalance | null;
		transactions: TransactionsResult | null;
		usageByUser: UsageRollup[];
		usageByTeam: UsageRollup[];
	}) | null>(null);
	const billingLoadSequence = useRef(0);
	const subscriptionLoadSequence = useRef(0);
	const [allPlans, setAllPlans] = useState<any[]>([]);

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
	const userId = authUser?.userId ?? '';
	const subscriptions = subscriptionSnapshot?.client === client && subscriptionSnapshot.orgId === orgId &&
		subscriptionSnapshot.userId === userId ? subscriptionSnapshot : null;
	const dashboard = dashboardSnapshot?.client === client && dashboardSnapshot.orgId === orgId &&
		dashboardSnapshot.userId === userId ? dashboardSnapshot : null;

	/** Extracts a human-readable message from a thrown value. */
	const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

	/**
	 * Fetches the current user's profile from the server. Resolves true on
	 * success; a failure is surfaced as sectionError and resolves false so a
	 * caller that depends on the refresh (e.g. leaving an org) can tell.
	 * Only the most recent request may update state: an older response that
	 * lands after a newer one (e.g. a refresh started before a leave) is
	 * dropped so it cannot restore a membership that no longer exists.
	 */
	const profileRequestSeq = useRef(0);
	const loadProfile = useCallback(async (): Promise<boolean> => {
		if (!client) return false;
		const seq = ++profileRequestSeq.current;
		try {
			const body = await client.account.getProfile();
			if (seq !== profileRequestSeq.current) return true;
			setProfile(body);
			return true;
		} catch (e) {
			if (seq !== profileRequestSeq.current) return false;
			setSectionError(errMsg(e));
			return false;
		}
	}, [client]);

	/** Fetches the list of API keys owned by the current user. */
	const loadKeys = useCallback(async () => {
		if (!client) return;
		try {
			const keys = await client.account.listKeys();
			setKeys(keys);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [client]);

	/** Fetches the organization detail. */
	const loadOrg = useCallback(async () => {
		if (!client || !orgId) return;
		try {
			const body = await client.account.getOrg(orgId);
			setOrg(body);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [client, orgId]);

	/** Fetches the flat list of organization members. */
	const loadMembers = useCallback(async () => {
		if (!client || !orgId) return;
		try {
			const members = await client.account.listMembers(orgId);
			setMembers(members);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [client, orgId]);

	/** Fetches the flat list of teams in the organization. */
	const loadTeams = useCallback(async () => {
		if (!client || !orgId) return;
		try {
			const teams = await client.account.listTeams(orgId);
			setTeams(teams);
		} catch (e) {
			setSectionError(errMsg(e));
		}
	}, [client, orgId]);

	/**
	 * Fetches full detail (including member list) for a specific team.
	 * @param teamId - The unique identifier of the team to load.
	 */
	const loadTeamDetail = useCallback(
		async (teamId: string) => {
			if (!client || !orgId) return;
			try {
				const body = await client.account.getTeamDetail(orgId, teamId);
				setTeamDetail(body);
			} catch (e) {
				setSectionError(errMsg(e));
			}
		},
		[client, orgId]
	);

	// ── Load billing data ───────────────────────────────────────────────────

	const isCurrentBillingScope = useCallback(() => {
		const manager = ConnectionManager.getInstance();
		const account = manager.getAccountInfo();
		const transition = getAccountTransition(manager);
		return !transition.changingWorkspace && !transition.disconnecting &&
			manager.getClient() === client && account?.organization?.id === orgId && account.userId === userId;
	}, [client, orgId, userId]);

	/** Fetches all billing data in one shot: subscriptions, balance, plans, transactions, usage. */
	const loadBilling = useCallback(async () => {
		if (!client || !orgId || !isCurrentBillingScope()) return;
		const sequence = ++billingLoadSequence.current;
		const subscriptionSequence = ++subscriptionLoadSequence.current;
		const isCurrentLoad = () => sequence === billingLoadSequence.current && isCurrentBillingScope();
		const publishSubscriptions = (rows: BillingDetail[], error: string | null) => {
			if (subscriptionSequence === subscriptionLoadSequence.current && isCurrentLoad()) {
				setSubscriptionSnapshot({ client, orgId, userId, rows, error });
			}
		};
		const [, , balance, transactions, usageByUser, usageByTeam] = await Promise.all([
			client.billing.getDetails(orgId).then(
				(rows) => publishSubscriptions(rows, null),
				(error: unknown) => publishSubscriptions([], errMsg(error) || 'Failed to load subscriptions'),
			),
			client.billing.getProductPrices('rocketride.pipeBuilder').catch(() => []).then((plans) => {
				if (isCurrentLoad()) setAllPlans(plans);
			}),
			client.billing.getCreditBalance(orgId).catch(() => null),
			client.billing.getTransactions(orgId, { page: 1, pageSize: 20 }).catch(() => null),
			client.billing.getUsageByUser(orgId).catch(() => [] as UsageRollup[]),
			client.billing.getUsageByTeam(orgId).catch(() => [] as UsageRollup[]),
		]);
		if (!isCurrentLoad()) return;
		setDashboardSnapshot({ client, orgId, userId, balance, transactions, usageByUser, usageByTeam });
	}, [client, orgId, userId, isCurrentBillingScope]);

	/** Fetches just the transactions page (legacy pagination callback). */
	const handleTransactionPage = useCallback(
		async (page: number) => {
			if (!client || !orgId) return;
			const tx = await client.billing.getTransactions(orgId, { page, pageSize: 20 }).catch(() => null);
			if (tx && isCurrentBillingScope()) {
				setDashboardSnapshot((current) => current?.client === client && current.orgId === orgId && current.userId === userId
					? { ...current, transactions: tx }
					: current);
			}
		},
		[client, orgId, userId, isCurrentBillingScope]
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
			if (!client || !orgId) return null;
			return client.billing.getTransactions(orgId, {
				page: reqst.page,
				pageSize: reqst.size,
				sort: reqst.sort,
				filters: reqst.filters,
				search: reqst.search,
			}).catch(() => null);
		},
		[client, orgId]
	);

	/**
	 * Org-scoped distinct ledger values for the transaction grid's enum
	 * checklists (Type / Resource). A failure surfaces as an empty checklist.
	 */
	const fetchTransactionDistinct = useCallback(
		async (field: string): Promise<(string | number | boolean)[]> => {
			if (!client || !orgId) return [];
			return client.billing.getTransactionDistinct(orgId, field).catch(() => []);
		},
		[client, orgId]
	);

	/** Purchase a top-up pack by charging the card on file. */
	const handlePurchaseTopup = useCallback(
		async (plan: any) => {
			if (!client || !orgId) throw new Error('Not connected');
			const result = await client.billing.purchaseTopup(orgId, plan.stripePriceId);
			if (result.status === 'succeeded') {
				// Re-fetch billing data to reflect the new balance
				loadBilling();
			}
			return result;
		},
		[client, orgId, loadBilling]
	);

	const requirePlanChangeClient = useCallback(() => {
		const manager = ConnectionManager.getInstance();
		if (!client || !orgId || !manager.isConnected()) throw new Error('Not connected');
		if (!isCurrentBillingScope()) {
			throw new Error('The active organization or connection changed. Reopen the plan change.');
		}
		if (!canManageOrganizationBilling(manager.getAccountInfo())) {
			throw new Error('Workspace admin permission is required to change plans.');
		}
		return client;
	}, [client, orgId, isCurrentBillingScope]);

	const handlePreviewSubscriptionChange = useCallback(
		async (appId: string, newPriceId: string, expectedPriceId: string) => {
			const billingClient = requirePlanChangeClient();
			try {
				const preview = await billingClient.call<unknown>('rrext_account_billing', {
					subcommand: 'preview_upgrade', orgId, appId, newPriceId, expectedPriceId,
				});
				requirePlanChangeClient();
				return parsePlanChangePreview(preview);
			} catch (error) {
				requirePlanChangeClient();
				// Older servers can still apply plan changes. Only the explicit
				// unsupported-command response can fall back to a neutral dialog.
				if (error instanceof Error && error.message === "Unknown billing subcommand: 'preview_upgrade'") return null;
				throw error;
			}
		},
		[requirePlanChangeClient, orgId]
	);

	const handleUpgradeSubscription = useCallback(
		async (appId: string, newPriceId: string, attemptId?: string, expectedPriceId?: string) => {
			const manager = ConnectionManager.getInstance();
			const transition = getAccountTransition(manager);
			const response = await requirePlanChangeClient().call<unknown>('rrext_account_billing', {
				subcommand: 'upgrade',
				orgId,
				appId,
				newPriceId,
				...(attemptId ? { attemptId } : {}),
				...(expectedPriceId ? { expectedPriceId } : {}),
			});
			requirePlanChangeClient();
			const result = parsePlanChangeOutcome(response);
			if (result.status === 'requires_action') {
				return {
					...result,
					assertPaymentScope: () => {
						requirePlanChangeClient();
						if (transition !== getAccountTransition(manager)) {
							throw new Error('The billing connection changed. Try the plan change again.');
						}
					},
				};
			}
			if (result.status === 'upgraded' || result.status === 'applied' || result.status === 'scheduled' ||
				result.status === 'downgrade_scheduled' || result.status === 'unchanged') {
				loadBilling();
			}
			return result;
		},
		[requirePlanChangeClient, orgId, loadBilling]
	);

	// ── Load data upfront on connect ─────────────────────────────────────────
	// Classic view loads EVERYTHING (tab badges need the counts); an embedded
	// pane has no badges, so it loads only what it renders.
	useEffect(() => {
		if (!client) return;
		if (embeddedSection === 'profile') {
			loadProfile();
			loadOrg();
			loadMembers();
			loadTeams();
			return;
		}
		if (embeddedSection === 'billing') {
			loadProfile();
			loadBilling();
			return;
		}
		if (embeddedSection === 'api-keys') {
			loadProfile();
			loadKeys();
			loadTeams();
			return;
		}
		loadProfile();
		loadKeys();
		loadOrg();
		loadMembers();
		loadTeams();
		loadBilling();
	}, [client, orgId, userId, embeddedSection]);

	// ── Subscribe to billing events when billing tab is active ──────────────
	useEffect(() => {
		if (!client || section !== 'billing') return;
		// Subscribe to billing ledger events via the wildcard monitor (the
		// realm client forwards monitors to the root broker, which refcounts
		// across realms; only edges reach the engine).
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
	}, [section, client, loadBilling]);

	// ── Reload current section on refresh signal ─────────────────────────────
	useEffect(() => {
		if (!reloadCounter || !client) return;
		setSectionError(null);
		if (section === 'profile') {
			loadProfile();
			// The embedded Profile pane renders org, member, and team data
			// too (see the upfront loader) — keep them fresh as well.
			if (embeddedSection === 'profile') {
				loadOrg();
				loadMembers();
				loadTeams();
			}
		} else if (section === 'billing') loadBilling();
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
		if (!activeTeamId || !client) return;
		loadTeamDetail(activeTeamId);
		loadMembers();
	}, [activeTeamId, client, reloadCounter]);

	// ── Callbacks ────────────────────────────────────────────────────────────

	/** Persists updated profile fields. */
	const handleSaveProfile = useCallback(
		async (fields: ProfileUpdate) => {
			if (!client) return;
			await client.account.updateProfile(fields);
			// Server pushes an updated ConnectResult via shell:accountUpdate
		},
		[client]
	);

	/** Sets the user's dev team (dev-run billing + env layer). */
	const handleSetDevTeam = useCallback(
		async (teamId: string) => {
			if (!client) return;
			await client.account.setDevTeam(teamId);
		},
		[client]
	);

	/** Switches the user's active organization. The guard runs FIRST — a
	 *  dirty settings draft must be confirmed-and-discarded before the switch
	 *  commits (a workspace-A draft must never save into workspace B). */
	const handleSetDefaultOrg = useCallback(
		async (orgId: string) => {
			if (!client) return;
			if (confirmWorkspaceSwitch && !confirmWorkspaceSwitch()) return;
			// The switch started HERE (the Profile picker), so after the rescope
			// the shell should land back on the Profile section — in
			// sessionStorage (not state) because the rescope remounts this whole
			// tree, and its reload FALLBACK replaces the page outright. A
			// push-initiated switch from another tab sets no flag and lands on
			// the workbench as before. Key literal = OverlayManager's
			// WORKSPACE_SWITCH_LAND_KEY (importing it would cycle:
			// OverlayManager → SettingsProvider → AccountProvider).
			try { window.sessionStorage.setItem('rr:workspace-switch-land', '1'); } catch { /* storage unavailable — land on the workbench */ }
			try {
				await client.account.setDefaultOrg(orgId);
			} catch (err) {
				// A failed switch must not leave the landing flag armed — the
				// next unrelated mount would open Settings at Profile.
				try { window.sessionStorage.removeItem('rr:workspace-switch-land'); } catch { /* ignore */ }
				throw err;
			}
		},
		[client, confirmWorkspaceSwitch]
	);

	/** Renames ANY workspace the user administers (manage-workspaces drawer).
	 *  Re-fetches the profile so the memberships list reflects the new name. */
	const handleRenameWorkspace = useCallback(
		async (targetOrgId: string, name: string) => {
			if (!client) return;
			await client.account.updateOrgName(targetOrgId, name);
			if (targetOrgId === orgId) setOrg((c) => (c ? { ...c, name } : c));
			await loadProfile();
		},
		[client, orgId, loadProfile]
	);

	/** Creates a new workspace. The server makes the caller its admin, switches
	 *  their default org, and pushes `apaext_org_changed` — the shell's rescope
	 *  path takes over from there, so the only client work is the landing flag
	 *  (the switch started here, so land back on Profile). */
	const handleCreateWorkspace = useCallback(
		async (name: string) => {
			if (!client) return;
			// Same literal as OverlayManager's WORKSPACE_SWITCH_LAND_KEY (an
			// import would cycle; see handleSetDefaultOrg).
			try { window.sessionStorage.setItem('rr:workspace-switch-land', '1'); } catch { /* storage unavailable — land on the workbench */ }
			try {
				await client.account.createOrg(name);
			} catch (err) {
				// The switch never happened — don't leave a stale landing flag
				// to hijack the NEXT unrelated mount of the settings overlay.
				try { window.sessionStorage.removeItem('rr:workspace-switch-land'); } catch { /* ignore */ }
				throw err;
			}
		},
		[client]
	);

	/** Leaves a workspace. Leaving the CURRENT one makes the server re-point
	 *  the default and push `apaext_org_changed` (the rescope takes over);
	 *  leaving another just needs the memberships list re-read. The leave has
	 *  already succeeded by then: a failed re-read is reported as such, never
	 *  as a failed leave. */
	const handleLeaveWorkspace = useCallback(
		async (targetOrgId: string) => {
			if (!client) return;
			const leavingCurrent = targetOrgId === authUser?.organization?.id;
			if (leavingCurrent) {
				try { window.sessionStorage.setItem('rr:workspace-switch-land', '1'); } catch { /* storage unavailable */ }
			}
			try {
				await client.account.leaveOrg(targetOrgId);
			} catch (err) {
				if (leavingCurrent) {
					try { window.sessionStorage.removeItem('rr:workspace-switch-land'); } catch { /* ignore */ }
				}
				throw err;
			}
			if (!leavingCurrent && !(await loadProfile())) {
				throw new Error('You left the workspace, but the workspace list could not be refreshed. Reload the page.');
			}
		},
		[client, authUser, loadProfile]
	);

	/** Dry-run for the delete confirm dialog: member count + billing blocker. */
	const handleDeleteWorkspacePrecheck = useCallback(
		async (targetOrgId: string) => {
			if (!client) throw new Error('Not connected');
			return client.account.deleteOrgPrecheck(targetOrgId);
		},
		[client]
	);

	/** Deletes a workspace (admin-gated, destroys its data for all members).
	 *  Same landing split as leave: current org → rescope path; another org →
	 *  memberships re-read. */
	const handleDeleteWorkspace = useCallback(
		async (targetOrgId: string) => {
			if (!client) return;
			const deletingCurrent = targetOrgId === authUser?.organization?.id;
			if (deletingCurrent) {
				try { window.sessionStorage.setItem('rr:workspace-switch-land', '1'); } catch { /* storage unavailable */ }
			}
			try {
				await client.account.deleteOrg(targetOrgId);
			} catch (err) {
				if (deletingCurrent) {
					try { window.sessionStorage.removeItem('rr:workspace-switch-land'); } catch { /* ignore */ }
				}
				throw err;
			}
			if (!deletingCurrent) await loadProfile();
		},
		[client, authUser, loadProfile]
	);

	/** Deletes the user account. */
	const handleDeleteAccount = useCallback(async () => {
		if (!client) return;
		await client.account.deleteAccount();
	}, [client]);

	/** Persists an updated organization name. */
	const handleSaveOrgName = useCallback(
		async (name: string) => {
			if (!client || !orgId) return;
			await client.account.updateOrgName(orgId, name);
			// Optimistically update the in-memory org record
			setOrg((c) => (c ? { ...c, name } : c));
		},
		[client, orgId]
	);

	/** Creates a new API key and returns the raw key string. */
	const handleCreateKey = useCallback(
		async (params: { name: string; permissions: string[]; expiresAt?: string; teamId?: string }) => {
			if (!client) throw new Error('Not connected');
			// Forward the full params (incl. teamId) so a team-scoped key is created
			// team-scoped rather than silently falling back to org-wide.
			const { key } = await client.account.createKey(params);
			await loadKeys();
			return { key };
		},
		[client, loadKeys]
	);

	/** Revokes an API key by ID. */
	const handleRevokeKey = useCallback(
		async (keyId: string) => {
			if (!client) return;
			await client.account.revokeKey(keyId);
			await loadKeys();
		},
		[client, loadKeys]
	);

	/** Sends an invitation to a new organization member. */
	const handleInviteMember = useCallback(
		async (params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> }) => {
			if (!client || !orgId) return;
			await client.account.inviteMember(orgId, params);
			await loadMembers();
		},
		[client, orgId, loadMembers]
	);

	/** Updates an organization member's role. */
	const handleUpdateMemberRole = useCallback(
		async (userId: string, role: string) => {
			if (!client || !orgId) return;
			await client.account.updateMemberRole(orgId, userId, role);
			await loadMembers();
		},
		[client, orgId, loadMembers]
	);

	/** Removes an organization member. */
	const handleRemoveMember = useCallback(
		async (userId: string) => {
			if (!client || !orgId) return;
			await client.account.removeMember(orgId, userId);
			await loadMembers();
		},
		[client, orgId, loadMembers]
	);

	/** Resends the initialization email for a pending member. */
	const handleResendInvite = useCallback(
		async (userId: string) => {
			if (!client || !orgId) return;
			await client.account.resendInvite(orgId, userId);
		},
		[client, orgId]
	);

	/** Creates a new team. */
	const handleCreateTeam = useCallback(
		async (name: string) => {
			if (!client || !orgId) return;
			await client.account.createTeam(orgId, name);
			await loadTeams();
		},
		[client, orgId, loadTeams]
	);

	/** Deletes a team. */
	const handleDeleteTeam = useCallback(
		async (teamId: string) => {
			if (!client || !orgId) return;
			await client.account.deleteTeam(orgId, teamId);
			setActiveTeamId(null);
			await loadTeams();
		},
		[client, orgId, loadTeams]
	);

	/** Adds a member to a team with specified permissions. */
	const handleAddTeamMember = useCallback(
		async (params: { teamId: string; userId: string; permissions: string[] }) => {
			if (!client || !orgId) return;
			await client.account.addTeamMember(orgId, params);
			await loadTeamDetail(params.teamId);
		},
		[client, orgId, loadTeamDetail]
	);

	/** Updates a team member's permissions. */
	const handleEditTeamMemberPerms = useCallback(
		async (params: { teamId: string; userId: string; permissions: string[] }) => {
			if (!client || !orgId) return;
			await client.account.updateTeamMemberPerms(orgId, params);
			await loadTeamDetail(params.teamId);
		},
		[client, orgId, loadTeamDetail]
	);

	/** Removes a member from a team. */
	const handleRemoveTeamMember = useCallback(
		async (params: { teamId: string; userId: string }) => {
			if (!client || !orgId) return;
			await client.account.removeTeamMember(orgId, params);
			await loadTeamDetail(params.teamId);
		},
		[client, orgId, loadTeamDetail]
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
			if (!client || !orgId || !isCurrentBillingScope()) return;
			let sequence: number | undefined;
			try {
				await client.billing.cancelSubscription(orgId, appId);
				if (!isCurrentBillingScope()) return;
				sequence = ++subscriptionLoadSequence.current;
				const updated = await client.billing.getDetails(orgId);
				if (sequence === subscriptionLoadSequence.current && isCurrentBillingScope()) {
					setSubscriptionSnapshot({ client, orgId, userId, rows: updated, error: null });
				}
			} catch (error) {
				if (isCurrentBillingScope() && (sequence === undefined || sequence === subscriptionLoadSequence.current)) throw error;
			}
		},
		[client, orgId, userId, isCurrentBillingScope]
	);

	/** Opens the Stripe customer portal for payment method management.
	 *  The return URL is HOST POLICY (`host.stripeReturnUrl`), and the open
	 *  itself is a host op — a webview realm cannot reach the real browser. */
	const handleOpenPortal = useCallback(async () => {
		if (!client || !orgId) return;
		const cm = ConnectionManager.getInstance();
		const { url: returnUrl } = await cm.request('host.stripeReturnUrl', {}) as { url: string };
		const { url } = await client.billing.createPortalSession(orgId, returnUrl);
		await cm.request('host.openExternal', { url });
	}, [client, orgId]);

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
				subscriptions={subscriptions?.rows ?? []}
				billingLoading={Boolean(client && orgId && !subscriptions)}
				billingError={subscriptions?.error ?? null}
				creditBalance={dashboard ? dashboard.balance : (authUser as { credits?: CreditBalance })?.credits ?? null}
				apps={appManifest}
				onCancelSubscription={handleCancelSubscription}
				onOpenPortal={handleOpenPortal}
				onSubscribe={onSubscribe}
				transactions={dashboard?.transactions ?? null}
				usageByUser={dashboard?.usageByUser ?? []}
				usageByTeam={dashboard?.usageByTeam ?? []}
				activeTasks={[]}
				topupPlans={allPlans.filter((p: any) => p.metadata?.kind === 'topup').map((p: any) => ({ id: p.id, stripePriceId: p.stripePriceId, nickname: p.nickname, amountCents: p.amountCents, metadata: p.metadata }))}
				allPlans={allPlans}
				onPurchaseTopup={handlePurchaseTopup}
				onUpgradeSubscription={subscriptions ? handleUpgradeSubscription : undefined}
				onPreviewSubscriptionChange={subscriptions ? handlePreviewSubscriptionChange : undefined}
				dashboardLoading={Boolean(client && orgId && !dashboard)}
				onTransactionPage={handleTransactionPage}
				fetchTransactions={fetchTransactions}
				fetchTransactionDistinct={fetchTransactionDistinct}
				section={section}
				onSectionChange={setSection}
				activeTeamId={activeTeamId}
				onActiveTeamIdChange={setActiveTeamId}
				{...(embeddedSection !== undefined ? { embeddedSection } : {})}
				{...(onNavigateSection !== undefined ? { onNavigateSection } : {})}
				onRenameWorkspace={handleRenameWorkspace}
				onCreateWorkspace={handleCreateWorkspace}
				onLeaveWorkspace={handleLeaveWorkspace}
				onDeleteWorkspace={handleDeleteWorkspace}
				onDeleteWorkspacePrecheck={handleDeleteWorkspacePrecheck}
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
