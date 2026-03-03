// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

import React, { useState } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';
import { ConnectionSettings } from './ConnectionSettings';
import { PipelineSettings } from './PipelineSettings';
import { DebuggingSettings } from './DebuggingSettings';
import { EnvVariablesSettings } from './EnvVariablesSettings';
import { MessageDisplay } from './MessageDisplay';

// Import the styles
import '../../styles/vscode.css'
import '../../styles/app.css';
import './styles.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface SettingsData {
	hostUrl: string;
	connectionMode: 'cloud' | 'onprem' | 'local';
	hasApiKey: boolean;
	apiKey: string;
	autoConnect: boolean;
	defaultPipelinePath: string;
	localEngineVersion: string;
	localEngineArgs: string[];
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';
	envVars?: Record<string, string>;
}

export interface EngineVersionItem {
	tag_name: string;
	prerelease: boolean;
}

export interface MessageData {
	level: 'success' | 'error' | 'info' | 'warning';
	message: string;
}

export type PageSettingsIncomingMessage
	= {
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

export type PageSettingsOutgoingMessage
	= {
		type: 'ready';
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
		localEngineArgs: [],
		pipelineRestartBehavior: 'prompt',
		envVars: {}
	});
	const [message, setMessage] = useState<MessageData | null>(null);
	const [developmentTestMessage, setDevelopmentTestMessage] = useState<MessageData | null>(null);
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	// ========================================================================
	// WEBVIEW MESSAGING
	// ========================================================================

	const { sendMessage, isReady: _isReady } = useMessaging<
		PageSettingsOutgoingMessage, PageSettingsIncomingMessage>({
			onMessage: (message) => {
				// Handle all incoming messages from your discriminated union
				switch (message.type) {
					case 'settingsLoaded':
						setSettings(message.settings);
						if (message.settings.connectionMode === 'local') {
							setEngineVersionsLoading(true);
							sendMessage({ type: 'fetchEngineVersions' });
						}
						break;

					case 'engineVersionsLoaded':
						setEngineVersions(message.versions);
						setEngineVersionsLoading(false);
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
			}
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
		setSettings(prev => ({ ...prev, apiKey: '', hasApiKey: false }));
		sendMessage({ type: 'clearCredentials' });
	};

	/**
	 * Update settings with partial changes
	 */
	const handleSettingsChange = (newSettings: Partial<SettingsData>): void => {
		setSettings(prev => {
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
		setSettings(prev => ({
			...prev,
			envVars: {
				...prev.envVars,
				[key]: value
			}
		}));
	};

	/**
	 * Update an existing environment variable (local state only, not saved until "Save All Settings")
	 */
	const handleEnvVarUpdate = (key: string, value: string): void => {
		setSettings(prev => ({
			...prev,
			envVars: {
				...prev.envVars,
				[key]: value
			}
		}));
	};

	/**
	 * Delete an environment variable (local state only, not saved until "Save All Settings")
	 */
	const handleEnvVarDelete = (key: string): void => {
		setSettings(prev => {
			const newEnvVars = { ...prev.envVars };
			delete newEnvVars[key];
			return {
				...prev,
				envVars: newEnvVars
			};
		});
	};

	// ========================================================================
	// RENDER
	// ========================================================================

	return (
		<div className="settings-app">
			<div className="header">
				<h1>RocketRide Extension Settings</h1>
				<p>Configure your RocketRide extension preferences and connection settings</p>
			</div>

			<div className="action-buttons">
				<button onClick={handleSaveSettings}>Save All Settings</button>
			</div>

			<MessageDisplay message={message} />

			<div className="settings-container">
				<ConnectionSettings
					settings={settings}
					onSettingsChange={handleSettingsChange}
					onClearCredentials={handleClearCredentials}
					onTestDevelopmentConnection={handleTestDevelopmentConnection}
					developmentTestMessage={developmentTestMessage}
					engineVersions={engineVersions}
					engineVersionsLoading={engineVersionsLoading}
				/>

				<PipelineSettings
					settings={settings}
					onSettingsChange={handleSettingsChange}
				/>

				<EnvVariablesSettings
					settings={settings}
					onEnvVarAdd={handleEnvVarAdd}
					onEnvVarUpdate={handleEnvVarUpdate}
					onEnvVarDelete={handleEnvVarDelete}
				/>

				<DebuggingSettings
					settings={settings}
					onSettingsChange={handleSettingsChange}
				/>
			</div>
		</div>
	);
};
