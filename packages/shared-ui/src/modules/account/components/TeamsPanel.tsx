// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TeamsPanel — the Teams tab within AccountView.
 *
 * Renders either a flat list of all teams (when `activeTeamId` is null) or a
 * drill-down detail view for a single team (when a team has been selected).
 * Both views are stock Cards with stock DataTable bodies: the list view shows
 * team name and member count with Delete / Manage actions; the detail view
 * lists members with permission pills and Edit Perms / Remove actions.
 */

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataTable } from '../../../components/data-table/DataTable';
import type { DataTableColumn } from '../../../components/data-table/DataTable';
import { createArrayDataSource } from '../../../components/data-table/dataSource';
import type { ConnectResult, TeamRecord, TeamDetail, TeamMemberRecord } from '../types';
import { S, PermPill, Avatar, avatarColor } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Horizontal cluster inside a table cell (avatar + text). */
	cellCluster: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as CSSProperties,

	/** Detail-view header cluster: back button + team avatar + label. */
	detailHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,

	/**
	 * Deterministic-color initial chip for a team.
	 *
	 * @param name - Team name seeding the color and initial.
	 * @param size - Chip edge length in pixels.
	 */
	teamChip: (name: string, size: number): CSSProperties => ({
		width: size,
		height: size,
		borderRadius: size >= 32 ? 7 : 5,
		background: avatarColor(name),
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: Math.round(size * 0.4),
		fontWeight: 700,
		color: 'var(--rr-fg-button)',
		flexShrink: 0,
	}),

	/** Buttons inside a row-actions cell, spaced like the DataTable spec. */
	rowButtons: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 5,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Flattened row shape fed to the teams list DataTable. */
interface TeamRow extends Record<string, unknown> {
	/** Team id — used to resolve callbacks. */
	id: string;
	/** Team display name. */
	name: string;
	/** Current member count. */
	members: number;
}

/** Flattened row shape fed to the team-detail members DataTable. */
interface TeamMemberRow extends Record<string, unknown> {
	/** Member user id — used to resolve callbacks. */
	userId: string;
	/** Member display name. */
	displayName: string;
	/** Member email address. */
	email: string;
	/** Permission keys held within the team. */
	permissions: string[];
}

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
// TEAM DETAIL VIEW
// =============================================================================

/** Props for the internal team-detail members view. */
interface TeamDetailViewProps {
	/** Full detail for the selected team. */
	teamDetail: TeamDetail;
	/** The current user's profile, used to suppress self-removal controls. */
	profile: ConnectResult | null;
	/** Returns from team detail back to the flat team list. */
	onBack: () => void;
	/** Opens the Add Member to Team modal. */
	onAddMember: () => void;
	/** Opens the Edit Permissions modal for a team member. */
	onEditPerms: (m: TeamMemberRecord) => void;
	/** Opens the remove-from-team confirmation modal. */
	onRemoveMember: (userId: string, displayName: string) => void;
	/** True when the current user has team.admin on the active team. */
	isTeamAdmin: boolean;
}

/**
 * Drill-down view for a single team: a Card whose header carries a back
 * button, the team chip, and the member count, and whose body is a DataTable
 * of the team's members with permission pills and admin actions.
 */
const TeamDetailView: React.FC<TeamDetailViewProps> = ({ teamDetail, profile, onBack, onAddMember, onEditPerms, onRemoveMember, isTeamAdmin }) => {
	// Flatten member records into table rows.
	const rows = useMemo<TeamMemberRow[]>(
		() =>
			teamDetail.members.map((m) => ({
				userId: m.userId,
				displayName: m.displayName,
				email: m.email,
				permissions: m.permissions,
			})),
		[teamDetail.members]
	);

	// Client-side data source over the member rows.
	const source = useMemo(() => createArrayDataSource<TeamMemberRow>(rows), [rows]);

	// Count team admins so the last admin cannot remove themselves.
	const adminCount = useMemo(() => teamDetail.members.filter((m) => m.permissions.includes('team.admin')).length, [teamDetail.members]);

	// Column definitions; cells keep the existing avatar / pill renderings.
	const columns = useMemo<DataTableColumn<TeamMemberRow>[]>(
		() => [
			{
				key: 'displayName',
				label: 'Member',
				sortable: true,
				render: (row) => (
					<div style={styles.cellCluster}>
						<Avatar name={row.displayName} email={row.email} size={28} />
						<span>{row.displayName}</span>
					</div>
				),
			},
			{ key: 'email', label: 'Email', sortable: true },
			{
				key: 'permissions',
				label: 'Permissions',
				render: (row) => (
					<div style={S.perms}>
						{row.permissions.map((p) => (
							<PermPill key={p} perm={p} />
						))}
					</div>
				),
			},
		],
		[]
	);

	/**
	 * Resolves a table row back to its team-member record and opens the Edit
	 * Permissions modal. No-ops if the record has vanished.
	 *
	 * @param row - The clicked table row.
	 */
	const handleEditPerms = (row: TeamMemberRow): void => {
		const record = teamDetail.members.find((m) => m.userId === row.userId);
		if (record) onEditPerms(record);
	};

	return (
		<Card
			header={
				<div style={styles.detailHeader}>
					<Button variant="ghost" small onClick={onBack} title="Back to teams">
						{'←'}
					</Button>
					<div style={styles.teamChip(teamDetail.name, 22)}>{teamDetail.name[0]}</div>
					<span>
						{teamDetail.name} — {teamDetail.members.length} member{teamDetail.members.length !== 1 ? 's' : ''}
					</span>
				</div>
			}
			headerActions={
				isTeamAdmin ? (
					<Button variant="primary" small onClick={onAddMember}>
						+ Add Member
					</Button>
				) : undefined
			}
			noBodyPadding
		>
			<DataTable<TeamMemberRow>
				columns={columns}
				source={source}
				// Edit / Remove only render for team admins; the last remaining
				// admin cannot remove themselves (a team must keep one admin).
				actions={
					isTeamAdmin
						? (row) => {
								const isSelf = row.userId === profile?.userId;
								const isLastAdmin = isSelf && row.permissions.includes('team.admin') && adminCount <= 1;
								return (
									<div style={styles.rowButtons}>
										<Button variant="ghost" small onClick={() => handleEditPerms(row)}>
											Edit Perms
										</Button>
										{!isLastAdmin && (
											<Button variant="ghost" small onClick={() => onRemoveMember(row.userId, row.displayName)}>
												Remove
											</Button>
										)}
									</div>
								);
						  }
						: undefined
				}
				emptyState={{ title: 'No members in this team yet' }}
			/>
		</Card>
	);
};

// =============================================================================
// TEAMS PANEL
// =============================================================================

/**
 * The Teams tab panel.
 *
 * Renders either a flat list of all teams (when `activeTeamId` is null) or a
 * drill-down detail view for a single team (when a team has been selected).
 */
export const TeamsPanel: React.FC<TeamsPanelProps> = ({ teams, teamDetail, activeTeamId, profile, onSelectTeam, onBack, onCreateTeam, onAddMember, onEditPerms, onRemoveMember, onDeleteTeam, isOrgAdmin, isTeamAdmin }) => {
	// Flatten team records into table rows.
	const rows = useMemo<TeamRow[]>(
		() =>
			teams.map((t) => ({
				id: t.id,
				name: t.name,
				members: t.memberCount,
			})),
		[teams]
	);

	// Client-side data source over the team rows.
	const source = useMemo(() => createArrayDataSource<TeamRow>(rows), [rows]);

	// Column definitions; the team cell keeps its color-chip rendering.
	const columns = useMemo<DataTableColumn<TeamRow>[]>(
		() => [
			{
				key: 'name',
				label: 'Team',
				sortable: true,
				render: (row) => (
					<div style={styles.cellCluster}>
						<div style={styles.teamChip(row.name, 32)}>{row.name[0]}</div>
						<span>{row.name}</span>
					</div>
				),
			},
			{
				key: 'members',
				label: 'Members',
				sortable: true,
				render: (row) => `${row.members} member${row.members !== 1 ? 's' : ''}`,
			},
		],
		[]
	);

	// -- Detail view -- shown when a team row has been clicked
	if (activeTeamId && teamDetail) {
		return (
			<section>
				<TeamDetailView teamDetail={teamDetail} profile={profile} onBack={onBack} onAddMember={onAddMember} onEditPerms={onEditPerms} onRemoveMember={onRemoveMember} isTeamAdmin={isTeamAdmin} />
			</section>
		);
	}

	// -- List view -- default when no team is selected
	return (
		<section>
			<Card
				header={`Teams — ${teams.length} team${teams.length !== 1 ? 's' : ''}`}
				headerActions={
					isOrgAdmin ? (
						<Button variant="primary" small onClick={onCreateTeam}>
							+ New Team
						</Button>
					) : undefined
				}
				noBodyPadding
			>
				<DataTable<TeamRow>
					columns={columns}
					source={source}
					onRowClick={(row) => onSelectTeam(row.id)}
					// Delete is org-admin only; Manage mirrors the row click.
					actions={(row) => (
						<div style={styles.rowButtons}>
							{isOrgAdmin && (
								<Button variant="ghost" small onClick={() => onDeleteTeam(row.id)}>
									Delete
								</Button>
							)}
							<Button variant="ghost" small onClick={() => onSelectTeam(row.id)}>
								Manage {'→'}
							</Button>
						</div>
					)}
					emptyState={{ title: 'No teams yet' }}
				/>
			</Card>
		</section>
	);
};
