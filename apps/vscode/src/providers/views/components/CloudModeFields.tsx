// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CloudModeFields — shared config fields for "Cloud" connection mode.
 *
 * Renders: sign-in/out status, team selector, auto-connect checkbox.
 * Used by both ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React from 'react';
import { settingsStyles as S } from '../PageSettings/SettingsWebview';

// =============================================================================
// TYPES
// =============================================================================

export interface CloudModeFieldsProps {
	cloudSignedIn: boolean;
	cloudUserName: string;
	onCloudSignIn: () => void;
	onCloudSignOut: () => void;
	teams: Array<{ id: string; name: string }>;
	selectedTeamId: string;
	onTeamChange: (teamId: string) => void;
	autoConnect: boolean;
	onAutoConnectChange: (checked: boolean) => void;
	/** HTML id prefix to avoid duplicate ids when mounted in multiple panels. */
	idPrefix: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const CloudModeFields: React.FC<CloudModeFieldsProps> = ({ cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut, teams, selectedTeamId, onTeamChange, autoConnect, onAutoConnectChange, idPrefix }) => {
	const id = (name: string) => `${idPrefix}-${name}`;

	return (
		<>
			<div style={S.modeConfigDesc}>Sign in with your RocketRide account to connect to the cloud.</div>

			{/* Sign-in status */}
			{cloudSignedIn ? (
				<div style={S.formGroup}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
						<span style={{ fontSize: 20, color: 'var(--vscode-testing-iconPassed, #22c55e)' }}>&#10003;</span>
						<div>
							<div style={{ fontWeight: 600, color: 'var(--rr-text-primary)' }}>{cloudUserName || 'Signed in'}</div>
						</div>
					</div>
					<button
						type="button"
						onClick={onCloudSignOut}
						style={{
							width: 'auto',
							marginTop: 8,
							backgroundColor: 'var(--vscode-button-secondaryBackground)',
							color: 'var(--vscode-button-secondaryForeground)',
						}}
					>
						Sign Out
					</button>
				</div>
			) : (
				<div style={S.formGroup}>
					<button type="button" onClick={onCloudSignIn} style={{ width: 'auto', padding: '10px 24px', fontWeight: 600 }}>
						Sign In
					</button>
				</div>
			)}

			{/* Team selector */}
			{cloudSignedIn && teams.length > 0 && (
				<div style={S.formGroup}>
					<label htmlFor={id('team')} style={S.label}>
						Team
					</label>
					<select id={id('team')} value={selectedTeamId} onChange={(e) => onTeamChange(e.target.value)}>
						<option value="">Select a team...</option>
						{teams.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
							</option>
						))}
					</select>
					<div style={S.helpText}>Which team's engine to connect to</div>
				</div>
			)}

			{/* Auto-connect */}
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
