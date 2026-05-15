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
							<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardHeaderButton, border: 'none', background: 'transparent', fontSize: 20, fontWeight: 900, padding: '0 6px', lineHeight: '1rem' } as CSSProperties} onClick={onBack}>
								{'\u2190'}
							</button>
							<div style={{ width: 22, height: 22, borderRadius: 5, background: avatarColor(teamDetail.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{teamDetail.name[0]}</div>
							<span style={commonStyles.labelUppercase}>
								{teamDetail.name} — {teamDetail.members.length} member{teamDetail.members.length !== 1 ? 's' : ''}
							</span>
						</div>
						{isTeamAdmin && (
							<button style={{ ...commonStyles.buttonPrimary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onAddMember}>
								+ Add Member
							</button>
						)}
					</div>
					<div style={S.rowList}>
						{(() => {
							// Count how many team admins exist so the UI can prevent
							// the last admin from removing themselves or dropping admin.
							const adminCount = teamDetail.members.filter((m) => m.permissions.includes('team.admin')).length;

							return teamDetail.members.map((m, i) => {
								const isSelf = m.userId === profile?.userId;
								const isLastAdmin = isSelf && m.permissions.includes('team.admin') && adminCount <= 1;

								return (
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
										{isTeamAdmin && (
											<div style={S.rowActions}>
												<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => onEditPerms(m)}>
													Edit Perms
												</button>
												{/* Hide Remove if this is the last admin (team must always have one). */}
												{!isLastAdmin && (
													<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => onRemoveMember(m.userId, m.displayName)}>
														Remove
													</button>
												)}
											</div>
										)}
									</div>
								);
							});
						})()}
					</div>
				</div>
			</section>
		);
	}

	// -- List view -- default when no team is selected
	return (
		<section>
			<div style={{ ...commonStyles.card, marginBottom: 14 }}>
				<div style={commonStyles.cardHeader}>
					<span style={commonStyles.labelUppercase}>
						Teams — {teams.length} team{teams.length !== 1 ? 's' : ''}
					</span>
					{isOrgAdmin && (
						<button style={{ ...commonStyles.buttonPrimary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onCreateTeam}>
							+ New Team
						</button>
					)}
				</div>
				<div style={S.rowList}>
					{teams.map((t, i) => (
						<div key={t.id} onClick={() => onSelectTeam(t.id)} style={{ ...S.rowItem, cursor: 'pointer', borderBottom: 'none' }}>
							<div style={{ width: 32, height: 32, borderRadius: 7, background: avatarColor(t.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{t.name[0]}</div>
							<div style={S.rowInfo}>
								<div style={S.rowName}>{t.name}</div>
								<div style={commonStyles.textMuted}>
									{t.memberCount} member{t.memberCount !== 1 ? 's' : ''}
								</div>
							</div>
							<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
								{isOrgAdmin && (
									<button
										style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties}
										onClick={(e) => {
											e.stopPropagation();
											onDeleteTeam(t.id);
										}}
									>
										Delete
									</button>
								)}
								<button
									style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties}
									onClick={(e) => {
										e.stopPropagation();
										onSelectTeam(t.id);
									}}
								>
									Manage {'\u2192'}
								</button>
							</div>
						</div>
					))}
					{teams.length === 0 && <div style={{ padding: '20px 18px', color: 'var(--rr-text-disabled)', fontSize: 12 }}>No teams yet.</div>}
				</div>
			</div>
		</section>
	);
};
