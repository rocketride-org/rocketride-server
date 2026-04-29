// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeployTargetSettings — full settings section for the deployment target.
 *
 * Mirrors ConnectionSettings in structure: mode dropdown + mode-specific config
 * via shared components in views/components/.
 *
 * Key differences from ConnectionSettings:
 *   - Uses deploy-specific fields: deployHostUrl, deployApiKey (not shared with dev)
 *   - Cloud sign-in state is SHARED — signing in here or in dev section updates both
 *   - "Deploy to a different target" checkbox controls whether the section is expanded
 *   - When collapsed (deployTargetMode = null), deploy uses the same target as dev
 *   - Local engine settings (version, args, debug) are SHARED with dev
 */

import React from 'react';
import { SettingsData, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { LocalModeFields, CloudModeFields, OnPremModeFields, SimpleModeFields } from '../components';

// =============================================================================
// TYPES
// =============================================================================

interface DeployTargetSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	onSave: () => void;
	teams: Array<{ id: string; name: string }>;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
	onClearCredentials: () => void;
	cloudSignedIn?: boolean;
	cloudUserName?: string;
	onCloudSignIn?: () => void;
	onCloudSignOut?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const DeployTargetSettings: React.FC<DeployTargetSettingsProps> = ({ settings, onSettingsChange, onSave, teams, engineVersions, engineVersionsLoading, onClearCredentials, cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut }) => {
	const hasDeployTarget = settings.deployTargetMode !== null;

	// =========================================================================
	// EVENT HANDLERS
	// =========================================================================

	const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.checked) {
			const defaultMode = cloudSignedIn ? 'cloud' : 'local';
			onSettingsChange({ deployTargetMode: defaultMode });
		} else {
			onSettingsChange({ deployTargetMode: null, deployTargetTeamId: '' });
		}
	};

	const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as SettingsData['deployTargetMode'];
		onSettingsChange({ deployTargetMode: mode });
	};

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={S.card}>
			<SettingsCardHeader title="Deployment Target" onSave={onSave} />
			<div style={S.cardBody}>
				<div style={S.sectionDescription}>Where pipelines are deployed for production. Leave unchecked to deploy to the same target as development.</div>
				<div style={S.formGrid}>
					{/* Enable/disable toggle */}
					<div style={S.formGroup}>
						<div>
							<input type="checkbox" id="deployTargetEnabled" checked={hasDeployTarget} onChange={handleToggle} style={{ marginRight: 8, verticalAlign: 'middle' }} />
							<label htmlFor="deployTargetEnabled" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
								Deploy to a different target
							</label>
						</div>
					</div>

					{/* Mode-specific config (only when enabled) */}
					{hasDeployTarget && (
						<>
							{/* Mode dropdown */}
							<div style={S.formGroup}>
								<label htmlFor="deploy-connectionMode" style={S.label}>
									Target
								</label>
								<select id="deploy-connectionMode" value={settings.deployTargetMode ?? ''} onChange={handleModeChange}>
									<option value="local">Local</option>
									<option value="cloud">RocketRide Cloud</option>
									<option value="onprem">On-prem (your own hosted server)</option>
									<option value="docker">Docker</option>
									<option value="service">Service</option>
								</select>
								<div style={S.helpText}>Choose where to deploy pipelines for production</div>
							</div>

							{/* Mode fields */}
							<div style={S.modeConfigBox}>
								{settings.deployTargetMode === 'local' && <LocalModeFields idPrefix="deploy" engineVersion={settings.localEngineVersion} onVersionChange={(v) => onSettingsChange({ localEngineVersion: v })} engineVersions={engineVersions} engineVersionsLoading={engineVersionsLoading} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} engineArgs={settings.localEngineArgs} onEngineArgsChange={(a) => onSettingsChange({ localEngineArgs: a })} />}

								{settings.deployTargetMode === 'cloud' && <CloudModeFields idPrefix="deploy" cloudSignedIn={cloudSignedIn ?? false} cloudUserName={cloudUserName ?? ''} onCloudSignIn={onCloudSignIn!} onCloudSignOut={onCloudSignOut!} teams={teams} selectedTeamId={settings.deployTargetTeamId} onTeamChange={(id) => onSettingsChange({ deployTargetTeamId: id })} autoConnect={settings.deployAutoConnect} onAutoConnectChange={(c) => onSettingsChange({ deployAutoConnect: c })} />}

								{settings.deployTargetMode === 'onprem' && <OnPremModeFields idPrefix="deploy" hostUrl={settings.deployHostUrl} onHostUrlChange={(url) => onSettingsChange({ deployHostUrl: url })} apiKey={settings.deployApiKey} onApiKeyChange={(key) => onSettingsChange({ deployApiKey: key })} onClearApiKey={onClearCredentials} autoConnect={settings.deployAutoConnect} onAutoConnectChange={(c) => onSettingsChange({ deployAutoConnect: c })} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} />}

								{settings.deployTargetMode === 'docker' && <SimpleModeFields idPrefix="deploy" description="Deploy pipelines to a Docker container." autoConnect={settings.deployAutoConnect} onAutoConnectChange={(c) => onSettingsChange({ deployAutoConnect: c })} />}

								{settings.deployTargetMode === 'service' && <SimpleModeFields idPrefix="deploy" description="Deploy pipelines to a local system service." autoConnect={settings.deployAutoConnect} onAutoConnectChange={(c) => onSettingsChange({ deployAutoConnect: c })} />}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
};
