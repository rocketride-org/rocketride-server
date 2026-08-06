// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * OrganizationPanel — the Organization tab within AccountView.
 *
 * Currently exposes a single "Organization" Card that lets an org admin rename
 * the organization. Additional settings (billing, SSO, etc.) can be added as
 * Cards beneath the existing one in future iterations.
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell/src/themes/styles';
import { Card, Button } from 'shell';
import type { OrgDetail } from '../types';
import { S } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Cluster of status text + action buttons in the card header. */
	headerCluster: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,

	/** Inline error message shown next to the header actions. */
	errorText: {
		fontSize: 11,
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	/** Inline "Saved" confirmation shown next to the header actions. */
	savedText: {
		fontSize: 11,
		color: 'var(--rr-color-success)',
	} as CSSProperties,

	/** Organization name input — capped width inside the card body. */
	input: {
		...commonStyles.inputField,
		maxWidth: 280,
	} as CSSProperties,

	/** Read-only treatment for non-admin viewers. */
	inputReadOnly: {
		opacity: 0.7,
		cursor: 'default',
	} as CSSProperties,
};

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
 * Currently exposes a single "Organization" Card that lets an org admin rename
 * the organization. Additional settings (billing, SSO, etc.) can be added as
 * Cards beneath the existing one in future iterations.
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

	/** Discards the local draft and restores the persisted name. */
	const handleCancel = useCallback(() => {
		setEditName(org?.name ?? '');
		setDirty(false);
		setError(null);
	}, [org?.name]);

	return (
		<section>
			<Card
				header="Organization"
				headerActions={
					<div style={styles.headerCluster}>
						{/* Status feedback from the last save attempt. */}
						{error && <span style={styles.errorText}>{error}</span>}
						{saved && <span style={styles.savedText}>Saved</span>}
						{/* Save / Cancel only appear for admins with unsaved edits. */}
						{isOrgAdmin && dirty && (
							<>
								<Button variant="ghost" small onClick={handleCancel} disabled={saving}>
									Cancel
								</Button>
								<Button variant="primary" small onClick={handleSave} disabled={saving}>
									{saving ? 'Saving…' : 'Save'}
								</Button>
							</>
						)}
					</div>
				}
			>
				<div style={S.field}>
					<div style={S.fieldLabel}>Organization Name</div>
					<input
						value={editName}
						onChange={handleChange}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && isOrgAdmin && dirty) handleSave();
						}}
						readOnly={!isOrgAdmin}
						style={{ ...styles.input, ...(isOrgAdmin ? {} : styles.inputReadOnly) }}
					/>
				</div>
			</Card>
		</section>
	);
};
