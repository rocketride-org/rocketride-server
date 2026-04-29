// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionSettings — "Development Mode" section of the VS Code Settings page.
 *
 * Renders a mode dropdown (Local/Cloud/On-prem/Docker/Service) and delegates
 * to the appropriate target panel in views/components/panels/.
 */

import React from 'react';
import { MessageData, SettingsData, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { LocalPanel, CloudPanel, OnPremPanel, DockerPanel, ServicePanel } from '../components/panels';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';

// ============================================================================
// TYPES
// ============================================================================

interface ConnectionSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	onSave: () => void;
	onClearCredentials: () => void;
	onTestDevelopmentConnection: () => void;
	developmentTestMessage: MessageData | null;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
	cloudSignedIn?: boolean;
	cloudUserName?: string;
	onCloudSignIn?: () => void;
	onCloudSignOut?: () => void;
	teams?: Array<{ id: string; name: string }>;
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

// ============================================================================
// COMPONENT
// ============================================================================

export const ConnectionSettings: React.FC<ConnectionSettingsProps> = (props) => {
	const { settings, onSettingsChange, onSave, onClearCredentials, onTestDevelopmentConnection, developmentTestMessage, engineVersions, engineVersionsLoading, cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut, teams } = props;

	const handleConnectionModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as SettingsData['connectionMode'];
		const updates: Partial<SettingsData> = { connectionMode: mode };

		if (mode === 'onprem') {
			if (!settings.hostUrl || settings.hostUrl === 'https://cloud.rocketride.ai' || settings.hostUrl.startsWith('http://localhost')) {
				updates.hostUrl = '';
			}
		}

		onSettingsChange(updates);
	};

	const showAccountWarning = settings.connectionMode === 'onprem' && !settings.apiKey.trim();

	return (
		<div
			style={{
				...S.card,
				...(showAccountWarning
					? {
							borderColor: 'var(--vscode-editorWarning-foreground)',
							backgroundColor: 'var(--vscode-editorWarning-background)',
						}
					: {}),
			}}
			id="developmentSection"
		>
			<SettingsCardHeader title="Development Mode" onSave={onSave} />
			<div style={S.cardBody}>
				<div style={S.sectionDescription}>Where pipelines run during development. Cloud and On-prem modes require authentication.</div>
				<div style={S.formGrid}>
					<div style={S.formGroup}>
						<label htmlFor="dev-connectionMode" style={S.label}>
							Connection mode
						</label>
						<select id="dev-connectionMode" value={settings.connectionMode} onChange={handleConnectionModeChange}>
							<option value="cloud">RocketRide Cloud</option>
							<option value="docker">Docker</option>
							<option value="service">Service</option>
							<option value="onprem">On-prem (your own hosted server)</option>
							<option value="local">Local</option>
						</select>
						<div style={S.helpText}>Choose where your server runs for development</div>
					</div>

					{/* Mode-specific panel */}
					<div style={S.modeConfigBox}>
						{settings.connectionMode === 'cloud' && <CloudPanel idPrefix="dev" cloudSignedIn={cloudSignedIn ?? false} cloudUserName={cloudUserName ?? ''} onCloudSignIn={onCloudSignIn!} onCloudSignOut={onCloudSignOut!} teams={teams ?? []} selectedTeamId={settings.developmentTeamId} onTeamChange={(id) => onSettingsChange({ developmentTeamId: id })} />}

						{settings.connectionMode === 'onprem' && <OnPremPanel idPrefix="dev" hostUrl={settings.hostUrl} onHostUrlChange={(url) => onSettingsChange({ hostUrl: url })} apiKey={settings.apiKey} onApiKeyChange={(key) => onSettingsChange({ apiKey: key, hasApiKey: key.trim().length > 0 })} onClearApiKey={onClearCredentials} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} onTestConnection={onTestDevelopmentConnection} testMessage={developmentTestMessage} />}

						{settings.connectionMode === 'local' && <LocalPanel idPrefix="dev" engineVersion={settings.localEngineVersion} onVersionChange={(v) => onSettingsChange({ localEngineVersion: v })} engineVersions={engineVersions} engineVersionsLoading={engineVersionsLoading} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} engineArgs={settings.localEngineArgs} onEngineArgsChange={(a) => onSettingsChange({ localEngineArgs: a })} />}

						{settings.connectionMode === 'docker' && <DockerPanel idPrefix="dev" status={props.dockerStatus} progress={props.dockerProgress} error={props.dockerError} busy={props.dockerBusy} action={props.dockerAction} versions={props.dockerVersions} selectedVersion={props.dockerSelectedVersion} onVersionChange={props.onDockerVersionChange} onInstall={props.onDockerInstall} onUpdate={props.onDockerUpdate} onRemove={props.onDockerRemove} onStart={props.onDockerStart} onStop={props.onDockerStop} />}

						{settings.connectionMode === 'service' && <ServicePanel idPrefix="dev" status={props.serviceStatus} progress={props.serviceProgress} error={props.serviceError} busy={props.serviceBusy} action={props.serviceAction} versions={props.serviceVersions} selectedVersion={props.serviceSelectedVersion} onVersionChange={props.onServiceVersionChange} onInstall={props.onServiceInstall} onUpdate={props.onServiceUpdate} onRemove={props.onServiceRemove} onStart={props.onServiceStart} onStop={props.onServiceStop} sudoPromptVisible={props.sudoPromptVisible} sudoPasswordInput={props.sudoPasswordInput} onSudoPasswordChange={props.onSudoPasswordChange} onSudoSubmit={props.onSudoSubmit} />}
					</div>
				</div>
			</div>
		</div>
	);
};
