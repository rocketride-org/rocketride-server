// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * OrganizationPanel — the Organization tab within AccountView.
 *
 * Currently exposes a single "General" card that lets an org admin rename the
 * organization. Additional settings (billing, SSO, etc.) can be added as cards
 * beneath the existing one in future iterations.
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { OrgDetail } from '../types';
import { S } from './shared';

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the OrganizationPanel component. */
export interface OrganizationPanelProps {
	/** The current organization detail, or null while loading. */
	org: OrgDetail | null;
	/** Async handler that persists the updated org name. */
	onSave: (name: string) => Promise<void>;
	/** True when the current user has org.admin permissions. */
	isOrgAdmin: boolean;
}

// =============================================================================
// ORGANIZATION PANEL
// =============================================================================

/**
 * The Organization tab panel.
 *
 * Currently exposes a single "General" card that lets an org admin rename the
 * organization. Additional settings (billing, SSO, etc.) can be added as cards
 * beneath the existing one in future iterations.
 */
export const OrganizationPanel: React.FC<OrganizationPanelProps> = ({ org, onSave, isOrgAdmin }) => {
	const [editName, setEditName] = useState('');
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Sync local draft when org data changes externally.
	useEffect(() => {
		setEditName(org?.name ?? '');
		setDirty(false);
	}, [org?.name]);

	/** Updates the local draft and marks dirty. */
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (!isOrgAdmin) return;
			setEditName(e.target.value);
			setDirty(true);
			setSaved(false);
		},
		[isOrgAdmin]
	);

	/** Persists the name and shows the "Saved" indicator. */
	const handleSave = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			await onSave(editName);
			setDirty(false);
			setSaved(true);
			setTimeout(() => setSaved(false), 5000);
		} catch (err: any) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [editName, onSave]);

	return (
		<section>
			<div style={{ ...commonStyles.card, marginBottom: 14 }}>
				<div style={{ ...commonStyles.cardHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
					<span style={commonStyles.labelUppercase}>Organization</span>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						{error && <span style={{ fontSize: 11, color: 'var(--rr-color-error)' }}>{error}</span>}
						{saved && <span style={{ fontSize: 11, color: 'var(--rr-color-success)' }}>Saved</span>}
						{isOrgAdmin && dirty && (
							<>
								<button
									onClick={() => {
										setEditName(org?.name ?? '');
										setDirty(false);
										setError(null);
									}}
									disabled={saving}
									style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardHeaderButton } as CSSProperties}
								>
									Cancel
								</button>
								<button
									onClick={handleSave}
									disabled={saving}
									style={
										{
											...commonStyles.buttonPrimary,
											...commonStyles.cardHeaderButton,
											...(saving ? commonStyles.buttonDisabled : {}),
										} as CSSProperties
									}
								>
									{saving ? 'Saving\u2026' : 'Save'}
								</button>
							</>
						)}
					</div>
				</div>
				<div style={commonStyles.cardBody}>
					<div style={S.field}>
						<div style={S.fieldLabel}>Organization Name</div>
						<input
							value={editName}
							onChange={handleChange}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && isOrgAdmin && dirty) handleSave();
							}}
							readOnly={!isOrgAdmin}
							style={{ ...commonStyles.inputField, maxWidth: 280, ...(isOrgAdmin ? {} : { opacity: 0.7, cursor: 'default' }) }}
						/>
					</div>
				</div>
			</div>
		</section>
	);
};
