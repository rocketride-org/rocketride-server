// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CloudPanel — target panel for Cloud connection mode.
 *
 * Renders: sign-in/out status, team selector.
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React, { useEffect } from 'react';
import cloudLogoDark from '../../../../../rocketride-dark-icon.png';
import cloudLogoLight from '../../../../../rocketride-light-icon.png';
import { settingsStyles as S } from '../../PageSettings/SettingsWebview';
import { useTheme } from '../../hooks/useTheme';

// =============================================================================
// TYPES
// =============================================================================

export interface CloudPanelProps {
	cloudSignedIn: boolean;
	cloudUserName: string;
	onCloudSignIn: () => void;
	onCloudSignOut: () => void;
	teams: Array<{ id: string; name: string }>;
	selectedTeamId: string;
	onTeamChange: (teamId: string) => void;
	idPrefix: string;
	simplified?: boolean;
	/** Whether the server supports SaaS/OAuth. When false, shows an incompatible-server message. */
	isSaas?: boolean;
	/** Called on mount to trigger a server probe. Parent updates isSaas when result arrives. */
	onProbeServer?: () => void;
	/** Called when isSaas becomes true, to fetch the team list. */
	onFetchTeams?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const CloudPanel: React.FC<CloudPanelProps> = ({ cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut, teams, selectedTeamId, onTeamChange, idPrefix, isSaas, onProbeServer, onFetchTeams }) => {
	const id = (name: string) => `${idPrefix}-${name}`;
	const theme = useTheme();

	// Stage 1: Probe on mount to check if server supports cloud/OAuth
	useEffect(() => {
		if (onProbeServer) onProbeServer();
	}, []);

	// Stage 2: Once confirmed SaaS, fetch teams
	useEffect(() => {
		if (isSaas && onFetchTeams) onFetchTeams();
	}, [isSaas]);

	return (
		<>
			<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
				<img src={theme === 'dark' ? cloudLogoLight : cloudLogoDark} alt="RocketRide Cloud" style={{ width: 48, height: 48, objectFit: 'contain', flexShrink: 0 }} />
				<div style={S.modeConfigDesc}>Sign in with your RocketRide account to connect to the cloud.</div>
			</div>

			{/* Probing server... */}
			{isSaas === undefined && <div style={S.modeConfigDesc}>Checking server compatibility...</div>}

			{/* Server does not support cloud/OAuth */}
			{isSaas === false && <div style={{ padding: '12px 16px', borderRadius: 4, backgroundColor: 'var(--vscode-inputValidation-warningBackground, #4d3a00)', border: '1px solid var(--vscode-inputValidation-warningBorder, #f0c000)', color: 'var(--rr-text-primary)', fontSize: 13, lineHeight: 1.5 }}>The configured server does not support RocketRide Cloud. Cloud mode requires a RocketRide Cloud server. Please use a different connection mode.</div>}

			{/* Sign-in status — only when server supports cloud */}
			{isSaas && cloudSignedIn && (
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
			)}
			{isSaas && !cloudSignedIn && (
				<div style={S.formGroup}>
					<button type="button" onClick={onCloudSignIn} style={{ width: 'auto', padding: '10px 24px', fontWeight: 600 }}>
						Sign In
					</button>
				</div>
			)}

			{/* Team selector */}
			{isSaas && cloudSignedIn && teams.length > 0 && (
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
		</>
	);
};
