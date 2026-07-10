// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MembersPanel — the Members tab within AccountView.
 *
 * Lists all organization members in the stock DataTable (search, sort,
 * pagination) inside a stock Card, with the A-Z letter selector preserved as a
 * strip along the table's right edge. Pending invitations show Resend / Cancel
 * actions instead of Edit / Remove. The current user's own row shows their
 * role but no action buttons.
 */

import React, { useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataTable } from '../../../components/data-table/DataTable';
import type { DataTableColumn } from '../../../components/data-table/DataTable';
import { createArrayDataSource } from '../../../components/data-table/dataSource';
import type { ConnectResult, OrgDetail, MemberRecord } from '../types';
import { Badge, Avatar } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Container that holds the member table and the A-Z sidebar side by side. */
	body: {
		display: 'flex',
		alignItems: 'stretch',
	} as CSSProperties,

	/** Table region occupying the remaining width beside the A-Z bar. */
	tableWrap: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	/** Horizontal cluster inside a table cell (avatar + text). */
	cellCluster: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as CSSProperties,

	/** "(you)" annotation on the current user's own row. */
	youTag: {
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
		marginLeft: 5,
	} as CSSProperties,

	/** Vertical A-Z sidebar strip on the right edge. */
	azBar: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'flex-start',
		padding: '4px 2px',
		borderLeft: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		userSelect: 'none',
		overflowY: 'auto',
	} as CSSProperties,

	/** A single letter button in the A-Z sidebar. */
	azLetter: {
		fontSize: 10,
		fontWeight: 500,
		lineHeight: 1,
		padding: '3px 6px',
		cursor: 'pointer',
		borderRadius: 3,
		border: 'none',
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		transition: 'background 0.1s, color 0.1s',
	} as CSSProperties,

	/** Active/selected letter style override. */
	azLetterActive: {
		background: 'var(--rr-brand)',
		color: 'var(--rr-fg-button)',
	} as CSSProperties,

	/** Disabled letter (no members start with this letter). */
	azLetterDisabled: {
		color: 'var(--rr-text-disabled)',
		cursor: 'default',
		opacity: 0.4,
	} as CSSProperties,

	/** Buttons inside a row-actions cell, spaced like the DataTable spec. */
	rowButtons: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 5,
	} as CSSProperties,

	/** "Sent!" confirmation after a successful invite resend. */
	sentText: {
		fontSize: 11,
		color: 'var(--rr-color-success)',
		fontWeight: 600,
	} as CSSProperties,
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// =============================================================================
// TYPES
// =============================================================================

/** Flattened row shape fed to the members DataTable. */
interface MemberRow extends Record<string, unknown> {
	/** Member user id — used to resolve callbacks. */
	userId: string;
	/** Member display name. */
	displayName: string;
	/** Member email address. */
	email: string;
	/** Organization-level role (e.g. "admin" or "member"). */
	role: string;
	/** Membership status (e.g. "active" or "pending"). */
	status: string;
}

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the MembersPanel component. */
export interface MembersPanelProps {
	/** The current organization detail, used for the section header label. */
	org: OrgDetail | null;
	/** Full list of organization members to display. */
	members: MemberRecord[];
	/** The current user's profile, used to suppress self-edit/remove controls. */
	profile: ConnectResult | null;
	/** Opens the Invite Member modal. */
	onInvite: () => void;
	/** Opens the Change Role modal for a specific member. */
	onChangeRole: (m: MemberRecord) => void;
	/** Opens the remove/cancel-invite confirmation modal for the given member. */
	onRemove: (m: MemberRecord) => void;
	/** Resends the initialization email for a pending member. */
	onResendInvite: (m: MemberRecord) => Promise<void>;
	/** True when the current user has org.admin permissions. */
	isOrgAdmin: boolean;
}

// =============================================================================
// MEMBERS PANEL
// =============================================================================

/**
 * The Members tab panel.
 *
 * Renders a Card headed with the org name and member count, an Invite action,
 * and a DataTable body (search, sort, pagination) flanked by the A-Z letter
 * selector strip.
 */
export const MembersPanel: React.FC<MembersPanelProps> = ({ org, members, profile, onInvite, onChangeRole, onRemove, onResendInvite, isOrgAdmin }) => {
	const [activeLetter, setActiveLetter] = useState<string | null>(null);
	const [resendingUserId, setResendingUserId] = useState<string | null>(null);
	const [resentUserId, setResentUserId] = useState<string | null>(null);

	// Determine which letters have at least one matching member.
	const availableLetters = useMemo(() => {
		const set = new Set<string>();
		for (const m of members) {
			const first = (m.displayName || m.email || '').charAt(0).toUpperCase();
			if (first >= 'A' && first <= 'Z') set.add(first);
		}
		return set;
	}, [members]);

	// A-Z letter filter applied BEFORE the table: the DataTable's own search
	// then narrows within the selected letter.
	const letterFiltered = useMemo(() => {
		if (!activeLetter) return members;
		return members.filter((m) => {
			const first = (m.displayName || m.email || '').charAt(0).toUpperCase();
			return first === activeLetter;
		});
	}, [members, activeLetter]);

	// Flatten member records into table rows.
	const rows = useMemo<MemberRow[]>(
		() =>
			letterFiltered.map((m) => ({
				userId: m.userId,
				displayName: m.displayName,
				email: m.email,
				role: m.role,
				status: m.status,
			})),
		[letterFiltered]
	);

	// Client-side data source over the (letter-filtered) member rows.
	const source = useMemo(() => createArrayDataSource<MemberRow>(rows), [rows]);

	// Column definitions; cells keep the existing avatar / badge renderings.
	const columns = useMemo<DataTableColumn<MemberRow>[]>(
		() => [
			{
				key: 'displayName',
				label: 'Member',
				sortable: true,
				render: (row) => (
					<div style={styles.cellCluster}>
						<Avatar name={row.displayName} email={row.email} size={28} />
						<span>
							{row.displayName}
							{/* Annotate the authenticated user's own row with "(you)". */}
							{row.userId === profile?.userId && <span style={styles.youTag}>(you)</span>}
						</span>
					</div>
				),
			},
			{ key: 'email', label: 'Email', sortable: true },
			{
				key: 'role',
				label: 'Role',
				sortable: true,
				// Pending invitations show the Pending badge in place of a role.
				render: (row) => (row.status === 'pending' ? <Badge variant="pending">Pending</Badge> : <Badge variant={row.role === 'admin' ? 'admin' : 'member'}>{row.role}</Badge>),
			},
		],
		[profile?.userId]
	);

	/**
	 * Resolves a table row back to its member record. No-ops via undefined if
	 * the record has vanished from the prop between render and click.
	 *
	 * @param row - The clicked table row.
	 * @returns The matching member record, or undefined.
	 */
	const recordFor = (row: MemberRow): MemberRecord | undefined => members.find((m) => m.userId === row.userId);

	/**
	 * Resends the invitation email for a pending member, tracking in-flight and
	 * "Sent!" confirmation state per user id.
	 *
	 * @param row - The pending member's table row.
	 */
	const handleResend = async (row: MemberRow): Promise<void> => {
		const record = recordFor(row);
		if (!record) return;
		setResendingUserId(row.userId);
		try {
			await onResendInvite(record);
			setResentUserId(row.userId);
			setTimeout(() => setResentUserId(null), 3000);
		} finally {
			setResendingUserId(null);
		}
	};

	/**
	 * Renders the per-row action buttons: nothing for the current user,
	 * Resend / Cancel for pending invitations, Edit / Remove for active
	 * members — admin only in both cases.
	 *
	 * @param row - The member's table row.
	 * @returns The action node for the row, or null.
	 */
	const renderActions = (row: MemberRow): React.ReactNode => {
		// Current user: no self-edit/remove controls.
		if (row.userId === profile?.userId) return null;

		if (row.status === 'pending') {
			// Pending invitation: resend the email or cancel the invite.
			return (
				<div style={styles.rowButtons}>
					{resentUserId === row.userId ? (
						<span style={styles.sentText}>Sent!</span>
					) : (
						<Button variant="ghost" small disabled={resendingUserId === row.userId} onClick={() => handleResend(row)}>
							{resendingUserId === row.userId ? 'Sending...' : 'Resend'}
						</Button>
					)}
					<Button
						variant="ghost"
						small
						onClick={() => {
							const record = recordFor(row);
							if (record) onRemove(record);
						}}
					>
						Cancel
					</Button>
				</div>
			);
		}

		// Active member: change role or remove from the organization.
		return (
			<div style={styles.rowButtons}>
				<Button
					variant="ghost"
					small
					onClick={() => {
						const record = recordFor(row);
						if (record) onChangeRole(record);
					}}
				>
					Edit
				</Button>
				<Button
					variant="ghost"
					small
					onClick={() => {
						const record = recordFor(row);
						if (record) onRemove(record);
					}}
				>
					Remove
				</Button>
			</div>
		);
	};

	/** Handles letter click — toggles off if already selected. */
	const handleLetterClick = (letter: string) => {
		if (!availableLetters.has(letter)) return;
		setActiveLetter((prev) => (prev === letter ? null : letter));
	};

	return (
		<section>
			<Card
				header={`${org ? `${org.name} — ` : ''}${members.length} member${members.length !== 1 ? 's' : ''}`}
				headerActions={
					isOrgAdmin ? (
						<Button variant="primary" small onClick={onInvite}>
							+ Invite
						</Button>
					) : undefined
				}
				noBodyPadding
			>
				{/* Body: member table + A-Z sidebar */}
				<div style={styles.body}>
					<div style={styles.tableWrap}>
						<DataTable<MemberRow>
							columns={columns}
							source={source}
							searchPlaceholder="Search members…"
							countLabel={(n) => `${n} member${n !== 1 ? 's' : ''}`}
							// The Actions column only exists for org admins; member rows
							// without actions (the viewer's own row) render an empty cell.
							actions={isOrgAdmin ? renderActions : undefined}
							emptyState={{ title: members.length === 0 ? 'No members yet' : 'No members match the current filter' }}
						/>
					</div>

					{/* A-Z letter sidebar */}
					<div style={styles.azBar}>
						{LETTERS.map((letter) => {
							const available = availableLetters.has(letter);
							const active = activeLetter === letter;
							return (
								<button
									key={letter}
									style={{
										...styles.azLetter,
										...(active ? styles.azLetterActive : {}),
										...(!available && !active ? styles.azLetterDisabled : {}),
									}}
									onClick={() => handleLetterClick(letter)}
									tabIndex={available ? 0 : -1}
								>
									{letter}
								</button>
							);
						})}
					</div>
				</div>
			</Card>
		</section>
	);
};
