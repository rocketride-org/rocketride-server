// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SimpleModeFields — shared config fields for Docker and Service modes.
 *
 * Renders: description text + auto-connect checkbox.
 * Used by both ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React from 'react';
import { settingsStyles as S } from '../PageSettings/SettingsWebview';

// =============================================================================
// TYPES
// =============================================================================

export interface SimpleModeFieldsProps {
	description: string;
	autoConnect: boolean;
	onAutoConnectChange: (checked: boolean) => void;
	/** HTML id prefix to avoid duplicate ids when mounted in multiple panels. */
	idPrefix: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const SimpleModeFields: React.FC<SimpleModeFieldsProps> = ({ description, autoConnect, onAutoConnectChange, idPrefix }) => {
	const id = (name: string) => `${idPrefix}-${name}`;

	return (
		<>
			<div style={S.modeConfigDesc}>{description}</div>
			<div style={S.formGroup}>
				<label htmlFor={id('autoConnect')} style={S.label}>
					Auto-connect on startup
				</label>
				<div>
					<input type="checkbox" id={id('autoConnect')} checked={autoConnect} onChange={(e) => onAutoConnectChange(e.target.checked)} style={{ marginRight: 8, verticalAlign: 'middle' }} />
					<label htmlFor={id('autoConnect')} style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
						Automatically connect when extension starts
					</label>
				</div>
			</div>
		</>
	);
};
