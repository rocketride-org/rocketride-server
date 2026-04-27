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

import React, { useState, useMemo, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';
import { ConnectionSettings } from './ConnectionSettings';
import { PipelineSettings } from './PipelineSettings';
import { DebuggingSettings } from './DebuggingSettings';
import { EnvVariablesSettings } from './EnvVariablesSettings';
import { IntegrationSettings } from './IntegrationSettings';
import { DeployTargetSettings } from './DeployTargetSettings';
import { MessageDisplay } from './MessageDisplay';
import { commonStyles } from 'shared/themes/styles';
import { TabPanel } from 'shared/components/tab-panel/TabPanel';
import type { ITabPanelTab, ITabPanelPanel } from 'shared/components/tab-panel/TabPanel';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface SettingsData {
	hostUrl: string;
	connectionMode: 'cloud' | 'docker' | 'service' | 'onprem' | 'local';
	hasApiKey: boolean;
	apiKey: string;
	autoConnect: boolean;
	defaultPipelinePath: string;
	localEngineVersion: string;
	localEngineArgs: string;
	localDebugOutput: boolean;
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';
	developmentTeamId: string;
	deployTargetMode: 'cloud' | 'docker' | 'service' | 'onprem' | 'local' | null;
	deployTargetTeamId: string;
	/** Separate host URL for deploy target (on-prem deploy) */
	deployHostUrl: string;
	/** Separate API key for deploy target (on-prem deploy) */
	deployApiKey: string;
	/** Auto-connect to deploy target on startup */
	deployAutoConnect: boolean;
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

export type PageSettingsIncomingMessage =
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

export type PageSettingsOutgoingMessage =
	| {
			type: 'view:ready';
	  }
	| {
			type: 'saveSettings';
			settings: SettingsData;
	  }
	| {
			type: 'testConnection';
			settings: SettingsData;
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
// MAIN SETTINGS VIEW COMPONENT
// ============================================================================

/**
 * PageSettings - Configuration dashboard for VS Code extension webview
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
export const PageSettings: React.FC = () => {
	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================

	const [settings, setSettings] = useState<SettingsData>({
		hostUrl: 'http://localhost:5565',
		connectionMode: 'local',
		hasApiKey: false,
		apiKey: '', // Initialize empty - will be loaded from secure storage
		autoConnect: true,
		defaultPipelinePath: 'pipelines', // Initialize with default value
		localEngineVersion: 'latest',
		localEngineArgs: '',
		pipelineRestartBehavior: 'prompt',
		developmentTeamId: '',
		deployTargetMode: null,
		deployTargetTeamId: '',
		deployHostUrl: '',
		deployApiKey: '',
		deployAutoConnect: false,
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
	const [developmentTestMessage, setDevelopmentTestMessage] = useState<MessageData | null>(null);
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	// Cloud auth state
	const [cloudSignedIn, setCloudSignedIn] = useState(false);
	const [cloudUserName, setCloudUserName] = useState('');
	const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);

	// Active settings tab
	const [activeTab, setActiveTab] = useState('development');

	// ========================================================================
	// WEBVIEW MESSAGING
	// ========================================================================

	const { sendMessage, isReady: _isReady } = useMessaging<PageSettingsOutgoingMessage, PageSettingsIncomingMessage>({
		onMessage: (message) => {
			// Handle all incoming messages from your discriminated union
			switch (message.type) {
				case 'settingsLoaded':
					setSettings(message.settings);
					if (message.settings.connectionMode === 'local') {
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

				case 'showMessage': {
					const msg = { level: message.level, message: message.message };
					const clearAfter = message.level === 'success' ? 5000 : undefined;
					if (message.context === 'development') {
						setDevelopmentTestMessage(msg);
						if (clearAfter) setTimeout(() => setDevelopmentTestMessage(null), clearAfter);
					} else {
						setMessage(msg);
						if (clearAfter) setTimeout(() => setMessage(null), clearAfter);
					}
					break;
				}
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

	/**
	 * Test development connection (run/debug server)
	 */
	const handleTestDevelopmentConnection = (): void => {
		sendMessage({ type: 'testConnection', settings });
	};

	/**
	 * Clear stored credentials
	 */
	const handleClearCredentials = (): void => {
		// Clear the API key from local state and send clear message
		setSettings((prev) => ({ ...prev, apiKey: '', hasApiKey: false }));
		sendMessage({ type: 'clearCredentials' });
	};

	/**
	 * Update settings with partial changes
	 */
	const handleSettingsChange = (newSettings: Partial<SettingsData>): void => {
		setSettings((prev) => {
			// If switching to local mode, fetch engine versions
			if (newSettings.connectionMode === 'local' && prev.connectionMode !== 'local') {
				setEngineVersionsLoading(true);
				sendMessage({ type: 'fetchEngineVersions' });
			}
			// If either mode switches to cloud, fetch teams
			if ((newSettings.connectionMode === 'cloud' && prev.connectionMode !== 'cloud') || (newSettings.deployTargetMode === 'cloud' && prev.deployTargetMode !== 'cloud')) {
				sendMessage({ type: 'fetchTeams' });
			}
			return { ...prev, ...newSettings };
		});
	};

	/**
	 * Add or update an environment variable (local state only, not saved until "Save All Settings")
	 */
	const handleEnvVarAdd = (key: string, value: string): void => {
		setSettings((prev) => ({
			...prev,
			envVars: {
				...prev.envVars,
				[key]: value,
			},
		}));
	};

	/**
	 * Update an existing environment variable (local state only, not saved until "Save All Settings")
	 */
	const handleEnvVarUpdate = (key: string, value: string): void => {
		setSettings((prev) => ({
			...prev,
			envVars: {
				...prev.envVars,
				[key]: value,
			},
		}));
	};

	/**
	 * Delete an environment variable (local state only, not saved until "Save All Settings")
	 */
	const handleEnvVarDelete = (key: string): void => {
		setSettings((prev) => {
			const newEnvVars = { ...prev.envVars };
			delete newEnvVars[key];
			return {
				...prev,
				envVars: newEnvVars,
			};
		});
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
			{ id: 'environment', label: 'Environment' },
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
						<ConnectionSettings settings={settings} onSettingsChange={handleSettingsChange} onClearCredentials={handleClearCredentials} onTestDevelopmentConnection={handleTestDevelopmentConnection} developmentTestMessage={developmentTestMessage} engineVersions={engineVersions} engineVersionsLoading={engineVersionsLoading} cloudSignedIn={cloudSignedIn} cloudUserName={cloudUserName} onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' } as any)} onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' } as any)} teams={teams} />
					</div>
				),
			},
			deployment: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<DeployTargetSettings settings={settings} onSettingsChange={handleSettingsChange} teams={teams} cloudSignedIn={cloudSignedIn} cloudUserName={cloudUserName} onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' } as any)} onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' } as any)} />
					</div>
				),
			},
			pipeline: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<PipelineSettings settings={settings} onSettingsChange={handleSettingsChange} />
					</div>
				),
			},
			environment: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<EnvVariablesSettings settings={settings} onEnvVarAdd={handleEnvVarAdd} onEnvVarUpdate={handleEnvVarUpdate} onEnvVarDelete={handleEnvVarDelete} />
					</div>
				),
			},
			debugging: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<DebuggingSettings settings={settings} onSettingsChange={handleSettingsChange} />
					</div>
				),
			},
			integrations: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<IntegrationSettings settings={settings} onSettingsChange={handleSettingsChange} />
					</div>
				),
			},
		}),
		[settings, message, developmentTestMessage, engineVersions, engineVersionsLoading, cloudSignedIn, cloudUserName, teams]
	);

	return (
		<div style={commonStyles.columnFill}>
			{/* ── Header bar ────────────────────────────────────────── */}
			<div style={commonStyles.headerBar}>
				<div>
					<div style={{ fontSize: 15, fontWeight: 600, color: 'var(--rr-text-primary)' }}>RocketRide Extension Settings</div>
					<div style={commonStyles.textMuted}>Configure your extension preferences and connection settings</div>
				</div>
				<button style={commonStyles.buttonPrimary} onClick={handleSaveSettings}>
					Save All Settings
				</button>
			</div>

			{/* ── Tab panel ─────────────────────────────────────────── */}
			<TabPanel tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} panels={panels} />
		</div>
	);
};
