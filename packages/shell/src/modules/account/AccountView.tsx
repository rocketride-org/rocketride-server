// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AccountView — account management tabs behind a stock TabControl strip.
 *
 * This is the pure, host-agnostic root component for the Account module.
 * All data is received as props and all server mutations are delegated to
 * async callback props. Internal state is limited to UI concerns: modals,
 * form fields, local errors, and transient feedback.
 *
 * The host application is responsible for:
 *  - fetching data via DAP or any other transport
 *  - wiring auth / logout
 *  - passing the results down as `IAccountViewProps`
 */

import React, { useMemo, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import { TabControl } from '../../components/tab-control/TabControl';
import { ContentHeader } from '../../components/content-header/ContentHeader';
import type { ITabPanelPanel } from '../../components/tab-panel/TabPanel';
import type { ViewMenu } from '../../types/viewMenu';
import type { IDataGridPageRequest } from '../../components/data-grid/DataGrid';
import { commonStyles } from '../../themes/styles';
import type { ConnectResult, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, AccountSection, ProfileUpdate } from './types';
import type { BillingDetail, CreditBalance, TransactionsResult, UsageRollup } from '../billing/types';
import type { ActiveTask } from '../billing/components/BillingDashboard';
import { ProfilePanel } from './components/ProfilePanel';
import { ProfileSection } from './components/ProfileSection';
// EnvScopeCard removed — env management is now in the standalone Environment page
import { BillingPanel } from './components/BillingPanel';
import { ApiKeysPanel } from './components/ApiKeysPanel';
import { OrganizationPanel } from './components/OrganizationPanel';
import { TeamsPanel } from './components/TeamsPanel';
import { MembersPanel } from './components/MembersPanel';

// =============================================================================
// LAYOUT STYLES
// =============================================================================

/** Top-level layout styles for the AccountView root container and overlay elements. */
const styles = {
	/** Full-bleed flex column that fills the shell panel slot. */
	root: {
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
		height: '100%',
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family, Roboto, sans-serif)',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	/**
	 * Fills the space below the top TabControl strip; TabPanel's
	 * 100%-height wrapper resolves against this definite flex box.
	 */
	pageBody: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minWidth: 0,
		minHeight: 0,
	} as CSSProperties,
};

/** Embedded-mode extras: the live workspace chip row on Billing / API Keys. */
const embeddedStyles = {
	/** Embedded pane root: UNLIKE styles.root this must NOT clamp height or
	 *  clip — the Settings page's content pane owns the scroll, so this
	 *  container just grows with its content (the EnvironmentView pattern).
	 *  Deliberately NOT position:relative: the record drawers (`contained`
	 *  DetailPanels) anchor to the nearest positioned ancestor, which must be
	 *  the settings dialog/viewport — not this scrolling pane, or the drawer
	 *  scrolls away with the content. */
	root: {
		width: '100%',
		fontFamily: 'var(--rr-font-family, Roboto, sans-serif)',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	chipRow: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginBottom: 12,
	} as CSSProperties,
	chip: {
		display: 'inline-block',
		padding: '1px 8px',
		borderRadius: 10,
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	chipLink: {
		background: 'none',
		border: 'none',
		padding: 0,
		cursor: 'pointer',
		color: 'var(--rr-text-link)',
		fontSize: 12,
		fontFamily: 'inherit',
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for the AccountView component.
 *
 * All data arrives as props; all server mutations are async callbacks that
 * the host fulfills. AccountView only manages transient UI state internally
 * (modals, form fields, saving flags, local errors).
 */
export interface IAccountViewProps {
	// -- Data ------------------------------------------------------------------
	/** Whether the shell client is connected to the server. */
	isConnected: boolean;
	/** Error message from the last failed data load for the active section, or null. */
	sectionError?: string | null;
	/** The live/editable profile data from the server, or null while loading. */
	profile: ConnectResult | null;
	/** Cached identity from the auth provider, used as display fallback. */
	authUser: ConnectResult | null;
	/** List of API key records owned by the current user. */
	keys: ApiKeyRecord[];
	/** Organization detail for the current user's org, or null while loading. */
	org: OrgDetail | null;
	/** Flat list of all organization members. */
	members: MemberRecord[];
	/** Flat list of all teams in the organization. */
	teams: TeamRecord[];
	/** Full detail for the currently selected team, or null. */
	teamDetail: TeamDetail | null;

	// -- Billing data ----------------------------------------------------------
	/** Per-app subscription rows for the billing panel. */
	subscriptions: BillingDetail[];
	/** True while billing data is being fetched. */
	billingLoading: boolean;
	/** Error message from the last billing operation, or null. */
	billingError: string | null;
	/** Current org credit balance, or null while loading. */
	creditBalance: CreditBalance | null;
	/** App manifest entries for resolving display names, icons, etc. from appId. */
	apps?: Array<{ id: string; name: string; icon?: string; description?: string }>;

	// -- Billing callbacks -----------------------------------------------------
	/** Cancel a subscription. Host re-fetches and updates subscriptions prop. */
	onCancelSubscription: (appId: string) => Promise<void>;
	/** Open the Stripe customer portal for payment management. */
	onOpenPortal: () => Promise<void>;
	/** Called when the user clicks the Subscribe CTA. Opens the checkout flow. */
	onSubscribe?: () => void;

	// -- Dashboard data (admin billing insights) -------------------------------
	/** Paginated transaction result for the transaction log. */
	transactions?: TransactionsResult | null;
	/** Per-user usage rollup. */
	usageByUser?: UsageRollup[];
	/** Per-team usage rollup. */
	usageByTeam?: UsageRollup[];
	/** Currently running tasks with live token data. */
	activeTasks?: ActiveTask[];
	/** Whether dashboard data is still loading. */
	dashboardLoading?: boolean;
	/** Callback to change the transaction page. */
	onTransactionPage?: (page: number) => void;
	/** Direct ledger query for the transaction log (preferred; see BillingDashboardProps). */
	fetchTransactions?: (req: IDataGridPageRequest) => Promise<TransactionsResult | null>;
	/** Org-scoped distinct ledger values for the enum checklist filters. */
	fetchTransactionDistinct?: (field: string) => Promise<(string | number | boolean)[]>;
	/** Available top-up packs (filtered from plans by kind='topup'). */
	topupPlans?: any[];
	/** Callback when user clicks a top-up pack. */
	onBuyTopup?: (plan: any) => void;
	/** All plans from app_prices (for the TopUpModal). */
	allPlans?: any[];
	/** Called to purchase a top-up pack (charges card on file). */
	onPurchaseTopup?: (plan: any) => Promise<{ status: string; clientSecret?: string }>;
	/** Called when the user confirms a plan upgrade/downgrade from the billing panel. */
	onUpgradeSubscription?: (appId: string, newPriceId: string) => Promise<void>;

	// -- Navigation state ------------------------------------------------------
	/** The currently active section / tab. */
	section: AccountSection;
	/** Called when the user switches tabs. */
	onSectionChange: (section: AccountSection) => void;
	/** ID of the team currently being drilled into, or null for list view. */
	activeTeamId: string | null;
	/** Called when the user drills into / backs out of a team. */
	onActiveTeamIdChange: (id: string | null) => void;

	// -- Embedded mode (the Settings page's Account group) ----------------------
	/** Render ONE pane with no tab strip: the collapsed 3-section IA inside
	 *  the Settings nav — 'profile' (identity + workspace master card,
	 *  absorbing the old Organization/Teams/Members tabs), 'billing', or
	 *  'api-keys'. Absent = the classic 6-tab view (unchanged). */
	embeddedSection?: 'profile' | 'billing' | 'api-keys';
	/** Settings-nav navigation for embedded cross-links (the Billing / API
	 *  Keys workspace chip's "change…" jumps to the Profile section). */
	onNavigateSection?: (sectionId: string) => void;
	/** Renames ANY workspace by id (the manage-workspaces drawer). */
	onRenameWorkspace?: (orgId: string, name: string) => Promise<void>;
	/** Creates a new workspace; the server switches the caller into it. */
	onCreateWorkspace?: (name: string) => Promise<void>;
	/** Leaves a workspace the user belongs to (server enforces the rules). */
	onLeaveWorkspace?: (orgId: string) => Promise<void>;
	/** Deletes a workspace the user administers (destroys its data). */
	onDeleteWorkspace?: (orgId: string) => Promise<void>;
	/** Dry-run for the delete confirm: member count + billing blocker. */
	onDeleteWorkspacePrecheck?: (orgId: string) => Promise<{ members: number; subscriptionActive: boolean }>;

	// -- Callbacks (async, host handles actual server calls) --------------------
	/** Persists updated profile fields. */
	onSaveProfile: (fields: ProfileUpdate) => Promise<void>;
	/** Sets the user's dev team (dev-run billing + env layer). */
	onSetDevTeam: (teamId: string) => Promise<void>;
	/** Switches the user's active organization. */
	onSetDefaultOrg: (orgId: string) => Promise<void>;
	/**
	 * @deprecated Unused — the shell owns the logout flow (`shell:logoutRequest`);
	 * no panel in this view renders a sign-out control. Kept optional so existing
	 * hosts still compile; will be removed once every caller stops passing it.
	 */
	onLogout?: () => void;
	/**
	 * @deprecated Unused — account deletion has no entry point in this view.
	 * Kept optional so existing hosts still compile; will be removed once every
	 * caller stops passing it.
	 */
	onDeleteAccount?: () => Promise<void>;
	/** Persists an updated organization name. */
	onSaveOrgName: (name: string) => Promise<void>;
	/** Creates a new API key and returns the raw key string. */
	onCreateKey: (params: { name: string; permissions: string[]; expiresAt?: string; teamId?: string }) => Promise<{ key: string }>;
	/** Revokes an API key by its ID. */
	onRevokeKey: (keyId: string) => Promise<void>;
	/** Sends an invitation to a new organization member. */
	onInviteMember: (params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> }) => Promise<void>;
	/** Updates an organization member's role. */
	onUpdateMemberRole: (userId: string, role: string) => Promise<void>;
	/** Removes an organization member. */
	onRemoveMember: (userId: string) => Promise<void>;
	/** Resends the initialization email for a pending member. */
	onResendInvite: (userId: string) => Promise<void>;
	/** Creates a new team. */
	onCreateTeam: (name: string) => Promise<void>;
	/** Deletes a team. */
	onDeleteTeam: (teamId: string) => Promise<void>;
	/** Adds a member to a team with specified permissions. */
	onAddTeamMember: (params: { teamId: string; userId: string; permissions: string[] }) => Promise<void>;
	/** Updates a team member's permissions. */
	onEditTeamMemberPerms: (params: { teamId: string; userId: string; permissions: string[] }) => Promise<void>;
	/** Removes a member from a team. */
	onRemoveTeamMember: (params: { teamId: string; userId: string }) => Promise<void>;
	/** Requests the host to load full detail for a specific team. */
	onLoadTeamDetail: (teamId: string) => void;

	// Environment secrets are now managed by the standalone Environment page
	// (EnvironmentProvider / EnvironmentWebview). The onLoadEnv, onSaveEnv,
	// and refreshSignal props have been removed.
}

// =============================================================================
// ACCOUNT VIEW
// =============================================================================

/**
 * AccountView is the pure, host-agnostic root component for account management.
 *
 * It renders five tab panels (Profile, API Keys, Organization, Teams, Members)
 * and owns all modal/form UI state internally. Server operations are delegated
 * to the host via async callback props defined in IAccountViewProps.
 */
const AccountView: React.FC<IAccountViewProps> = (props) => {
	const { isConnected, sectionError, profile, authUser, keys, org, members, teams, teamDetail, subscriptions, billingLoading, billingError, creditBalance, apps, onCancelSubscription, onOpenPortal, onSubscribe, transactions, usageByUser, usageByTeam, activeTasks, dashboardLoading, onTransactionPage, fetchTransactions, fetchTransactionDistinct, topupPlans, onBuyTopup, allPlans, onPurchaseTopup, onUpgradeSubscription, section, onSectionChange, activeTeamId, onActiveTeamIdChange, embeddedSection, onNavigateSection, onRenameWorkspace, onCreateWorkspace, onLeaveWorkspace, onDeleteWorkspace, onDeleteWorkspacePrecheck, onSaveProfile, onSetDevTeam, onSetDefaultOrg, onSaveOrgName, onCreateKey, onRevokeKey, onInviteMember, onUpdateMemberRole, onRemoveMember, onResendInvite, onCreateTeam, onDeleteTeam, onAddTeamMember, onEditTeamMemberPerms, onRemoveTeamMember, onLoadTeamDetail } = props;

	// =========================================================================
	// PERMISSION HELPERS
	// =========================================================================

	/** True when the current user has org.admin on their organization. */
	const isOrgAdmin = useMemo(() => {
		return profile?.organization?.permissions?.includes('org.admin') ?? false;
	}, [profile]);

	/**
	 * Returns true when the current user has team.admin on the given team.
	 * Org admins implicitly have team.admin on all teams.
	 */
	const isTeamAdmin = useMemo(() => {
		return (teamId: string): boolean => {
			if (isOrgAdmin) return true;
			const org = profile?.organization;
			if (!org) return false;
			for (const t of org.teams ?? []) {
				if (t.id === teamId && t.permissions?.includes('team.admin')) return true;
			}
			return false;
		};
	}, [profile, isOrgAdmin]);

	/** True when the user has team.admin on the currently viewed team detail. */
	const isActiveTeamAdmin = activeTeamId ? isTeamAdmin(activeTeamId) : false;

	// =========================================================================
	// PORTAL ERROR HANDLING
	// =========================================================================

	/** Wraps the portal callback with local error handling. */
	const handlePortal = async () => {
		try {
			await onOpenPortal();
		} catch (e) {
			console.log('open portal error:', e);
		}
	};

	// =========================================================================
	// TABS
	// =========================================================================

	/**
	 * ViewMenu declaration — rendered by this view's own TabControl strip.
	 * Counts on Billing, API Keys, Teams, and Members show when non-zero.
	 */
	const activeKeyCount = keys.filter((k) => k.active).length;
	const viewMenu = useMemo<ViewMenu>(
		() => ({
			entries: [
				{ id: 'profile', label: 'Profile' },
				{ id: 'billing', label: 'Billing', ...(subscriptions.length > 0 ? { count: subscriptions.length } : {}) },
				{ id: 'api-keys', label: 'API Keys', ...(activeKeyCount > 0 ? { count: activeKeyCount } : {}) },
				{ id: 'organization', label: 'Organization' },
				{ id: 'teams', label: 'Teams', ...(teams.length > 0 ? { count: teams.length } : {}) },
				{ id: 'members', label: 'Members', ...(members.length > 0 ? { count: members.length } : {}) },
			],
		}),
		[subscriptions.length, activeKeyCount, teams.length, members.length]
	);

	/** Selecting an entry switches the section and drops any team drill-down. */
	const handleSelectSection = useCallback(
		(id: string) => {
			onSectionChange(id as AccountSection);
			onActiveTeamIdChange(null);
		},
		[onSectionChange, onActiveTeamIdChange]
	);

	// =========================================================================
	// PANELS
	// =========================================================================

	/**
	 * Memoized panel content map keyed by section ID.
	 * Each value wraps its panel component in the shared tabContent scroll container.
	 */
	const panels = useMemo<Record<string, ITabPanelPanel>>(
		() => ({
			profile: {
				content: (
					<>
						{/* Page heading — below the strip, per the style guide (tabs first, title inside each page). */}
						<ContentHeader title="Profile" subtitle="Your identity, sign-in, and defaults for this account." />
						<div style={commonStyles.tabContent}>
							{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
							<ProfilePanel profile={profile} authUser={authUser} onSave={onSaveProfile} onSetDevTeam={onSetDevTeam} onSetDefaultOrg={onSetDefaultOrg} />
						</div>
					</>
				),
			},
			billing: {
				content: (
					<>
						<ContentHeader title="Billing" subtitle="Subscriptions, account balance, and payment methods." />
						<div style={commonStyles.tabContent}>
							<BillingPanel isConnected={isConnected} subscriptions={subscriptions} loading={billingLoading} error={billingError} creditBalance={creditBalance} apps={apps} onCancelSubscription={onCancelSubscription} onOpenPortal={handlePortal} isOrgAdmin={isOrgAdmin} onSubscribe={onSubscribe} transactions={transactions} usageByUser={usageByUser} usageByTeam={usageByTeam} activeTasks={activeTasks} dashboardLoading={dashboardLoading} onTransactionPage={onTransactionPage} fetchTransactions={fetchTransactions} fetchTransactionDistinct={fetchTransactionDistinct} topupPlans={topupPlans} onBuyTopup={onBuyTopup} allPlans={allPlans} onPurchaseTopup={onPurchaseTopup} onUpgradeSubscription={onUpgradeSubscription} />
						</div>
					</>
				),
			},
			'api-keys': {
				content: (
					<>
						<ContentHeader title="API Keys" subtitle="Create and revoke keys for programmatic access." />
						<div style={commonStyles.tabContent}>
							{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
							<ApiKeysPanel keys={keys} teams={teams} onCreateKey={onCreateKey} onRevokeKey={onRevokeKey} />
						</div>
					</>
				),
			},
			organization: {
				content: (
					<>
						<ContentHeader title="Organization" subtitle="Your organization's name and settings." />
						<div style={commonStyles.tabContent}>
							{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
							<OrganizationPanel org={org} onSave={onSaveOrgName} isOrgAdmin={isOrgAdmin} />
						</div>
					</>
				),
			},
			teams: {
				content: (
					<>
						<ContentHeader title="Teams" subtitle="Group members and scope their permissions." />
						<div style={commonStyles.tabContent}>
							{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
							<TeamsPanel teams={teams} teamDetail={teamDetail} activeTeamId={activeTeamId} onActiveTeamIdChange={onActiveTeamIdChange} onLoadTeamDetail={onLoadTeamDetail} members={members} profile={profile} onCreateTeam={onCreateTeam} onDeleteTeam={onDeleteTeam} onAddTeamMember={onAddTeamMember} onEditTeamMemberPerms={onEditTeamMemberPerms} onRemoveTeamMember={onRemoveTeamMember} isOrgAdmin={isOrgAdmin} isActiveTeamAdmin={isActiveTeamAdmin} />
						</div>
					</>
				),
			},
			members: {
				content: (
					<>
						<ContentHeader title="Members" subtitle="Everyone in this organization and their roles." />
						<div style={commonStyles.tabContent}>
							{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
							<MembersPanel members={members} teams={teams} profile={profile} isOrgAdmin={isOrgAdmin} onInviteMember={onInviteMember} onUpdateMemberRole={onUpdateMemberRole} onRemoveMember={onRemoveMember} onResendInvite={onResendInvite} />
						</div>
					</>
				),
			},
		}),
		[sectionError, profile, authUser, keys, org, teams, teamDetail, activeTeamId, members, isConnected, subscriptions, billingLoading, billingError, creditBalance, transactions, apps, usageByUser, usageByTeam, activeTasks, dashboardLoading, topupPlans, allPlans, fetchTransactions, fetchTransactionDistinct, onSaveProfile, onSetDevTeam, onSetDefaultOrg, onSubscribe, onTransactionPage, onBuyTopup, onPurchaseTopup, onUpgradeSubscription, onSaveOrgName, onResendInvite, onActiveTeamIdChange, onLoadTeamDetail, onCreateKey, onRevokeKey, onInviteMember, onUpdateMemberRole, onRemoveMember, onCancelSubscription, onCreateTeam, onDeleteTeam, onAddTeamMember, onEditTeamMemberPerms, onRemoveTeamMember, handlePortal, isOrgAdmin, isActiveTeamAdmin]
	);

	// =========================================================================
	// RENDER — EMBEDDED MODE (one pane, no tab strip)
	// =========================================================================

	if (embeddedSection) {
		/** The live workspace chip + "change…" link shown on the Billing and
		 *  API Keys panes — the one committed switcher lives on Profile. */
		const workspaceName = profile?.organization?.name ?? authUser?.organization?.name ?? '';
		const chip = workspaceName ? (
			<span style={embeddedStyles.chipRow}>
				for <span style={embeddedStyles.chip}>{workspaceName}</span>
				{onNavigateSection && (
					<button style={embeddedStyles.chipLink} onClick={() => onNavigateSection('account:profile')}>
						change…
					</button>
				)}
			</span>
		) : null;

		return (
			<div style={embeddedStyles.root}>
				{embeddedSection === 'profile' && (
					<>
						<ContentHeader title="Profile" subtitle="Who you are, and the workspace you're working in." />
						<div style={commonStyles.tabContent}>
							{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
							<ProfileSection
								profile={profile}
								authUser={authUser}
								members={members}
								teams={teams}
								teamDetail={teamDetail}
								activeTeamId={activeTeamId}
								isOrgAdmin={isOrgAdmin}
								isActiveTeamAdmin={isActiveTeamAdmin}
								onActiveTeamIdChange={onActiveTeamIdChange}
								onLoadTeamDetail={onLoadTeamDetail}
								onSaveProfile={onSaveProfile}
								onSetDevTeam={async (id) => onSetDevTeam(id)}
								onSetDefaultOrg={async (id) => onSetDefaultOrg(id)}
								onRenameWorkspace={onRenameWorkspace ?? (async (_orgId, name) => onSaveOrgName(name))}
								{...(onCreateWorkspace ? { onCreateWorkspace } : {})}
								{...(onLeaveWorkspace ? { onLeaveWorkspace } : {})}
								{...(onDeleteWorkspace ? { onDeleteWorkspace } : {})}
								{...(onDeleteWorkspacePrecheck ? { onDeleteWorkspacePrecheck } : {})}
								onInviteMember={onInviteMember}
								onUpdateMemberRole={onUpdateMemberRole}
								onRemoveMember={onRemoveMember}
								onResendInvite={onResendInvite}
								onCreateTeam={onCreateTeam}
								onDeleteTeam={onDeleteTeam}
								onAddTeamMember={onAddTeamMember}
								onEditTeamMemberPerms={onEditTeamMemberPerms}
								onRemoveTeamMember={onRemoveTeamMember}
							/>
						</div>
					</>
				)}
				{embeddedSection === 'billing' && (
					<>
						<ContentHeader title="Billing" subtitle="Subscriptions, account balance, and payment methods." />
						<div style={commonStyles.tabContent}>
							{chip}
							<BillingPanel isConnected={isConnected} subscriptions={subscriptions} loading={billingLoading} error={billingError} creditBalance={creditBalance} apps={apps} onCancelSubscription={onCancelSubscription} onOpenPortal={handlePortal} isOrgAdmin={isOrgAdmin} onSubscribe={onSubscribe} transactions={transactions} usageByUser={usageByUser} usageByTeam={usageByTeam} activeTasks={activeTasks} dashboardLoading={dashboardLoading} onTransactionPage={onTransactionPage} fetchTransactions={fetchTransactions} fetchTransactionDistinct={fetchTransactionDistinct} topupPlans={topupPlans} onBuyTopup={onBuyTopup} allPlans={allPlans} onPurchaseTopup={onPurchaseTopup} onUpgradeSubscription={onUpgradeSubscription} />
						</div>
					</>
				)}
				{embeddedSection === 'api-keys' && (
					<>
						<ContentHeader title="API Keys" subtitle="Create and revoke keys for programmatic access." />
						<div style={commonStyles.tabContent}>
							{chip}
							{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
							<ApiKeysPanel keys={keys} teams={teams} onCreateKey={onCreateKey} onRevokeKey={onRevokeKey} />
						</div>
					</>
				)}
			</div>
		);
	}

	// =========================================================================
	// RENDER — CLASSIC TAB VIEW
	// =========================================================================

	return (
		<div style={styles.root}>
			{/* Page strip — the view renders its own tabs at the very top. */}
			<TabControl menu={viewMenu} activeId={section} onSelect={handleSelectSection} />
			{/* Page bodies fill the space below the strip. */}
			<div style={styles.pageBody}>
				<TabPanel panels={panels} activeId={section} />
			</div>

		</div>
	);
};

export default AccountView;
