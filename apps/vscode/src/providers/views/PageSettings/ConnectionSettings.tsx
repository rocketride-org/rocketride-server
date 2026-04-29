// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionSettings — "Development Mode" section of the VS Code Settings page.
 *
 * Wraps the shared ConnectionConfig component in a card with a header and
 * save button. Passes through all connection-related props.
 */

import React from 'react';
import { MessageData, SettingsData, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { ConnectionConfig } from '../components/ConnectionConfig';
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
	const { settings, onSettingsChange, onSave } = props;

	const handleConnectionModeChange = (mode: SettingsData['connectionMode']) => {
		const updates: Partial<SettingsData> = { connectionMode: mode };

		if (mode === 'onprem') {
			if (!settings.hostUrl || settings.hostUrl.includes('cloud.rocketride') || settings.hostUrl.startsWith('http://localhost')) {
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
					<ConnectionConfig
						simplified={false}
						idPrefix="dev"
						connectionMode={settings.connectionMode}
						onConnectionModeChange={handleConnectionModeChange}
						settings={settings}
						onSettingsChange={onSettingsChange}
						cloudSignedIn={props.cloudSignedIn ?? false}
						cloudUserName={props.cloudUserName ?? ''}
						onCloudSignIn={props.onCloudSignIn!}
						onCloudSignOut={props.onCloudSignOut!}
						teams={props.teams ?? []}
						onClearCredentials={props.onClearCredentials}
						onTestConnection={props.onTestDevelopmentConnection}
						testMessage={props.developmentTestMessage}
						engineVersions={props.engineVersions}
						engineVersionsLoading={props.engineVersionsLoading}
						dockerStatus={props.dockerStatus}
						dockerProgress={props.dockerProgress}
						dockerError={props.dockerError}
						dockerBusy={props.dockerBusy}
						dockerAction={props.dockerAction}
						dockerVersions={props.dockerVersions}
						dockerSelectedVersion={props.dockerSelectedVersion}
						onDockerVersionChange={props.onDockerVersionChange}
						onDockerInstall={props.onDockerInstall}
						onDockerUpdate={props.onDockerUpdate}
						onDockerRemove={props.onDockerRemove}
						onDockerStart={props.onDockerStart}
						onDockerStop={props.onDockerStop}
						serviceStatus={props.serviceStatus}
						serviceProgress={props.serviceProgress}
						serviceError={props.serviceError}
						serviceBusy={props.serviceBusy}
						serviceAction={props.serviceAction}
						serviceVersions={props.serviceVersions}
						serviceSelectedVersion={props.serviceSelectedVersion}
						onServiceVersionChange={props.onServiceVersionChange}
						onServiceInstall={props.onServiceInstall}
						onServiceUpdate={props.onServiceUpdate}
						onServiceRemove={props.onServiceRemove}
						onServiceStart={props.onServiceStart}
						onServiceStop={props.onServiceStop}
						sudoPromptVisible={props.sudoPromptVisible}
						sudoPasswordInput={props.sudoPasswordInput}
						onSudoPasswordChange={props.onSudoPasswordChange}
						onSudoSubmit={props.onSudoSubmit}
					/>
				</div>
			</div>
		</div>
	);
};
