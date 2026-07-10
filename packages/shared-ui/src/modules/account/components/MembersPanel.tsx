// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MembersPanel — the Members tab within AccountView.
 *
 * Lists all organization members with their avatar, name, email, role badge,
 * and status. Includes a search bar and an A-Z letter selector for filtering.
 * Pending invitations show a "Cancel" button instead of edit/remove.
 * The current user's own row shows their role but no action buttons.
 */

import React, { useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, OrgDetail, MemberRecord } from '../types';
import { S, Badge, Avatar } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Container that holds the member list and the A-Z sidebar side by side. */
	body: {
		display: 'flex',
		alignItems: 'stretch',
	} as CSSProperties,

	/** Compact search input in the card header. */
	search: {
		...commonStyles.inputField,
		width: 200,
		margin: 0,
		padding: '4px 8px',
		fontSize: 12,
	} as CSSProperties,

	/** Scrollable member list occupying the remaining width. */
	list: {
		flex: 1,
		minWidth: 0,
		maxHeight: 480,
		overflowY: 'auto',
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
		color: '#fff',
	} as CSSProperties,

	/** Disabled letter (no members start with this letter). */
	azLetterDisabled: {
		color: 'var(--rr-text-disabled)',
		cursor: 'default',
		opacity: 0.4,
	} as CSSProperties,

	/** Muted helper text for empty/filtered states. */
	empty: {
		padding: '20px 18px',
		color: 'var(--rr-text-disabled)',
		fontSize: 12,
	} as CSSProperties,
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

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
 * Lists all organization members with their avatar, name, email, role badge,
 * and status. Includes a top search bar and a right-side A-Z letter selector.
 */
export const MembersPanel: React.FC<MembersPanelProps> = ({ org, members, profile, onInvite, onChangeRole, onRemove, onResendInvite, isOrgAdmin }) => {
	const [search, setSearch] = useState('');
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

	// Filter members by search text and/or selected letter.
	const filtered = useMemo(() => {
		let result = members;

		// A-Z letter filter: match first character of displayName.
		if (activeLetter) {
			result = result.filter((m) => {
				const first = (m.displayName || m.email || '').charAt(0).toUpperCase();
				return first === activeLetter;
			});
		}

		// Search filter: match against displayName or email.
		const q = search.trim().toLowerCase();
		if (q) {
			result = result.filter((m) => {
				const name = (m.displayName || '').toLowerCase();
				const email = (m.email || '').toLowerCase();
				return name.includes(q) || email.includes(q);
			});
		}

		return result;
	}, [members, activeLetter, search]);

	/** Handles letter click — toggles off if already selected. */
	const handleLetterClick = (letter: string) => {
		if (!availableLetters.has(letter)) return;
		setActiveLetter((prev) => (prev === letter ? null : letter));
	};

	return (
		<section>
			<div style={{ ...commonStyles.card, marginBottom: 14 }}>
				{/* Header with search */}
				<div style={commonStyles.cardHeader}>
					<span style={commonStyles.labelUppercase}>
						{org ? `${org.name} — ` : ''}
						{members.length} member{members.length !== 1 ? 's' : ''}
					</span>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<input type="text" placeholder="Search by name or email…" value={search} onChange={(e) => setSearch(e.target.value)} style={styles.search} />
						{isOrgAdmin && (
							<button style={{ ...commonStyles.buttonPrimary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onInvite}>
								+ Invite
							</button>
						)}
					</div>
				</div>

				{/* Body: member list + A-Z sidebar */}
				<div style={styles.body}>
					{/* Member list */}
					<div style={styles.list}>
						{filtered.map((m, i) => (
							<div key={m.userId} style={{ ...S.rowItem, borderBottom: i < filtered.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
								<Avatar name={m.displayName} email={m.email} size={28} />
								<div style={S.rowInfo}>
									<div style={S.rowName}>
										{m.displayName}
										{/* Annotate the authenticated user's own row with "(you)". */}
										{m.userId === profile?.userId && <span style={{ fontSize: 10, color: 'var(--rr-text-disabled)', marginLeft: 5 }}>(you)</span>}
									</div>
									<div style={commonStyles.textMuted}>{m.email}</div>
								</div>
								{m.userId === profile?.userId ? (
									// Current user: show role badge only, no edit/remove.
									<Badge variant={m.role === 'admin' ? 'admin' : 'member'}>{m.role}</Badge>
								) : m.status === 'pending' ? (
									// Pending invitation: show badge, resend, and cancel buttons (admin only).
									<div style={S.rowActions}>
										<Badge variant="pending">Pending</Badge>
										{isOrgAdmin && (
											<>
												{resentUserId === m.userId ? (
													<span style={{ fontSize: 11, color: 'var(--rr-color-success)', fontWeight: 600 }}>Sent!</span>
												) : (
													<button
														style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton, ...(resendingUserId === m.userId ? commonStyles.buttonDisabled : {}) } as CSSProperties}
														disabled={resendingUserId === m.userId}
														onClick={async () => {
															setResendingUserId(m.userId);
															try {
																await onResendInvite(m);
																setResentUserId(m.userId);
																setTimeout(() => setResentUserId(null), 3000);
															} finally {
																setResendingUserId(null);
															}
														}}
													>
														{resendingUserId === m.userId ? 'Sending...' : 'Resend'}
													</button>
												)}
												<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => onRemove(m)}>
													Cancel
												</button>
											</>
										)}
									</div>
								) : (
									// Active member: show role badge with edit and remove (admin only).
									<div style={S.rowActions}>
										<Badge variant={m.role === 'admin' ? 'admin' : 'member'}>{m.role}</Badge>
										{isOrgAdmin && (
											<>
												<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton, border: 'none', background: 'transparent' } as CSSProperties} onClick={() => onChangeRole(m)}>
													Edit
												</button>
												<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => onRemove(m)}>
													Remove
												</button>
											</>
										)}
									</div>
								)}
							</div>
						))}
						{filtered.length === 0 && <div style={styles.empty}>{members.length === 0 ? 'No members yet.' : 'No members match the current filter.'}</div>}
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
			</div>
		</section>
	);
};
