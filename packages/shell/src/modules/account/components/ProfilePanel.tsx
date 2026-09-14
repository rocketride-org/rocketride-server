// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProfilePanel — the Profile tab within AccountView.
 *
 * Displays the user's avatar card with identity information, organization
 * and team memberships with development-team assignment, and the Edit Profile
 * record panel — an edit-only form DetailPanel per the interaction standard
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

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import { Card } from '../../../components/card/Card';
import { DetailPanel } from '../../../components/detail-panel/DetailPanel';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Banner } from '../../../components/banner/Banner';
import { Button } from '../../../components/button/Button';
import type { ConnectResult, ProfileUpdate } from '../types';
import { S, Badge, Avatar, initials, avatarColor } from './shared';

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

	/** Green check label for the active org / development team. */
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
	/** Assigns the team the user's development runs execute under, by its ID. */
	onSetDevTeam: (teamId: string) => void;
	/** Switches the user's active organization by its ID. */
	onSetDefaultOrg: (orgId: string) => void;
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
 * a list of their organizations and team memberships with a development-team
 * assignment action per team, and an inline Edit Profile modal.
 */
export const ProfilePanel: React.FC<ProfilePanelProps> = ({ profile, authUser, onSave, onSetDevTeam, onSetDefaultOrg }) => {
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
												const isDevTeam = authUser?.devTeam === t.id;
												const isLast = i === o.teams.length - 1;
												return (
													<div key={t.id} style={styles.teamRow(isLast, oi < memberships.length - 1)}>
														<div style={styles.teamChip(t.name)}>{t.name[0]}</div>
														<div style={S.rowInfo}>
															<div style={S.rowName}>{t.name}</div>
														</div>
														{isDevTeam ? (
															<span style={styles.activeLabel}>{'✓'} Development team</span>
														) : (
															<Button variant="ghost" small onClick={() => onSetDevTeam(t.id)}>
																Set as development team
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
