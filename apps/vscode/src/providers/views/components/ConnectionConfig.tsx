// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionConfig — shared connection mode selector + panel.
 *
 * Renders the connection mode dropdown and the appropriate panel for the
 * selected mode. Used by both the Welcome page and the Settings page.
 *
 * The `simplified` prop is passed through to each panel so they can hide
 * advanced fields when used in a welcome/onboarding context.
 */

import React from 'react';
import { LocalPanel } from './panels/LocalPanel';
import { CloudPanel } from './panels/CloudPanel';
import { OnPremPanel } from './panels/OnPremPanel';
import { DockerPanel } from './panels/DockerPanel';
import { ServicePanel } from './panels/ServicePanel';
import { settingsStyles as S } from '../Settings/SettingsWebview';
import type { SettingsData, ConnectionMode, EngineVersionItem, MessageData } from '../Settings/SettingsWebview';
import type { ServiceStatus, DockerStatus, VersionOption } from './panels/shared';

// =============================================================================
// TYPES
// =============================================================================

export interface ConnectionConfigProps {
	simplified: boolean;
	idPrefix: string;

	/** Which connection group this config manages */
	group: 'development' | 'deployment';

	/** When true, only auth-relevant fields are shown (sign-in, API key). Used by Auth page for re-authentication. */
	authOnly?: boolean;

	// Server capabilities (from probe) — controls which modes are shown
	serverCapabilities: string[];

	// Mode change handler
	onConnectionModeChange: (mode: ConnectionMode) => void;

	// Settings + change handler
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;

	// Cloud
	cloudSignedIn: boolean;
	cloudUserName: string;
	onCloudSignIn: () => void;
	onCloudSignOut: () => void;
	onProbeCloudServer?: () => void;
	onFetchTeams?: () => void;
	isSaas?: boolean;
	teams: Array<{ id: string; name: string }>;

	// On-prem
	onClearCredentials: () => void;
	onTestConnection: (hostUrl: string, apiKey: string) => void;
	testMessage: MessageData | null;

	// Local engine
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;

	// Docker
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

	// Service
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

export const ConnectionConfig: React.FC<ConnectionConfigProps> = (props) => {
	const { simplified, idPrefix, group, authOnly, serverCapabilities, onConnectionModeChange, settings, onSettingsChange, cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut, teams, onClearCredentials, onTestConnection, testMessage, engineVersions, engineVersionsLoading } = props;

	const groupSettings = settings[group];
	const connectionMode = groupSettings.connectionMode;

	/** Wrap a partial group update in the correct nested key */
	const changeGroup = (partial: Record<string, unknown>): void => {
		onSettingsChange({ [group]: partial } as Partial<SettingsData>);
	};

	const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onConnectionModeChange(e.target.value as ConnectionMode);
	};

	// authOnly: only show auth-relevant fields for re-authentication
	if (authOnly) {
		return (
			<div style={S.modeConfigBox}>
				{connectionMode === 'cloud' && <CloudPanel idPrefix={idPrefix} cloudSignedIn={cloudSignedIn} cloudUserName={cloudUserName} onCloudSignIn={onCloudSignIn} onCloudSignOut={onCloudSignOut} teams={[]} selectedTeamId="" onTeamChange={() => {}} simplified={true} />}

				{(connectionMode === 'onprem' || connectionMode === 'docker' || connectionMode === 'service') && <OnPremPanel idPrefix={idPrefix} hostUrl={groupSettings.hostUrl} onHostUrlChange={(url) => changeGroup({ hostUrl: url })} apiKey={groupSettings.apiKey} onApiKeyChange={(key) => changeGroup({ apiKey: key, hasApiKey: key.trim().length > 0 })} onClearApiKey={onClearCredentials} debugOutput={false} onDebugOutputChange={() => {}} simplified={true} />}
			</div>
		);
	}

	return (
		<>
			{/* Connection mode dropdown */}
			<div style={S.formGroup}>
				<label htmlFor={`${idPrefix}-connectionMode`} style={S.label}>
					Connection mode
				</label>
				<select id={`${idPrefix}-connectionMode`} value={connectionMode ?? ''} onChange={handleModeChange}>
					<option value="cloud">RocketRide Cloud</option>
					<option value="docker">Docker</option>
					<option value="service">Service</option>
					<option value="onprem">Direct Connect</option>
					<option value="local">Local</option>
				</select>
				<div style={S.helpText}>Choose where your server runs for development and deployment</div>
			</div>

			{/* Mode-specific panel */}
			<div style={{ ...S.modeConfigBox, marginTop: 8 }}>
				{connectionMode === 'cloud' && <CloudPanel idPrefix={idPrefix} cloudSignedIn={cloudSignedIn} cloudUserName={cloudUserName} onCloudSignIn={onCloudSignIn} onCloudSignOut={onCloudSignOut} teams={teams} selectedTeamId={groupSettings.teamId} onTeamChange={(id) => changeGroup({ teamId: id })} simplified={simplified} isSaas={props.isSaas} onProbeServer={props.onProbeCloudServer} onFetchTeams={props.onFetchTeams} />}

				{connectionMode === 'onprem' && <OnPremPanel idPrefix={idPrefix} hostUrl={groupSettings.hostUrl} onHostUrlChange={(url) => changeGroup({ hostUrl: url })} apiKey={groupSettings.apiKey} onApiKeyChange={(key) => changeGroup({ apiKey: key, hasApiKey: key.trim().length > 0 })} onClearApiKey={onClearCredentials} debugOutput={groupSettings.local.debugOutput} onDebugOutputChange={(c) => changeGroup({ local: { debugOutput: c } })} onTestConnection={onTestConnection} testMessage={testMessage} simplified={simplified} />}

				{connectionMode === 'local' && <LocalPanel idPrefix={idPrefix} engineVersion={groupSettings.local.engineVersion} onVersionChange={(v) => changeGroup({ local: { engineVersion: v } })} engineVersions={engineVersions} engineVersionsLoading={engineVersionsLoading} debugOutput={groupSettings.local.debugOutput} onDebugOutputChange={(c) => changeGroup({ local: { debugOutput: c } })} engineArgs={groupSettings.local.engineArgs} onEngineArgsChange={(a) => changeGroup({ local: { engineArgs: a } })} simplified={simplified} />}

				{connectionMode === 'docker' && <DockerPanel idPrefix={idPrefix} status={props.dockerStatus} progress={props.dockerProgress} error={props.dockerError} busy={props.dockerBusy} action={props.dockerAction} versions={props.dockerVersions} selectedVersion={props.dockerSelectedVersion} onVersionChange={props.onDockerVersionChange} onInstall={props.onDockerInstall} onUpdate={props.onDockerUpdate} onRemove={props.onDockerRemove} onStart={props.onDockerStart} onStop={props.onDockerStop} simplified={simplified} />}

				{connectionMode === 'service' && <ServicePanel idPrefix={idPrefix} status={props.serviceStatus} progress={props.serviceProgress} error={props.serviceError} busy={props.serviceBusy} action={props.serviceAction} versions={props.serviceVersions} selectedVersion={props.serviceSelectedVersion} onVersionChange={props.onServiceVersionChange} onInstall={props.onServiceInstall} onUpdate={props.onServiceUpdate} onRemove={props.onServiceRemove} onStart={props.onServiceStart} onStop={props.onServiceStop} sudoPromptVisible={props.sudoPromptVisible} sudoPasswordInput={props.sudoPasswordInput} onSudoPasswordChange={props.onSudoPasswordChange} onSudoSubmit={props.onSudoSubmit} simplified={simplified} />}
			</div>
		</>
	);
};
