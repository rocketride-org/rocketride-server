// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionSettings — "Development Mode" section of the VS Code Settings page.
 *
 * Renders a mode dropdown (Local/Cloud/On-prem/Docker/Service) and mode-specific
 * configuration fields (engine version, host URL, API key, cloud sign-in, team
 * selector, etc.).
 *
 * Cloud sign-in state is shared with DeployTargetSettings — signing in here
 * updates both sections.
 */

import React, { useState } from 'react';
import { MessageData, SettingsData, EngineVersionItem, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';
import { MessageDisplay } from './MessageDisplay';

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
	/** Cloud auth state — provided by PageSettingsProvider */
	cloudSignedIn?: boolean;
	cloudUserName?: string;
	onCloudSignIn?: () => void;
	onCloudSignOut?: () => void;
	/** Available teams for cloud mode */
	teams?: Array<{ id: string; name: string }>;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ConnectionSettings: React.FC<ConnectionSettingsProps> = ({ settings, onSettingsChange, onSave, onClearCredentials, onTestDevelopmentConnection, developmentTestMessage, engineVersions, engineVersionsLoading, cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut, teams }) => {
	const [showApiKey, setShowApiKey] = useState(false);
	const [passwordToggleHover, setPasswordToggleHover] = useState(false);

	// ========================================================================
	// EVENT HANDLERS
	// ========================================================================

	const handleConnectionModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as 'cloud' | 'docker' | 'service' | 'onprem' | 'local';
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

	const handleHostUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ hostUrl: e.target.value });
	};

	const handleAutoConnectChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ autoConnect: e.target.checked });
	};

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
						<label htmlFor="connectionMode" style={S.label}>
							Connection mode
						</label>
						<select id="connectionMode" value={settings.connectionMode} onChange={handleConnectionModeChange}>
							<option value="cloud">RocketRide Cloud</option>
							<option value="docker">Docker</option>
							<option value="service">Service</option>
							<option value="onprem">On-prem (your own hosted server)</option>
							<option value="local">Local</option>
						</select>
						<div style={S.helpText}>Choose where your server runs for development</div>
					</div>

					{/* Config box -- mode-specific fields */}
					<div style={S.modeConfigBox}>
						{/* ── Cloud ──────────────────────────────────────────── */}
						{settings.connectionMode === 'cloud' && (
							<>
								<div style={S.modeConfigDesc}>Sign in with your RocketRide account to connect to the cloud.</div>
								{cloudSignedIn ? (
									<div style={S.formGroup}>
										<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
											<span style={{ fontSize: 20, color: 'var(--vscode-testing-iconPassed, #22c55e)' }}>&#10003;</span>
											<div>
												<div style={{ fontWeight: 600, color: 'var(--rr-text-primary)' }}>{cloudUserName || 'Signed in'}</div>
											</div>
										</div>
										<button
											type="button"
											onClick={onCloudSignOut}
											style={{
												width: 'auto',
												marginTop: 8,
												backgroundColor: 'var(--vscode-button-secondaryBackground)',
												color: 'var(--vscode-button-secondaryForeground)',
											}}
										>
											Sign Out
										</button>
									</div>
								) : (
									<div style={S.formGroup}>
										<button type="button" onClick={onCloudSignIn} style={{ width: 'auto', padding: '10px 24px', fontWeight: 600 }}>
											Sign In
										</button>
									</div>
								)}
								{/* Team selector (only when signed in and teams available) */}
								{cloudSignedIn && teams && teams.length > 0 && (
									<div style={S.formGroup}>
										<label htmlFor="developmentTeam" style={S.label}>
											Team
										</label>
										<select id="developmentTeam" value={settings.developmentTeamId} onChange={(e) => onSettingsChange({ developmentTeamId: e.target.value })}>
											<option value="">Select a team...</option>
											{teams.map((t) => (
												<option key={t.id} value={t.id}>
													{t.name}
												</option>
											))}
										</select>
										<div style={S.helpText}>Which team's engine to connect to for development</div>
									</div>
								)}
								<div style={S.formGroup}>
									<label htmlFor="autoConnect" style={S.label}>
										Auto-connect on startup
									</label>
									<div>
										<input type="checkbox" id="autoConnect" checked={settings.autoConnect} onChange={handleAutoConnectChange} style={{ marginRight: 8, verticalAlign: 'middle' }} />
										<label htmlFor="autoConnect" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
											Automatically connect when extension starts
										</label>
									</div>
								</div>
							</>
						)}

						{/* ── Docker ─────────────────────────────────────────── */}
						{settings.connectionMode === 'docker' && (
							<>
								<div style={S.modeConfigDesc}>Connects to your local Docker instance.</div>
								<div style={S.formGroup}>
									<label htmlFor="autoConnect" style={S.label}>
										Auto-connect on startup
									</label>
									<div>
										<input type="checkbox" id="autoConnect" checked={settings.autoConnect} onChange={handleAutoConnectChange} style={{ marginRight: 8, verticalAlign: 'middle' }} />
										<label htmlFor="autoConnect" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
											Automatically connect when extension starts
										</label>
									</div>
								</div>
							</>
						)}

						{/* ── Service ────────────────────────────────────────── */}
						{settings.connectionMode === 'service' && (
							<>
								<div style={S.modeConfigDesc}>Connects to your local RocketRide service.</div>
								<div style={S.formGroup}>
									<label htmlFor="autoConnect" style={S.label}>
										Auto-connect on startup
									</label>
									<div>
										<input type="checkbox" id="autoConnect" checked={settings.autoConnect} onChange={handleAutoConnectChange} style={{ marginRight: 8, verticalAlign: 'middle' }} />
										<label htmlFor="autoConnect" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
											Automatically connect when extension starts
										</label>
									</div>
								</div>
							</>
						)}

						{/* ── On-prem ────────────────────────────────────────── */}
						{settings.connectionMode === 'onprem' && (
							<>
								<div style={S.modeConfigDesc}>Connect to your own hosted RocketRide server.</div>
								<div style={S.formGroup}>
									<label htmlFor="hostUrl" style={S.label}>
										Host URL
									</label>
									<input type="text" id="hostUrl" placeholder="your-server:5565" value={settings.hostUrl} onChange={handleHostUrlChange} />
									<div style={S.helpText}>Base URL of your hosted RocketRide server (e.g. myserver:5565)</div>
								</div>
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
									<div style={S.helpText}>API key is saved securely when you save settings.</div>
								</div>
								<div style={S.formGroup}>
									<label htmlFor="autoConnect" style={S.label}>
										Auto-connect on startup
									</label>
									<div>
										<input type="checkbox" id="autoConnect" checked={settings.autoConnect} onChange={handleAutoConnectChange} style={{ marginRight: 8, verticalAlign: 'middle' }} />
										<label htmlFor="autoConnect" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
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

						{/* ── Local ──────────────────────────────────────────── */}
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
		</div>
	);
};
