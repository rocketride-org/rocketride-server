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

import React, { useState } from 'react';
import { MessageData, SettingsData, EngineVersionItem, settingsStyles as S } from './PageSettings';
import { MessageDisplay } from './MessageDisplay';

// ============================================================================
// TYPES
// ============================================================================

interface ConnectionSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	onClearCredentials: () => void;
	onTestDevelopmentConnection: () => void;
	developmentTestMessage: MessageData | null;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ConnectionSettings: React.FC<ConnectionSettingsProps> = ({ settings, onSettingsChange, onClearCredentials, onTestDevelopmentConnection, developmentTestMessage, engineVersions, engineVersionsLoading }) => {
	const [showApiKey, setShowApiKey] = useState(false);
	const [passwordToggleHover, setPasswordToggleHover] = useState(false);

	// ========================================================================
	// EVENT HANDLERS
	// ========================================================================

	const handleConnectionModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as 'cloud' | 'onprem' | 'local';
		const updates: Partial<SettingsData> = { connectionMode: mode };

		if (mode === 'cloud') {
			updates.hostUrl = 'https://cloud.rocketride.ai';
		} else if (mode === 'onprem') {
			if (!settings.hostUrl || settings.hostUrl === 'https://cloud.rocketride.ai' || settings.hostUrl.startsWith('http://localhost')) {
				updates.hostUrl = '';
			}
		} else if (mode === 'local') {
			updates.autoConnect = true;
		}

		onSettingsChange(updates);
	};

	const handleHostUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ hostUrl: e.target.value });
	};

	const handleAutoConnectChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ autoConnect: e.target.checked });
	};

	// Engine version and arguments handlers (local mode)
	const handleVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ localEngineVersion: e.target.value });
	};

	const displayVersion = (tagName: string): string => {
		return tagName.replace(/^server-/, '');
	};

	const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({
			apiKey: e.target.value,
			hasApiKey: e.target.value.trim().length > 0,
		});
	};

	const toggleApiKeyVisibility = () => {
		setShowApiKey(!showApiKey);
	};

	const showAccountWarning = settings.connectionMode === 'onprem' && !settings.apiKey.trim();

	// ========================================================================
	// RENDER
	// ========================================================================

	return (
		<>
			{/* Development -- where you run and debug (local or remote) */}
			<div
				style={{
					...S.section,
					...(showAccountWarning
						? {
								borderColor: 'var(--vscode-editorWarning-foreground)',
								backgroundColor: 'var(--vscode-editorWarning-background)',
							}
						: {}),
				}}
				id="developmentSection"
			>
				<div style={S.sectionTitle}>Development connection</div>
				<div style={S.sectionDescription}>Where the extension connects to run and debug pipelines. Cloud and On-prem modes require a RocketRide API key.</div>
				<div style={S.formGrid}>
					<div style={S.formGroup}>
						<label htmlFor="connectionMode" style={S.label}>
							Connection mode
						</label>
						<select id="connectionMode" value={settings.connectionMode} onChange={handleConnectionModeChange}>
							<option value="cloud">Cloud (RocketRide.ai cloud)</option>
							<option value="onprem">On-prem (your own hosted server)</option>
							<option value="local">Local (your local machine)</option>
						</select>
						<div style={S.helpText}>Choose where your server runs for development</div>
					</div>

					{/* Config box -- description + mode-specific fields */}
					<div style={S.modeConfigBox}>
						{/* Cloud -- Coming Soon */}
						{settings.connectionMode === 'cloud' && (
							<>
								<div style={S.modeConfigDesc}>Connect to RocketRide.ai cloud. Requires an API key from your account dashboard.</div>
								<div style={{ textAlign: 'center', padding: '20px 16px' }}>
									<div style={{ fontSize: 36, marginBottom: 10, opacity: 0.6 }}>&#9729;</div>
									<div
										style={{
											fontSize: 15,
											fontWeight: 600,
											color: 'var(--rr-text-primary)',
											marginBottom: 6,
											letterSpacing: 0.5,
										}}
									>
										Coming Soon
									</div>
									<div
										style={{
											fontSize: 12,
											color: 'var(--rr-text-secondary)',
											lineHeight: 1.6,
										}}
									>
										RocketRide Cloud is under active development.
										<br />
										Stay tuned for managed cloud hosting with zero setup.
									</div>
								</div>
							</>
						)}

						{/* On-prem */}
						{settings.connectionMode === 'onprem' && (
							<>
								<div style={S.modeConfigDesc}>Connect to your own hosted RocketRide server.</div>
								<div style={S.formGroup} id="apiKeyGroup">
									<label htmlFor="apiKey" style={S.label}>
										API Key
									</label>
									<div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
										<input type={showApiKey ? 'text' : 'password'} id="apiKey" placeholder="Enter your API key" value={settings.apiKey} onChange={handleApiKeyChange} style={{ flex: 1 }} />
										<button
											type="button"
											onClick={toggleApiKeyVisibility}
											title={showApiKey ? 'Hide API key' : 'Show API key'}
											onMouseEnter={() => setPasswordToggleHover(true)}
											onMouseLeave={() => setPasswordToggleHover(false)}
											style={{
												backgroundColor: 'var(--vscode-button-secondaryBackground)',
												color: 'var(--vscode-button-secondaryForeground)',
												border: '1px solid var(--rr-border-input)',
												padding: '8px 12px',
												borderRadius: 4,
												cursor: 'pointer',
												fontSize: 20,
												minWidth: 44,
												display: 'flex',
												alignItems: 'center',
												justifyContent: 'center',
												transition: 'all 0.2s',
												...(passwordToggleHover
													? {
															backgroundColor: 'var(--vscode-button-secondaryHoverBackground)',
															borderColor: 'var(--rr-border-focus)',
														}
													: {}),
											}}
										>
											{showApiKey ? '\u{1F648}' : '\u{1F50D}'}
										</button>
										{settings.apiKey.trim() && (
											<button type="button" onClick={onClearCredentials} title="Clear stored API key" style={{ padding: '6px 12px', fontSize: 12 }}>
												Clear
											</button>
										)}
									</div>
									<div style={S.helpText}>API key is saved securely when you save settings. Required for cloud development and for deployment.</div>
								</div>
								<div style={S.formGroup}>
									<label htmlFor="hostUrl" style={S.label}>
										Host URL
									</label>
									<input type="text" id="hostUrl" placeholder="your-server:5565" value={settings.hostUrl} onChange={handleHostUrlChange} />
									<div style={S.helpText}>Base URL of your hosted RocketRide server (e.g. myserver:5565)</div>
								</div>
								<div style={S.formGroup}>
									<label htmlFor="autoConnect" style={S.label}>
										Auto-connect on startup
									</label>
									<div>
										<input type="checkbox" id="autoConnect" checked={settings.autoConnect} onChange={handleAutoConnectChange} style={{ marginRight: 8, verticalAlign: 'middle' }} />
										<label
											htmlFor="autoConnect"
											style={{
												display: 'inline',
												fontWeight: 'normal',
												margin: 0,
												verticalAlign: 'middle',
												cursor: 'pointer',
											}}
										>
											Automatically connect when extension starts
										</label>
									</div>
									<div style={S.helpText}>Enable to connect automatically on startup</div>
								</div>
								<div style={{ ...S.formGroup, alignItems: 'flex-end' }}>
									<button
										type="button"
										onClick={onTestDevelopmentConnection}
										title="Test connection to the development server"
										style={{
											width: 'auto',
											backgroundColor: 'var(--vscode-button-secondaryBackground)',
											color: 'var(--vscode-button-secondaryForeground)',
										}}
									>
										Test connection
									</button>
									<div style={S.helpText}>Verify the development server URL and credentials</div>
								</div>
								{developmentTestMessage && <MessageDisplay message={developmentTestMessage} inline />}
							</>
						)}

						{/* Local */}
						{settings.connectionMode === 'local' && (
							<>
								<div style={S.modeConfigDesc}>Run the server locally on your machine. The extension will download and manage the server for you.</div>
								<div style={S.formGroup}>
									<label htmlFor="serverVersion" style={S.label}>
										Server Version
									</label>
									<select id="serverVersion" value={settings.localEngineVersion} onChange={handleVersionChange} disabled={engineVersionsLoading}>
										<optgroup label="Recommended">
											<option value="latest">&lt;Latest&gt;</option>
											<option value="prerelease">&lt;Prerelease&gt;</option>
										</optgroup>
										<optgroup label={engineVersionsLoading ? 'Loading versions...' : 'All versions'}>
											{engineVersions.map((v) => (
												<option key={v.tag_name} value={v.tag_name}>
													{displayVersion(v.tag_name)}
												</option>
											))}
										</optgroup>
									</select>
									<div style={S.helpText}>Choose which server version to download. &lt;Latest&gt; gets the newest stable release.</div>
								</div>
							</>
						)}
					</div>

					{/* Debug -- shown for local and on-prem modes */}
					{(settings.connectionMode === 'local' || settings.connectionMode === 'onprem') && (
						<div style={S.modeConfigBox}>
							<div style={S.formGroup}>
								<div>
									<input type="checkbox" id="localDebugOutput" checked={settings.localDebugOutput} onChange={(e) => onSettingsChange({ localDebugOutput: e.target.checked })} style={{ marginRight: 8, verticalAlign: 'middle' }} />
									<label
										htmlFor="localDebugOutput"
										style={{
											display: 'inline',
											fontWeight: 'normal',
											margin: 0,
											verticalAlign: 'middle',
											cursor: 'pointer',
										}}
									>
										Full debug output
									</label>
								</div>
								<div style={S.helpText}>Enable detailed server trace logging (see Output&#8594;RocketRide: Console)</div>
							</div>
							{settings.connectionMode === 'local' && (
								<div style={S.formGroup}>
									<label htmlFor="engineArgs" style={S.label}>
										Server Arguments
									</label>
									<input type="text" id="engineArgs" value={settings.localEngineArgs} placeholder="--option=value --flag" onChange={(e) => onSettingsChange({ localEngineArgs: e.target.value })} />
									<div style={S.helpText}>Additional command-line arguments passed to the server</div>
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</>
	);
};
