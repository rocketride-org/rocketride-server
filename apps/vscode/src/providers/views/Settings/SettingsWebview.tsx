// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import React, { useState, useRef, useMemo, useCallback, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';
import { ConnectionSettings } from './ConnectionSettings';
import { PipelineSettings } from './PipelineSettings';
import { DebuggingSettings } from './DebuggingSettings';
// EnvVariablesSettings removed — env is now managed in the Account page
import { IntegrationSettings } from './IntegrationSettings';
import { DeploySettings } from './DeploySettings';
import { MessageDisplay } from './MessageDisplay';
import { commonStyles } from 'shared/themes/styles';
import { TabPanel } from 'shared/components/tab-panel/TabPanel';
import type { ITabPanelTab, ITabPanelPanel } from 'shared/components/tab-panel/TabPanel';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type ConnectionMode = 'cloud' | 'docker' | 'service' | 'onprem' | 'local';

export interface ConnectionGroupSettings {
	connectionMode: ConnectionMode | null;
	hostUrl: string;
	hasApiKey: boolean;
	apiKey: string;
	teamId: string;
	local: {
		engineVersion: string;
		debugOutput: boolean;
		engineArgs: string;
	};
}

export interface SettingsData {
	development: ConnectionGroupSettings;
	deployment: ConnectionGroupSettings;
	defaultPipelinePath: string;
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';
	envVars?: Record<string, string>;
	autoAgentIntegration: boolean;
	integrationCopilot: boolean;
	integrationClaudeCode: boolean;
	integrationCursor: boolean;
	integrationWindsurf: boolean;
	integrationClaudeMd: boolean;
	integrationAgentsMd: boolean;
}

export interface EngineVersionItem {
	tag_name: string;
	prerelease: boolean;
}

export interface MessageData {
	level: 'success' | 'error' | 'info' | 'warning';
	message: string;
}

export type SettingsIncomingMessage =
	| {
			type: 'settingsLoaded';
			settings: SettingsData;
	  }
	| {
			type: 'showMessage';
			level: 'success' | 'error' | 'info' | 'warning';
			message: string;
			context?: 'development';
	  }
	| {
			type: 'engineVersionsLoaded';
			versions: EngineVersionItem[];
	  };

export type SettingsOutgoingMessage =
	| {
			type: 'view:ready';
	  }
	| {
			type: 'saveSettings';
			settings: SettingsData;
	  }
	| {
			type: 'testConnection';
			hostUrl: string;
			apiKey: string;
	  }
	| {
			type: 'clearCredentials';
	  }
	| {
			type: 'fetchEngineVersions';
	  }
	| {
			type: 'fetchTeams';
	  };

// ============================================================================
// SHARED STYLES
// ============================================================================

export const settingsStyles = {
	// Card structure (from commonStyles)
	card: commonStyles.card as CSSProperties,
	cardHeader: commonStyles.cardHeader as CSSProperties,
	cardBody: {
		...commonStyles.cardBody,
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,
	sectionDescription: {
		...commonStyles.textMuted,
		fontSize: 13,
		margin: 0,
	} as CSSProperties,
	formGrid: {
		display: 'grid',
		gap: 16,
		gridTemplateColumns: '1fr',
	} as CSSProperties,
	formGroup: {
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	label: {
		fontWeight: 600,
		marginBottom: 6,
		fontSize: 13,
	} as CSSProperties,
	helpText: {
		...commonStyles.textMuted,
		marginTop: 4,
		lineHeight: 1.4,
	} as CSSProperties,
	modeConfigBox: {
		...commonStyles.cardFlat,
		gridColumn: '1 / -1',
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,
	modeConfigDesc: {
		...commonStyles.textMuted,
		fontSize: 11.5,
		lineHeight: 1.5,
		margin: 0,
	} as CSSProperties,
	checkboxGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
	} as CSSProperties,
	checkboxLabel: {
		display: 'flex',
		alignItems: 'center',
		cursor: 'pointer',
		fontWeight: 'normal',
		margin: 0,
	} as CSSProperties,
	checkboxInput: {
		margin: '0 8px 0 0',
		flexShrink: 0,
		cursor: 'pointer',
	} as CSSProperties,
	checkboxSpan: {
		fontWeight: 600,
		fontSize: 13,
	} as CSSProperties,
	checkboxHelpText: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginLeft: 24,
		marginTop: 2,
		marginBottom: 8,
		lineHeight: 1.4,
	} as CSSProperties,
};

// ============================================================================
// SHARED CARD HEADER WITH SAVE BUTTON
// ============================================================================

export const SettingsCardHeader: React.FC<{
	title: string;
	onSave: () => void;
	onCancel?: () => void;
	dirty?: boolean;
	saved?: boolean;
}> = ({ title, onSave, onCancel, dirty, saved }) => (
	<div style={settingsStyles.cardHeader}>
		{title}
		<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
			{saved && <span style={{ fontSize: 11, color: 'var(--rr-color-success)' }}>Saved</span>}
			{dirty && (
				<>
					{onCancel && (
						<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onCancel}>
							Cancel
						</button>
					)}
					<button style={{ ...commonStyles.buttonPrimary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onSave}>
						Save All Settings
					</button>
				</>
			)}
		</div>
	</div>
);

// ============================================================================
// MAIN SETTINGS VIEW COMPONENT
// ============================================================================

/**
 * Settings - Configuration dashboard for VS Code extension webview
 *
 * Provides settings management interface with multiple configuration sections.
 * Communicates with VS Code extension via useMessaging for persistence and validation.
 *
 * Features:
 * - Connection settings with cloud/local mode support
 * - Pipeline configuration with default paths
 * - Local engine settings for self-hosted instances
 * - Debugging configuration options
 * - Real-time validation and feedback messaging
 */
export const Settings: React.FC = () => {
	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================

	const [settings, setSettings] = useState<SettingsData>({
		development: {
			connectionMode: 'local',
			hostUrl: 'http://localhost:5565',
			hasApiKey: false,
			apiKey: '',
			teamId: '',
			local: { engineVersion: 'latest', debugOutput: false, engineArgs: '' },
		},
		deployment: {
			connectionMode: null,
			hostUrl: '',
			hasApiKey: false,
			apiKey: '',
			teamId: '',
			local: { engineVersion: 'latest', debugOutput: false, engineArgs: '' },
		},
		defaultPipelinePath: 'pipelines',
		pipelineRestartBehavior: 'prompt',
		envVars: {},
		autoAgentIntegration: true,
		integrationCopilot: false,
		integrationClaudeCode: false,
		integrationCursor: false,
		integrationWindsurf: false,
		integrationClaudeMd: false,
		integrationAgentsMd: false,
	});
	const [message, setMessage] = useState<MessageData | null>(null);
	const [testMessage, setTestMessage] = useState<MessageData | null>(null);
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	// Server capabilities (from probe)
	const [serverCapabilities, setServerCapabilities] = useState<string[]>([]);
	const [isSaasProbed, setIsSaasProbed] = useState<boolean | undefined>(undefined);

	// Cloud auth state
	const [cloudSignedIn, setCloudSignedIn] = useState(false);
	const [cloudUserName, setCloudUserName] = useState('');
	const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);

	// Docker state
	const [dockerStatus, setDockerStatus] = useState<DockerStatus>({ state: 'not-installed', version: null, publishedAt: null, imageTag: null });
	const [dockerProgress, setDockerProgress] = useState<string | null>(null);
	const [dockerError, setDockerError] = useState<string | null>(null);
	const [dockerBusy, setDockerBusy] = useState(false);
	const [dockerAction, setDockerAction] = useState<'install' | 'update' | 'remove' | 'start' | 'stop' | null>(null);
	const [dockerTags, setDockerTags] = useState<string[]>([]);
	const [dockerSelectedVersion, setDockerSelectedVersion] = useState('latest');

	// Service state
	const [serviceStatus, setServiceStatus] = useState<ServiceStatus>({ state: 'not-installed', version: null, publishedAt: null, installPath: null });
	const [serviceProgress, setServiceProgress] = useState<string | null>(null);
	const [serviceError, setServiceError] = useState<string | null>(null);
	const [serviceBusy, setServiceBusy] = useState(false);
	const [serviceAction, setServiceAction] = useState<'install' | 'update' | 'remove' | 'start' | 'stop' | null>(null);
	const [serviceSelectedVersion, setServiceSelectedVersion] = useState('latest');
	const [sudoPromptVisible, setSudoPromptVisible] = useState(false);
	const [sudoPasswordInput, setSudoPasswordInput] = useState('');

	// Active settings tab
	const [activeTab, setActiveTab] = useState('development');

	// Dirty-state tracking — buttons only appear when user has edited something
	const [dirty, setDirty] = useState(false);
	const [saved, setSaved] = useState(false);
	const savedSettingsRef = useRef<SettingsData | null>(null);

	// ========================================================================
	// WEBVIEW MESSAGING
	// ========================================================================

	const { sendMessage, isReady: _isReady } = useMessaging<SettingsOutgoingMessage, SettingsIncomingMessage>({
		onMessage: (message) => {
			// Handle all incoming messages from your discriminated union
			switch (message.type) {
				case 'settingsLoaded':
					setSettings(message.settings);
					// Snapshot for cancel/reset and clear dirty state
					savedSettingsRef.current = JSON.parse(JSON.stringify(message.settings));
					setDirty(false);
					if (message.settings.development.connectionMode === 'local') {
						setEngineVersionsLoading(true);
						sendMessage({ type: 'fetchEngineVersions' });
					}
					// Request cloud auth status when settings load
					sendMessage({ type: 'cloud:getStatus' } as any);
					break;

				case 'engineVersionsLoaded':
					setEngineVersions(message.versions);
					setEngineVersionsLoading(false);
					break;

				case 'cloud:status' as any:
					setCloudSignedIn((message as any).signedIn);
					setCloudUserName((message as any).userName || '');
					break;

				case 'teamsLoaded' as any:
					setTeams((message as any).teams || []);
					break;

				case 'setFocus' as any:
					if ((message as any).focus) setActiveTab((message as any).focus);
					break;

				case 'serverInfo' as any: {
					const caps = (message as any).capabilities || [];
					setServerCapabilities(caps);
					setIsSaasProbed(caps.includes('saas'));
					break;
				}

				case 'showMessage': {
					const msg = { level: message.level, message: message.message };
					const clearAfter = message.level === 'success' ? 5000 : undefined;
					if (message.context === 'development') {
						setTestMessage(msg);
						if (clearAfter) setTimeout(() => setTestMessage(null), clearAfter);
					} else {
						setMessage(msg);
						if (clearAfter) setTimeout(() => setMessage(null), clearAfter);
						// Show "Saved" in card header on successful save
						if (message.level === 'success') {
							savedSettingsRef.current = JSON.parse(JSON.stringify(settings));
							setDirty(false);
							setSaved(true);
							setTimeout(() => setSaved(false), 5000);
						}
					}
					break;
				}

				// Docker messages
				case 'dockerStatus' as any:
					setDockerStatus((message as any).status);
					if (!dockerBusy) setDockerProgress(null);
					break;
				case 'dockerProgress' as any:
					setDockerProgress((message as any).message);
					setDockerError(null);
					break;
				case 'dockerComplete' as any:
					setDockerBusy(false);
					setDockerAction(null);
					setDockerProgress(null);
					break;
				case 'dockerError' as any:
					setDockerError((message as any).message);
					setDockerBusy(false);
					setDockerAction(null);
					setDockerProgress(null);
					break;
				case 'dockerVersionsLoaded' as any:
					setDockerTags((message as any).tags || []);
					break;

				// Service messages
				case 'serviceStatus' as any:
					setServiceStatus((message as any).status);
					if (!serviceBusy) setServiceProgress(null);
					break;
				case 'serviceProgress' as any:
					setServiceProgress((message as any).message);
					setServiceError(null);
					break;
				case 'serviceComplete' as any:
					setServiceBusy(false);
					setServiceAction(null);
					setServiceProgress(null);
					setSudoPromptVisible(false);
					setSudoPasswordInput('');
					break;
				case 'serviceError' as any:
					setServiceError((message as any).message);
					setServiceBusy(false);
					setServiceAction(null);
					setServiceProgress(null);
					setSudoPromptVisible(false);
					setSudoPasswordInput('');
					break;
				case 'serviceNeedsSudo' as any:
					setSudoPromptVisible(true);
					break;
			}
		},
	});

	// ========================================================================
	// EVENT HANDLERS
	// ========================================================================

	/**
	 * Save all settings to extension storage
	 */
	const handleSaveSettings = (): void => {
		sendMessage({ type: 'saveSettings', settings });
	};

	/** Revert to last-saved settings and clear dirty state. */
	const handleCancelSettings = useCallback((): void => {
		if (savedSettingsRef.current) {
			setSettings(JSON.parse(JSON.stringify(savedSettingsRef.current)));
		}
		setDirty(false);
		setSaved(false);
	}, []);

	/**
	 * Test development connection (run/debug server)
	 */
	const handleTestConnection = (hostUrl: string, apiKey: string): void => {
		sendMessage({ type: 'testConnection', hostUrl, apiKey });
	};

	/**
	 * Probe cloud server to check SaaS compatibility
	 */
	const handleProbeCloudServer = (cloudUrl: string): void => {
		setIsSaasProbed(undefined); // reset to loading
		sendMessage({ type: 'probeServerInfo', hostUrl: cloudUrl } as any);
	};

	const handleFetchTeams = (cloudUrl: string): void => {
		sendMessage({ type: 'fetchTeams', hostUrl: cloudUrl } as any);
	};

	/**
	 * Clear stored credentials
	 */
	const handleClearCredentials = (): void => {
		// Clear the API key from local state and send clear message
		setSettings((prev) => ({
			...prev,
			development: { ...prev.development, apiKey: '', hasApiKey: false },
		}));
		sendMessage({ type: 'clearCredentials' });
	};

	/**
	 * Update settings with partial changes
	 */
	const handleSettingsChange = (changes: Partial<SettingsData>): void => {
		setDirty(true);
		setSaved(false);
		setSettings((prev) => {
			const next = { ...prev };

			// Deep-merge development group
			if (changes.development) {
				next.development = { ...prev.development, ...changes.development };
				if (changes.development.local) {
					next.development.local = { ...prev.development.local, ...changes.development.local };
				}
			}

			// Deep-merge deployment group
			if (changes.deployment) {
				next.deployment = { ...prev.deployment, ...changes.deployment };
				if (changes.deployment.local) {
					next.deployment.local = { ...prev.deployment.local, ...changes.deployment.local };
				}
			}

			// Top-level fields
			const { development, deployment, ...topLevel } = changes;
			Object.assign(next, topLevel);

			// Side effects: fetch engine versions when switching to local mode
			const devMode = changes.development?.connectionMode;
			const depMode = changes.deployment?.connectionMode;
			if ((devMode === 'local' && prev.development.connectionMode !== 'local') || (depMode === 'local' && prev.deployment.connectionMode !== 'local')) {
				setEngineVersionsLoading(true);
				sendMessage({ type: 'fetchEngineVersions' });
			}

			// Teams are fetched by CloudPanel after it confirms the server is SaaS

			// Fetch versions when switching to docker or service
			const switchingToDockerOrService = (devMode === 'docker' || devMode === 'service') && prev.development.connectionMode !== devMode;
			const deploySwitchingToDockerOrService = (depMode === 'docker' || depMode === 'service') && prev.deployment.connectionMode !== depMode;
			if (switchingToDockerOrService || deploySwitchingToDockerOrService) {
				sendMessage({ type: 'fetchVersions' } as any);
			}

			return next;
		});
	};

	// ========================================================================
	// DOCKER / SERVICE VERSION OPTIONS
	// ========================================================================

	const dockerVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...dockerTags.map((t) => ({ value: t, label: t }))];

	const serviceVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...engineVersions.map((v) => ({ value: v.tag_name, label: v.tag_name.replace(/^server-/, '') }))];

	// ========================================================================
	// DOCKER / SERVICE ACTION HANDLERS
	// ========================================================================

	const makeDockerHandler = (actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => () => {
		setDockerBusy(true);
		setDockerAction(actionType);
		setDockerError(null);
		const msgType = `docker${actionType.charAt(0).toUpperCase()}${actionType.slice(1)}`;
		const payload: Record<string, unknown> = { type: msgType };
		if (actionType === 'install' || actionType === 'update') {
			payload.version = dockerSelectedVersion;
		}
		sendMessage(payload as any);
	};

	const makeServiceHandler = (actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => () => {
		setServiceBusy(true);
		setServiceAction(actionType);
		setServiceError(null);
		const msgType = `service${actionType.charAt(0).toUpperCase()}${actionType.slice(1)}`;
		const payload: Record<string, unknown> = { type: msgType };
		if (actionType === 'install' || actionType === 'update') {
			payload.version = serviceSelectedVersion;
		}
		sendMessage(payload as any);
	};

	const handleSudoSubmit = (): void => {
		const password = sudoPasswordInput;
		setSudoPasswordInput('');
		setSudoPromptVisible(false);
		sendMessage({ type: 'sudoPassword', password } as any);
	};

	// ========================================================================
	// RENDER
	// ========================================================================

	// ========================================================================
	// TAB DEFINITIONS
	// ========================================================================

	const tabs: ITabPanelTab[] = useMemo(
		() => [
			{ id: 'development', label: 'Development' },
			{ id: 'deployment', label: 'Deployment' },
			{ id: 'pipeline', label: 'Pipeline' },
			{ id: 'debugging', label: 'Debugging' },
			{ id: 'integrations', label: 'Integrations' },
		],
		[]
	);

	const panels: Record<string, ITabPanelPanel> = useMemo(
		() => ({
			development: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<ConnectionSettings
							settings={settings}
							onSettingsChange={handleSettingsChange}
							onSave={handleSaveSettings}
							onCancel={handleCancelSettings}
							dirty={dirty}
							saved={saved}
							onClearCredentials={handleClearCredentials}
							onTestDevelopmentConnection={handleTestConnection}
							serverCapabilities={serverCapabilities}
							testMessage={testMessage}
							engineVersions={engineVersions}
							engineVersionsLoading={engineVersionsLoading}
							cloudSignedIn={cloudSignedIn}
							cloudUserName={cloudUserName}
							onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' } as any)}
							onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' } as any)}
							onProbeCloudServer={handleProbeCloudServer}
							onFetchTeams={handleFetchTeams}
							isSaas={isSaasProbed}
							teams={teams}
							dockerStatus={dockerStatus}
							dockerProgress={dockerProgress}
							dockerError={dockerError}
							dockerBusy={dockerBusy}
							dockerAction={dockerAction}
							dockerVersions={dockerVersionOptions}
							dockerSelectedVersion={dockerSelectedVersion}
							onDockerVersionChange={setDockerSelectedVersion}
							onDockerInstall={makeDockerHandler('install')}
							onDockerUpdate={makeDockerHandler('update')}
							onDockerRemove={makeDockerHandler('remove')}
							onDockerStart={makeDockerHandler('start')}
							onDockerStop={makeDockerHandler('stop')}
							serviceStatus={serviceStatus}
							serviceProgress={serviceProgress}
							serviceError={serviceError}
							serviceBusy={serviceBusy}
							serviceAction={serviceAction}
							serviceVersions={serviceVersionOptions}
							serviceSelectedVersion={serviceSelectedVersion}
							onServiceVersionChange={setServiceSelectedVersion}
							onServiceInstall={makeServiceHandler('install')}
							onServiceUpdate={makeServiceHandler('update')}
							onServiceRemove={makeServiceHandler('remove')}
							onServiceStart={makeServiceHandler('start')}
							onServiceStop={makeServiceHandler('stop')}
							sudoPromptVisible={sudoPromptVisible}
							sudoPasswordInput={sudoPasswordInput}
							onSudoPasswordChange={setSudoPasswordInput}
							onSudoSubmit={handleSudoSubmit}
						/>
					</div>
				),
			},
			deployment: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<DeploySettings
							settings={settings}
							onSettingsChange={handleSettingsChange}
							onSave={handleSaveSettings}
							onCancel={handleCancelSettings}
							dirty={dirty}
							saved={saved}
							serverCapabilities={serverCapabilities}
							teams={teams}
							engineVersions={engineVersions}
							engineVersionsLoading={engineVersionsLoading}
							onClearCredentials={handleClearCredentials}
							onTestConnection={handleTestConnection}
							testMessage={testMessage}
							cloudSignedIn={cloudSignedIn}
							cloudUserName={cloudUserName}
							onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' } as any)}
							onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' } as any)}
							onProbeCloudServer={handleProbeCloudServer}
							onFetchTeams={handleFetchTeams}
							isSaas={isSaasProbed}
							dockerStatus={dockerStatus}
							dockerProgress={dockerProgress}
							dockerError={dockerError}
							dockerBusy={dockerBusy}
							dockerAction={dockerAction}
							dockerVersions={dockerVersionOptions}
							dockerSelectedVersion={dockerSelectedVersion}
							onDockerVersionChange={setDockerSelectedVersion}
							onDockerInstall={makeDockerHandler('install')}
							onDockerUpdate={makeDockerHandler('update')}
							onDockerRemove={makeDockerHandler('remove')}
							onDockerStart={makeDockerHandler('start')}
							onDockerStop={makeDockerHandler('stop')}
							serviceStatus={serviceStatus}
							serviceProgress={serviceProgress}
							serviceError={serviceError}
							serviceBusy={serviceBusy}
							serviceAction={serviceAction}
							serviceVersions={serviceVersionOptions}
							serviceSelectedVersion={serviceSelectedVersion}
							onServiceVersionChange={setServiceSelectedVersion}
							onServiceInstall={makeServiceHandler('install')}
							onServiceUpdate={makeServiceHandler('update')}
							onServiceRemove={makeServiceHandler('remove')}
							onServiceStart={makeServiceHandler('start')}
							onServiceStop={makeServiceHandler('stop')}
							sudoPromptVisible={sudoPromptVisible}
							sudoPasswordInput={sudoPasswordInput}
							onSudoPasswordChange={setSudoPasswordInput}
							onSudoSubmit={handleSudoSubmit}
						/>
					</div>
				),
			},
			pipeline: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<PipelineSettings settings={settings} onSettingsChange={handleSettingsChange} onSave={handleSaveSettings} onCancel={handleCancelSettings} dirty={dirty} saved={saved} />
					</div>
				),
			},
			debugging: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<DebuggingSettings settings={settings} onSettingsChange={handleSettingsChange} onSave={handleSaveSettings} onCancel={handleCancelSettings} dirty={dirty} saved={saved} />
					</div>
				),
			},
			integrations: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<IntegrationSettings settings={settings} onSettingsChange={handleSettingsChange} onSave={handleSaveSettings} onCancel={handleCancelSettings} dirty={dirty} saved={saved} />
					</div>
				),
			},
		}),
		[settings, message, testMessage, engineVersions, engineVersionsLoading, serverCapabilities, cloudSignedIn, cloudUserName, teams, dockerStatus, dockerProgress, dockerError, dockerBusy, dockerAction, dockerVersionOptions, dockerSelectedVersion, serviceStatus, serviceProgress, serviceError, serviceBusy, serviceAction, serviceVersionOptions, serviceSelectedVersion, sudoPromptVisible, sudoPasswordInput]
	);

	return (
		<div style={commonStyles.columnFill}>
			{/* ── Tab panel ─────────────────────────────────────────── */}
			<TabPanel tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} panels={panels} />
		</div>
	);
};
