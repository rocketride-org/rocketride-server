// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MembersPanel — the Members tab within AccountView.
 *
 * Lists all organization members in the stock DataGrid (sort, pagination)
 * inside a stock Card, with a toolbar search box above the grid and the A-Z
 * letter selector preserved as a strip along the table's right edge. Pending
 * invitations show Resend / Cancel actions instead of Edit / Remove. The
 * current user's own row shows their role but no action buttons.
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataGrid } from '../../../components/data-grid/DataGrid';
import { avatarEl, buttonEl, matchesSearch } from '../../../components/data-grid/defaults';
import type { GridColumnDefinition } from '../../../components/data-grid/defaults';
import { InputField } from '../../../components/input-field/InputField';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import type { ConnectResult, OrgDetail, MemberRecord } from '../types';
import { initials, avatarColor } from './shared';

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

	/** Toolbar above the grid: search box + row count (old stock-table toolbar spec). */
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '12px 16px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Toolbar search box sizing (30px tall, 260px wide — old stock-table spec). */
	search: {
		width: 260,
		height: 30,
	} as CSSProperties,

	/** Toolbar row-count text (old stock-table count spec). */
	count: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

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

	/** Role / status badge shape (commonStyles.badge values + surface fill); text color set per variant. */
	roleBadge: {
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

	/** "Sent!" confirmation after a successful invite resend (DOM style for the grid formatter). */
	sentText: {
		fontSize: '11px',
		color: 'var(--rr-color-success)',
		fontWeight: '600',
	} as Partial<CSSStyleDeclaration>,
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Debounce applied to the toolbar search input (old stock-table spec). */
const SEARCH_DEBOUNCE_MS = 250;

// =============================================================================
// CELL BUILDERS
// =============================================================================

/**
 * Builds a member cell — 28px initials avatar beside the display name, with a
 * "(you)" tag on the viewer's own row (DOM clone of the old Avatar + cluster
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

/**
 * Builds a role / status badge (DOM clone of the shared Badge component's
 * admin / member / pending variants — surface fill, variant text color).
 *
 * @param variant - Badge variant determining the text color.
 * @param label - Badge label text.
 * @returns The badge element.
 */
function roleBadgeEl(variant: 'admin' | 'member' | 'pending', label: string): HTMLElement {
	const el = document.createElement('span');
	Object.assign(el.style, styles.roleBadge);
	// Variant text colors mirror the shared Badge's overrides.
	el.style.color = variant === 'admin' ? 'var(--rr-brand)' : variant === 'pending' ? 'var(--rr-color-warning)' : 'var(--rr-text-secondary)';
	el.textContent = label;
	return el;
}

// =============================================================================
// TYPES
// =============================================================================

/** Flattened row shape fed to the members DataGrid. */
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
 * a toolbar search box, and a DataGrid body (sort, pagination) flanked by the
 * A-Z letter selector strip.
 */
export const MembersPanel: React.FC<MembersPanelProps> = ({ org, members, profile, onInvite, onChangeRole, onRemove, onResendInvite, isOrgAdmin }) => {
	const [activeLetter, setActiveLetter] = useState<string | null>(null);
	const [resendingUserId, setResendingUserId] = useState<string | null>(null);
	const [resentUserId, setResentUserId] = useState<string | null>(null);
	// Toolbar search input, debounced before filtering (old stock-table behavior).
	const [searchInput, setSearchInput] = useState('');
	const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);

	// Determine which letters have at least one matching member.
	const availableLetters = useMemo(() => {
		const set = new Set<string>();
		for (const m of members) {
			const first = (m.displayName || m.email || '').charAt(0).toUpperCase();
			if (first >= 'A' && first <= 'Z') set.add(first);
		}
		return set;
	}, [members]);

	// A-Z letter filter applied BEFORE the search: the toolbar search then
	// narrows within the selected letter.
	const letterFiltered = useMemo(() => {
		if (!activeLetter) return members;
		return members.filter((m) => {
			const first = (m.displayName || m.email || '').charAt(0).toUpperCase();
			return first === activeLetter;
		});
	}, [members, activeLetter]);

	// Flatten member records into table rows.
	const allRows = useMemo<MemberRow[]>(
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

	// View-side search over the (letter-filtered) rows — replaces the old
	// stock table's built-in search box.
	const rows = useMemo<MemberRow[]>(() => allRows.filter((row) => matchesSearch(row, search)), [allRows, search]);

	/**
	 * Resolves a table row back to its member record. No-ops via undefined if
	 * the record has vanished from the prop between render and click.
	 *
	 * @param row - The clicked table row.
	 * @returns The matching member record, or undefined.
	 */
	const recordFor = (row: MemberRow): MemberRecord | undefined => members.find((m) => m.userId === row.userId);

	// Mounted flag guarding the async resend flow — the await and the 3s
	// confirmation timer can both outlive the panel (e.g. the modal closes).
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

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
			// Skip the confirmation state entirely if the panel is already gone.
			if (!mountedRef.current) return;
			setResentUserId(row.userId);
			setTimeout(() => {
				if (mountedRef.current) setResentUserId(null);
			}, 3000);
		} finally {
			if (mountedRef.current) setResendingUserId(null);
		}
	};

	// Live action router — the actions column's cellClick is baked into the
	// memoized column definition, so it dispatches through this ref to always
	// reach the latest prop closures and member records.
	const actionRef = useRef<(action: string, row: MemberRow) => void>(() => undefined);
	actionRef.current = (action, row) => {
		// Route the clicked button's action key to the matching handler.
		if (action === 'resend') {
			void handleResend(row);
			return;
		}
		const record = recordFor(row);
		if (!record) return;
		if (action === 'edit') onChangeRole(record);
		else if (action === 'remove') onRemove(record);
	};

	// Column definitions; cells keep the existing avatar / badge renderings.
	const columns = useMemo<GridColumnDefinition[]>(() => {
		const cols: GridColumnDefinition[] = [
			{
				title: 'Member',
				field: 'displayName',
				headerSort: true,
				// Avatar + name cluster, "(you)" on the viewer's own row.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as MemberRow;
					return memberCellEl(row.displayName, row.email, row.userId === profile?.userId);
				},
			},
			{ title: 'Email', field: 'email', headerSort: true },
			{
				title: 'Role',
				field: 'role',
				headerSort: true,
				// Pending invitations show the Pending badge in place of a role.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as MemberRow;
					return row.status === 'pending' ? roleBadgeEl('pending', 'Pending') : roleBadgeEl(row.role === 'admin' ? 'admin' : 'member', row.role);
				},
			},
		];
		// The Actions column only exists for org admins: nothing for the current
		// user, Resend / Cancel for pending invitations, Edit / Remove for active
		// members. Built by hand instead of createActionsColumn because the
		// button set varies per row (and Resend has in-flight / "Sent!" states).
		if (isOrgAdmin) {
			cols.push({
				title: 'Actions',
				field: '__rrActions',
				width: 150,
				hozAlign: 'right',
				headerSort: false,
				// Popup-exempt actions column (no header popup, no toggle-list
				// entry); the marker is stripped before reaching Tabulator.
				rrNoPopup: true,
				resizable: false,
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as MemberRow;
					const wrap = document.createElement('span');
					wrap.dataset.rrActions = 'true';
					wrap.className = 'rr-cell-actions';
					// Current user: no self-edit/remove controls.
					if (row.userId === profile?.userId) return wrap;
					if (row.status === 'pending') {
						// Pending invitation: resend the email or cancel the invite.
						if (resentUserId === row.userId) {
							// "Sent!" confirmation replaces the Resend button briefly.
							const sent = document.createElement('span');
							Object.assign(sent.style, styles.sentText);
							sent.textContent = 'Sent!';
							wrap.appendChild(sent);
						} else {
							const resend = buttonEl('ghost', resendingUserId === row.userId ? 'Sending...' : 'Resend', 'resend');
							if (resendingUserId === row.userId) (resend as HTMLButtonElement).disabled = true;
							wrap.appendChild(resend);
						}
						wrap.appendChild(buttonEl('ghost', 'Cancel', 'remove'));
					} else {
						// Active member: change role or remove from the organization.
						wrap.appendChild(buttonEl('ghost', 'Edit', 'edit'));
						wrap.appendChild(buttonEl('ghost', 'Remove', 'remove'));
					}
					return wrap;
				},
				// Route clicks on the buttons to the live action router by key.
				cellClick: (e: UIEvent, cell: CellComponent) => {
					const target = (e.target as HTMLElement).closest('button[data-action]');
					if (!target) return;
					actionRef.current((target as HTMLElement).dataset.action ?? '', cell.getRow().getData() as MemberRow);
				},
			});
		}
		return cols;
	}, [isOrgAdmin, profile?.userId, resendingUserId, resentUserId]);

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
						{/* Toolbar: search box + filtered row count (replaces the old
						    stock table's built-in toolbar). */}
						<div style={styles.toolbar}>
							<InputField style={styles.search} placeholder="Search members…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
							<span style={styles.count}>{`${rows.length} member${rows.length !== 1 ? 's' : ''}`}</span>
						</div>
						<DataGrid<MemberRow>
							columns={columns}
							data={rows}
							emptyTitle={members.length === 0 ? 'No members yet' : 'No members match the current filter'}
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
