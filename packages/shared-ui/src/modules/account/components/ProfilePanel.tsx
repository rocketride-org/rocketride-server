// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProfilePanel — the Profile tab within AccountView.
 *
 * Displays the user's avatar card with identity information, organization
 * and team memberships with "Set default" actions, a Sign Out button, and
 * an inline Edit Profile modal. All server interactions are delegated to
 * the host via callback props.
 */

import React from 'react';
import { commonStyles } from '../../../themes/styles';
import type { ConnectResult, ProfileUpdate } from '../types';
import { S, Btn, Badge, PermPill, Avatar, Modal, initials, avatarColor } from './shared';

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
	/** Triggers the logout flow. */
	onLogout: () => void;
	/** Async handler that permanently deletes the user account. */
	onDeleteAccount: () => Promise<void>;
}

// =============================================================================
// VERIFIED BADGE
// =============================================================================

/** A small green "Verified" pill shown next to a verified email or phone number. */
const VerifiedBadge: React.FC = () => (
	<span
		style={{
			display: 'inline-flex',
			alignItems: 'center',
			gap: 3,
			fontSize: 10,
			fontWeight: 600,
			padding: '1px 6px',
			borderRadius: 4,
			background: 'var(--rr-bg-surface-alt)',
			color: 'var(--rr-color-success)',
		}}
	>
		{'\u2713'} Verified
	</span>
);

// =============================================================================
// PROFILE PANEL
// =============================================================================

/**
 * The Profile tab panel.
 *
 * Displays a large avatar card with the user's identity information,
 * a list of their organizations and team memberships with a "Set default"
 * action per team, a Sign Out button, and an inline Edit Profile modal.
 */
export const ProfilePanel: React.FC<ProfilePanelProps> = ({ profile, authUser, onSave, onSetDefaultTeam, onLogout, onDeleteAccount }) => {
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

	const [editOpen, setEditOpen] = React.useState(false);
	const [fields, setFields] = React.useState<ProfileUpdate>(fromProfile);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	// Re-sync form fields when the server profile or auth user data is refreshed.
	React.useEffect(() => {
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
	const displayName = profile?.displayName || authUser?.displayName || '\u2014';
	const email = profile?.email || authUser?.email || '';
	const orgs = profile?.organizations ?? authUser?.organizations ?? [];

	return (
		<section>
			<div style={commonStyles.sectionHeader}>
				<span style={commonStyles.sectionHeaderLabel}>Profile</span>
			</div>

			<div style={{ ...commonStyles.card, marginBottom: 14 }}>
				<div style={{ padding: '24px 24px 20px', display: 'flex', alignItems: 'center', gap: 18 }}>
					{/* Avatar */}
					<div style={{ width: 64, height: 64, borderRadius: '50%', background: avatarColor(displayName || email), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{initials(displayName, email)}</div>

					{/* Identity */}
					<div style={{ flex: 1, minWidth: 0 }}>
						<div style={{ fontSize: 18, fontWeight: 700, color: 'var(--rr-text-primary)', marginBottom: 4 }}>{displayName}</div>
						{(profile?.preferredUsername || authUser?.preferredUsername) && <div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginBottom: 12 }}>{profile?.preferredUsername || authUser?.preferredUsername}</div>}
						<div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '4px 16px' }}>
							{(profile?.email || authUser?.email) && (
								<span style={{ fontSize: 12, color: 'var(--rr-text-secondary)', display: 'flex', alignItems: 'center', gap: 5 }}>
									{profile?.email || authUser?.email}
									{/* Show verified / unverified badge only when the server has provided the flag. */}
									{profile?.emailVerified !== undefined && (profile.emailVerified ? <VerifiedBadge /> : <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-warning)' }}>Unverified</span>)}
								</span>
							)}
							{(profile?.phoneNumber || authUser?.phoneNumber) && (
								<span style={{ fontSize: 12, color: 'var(--rr-text-secondary)', display: 'flex', alignItems: 'center', gap: 5 }}>
									{profile?.phoneNumber || authUser?.phoneNumber}
									{profile?.phoneNumberVerified !== undefined && (profile.phoneNumberVerified ? <VerifiedBadge /> : <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-warning)' }}>Unverified</span>)}
								</span>
							)}
						</div>
					</div>

					<Btn variant="secondary" small onClick={openEdit}>
						Edit Profile
					</Btn>
				</div>
			</div>

			{orgs.length > 0 && (
				<>
					<div style={commonStyles.sectionHeader}>
						<span style={commonStyles.sectionHeaderLabel}>Organizations</span>
					</div>
					{orgs.map((o) => (
						<div key={o.id} style={{ ...commonStyles.card, marginBottom: 14 }}>
							<div style={commonStyles.cardHeader}>
								<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
									<Avatar name={o.name} size={20} square />
									<span>{o.name}</span>
								</div>
								{o.permissions?.includes('org.admin') && <Badge variant="admin">Admin</Badge>}
							</div>
							<div style={S.rowList}>
								{o.teams.map((t, i) => {
									// Highlight the team that the user has chosen as their default context.
									const isDefault = authUser?.defaultTeam === t.id;
									return (
										<div key={t.id} style={{ ...S.rowItem, borderBottom: i < o.teams.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
											<div style={{ width: 22, height: 22, borderRadius: 5, background: avatarColor(t.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 }}>{t.name[0]}</div>
											<div style={S.rowInfo}>
												<div style={S.rowName}>{t.name}</div>
												<div style={S.perms}>
													{t.permissions.map((p) => (
														<PermPill key={p} perm={p} />
													))}
												</div>
											</div>
											{isDefault ? (
												<span style={{ fontSize: 11, color: 'var(--rr-color-success)', fontWeight: 600 }}>{'\u2713'} Default</span>
											) : (
												<Btn variant="secondary" small onClick={() => onSetDefaultTeam(t.id)}>
													Set default
												</Btn>
											)}
										</div>
									);
								})}
							</div>
						</div>
					))}
				</>
			)}

			{/* -- Edit Profile Dialog -- */}
			{editOpen && (
				<Modal
					title="Edit Profile"
					onClose={closeEdit}
					footer={
						<>
							<Btn variant="secondary" onClick={closeEdit} disabled={saving}>
								Cancel
							</Btn>
							<Btn variant="primary" onClick={handleSave} disabled={saving}>
								{saving ? 'Saving\u2026' : 'Save Changes'}
							</Btn>
						</>
					}
				>
					<div style={S.fieldRow}>
						<div style={S.field}>
							<div style={S.fieldLabel}>Nickname</div>
							<input value={fields.displayName} onChange={set('displayName')} style={S.fieldInput} autoFocus />
							<div style={S.fieldHint}>What we call you in the app</div>
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Login Name</div>
							<input value={fields.preferredUsername} readOnly style={{ ...S.fieldInput, opacity: 0.6, cursor: 'default' }} />
							<div style={S.fieldHint}>Used to sign in -- contact support to change</div>
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>First Name</div>
							<input value={fields.givenName} onChange={set('givenName')} style={S.fieldInput} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Last Name</div>
							<input value={fields.familyName} onChange={set('familyName')} style={S.fieldInput} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Email</div>
							<input value={fields.email} onChange={set('email')} style={S.fieldInput} />
						</div>
						<div style={S.field}>
							<div style={S.fieldLabel}>Phone</div>
							<input value={fields.phoneNumber} onChange={set('phoneNumber')} placeholder="+15550000000" style={S.fieldInput} />
						</div>
					</div>
					{error && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 4 }}>{error}</div>}
				</Modal>
			)}
		</section>
	);
};
