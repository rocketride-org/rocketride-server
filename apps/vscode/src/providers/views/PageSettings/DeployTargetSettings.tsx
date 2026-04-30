// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeployTargetSettings — full settings section for the deployment target.
 *
 * Mirrors ConnectionSettings in structure: mode dropdown + target-specific panel.
 *
 * Key differences from ConnectionSettings:
 *   - Uses deploy-specific fields: deployHostUrl, deployApiKey (not shared with dev)
 *   - Cloud sign-in state is SHARED — signing in here or in dev section updates both
 *   - "Deploy to a different target" checkbox controls whether the section is expanded
 *   - When collapsed (deployTargetMode = null), deploy uses the same target as dev
 */

import React from 'react';
import { SettingsData, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { LocalPanel, CloudPanel, OnPremPanel, DockerPanel, ServicePanel } from '../components/panels';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';

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
	serverCapabilities: string[];
	cloudSignedIn?: boolean;
	cloudUserName?: string;
	onCloudSignIn?: () => void;
	onCloudSignOut?: () => void;
	// Docker panel props
	dockerStatus: DockerStatus;
	dockerProgress: string | null;
	dockerError: string | null;
	dockerBusy: boolean;
	dockerAction: 'install' | 'update' | 'remove' | 'start' | 'stop' | null;
	dockerVersions: VersionOption[];
	dockerSelectedVersion: string;
	onDockerVersionChange: (v: string) => void;
	onDockerInstall: () => void;
	onDockerUpdate: () => void;
	onDockerRemove: () => void;
	onDockerStart: () => void;
	onDockerStop: () => void;
	// Service panel props
	serviceStatus: ServiceStatus;
	serviceProgress: string | null;
	serviceError: string | null;
	serviceBusy: boolean;
	serviceAction: 'install' | 'update' | 'remove' | 'start' | 'stop' | null;
	serviceVersions: VersionOption[];
	serviceSelectedVersion: string;
	onServiceVersionChange: (v: string) => void;
	onServiceInstall: () => void;
	onServiceUpdate: () => void;
	onServiceRemove: () => void;
	onServiceStart: () => void;
	onServiceStop: () => void;
	sudoPromptVisible: boolean;
	sudoPasswordInput: string;
	onSudoPasswordChange: (pw: string) => void;
	onSudoSubmit: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const DeployTargetSettings: React.FC<DeployTargetSettingsProps> = (props) => {
	const { settings, onSettingsChange, onSave, teams, engineVersions, engineVersionsLoading, onClearCredentials, cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut } = props;
	const hasDeployTarget = settings.deployTargetMode !== null;

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
									{props.serverCapabilities.includes('saas') && <option value="cloud">RocketRide Cloud</option>}
									<option value="docker">Docker</option>
									<option value="service">Service</option>
									<option value="onprem">On-prem (your own hosted server)</option>
									<option value="local">Local</option>
								</select>
								<div style={S.helpText}>Choose where to deploy pipelines for production</div>
							</div>

							{/* Target panel */}
							<div style={S.modeConfigBox}>
								{settings.deployTargetMode === 'local' && <LocalPanel idPrefix="deploy" engineVersion={settings.localEngineVersion} onVersionChange={(v) => onSettingsChange({ localEngineVersion: v })} engineVersions={engineVersions} engineVersionsLoading={engineVersionsLoading} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} engineArgs={settings.localEngineArgs} onEngineArgsChange={(a) => onSettingsChange({ localEngineArgs: a })} />}

								{settings.deployTargetMode === 'cloud' && <CloudPanel idPrefix="deploy" cloudSignedIn={cloudSignedIn ?? false} cloudUserName={cloudUserName ?? ''} onCloudSignIn={onCloudSignIn!} onCloudSignOut={onCloudSignOut!} teams={teams} selectedTeamId={settings.deployTargetTeamId} onTeamChange={(id) => onSettingsChange({ deployTargetTeamId: id })} />}

								{settings.deployTargetMode === 'onprem' && <OnPremPanel idPrefix="deploy" hostUrl={settings.deployHostUrl} onHostUrlChange={(url) => onSettingsChange({ deployHostUrl: url })} apiKey={settings.deployApiKey} onApiKeyChange={(key) => onSettingsChange({ deployApiKey: key })} onClearApiKey={onClearCredentials} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} />}

								{settings.deployTargetMode === 'docker' && <DockerPanel idPrefix="deploy" status={props.dockerStatus} progress={props.dockerProgress} error={props.dockerError} busy={props.dockerBusy} action={props.dockerAction} versions={props.dockerVersions} selectedVersion={props.dockerSelectedVersion} onVersionChange={props.onDockerVersionChange} onInstall={props.onDockerInstall} onUpdate={props.onDockerUpdate} onRemove={props.onDockerRemove} onStart={props.onDockerStart} onStop={props.onDockerStop} />}

								{settings.deployTargetMode === 'service' && <ServicePanel idPrefix="deploy" status={props.serviceStatus} progress={props.serviceProgress} error={props.serviceError} busy={props.serviceBusy} action={props.serviceAction} versions={props.serviceVersions} selectedVersion={props.serviceSelectedVersion} onVersionChange={props.onServiceVersionChange} onInstall={props.onServiceInstall} onUpdate={props.onServiceUpdate} onRemove={props.onServiceRemove} onStart={props.onServiceStart} onStop={props.onServiceStop} sudoPromptVisible={props.sudoPromptVisible} sudoPasswordInput={props.sudoPasswordInput} onSudoPasswordChange={props.onSudoPasswordChange} onSudoSubmit={props.onSudoSubmit} />}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
};
