// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeploySettings — "Deployment Target" section of the VS Code Settings page.
 *
 * Wraps the shared ConnectionConfig component in a card with a header,
 * save button, and a toggle checkbox to enable/disable a separate deploy target.
 *
 * When the checkbox is unchecked (deployment.connectionMode === null),
 * deployment uses the same target as development (shared mode).
 */

import React from 'react';
import { SettingsData, ConnectionMode, MessageData, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { ConnectionConfig } from '../components/ConnectionConfig';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for the Deployment Target settings card.
 *
 * When `settings.deployment.connectionMode` is null the deploy target is
 * "shared" with the development group and the ConnectionConfig is hidden.
 */
interface DeploySettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	onSave: () => void;
	onCancel?: () => void;
	dirty?: boolean;
	saved?: boolean;
	onClearCredentials: () => void;
	onTestConnection: (mode: string, params?: Record<string, unknown>) => void;
	testMessage: MessageData | null;
	/** Available teams for cloud mode (fetched after OAuth sign-in). */
	teams: Array<{ id: string; name: string }>;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
	serverCapabilities: string[];
	cloudSignedIn?: boolean;
	cloudUserName?: string;
	onCloudSignIn?: () => void;
	onCloudSignOut?: () => void;
	onProbeCloudServer?: () => void;
	onFetchTeams?: () => void;
	isSaas?: boolean;
	/** Whether the user has an active subscription. */
	isSubscribed?: boolean;
	/** Checkout callbacks for CloudPanel. */
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
	sudoPromptVisible: boolean;
	sudoPasswordInput: string;
	onSudoPasswordChange: (pw: string) => void;
	onSudoSubmit: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const DeploySettings: React.FC<DeploySettingsProps> = (props) => {
	const { settings, onSettingsChange, onSave, cloudSignedIn } = props;
	const hasDeployTarget = settings.deployment.connectionMode !== null;

	/**
	 * Toggle a separate deploy target on/off.
	 * When enabled, defaults to cloud (if signed in + SaaS) or local.
	 * When disabled, resets to shared mode (connectionMode = null).
	 */
	const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.checked) {
			const isSaas = (props.serverCapabilities ?? []).includes('saas');
			const devMode = settings.development.connectionMode;
			const canUseCloud = cloudSignedIn && isSaas && devMode !== 'cloud';
			const defaultMode: ConnectionMode = canUseCloud ? 'cloud' : 'local';
			onSettingsChange({ deployment: { connectionMode: defaultMode } } as Partial<SettingsData>);
		} else {
			onSettingsChange({ deployment: { connectionMode: null, teamId: '' } } as Partial<SettingsData>);
		}
	};

	const handleModeChange = (mode: ConnectionMode) => {
		onSettingsChange({ deployment: { connectionMode: mode } } as Partial<SettingsData>);
	};

	return (
		<div style={S.card}>
			<SettingsCardHeader title="Deployment Target" onSave={props.onSave} onCancel={props.onCancel} dirty={props.dirty} saved={props.saved} />
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

					{/* ConnectionConfig — same component as Development, just group="deployment" */}
					{hasDeployTarget && (
						<ConnectionConfig
							simplified={false}
							idPrefix="deploy"
							group="deployment"
							otherGroupMode={settings.development.connectionMode}
							serverCapabilities={props.serverCapabilities}
							onConnectionModeChange={handleModeChange}
							settings={settings}
							onSettingsChange={onSettingsChange}
							cloudSignedIn={props.cloudSignedIn ?? false}
							cloudUserName={props.cloudUserName ?? ''}
							onCloudSignIn={props.onCloudSignIn ?? (() => {})}
							onCloudSignOut={props.onCloudSignOut ?? (() => {})}
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
					)}
				</div>
			</div>
		</div>
	);
};
