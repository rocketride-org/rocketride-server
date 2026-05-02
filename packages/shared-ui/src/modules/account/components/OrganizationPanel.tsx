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

import React from 'react';
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
	/** The current value of the organization name text input (controlled). */
	editOrgName: string;
	/** True while the name-save request is in flight. */
	orgSaving: boolean;
	/** An error message to display below the name field, or null. */
	orgError: string | null;
	/** Called on every keystroke in the org name input. */
	onOrgNameChange: (v: string) => void;
	/** Triggers the persistence of the updated org name. */
	onOrgNameSave: () => void;
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
export const OrganizationPanel: React.FC<OrganizationPanelProps> = ({ org, editOrgName, orgSaving, orgError, onOrgNameChange, onOrgNameSave, isOrgAdmin }) => (
	<section>
		<div style={{ ...commonStyles.card, marginBottom: 14 }}>
			<div style={commonStyles.cardHeader}>
				<span>Organization{org ? ` \u2014 ${org.name}` : ''}</span>
			</div>
			<div style={commonStyles.cardBody}>
				<div style={S.field}>
					<div style={S.fieldLabel}>Organization Name</div>
					<input
						value={editOrgName}
						onChange={(e) => isOrgAdmin && onOrgNameChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && isOrgAdmin) onOrgNameSave();
						}}
						readOnly={!isOrgAdmin}
						style={{ ...commonStyles.inputField, maxWidth: 280, ...(isOrgAdmin ? {} : { opacity: 0.7, cursor: 'default' }) }}
					/>
					{orgError && <div style={{ fontSize: 11, color: 'var(--rr-color-error)', marginTop: 4 }}>{orgError}</div>}
				</div>
				{isOrgAdmin && (
					<button style={{ ...commonStyles.buttonPrimary, ...(orgSaving ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={onOrgNameSave} disabled={orgSaving}>
						{orgSaving ? 'Saving\u2026' : 'Save Changes'}
					</button>
				)}
			</div>
		</div>
	</section>
);
