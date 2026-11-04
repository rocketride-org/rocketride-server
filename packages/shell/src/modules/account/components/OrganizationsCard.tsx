// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * OrganizationsCard — the user's organizations list at the top of the
 * Organization tab.
 *
 * Lists every organization the user belongs to with the active one marked, a
 * "Switch to" action per inactive org, and a "Leave" action per org guarded by
 * the stock ConfirmDialog. Leave is disabled (with a hint) when the profile
 * flags the user as the org's last admin; leaving the user's only organization
 * is allowed but the confirm warns that they will be left without a workspace.
 * A refused leave (e.g. the server's own last-admin guard) renders the
 * server's message as a Banner at the top of the card body. All server
 * interactions are delegated to the host via callback props.
 */

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import { Card } from '../../../components/card/Card';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Banner } from '../../../components/banner/Banner';
import { Button } from '../../../components/button/Button';
import type { OrgInfo } from '../types';
import { S, Badge, Avatar } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/**
	 * Membership org row: dimmed when the org is not the active one.
	 *
	 * @param active - Whether the org is the user's active organization.
	 */
	orgRow: (active: boolean): CSSProperties => ({
		...S.rowItem,
		borderBottom: 'none',
		opacity: active ? 1 : 0.45,
	}),

	/** Green check label for the active org. */
	activeLabel: {
		fontSize: 11,
		color: 'var(--rr-color-success)',
		fontWeight: 600,
	} as CSSProperties,

	/** Row-end cluster of the per-org actions (Switch to / Leave). */
	rowActions: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
	} as CSSProperties,

	/** Muted hint beside a disabled Leave button (the org's last admin). */
	leaveHint: {
		...commonStyles.textMuted,
		fontSize: 11,
		maxWidth: 220,
		textAlign: 'right',
	} as CSSProperties,

	/** Spacing wrapper for the error Banner at the top of the card body. */
	errorBanner: {
		padding: '12px 20px 0',
	} as CSSProperties,

	/** Empty-state line for a user with no org. */
	emptyOrgs: {
		...commonStyles.textMuted,
		padding: '16px 20px',
	} as CSSProperties,
};

// =============================================================================
// CONSTANTS
// =============================================================================

/** Why Leave is disabled for the org's last admin (tooltip + inline hint). */
const LAST_ADMIN_HINT = "You're the last admin of this organization. Promote another member first.";

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the OrganizationsCard component. */
export interface OrganizationsCardProps {
	/** Every organization the user belongs to (the active org alone when the profile carries no membership list). */
	memberships: OrgInfo[];
	/** The ID of the user's active (default) organization, if any. */
	defaultOrgId: string | undefined;
	/** Switches the user's active organization by its ID. */
	onSetDefaultOrg: (orgId: string) => void;
	/** Removes the user from the organization with the given ID. Hosts that omit it (the VS Code account view) show no Leave button. */
	onLeaveOrg?: (orgId: string) => Promise<void>;
}

// =============================================================================
// ORGANIZATIONS CARD
// =============================================================================

/**
 * The Organizations card: switch between the user's organizations or leave
 * one. Always rendered so a user with no org still sees the empty state.
 */
export const OrganizationsCard: React.FC<OrganizationsCardProps> = ({ memberships, defaultOrgId, onSetDefaultOrg, onLeaveOrg }) => {
	// ── Leave organization ──────────────────────────────────────────────────
	// The org awaiting leave confirmation (stock ConfirmDialog), or null.
	const [confirmLeave, setConfirmLeave] = useState<OrgInfo | null>(null);
	const [leaving, setLeaving] = useState(false);
	const [leaveError, setLeaveError] = useState<string | null>(null);

	/**
	 * Leaves the confirmed organization. Leaving the ACTIVE org triggers the
	 * server's org-changed push, which reloads the shell; leaving another org
	 * relies on the host reloading the profile. A refusal (e.g. the org's
	 * last admin) closes the confirm and shows the server's message.
	 */
	const handleLeave = async () => {
		if (!confirmLeave || !onLeaveOrg) return;
		const org = confirmLeave;
		setLeaving(true);
		setLeaveError(null);
		try {
			await onLeaveOrg(org.id);
			setConfirmLeave(null);
		} catch (e) {
			setConfirmLeave(null);
			setLeaveError(e instanceof Error ? e.message : String(e));
		} finally {
			setLeaving(false);
		}
	};

	// Leaving the user's only organization leaves them without a workspace —
	// allowed, but the confirm dialog says so.
	const isOnlyOrg = memberships.length === 1;

	return (
		<>
			<Card header="Organizations / Workspaces" noBodyPadding>
				{/* Error surface (interaction standard): a stock Banner at the top
				    of the body, e.g. the server refusing the org's last admin. */}
				{leaveError && (
					<div style={styles.errorBanner}>
						<Banner variant="error">{leaveError}</Banner>
					</div>
				)}
				<div style={S.rowList}>
					{memberships.length === 0 && <div style={styles.emptyOrgs}>You don't belong to an organization yet.</div>}
					{memberships.map((o) => {
						const isActive = o.id === defaultOrgId;
						return (
							<div key={o.id} style={styles.orgRow(isActive)}>
								<Avatar name={o.name} size={24} square />
								<div style={S.rowInfo}>
									<div style={S.rowName}>{o.name}</div>
								</div>
								{o.permissions?.includes('org.admin') && <Badge variant="admin">Admin</Badge>}
								<div style={styles.rowActions}>
									{isActive ? (
										<span style={styles.activeLabel}>{'✓'} Active</span>
									) : (
										<Button variant="ghost" small onClick={() => onSetDefaultOrg(o.id)}>
											Switch to
										</Button>
									)}
									{onLeaveOrg && o.isLastAdmin && <span style={styles.leaveHint}>{LAST_ADMIN_HINT}</span>}
									{onLeaveOrg && (
										<Button
											variant="ghost"
											small
											disabled={leaving || !!o.isLastAdmin}
											title={o.isLastAdmin ? LAST_ADMIN_HINT : undefined}
											onClick={() => {
												setLeaveError(null);
												setConfirmLeave(o);
											}}
										>
											Leave
										</Button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</Card>

			{/* -- Leave confirmation (stock dialog) -- */}
			{confirmLeave && (
				<ConfirmDialog
					title="Leave organization"
					message={`Leave ${confirmLeave.name}? You will lose access to its teams and runs.${isOnlyOrg ? ' This is your only organization: you will have no workspace until you are invited to one.' : ''}`}
					confirmLabel={leaving ? 'Leaving…' : 'Leave'}
					confirmDisabled={leaving}
					destructive
					onConfirm={() => void handleLeave()}
					onCancel={() => {
						if (!leaving) setConfirmLeave(null);
					}}
				/>
			)}
		</>
	);
};
