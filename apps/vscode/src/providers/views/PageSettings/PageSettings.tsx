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

import React, { useState, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';
import { ConnectionSettings } from './ConnectionSettings';
import { PipelineSettings } from './PipelineSettings';
import { DebuggingSettings } from './DebuggingSettings';
import { EnvVariablesSettings } from './EnvVariablesSettings';
import { IntegrationSettings } from './IntegrationSettings';
import { MessageDisplay } from './MessageDisplay';

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
	  };

// ============================================================================
// SHARED STYLES
// ============================================================================

export const settingsStyles = {
	section: {
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		padding: 20,
		backgroundColor: 'var(--rr-bg-default)',
	} as CSSProperties,
	sectionTitle: {
		fontSize: 18,
		fontWeight: 600,
		margin: '0 0 16px 0',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	sectionDescription: {
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		marginBottom: 16,
	} as CSSProperties,
	formGrid: {
		display: 'grid',
		gap: 16,
		gridTemplateColumns: '1fr',
		paddingLeft: 50,
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
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginTop: 4,
		lineHeight: 1.4,
	} as CSSProperties,
	modeConfigBox: {
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: 16,
		gridColumn: '1 / -1',
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,
	modeConfigDesc: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
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

	return (
		<div
			style={{
				maxWidth: 800,
				margin: '0 auto',
				padding: 24,
				backgroundColor: 'var(--rr-bg-default)',
			}}
		>
			<div
				style={{
					borderBottom: '1px solid var(--rr-border)',
					paddingBottom: 16,
					marginBottom: 24,
				}}
			>
				<h1
					style={{
						margin: '0 0 8px 0',
						fontSize: 24,
						fontWeight: 600,
						color: 'var(--rr-text-primary)',
					}}
				>
					RocketRide Extension Settings
				</h1>
				<p
					style={{
						margin: 0,
						color: 'var(--rr-text-secondary)',
						fontSize: 14,
					}}
				>
					Configure your RocketRide extension preferences and connection settings
				</p>
			</div>

			<div
				style={{
					display: 'flex',
					gap: 12,
					marginBottom: 24,
				}}
			>
				<button onClick={handleSaveSettings}>Save All Settings</button>
			</div>

			<MessageDisplay message={message} />

			<div style={{ display: 'grid', gap: 24 }}>
				<ConnectionSettings settings={settings} onSettingsChange={handleSettingsChange} onClearCredentials={handleClearCredentials} onTestDevelopmentConnection={handleTestDevelopmentConnection} developmentTestMessage={developmentTestMessage} engineVersions={engineVersions} engineVersionsLoading={engineVersionsLoading} cloudSignedIn={cloudSignedIn} cloudUserName={cloudUserName} onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' } as any)} onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' } as any)} />

				<PipelineSettings settings={settings} onSettingsChange={handleSettingsChange} />

				<EnvVariablesSettings settings={settings} onEnvVarAdd={handleEnvVarAdd} onEnvVarUpdate={handleEnvVarUpdate} onEnvVarDelete={handleEnvVarDelete} />

				<DebuggingSettings settings={settings} onSettingsChange={handleSettingsChange} />

				<IntegrationSettings settings={settings} onSettingsChange={handleSettingsChange} />
			</div>
		</div>
	);
};
