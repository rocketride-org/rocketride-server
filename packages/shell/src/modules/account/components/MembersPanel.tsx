// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MembersPanel — the Members tab within AccountView.
 *
 * Rebuilt to the record-panel standard (see ApiKeysPanel, THE EXEMPLAR): the
 * grid is PURE DATA — no Actions column, no per-row buttons — and every
 * operation on a member happens in ONE record surface, a contained
 * DetailPanel sliding from the Account dialog's edge:
 *
 *  - row click                -> the panel in INSPECT mode (member facts with
 *                                the role read-only, a Resend Invite BODY
 *                                verb on pending invitations, and Remove in
 *                                the footer guarded by a stock ConfirmDialog)
 *  - footer [Edit]            -> EDIT mode (org admins, never self): the role
 *                                select is STAGED; [Save] materializes on the
 *                                first change and commits back to inspect
 *                                with the panel open; a dirty Cancel / X /
 *                                Escape raises the stock discard confirm
 *  - "Invite Member" (header) -> the SAME panel in CREATE mode carrying the
 *                                retired invite modal's form field-for-field
 *                                (email, names, org role, per-team access
 *                                with the PermGrid editor); [Send Invite]
 *                                materializes on the first change
 *
 * The panel owns its whole lifecycle — form state, validation, saving,
 * errors, confirmation — through the four raw host actions it receives
 * (`onInviteMember`, `onUpdateMemberRole`, `onRemoveMember`,
 * `onResendInvite`). No modals live in AccountView for members.
 *
 * Gating: only org admins get the Invite action, the [Edit] mode entry, the
 * Resend Invite action, and the Remove footer verb; the viewer's own row
 * never offers self-edit/remove (ported from the old Actions column rules).
 * Errors render as an in-panel Banner at the top of the body.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { Banner } from '../../../components/banner/Banner';
import { CardDataGrid } from '../../../components/data-grid/CardDataGrid';
import { autoFormatter, avatarEl, badgeEl, mutedEl } from '../../../components/data-grid/defaults';
import { DetailPanel } from '../../../components/detail-panel/DetailPanel';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Section, LabelValue } from '../../../components/section/Section';
import type { GridColumnDefinition } from '../../../components/data-grid/defaults';
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, MemberRecord, TeamRecord } from '../types';
import { S, PermGrid, PermPill, Avatar, Badge, initials, avatarColor } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Role / status badge shape (commonStyles.badge values + surface fill); text color set per variant. */
	badge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		padding: '2px 8px',
		fontSize: '11px',
		fontWeight: '600',
		borderRadius: '10px',
		letterSpacing: '0.3px',
		background: 'var(--rr-bg-surface-alt)',
	} as Partial<CSSStyleDeclaration>,

	/** Glowing green dot inside the 'active' badge (commonStyles.indicatorSuccess clone). */
	activeDot: {
		width: '8px',
		height: '8px',
		borderRadius: '50%',
		backgroundColor: 'var(--rr-color-success)',
		boxShadow: '0 0 4px var(--rr-color-success)',
	} as Partial<CSSStyleDeclaration>,

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

	/** "(you)" annotation on the current user's own row (DOM style for the grid formatter). */
	youTag: {
		fontSize: '10px',
		color: 'var(--rr-text-disabled)',
		marginLeft: '5px',
	} as Partial<CSSStyleDeclaration>,

	/** Select control styling for role pickers (inputField + pointer cursor). */
	select: {
		...commonStyles.inputField,
		cursor: 'pointer',
	} as React.CSSProperties,

	/** Invitation row in VIEW mode: explanatory note beside the Resend action. */
	inviteRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as React.CSSProperties,

	/** Muted explanatory note filling the invitation row. */
	inviteNote: {
		flex: 1,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as React.CSSProperties,

	/** "Sent!" confirmation shown in place of the Resend button after success. */
	sentText: {
		fontSize: 11,
		fontWeight: 600,
		color: 'var(--rr-color-success)',
	} as React.CSSProperties,

	/** Vertical stack of team-access rows in the invite form. */
	teamList: {
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
	} as React.CSSProperties,

	/** A single team-access row: checkbox + name + Edit Perms toggle. */
	teamRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as React.CSSProperties,

	/** Custom team-access checkbox; fills with the info accent when checked. */
	teamCheckbox: (checked: boolean): React.CSSProperties => ({
		width: 14,
		height: 14,
		borderRadius: 3,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 9,
		cursor: 'pointer',
		border: `1px solid ${checked ? 'var(--rr-color-info)' : 'var(--rr-border-input)'}`,
		background: checked ? 'var(--rr-color-info)' : 'var(--rr-bg-input)',
		color: 'var(--rr-fg-button)',
	}),

	/** Team name label; brightens when the team is checked. */
	teamName: (checked: boolean): React.CSSProperties => ({
		flex: 1,
		fontSize: 12,
		fontWeight: 500,
		color: checked ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
	}),

	/** Compact "Edit Perms" / "Done" toggle on a checked team row. */
	permsToggle: {
		...commonStyles.buttonSecondary,
		...commonStyles.cardBodyButton,
		fontSize: 10,
		padding: '2px 8px',
	} as React.CSSProperties,

	/** Permission-pill cluster shown under a checked team (when not editing). */
	teamPerms: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 4,
		marginTop: 4,
		paddingLeft: 22,
	} as React.CSSProperties,

	/** PermGrid indentation under a team row while editing its permissions. */
	teamPermGrid: {
		marginTop: 6,
		paddingLeft: 22,
	} as React.CSSProperties,

	/** Emphasized member name inside the remove-confirmation copy. */
	confirmName: {
		color: 'var(--rr-text-primary)',
	} as React.CSSProperties,

	/** Spacing wrapper for the in-panel error Banner at the top of the body. */
	errorBanner: {
		marginBottom: 12,
	} as React.CSSProperties,

	/** Left-anchored destructive slot in the panel footer (footer is flex-end). */
	footerDanger: {
		marginRight: 'auto',
	} as React.CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/**
 * Flattened row shape fed to the members grid. Sortable / searchable values
 * are primitives; `status` is a pre-computed display string so client-side
 * sort operates on what the user sees.
 */
interface MemberRow extends Record<string, unknown> {
	/** Member user id — resolves the record for the panel on row click. */
	id: string;
	/** Member display name. */
	displayName: string;
	/** Member email address. */
	email: string;
	/** Organization-level role (e.g. "admin" or "member"). */
	role: string;
	/** Display status: 'Active' | 'Pending' (title-cased wire status). */
	status: string;
	/** ISO membership creation timestamp, or null. */
	createdAt: string | null;
	/** Teams the member belongs to (id + display name pairs). */
	teams: Array<{ id: string; name: string }>;
}

/** The record panel's mode: closed, viewing one member, or inviting one. */
type PanelState = { mode: 'view'; userId: string } | { mode: 'create' } | null;

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the MembersPanel component. */
export interface MembersPanelProps {
	/** Full list of organization members to display. */
	members: MemberRecord[];
	/** Teams available for the invite form's Team Access assignments. */
	teams: TeamRecord[];
	/** The current user's profile, used to suppress self-edit/remove controls. */
	profile: ConnectResult | null;
	/** True when the current user has org.admin permissions. */
	isOrgAdmin: boolean;
	/** Sends an invitation to a new organization member. */
	onInviteMember: (params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> }) => Promise<void>;
	/** Updates an organization member's role. */
	onUpdateMemberRole: (userId: string, role: string) => Promise<void>;
	/** Removes an organization member. */
	onRemoveMember: (userId: string) => Promise<void>;
	/** Resends the initialization email for a pending member. */
	onResendInvite: (userId: string) => Promise<void>;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives the display status string for a member's wire status by
 * title-casing it ('active' -> 'Active', 'pending' -> 'Pending').
 *
 * @param status - The raw wire status.
 * @returns The display status string.
 */
function memberStatus(status: string): string {
	return status ? status.charAt(0).toUpperCase() + status.slice(1) : status;
}

/**
 * Maps a display status string to its badge variant.
 *
 * @param status - Display status produced by {@link memberStatus}.
 * @returns The badge variant carrying the current color treatment.
 */
function statusBadgeVariant(status: string): 'active' | 'pending' | 'member' {
	if (status === 'Active') return 'active';
	if (status === 'Pending') return 'pending';
	return 'member';
}

/** Per-variant badge text colors — mirrors the shared Badge's overrides. */
const BADGE_COLORS: Record<'active' | 'admin' | 'member' | 'pending', string> = {
	active: 'var(--rr-color-success)',
	admin: 'var(--rr-brand)',
	member: 'var(--rr-text-secondary)',
	pending: 'var(--rr-color-warning)',
};

/**
 * Builds a role / status badge (DOM clone of the shared Badge component):
 * surface fill, variant text color, and the glowing green dot on 'active'.
 *
 * @param variant - Badge variant determining the text color.
 * @param label - Badge label text.
 * @returns The badge element.
 */
function memberBadgeEl(variant: 'active' | 'admin' | 'member' | 'pending', label: string): HTMLElement {
	const el = document.createElement('span');
	Object.assign(el.style, styles.badge);
	el.style.color = BADGE_COLORS[variant];
	// The active variant carries the glowing success dot before its label.
	if (variant === 'active') {
		const dot = document.createElement('span');
		Object.assign(dot.style, styles.activeDot);
		el.appendChild(dot);
	}
	el.appendChild(document.createTextNode(label));
	return el;
}

/**
 * Builds a member cell — 28px initials avatar beside the display name, with a
 * "(you)" tag on the viewer's own row (DOM clone of the Avatar + cluster
 * cell render).
 *
 * @param displayName - Member display name (initials + color seed).
 * @param email - Fallback seed when the name is empty.
 * @param isSelf - Whether the row belongs to the authenticated user.
 * @returns The cluster element.
 */
function memberCellEl(displayName: string, email: string, isSelf: boolean): HTMLElement {
	// Cluster wrapper: avatar + name in a horizontal flex row.
	const wrap = document.createElement('div');
	Object.assign(wrap.style, styles.cellCluster);
	// Stock avatar resized to the panel's 28px spec.
	const avatar = avatarEl(initials(displayName, email), avatarColor(displayName || email));
	Object.assign(avatar.style, styles.avatarSmall);
	wrap.appendChild(avatar);
	// Display-name label, annotated with "(you)" on the viewer's own row.
	const name = document.createElement('span');
	name.textContent = displayName;
	if (isSelf) {
		const you = document.createElement('span');
		Object.assign(you.style, styles.youTag);
		you.textContent = '(you)';
		name.appendChild(you);
	}
	wrap.appendChild(name);
	return wrap;
}

// =============================================================================
// MEMBERS PANEL
// =============================================================================

/**
 * The Members tab: a pure-data CardDataGrid plus the single record panel
 * that hosts view, role editing, invite resend, remove, and the invite form.
 * See the module doc for the standard this file follows.
 */
export const MembersPanel: React.FC<MembersPanelProps> = ({ members, teams, profile, isOrgAdmin, onInviteMember, onUpdateMemberRole, onRemoveMember, onResendInvite }) => {
	// ── Record panel state ──────────────────────────────────────────────────
	const [panel, setPanel] = useState<PanelState>(null);
	// Invite-form fields (reset on every open of create mode).
	const [formEmail, setFormEmail] = useState('');
	const [formGivenName, setFormGivenName] = useState('');
	const [formFamilyName, setFormFamilyName] = useState('');
	const [formRole, setFormRole] = useState('member');
	// Team access assignments: teamId -> selected permission keys.
	const [formTeams, setFormTeams] = useState<Record<string, string[]>>({});
	// Which team row's PermGrid editor is expanded, or null for none.
	const [editPermsTeamId, setEditPermsTeamId] = useState<string | null>(null);
	// EDIT mode flag for the view panel: true while the role select is staged.
	const [editingRole, setEditingRole] = useState(false);
	// Staged role value while in EDIT mode (seeded from the record on entry).
	const [roleValue, setRoleValue] = useState('member');
	// Async lifecycle shared by invite, role save, and remove.
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Resend-invite transient states (in-flight and "Sent!" confirmation).
	const [resending, setResending] = useState(false);
	const [resent, setResent] = useState(false);
	// Remove confirmation gate (stacks over the panel via the overlay stack).
	const [confirmRemove, setConfirmRemove] = useState(false);
	// Footer-Cancel discard confirm (the DetailPanel guards X / Escape itself;
	// the footer Cancel routes through this local gate per the standard).
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	// The viewed record resolves LIVE from props so server refreshes (e.g. a
	// role save flipping role -> admin) update the open panel in place.
	const viewedMember = panel?.mode === 'view' ? (members.find((m) => m.userId === panel.userId) ?? null) : null;

	// Gating derived from the viewed record: never self-edit/remove, and only
	// org admins manage members at all (ported from the old Actions column).
	const isSelf = viewedMember != null && viewedMember.userId === profile?.userId;
	const isPending = viewedMember != null && viewedMember.status === 'pending';
	const canManage = isOrgAdmin && viewedMember != null && !isSelf;

	// EDIT-mode dirty flag: the staged role differs from the record. Drives
	// the materializing [Save] and arms the discard guard.
	const roleDirty = editingRole && viewedMember != null && roleValue !== viewedMember.role;

	// CREATE-mode dirty flag: any invite field differs from its seeded
	// default. Drives the materializing [Send Invite] and the discard guard.
	const inviteDirty = panel?.mode === 'create' && (formEmail.trim() !== '' || formGivenName.trim() !== '' || formFamilyName.trim() !== '' || formRole !== 'member' || Object.keys(formTeams).length > 0);

	// Mounted flag guarding the async resend flow — the await and the 3s
	// confirmation timer can both outlive the panel (e.g. the dialog closes).
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[]
	);

	// ── Table rows ──────────────────────────────────────────────────────────
	const rows = useMemo<MemberRow[]>(
		() =>
			members.map((m) => ({
				id: m.userId,
				displayName: m.displayName,
				email: m.email,
				role: m.role,
				status: memberStatus(m.status),
				createdAt: m.createdAt ?? null,
				teams: m.teams ?? [],
			})),
		[members]
	);

	// ── Columns (pure data — the record panel replaced the Actions column) ──
	// Contract flags (rrDefault, array order) declare the default layout; displayName asc keeps the
	// member list alphabetical. Created and Teams stay declared but unindexed
	// (hidden by default, toggleable from the header menu).
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Member',
				field: 'displayName',
				rrType: 'string',
				rrDefault: true,
				rrDefaultSort: 'asc',
				rrDescription: 'Display name from the user profile (the avatar initials and color derive from it); "(you)" marks the signed-in viewer\'s own row.',
				headerSort: true,
				// Avatar + name cluster, "(you)" on the viewer's own row.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as MemberRow;
					return memberCellEl(row.displayName, row.email, row.id === profile?.userId);
				},
			},
			{ title: 'Email', field: 'email', rrType: 'string', rrDefault: true, rrDescription: "Sign-in email address of the member's user account; invitations are sent here.", headerSort: true },
			{
				title: 'Role',
				field: 'role',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Organization-level role: admin manages members, teams, and billing; member has standard access.',
				headerSort: true,
				// Role badge: brand for admins, neutral for members.
				formatter: (cell: CellComponent) => {
					const role = cell.getValue() as string;
					return memberBadgeEl(role === 'admin' ? 'admin' : 'member', role);
				},
			},
			{
				title: 'Status',
				field: 'status',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Membership state: Pending until the invitee completes the initialization email; the first sign-in flips it to Active.',
				headerSort: true,
				// Status badge: green dot for active, amber for pending invites.
				formatter: (cell: CellComponent) => {
					const status = cell.getValue() as string;
					return memberBadgeEl(statusBadgeVariant(status), status);
				},
			},
			{ title: 'Created', field: 'createdAt', rrType: 'date', rrDescription: 'UTC time the org membership was created — for invited members, when the invitation was sent.', headerSort: true, formatter: autoFormatter },
			{
				title: 'Teams',
				field: 'teams',
				rrDescription: 'Teams of this organization the member belongs to; memberships in other organizations are not listed.',
				headerSort: false,
				// Badge per team name (the raw value is {id, name} pairs).
				formatter: (cell: CellComponent) => {
					const teams = (cell.getValue() as Array<{ id: string; name: string }> | null) ?? [];
					if (teams.length === 0) return mutedEl('--');
					const wrap = document.createElement('span');
					wrap.className = 'rr-cell-badges';
					for (const team of teams) wrap.appendChild(badgeEl('info', team.name));
					return wrap;
				},
			},
		],
		[profile?.userId]
	);

	// ── Panel lifecycle ─────────────────────────────────────────────────────

	/** Open the record panel in CREATE (invite) mode with a fresh form. */
	const openInvite = (): void => {
		setFormEmail('');
		setFormGivenName('');
		setFormFamilyName('');
		setFormRole('member');
		setFormTeams({});
		setEditPermsTeamId(null);
		setError(null);
		setPanel({ mode: 'create' });
	};

	/**
	 * Open the record panel in INSPECT mode for a clicked row's member. Role
	 * staging happens later, on the explicit [Edit] entry.
	 *
	 * @param userId - The clicked member's user id.
	 */
	const openView = (userId: string): void => {
		setEditingRole(false);
		setError(null);
		setResent(false);
		setPanel({ mode: 'view', userId });
	};

	/** Close the panel and drop every transient state it owned. */
	const closePanel = (): void => {
		setPanel(null);
		setEditingRole(false);
		setError(null);
		setConfirmRemove(false);
		setConfirmDiscard(false);
	};

	/** Enter EDIT mode, staging the role select from the record's current role. */
	const enterRoleEdit = (): void => {
		if (!viewedMember) return;
		setRoleValue(viewedMember.role);
		setError(null);
		setEditingRole(true);
	};

	/** Leave EDIT mode back to inspect, dropping the staged role value. Also
	    the DetailPanel's onExitMode target (Escape-as-Cancel, confirmed discard). */
	const exitRoleEdit = (): void => {
		if (viewedMember) setRoleValue(viewedMember.role);
		setEditingRole(false);
	};

	/** Validate + submit the invite form; success closes the panel. */
	const handleInvite = async (): Promise<void> => {
		// Step 1: validation mirrors the retired invite modal's rules.
		if (!formEmail.trim()) {
			setError('Email is required');
			return;
		}
		if (!formGivenName.trim()) {
			setError('First name is required');
			return;
		}
		if (!formFamilyName.trim()) {
			setError('Last name is required');
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// Step 2: build team assignments from the checked teams.
			const teamAssignments = Object.entries(formTeams).map(([teamId, permissions]) => ({ teamId, permissions }));
			// Step 3: delegate to the host action; success closes the panel.
			await onInviteMember({
				email: formEmail.trim(),
				givenName: formGivenName.trim(),
				familyName: formFamilyName.trim(),
				role: formRole,
				teamAssignments: teamAssignments.length > 0 ? teamAssignments : undefined,
			});
			closePanel();
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to invite member');
		} finally {
			setSaving(false);
		}
	};

	/** Commit the staged role for the viewed member (EDIT mode's Save). */
	const handleSaveRole = async (): Promise<void> => {
		if (!viewedMember) return;
		setSaving(true);
		setError(null);
		try {
			await onUpdateMemberRole(viewedMember.userId, roleValue);
			// Save returns to INSPECT with the panel open: the live record
			// resolve shows the new role immediately.
			setEditingRole(false);
		} catch (e) {
			// A failed save stays in EDIT with the staged value intact.
			setError(e instanceof Error ? e.message : 'Failed to update role');
		} finally {
			setSaving(false);
		}
	};

	/** Remove the viewed member after the ConfirmDialog's confirmation. */
	const handleRemove = async (): Promise<void> => {
		if (!viewedMember) return;
		setSaving(true);
		setError(null);
		try {
			await onRemoveMember(viewedMember.userId);
			// The member is gone from the organization — close everything.
			closePanel();
		} catch (e) {
			setConfirmRemove(false);
			setError(e instanceof Error ? e.message : 'Failed to remove member');
		} finally {
			setSaving(false);
		}
	};

	/**
	 * Resend the invitation email for the viewed pending member, tracking
	 * in-flight and "Sent!" confirmation states.
	 */
	const handleResend = async (): Promise<void> => {
		if (!viewedMember) return;
		setResending(true);
		setError(null);
		try {
			await onResendInvite(viewedMember.userId);
			// Skip the confirmation state entirely if the panel is already gone.
			if (!mountedRef.current) return;
			setResent(true);
			setTimeout(() => {
				if (mountedRef.current) setResent(false);
			}, 3000);
		} catch (e) {
			if (mountedRef.current) setError(e instanceof Error ? e.message : 'Failed to resend invitation');
		} finally {
			if (mountedRef.current) setResending(false);
		}
	};

	// ── Render ──────────────────────────────────────────────────────────────

	return (
		<section>
			{/* Pure-data grid: row click opens the record panel. */}
			<Card noBodyPadding>
				<CardDataGrid<MemberRow>
					title="Members"
					actions={
						isOrgAdmin ? (
							<Button variant="primary" small onClick={openInvite}>
								Invite Member
							</Button>
						) : undefined
					}
					columns={columns}
					data={rows}
					noSearch
					onRowClick={(row) => openView(row.id)}
					emptyTitle="No members yet"
					emptyDescription="Invite a colleague to join this organization."
				/>
			</Card>

			{/* ── Record panel: INSPECT / EDIT mode. Footer contract: [Remove]
			    left-anchored danger; right cluster is mode machinery — [Edit]
			    in inspect, a materializing [Save] + stationary [Cancel] in
			    edit. Header X / Escape are the exits (no footer Close); a
			    viewer who cannot manage gets a pure-inspect panel (no footer).
			    dirty/editing/busy arm the component's own guards. ──────────── */}
			{viewedMember != null && (
				<DetailPanel
					persistKey="panelDetailMemberWidth"
					contained
					open
					onClose={closePanel}
					avatar={<Avatar name={viewedMember.displayName} email={viewedMember.email} size={42} />}
					title={viewedMember.displayName}
					subtitle={viewedMember.email}
					dirty={roleDirty}
					editing={editingRole}
					onExitMode={exitRoleEdit}
					busy={saving}
					footer={
						canManage ? (
							<>
								<div style={styles.footerDanger}>
									<Button variant="danger" small disabled={saving} onClick={() => setConfirmRemove(true)}>
										{isPending ? 'Cancel Invitation' : 'Remove from Organization'}
									</Button>
								</div>
								{editingRole ? (
									<>
										{/* [Save] materializes on the first change, LEFT of Cancel. */}
										{roleDirty && (
											<Button variant="primary" small disabled={saving} onClick={() => void handleSaveRole()}>
												{saving ? 'Saving…' : 'Save'}
											</Button>
										)}
										<Button variant="ghost" small disabled={saving} onClick={() => (roleDirty ? setConfirmDiscard(true) : exitRoleEdit())}>
											Cancel
										</Button>
									</>
								) : (
									<Button variant="ghost" small onClick={enterRoleEdit}>
										Edit
									</Button>
								)}
							</>
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
					<Section label="Member">
						<LabelValue label="Name">{isSelf ? `${viewedMember.displayName} (you)` : viewedMember.displayName}</LabelValue>
						<LabelValue label="Email">{viewedMember.email}</LabelValue>
						<LabelValue label="Status">
							<Badge variant={statusBadgeVariant(memberStatus(viewedMember.status))}>{memberStatus(viewedMember.status)}</Badge>
						</LabelValue>
						<LabelValue label="Teams">{viewedMember.teams?.length ? viewedMember.teams.map((t) => t.name).join(', ') : '--'}</LabelValue>
						{/* Role: read-only badge in INSPECT; the STAGED select in EDIT
						    (nothing commits until the footer Save). */}
						<LabelValue label="Role">
							{editingRole ? (
								<select value={roleValue} onChange={(e) => setRoleValue(e.target.value)} style={styles.select}>
									<option value="member">Member</option>
									<option value="admin">Admin</option>
								</select>
							) : (
								<Badge variant={viewedMember.role === 'admin' ? 'admin' : 'member'}>{viewedMember.role}</Badge>
							)}
						</LabelValue>
					</Section>
					{/* Pending invitation BODY verb (org admins): resend commits
					    immediately — low stakes, unguarded — with the in-flight /
					    "Sent!" states from the old Actions column. */}
					{canManage && isPending && (
						<Section label="Invitation">
							<div style={styles.inviteRow}>
								<span style={styles.inviteNote}>This member has not accepted their invitation yet.</span>
								{resent ? (
									<span style={styles.sentText}>Sent!</span>
								) : (
									<Button variant="ghost" small disabled={resending} onClick={() => void handleResend()}>
										{resending ? 'Sending…' : 'Resend Invite'}
									</Button>
								)}
							</div>
						</Section>
					)}
				</DetailPanel>
			)}

			{/* ── Record panel: CREATE (invite) mode. [Send Invite] MATERIALIZES
			    on the first change, LEFT of the stationary [Cancel]; a dirty
			    Cancel routes through the discard confirm; dirty/editing arm
			    the component's own X / Escape guard; onExitMode closes
			    (create-mode panels close on mode exit). ────────────────────── */}
			{panel?.mode === 'create' && (
				<DetailPanel
					persistKey="panelDetailMemberWidth"
					contained
					open
					onClose={closePanel}
					title="Invite Member"
					subtitle="Send an invitation to join this organization"
					dirty={inviteDirty}
					editing
					onExitMode={closePanel}
					busy={saving}
					footer={
						<>
							{inviteDirty && (
								<Button variant="primary" small disabled={saving} onClick={() => void handleInvite()}>
									{saving ? 'Inviting…' : 'Send Invite'}
								</Button>
							)}
							<Button variant="ghost" small disabled={saving} onClick={() => (inviteDirty ? setConfirmDiscard(true) : closePanel())}>
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
					{/* Invite form (ported field-for-field from the retired modal). */}
					<div style={S.field}>
						<div style={S.fieldLabel}>Email Address</div>
						<input value={formEmail} onChange={(e) => setFormEmail(e.target.value)} placeholder="colleague@acme.com" style={commonStyles.inputField} data-rr-autofocus="true" />
					</div>
					<div style={S.fieldRow}>
						<div style={S.field}>
							<div style={S.fieldLabel}>First Name</div>
							<input value={formGivenName} onChange={(e) => setFormGivenName(e.target.value)} placeholder="Jane" style={commonStyles.inputField} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Last Name</div>
							<input value={formFamilyName} onChange={(e) => setFormFamilyName(e.target.value)} placeholder="Smith" style={commonStyles.inputField} />
						</div>
					</div>
					<div style={S.field}>
						<div style={S.fieldLabel}>Organization Role</div>
						<select value={formRole} onChange={(e) => setFormRole(e.target.value)} style={styles.select}>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</div>
					{/* Team Access: check a team to assign it, expanding to a PermGrid
					    editor per team; unchecked teams carry no assignment. */}
					{teams.length > 0 && (
						<div style={S.field}>
							<div style={S.fieldLabel}>Team Access</div>
							<div style={styles.teamList}>
								{teams.map((t) => {
									// Checked = the team has an assignment entry; default perms seed on check.
									const checked = t.id in formTeams;
									const perms = formTeams[t.id] ?? [];
									const editingPerms = editPermsTeamId === t.id;
									return (
										<div key={t.id}>
											<div style={styles.teamRow}>
												{/* Custom checkbox toggling the team's assignment entry. */}
												<div
													style={styles.teamCheckbox(checked)}
													onClick={() => {
														if (checked) {
															// Unchecking drops the assignment (and closes its perms editor).
															const next = { ...formTeams };
															delete next[t.id];
															setFormTeams(next);
															if (editingPerms) setEditPermsTeamId(null);
														} else {
															// Checking seeds the default capability permissions.
															setFormTeams({ ...formTeams, [t.id]: ['task.control', 'task.monitor'] });
														}
													}}
												>
													{checked && '✓'}
												</div>
												{/* Team name */}
												<span style={styles.teamName(checked)}>{t.name}</span>
												{/* Edit Perms toggle (only for checked teams). */}
												{checked && (
													<button type="button" style={styles.permsToggle} onClick={() => setEditPermsTeamId(editingPerms ? null : t.id)}>
														{editingPerms ? 'Done' : 'Edit Perms'}
													</button>
												)}
											</div>
											{/* Permission badges (when not editing). */}
											{checked && !editingPerms && perms.length > 0 && (
												<div style={styles.teamPerms}>
													{perms.map((p) => (
														<PermPill key={p} perm={p} />
													))}
												</div>
											)}
											{/* PermGrid (when editing). */}
											{editingPerms && (
												<div style={styles.teamPermGrid}>
													<PermGrid value={perms} onChange={(v) => setFormTeams({ ...formTeams, [t.id]: v })} />
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					)}
				</DetailPanel>
			)}

			{/* ── Remove confirmation (stacks over the record panel) ────────── */}
			{confirmRemove && viewedMember != null && (
				<ConfirmDialog
					title={isPending ? 'Cancel Invitation' : 'Remove Member'}
					destructive
					confirmLabel={saving ? 'Removing…' : isPending ? 'Yes, Cancel Invite' : 'Yes, Remove'}
					confirmDisabled={saving}
					message={
						isPending ? (
							<>
								Are you sure you want to cancel the invitation for <strong style={styles.confirmName}>{viewedMember.displayName}</strong> ({viewedMember.email})?
							</>
						) : (
							<>
								Are you sure you want to remove <strong style={styles.confirmName}>{viewedMember.displayName}</strong> ({viewedMember.email}) from the organization?
							</>
						)
					}
					onConfirm={() => void handleRemove()}
					onCancel={() => setConfirmRemove(false)}
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
						// Route by the mode that raised it: an invite discard closes
						// the create panel; a role-edit discard drops to inspect.
						setConfirmDiscard(false);
						if (panel?.mode === 'create') closePanel();
						else exitRoleEdit();
					}}
					onCancel={() => setConfirmDiscard(false)}
				/>
			)}
		</section>
	);
};
