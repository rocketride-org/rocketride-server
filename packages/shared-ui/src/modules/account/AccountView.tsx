// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AccountView — account management tabs using the shared TabPanel overlay.
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

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import { commonStyles } from '../../themes/styles';
import type { ITabPanelTab, ITabPanelPanel } from '../../components/tab-panel/TabPanel';
import type { ConnectResult, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, TeamMemberRecord, AccountSection, ProfileUpdate } from './types';
import type { BillingDetail, CreditBalance, TransactionsResult, UsageRollup } from '../billing/types';
import type { ActiveTask } from '../billing/components/BillingDashboard';
import { ProfilePanel } from './components/ProfilePanel';
// EnvScopeCard removed — env management is now in the standalone Environment page
import { BillingPanel } from './components/BillingPanel';
import { ApiKeysPanel } from './components/ApiKeysPanel';
import { OrganizationPanel } from './components/OrganizationPanel';
import { TeamsPanel } from './components/TeamsPanel';
import { MembersPanel } from './components/MembersPanel';
import { S, Modal, PermGrid, PermPill, ExpiryOpts, Avatar, relativeTime, PERM_DISPLAY } from './components/shared';

// =============================================================================
// REVEAL STYLES
// =============================================================================

/** Styles for the API key reveal box shown after creating a new key. */
const revealStyles = {
	/** Highlighted box used to display a newly created API key. */
	box: { background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', borderRadius: 7, padding: 12, marginBottom: 12 } as CSSProperties,
	/** Uppercase section label inside the reveal box. */
	label: { ...commonStyles.labelUppercase, marginBottom: 7 } as CSSProperties,
	/** Horizontal row pairing the key value with the copy button. */
	row: { display: 'flex', alignItems: 'center', gap: 7 } as CSSProperties,
	/** Monospace display for the raw API key string. */
	key: { ...commonStyles.inputField, ...commonStyles.fontMono, flex: 1, fontSize: 11, wordBreak: 'break-all' as const, lineHeight: 1.5 } as CSSProperties,
	/** Warning message below the reveal box reminding the user to copy the key. */
	warn: { fontSize: 10, color: 'var(--rr-color-warning)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 7 } as CSSProperties,
};

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
	/** Full-bleed frosted-glass overlay shown when the shell client is disconnected. */
	disconnectOverlay: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.45)',
		backdropFilter: 'blur(8px)',
		WebkitBackdropFilter: 'blur(8px)',
		zIndex: 1000,
	} as CSSProperties,
	/** Non-interactive status button rendered inside the disconnect overlay. */
	disconnectButton: {
		padding: '14px 40px',
		fontSize: 14,
		fontWeight: 700,
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-fg-button)',
		backgroundColor: 'transparent',
		border: '2px solid rgba(255, 255, 255, 0.7)',
		borderRadius: 6,
		cursor: 'default',
		letterSpacing: '0.05em',
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
	/** Member lookup: userId -> display name. */
	memberNames?: Record<string, string>;
	/** Team lookup: teamId -> display name. */
	teamNames?: Record<string, string>;
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

	// -- Callbacks (async, host handles actual server calls) --------------------
	/** Persists updated profile fields. */
	onSaveProfile: (fields: ProfileUpdate) => Promise<void>;
	/** Sets the user's preferred default team. */
	onSetDefaultTeam: (teamId: string) => Promise<void>;
	/** Switches the user's active organization. */
	onSetDefaultOrg: (orgId: string) => Promise<void>;
	/** Triggers the logout flow. */
	onLogout: () => void;
	/** Permanently deletes the user account. */
	onDeleteAccount: () => Promise<void>;
	/** Persists an updated organization name. */
	onSaveOrgName: (name: string) => Promise<void>;
	/** Creates a new API key and returns the raw key string. */
	onCreateKey: (params: { name: string; permissions: string[]; expiresAt?: string }) => Promise<{ key: string }>;
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
	const { isConnected, sectionError, profile, authUser, keys, org, members, teams, teamDetail, subscriptions, billingLoading, billingError, creditBalance, apps, onCancelSubscription, onOpenPortal, onSubscribe, transactions, usageByUser, usageByTeam, activeTasks, dashboardLoading, onTransactionPage, memberNames, teamNames, topupPlans, onBuyTopup, allPlans, onPurchaseTopup, onUpgradeSubscription, section, onSectionChange, activeTeamId, onActiveTeamIdChange, onSaveProfile, onSetDefaultTeam, onSetDefaultOrg, onLogout, onDeleteAccount, onSaveOrgName, onCreateKey, onRevokeKey, onInviteMember, onUpdateMemberRole, onRemoveMember, onResendInvite, onCreateTeam, onDeleteTeam, onAddTeamMember, onEditTeamMemberPerms, onRemoveTeamMember, onLoadTeamDetail } = props;

	// =========================================================================
	// PERMISSION HELPERS
	// =========================================================================

	/** The organization's ID (used for org-scoped env calls). */
	const orgId = profile?.organization?.id;

	// Build appId → app lookup for display name resolution
	const appMap = useMemo(() => {
		const map: Record<string, { id: string; name: string; icon?: string; description?: string }> = {};
		for (const a of apps ?? []) map[a.id] = a;
		return map;
	}, [apps]);

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
	// MODAL STATE
	// =========================================================================

	/** Union of all modal identifiers; null means no modal is open. */
	type ModalId = 'create-key' | 'reveal-key' | 'revoke-key' | 'invite' | 'change-role' | 'edit-perms' | 'add-member' | 'create-team' | 'delete-team' | 'cancel-sub' | 'remove-member' | 'remove-team-member' | null;
	const [modal, setModal] = useState<ModalId>(null);

	// -- Modal form state -- one group of fields per modal dialog.
	const [newKeyName, setNewKeyName] = useState('');
	const [newKeyTeamId, setNewKeyTeamId] = useState<string>('');
	const [newKeyPerms, setNewKeyPerms] = useState<string[]>([]);
	const [newKeyExpiry, setNewKeyExpiry] = useState<number | null>(90);
	/** Holds the newly created key value alongside its record so the reveal modal can display it once. */
	const [revealedKey, setRevealedKey] = useState<{ key: string; record: Omit<ApiKeyRecord, 'active' | 'lastUsedAt' | 'revokedAt'> } | null>(null);
	/** Tracks whether the copy-to-clipboard action has just fired, for transient feedback. */
	const [keyCopied, setKeyCopied] = useState(false);
	const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);
	const [inviteEmail, setInviteEmail] = useState('');
	const [inviteGivenName, setInviteGivenName] = useState('');
	const [inviteFamilyName, setInviteFamilyName] = useState('');
	const [inviteRole, setInviteRole] = useState('member');
	const [inviteTeams, setInviteTeams] = useState<Record<string, string[]>>({});
	const [inviteEditPermsTeamId, setInviteEditPermsTeamId] = useState<string | null>(null);
	const [editRoleTarget, setEditRoleTarget] = useState<MemberRecord | null>(null);
	const [editRoleValue, setEditRoleValue] = useState('member');
	const [editPermsTarget, setEditPermsTarget] = useState<TeamMemberRecord | null>(null);
	const [editPermsValue, setEditPermsValue] = useState<string[]>([]);
	const [addMemberUserId, setAddMemberUserId] = useState('');
	const [addMemberPerms, setAddMemberPerms] = useState<string[]>(['task.control', 'task.monitor']);
	const [newTeamName, setNewTeamName] = useState('');
	/** Tracks the appId of the subscription being cancelled. */
	const [cancelSubAppId, setCancelSubAppId] = useState<string | null>(null);
	/** Tracks the member being removed from the org. */
	const [removeMemberTarget, setRemoveMemberTarget] = useState<MemberRecord | null>(null);
	/** Tracks the team member being removed from a team. */
	const [removeTeamMemberTarget, setRemoveTeamMemberTarget] = useState<{ userId: string; displayName: string } | null>(null);
	/** Tracks the team ID pending delete confirmation. */
	const [deleteTeamId, setDeleteTeamId] = useState<string | null>(null);
	/** Shared saving flag used by all modal submit handlers. */
	const [saving, setSaving] = useState(false);
	/** Shared error string shown inside the active modal on failure. */
	const [saveError, setSaveError] = useState<string | null>(null);

	// =========================================================================
	// CREATE KEY
	// =========================================================================

	/**
	 * Submits the new API key form.
	 * On success, transitions to the "reveal-key" modal to display the raw key
	 * value (which the server will never return again after this point).
	 */
	const handleCreateKey = async () => {
		if (!newKeyName.trim()) {
			setSaveError('Name is required');
			return;
		}
		// Team-scoped keys require permissions
		if (newKeyTeamId && newKeyPerms.length === 0) {
			setSaveError('Select at least one permission for a team-scoped key');
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			const expiresAt = newKeyExpiry ? new Date(Date.now() + newKeyExpiry * 86400000).toISOString() : undefined;
			const params: { name: string; permissions: string[]; expiresAt?: string; teamId?: string } = {
				name: newKeyName.trim(),
				permissions: newKeyTeamId ? newKeyPerms : [],
				...(expiresAt ? { expiresAt } : {}),
			};
			if (newKeyTeamId) params.teamId = newKeyTeamId;
			const body = await onCreateKey(params);
			const teamName = newKeyTeamId ? teams.find((t) => t.id === newKeyTeamId)?.name || null : null;
			setRevealedKey({ key: body.key, record: { id: '', name: newKeyName.trim(), teamId: newKeyTeamId || null, teamName, permissions: params.permissions, createdAt: new Date().toISOString(), expiresAt: expiresAt || null, isSession: false } });
			setModal('reveal-key');
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to create key');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// REVOKE KEY
	// =========================================================================

	/** Sends the revoke request for the currently targeted key. */
	const handleRevokeKey = async () => {
		if (!revokeTarget) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onRevokeKey(revokeTarget.id);
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to revoke key');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// INVITE MEMBER
	// =========================================================================

	/** Validates the invite form fields and sends the invitation. */
	const handleInvite = async () => {
		// Step 1: validate required fields.
		if (!inviteEmail.trim()) {
			setSaveError('Email is required');
			return;
		}
		if (!inviteGivenName.trim()) {
			setSaveError('First name is required');
			return;
		}
		if (!inviteFamilyName.trim()) {
			setSaveError('Last name is required');
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			// Step 2: build team assignments from the checked teams.
			const teamAssignments = Object.entries(inviteTeams).map(([teamId, permissions]) => ({ teamId, permissions }));
			// Step 3: call the host callback.
			await onInviteMember({
				email: inviteEmail.trim(),
				givenName: inviteGivenName.trim(),
				familyName: inviteFamilyName.trim(),
				role: inviteRole,
				teamAssignments: teamAssignments.length > 0 ? teamAssignments : undefined,
			});
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to invite member');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// UPDATE MEMBER ROLE
	// =========================================================================

	/** Persists the updated organization role for the targeted member. */
	const handleUpdateRole = async () => {
		if (!editRoleTarget) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onUpdateMemberRole(editRoleTarget.userId, editRoleValue);
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to update role');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// REMOVE MEMBER
	// =========================================================================

	/** Confirms removal of an org member (or cancels a pending invitation). */
	const handleRemoveMember = async () => {
		if (!removeMemberTarget) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onRemoveMember(removeMemberTarget.userId);
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to remove member');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// CANCEL SUBSCRIPTION
	// =========================================================================

	/** Confirms the cancellation and delegates to the host callback. */
	const handleCancelSubscription = async () => {
		if (!cancelSubAppId) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onCancelSubscription(cancelSubAppId);
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to cancel subscription');
		} finally {
			setSaving(false);
		}
	};

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
	// CREATE TEAM
	// =========================================================================

	/** Creates a new team with the entered name. */
	const handleCreateTeam = async () => {
		if (!newTeamName.trim()) {
			setSaveError('Name is required');
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			await onCreateTeam(newTeamName.trim());
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to create team');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// DELETE TEAM
	// =========================================================================

	/**
	 * Deletes a team and returns the Teams panel to the list view.
	 * @param teamId - The ID of the team to delete.
	 */
	const handleDeleteTeam = async () => {
		if (!deleteTeamId) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onDeleteTeam(deleteTeamId);
			onActiveTeamIdChange(null);
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to delete team');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// EDIT TEAM MEMBER PERMISSIONS
	// =========================================================================

	/** Persists updated per-team permissions for the targeted team member. */
	const handleEditPerms = async () => {
		if (!editPermsTarget || !teamDetail) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onEditTeamMemberPerms({ teamId: teamDetail.id, userId: editPermsTarget.userId, permissions: editPermsValue });
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to update permissions');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// ADD TEAM MEMBER
	// =========================================================================

	/** Adds the selected organization member to the current team with the chosen permissions. */
	const handleAddTeamMember = async () => {
		if (!addMemberUserId || !teamDetail) {
			setSaveError('Select a member');
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			await onAddTeamMember({ teamId: teamDetail.id, userId: addMemberUserId, permissions: addMemberPerms });
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to add member');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// REMOVE TEAM MEMBER
	// =========================================================================

	/** Confirms removal of a member from the current team. */
	const handleRemoveTeamMember = async () => {
		if (!removeTeamMemberTarget || !teamDetail) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onRemoveTeamMember({ teamId: teamDetail.id, userId: removeTeamMemberTarget.userId });
			setModal(null);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : 'Failed to remove team member');
		} finally {
			setSaving(false);
		}
	};

	// =========================================================================
	// MODAL OPEN HELPERS
	// =========================================================================

	/** Resets the create-key form fields and opens the modal. */
	const openCreateKey = () => {
		setNewKeyName('');
		setNewKeyTeamId('');
		setNewKeyPerms([]);
		setNewKeyExpiry(90);
		setSaveError(null);
		setModal('create-key');
	};
	/** Stores the target key for revocation and opens the confirmation modal. */
	const openRevokeKey = (key: ApiKeyRecord) => {
		setRevokeTarget(key);
		setSaveError(null);
		setModal('revoke-key');
	};
	/** Resets the invite form and opens the invite modal. */
	const openInvite = () => {
		setInviteEmail('');
		setInviteGivenName('');
		setInviteFamilyName('');
		setInviteRole('member');
		setInviteTeams({});
		setInviteEditPermsTeamId(null);
		setSaveError(null);
		setModal('invite');
	};
	/** Populates the role editor with the member's current role and opens the modal. */
	const openChangeRole = (m: MemberRecord) => {
		setEditRoleTarget(m);
		setEditRoleValue(m.role);
		setSaveError(null);
		setModal('change-role');
	};
	/** Populates the perms editor with the member's current permissions and opens the modal. */
	const openEditPerms = (m: TeamMemberRecord) => {
		setEditPermsTarget(m);
		setEditPermsValue([...m.permissions]);
		setSaveError(null);
		setModal('edit-perms');
	};
	/** Stores the target member and opens the remove-member confirmation modal. */
	const openRemoveMember = (m: MemberRecord) => {
		setRemoveMemberTarget(m);
		setSaveError(null);
		setModal('remove-member');
	};

	/** Stores the target team member and opens the remove-team-member confirmation modal. */
	const openRemoveTeamMember = (userId: string, displayName: string) => {
		setRemoveTeamMemberTarget({ userId, displayName });
		setSaveError(null);
		setModal('remove-team-member');
	};

	/** Stores the target subscription appId and opens the cancel confirmation modal. */
	const openCancelSub = (appId: string) => {
		setCancelSubAppId(appId);
		setSaveError(null);
		setModal('cancel-sub');
	};

	/**
	 * Pre-selects the first eligible organization member (one not already in the team)
	 * and opens the Add Member to Team modal.
	 */
	const openAddMember = () => {
		setAddMemberUserId('');
		setAddMemberPerms(['task.control', 'task.monitor']);
		setSaveError(null);
		setModal('add-member');
	};

	// =========================================================================
	// TABS
	// =========================================================================

	/**
	 * Memoized tab descriptor array for the TabPanel overlay.
	 * Badges on API Keys, Teams, and Members show the current count when non-zero.
	 */
	const tabs = useMemo<ITabPanelTab[]>(
		() => [
			{ id: 'profile', label: 'Profile' },
			{ id: 'billing', label: 'Billing', badge: subscriptions.length > 0 ? subscriptions.length : undefined },
			{ id: 'api-keys', label: 'API Keys', badge: keys.filter((k) => k.active).length > 0 ? keys.filter((k) => k.active).length : undefined },
			{ id: 'organization', label: 'Organization' },
			{ id: 'teams', label: 'Teams', badge: teams.length > 0 ? teams.length : undefined },
			{ id: 'members', label: 'Members', badge: members.length > 0 ? members.length : undefined },
		],
		[subscriptions, keys, teams, members]
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
					<div style={commonStyles.tabContent}>
						{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
						<ProfilePanel profile={profile} authUser={authUser} onSave={onSaveProfile} onSetDefaultTeam={onSetDefaultTeam} onSetDefaultOrg={onSetDefaultOrg} onLogout={onLogout} onDeleteAccount={onDeleteAccount} />
					</div>
				),
			},
			billing: {
				content: (
					<div style={commonStyles.tabContent}>
						<BillingPanel isConnected={isConnected} subscriptions={subscriptions} loading={billingLoading} error={billingError} creditBalance={creditBalance} apps={apps} onCancelSubscription={openCancelSub} onOpenPortal={handlePortal} isOrgAdmin={isOrgAdmin} onSubscribe={onSubscribe} transactions={transactions} usageByUser={usageByUser} usageByTeam={usageByTeam} activeTasks={activeTasks} dashboardLoading={dashboardLoading} onTransactionPage={onTransactionPage} topupPlans={topupPlans} onBuyTopup={onBuyTopup} allPlans={allPlans} onPurchaseTopup={onPurchaseTopup} memberNames={memberNames} teamNames={teamNames} onUpgradeSubscription={onUpgradeSubscription} />
					</div>
				),
			},
			'api-keys': {
				content: (
					<div style={commonStyles.tabContent}>
						{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
						<ApiKeysPanel keys={keys} onCreateKey={openCreateKey} onRevokeKey={openRevokeKey} />
					</div>
				),
			},
			organization: {
				content: (
					<div style={commonStyles.tabContent}>
						{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
						<OrganizationPanel org={org} onSave={onSaveOrgName} isOrgAdmin={isOrgAdmin} />
					</div>
				),
			},
			teams: {
				content: (
					<div style={commonStyles.tabContent}>
						{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
						<TeamsPanel
							teams={teams}
							teamDetail={teamDetail}
							activeTeamId={activeTeamId}
							profile={profile}
							onSelectTeam={(id) => {
								onActiveTeamIdChange(id);
								onLoadTeamDetail(id);
							}}
							onBack={() => onActiveTeamIdChange(null)}
							onCreateTeam={() => {
								setNewTeamName('');
								setSaveError(null);
								setModal('create-team');
							}}
							onAddMember={openAddMember}
							onEditPerms={openEditPerms}
							onRemoveMember={openRemoveTeamMember}
							onDeleteTeam={(id) => {
								setDeleteTeamId(id);
								setSaveError(null);
								setModal('delete-team');
							}}
							isOrgAdmin={isOrgAdmin}
							isTeamAdmin={isActiveTeamAdmin}
						/>
					</div>
				),
			},
			members: {
				content: (
					<div style={commonStyles.tabContent}>
						{sectionError && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{sectionError}</p>}
						<MembersPanel org={org} members={members} profile={profile} onInvite={openInvite} onChangeRole={openChangeRole} onRemove={openRemoveMember} onResendInvite={(m) => onResendInvite(m.userId)} isOrgAdmin={isOrgAdmin} />
					</div>
				),
			},
		}),
		[sectionError, profile, authUser, keys, org, teams, teamDetail, activeTeamId, members, isConnected, subscriptions, billingLoading, billingError, creditBalance, transactions, apps, usageByUser, usageByTeam, activeTasks, dashboardLoading, topupPlans, allPlans, memberNames, teamNames, onSaveProfile, onSetDefaultTeam, onSetDefaultOrg, onLogout, onDeleteAccount, onSubscribe, onTransactionPage, onBuyTopup, onPurchaseTopup, onUpgradeSubscription, onSaveOrgName, onResendInvite, onActiveTeamIdChange, onLoadTeamDetail, openCancelSub, handlePortal, openCreateKey, openRevokeKey, openInvite, openChangeRole, openRemoveMember, openRemoveTeamMember, openAddMember, openEditPerms, isOrgAdmin, isActiveTeamAdmin]
	);

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={styles.root}>
			<TabPanel
				tabs={tabs}
				activeTab={section}
				onTabChange={(id) => {
					onSectionChange(id as AccountSection);
					onActiveTeamIdChange(null);
				}}
				panels={panels}
			/>

			{/* Frosted-glass overlay with a disabled status button when disconnected. */}
			{!isConnected && (
				<div style={styles.disconnectOverlay}>
					<button type="button" style={styles.disconnectButton} disabled>
						[ Disconnected ]
					</button>
				</div>
			)}

			{/* ================================================================ */}
			{/* MODALS                                                           */}
			{/* ================================================================ */}

			{/* Create Key */}
			{modal === 'create-key' && (
				<Modal
					title="Create API Key"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonPrimary, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleCreateKey} disabled={saving}>
								{saving ? 'Creating\u2026' : 'Create Key'}
							</button>
						</>
					}
				>
					<div style={S.field}>
						<div style={S.fieldLabel}>Key Name</div>
						<input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="e.g. Production Server, CI Pipeline" style={commonStyles.inputField} />
					</div>
					<div style={S.field}>
						<div style={S.fieldLabel}>Team Scope</div>
						<select
							value={newKeyTeamId}
							onChange={(e) => {
								setNewKeyTeamId(e.target.value);
								// Reset permissions when switching teams
								setNewKeyPerms([]);
							}}
							style={{ ...commonStyles.inputField, cursor: 'pointer' } as CSSProperties}
						>
							<option value="">All Teams</option>
							{teams.map((t) => (
								<option key={t.id} value={t.id}>
									{t.name}
								</option>
							))}
						</select>
						<div style={commonStyles.textMuted}>{newKeyTeamId ? 'Key is restricted to this team only.' : 'Key inherits all teams from your account.'}</div>
					</div>
					{newKeyTeamId && (
						<div style={{ ...S.field, marginBottom: 14 }}>
							<div style={S.fieldLabel}>Permissions</div>
							<PermGrid value={newKeyPerms} onChange={setNewKeyPerms} />
						</div>
					)}
					<div style={S.field}>
						<div style={S.fieldLabel}>Expiry</div>
						<ExpiryOpts value={newKeyExpiry} onChange={setNewKeyExpiry} />
					</div>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Reveal Key */}
			{modal === 'reveal-key' && revealedKey && (
				<Modal
					title="Key Created"
					onClose={() => setModal(null)}
					footer={
						<button style={commonStyles.buttonPrimary as CSSProperties} onClick={() => setModal(null)}>
							Done
						</button>
					}
				>
					<p style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
						Copy it now -- <strong style={{ color: 'var(--rr-text-primary)' }}>it won't be shown again.</strong>
					</p>
					<div style={revealStyles.box}>
						<div style={revealStyles.label}>Your API Key</div>
						<div style={revealStyles.row}>
							<div style={revealStyles.key}>{revealedKey.key}</div>
							{/* Copy button: flips to "Copied" for 2s after a successful clipboard write. */}
							<button
								onClick={() => {
									navigator.clipboard.writeText(revealedKey.key);
									setKeyCopied(true);
									setTimeout(() => setKeyCopied(false), 2000);
								}}
								style={{ padding: '7px 10px', background: 'var(--rr-bg-input)', border: `1px solid ${keyCopied ? 'var(--rr-color-success)' : 'var(--rr-border-input)'}`, borderRadius: 5, color: keyCopied ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}
							>
								{keyCopied ? '\u2713 Copied' : '\u2398 Copy'}
							</button>
						</div>
						<div style={revealStyles.warn}>Warning: Store safely -- cannot be retrieved after closing.</div>
					</div>
					<div style={{ background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', borderRadius: 7, padding: '10px 13px', fontSize: 11, color: 'var(--rr-text-secondary)', lineHeight: 1.6 }}>
						<strong>Expires:</strong> {revealedKey.record.expiresAt ? new Date(revealedKey.record.expiresAt).toLocaleDateString() : 'No expiry'}
					</div>
				</Modal>
			)}

			{/* Revoke Key */}
			{modal === 'revoke-key' && revokeTarget && (
				<Modal
					title="Revoke API Key"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonDanger, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleRevokeKey} disabled={saving}>
								{saving ? 'Revoking\u2026' : 'Revoke Key'}
							</button>
						</>
					}
				>
					<div style={{ fontSize: 13, fontWeight: 700, color: 'var(--rr-text-primary)', marginBottom: 2 }}>{revokeTarget.name}</div>
					<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)', marginBottom: 14 }}>Last used {relativeTime(revokeTarget.lastUsedAt)}</div>
					<div style={{ display: 'flex', gap: 10, background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-color-error)', borderRadius: 7, padding: 12 }}>
						<span style={{ fontSize: 12, fontWeight: 700, flexShrink: 0, color: 'var(--rr-color-error)' }}>!</span>
						<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>
							<strong style={{ color: 'var(--rr-text-primary)' }}>This cannot be undone.</strong> Any service using this key will immediately lose access.
						</div>
					</div>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Invite Member */}
			{modal === 'invite' && (
				<Modal
					title="Invite Member"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonPrimary, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleInvite} disabled={saving}>
								{saving ? 'Inviting\u2026' : 'Send Invite'}
							</button>
						</>
					}
				>
					<div style={S.field}>
						<div style={S.fieldLabel}>Email Address</div>
						<input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@acme.com" style={commonStyles.inputField} autoFocus />
					</div>
					<div style={S.fieldRow}>
						<div style={S.field}>
							<div style={S.fieldLabel}>First Name</div>
							<input value={inviteGivenName} onChange={(e) => setInviteGivenName(e.target.value)} placeholder="Jane" style={commonStyles.inputField} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Last Name</div>
							<input value={inviteFamilyName} onChange={(e) => setInviteFamilyName(e.target.value)} placeholder="Smith" style={commonStyles.inputField} />
						</div>
					</div>
					<div style={S.field}>
						<div style={S.fieldLabel}>Organization Role</div>
						<select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} style={{ ...commonStyles.inputField, cursor: 'pointer' } as CSSProperties}>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</div>
					{/* Team Access */}
					{teams.length > 0 && (
						<div style={S.field}>
							<div style={S.fieldLabel}>Team Access</div>
							<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
								{teams.map((t) => {
									const checked = t.id in inviteTeams;
									const perms = inviteTeams[t.id] ?? [];
									const editingPerms = inviteEditPermsTeamId === t.id;
									return (
										<div key={t.id}>
											<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
												{/* Checkbox */}
												<div
													onClick={() => {
														if (checked) {
															const next = { ...inviteTeams };
															delete next[t.id];
															setInviteTeams(next);
															if (editingPerms) setInviteEditPermsTeamId(null);
														} else {
															setInviteTeams({ ...inviteTeams, [t.id]: ['task.control', 'task.monitor'] });
														}
													}}
													style={{
														width: 14, height: 14, borderRadius: 3, flexShrink: 0,
														display: 'flex', alignItems: 'center', justifyContent: 'center',
														fontSize: 9, cursor: 'pointer',
														border: `1px solid ${checked ? 'var(--rr-color-info)' : 'var(--rr-border-input)'}`,
														background: checked ? 'var(--rr-color-info)' : 'var(--rr-bg-input)',
														color: 'var(--rr-fg-button)',
													}}
												>
													{checked && '\u2713'}
												</div>
												{/* Team name */}
												<span style={{ flex: 1, fontSize: 12, fontWeight: 500, color: checked ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)' }}>{t.name}</span>
												{/* Edit Perms button */}
												{checked && (
													<button
														style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton, fontSize: 10, padding: '2px 8px' } as CSSProperties}
														onClick={() => setInviteEditPermsTeamId(editingPerms ? null : t.id)}
													>
														{editingPerms ? 'Done' : 'Edit Perms'}
													</button>
												)}
											</div>
											{/* Permission badges (when not editing) */}
											{checked && !editingPerms && perms.length > 0 && (
												<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, paddingLeft: 22 }}>
													{perms.map((p) => (
														<PermPill key={p} perm={p} />
													))}
												</div>
											)}
											{/* PermGrid (when editing) */}
											{editingPerms && (
												<div style={{ marginTop: 6, paddingLeft: 22 }}>
													<PermGrid value={perms} onChange={(v) => setInviteTeams({ ...inviteTeams, [t.id]: v })} />
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					)}
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Change Role */}
			{modal === 'change-role' && editRoleTarget && (
				<Modal
					title="Edit Member"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonPrimary, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleUpdateRole} disabled={saving}>
								{saving ? 'Saving\u2026' : 'Save'}
							</button>
						</>
					}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
						<Avatar name={editRoleTarget.displayName} email={editRoleTarget.email} size={32} />
						<div>
							<div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)' }}>{editRoleTarget.displayName}</div>
							<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{editRoleTarget.email}</div>
						</div>
					</div>
					<div style={S.field}>
						<div style={S.fieldLabel}>Organization Role</div>
						<select value={editRoleValue} onChange={(e) => setEditRoleValue(e.target.value)} style={{ ...commonStyles.inputField, cursor: 'pointer' } as CSSProperties}>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</div>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Edit Permissions */}
			{modal === 'edit-perms' && editPermsTarget && (
				<Modal
					title="Edit Permissions"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonPrimary, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleEditPerms} disabled={saving}>
								{saving ? 'Saving\u2026' : 'Save Permissions'}
							</button>
						</>
					}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
						<Avatar name={editPermsTarget.displayName} email={editPermsTarget.email} size={32} />
						<div>
							<div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)' }}>{editPermsTarget.displayName}</div>
							<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{teamDetail?.name}</div>
						</div>
					</div>
					<PermGrid value={editPermsValue} onChange={setEditPermsValue} />
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Add Team Member */}
			{modal === 'add-member' &&
				(() => {
					const eligible = members.filter((m) => !teamDetail?.members.find((tm) => tm.userId === m.userId));
					return (
						<Modal
							title="Add Member to Team"
							onClose={() => setModal(null)}
							footer={
								<>
									<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
										Cancel
									</button>
									{eligible.length > 0 && (
										<button style={{ ...commonStyles.buttonPrimary, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleAddTeamMember} disabled={saving}>
											{saving ? 'Adding\u2026' : 'Add to Team'}
										</button>
									)}
								</>
							}
						>
							<div style={S.field}>
								<div style={S.fieldLabel}>Member</div>
								{eligible.length === 0 ? (
									<div style={{ fontSize: 12, color: 'var(--rr-text-disabled)', padding: '7px 0' }}>All organization members are already in this team.</div>
								) : (
									<select value={addMemberUserId} onChange={(e) => setAddMemberUserId(e.target.value)} style={{ ...commonStyles.inputField, cursor: 'pointer' } as CSSProperties}>
										<option value="" disabled>
											Select a member…
										</option>
										{eligible.map((m) => (
											<option key={m.userId} value={m.userId}>
												{m.displayName} — {m.email}
											</option>
										))}
									</select>
								)}
							</div>
							{eligible.length > 0 && (
								<div style={{ ...S.field, marginBottom: 0 }}>
									<div style={S.fieldLabel}>Permissions</div>
									<PermGrid value={addMemberPerms} onChange={setAddMemberPerms} />
								</div>
							)}
							{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
						</Modal>
					);
				})()}

			{/* Cancel Subscription */}
			{modal === 'cancel-sub' && cancelSubAppId && (
				<Modal
					title="Cancel Subscription"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Keep Subscription
							</button>
							<button style={{ ...commonStyles.buttonDanger, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleCancelSubscription} disabled={saving}>
								{saving ? 'Cancelling\u2026' : 'Yes, Cancel'}
							</button>
						</>
					}
				>
					<p style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>
						Are you sure you want to cancel <strong style={{ color: 'var(--rr-text-primary)' }}>{appMap[cancelSubAppId]?.name ?? cancelSubAppId}</strong>? Your access will continue until the end of the current billing period, after which the subscription will not renew.
					</p>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Remove Org Member */}
			{modal === 'remove-member' && removeMemberTarget && (
				<Modal
					title={removeMemberTarget.status === 'pending' ? 'Cancel Invitation' : 'Remove Member'}
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonDanger, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleRemoveMember} disabled={saving}>
								{saving ? 'Removing\u2026' : removeMemberTarget.status === 'pending' ? 'Yes, Cancel Invite' : 'Yes, Remove'}
							</button>
						</>
					}
				>
					<p style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>
						{removeMemberTarget.status === 'pending' ? (
							<>
								Are you sure you want to cancel the invitation for <strong style={{ color: 'var(--rr-text-primary)' }}>{removeMemberTarget.displayName}</strong> ({removeMemberTarget.email})?
							</>
						) : (
							<>
								Are you sure you want to remove <strong style={{ color: 'var(--rr-text-primary)' }}>{removeMemberTarget.displayName}</strong> ({removeMemberTarget.email}) from the organization?
							</>
						)}
					</p>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Remove Team Member */}
			{modal === 'remove-team-member' && removeTeamMemberTarget && (
				<Modal
					title="Remove from Team"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonDanger, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleRemoveTeamMember} disabled={saving}>
								{saving ? 'Removing\u2026' : 'Yes, Remove'}
							</button>
						</>
					}
				>
					<p style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>
						Are you sure you want to remove <strong style={{ color: 'var(--rr-text-primary)' }}>{removeTeamMemberTarget.displayName}</strong> from <strong style={{ color: 'var(--rr-text-primary)' }}>{teamDetail?.name}</strong>?
					</p>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Create Team */}
			{modal === 'create-team' && (
				<Modal
					title="Create Team"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonPrimary, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleCreateTeam} disabled={saving}>
								{saving ? 'Creating\u2026' : 'Create Team'}
							</button>
						</>
					}
				>
					<div style={S.field}>
						<div style={S.fieldLabel}>Team Name</div>
						<input value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder="e.g. Engineering, Data Science, QA" style={commonStyles.inputField} autoFocus />
						<div style={commonStyles.textMuted}>You'll be added as admin automatically.</div>
					</div>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}

			{/* Delete Team */}
			{modal === 'delete-team' && deleteTeamId && (
				<Modal
					title="Delete Team"
					onClose={() => setModal(null)}
					footer={
						<>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={() => setModal(null)}>
								Cancel
							</button>
							<button style={{ ...commonStyles.buttonDanger, ...(saving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={handleDeleteTeam} disabled={saving}>
								{saving ? 'Deleting\u2026' : 'Yes, Delete'}
							</button>
						</>
					}
				>
					<p style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>
						Are you sure you want to delete <strong style={{ color: 'var(--rr-text-primary)' }}>{teams.find((t) => t.id === deleteTeamId)?.name ?? 'this team'}</strong>? Members will not be removed from the organization.
					</p>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}
		</div>
	);
};

export default AccountView;
