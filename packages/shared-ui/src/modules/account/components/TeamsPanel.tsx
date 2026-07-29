// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TeamsPanel — the Teams tab within AccountView.
 *
 * Converted to the record-panel standard (see
 * ApiKeysPanel, THE EXEMPLAR): the grid is PURE DATA — no Actions column, no
 * drill-down view swap — and every operation on a team happens in ONE record
 * surface, a contained DetailPanel sliding from the Account dialog's edge:
 *
 *  - row click             -> the panel in VIEW mode: team facts, the live
 *                             member list with permission pills, an inline
 *                             per-member permissions editor, member removal
 *                             (ConfirmDialog-guarded), the add-member form,
 *                             and Delete Team in the footer (ConfirmDialog-
 *                             guarded, org-admin only). Header X / Escape are
 *                             the exits (no footer Close). The per-member
 *                             body operations stay immediate VERBS — a
 *                             documented gray zone, deliberately untouched.
 *  - "+ New Team" (header) -> the SAME panel in CREATE mode (team name form);
 *                             [Create Team] MATERIALIZES on the first change,
 *                             and a dirty Cancel / X / Escape raises the
 *                             stock "Discard changes?" confirm
 *
 * WHY: the previous implementation swapped the whole tab between a list Card
 * and a drill-down members Card, and delegated create / delete / add-member /
 * edit-perms / remove-member to five modals owned by AccountView. The record
 * panel absorbs all of them, so the host passes RAW async actions and the
 * panel owns its whole lifecycle — form state, validation, saving, errors,
 * confirmations. No team modals live in AccountView anymore.
 *
 * The VIEW panel keeps the host-owned `activeTeamId` / `onLoadTeamDetail`
 * mechanics: opening a row raises the id on the host, an effect requests the
 * detail load, and the body renders LIVE from the `teamDetail` prop — so
 * server refreshes (a member added, permissions changed) update the open
 * panel in place.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { Banner } from '../../../components/banner/Banner';
import { CardDataGrid } from '../../../components/data-grid/CardDataGrid';
import type { GridColumnDefinition } from '../../../components/data-grid/defaults';
import { DetailPanel } from '../../../components/detail-panel/DetailPanel';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Section, LabelValue } from '../../../components/section/Section';
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, MemberRecord, TeamRecord, TeamDetail, TeamMemberRecord } from '../types';
import { S, Avatar, PermGrid, PermPill, avatarColor } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Horizontal cluster inside a grid cell (chip + text) — DOM style for formatters. */
	cellCluster: {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
	} as Partial<CSSStyleDeclaration>,

	/** 32px team chip in the grid's Team cell (DOM clone of teamChip(name, 32)). */
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

	/**
	 * Deterministic-color initial chip for a team — fills the DetailPanel's
	 * 42px avatar slot (the slot's own 50% radius clips it round).
	 *
	 * @param name - Team name seeding the color.
	 */
	teamChipAvatar: (name: string): CSSProperties => ({
		width: 42,
		height: 42,
		background: avatarColor(name),
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 17,
		fontWeight: 700,
		color: 'var(--rr-fg-button)',
	}),

	/** One member entry in the panel's Members section (identity row + pills / editor). */
	memberItem: {
		padding: '10px 0',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Identity row: avatar + name/email column + right-aligned action buttons. */
	memberIdentity: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as CSSProperties,

	/** Flex-growing name/email column inside the identity row. */
	memberInfo: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	/** Member display name line. */
	memberName: {
		fontSize: 12.5,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** Member email line under the name. */
	memberEmail: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Right-aligned action button cluster inside the identity row. */
	memberActions: {
		display: 'flex',
		alignItems: 'center',
		gap: 5,
		flexShrink: 0,
	} as CSSProperties,

	/** Inline editor block (PermGrid + its action row) under an identity row. */
	editorBlock: {
		marginTop: 10,
	} as CSSProperties,

	/** Right-aligned action row closing an inline form (Save/Cancel, Add/Cancel). */
	editorActions: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 8,
		marginTop: 10,
	} as CSSProperties,

	/** Spacing above the "+ Add Member" reveal button / the revealed add form. */
	addBlock: {
		marginTop: 12,
	} as CSSProperties,

	/** Muted line shown when every org member already belongs to the team. */
	emptyEligible: {
		fontSize: 12,
		color: 'var(--rr-text-disabled)',
		padding: '7px 0',
	} as CSSProperties,

	/** Muted placeholder while the team detail loads or the team has no members. */
	mutedLine: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		padding: '7px 0',
	} as CSSProperties,

	/** Spacing wrapper for the in-panel error Banner at the top of the body. */
	errorBanner: {
		marginBottom: 12,
	} as CSSProperties,

	/** Left-anchored destructive slot in the panel footer (footer is flex-end). */
	footerDanger: {
		marginRight: 'auto',
	} as CSSProperties,
};

// =============================================================================
// CELL BUILDERS
// =============================================================================

/**
 * Builds a team cell — 32px deterministic-color chip with the team's initial
 * beside the team name (DOM clone of the retired teamChip + cluster render).
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

// =============================================================================
// TYPES
// =============================================================================

/**
 * Flattened row shape fed to the teams grid. Sortable / filterable values are
 * primitives; TeamRecord carries no timestamps, so the grid is names + counts.
 */
interface TeamRow extends Record<string, unknown> {
	/** Team id — resolves the record for the panel on row click. */
	id: string;
	/** Team display name. */
	name: string;
	/** Current member count. */
	members: number;
}

/**
 * The record panel's mode: closed, viewing one team, or creating one. VIEW
 * mode is DERIVED from the host-owned `activeTeamId` (never duplicated in
 * local state) so the existing drill-down mechanics — including the host
 * clearing the id on tab switches — keep working unchanged.
 */
type PanelState = { mode: 'view'; teamId: string } | { mode: 'create' } | null;

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the TeamsPanel component. */
export interface TeamsPanelProps {
	/** Flat list of all teams in the organization. */
	teams: TeamRecord[];
	/** Full detail for the currently selected team, or null while loading / none selected. */
	teamDetail: TeamDetail | null;
	/** ID of the team whose record panel is open, or null when closed. */
	activeTeamId: string | null;
	/** Called when the user opens / closes a team's record panel. */
	onActiveTeamIdChange: (id: string | null) => void;
	/** Requests the host to load full detail for a specific team. */
	onLoadTeamDetail: (teamId: string) => void;
	/** Flat list of all organization members (the add-member eligibility pool). */
	members: MemberRecord[];
	/** The current user's profile, used to suppress last-admin self-removal. */
	profile: ConnectResult | null;
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
	/** True when the current user has org.admin permissions. */
	isOrgAdmin: boolean;
	/** True when the current user has team.admin on the active team. */
	isActiveTeamAdmin: boolean;
}

// =============================================================================
// TEAMS PANEL
// =============================================================================

/**
 * The Teams tab: a pure-data CardDataGrid plus the single record panel that
 * hosts view, create, member management, and delete. See the module doc for
 * the standard this file follows.
 */
export const TeamsPanel: React.FC<TeamsPanelProps> = ({ teams, teamDetail, activeTeamId, onActiveTeamIdChange, onLoadTeamDetail, members, profile, onCreateTeam, onDeleteTeam, onAddTeamMember, onEditTeamMemberPerms, onRemoveTeamMember, isOrgAdmin, isActiveTeamAdmin }) => {
	// ── Record panel state ──────────────────────────────────────────────────
	// CREATE mode is local; VIEW mode is derived from the host-owned id below.
	const [createOpen, setCreateOpen] = useState(false);
	// Create-form field (reset on every open of create mode).
	const [formName, setFormName] = useState('');
	// Inline per-member permissions editor: the member being edited + draft.
	const [editingUserId, setEditingUserId] = useState<string | null>(null);
	const [editPerms, setEditPerms] = useState<string[]>([]);
	// Add-member form: reveal flag + selected user + draft permissions.
	const [addOpen, setAddOpen] = useState(false);
	const [addUserId, setAddUserId] = useState('');
	const [addPerms, setAddPerms] = useState<string[]>(['task.control', 'task.monitor']);
	// Async lifecycle shared by every action the panel hosts.
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Confirmation gates (each stacks over the panel via the overlay stack).
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState<{ userId: string; displayName: string } | null>(null);
	// Footer-Cancel discard confirm (the DetailPanel guards X / Escape itself;
	// the create footer's Cancel routes through this local gate per the standard).
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	// The panel's mode: create wins (the grid is unreachable under an open
	// panel, so both can never be user-driven at once); otherwise the host's
	// activeTeamId opens VIEW mode.
	const panel: PanelState = createOpen ? { mode: 'create' } : activeTeamId != null ? { mode: 'view', teamId: activeTeamId } : null;

	// The viewed record resolves LIVE from props so server refreshes (member
	// added / removed, permissions changed) update the open panel in place.
	const viewedTeam = panel?.mode === 'view' ? teams.find((t) => t.id === panel.teamId) ?? null : null;

	// CREATE-mode dirty flag: the name field differs from its seeded default.
	// Drives the materializing [Create Team] and arms the discard guard.
	const createDirty = panel?.mode === 'create' && formName.trim() !== '';
	// Detail must MATCH the viewed team — a stale detail from a previously
	// viewed team must not render under the wrong title while the load runs.
	const viewedDetail = panel?.mode === 'view' && teamDetail?.id === panel.teamId ? teamDetail : null;

	// ── Detail load on panel open ───────────────────────────────────────────
	// Latest loader kept in a ref so the effect depends only on the team id —
	// an inline host lambda must not re-trigger loads on every parent render.
	const loadDetailRef = useRef(onLoadTeamDetail);
	loadDetailRef.current = onLoadTeamDetail;

	// Preserved drill-down mechanic: whenever the VIEW panel opens (or the
	// viewed team changes), request the fresh detail from the host.
	useEffect(() => {
		if (activeTeamId != null) loadDetailRef.current(activeTeamId);
	}, [activeTeamId]);

	// ── Table rows ──────────────────────────────────────────────────────────
	const rows = useMemo<TeamRow[]>(
		() =>
			teams.map((t) => ({
				id: t.id,
				name: t.name,
				members: t.memberCount,
			})),
		[teams]
	);

	// ── Columns (pure data — the record panel replaced the Actions column) ──
	// Contract flags (rrDefault, array order) declare the default layout; name asc keeps the short
	// team list alphabetical.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Team',
				field: 'name',
				rrType: 'string',
				rrDefault: true,
				rrDefaultSort: 'asc',
				rrDescription: 'Display name of the team; the chip color and initial derive deterministically from it.',
				headerSort: true,
				formatter: (cell: CellComponent) => teamCellEl(String(cell.getValue() ?? '')),
			},
			{
				title: 'Members',
				field: 'members',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Number of users currently in the team, counted server-side when the list loads.',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => {
					const n = cell.getValue() as number;
					return `${n} member${n !== 1 ? 's' : ''}`;
				},
			},
		],
		[]
	);

	// ── Panel lifecycle ─────────────────────────────────────────────────────

	/** Open the record panel in CREATE mode with a fresh form. */
	const openCreate = (): void => {
		setFormName('');
		setError(null);
		setCreateOpen(true);
	};

	/** Open the record panel in VIEW mode for the clicked team. */
	const openView = (teamId: string): void => {
		// Reset every transient sub-state from a previously viewed team.
		setError(null);
		setEditingUserId(null);
		setAddOpen(false);
		// Raise the id on the host — the detail-load effect fires off this.
		onActiveTeamIdChange(teamId);
	};

	/** Close the panel and drop every transient state it owned. */
	const closePanel = (): void => {
		setCreateOpen(false);
		// Clear the host-owned id only when it is actually set (VIEW mode).
		if (activeTeamId != null) onActiveTeamIdChange(null);
		setError(null);
		setEditingUserId(null);
		setAddOpen(false);
		setConfirmDelete(false);
		setConfirmRemove(null);
		setConfirmDiscard(false);
	};

	// ── Create team ─────────────────────────────────────────────────────────

	/** Validate + submit the create form; success closes the panel. */
	const handleCreate = async (): Promise<void> => {
		// Step 1: validation mirrors the retired modal's rules.
		if (!formName.trim()) {
			setError('Name is required');
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// Step 2: create on the server; the host refreshes the teams list.
			await onCreateTeam(formName.trim());
			closePanel();
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to create team');
		} finally {
			setSaving(false);
		}
	};

	// ── Delete team ─────────────────────────────────────────────────────────

	/** Delete the viewed team after the ConfirmDialog's confirmation. */
	const handleDelete = async (): Promise<void> => {
		if (panel?.mode !== 'view') return;
		setSaving(true);
		setError(null);
		try {
			await onDeleteTeam(panel.teamId);
			// The record is gone — close both the confirmation and the panel.
			setConfirmDelete(false);
			closePanel();
		} catch (e) {
			setConfirmDelete(false);
			setError(e instanceof Error ? e.message : 'Failed to delete team');
		} finally {
			setSaving(false);
		}
	};

	// ── Edit member permissions ─────────────────────────────────────────────

	/**
	 * Swap a member row to the inline PermGrid editor, seeded with the
	 * member's current permissions (ported 'edit-perms' semantics).
	 *
	 * @param m - The team member to edit.
	 */
	const startEditPerms = (m: TeamMemberRecord): void => {
		setEditingUserId(m.userId);
		setEditPerms([...m.permissions]);
		setError(null);
	};

	/** Persist the draft permissions for the member being edited. */
	const handleSavePerms = async (): Promise<void> => {
		if (editingUserId == null || viewedDetail == null) return;
		setSaving(true);
		setError(null);
		try {
			await onEditTeamMemberPerms({ teamId: viewedDetail.id, userId: editingUserId, permissions: editPerms });
			// Collapse the editor — the pills re-render from the refreshed detail.
			setEditingUserId(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to update permissions');
		} finally {
			setSaving(false);
		}
	};

	// ── Add member ──────────────────────────────────────────────────────────

	/** Reveal the add-member form with the stock default permissions. */
	const openAddForm = (): void => {
		setAddUserId('');
		setAddPerms(['task.control', 'task.monitor']);
		setError(null);
		setAddOpen(true);
	};

	/** Validate + submit the add-member form; success collapses the form. */
	const handleAddMember = async (): Promise<void> => {
		// Step 1: validation mirrors the retired modal's rules.
		if (!addUserId || viewedDetail == null) {
			setError('Select a member');
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// Step 2: add on the server; the member list refreshes from props.
			await onAddTeamMember({ teamId: viewedDetail.id, userId: addUserId, permissions: addPerms });
			setAddOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to add member');
		} finally {
			setSaving(false);
		}
	};

	// ── Remove member ───────────────────────────────────────────────────────

	/** Remove the confirmed member after the ConfirmDialog's confirmation. */
	const handleRemoveMember = async (): Promise<void> => {
		if (confirmRemove == null || viewedDetail == null) return;
		setSaving(true);
		setError(null);
		try {
			await onRemoveTeamMember({ teamId: viewedDetail.id, userId: confirmRemove.userId });
			// Keep the panel open: the live member list shows the removal.
			setConfirmRemove(null);
		} catch (e) {
			setConfirmRemove(null);
			setError(e instanceof Error ? e.message : 'Failed to remove team member');
		} finally {
			setSaving(false);
		}
	};

	// ── Derived view-mode values ────────────────────────────────────────────
	// Live member count: the loaded detail wins over the list's cached count.
	const memberCount = viewedDetail != null ? viewedDetail.members.length : viewedTeam?.memberCount ?? 0;
	// Count team admins so the last admin cannot remove themselves.
	const adminCount = useMemo(() => (viewedDetail == null ? 0 : viewedDetail.members.filter((m) => m.permissions.includes('team.admin')).length), [viewedDetail]);
	// Org members not already in the team — the add-member eligibility pool.
	const eligible = useMemo(() => (viewedDetail == null ? [] : members.filter((m) => !viewedDetail.members.some((tm) => tm.userId === m.userId))), [members, viewedDetail]);

	// ── Render ──────────────────────────────────────────────────────────────
	return (
		<section>
			{/* Pure-data grid: row click opens the record panel. */}
			<Card noBodyPadding>
				<CardDataGrid<TeamRow>
					title="Teams"
					actions={
						isOrgAdmin ? (
							<Button variant="primary" small onClick={openCreate}>
								+ New Team
							</Button>
						) : undefined
					}
					columns={columns}
					data={rows}
					noSearch
					onRowClick={(row) => openView(row.id)}
					emptyTitle="No teams yet"
					emptyDescription="Create a team to group members and scope their permissions."
				/>
			</Card>

			{/* ── Record panel: VIEW mode. Footer = the record-level [Delete
			    Team] verb only (left-anchored danger, org-admin gate); header
			    X / Escape are the exits — no footer Close, and no [Edit] this
			    pass (the member-management body is verb-driven). A non-admin
			    gets no footer at all. busy locks dismissal while any of the
			    panel's async actions is in flight. ────────────────────────── */}
			{viewedTeam != null && (
				<DetailPanel
					persistKey="panelDetailAccountTeamWidth"
					contained
					open
					onClose={closePanel}
					avatar={<div style={styles.teamChipAvatar(viewedTeam.name)}>{viewedTeam.name[0] ?? ''}</div>}
					title={viewedTeam.name}
					subtitle={`${memberCount} member${memberCount !== 1 ? 's' : ''}`}
					busy={saving}
					footer={
						isOrgAdmin ? (
							<div style={styles.footerDanger}>
								<Button variant="danger" small disabled={saving} onClick={() => setConfirmDelete(true)}>
									Delete Team
								</Button>
							</div>
						) : undefined
					}
				>
					{/* In-panel error surface (interaction standard): a stock Banner
					    at the top of the body. */}
					{error && (
						<div style={styles.errorBanner}>
							<Banner variant="error">{error}</Banner>
						</div>
					)}
					{/* Team facts from the live list record. */}
					<Section label="Team">
						<LabelValue label="Name">{viewedTeam.name}</LabelValue>
						<LabelValue label="Members">{`${memberCount} member${memberCount !== 1 ? 's' : ''}`}</LabelValue>
						<LabelValue label="Team ID" mono>
							{viewedTeam.id}
						</LabelValue>
					</Section>

					{/* Member list — rendered from the host-loaded detail. */}
					<Section label="Members">
						{viewedDetail == null ? (
							/* Detail still in flight for this team. */
							<div style={styles.mutedLine}>Loading members…</div>
						) : viewedDetail.members.length === 0 ? (
							<div style={styles.mutedLine}>No members in this team yet</div>
						) : (
							viewedDetail.members.map((m) => {
								// The last remaining team admin cannot remove themselves
								// (a team must keep one admin) — ported from the old grid.
								const isSelf = m.userId === profile?.userId;
								const isLastAdmin = isSelf && m.permissions.includes('team.admin') && adminCount <= 1;
								const isEditing = editingUserId === m.userId;
								return (
									<div key={m.userId} style={styles.memberItem}>
										{/* Identity row: avatar + name/email + admin actions. */}
										<div style={styles.memberIdentity}>
											<Avatar name={m.displayName} email={m.email} size={28} />
											<div style={styles.memberInfo}>
												<div style={styles.memberName}>{m.displayName}</div>
												<div style={styles.memberEmail}>{m.email}</div>
											</div>
											{isActiveTeamAdmin && !isEditing && (
												<div style={styles.memberActions}>
													<Button variant="ghost" small onClick={() => startEditPerms(m)}>
														Edit Permissions
													</Button>
													{!isLastAdmin && (
														<Button variant="ghost" small onClick={() => setConfirmRemove({ userId: m.userId, displayName: m.displayName })}>
															Remove
														</Button>
													)}
												</div>
											)}
										</div>
										{isEditing ? (
											/* Inline editor: PermGrid draft + Save/Cancel (ported 'edit-perms'). */
											<div style={styles.editorBlock}>
												<PermGrid value={editPerms} onChange={setEditPerms} />
												<div style={styles.editorActions}>
													<Button variant="ghost" small onClick={() => setEditingUserId(null)}>
														Cancel
													</Button>
													<Button variant="primary" small disabled={saving} onClick={() => void handleSavePerms()}>
														{saving ? 'Saving…' : 'Save Permissions'}
													</Button>
												</div>
											</div>
										) : (
											/* Read view: one pill per permission key. */
											<div style={S.perms}>
												{m.permissions.map((p) => (
													<PermPill key={p} perm={p} />
												))}
											</div>
										)}
									</div>
								);
							})
						)}

						{/* Add-member affordance — team admins only, needs the loaded detail
						    for the eligibility pool. */}
						{isActiveTeamAdmin && viewedDetail != null && (
							<div style={styles.addBlock}>
								{addOpen ? (
									/* Revealed add form (ported 'add-member' modal). */
									<>
										<div style={S.field}>
											<div style={S.fieldLabel}>Member</div>
											{eligible.length === 0 ? (
												<div style={styles.emptyEligible}>All organization members are already in this team.</div>
											) : (
												<select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} style={{ ...commonStyles.inputField, cursor: 'pointer' } as CSSProperties}>
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
												<PermGrid value={addPerms} onChange={setAddPerms} />
											</div>
										)}
										<div style={styles.editorActions}>
											<Button variant="ghost" small onClick={() => setAddOpen(false)}>
												Cancel
											</Button>
											{eligible.length > 0 && (
												<Button variant="primary" small disabled={saving} onClick={() => void handleAddMember()}>
													{saving ? 'Adding…' : 'Add to Team'}
												</Button>
											)}
										</div>
									</>
								) : (
									<Button variant="primary" small onClick={openAddForm}>
										+ Add Member
									</Button>
								)}
							</div>
						)}
					</Section>
				</DetailPanel>
			)}

			{/* ── Record panel: CREATE mode. [Create Team] MATERIALIZES on the
			    first change, LEFT of the stationary [Cancel]; a dirty Cancel
			    routes through the discard confirm; dirty/editing arm the
			    component's own X / Escape guard; onExitMode closes
			    (create-mode panels close on mode exit). ────────────────────── */}
			{panel?.mode === 'create' && (
				<DetailPanel
					persistKey="panelDetailAccountTeamWidth"
					contained
					open
					onClose={closePanel}
					title="New Team"
					dirty={createDirty}
					editing
					onExitMode={closePanel}
					busy={saving}
					footer={
						<>
							{createDirty && (
								<Button variant="primary" small disabled={saving} onClick={() => void handleCreate()}>
									{saving ? 'Creating…' : 'Create Team'}
								</Button>
							)}
							<Button variant="ghost" small disabled={saving} onClick={() => (createDirty ? setConfirmDiscard(true) : closePanel())}>
								Cancel
							</Button>
						</>
					}
				>
					{/* In-panel error surface (interaction standard): a stock Banner
					    at the top of the body. */}
					{error && (
						<div style={styles.errorBanner}>
							<Banner variant="error">{error}</Banner>
						</div>
					)}
					{/* Create form (ported field-for-field from the retired modal). */}
					<div style={S.field}>
						<div style={S.fieldLabel}>Team Name</div>
						<input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Engineering, Data Science, QA" style={commonStyles.inputField} data-rr-autofocus="true" />
						<div style={commonStyles.textMuted}>You'll be added as admin automatically.</div>
					</div>
				</DetailPanel>
			)}

			{/* ── Delete confirmation (stacks over the record panel) ────────── */}
			{confirmDelete && viewedTeam != null && (
				<ConfirmDialog
					title="Delete Team"
					destructive
					confirmLabel={saving ? 'Deleting…' : 'Yes, Delete'}
					confirmDisabled={saving}
					message={
						<>
							Are you sure you want to delete <strong style={{ color: 'var(--rr-text-primary)' }}>{viewedTeam.name}</strong>? Members will not be removed from the organization.
						</>
					}
					onConfirm={() => void handleDelete()}
					onCancel={() => setConfirmDelete(false)}
				/>
			)}

			{/* ── Remove-member confirmation (stacks over the record panel) ── */}
			{confirmRemove != null && viewedTeam != null && (
				<ConfirmDialog
					title="Remove from Team"
					destructive
					confirmLabel={saving ? 'Removing…' : 'Yes, Remove'}
					confirmDisabled={saving}
					message={
						<>
							Are you sure you want to remove <strong style={{ color: 'var(--rr-text-primary)' }}>{confirmRemove.displayName}</strong> from <strong style={{ color: 'var(--rr-text-primary)' }}>{viewedTeam.name}</strong>?
						</>
					}
					onConfirm={() => void handleRemoveMember()}
					onCancel={() => setConfirmRemove(null)}
				/>
			)}

			{/* ── Footer-Cancel discard confirm (stock dialog, same copy as the
			    DetailPanel's own X / Escape guard) ──────────────────────────── */}
			{confirmDiscard && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={() => {
						// The confirmed discard closes the create panel whole.
						setConfirmDiscard(false);
						closePanel();
					}}
					onCancel={() => setConfirmDiscard(false)}
				/>
			)}
		</section>
	);
};
