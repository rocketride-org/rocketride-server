// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProfilePanel — the Profile tab within AccountView.
 *
 * Displays the user's avatar card with identity information, organization
 * and team memberships with "Set default" actions, and an inline Edit Profile
 * modal. Grouped sections render as stock Cards. All server interactions are
 * delegated to the host via callback props.
 */

import React, { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import type { ConnectResult, ProfileUpdate } from '../types';
import { S, Badge, Avatar, Modal, initials, avatarColor } from './shared';

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
	 */
	orgRow: (active: boolean): CSSProperties => ({
		...S.rowItem,
		borderBottom: 'none',
		opacity: active ? 1 : 0.45,
	}),

	/** Green check label for the active org / default team. */
	activeLabel: {
		fontSize: 11,
		color: 'var(--rr-color-success)',
		fontWeight: 600,
	} as CSSProperties,

	/** Indented "Teams" caption above the active org's team rows. */
	teamsCaption: {
		paddingLeft: 40,
		paddingTop: 4,
		paddingBottom: 4,
	} as CSSProperties,

	/** Small caption text for the "Teams" label. */
	teamsCaptionText: {
		...commonStyles.labelUppercase,
		fontSize: 9,
	} as CSSProperties,

	/**
	 * Team row under the active org: indented, tight vertical padding, and a
	 * divider only after the last team when another org row follows.
	 *
	 * @param isLast    - Whether this is the last team in the org.
	 * @param needsRule - Whether a divider should follow (another org is next).
	 */
	teamRow: (isLast: boolean, needsRule: boolean): CSSProperties => ({
		...S.rowItem,
		paddingLeft: 40,
		paddingRight: 60,
		paddingTop: 2,
		paddingBottom: isLast ? 12 : 2,
		borderBottom: isLast && needsRule ? '1px solid var(--rr-border)' : 'none',
	}),

	/**
	 * Small square team chip with a deterministic color background.
	 *
	 * @param name - Team name seeding the color.
	 */
	teamChip: (name: string): CSSProperties => ({
		width: 20,
		height: 20,
		borderRadius: 5,
		background: avatarColor(name),
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 10,
		fontWeight: 700,
		color: 'var(--rr-fg-button)',
		flexShrink: 0,
	}),

	/** Inline error message beneath the edit modal fields. */
	modalError: {
		fontSize: 11,
		color: 'var(--rr-color-error)',
		marginTop: 4,
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
	/** Sets the user's preferred default team by its ID. */
	onSetDefaultTeam: (teamId: string) => void;
	/** Switches the user's active organization by its ID. */
	onSetDefaultOrg: (orgId: string) => void;
	/** Triggers the logout flow. */
	onLogout: () => void;
	/** Async handler that permanently deletes the user account. */
	onDeleteAccount: () => Promise<void>;
}

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
 * Displays a large avatar card with the user's identity information,
 * a list of their organizations and team memberships with a "Set default"
 * action per team, and an inline Edit Profile modal.
 */
export const ProfilePanel: React.FC<ProfilePanelProps> = ({ profile, authUser, onSave, onSetDefaultTeam, onSetDefaultOrg }) => {
	/**
	 * Builds a ProfileUpdate snapshot from the current profile/authUser props.
	 * Called both on mount and whenever the underlying data changes, so the
	 * edit modal always opens pre-populated with the freshest values.
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
	const [fields, setFields] = useState<ProfileUpdate>(fromProfile);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Re-sync form fields when the server profile or auth user data is refreshed.
	useEffect(() => {
		setFields(fromProfile());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [profile?.displayName, profile?.email, authUser?.email]);

	/** Returns a change handler for a specific ProfileUpdate field key. */
	const set = (key: keyof ProfileUpdate) => (e: React.ChangeEvent<HTMLInputElement>) => {
		setFields((f) => ({ ...f, [key]: e.target.value }));
		setError(null);
	};

	/** Opens the edit modal and resets its form to the current profile snapshot. */
	const openEdit = () => {
		setFields(fromProfile());
		setError(null);
		setEditOpen(true);
	};
	/** Closes the edit modal and clears any pending error message. */
	const closeEdit = () => {
		setEditOpen(false);
		setError(null);
	};

	/** Submits the edited profile fields; shows an inline error on failure. */
	const handleSave = async () => {
		setSaving(true);
		setError(null);
		try {
			await onSave(fields);
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

			{/* Organizations / workspaces card with team memberships. */}
			{memberships.length > 0 && (
				<Card header="Organizations / Workspaces" noBodyPadding>
					<div style={S.rowList}>
						{memberships.map((o, oi) => {
							const isActive = o.id === defaultOrgId;
							return (
								<React.Fragment key={o.id}>
									{/* Org row */}
									<div style={styles.orgRow(isActive)}>
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
									{/* Teams — only shown for the active org */}
									{isActive && o.teams.length > 0 && (
										<>
											<div style={styles.teamsCaption}>
												<span style={styles.teamsCaptionText}>Teams</span>
											</div>
											{o.teams.map((t, i) => {
												const isDefaultTeam = authUser?.defaultTeam === t.id;
												const isLast = i === o.teams.length - 1;
												return (
													<div key={t.id} style={styles.teamRow(isLast, oi < memberships.length - 1)}>
														<div style={styles.teamChip(t.name)}>{t.name[0]}</div>
														<div style={S.rowInfo}>
															<div style={S.rowName}>{t.name}</div>
														</div>
														{isDefaultTeam ? (
															<span style={styles.activeLabel}>{'✓'} Default</span>
														) : (
															<Button variant="ghost" small onClick={() => onSetDefaultTeam(t.id)}>
																Set default
															</Button>
														)}
													</div>
												);
											})}
										</>
									)}
								</React.Fragment>
							);
						})}
					</div>
				</Card>
			)}

			{/* -- Edit Profile Dialog -- */}
			{editOpen && (
				<Modal
					title="Edit Profile"
					onClose={closeEdit}
					footer={
						<>
							<Button variant="ghost" onClick={closeEdit} disabled={saving}>
								Cancel
							</Button>
							<Button variant="primary" onClick={handleSave} disabled={saving}>
								{saving ? 'Saving…' : 'Save Changes'}
							</Button>
						</>
					}
				>
					<div style={S.fieldRow}>
						<div style={S.field}>
							<div style={S.fieldLabel}>Nickname</div>
							<input value={fields.displayName} onChange={set('displayName')} style={commonStyles.inputField} autoFocus />
							<div style={commonStyles.textMuted}>What we call you in the app</div>
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Login Name</div>
							<input value={fields.preferredUsername} readOnly style={styles.inputReadOnly} />
							<div style={commonStyles.textMuted}>Used to sign in -- contact support to change</div>
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
					{error && <div style={styles.modalError}>{error}</div>}
				</Modal>
			)}
		</section>
	);
};
