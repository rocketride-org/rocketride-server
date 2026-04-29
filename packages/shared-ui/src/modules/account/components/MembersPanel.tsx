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
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, OrgDetail, MemberRecord } from '../types';
import { S, Btn, Badge, Avatar } from './shared';

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
	/** Immediately removes or cancels the invitation for the given userId. */
	onRemove: (userId: string) => void;
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
export const MembersPanel: React.FC<MembersPanelProps> = ({ org, members, profile, onInvite, onChangeRole, onRemove }) => (
	<section>
		<div style={commonStyles.sectionHeader}>
			<span style={commonStyles.sectionHeaderLabel}>{org ? `Members \u2014 ${org.name}` : 'Members'}</span>
		</div>

		<div style={{ ...commonStyles.card, marginBottom: 14 }}>
			<div style={commonStyles.cardHeader}>
				<span>
					{members.length} member{members.length !== 1 ? 's' : ''}
				</span>
				<Btn variant="primary" onClick={onInvite} small>
					+ Invite
				</Btn>
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
							<div style={S.rowSub}>{m.email}</div>
						</div>
						{m.userId === profile?.userId ? (
							// Current user: show role badge only, no edit/remove.
							<Badge variant={m.role === 'admin' ? 'admin' : 'member'}>{m.role}</Badge>
						) : m.status === 'pending' ? (
							// Pending invitation: show badge and a cancel button.
							<div style={S.rowActions}>
								<Badge variant="pending">Pending</Badge>
								<Btn variant="danger" small onClick={() => onRemove(m.userId)}>
									Cancel
								</Btn>
							</div>
						) : (
							// Active member: show role badge with edit and remove options.
							<div style={S.rowActions}>
								<Badge variant={m.role === 'admin' ? 'admin' : 'member'}>{m.role}</Badge>
								<Btn variant="ghost" small onClick={() => onChangeRole(m)}>
									Edit
								</Btn>
								<Btn variant="danger" small onClick={() => onRemove(m.userId)}>
									Remove
								</Btn>
							</div>
						)}
					</div>
				))}
				{members.length === 0 && <div style={{ padding: '20px 18px', color: 'var(--rr-text-disabled)', fontSize: 12 }}>No members yet.</div>}
			</div>
		</div>
	</section>
);
