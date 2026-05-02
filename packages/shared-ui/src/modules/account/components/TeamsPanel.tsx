// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TeamsPanel — the Teams tab within AccountView.
 *
 * Renders either a flat list of all teams (when `activeTeamId` is null) or a
 * drill-down detail view for a single team (when a team has been selected).
 * The detail view lists members with permission pills and provides controls to
 * add/remove members, edit permissions, and delete the team.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, TeamRecord, TeamDetail, TeamMemberRecord } from '../types';
import { S, PermPill, Avatar, avatarColor } from './shared';

// =============================================================================
// DANGER ZONE STYLES
// =============================================================================

/** Styles for the danger zone section at the bottom of the team detail view. */
const dangerStyles = {
	/** Red-tinted bordered box that groups destructive actions. */
	zone: { border: '1px solid var(--rr-color-error)', borderRadius: 9, overflow: 'hidden', marginBottom: 14, marginTop: 20 } as CSSProperties,
	/** Header bar inside the danger zone. */
	hdr: { padding: '10px 18px', background: 'var(--rr-bg-surface-alt)', borderBottom: '1px solid var(--rr-border)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px', color: 'var(--rr-color-error)' } as CSSProperties,
	/** Horizontal row inside the danger zone that pairs a description with an action button. */
	row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px' } as CSSProperties,
	/** Bold label text for a danger-zone action. */
	label: { fontSize: 12, fontWeight: 500, color: 'var(--rr-text-primary)', marginBottom: 2 } as CSSProperties,
	/** Descriptive sub-text for a danger-zone action. */
	desc: { fontSize: 11, color: 'var(--rr-text-secondary)' } as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the TeamsPanel component. */
export interface TeamsPanelProps {
	/** Flat list of all teams in the organization. */
	teams: TeamRecord[];
	/** Full detail for the currently selected team, or null when none is selected. */
	teamDetail: TeamDetail | null;
	/** ID of the team currently being drilled into, or null for the list view. */
	activeTeamId: string | null;
	/** The current user's profile, used to suppress self-removal controls. */
	profile: ConnectResult | null;
	/** Drills into the detail view for the given team ID. */
	onSelectTeam: (id: string) => void;
	/** Returns from team detail back to the flat team list. */
	onBack: () => void;
	/** Opens the Create Team modal. */
	onCreateTeam: () => void;
	/** Opens the Add Member to Team modal. */
	onAddMember: () => void;
	/** Opens the Edit Permissions modal for a team member. */
	onEditPerms: (m: TeamMemberRecord) => void;
	/** Opens the remove-from-team confirmation modal. */
	onRemoveMember: (userId: string, displayName: string) => void;
	/** Immediately deletes the given team. */
	onDeleteTeam: (id: string) => void;
	/** True when the current user has org.admin permissions. */
	isOrgAdmin: boolean;
	/** True when the current user has team.admin on the active team. */
	isTeamAdmin: boolean;
}

// =============================================================================
// TEAMS PANEL
// =============================================================================

/**
 * The Teams tab panel.
 *
 * Renders either a flat list of all teams (when `activeTeamId` is null) or a
 * drill-down detail view for a single team (when a team has been selected).
 * The detail view lists members with permission pills and provides controls to
 * add/remove members, edit permissions, and delete the team.
 */
export const TeamsPanel: React.FC<TeamsPanelProps> = ({ teams, teamDetail, activeTeamId, profile, onSelectTeam, onBack, onCreateTeam, onAddMember, onEditPerms, onRemoveMember, onDeleteTeam, isOrgAdmin, isTeamAdmin }) => {
	// -- Detail view -- shown when a team row has been clicked
	if (activeTeamId && teamDetail) {
		return (
			<section>
				<div style={{ ...commonStyles.card, marginBottom: 14 }}>
					<div style={commonStyles.cardHeader}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
							<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.buttonSmall, border: 'none', background: 'transparent' } as CSSProperties} onClick={onBack}>
								{'\u2190'}
							</button>
							<div style={{ width: 22, height: 22, borderRadius: 5, background: teamDetail.color || avatarColor(teamDetail.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{teamDetail.name[0]}</div>
							<span>
								{teamDetail.name} — {teamDetail.members.length} member{teamDetail.members.length !== 1 ? 's' : ''}
							</span>
						</div>
						{isTeamAdmin && (
							<button style={commonStyles.buttonPrimarySmall as CSSProperties} onClick={onAddMember}>
								+ Add Member
							</button>
						)}
					</div>
					<div style={S.rowList}>
						{teamDetail.members.map((m, i) => (
							<div key={m.userId} style={{ ...S.rowItem, borderBottom: i < teamDetail.members.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
								<Avatar name={m.displayName} email={m.email} size={28} />
								<div style={S.rowInfo}>
									<div style={S.rowName}>{m.displayName}</div>
									<div style={commonStyles.textMuted}>{m.email}</div>
									<div style={S.perms}>
										{m.permissions.map((p) => (
											<PermPill key={p} perm={p} />
										))}
									</div>
								</div>
								{/* Hide edit/remove controls for the current user and non-team-admins. */}
								{isTeamAdmin && m.userId !== profile?.userId && (
									<div style={S.rowActions}>
										<button style={commonStyles.buttonSecondarySmall as CSSProperties} onClick={() => onEditPerms(m)}>
											Edit Perms
										</button>
										<button style={commonStyles.buttonSecondarySmall as CSSProperties} onClick={() => onRemoveMember(m.userId, m.displayName)}>
											Remove
										</button>
									</div>
								)}
							</div>
						))}
					</div>
				</div>

				{isTeamAdmin && (
					<div style={dangerStyles.zone}>
						<div style={dangerStyles.hdr}>Danger Zone</div>
						<div style={dangerStyles.row}>
							<div>
								<div style={dangerStyles.label}>Delete Team</div>
								<div style={dangerStyles.desc}>Members are not deleted from the organization.</div>
							</div>
							<button style={commonStyles.buttonDanger as CSSProperties} onClick={() => onDeleteTeam(teamDetail.id)}>
								Delete
							</button>
						</div>
					</div>
				)}
			</section>
		);
	}

	// -- List view -- default when no team is selected
	return (
		<section>
			<div style={{ ...commonStyles.card, marginBottom: 14 }}>
				<div style={commonStyles.cardHeader}>
					<span>
						Teams — {teams.length} team{teams.length !== 1 ? 's' : ''}
					</span>
					{isOrgAdmin && (
						<button style={commonStyles.buttonPrimarySmall as CSSProperties} onClick={onCreateTeam}>
							+ New Team
						</button>
					)}
				</div>
				<div style={S.rowList}>
					{teams.map((t, i) => (
						<div key={t.id} onClick={() => onSelectTeam(t.id)} style={{ ...S.rowItem, cursor: 'pointer', borderBottom: i < teams.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
							<div style={{ width: 32, height: 32, borderRadius: 7, background: t.color || avatarColor(t.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{t.name[0]}</div>
							<div style={S.rowInfo}>
								<div style={S.rowName}>{t.name}</div>
								<div style={commonStyles.textMuted}>
									{t.memberCount} member{t.memberCount !== 1 ? 's' : ''}
								</div>
							</div>
							{/* stopPropagation prevents the row's onClick from firing twice when the button is clicked directly. */}
							<button
								style={commonStyles.buttonSecondarySmall as CSSProperties}
								onClick={(e) => {
									e?.stopPropagation?.();
									onSelectTeam(t.id);
								}}
							>
								Manage {'\u2192'}
							</button>
						</div>
					))}
					{teams.length === 0 && <div style={{ padding: '20px 18px', color: 'var(--rr-text-disabled)', fontSize: 12 }}>No teams yet.</div>}
				</div>
			</div>
		</section>
	);
};
