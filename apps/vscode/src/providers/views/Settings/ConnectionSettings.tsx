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
import { MessageData, SettingsData, ConnectionMode, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { ConnectionConfig } from '../components/ConnectionConfig';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';

// ============================================================================
// TYPES
// ============================================================================

/** Props for the Development Mode connection settings card. */
interface ConnectionSettingsProps {
	/** Full settings object — group fields are read from `settings.development`. */
	settings: SettingsData;
	/** Partial-merge callback for settings changes. */
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	/** Persist all settings to extension storage. */
	onSave: () => void;
	/** Revert to last-saved settings. */
	onCancel?: () => void;
	/** True when the user has unsaved edits. */
	dirty?: boolean;
	/** True briefly after a successful save (shows "Saved" badge). */
	saved?: boolean;
	/** Remove stored API key from secret storage. */
	onClearCredentials: () => void;
	/** Test connection via ioControl — mode + optional params (hostUrl, apiKey for onprem). */
	onTestConnection: (mode: string, params?: Record<string, unknown>) => void;
	/** Inline test result banner (success/error), shown below the active panel. */
	testMessage: MessageData | null;
	/** Available engine versions fetched from GitHub releases. */
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
	/** Server capabilities from probe (e.g. ['saas']) — controls which modes are available. */
	serverCapabilities: string[];
	cloudSignedIn?: boolean;
	cloudUserName?: string;
	onCloudSignIn?: () => void;
	onCloudSignOut?: () => void;
	onProbeCloudServer?: () => void;
	onFetchTeams?: () => void;
	/** Whether the probed server supports SaaS/OAuth. */
	isSaas?: boolean;
	teams?: Array<{ id: string; name: string }>;
	/** Whether the user has an active subscription. */
	isSubscribed?: boolean;
	/** Checkout callbacks for CloudPanel's embedded CheckoutModal. */
	onFetchPlans?: () => Promise<any[]>;
	onCreateCheckout?: (priceId: string) => Promise<{ clientSecret: string; subscriptionId: string }>;
	onConfirmPending?: (subscriptionId: string, priceId: string) => Promise<void>;
	onCheckoutSuccess?: () => void;
	// -- Docker panel props --
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
	// -- Service panel props --
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
	/** Whether the sudo password prompt overlay is visible (Linux/macOS service installs). */
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

	/** When switching to onprem, clear the hostUrl if it still holds a cloud or localhost value. */
	const handleConnectionModeChange = (mode: ConnectionMode) => {
		const groupUpdates: Partial<SettingsData['development']> = { connectionMode: mode };

		if (mode === 'onprem') {
			const hostUrl = settings.development.hostUrl;
			if (!hostUrl || hostUrl.includes('cloud.rocketride') || hostUrl.startsWith('http://localhost')) {
				groupUpdates.hostUrl = '';
			}
		}

		onSettingsChange({ development: groupUpdates } as Partial<SettingsData>);
	};

	const showAccountWarning = settings.development.connectionMode === 'onprem' && !settings.development.apiKey.trim();

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
			<SettingsCardHeader title="Development Mode" onSave={onSave} onCancel={props.onCancel} dirty={props.dirty} saved={props.saved} />
			<div style={S.cardBody}>
				<div style={S.sectionDescription}>Where pipelines run during development. Cloud and Direct Connect modes require authentication.</div>
				<div style={S.formGrid}>
					<ConnectionConfig
						simplified={false}
						idPrefix="dev"
						group="development"
						otherGroupMode={settings.deployment.connectionMode}
						serverCapabilities={props.serverCapabilities}
						onConnectionModeChange={handleConnectionModeChange}
						settings={settings}
						onSettingsChange={onSettingsChange}
						cloudSignedIn={props.cloudSignedIn ?? false}
						cloudUserName={props.cloudUserName ?? ''}
						onCloudSignIn={props.onCloudSignIn!}
						onCloudSignOut={props.onCloudSignOut!}
						onProbeCloudServer={props.onProbeCloudServer}
						onFetchTeams={props.onFetchTeams}
						isSaas={props.isSaas}
						teams={props.teams ?? []}
						onClearCredentials={props.onClearCredentials}
						onTestConnection={props.onTestConnection}
						testMessage={props.testMessage}
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
						isSubscribed={props.isSubscribed}
						onFetchPlans={props.onFetchPlans}
						onCreateCheckout={props.onCreateCheckout}
						onConfirmPending={props.onConfirmPending}
						onCheckoutSuccess={props.onCheckoutSuccess}
					/>
				</div>
			</div>
		</div>
	);
};
