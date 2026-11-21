// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProfilePanel — the Profile tab within AccountView.
 *
 * Displays the user's avatar card with identity information, the TEAMS card
 * (the member's team order, B39: drag to reorder, row one is the home team,
 * the order is the `@team` resolution order), the organization memberships,
 * and the Edit Profile record panel — an edit-only form DetailPanel per the interaction standard
 * (2026-07-18): [Save Changes] MATERIALIZES only while a field differs from
 * the seeded profile snapshot; Cancel / X / Escape on a dirty form raise the
 * stock "Discard changes?" confirm (the DetailPanel owns the X / Escape
 * guard via the dirty / editing props; the footer Cancel routes through its
 * own check); a successful Save closes the panel (correct for a form-only
 * panel). Per the concurrent-edit ruling, the form seeds ONCE per open and
 * never re-seeds mid-edit — the user's typing is sacred. Errors render as an
 * in-panel Banner at the top of the body. Grouped sections render as stock
 * Cards. All server interactions are delegated to the host via callback props.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import { Card } from '../../../components/card/Card';
import { DetailPanel } from '../../../components/detail-panel/DetailPanel';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Banner } from '../../../components/banner/Banner';
import { Button } from '../../../components/button/Button';
import { StatusBadge } from '../../../components/status-badge/StatusBadge';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import type { ConnectResult, ProfileUpdate, TeamInfo } from '../types';
import { S, Badge, Avatar, initials, avatarColor } from './shared';
import { moveItem, orderTeams, ordinal, pushRetiresSave } from './teamOrder';
import type { PendingSave } from './teamOrder';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Vertical stack of the panel's cards (standard 16px rhythm). */
	stack: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,

	/** Identity card inner row: avatar + identity block + edit action. */
	identityRow: {
		padding: '24px 24px 20px',
		display: 'flex',
		alignItems: 'center',
		gap: 18,
	} as CSSProperties,

	/**
	 * Large circular avatar with a deterministic color background.
	 *
	 * @param seed - Name or email seeding the color.
	 */
	avatarLarge: (seed: string): CSSProperties => ({
		width: 64,
		height: 64,
		borderRadius: '50%',
		background: avatarColor(seed),
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 24,
		fontWeight: 700,
		color: 'var(--rr-fg-button)',
		flexShrink: 0,
	}),

	/** Flex-growing identity text block. */
	identityInfo: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	/** Display name line. */
	displayName: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		marginBottom: 4,
	} as CSSProperties,

	/** Preferred username line beneath the display name. */
	username: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginBottom: 12,
	} as CSSProperties,

	/** Wrapping row of contact entries (email / phone). */
	contactRow: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '4px 16px',
	} as CSSProperties,

	/** One contact entry: value text + verification pill. */
	contactItem: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		display: 'flex',
		alignItems: 'center',
		gap: 5,
	} as CSSProperties,

	/** Green "Verified" pill next to a verified email / phone. */
	verifiedPill: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 3,
		fontSize: 10,
		fontWeight: 600,
		padding: '1px 6px',
		borderRadius: 4,
		background: 'var(--rr-bg-surface-alt)',
		color: 'var(--rr-color-success)',
	} as CSSProperties,

	/** Amber "Unverified" pill next to an unverified email / phone. */
	unverifiedPill: {
		fontSize: 10,
		fontWeight: 600,
		padding: '1px 5px',
		borderRadius: 4,
		background: 'var(--rr-bg-surface-alt)',
		color: 'var(--rr-color-warning)',
	} as CSSProperties,

	/**
	 * Membership org row: dimmed when the org is not the active one.
	 *
	 * @param active - Whether the org is the user's active organization.
	 * @param last   - Whether this is the last row (no divider).
	 */
	orgRow: (active: boolean, last: boolean): CSSProperties => ({
		...S.rowItem,
		borderBottom: last ? 'none' : S.rowItem.borderBottom,
		opacity: active ? 1 : 0.45,
	}),

	/** Green check label for the active org. */
	activeLabel: {
		fontSize: 11,
		color: 'var(--rr-color-success)',
		fontWeight: 600,
	} as CSSProperties,

	/** Muted hint beside the Teams card title ("drag to order ..."). */
	cardHint: {
		...commonStyles.textMuted,
		fontWeight: 400,
		marginLeft: 10,
	} as CSSProperties,

	/**
	 * One team row of the Teams card: grip + chip + name + position + marker.
	 * The home row (first) carries the alt surface; the row under a drag
	 * carries the info-colored top edge as the drop indicator.
	 *
	 * @param home     - Whether this is row one (the home team).
	 * @param over     - Whether a dragged row is hovering this row.
	 * @param ghost    - Whether this row is the one being dragged.
	 * @param grabbable - Whether the rows can be dragged (more than one team, no save in flight).
	 * @param last     - Whether this is the last row (no divider; the footer follows).
	 */
	teamOrderRow: (home: boolean, over: boolean, ghost: boolean, grabbable: boolean, last: boolean): CSSProperties => ({
		...S.rowItem,
		gap: 12,
		paddingTop: 10,
		paddingBottom: 10,
		cursor: grabbable ? 'grab' : 'default',
		background: home ? 'var(--rr-bg-surface-alt)' : 'transparent',
		opacity: ghost ? 0.4 : 1,
		boxShadow: over ? 'inset 0 2px 0 0 var(--rr-color-info)' : 'none',
		borderBottom: last ? 'none' : S.rowItem.borderBottom,
		userSelect: 'none',
	}),

	/** Keyboard reorder controls at the right of a team row (Move up / Move down). */
	moveButtons: {
		display: 'flex',
		gap: 2,
		flexShrink: 0,
	} as CSSProperties,

	/** Drag grip icon slot at the left of a team row (fixed width so rows align without it). */
	grip: {
		width: 14,
		display: 'flex',
		alignItems: 'center',
		color: 'var(--rr-text-disabled)',
		flexShrink: 0,
	} as CSSProperties,

	/** Ordinal position caption after the team name ("1st", "2nd", ...). */
	position: {
		...commonStyles.textMuted,
		marginLeft: 8,
	} as CSSProperties,

	/** Footer sentence of the Teams card: what the order decides. */
	teamOrderFoot: {
		...commonStyles.textMuted,
		padding: '10px 18px',
		background: 'var(--rr-bg-surface-alt)',
		borderTop: '1px solid var(--rr-border)',
		lineHeight: 1.5,
	} as CSSProperties,

	/** Spacing wrapper for the Teams card's error Banner. */
	teamOrderError: {
		padding: '12px 18px 0',
	} as CSSProperties,

	/** Spacing wrapper for the in-panel error Banner at the top of the body. */
	errorBanner: {
		marginBottom: 12,
	} as CSSProperties,

	/** Read-only input treatment (login name). */
	inputReadOnly: {
		...commonStyles.inputField,
		opacity: 0.6,
		cursor: 'default',
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the ProfilePanel component. */
export interface ProfilePanelProps {
	/** The live profile data returned by the server, or null while loading. */
	profile: ConnectResult | null;
	/** The locally cached auth user from the identity provider, used as a fallback. */
	authUser: ConnectResult | null;
	/** Async handler that persists a ProfileUpdate and resolves on success. */
	onSave: (fields: ProfileUpdate) => Promise<void>;
	/**
	 * Persists the user's TEAM ORDER in the active organization (B39): the
	 * `@team` resolution order, the first entry being the HOME team. Resolves
	 * on success; a rejection is shown in the Teams card.
	 */
	onSetTeamOrder: (order: string[]) => Promise<void>;
	/** Switches the user's active organization by its ID. */
	onSetDefaultOrg: (orgId: string) => void;
	/** Render ONLY the identity card (+ its edit panel) — the collapsed
	 *  Profile section (ProfileSection) renders the workspace machinery
	 *  itself, so the Teams and memberships cards would be duplicates. */
	identityOnly?: boolean;
}

// =============================================================================
// TEAM ORDER
// =============================================================================

/** The sentence under the Teams card: what the order decides (B39, §3.2, §6.2, §8.3). */
const TEAM_ORDER_FOOT = 'When you call a pipeline or open an app, the first team in this order that has published it answers. Every run you make uses the environment of your home team, the first in this order, and its usage counts under the team whose publication served it; your own unpublished runs count under your home team.';

/** Drag payload type for a Teams card row (scoped so a foreign drag is ignored). */
const TEAM_ORDER_DND_MIME = 'application/x-rocketride-team-order';

/** Props accepted by the TeamOrderCard component. */
export interface TeamOrderCardProps {
	/** The active organization's teams (the server lists them in team order). */
	teams: TeamInfo[];
	/** The member's team order; empty falls back to the listing order. */
	order: readonly string[];
	/** Persists a new order; rejects with the server's message. */
	onSetTeamOrder: (order: string[]) => Promise<void>;
}

/**
 * The TEAMS card (B39, mockup `account-team-order-mockup.html`): one row per
 * team of the active organization, draggable to reorder. Row one is the HOME
 * team and carries the Home marker; every row shows its position. A drop
 * commits immediately through `onSetTeamOrder` — there is no staged state
 * and no separate development-team setting. While the server answers, the
 * card shows the dropped order; a refusal (for example a home team without
 * `task.control`) restores the server's order and banners the message.
 */
export const TeamOrderCard: React.FC<TeamOrderCardProps> = ({ teams, order, onSetTeamOrder }) => {
	const ordered = useMemo(() => orderTeams(teams, order), [teams, order]);
	// The order shown while a drop is in flight (null = the server's order).
	const [pending, setPending] = useState<TeamInfo[] | null>(null);
	// The row being dragged and the row it hovers, by team id.
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const rows = pending ?? ordered;
	const canReorder = rows.length > 1 && pending == null;
	// The save in flight: the ids it sent and whether the call has resolved.
	const saveRef = useRef<PendingSave | null>(null);

	// The server's answer to a saved order arrives as a pushed `order`; see
	// pushRetiresSave for which pushes retire the in-flight rows. The provider
	// drops profile responses that a save superseded, so a push that follows
	// the resolved call is authoritative.
	useEffect(() => {
		const save = saveRef.current;
		if (!save) return;
		if (pushRetiresSave(ordered.map((t) => t.id), save)) {
			saveRef.current = null;
			setPending(null);
		}
	}, [ordered]);

	/**
	 * Moves the row at `from` to `to`, shows the new order at once, and
	 * persists it; drag-and-drop and the keyboard buttons both land here. A
	 * refusal restores the server's order and names the reason.
	 */
	const commitMove = async (from: number, to: number): Promise<void> => {
		if (!canReorder || from < 0 || to < 0 || to >= rows.length || from === to) return;
		const next = moveItem(rows, from, to);
		const ids = next.map((t) => t.id);
		saveRef.current = { ids, resolved: false };
		setPending(next);
		setError(null);
		try {
			await onSetTeamOrder(ids);
			if (saveRef.current?.ids === ids) saveRef.current.resolved = true;
		} catch (err) {
			// A rejection of a save that a newer one has superseded says nothing
			// about the rows on screen: leave them and the newer save alone.
			if (saveRef.current?.ids !== ids) return;
			setError(err instanceof Error ? err.message : 'Could not save the team order');
			saveRef.current = null;
			setPending(null);
		}
	};

	/** Starts a row drag: records the team id in the transfer data and locally. */
	const handleDragStart = (e: React.DragEvent, teamId: string): void => {
		if (!canReorder) {
			e.preventDefault();
			return;
		}
		e.dataTransfer.setData(TEAM_ORDER_DND_MIME, teamId);
		e.dataTransfer.effectAllowed = 'move';
		setDraggingId(teamId);
		setError(null);
	};

	/** Marks the hovered row as the drop target (rows accept only our drag). */
	const handleDragOver = (e: React.DragEvent, teamId: string): void => {
		if (!draggingId || !e.dataTransfer.types.includes(TEAM_ORDER_DND_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		if (overId !== teamId) setOverId(teamId);
	};

	/** Clears the drag visuals (drop or cancel). */
	const handleDragEnd = (): void => {
		setDraggingId(null);
		setOverId(null);
	};

	/** Drops the dragged row on `teamId` and commits the move. */
	const handleDrop = (e: React.DragEvent, teamId: string): void => {
		e.preventDefault();
		const from = rows.findIndex((t) => t.id === draggingId);
		const to = rows.findIndex((t) => t.id === teamId);
		handleDragEnd();
		void commitMove(from, to);
	};

	return (
		<Card
			noBodyPadding
			header={
				<>
					Teams
					<span style={styles.cardHint}>{rows.length > 1 ? 'drag or use the arrows to order · the first team is your home team' : 'your home team'}</span>
				</>
			}
		>
			{error && (
				<div style={styles.teamOrderError}>
					<Banner variant="error">{error}</Banner>
				</div>
			)}
			<div style={S.rowList} role="list" aria-label="Team order">
				{rows.map((t, i) => {
					const home = i === 0;
					const last = i === rows.length - 1;
					return (
						<div
							key={t.id}
							role="listitem"
							aria-label={`${t.name}, ${ordinal(i + 1)}${home ? ', home team' : ''}`}
							draggable={canReorder}
							onDragStart={(e) => handleDragStart(e, t.id)}
							onDragOver={(e) => handleDragOver(e, t.id)}
							onDragLeave={() => {
								if (overId === t.id) setOverId(null);
							}}
							onDrop={(e) => handleDrop(e, t.id)}
							onDragEnd={handleDragEnd}
							style={styles.teamOrderRow(home, overId === t.id && draggingId !== t.id, draggingId === t.id, canReorder, last)}
						>
							<span style={styles.grip} aria-hidden="true">
								{canReorder && <GripVertical size={14} />}
							</span>
							<Avatar name={t.name} size={20} square />
							<div style={S.rowInfo}>
								<div style={S.rowName}>
									{t.name}
									<span style={styles.position}>{ordinal(i + 1)}</span>
								</div>
							</div>
							{home && <StatusBadge variant="success">Home</StatusBadge>}
							{rows.length > 1 && (
								<div style={styles.moveButtons}>
									<Button variant="ghost" small disabled={!canReorder || i === 0} title={`Move ${t.name} up`} onClick={() => void commitMove(i, i - 1)}>
										<ChevronUp size={14} aria-hidden="true" />
									</Button>
									<Button variant="ghost" small disabled={!canReorder || last} title={`Move ${t.name} down`} onClick={() => void commitMove(i, i + 1)}>
										<ChevronDown size={14} aria-hidden="true" />
									</Button>
								</div>
							)}
						</div>
					);
				})}
			</div>
			<div style={styles.teamOrderFoot}>{TEAM_ORDER_FOOT}</div>
		</Card>
	);
};

// =============================================================================
// VERIFIED BADGE
// =============================================================================

/** A small green "Verified" pill shown next to a verified email or phone number. */
const VerifiedBadge: React.FC = () => <span style={styles.verifiedPill}>{'✓'} Verified</span>;

// =============================================================================
// PROFILE PANEL
// =============================================================================

/**
 * The Profile tab panel.
 *
 * Displays a large avatar card with the user's identity information, the
 * Teams card (the member's team order in the active organization), a list of
 * their organizations, and an inline Edit Profile modal.
 */
export const ProfilePanel: React.FC<ProfilePanelProps> = ({ profile, authUser, onSave, onSetTeamOrder, onSetDefaultOrg, identityOnly }) => {
	/**
	 * Builds a ProfileUpdate snapshot from the current profile/authUser props.
	 * Called exactly when the edit panel OPENS — the concurrent-edit ruling
	 * (2026-07-18) forbids re-seeding staged fields while the panel is open,
	 * so a profile refresh mid-edit never clobbers the user's typing.
	 */
	const fromProfile = (): ProfileUpdate => ({
		displayName: profile?.displayName || authUser?.displayName || '',
		preferredUsername: profile?.preferredUsername || authUser?.preferredUsername || '',
		givenName: profile?.givenName || authUser?.givenName || '',
		familyName: profile?.familyName || authUser?.familyName || '',
		email: profile?.email || authUser?.email || '',
		phoneNumber: profile?.phoneNumber || authUser?.phoneNumber || '',
		locale: profile?.locale || authUser?.locale || '',
	});

	const [editOpen, setEditOpen] = useState(false);
	// Staged form fields, seeded once per open from the profile snapshot.
	const [fields, setFields] = useState<ProfileUpdate>(fromProfile);
	// The snapshot the form was seeded from — the dirty compare's baseline.
	// Comparing against LIVE props instead would falsely dirty a clean form
	// whenever the profile refreshes mid-edit.
	const [seeded, setSeeded] = useState<ProfileUpdate>(fromProfile);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Footer-Cancel discard confirm (the DetailPanel guards X / Escape itself;
	// the footer Cancel routes through this local gate per the standard).
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	// Dirty flag: any staged field differs from the seeded snapshot. Drives
	// the materializing [Save Changes] and arms the discard guard.
	const dirty = (Object.keys(fields) as Array<keyof ProfileUpdate>).some((key) => fields[key] !== seeded[key]);

	/** Returns a change handler for a specific ProfileUpdate field key. */
	const set = (key: keyof ProfileUpdate) => (e: React.ChangeEvent<HTMLInputElement>) => {
		setFields((f) => ({ ...f, [key]: e.target.value }));
		setError(null);
	};

	/**
	 * Opens the edit panel, seeding the form AND the dirty baseline from the
	 * freshest profile snapshot. This transition is the ONLY seeding point —
	 * there is deliberately no prop-driven re-seed effect (see fromProfile).
	 */
	const openEdit = () => {
		const snapshot = fromProfile();
		setFields(snapshot);
		setSeeded(snapshot);
		setError(null);
		setEditOpen(true);
	};
	/** Closes the edit panel and clears its transient state. */
	const closeEdit = () => {
		setEditOpen(false);
		setError(null);
		setConfirmDiscard(false);
	};

	/** Submits the edited profile fields; a failure stays open with the staged
	    values intact and shows the in-panel Banner. */
	const handleSave = async () => {
		setSaving(true);
		setError(null);
		try {
			await onSave(fields);
			// After Save the panel closes — correct for a form-only panel.
			setEditOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Save failed');
		} finally {
			setSaving(false);
		}
	};

	// Prefer the server-side profile value over the cached auth token value.
	const displayName = profile?.displayName || authUser?.displayName || '—';
	const email = profile?.email || authUser?.email || '';
	const org = profile?.organization ?? authUser?.organization ?? null;
	const memberships = profile?.memberships ?? (org ? [org] : []);
	const defaultOrgId = profile?.defaultOrgId ?? org?.id;
	// The active org's teams and the member's order in it. The server lists
	// `organization.teams` in team order and pushes `teamOrder` beside it.
	const activeOrg = memberships.find((o) => o.id === defaultOrgId) ?? org;
	const activeTeams = activeOrg?.teams ?? [];
	const teamOrder = profile?.teamOrder ?? authUser?.teamOrder ?? [];

	return (
		<section style={styles.stack}>
			{/* Identity card — headerless Card with the padded avatar row. */}
			<Card noBodyPadding>
				<div style={styles.identityRow}>
					{/* Avatar */}
					<div style={styles.avatarLarge(displayName || email)}>{initials(displayName, email)}</div>

					{/* Identity */}
					<div style={styles.identityInfo}>
						<div style={styles.displayName}>{displayName}</div>
						{(profile?.preferredUsername || authUser?.preferredUsername) && <div style={styles.username}>{profile?.preferredUsername || authUser?.preferredUsername}</div>}
						<div style={styles.contactRow}>
							{(profile?.email || authUser?.email) && (
								<span style={styles.contactItem}>
									{profile?.email || authUser?.email}
									{/* Show verified / unverified badge only when the server has provided the flag. */}
									{profile?.emailVerified !== undefined && (profile.emailVerified ? <VerifiedBadge /> : <span style={styles.unverifiedPill}>Unverified</span>)}
								</span>
							)}
							{(profile?.phoneNumber || authUser?.phoneNumber) && (
								<span style={styles.contactItem}>
									{profile?.phoneNumber || authUser?.phoneNumber}
									{profile?.phoneNumberVerified !== undefined && (profile.phoneNumberVerified ? <VerifiedBadge /> : <span style={styles.unverifiedPill}>Unverified</span>)}
								</span>
							)}
						</div>
					</div>

					<Button variant="ghost" small onClick={openEdit}>
						Edit Profile
					</Button>
				</div>
			</Card>

			{/* Teams card — the member's team order in the active org (B39). */}
			{!identityOnly && activeTeams.length > 0 && <TeamOrderCard teams={activeTeams} order={teamOrder} onSetTeamOrder={onSetTeamOrder} />}

			{/* Organizations / workspaces card. */}
			{!identityOnly && memberships.length > 0 && (
				<Card header="Organizations / Workspaces" noBodyPadding>
					<div style={S.rowList}>
						{memberships.map((o, oi) => {
							const isActive = o.id === defaultOrgId;
							return (
								<div key={o.id} style={styles.orgRow(isActive, oi === memberships.length - 1)}>
									<Avatar name={o.name} size={24} square />
									<div style={S.rowInfo}>
										<div style={S.rowName}>{o.name}</div>
									</div>
									{o.permissions?.includes('org.admin') && <Badge variant="admin">Admin</Badge>}
									{isActive ? (
										<span style={styles.activeLabel}>{'✓'} Active</span>
									) : (
										<Button variant="ghost" small onClick={() => onSetDefaultOrg(o.id)}>
											Switch to
										</Button>
									)}
								</div>
							);
						})}
					</div>
				</Card>
			)}

			{/* -- Edit Profile record panel (record-panel standard 2026-07-17:
			      the profile IS a record — editing slides out from the Account
			      dialog's edge like every other record, no dialog). Edit-only
			      form panel: editing is always true while open, [Save Changes]
			      MATERIALIZES only while dirty (LEFT of the stationary Cancel),
			      and a dirty Cancel / X / Escape raises the discard confirm. -- */}
			{editOpen && (
				<DetailPanel
					persistKey="panelDetailProfileWidth"
					contained
					open
					onClose={closeEdit}
					avatar={<div style={styles.avatarLarge(displayName || email)}>{initials(displayName, email)}</div>}
					title={displayName}
					subtitle={email || undefined}
					dirty={dirty}
					editing
					onExitMode={closeEdit}
					busy={saving}
					footer={
						<>
							{dirty && (
								<Button variant="primary" small onClick={() => void handleSave()} disabled={saving}>
									{saving ? 'Saving…' : 'Save Changes'}
								</Button>
							)}
							<Button variant="ghost" small onClick={() => (dirty ? setConfirmDiscard(true) : closeEdit())} disabled={saving}>
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
					<div style={S.fieldRow}>
						<div style={S.field}>
							<div style={S.fieldLabel}>Nickname</div>
							<input value={fields.displayName} onChange={set('displayName')} style={commonStyles.inputField} data-rr-autofocus="true" />
							<div style={commonStyles.textMuted}>What we call you in the app</div>
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Login Name</div>
							<input value={fields.preferredUsername} readOnly style={styles.inputReadOnly} />
							<div style={commonStyles.textMuted}>Used to sign in. Contact support to change</div>
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>First Name</div>
							<input value={fields.givenName} onChange={set('givenName')} style={commonStyles.inputField} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Last Name</div>
							<input value={fields.familyName} onChange={set('familyName')} style={commonStyles.inputField} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Email</div>
							<input value={fields.email} onChange={set('email')} style={commonStyles.inputField} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Phone</div>
							<input value={fields.phoneNumber} onChange={set('phoneNumber')} placeholder="+15550000000" style={commonStyles.inputField} />
						</div>
					</div>
				</DetailPanel>
			)}

			{/* -- Footer-Cancel discard confirm (stock dialog, same copy as the
			      DetailPanel's own X / Escape guard) -- */}
			{confirmDiscard && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={() => {
						// The confirmed discard closes the edit-only form panel.
						setConfirmDiscard(false);
						closeEdit();
					}}
					onCancel={() => setConfirmDiscard(false)}
				/>
			)}
		</section>
	);
};
