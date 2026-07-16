// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TeamsPanel — the Teams tab within AccountView.
 *
 * Renders either a flat list of all teams (when `activeTeamId` is null) or a
 * drill-down detail view for a single team (when a team has been selected).
 * Both views are stock Cards with stock DataGrid bodies: the list view shows
 * team name and member count with Delete / Manage actions; the detail view
 * lists members with permission pills and Edit Perms / Remove actions.
 */

import React, { useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { CellComponent, ColumnDefinition } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataGrid } from '../../../components/data-grid/DataGrid';
import { avatarEl, buttonEl, createActionsColumn } from '../../../components/data-grid/defaults';
import type { ConnectResult, TeamRecord, TeamDetail, TeamMemberRecord } from '../types';
import { PERM_DISPLAY, initials, avatarColor } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Horizontal cluster inside a grid cell (avatar + text) — DOM style for formatters. */
	cellCluster: {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
	} as Partial<CSSStyleDeclaration>,

	/** 28px member avatar overrides applied over the stock 32px avatarEl. */
	avatarSmall: {
		width: '28px',
		height: '28px',
		fontSize: '10.6px',
		fontWeight: '700',
	} as Partial<CSSStyleDeclaration>,

	/** 32px team chip in the list-view Team cell (DOM clone of teamChip(name, 32)). */
	teamChipCell: {
		width: '32px',
		height: '32px',
		borderRadius: '7px',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: '13px',
		fontWeight: '700',
		color: 'var(--rr-fg-button)',
		flexShrink: '0',
	} as Partial<CSSStyleDeclaration>,

	/** Wrapping flex row for permission pills (DOM clone of the shared S.perms). */
	permsWrap: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '3px',
		marginTop: '4px',
	} as Partial<CSSStyleDeclaration>,

	/** Permission pill shape (commonStyles.badge values + PermPill overrides); accent colors set per pill. */
	permPill: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		padding: '1px 6px',
		fontSize: '11px',
		fontWeight: '600',
		borderRadius: '3px',
		letterSpacing: '0.3px',
		background: 'var(--rr-bg-surface-alt)',
	} as Partial<CSSStyleDeclaration>,

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
};

// =============================================================================
// CELL BUILDERS
// =============================================================================

/**
 * Builds a person cell — 28px initials avatar beside the display name (DOM
 * clone of the old Avatar + cluster cell render).
 *
 * @param displayName - Member display name (initials + color seed).
 * @param email - Fallback seed when the name is empty.
 * @returns The cluster element.
 */
function personCellEl(displayName: string, email: string): HTMLElement {
	// Cluster wrapper: avatar + name in a horizontal flex row.
	const wrap = document.createElement('div');
	Object.assign(wrap.style, styles.cellCluster);
	// Stock avatar resized to the panel's 28px spec.
	const avatar = avatarEl(initials(displayName, email), avatarColor(displayName || email));
	Object.assign(avatar.style, styles.avatarSmall);
	wrap.appendChild(avatar);
	// Display-name label.
	const name = document.createElement('span');
	name.textContent = displayName;
	wrap.appendChild(name);
	return wrap;
}

/**
 * Builds a team cell — 32px deterministic-color chip with the team's initial
 * beside the team name (DOM clone of the old teamChip + cluster cell render).
 *
 * @param name - Team display name (chip color seed and initial).
 * @returns The cluster element.
 */
function teamCellEl(name: string): HTMLElement {
	// Cluster wrapper: chip + name in a horizontal flex row.
	const wrap = document.createElement('div');
	Object.assign(wrap.style, styles.cellCluster);
	// Rounded-square chip seeded by the team name.
	const chip = document.createElement('div');
	Object.assign(chip.style, styles.teamChipCell);
	chip.style.background = avatarColor(name);
	chip.textContent = name[0] ?? '';
	wrap.appendChild(chip);
	// Team-name label.
	const label = document.createElement('span');
	label.textContent = name;
	wrap.appendChild(label);
	return wrap;
}

/**
 * Builds a permission pill (DOM clone of the shared PermPill): admin and
 * wildcard permissions use the brand accent, capability flags use info.
 *
 * @param perm - The permission key string to display.
 * @returns The pill element.
 */
function permPillEl(perm: string): HTMLElement {
	const el = document.createElement('span');
	Object.assign(el.style, styles.permPill);
	// Distinguish elevated permissions (admin/*) from standard capability flags.
	const isAdmin = perm === 'team.admin' || perm === 'org.admin' || perm === '*';
	const accent = isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)';
	el.style.color = accent;
	el.style.border = `1px solid ${accent}`;
	el.textContent = PERM_DISPLAY[perm] ?? perm;
	return el;
}

// =============================================================================
// TYPES
// =============================================================================

/** Flattened row shape fed to the teams list DataGrid. */
interface TeamRow extends Record<string, unknown> {
	/** Team id — used to resolve callbacks. */
	id: string;
	/** Team display name. */
	name: string;
	/** Current member count. */
	members: number;
}

/** Flattened row shape fed to the team-detail members DataGrid. */
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
 * button, the team chip, and the member count, and whose body is a DataGrid
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

	// Count team admins so the last admin cannot remove themselves.
	const adminCount = useMemo(() => teamDetail.members.filter((m) => m.permissions.includes('team.admin')).length, [teamDetail.members]);

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

	// Live action router — the actions column's cellClick is baked into the
	// memoized column definition, so it dispatches through this ref to always
	// reach the latest prop closures.
	const actionRef = useRef<(action: string, row: TeamMemberRow) => void>(() => undefined);
	actionRef.current = (action, row) => {
		// Route the clicked button's action key to the matching handler.
		if (action === 'edit') handleEditPerms(row);
		else if (action === 'remove') onRemoveMember(row.userId, row.displayName);
	};

	// Column definitions; cells keep the existing avatar / pill renderings.
	const columns = useMemo<ColumnDefinition[]>(() => {
		const cols: ColumnDefinition[] = [
			{
				title: 'Member',
				field: 'displayName',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as TeamMemberRow;
					return personCellEl(row.displayName, row.email);
				},
			},
			{ title: 'Email', field: 'email', headerSort: true },
			{
				title: 'Permissions',
				field: 'permissions',
				headerSort: false,
				// One pill per permission key, in a wrapping flex row.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as TeamMemberRow;
					const wrap = document.createElement('div');
					Object.assign(wrap.style, styles.permsWrap);
					for (const p of row.permissions) wrap.appendChild(permPillEl(p));
					return wrap;
				},
			},
		];
		// Edit / Remove only render for team admins; the last remaining admin
		// cannot remove themselves (a team must keep one admin). Built by hand
		// instead of createActionsColumn because the button set varies per row.
		if (isTeamAdmin) {
			cols.push({
				title: 'Actions',
				field: '__rrActions',
				width: 170,
				hozAlign: 'right',
				headerSort: false,
				headerMenu: false,
				resizable: false,
				// Formatter: Edit Perms always; Remove unless last-admin self row.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as TeamMemberRow;
					const wrap = document.createElement('span');
					wrap.dataset.rrActions = 'true';
					wrap.className = 'rr-cell-actions';
					wrap.appendChild(buttonEl('ghost', 'Edit Perms', 'edit'));
					const isSelf = row.userId === profile?.userId;
					const isLastAdmin = isSelf && row.permissions.includes('team.admin') && adminCount <= 1;
					if (!isLastAdmin) wrap.appendChild(buttonEl('ghost', 'Remove', 'remove'));
					return wrap;
				},
				// Route clicks on the buttons to the live action router by key.
				cellClick: (e: UIEvent, cell: CellComponent) => {
					const target = (e.target as HTMLElement).closest('button[data-action]');
					if (!target) return;
					actionRef.current((target as HTMLElement).dataset.action ?? '', cell.getRow().getData() as TeamMemberRow);
				},
				// `headerMenu: false` (menu-exempt column) predates the @types union
				// (see createActionsColumn in defaults.ts) — hence the two-step cast.
			} as unknown as ColumnDefinition);
		}
		return cols;
	}, [isTeamAdmin, adminCount, profile?.userId]);

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
			<DataGrid<TeamMemberRow> columns={columns} data={rows} emptyTitle="No members in this team yet" />
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

	// Live action router — the actions column's onAction is baked into the
	// memoized column definition, so it dispatches through this ref to always
	// reach the latest prop closures.
	const actionRef = useRef<(action: string, row: TeamRow) => void>(() => undefined);
	actionRef.current = (action, row) => {
		// Delete removes the team; Manage mirrors the row click into detail.
		if (action === 'delete') onDeleteTeam(row.id);
		else onSelectTeam(row.id);
	};

	// Column definitions; the team cell keeps its color-chip rendering.
	const columns = useMemo<ColumnDefinition[]>(
		() => [
			{
				title: 'Team',
				field: 'name',
				headerSort: true,
				formatter: (cell: CellComponent) => teamCellEl(String(cell.getValue() ?? '')),
			},
			{
				title: 'Members',
				field: 'members',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => {
					const n = cell.getValue() as number;
					return `${n} member${n !== 1 ? 's' : ''}`;
				},
			},
			// Trailing Actions column — Delete is org-admin only; Manage mirrors
			// the row click.
			createActionsColumn<TeamRow>({
				actions: [...(isOrgAdmin ? [{ key: 'delete', label: 'Delete' }] : []), { key: 'manage', label: 'Manage →' }],
				onAction: (key, row) => actionRef.current(key, row),
				width: isOrgAdmin ? 180 : 120,
			}),
		],
		[isOrgAdmin]
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
				<DataGrid<TeamRow> columns={columns} data={rows} onRowClick={(row) => onSelectTeam(row.id)} emptyTitle="No teams yet" />
			</Card>
		</section>
	);
};
