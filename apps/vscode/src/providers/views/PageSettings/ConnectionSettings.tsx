// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionSettings — "Development Mode" section of the VS Code Settings page.
 *
 * Renders a mode dropdown (Local/Cloud/On-prem/Docker/Service) and delegates
 * mode-specific fields to shared components in views/components/.
 *
 * Cloud sign-in state is shared with DeployTargetSettings — signing in here
 * updates both sections.
 */

import React from 'react';
import { MessageData, SettingsData, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { LocalModeFields, CloudModeFields, OnPremModeFields, SimpleModeFields } from '../components';

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
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ConnectionSettings: React.FC<ConnectionSettingsProps> = ({ settings, onSettingsChange, onSave, onClearCredentials, onTestDevelopmentConnection, developmentTestMessage, engineVersions, engineVersionsLoading, cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut, teams }) => {
	// ========================================================================
	// EVENT HANDLERS
	// ========================================================================

	const handleConnectionModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as SettingsData['connectionMode'];
		const updates: Partial<SettingsData> = { connectionMode: mode };

		if (mode === 'onprem') {
			if (!settings.hostUrl || settings.hostUrl === 'https://cloud.rocketride.ai' || settings.hostUrl.startsWith('http://localhost')) {
				updates.hostUrl = '';
			}
		} else if (mode === 'local') {
			updates.autoConnect = true;
		}

		onSettingsChange(updates);
	};

	const showAccountWarning = settings.connectionMode === 'onprem' && !settings.apiKey.trim();

	// ========================================================================
	// RENDER
	// ========================================================================

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

					{/* Mode-specific fields */}
					<div style={S.modeConfigBox}>
						{settings.connectionMode === 'cloud' && <CloudModeFields idPrefix="dev" cloudSignedIn={cloudSignedIn ?? false} cloudUserName={cloudUserName ?? ''} onCloudSignIn={onCloudSignIn!} onCloudSignOut={onCloudSignOut!} teams={teams ?? []} selectedTeamId={settings.developmentTeamId} onTeamChange={(id) => onSettingsChange({ developmentTeamId: id })} autoConnect={settings.autoConnect} onAutoConnectChange={(c) => onSettingsChange({ autoConnect: c })} />}

						{settings.connectionMode === 'onprem' && <OnPremModeFields idPrefix="dev" hostUrl={settings.hostUrl} onHostUrlChange={(url) => onSettingsChange({ hostUrl: url })} apiKey={settings.apiKey} onApiKeyChange={(key) => onSettingsChange({ apiKey: key, hasApiKey: key.trim().length > 0 })} onClearApiKey={onClearCredentials} autoConnect={settings.autoConnect} onAutoConnectChange={(c) => onSettingsChange({ autoConnect: c })} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} onTestConnection={onTestDevelopmentConnection} testMessage={developmentTestMessage} />}

						{settings.connectionMode === 'local' && <LocalModeFields idPrefix="dev" engineVersion={settings.localEngineVersion} onVersionChange={(v) => onSettingsChange({ localEngineVersion: v })} engineVersions={engineVersions} engineVersionsLoading={engineVersionsLoading} debugOutput={settings.localDebugOutput} onDebugOutputChange={(c) => onSettingsChange({ localDebugOutput: c })} engineArgs={settings.localEngineArgs} onEngineArgsChange={(a) => onSettingsChange({ localEngineArgs: a })} />}

						{settings.connectionMode === 'docker' && <SimpleModeFields idPrefix="dev" description="Connects to your local Docker instance." autoConnect={settings.autoConnect} onAutoConnectChange={(c) => onSettingsChange({ autoConnect: c })} />}

						{settings.connectionMode === 'service' && <SimpleModeFields idPrefix="dev" description="Connects to your local RocketRide service." autoConnect={settings.autoConnect} onAutoConnectChange={(c) => onSettingsChange({ autoConnect: c })} />}
					</div>
				</div>
			</div>
		</div>
	);
};
