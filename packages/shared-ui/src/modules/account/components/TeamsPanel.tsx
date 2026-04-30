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
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, TeamRecord, TeamDetail, TeamMemberRecord } from '../types';
import { S, Btn, PermPill, Avatar, avatarColor } from './shared';

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
	/** Immediately removes a user from the current team. */
	onRemoveMember: (userId: string) => void;
	/** Immediately deletes the given team. */
	onDeleteTeam: (id: string) => void;
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
export const TeamsPanel: React.FC<TeamsPanelProps> = ({ teams, teamDetail, activeTeamId, profile, onSelectTeam, onBack, onCreateTeam, onAddMember, onEditPerms, onRemoveMember, onDeleteTeam }) => {
	// -- Detail view -- shown when a team row has been clicked
	if (activeTeamId && teamDetail) {
		return (
			<section>
				<div style={commonStyles.sectionHeader}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<Btn variant="ghost" small onClick={onBack}>
							{'\u2190'} Teams
						</Btn>
						<div style={{ width: 22, height: 22, borderRadius: 5, background: teamDetail.color || avatarColor(teamDetail.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{teamDetail.name[0]}</div>
						<span style={commonStyles.sectionHeaderLabel}>{teamDetail.name}</span>
					</div>
				</div>

				<div style={{ ...commonStyles.card, marginBottom: 14 }}>
					<div style={commonStyles.cardHeader}>
						<span>
							{teamDetail.members.length} member{teamDetail.members.length !== 1 ? 's' : ''}
						</span>
						<Btn variant="primary" small onClick={onAddMember}>
							+ Add Member
						</Btn>
					</div>
					<div style={S.rowList}>
						{teamDetail.members.map((m, i) => (
							<div key={m.userId} style={{ ...S.rowItem, borderBottom: i < teamDetail.members.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
								<Avatar name={m.displayName} email={m.email} size={28} />
								<div style={S.rowInfo}>
									<div style={S.rowName}>{m.displayName}</div>
									<div style={S.rowSub}>{m.email}</div>
									<div style={S.perms}>
										{m.permissions.map((p) => (
											<PermPill key={p} perm={p} />
										))}
									</div>
								</div>
								{/* Hide edit/remove controls for the current user to prevent self-removal. */}
								{m.userId !== profile?.userId && (
									<div style={S.rowActions}>
										<Btn variant="secondary" small onClick={() => onEditPerms(m)}>
											Edit Perms
										</Btn>
										<Btn variant="danger" small onClick={() => onRemoveMember(m.userId)}>
											Remove
										</Btn>
									</div>
								)}
							</div>
						))}
					</div>
				</div>

				<div style={S.dangerZone}>
					<div style={S.dangerHdr}>Danger Zone</div>
					<div style={S.dangerRow}>
						<div>
							<div style={S.dangerLabel}>Delete Team</div>
							<div style={S.dangerDesc}>Members are not deleted from the organization.</div>
						</div>
						<Btn variant="danger" onClick={() => onDeleteTeam(teamDetail.id)}>
							Delete
						</Btn>
					</div>
				</div>
			</section>
		);
	}

	// -- List view -- default when no team is selected
	return (
		<section>
			<div style={commonStyles.sectionHeader}>
				<span style={commonStyles.sectionHeaderLabel}>Teams</span>
			</div>

			<div style={{ ...commonStyles.card, marginBottom: 14 }}>
				<div style={commonStyles.cardHeader}>
					<span>
						{teams.length} team{teams.length !== 1 ? 's' : ''}
					</span>
					<Btn variant="primary" small onClick={onCreateTeam}>
						+ New Team
					</Btn>
				</div>
				<div style={S.rowList}>
					{teams.map((t, i) => (
						<div key={t.id} onClick={() => onSelectTeam(t.id)} style={{ ...S.rowItem, cursor: 'pointer', borderBottom: i < teams.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
							<div style={{ width: 32, height: 32, borderRadius: 7, background: t.color || avatarColor(t.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{t.name[0]}</div>
							<div style={S.rowInfo}>
								<div style={S.rowName}>{t.name}</div>
								<div style={S.rowSub}>
									{t.memberCount} member{t.memberCount !== 1 ? 's' : ''}
								</div>
							</div>
							{/* stopPropagation prevents the row's onClick from firing twice when the button is clicked directly. */}
							<Btn
								variant="secondary"
								small
								onClick={(e) => {
									e?.stopPropagation?.();
									onSelectTeam(t.id);
								}}
							>
								Manage {'\u2192'}
							</Btn>
						</div>
					))}
					{teams.length === 0 && <div style={{ padding: '20px 18px', color: 'var(--rr-text-disabled)', fontSize: 12 }}>No teams yet.</div>}
				</div>
			</div>
		</section>
	);
};
