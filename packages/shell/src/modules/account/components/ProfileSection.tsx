// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProfileSection — the COLLAPSED Account→Profile pane (Mockup D).
 *
 * The old Organization / Teams / Members tabs were three doors to one thing:
 * the workspace you are in. This section is that one thing:
 *
 *   - identity card (ProfilePanel in identity-only mode — same edit flow),
 *   - the WORKSPACE card, whose picker is the section's MASTER CONTROL:
 *     switching commits immediately (setDefaultOrg → org-changed push → the
 *     whole product rescopes; no staged state), and everything beneath it —
 *     your dev team, the people, the teams — belongs to the selected
 *     workspace by construction,
 *   - "Manage workspaces…" opens the standard right record-drawer: per-row
 *     Rename (admins, the old Organization tab), plus Leave / Delete / New
 *     workspace — GATED until the server ships the `rrext_account_org`
 *     create/leave/delete verbs (see docs/development/engine/rrext-account-org.md).
 */

import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DetailPanel } from '../../../components/detail-panel/DetailPanel';
import { Banner } from '../../../components/banner/Banner';
import type { ConnectResult, MemberRecord, TeamRecord, TeamDetail, ProfileUpdate } from '../types';
import { ProfilePanel } from './ProfilePanel';
import { MembersPanel } from './MembersPanel';
import { TeamsPanel } from './TeamsPanel';
import { Badge, Avatar } from './shared';

// =============================================================================
// FEATURE GATE
// =============================================================================

/** Whether the server ships the `rrext_account_org` create/leave/delete
 *  verbs (the Phase-0 backend contract). Until then the actions render
 *  DISABLED with an explanation — flipping this constant arms them. */
const WORKSPACE_LIFECYCLE_VERBS = false;

const GATE_TOOLTIP = 'Not available yet — requires server support for workspace create/leave/delete.';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	stack: { display: 'flex', flexDirection: 'column', gap: 16 } as CSSProperties,
	headRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 1 } as CSSProperties,
	hint: { fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.5, margin: '0 0 12px' } as CSSProperties,
	fieldLabel: { ...commonStyles.labelUppercase, marginBottom: 6, display: 'block' } as CSSProperties,
	subStack: { display: 'flex', flexDirection: 'column', gap: 14, padding: '0 16px 16px' } as CSSProperties,
	teamNote: { fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.5, padding: '2px 2px 0' } as CSSProperties,
	drawerRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	drawerName: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)' } as CSSProperties,
	drawerActions: { display: 'flex', gap: 6 } as CSSProperties,
	drawerFoot: { paddingTop: 12 } as CSSProperties,
	renameInput: { ...commonStyles.inputField, flex: 1, minWidth: 0 } as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/** Everything the collapsed Profile pane needs — the same data and callbacks
 *  the old Profile/Organization/Teams/Members tabs received, in one place. */
export interface IProfileSectionProps {
	profile: ConnectResult | null;
	authUser: ConnectResult | null;
	members: MemberRecord[];
	teams: TeamRecord[];
	teamDetail: TeamDetail | null;
	activeTeamId: string | null;
	isOrgAdmin: boolean;
	isActiveTeamAdmin: boolean;
	onActiveTeamIdChange: (id: string | null) => void;
	onLoadTeamDetail: (teamId: string) => void;
	onSaveProfile: (fields: ProfileUpdate) => Promise<void>;
	onSetDevTeam: (teamId: string) => Promise<void>;
	onSetDefaultOrg: (orgId: string) => Promise<void>;
	/** Renames ANY workspace the user administers (drawer per-row rename). */
	onRenameWorkspace: (orgId: string, name: string) => Promise<void>;
	onInviteMember: IParamsOf<'invite'>;
	onUpdateMemberRole: (userId: string, role: string) => Promise<void>;
	onRemoveMember: (userId: string) => Promise<void>;
	onResendInvite: (userId: string) => Promise<void>;
	onCreateTeam: (name: string) => Promise<void>;
	onDeleteTeam: (teamId: string) => Promise<void>;
	onAddTeamMember: (params: { teamId: string; userId: string; permissions: string[] }) => Promise<void>;
	onEditTeamMemberPerms: (params: { teamId: string; userId: string; permissions: string[] }) => Promise<void>;
	onRemoveTeamMember: (params: { teamId: string; userId: string }) => Promise<void>;
}

/** The invite callback's shape (kept structural — matches MembersPanel). */
type IParamsOf<T extends 'invite'> = T extends 'invite'
	? (params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> }) => Promise<void>
	: never;

// =============================================================================
// MANAGE WORKSPACES DRAWER
// =============================================================================

/** The right record-drawer listing every workspace the user belongs to. */
const ManageWorkspacesDrawer: React.FC<{
	memberships: NonNullable<ConnectResult['memberships']>;
	defaultOrgId: string | undefined;
	onClose: () => void;
	onRename: (orgId: string, name: string) => Promise<void>;
}> = ({ memberships, defaultOrgId, onClose, onRename }) => {
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const commitRename = async (orgId: string): Promise<void> => {
		if (!renameValue.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await onRename(orgId, renameValue.trim());
			setRenamingId(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Rename failed');
		} finally {
			setBusy(false);
		}
	};

	return (
		<DetailPanel persistKey="panelDetailWorkspaces" contained open onClose={onClose} title="Workspaces" subtitle="Every workspace you belong to">
			{error && (
				<div style={{ marginBottom: 12 }}>
					<Banner variant="error">{error}</Banner>
				</div>
			)}
			{memberships.map((o) => {
				const isAdmin = o.permissions?.includes('org.admin') ?? false;
				const isActive = o.id === defaultOrgId;
				return (
					<div key={o.id} style={styles.drawerRow}>
						<Avatar name={o.name} size={24} square />
						{renamingId === o.id ? (
							<>
								<input style={styles.renameInput} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(o.id); }} data-rr-autofocus="true" />
								<div style={styles.drawerActions}>
									<Button variant="primary" small disabled={busy || !renameValue.trim()} onClick={() => void commitRename(o.id)}>Save</Button>
									<Button variant="ghost" small disabled={busy} onClick={() => setRenamingId(null)}>Cancel</Button>
								</div>
							</>
						) : (
							<>
								<div style={styles.drawerName}>
									{o.name} {isAdmin && <Badge variant="admin">Admin</Badge>} {isActive && <Badge variant="active">Current</Badge>}
								</div>
								<div style={styles.drawerActions}>
									{isAdmin && (
										<Button variant="ghost" small onClick={() => { setRenamingId(o.id); setRenameValue(o.name); }}>Rename</Button>
									)}
									<Button variant="ghost" small disabled={!WORKSPACE_LIFECYCLE_VERBS} title={WORKSPACE_LIFECYCLE_VERBS ? undefined : GATE_TOOLTIP}>Leave</Button>
									{isAdmin && (
										<Button variant="ghost" small disabled={!WORKSPACE_LIFECYCLE_VERBS} title={WORKSPACE_LIFECYCLE_VERBS ? undefined : GATE_TOOLTIP}>Delete</Button>
									)}
								</div>
							</>
						)}
					</div>
				);
			})}
			<div style={styles.drawerFoot}>
				<Button variant="ghost" small disabled={!WORKSPACE_LIFECYCLE_VERBS} title={WORKSPACE_LIFECYCLE_VERBS ? undefined : GATE_TOOLTIP}>
					New workspace…
				</Button>
			</div>
		</DetailPanel>
	);
};

// =============================================================================
// PROFILE SECTION
// =============================================================================

/**
 * The collapsed Profile pane: identity + the workspace master card.
 */
export const ProfileSection: React.FC<IProfileSectionProps> = (props) => {
	const { profile, authUser, members, teams, teamDetail, activeTeamId, isOrgAdmin, isActiveTeamAdmin, onActiveTeamIdChange, onLoadTeamDetail, onSaveProfile, onSetDevTeam, onSetDefaultOrg, onRenameWorkspace, onInviteMember, onUpdateMemberRole, onRemoveMember, onResendInvite, onCreateTeam, onDeleteTeam, onAddTeamMember, onEditTeamMemberPerms, onRemoveTeamMember } = props;

	const [manageOpen, setManageOpen] = useState(false);

	const org = profile?.organization ?? authUser?.organization ?? null;
	const memberships = profile?.memberships ?? (org ? [org] : []);
	const defaultOrgId = profile?.defaultOrgId ?? org?.id;
	const active = useMemo(() => memberships.find((o) => o.id === defaultOrgId) ?? org, [memberships, defaultOrgId, org]);
	const activeTeams = active?.teams ?? [];
	const devTeamId = profile?.devTeam || authUser?.devTeam || '';

	return (
		<section style={styles.stack}>
			{/* ── Identity (same card + edit flow as before, memberships hidden) ── */}
			<ProfilePanel profile={profile} authUser={authUser} onSave={onSaveProfile} onSetDevTeam={(id) => void onSetDevTeam(id)} onSetDefaultOrg={(id) => void onSetDefaultOrg(id)} identityOnly />

			{/* ── THE workspace card — the picker is the section's master control ── */}
			<Card
				noBodyPadding
				header={
					<div style={styles.headRow}>
						<b>Workspace</b>
						<select
							style={{ ...commonStyles.inputField, width: 'auto', minWidth: 210 }}
							aria-label="Current workspace"
							value={defaultOrgId ?? ''}
							onChange={(e) => {
								// Commits on change — the org-changed push rescopes the
								// whole product through the one existing switch path.
								if (e.target.value && e.target.value !== defaultOrgId) void onSetDefaultOrg(e.target.value);
							}}
						>
							{memberships.map((o) => (
								<option key={o.id} value={o.id}>{o.name}</option>
							))}
						</select>
						{isOrgAdmin ? <Badge variant="admin">Admin</Badge> : <Badge variant="member">Member</Badge>}
						<div style={{ flex: 1 }} />
						<Button variant="ghost" small onClick={() => setManageOpen(true)}>Manage workspaces…</Button>
					</div>
				}
			>
				<div style={{ padding: 16 }}>
					<p style={styles.hint}>
						You belong to {memberships.length} workspace{memberships.length === 1 ? '' : 's'}. Everything below — and everything in the product: pipelines, apps, billing — belongs to the one selected here. Switching rescopes it all and is remembered for your next sign-in.
					</p>
					<span style={styles.fieldLabel}>Your development team</span>
					<select
						style={{ ...commonStyles.inputField, width: 'auto', minWidth: 210 }}
						aria-label="Development team"
						value={devTeamId}
						onChange={(e) => { if (e.target.value) void onSetDevTeam(e.target.value); }}
					>
						{!devTeamId && <option value="">Select a team…</option>}
						{activeTeams.map((t) => (
							<option key={t.id} value={t.id}>{t.name}</option>
						))}
					</select>
					<p style={{ ...styles.hint, margin: '6px 0 0' }}>
						New pipelines, dev runs, and app previews are shared with this team. Deploying to other teams is an explicit step in the Pipelines tool.
					</p>
				</div>

				{/* People + Teams live INSIDE the card the picker heads — switching
				    workspaces can never show another org's people by surprise. */}
				<div style={styles.subStack}>
					<MembersPanel members={members} teams={teams} profile={profile} isOrgAdmin={isOrgAdmin} onInviteMember={onInviteMember} onUpdateMemberRole={onUpdateMemberRole} onRemoveMember={onRemoveMember} onResendInvite={onResendInvite} />
					<TeamsPanel teams={teams} teamDetail={teamDetail} activeTeamId={activeTeamId} onActiveTeamIdChange={onActiveTeamIdChange} onLoadTeamDetail={onLoadTeamDetail} members={members} profile={profile} onCreateTeam={onCreateTeam} onDeleteTeam={onDeleteTeam} onAddTeamMember={onAddTeamMember} onEditTeamMemberPerms={onEditTeamMemberPerms} onRemoveTeamMember={onRemoveTeamMember} isOrgAdmin={isOrgAdmin} isActiveTeamAdmin={isActiveTeamAdmin} />
					<div style={styles.teamNote}>
						Teams scope where pipelines deploy and what API keys can reach. A pipeline deployed to another team is visible to that team only.
					</div>
				</div>
			</Card>

			{manageOpen && (
				<ManageWorkspacesDrawer memberships={memberships} defaultOrgId={defaultOrgId} onClose={() => setManageOpen(false)} onRename={onRenameWorkspace} />
			)}
		</section>
	);
};
