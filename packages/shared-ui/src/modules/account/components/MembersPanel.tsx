// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MembersPanel — the Members tab within AccountView.
 *
 * Lists all organization members with their avatar, name, email, role badge,
 * and status. Pending invitations show a "Cancel" button instead of edit/remove.
 * The current user's own row shows their role but no action buttons.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, OrgDetail, MemberRecord } from '../types';
import { S, Badge, Avatar } from './shared';

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
 * and status. Pending invitations show a "Cancel" button instead of edit/remove.
 * The current user's own row shows their role but no action buttons.
 */
export const MembersPanel: React.FC<MembersPanelProps> = ({ org, members, profile, onInvite, onChangeRole, onRemove, isOrgAdmin }) => (
	<section>
		<div style={{ ...commonStyles.card, marginBottom: 14 }}>
			<div style={commonStyles.cardHeader}>
				<span>
					{org ? `${org.name} — ` : ''}
					{members.length} member{members.length !== 1 ? 's' : ''}
				</span>
				{isOrgAdmin && (
					<button style={commonStyles.buttonPrimarySmall as CSSProperties} onClick={onInvite}>
						+ Invite
					</button>
				)}
			</div>
			<div style={S.rowList}>
				{members.map((m, i) => (
					<div key={m.userId} style={{ ...S.rowItem, borderBottom: i < members.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
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
							// Pending invitation: show badge and cancel button (admin only).
							<div style={S.rowActions}>
								<Badge variant="pending">Pending</Badge>
								{isOrgAdmin && (
									<button style={commonStyles.buttonSecondarySmall as CSSProperties} onClick={() => onRemove(m)}>
										Cancel
									</button>
								)}
							</div>
						) : (
							// Active member: show role badge with edit and remove (admin only).
							<div style={S.rowActions}>
								<Badge variant={m.role === 'admin' ? 'admin' : 'member'}>{m.role}</Badge>
								{isOrgAdmin && (
									<>
										<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.buttonSmall, border: 'none', background: 'transparent' } as CSSProperties} onClick={() => onChangeRole(m)}>
											Edit
										</button>
										<button style={commonStyles.buttonSecondarySmall as CSSProperties} onClick={() => onRemove(m)}>
											Remove
										</button>
									</>
								)}
							</div>
						)}
					</div>
				))}
				{members.length === 0 && <div style={{ padding: '20px 18px', color: 'var(--rr-text-disabled)', fontSize: 12 }}>No members yet.</div>}
			</div>
		</div>
	</section>
);
