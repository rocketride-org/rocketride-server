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

import React, { useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import type { ITabPanelTab, ITabPanelPanel } from '../../components/tab-panel/TabPanel';
import type { ConnectResult, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, TeamMemberRecord, AccountSection, ProfileUpdate } from './types';
import { ProfilePanel } from './components/ProfilePanel';
import { ApiKeysPanel } from './components/ApiKeysPanel';
import { OrganizationPanel } from './components/OrganizationPanel';
import { TeamsPanel } from './components/TeamsPanel';
import { MembersPanel } from './components/MembersPanel';
import { S, Btn, Modal, PermGrid, ExpiryOpts, Avatar, relativeTime } from './components/shared';

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

/** Tab content area — top padding clears the overlay pill bar (15px + 38px + 15px + 11px buffer). */
const tabContent: CSSProperties = {
	padding: '79px 32px 60px',
	overflow: 'auto',
	flex: 1,
	minHeight: 0,
	maxWidth: 640,
	margin: '0 auto',
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
	/** Triggers the logout flow. */
	onLogout: () => void;
	/** Permanently deletes the user account. */
	onDeleteAccount: () => Promise<void>;
	/** Persists an updated organization name. */
	onSaveOrgName: (name: string) => Promise<void>;
	/** Creates a new API key and returns the raw key string. */
	onCreateKey: (params: { name: string; teamId: string; permissions: string[]; expiresAt?: string }) => Promise<{ key: string }>;
	/** Revokes an API key by its ID. */
	onRevokeKey: (keyId: string) => Promise<void>;
	/** Sends an invitation to a new organization member. */
	onInviteMember: (params: { email: string; givenName: string; familyName: string; role: string }) => Promise<void>;
	/** Updates an organization member's role. */
	onUpdateMemberRole: (userId: string, role: string) => Promise<void>;
	/** Removes an organization member. */
	onRemoveMember: (userId: string) => Promise<void>;
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
	const { isConnected, profile, authUser, keys, org, members, teams, teamDetail, section, onSectionChange, activeTeamId, onActiveTeamIdChange, onSaveProfile, onSetDefaultTeam, onLogout, onDeleteAccount, onSaveOrgName, onCreateKey, onRevokeKey, onInviteMember, onUpdateMemberRole, onRemoveMember, onCreateTeam, onDeleteTeam, onAddTeamMember, onEditTeamMemberPerms, onRemoveTeamMember, onLoadTeamDetail } = props;

	// =========================================================================
	// MODAL STATE
	// =========================================================================

	/** Union of all modal identifiers; null means no modal is open. */
	type ModalId = 'create-key' | 'reveal-key' | 'revoke-key' | 'invite' | 'change-role' | 'edit-perms' | 'add-member' | 'create-team' | null;
	const [modal, setModal] = useState<ModalId>(null);

	// -- Modal form state -- one group of fields per modal dialog.
	const [newKeyName, setNewKeyName] = useState('');
	const [newKeyTeamId, setNewKeyTeamId] = useState('');
	const [newKeyPerms, setNewKeyPerms] = useState<string[]>(['task.control', 'task.monitor']);
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
	const [editRoleTarget, setEditRoleTarget] = useState<MemberRecord | null>(null);
	const [editRoleValue, setEditRoleValue] = useState('member');
	const [editPermsTarget, setEditPermsTarget] = useState<TeamMemberRecord | null>(null);
	const [editPermsValue, setEditPermsValue] = useState<string[]>([]);
	const [addMemberUserId, setAddMemberUserId] = useState('');
	const [addMemberPerms, setAddMemberPerms] = useState<string[]>(['task.control', 'task.monitor']);
	const [newTeamName, setNewTeamName] = useState('');
	/** Shared saving flag used by all modal submit handlers. */
	const [saving, setSaving] = useState(false);
	/** Shared error string shown inside the active modal on failure. */
	const [saveError, setSaveError] = useState<string | null>(null);

	// -- Org edit state -- separate from saving/saveError so it doesn't conflict with modal state.
	const [editOrgName, setEditOrgName] = useState(org?.name || '');
	const [orgSaving, setOrgSaving] = useState(false);
	const [orgError, setOrgError] = useState<string | null>(null);

	// Re-sync the org name field when the org data changes.
	React.useEffect(() => {
		if (org?.name) setEditOrgName(org.name);
	}, [org?.name]);

	// =========================================================================
	// ORG SAVE
	// =========================================================================

	/** Validates and persists the edited organization name. */
	const saveOrgName = async () => {
		const trimmed = editOrgName.trim();
		// Step 1: validate the input.
		if (!trimmed) {
			setOrgError('Name cannot be empty');
			return;
		}
		// Step 2: call the host callback.
		setOrgSaving(true);
		setOrgError(null);
		try {
			await onSaveOrgName(trimmed);
		} catch (e) {
			setOrgError(e instanceof Error ? e.message : 'Save failed');
		} finally {
			setOrgSaving(false);
		}
	};

	// =========================================================================
	// CREATE KEY
	// =========================================================================

	/**
	 * Submits the new API key form.
	 * On success, transitions to the "reveal-key" modal to display the raw key
	 * value (which the server will never return again after this point).
	 */
	const handleCreateKey = async () => {
		// Step 1: validate required fields.
		if (!newKeyName.trim() || !newKeyTeamId) {
			setSaveError('Name and team are required');
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			// Step 2: convert the selected number of days to an ISO expiry timestamp, or omit for no expiry.
			const expiresAt = newKeyExpiry ? new Date(Date.now() + newKeyExpiry * 86400000).toISOString() : undefined;
			// Step 3: call the host callback.
			const body = await onCreateKey({ name: newKeyName.trim(), teamId: newKeyTeamId, permissions: newKeyPerms, ...(expiresAt ? { expiresAt } : {}) });
			// Step 4: transition to the reveal modal.
			setRevealedKey({ key: body.key, record: { id: '', name: newKeyName.trim(), teamId: newKeyTeamId, teamName: teams.find((t) => t.id === newKeyTeamId)?.name || null, permissions: newKeyPerms, createdAt: new Date().toISOString(), expiresAt: expiresAt || null } });
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
			// Step 2: call the host callback.
			await onInviteMember({ email: inviteEmail.trim(), givenName: inviteGivenName.trim(), familyName: inviteFamilyName.trim(), role: inviteRole });
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

	/**
	 * Immediately removes an organization member (or cancels a pending invitation).
	 * @param userId - The ID of the member to remove.
	 */
	const handleRemoveMember = async (userId: string) => {
		try {
			await onRemoveMember(userId);
		} catch (e) {
			console.log('remove member error:', e);
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
	const handleDeleteTeam = async (teamId: string) => {
		try {
			await onDeleteTeam(teamId);
			onActiveTeamIdChange(null);
		} catch (e) {
			console.log('delete team error:', e);
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

	/**
	 * Removes a member from the current team.
	 * @param userId - The ID of the user to remove from the team.
	 */
	const handleRemoveTeamMember = async (userId: string) => {
		if (!teamDetail) return;
		try {
			await onRemoveTeamMember({ teamId: teamDetail.id, userId });
		} catch (e) {
			console.log('remove team member error:', e);
		}
	};

	// =========================================================================
	// MODAL OPEN HELPERS
	// =========================================================================

	/** Resets the create-key form fields and opens the modal. */
	const openCreateKey = () => {
		setNewKeyName('');
		setNewKeyTeamId(teams[0]?.id || '');
		setNewKeyPerms(['task.control', 'task.monitor']);
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
			{ id: 'api-keys', label: 'API Keys', badge: keys.filter((k) => k.active).length > 0 ? keys.filter((k) => k.active).length : undefined },
			{ id: 'organization', label: 'Organization' },
			{ id: 'teams', label: 'Teams', badge: teams.length > 0 ? teams.length : undefined },
			{ id: 'members', label: 'Members', badge: members.length > 0 ? members.length : undefined },
		],
		[keys, teams, members]
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
					<div style={tabContent}>
						<ProfilePanel profile={profile} authUser={authUser} onSave={onSaveProfile} onSetDefaultTeam={onSetDefaultTeam} onLogout={onLogout} onDeleteAccount={onDeleteAccount} />
					</div>
				),
			},
			'api-keys': {
				content: (
					<div style={tabContent}>
						<ApiKeysPanel keys={keys} onCreateKey={openCreateKey} onRevokeKey={openRevokeKey} />
					</div>
				),
			},
			organization: {
				content: (
					<div style={tabContent}>
						<OrganizationPanel org={org} editOrgName={editOrgName} orgSaving={orgSaving} orgError={orgError} onOrgNameChange={setEditOrgName} onOrgNameSave={saveOrgName} />
					</div>
				),
			},
			teams: {
				content: (
					<div style={tabContent}>
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
							onRemoveMember={handleRemoveTeamMember}
							onDeleteTeam={handleDeleteTeam}
						/>
					</div>
				),
			},
			members: {
				content: (
					<div style={tabContent}>
						<MembersPanel org={org} members={members} profile={profile} onInvite={openInvite} onChangeRole={openChangeRole} onRemove={handleRemoveMember} />
					</div>
				),
			},
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}),
		[profile, authUser, keys, org, editOrgName, orgSaving, orgError, teams, teamDetail, activeTeamId, members]
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
							<Btn variant="secondary" onClick={() => setModal(null)}>
								Cancel
							</Btn>
							<Btn variant="primary" onClick={handleCreateKey} disabled={saving}>
								{saving ? 'Creating\u2026' : 'Create Key'}
							</Btn>
						</>
					}
				>
					<div style={S.field}>
						<div style={S.fieldLabel}>Key Name</div>
						<input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="e.g. Production Server, CI Pipeline" style={S.fieldInput} />
					</div>
					<div style={S.field}>
						<div style={S.fieldLabel}>Team</div>
						<select value={newKeyTeamId} onChange={(e) => setNewKeyTeamId(e.target.value)} style={S.selectInput}>
							{teams.map((t) => (
								<option key={t.id} value={t.id}>
									{t.name}
								</option>
							))}
						</select>
						<div style={S.fieldHint}>This key can only start tasks within the selected team.</div>
					</div>
					<div style={{ ...S.field, marginBottom: 14 }}>
						<div style={S.fieldLabel}>Permissions</div>
						<PermGrid value={newKeyPerms} onChange={setNewKeyPerms} />
					</div>
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
						<Btn variant="primary" onClick={() => setModal(null)}>
							Done
						</Btn>
					}
				>
					<p style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
						Copy it now -- <strong style={{ color: 'var(--rr-text-primary)' }}>it won't be shown again.</strong>
					</p>
					<div style={S.revealBox}>
						<div style={S.revealLabel}>Your API Key</div>
						<div style={S.revealRow}>
							<div style={S.revealKey}>{revealedKey.key}</div>
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
						<div style={S.revealWarn}>{'\u26A0'} Store safely -- cannot be retrieved after closing.</div>
					</div>
					<div style={S.infoStrip}>
						<strong>Team:</strong> {teams.find((t) => t.id === revealedKey.record.teamId)?.name || revealedKey.record.teamId} &nbsp;{'\u00B7'}&nbsp;
						<strong>Perms:</strong> {revealedKey.record.permissions.join(', ')} &nbsp;{'\u00B7'}&nbsp;
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
							<Btn variant="secondary" onClick={() => setModal(null)}>
								Cancel
							</Btn>
							<Btn variant="danger" onClick={handleRevokeKey} disabled={saving}>
								{saving ? 'Revoking\u2026' : 'Revoke Key'}
							</Btn>
						</>
					}
				>
					<div style={{ fontSize: 13, fontWeight: 700, color: 'var(--rr-text-primary)', marginBottom: 2 }}>{revokeTarget.name}</div>
					<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)', marginBottom: 14 }}>
						{revokeTarget.teamName} {'\u00B7'} Last used {relativeTime(revokeTarget.lastUsedAt)}
					</div>
					<div style={{ display: 'flex', gap: 10, background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-color-error)', borderRadius: 7, padding: 12 }}>
						<span style={{ fontSize: 16, flexShrink: 0 }}>{'\u26A0'}</span>
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
							<Btn variant="secondary" onClick={() => setModal(null)}>
								Cancel
							</Btn>
							<Btn variant="primary" onClick={handleInvite} disabled={saving}>
								{saving ? 'Inviting\u2026' : 'Send Invite'}
							</Btn>
						</>
					}
				>
					<div style={S.field}>
						<div style={S.fieldLabel}>Email Address</div>
						<input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@acme.com" style={S.fieldInput} autoFocus />
					</div>
					<div style={S.fieldRow}>
						<div style={S.field}>
							<div style={S.fieldLabel}>First Name</div>
							<input value={inviteGivenName} onChange={(e) => setInviteGivenName(e.target.value)} placeholder="Jane" style={S.fieldInput} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Last Name</div>
							<input value={inviteFamilyName} onChange={(e) => setInviteFamilyName(e.target.value)} placeholder="Smith" style={S.fieldInput} />
						</div>
					</div>
					<div style={S.field}>
						<div style={S.fieldLabel}>Organization Role</div>
						<select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} style={S.selectInput}>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</div>
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
							<Btn variant="secondary" onClick={() => setModal(null)}>
								Cancel
							</Btn>
							<Btn variant="primary" onClick={handleUpdateRole} disabled={saving}>
								{saving ? 'Saving\u2026' : 'Save'}
							</Btn>
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
						<select value={editRoleValue} onChange={(e) => setEditRoleValue(e.target.value)} style={S.selectInput}>
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
							<Btn variant="secondary" onClick={() => setModal(null)}>
								Cancel
							</Btn>
							<Btn variant="primary" onClick={handleEditPerms} disabled={saving}>
								{saving ? 'Saving\u2026' : 'Save Permissions'}
							</Btn>
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
									<Btn variant="secondary" onClick={() => setModal(null)}>
										Cancel
									</Btn>
									{eligible.length > 0 && (
										<Btn variant="primary" onClick={handleAddTeamMember} disabled={saving}>
											{saving ? 'Adding\u2026' : 'Add to Team'}
										</Btn>
									)}
								</>
							}
						>
							<div style={S.field}>
								<div style={S.fieldLabel}>Member</div>
								{eligible.length === 0 ? (
									<div style={{ fontSize: 12, color: 'var(--rr-text-disabled)', padding: '7px 0' }}>All organization members are already in this team.</div>
								) : (
									<select value={addMemberUserId} onChange={(e) => setAddMemberUserId(e.target.value)} style={S.selectInput}>
										<option value="" disabled>
											Select a member\u2026
										</option>
										{eligible.map((m) => (
											<option key={m.userId} value={m.userId}>
												{m.displayName} \u2014 {m.email}
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

			{/* Create Team */}
			{modal === 'create-team' && (
				<Modal
					title="Create Team"
					onClose={() => setModal(null)}
					footer={
						<>
							<Btn variant="secondary" onClick={() => setModal(null)}>
								Cancel
							</Btn>
							<Btn variant="primary" onClick={handleCreateTeam} disabled={saving}>
								{saving ? 'Creating\u2026' : 'Create Team'}
							</Btn>
						</>
					}
				>
					<div style={S.field}>
						<div style={S.fieldLabel}>Team Name</div>
						<input value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder="e.g. Engineering, Data Science, QA" style={S.fieldInput} autoFocus />
						<div style={S.fieldHint}>You'll be added as admin automatically.</div>
					</div>
					{saveError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 8 }}>{saveError}</div>}
				</Modal>
			)}
		</div>
	);
};

export default AccountView;
