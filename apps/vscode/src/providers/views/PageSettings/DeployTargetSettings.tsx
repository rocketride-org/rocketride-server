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

/**
 * DeployTargetSettings — full settings section for the deployment target.
 *
 * Mirrors ConnectionSettings in structure: mode dropdown + mode-specific config.
 * Supports all modes (Local, Cloud, On-prem, Docker, Service) because the user
 * can develop in the cloud but deploy locally, or vice versa.
 *
 * Key differences from ConnectionSettings:
 *   - Uses deploy-specific fields: deployHostUrl, deployApiKey (not shared with dev)
 *   - Cloud sign-in state is SHARED — signing in here or in dev section updates both
 *   - "Deploy to a different target" checkbox controls whether the section is expanded
 *   - When collapsed (deployTargetMode = null), deploy uses the same target as dev
 *
 * Architecture:
 *   PageSettings → DeployTargetSettings → settings page webview
 *   DeployManager (extension host) owns the actual deploy connection
 */

import React, { useState } from 'react';
import { SettingsData, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for the DeployTargetSettings section.
 *
 * @property settings - The full settings data object (reads deploy-specific fields)
 * @property onSettingsChange - Callback to update settings (partial patch)
 * @property teams - Team list fetched from the deploy server (for cloud mode)
 * @property cloudSignedIn - Whether user is signed into RocketRide Cloud (shared state)
 * @property cloudUserName - Display name of the signed-in user
 * @property onCloudSignIn - Triggers the OAuth sign-in flow (shared with dev section)
 * @property onCloudSignOut - Signs out from cloud (shared with dev section)
 */
interface DeployTargetSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	onSave: () => void;
	teams: Array<{ id: string; name: string }>;
	cloudSignedIn?: boolean;
	cloudUserName?: string;
	onCloudSignIn?: () => void;
	onCloudSignOut?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const DeployTargetSettings: React.FC<DeployTargetSettingsProps> = ({ settings, onSettingsChange, onSave, teams, cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut }) => {
	// ── Local UI state ──────────────────────────────────────────────────────
	const [showDeployApiKey, setShowDeployApiKey] = useState(false);
	const [passwordToggleHover, setPasswordToggleHover] = useState(false);

	/** Whether the deploy target section is expanded (deployTargetMode !== null). */
	const hasDeployTarget = settings.deployTargetMode !== null;

	// =========================================================================
	// EVENT HANDLERS
	// =========================================================================

	/**
	 * Toggles the deploy target section on/off.
	 * When enabled, defaults to cloud mode if signed in, otherwise local.
	 */
	const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.checked) {
			// Pick a sensible default mode
			const defaultMode = cloudSignedIn ? 'cloud' : 'local';
			onSettingsChange({ deployTargetMode: defaultMode });
		} else {
			// Collapse section — clear deploy-specific settings
			onSettingsChange({ deployTargetMode: null, deployTargetTeamId: '' });
		}
	};

	/**
	 * Changes the deploy target mode.
	 * Resets mode-specific fields when switching (e.g. clears team when leaving cloud).
	 */
	const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as SettingsData['deployTargetMode'];
		onSettingsChange({ deployTargetMode: mode });
	};

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={S.card}>
			<SettingsCardHeader title="Deployment Target" onSave={onSave} />
			<div style={S.cardBody}>
				<div style={S.sectionDescription}>Where pipelines are deployed for production. Leave unchecked to deploy to the same target as development.</div>
				<div style={S.formGrid}>
					{/* ── Enable/disable toggle ────────────────────────────────── */}
					<div style={S.formGroup}>
						<div>
							<input type="checkbox" id="deployTargetEnabled" checked={hasDeployTarget} onChange={handleToggle} style={{ marginRight: 8, verticalAlign: 'middle' }} />
							<label htmlFor="deployTargetEnabled" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
								Deploy to a different target
							</label>
						</div>
					</div>

					{/* ── Mode-specific config (only when enabled) ─────────────── */}
					{hasDeployTarget && (
						<>
							{/* Mode dropdown */}
							<div style={S.formGroup}>
								<label htmlFor="deployTargetMode" style={S.label}>
									Target
								</label>
								<select id="deployTargetMode" value={settings.deployTargetMode ?? ''} onChange={handleModeChange}>
									<option value="local">Local</option>
									<option value="cloud">RocketRide Cloud</option>
									<option value="onprem">On-prem (your own hosted server)</option>
									<option value="docker">Docker</option>
									<option value="service">Service</option>
								</select>
								<div style={S.helpText}>Choose where to deploy pipelines for production</div>
							</div>

							{/* Config box — mode-specific fields */}
							<div style={S.modeConfigBox}>
								{/* ── Local deploy mode ──────────────────────────── */}
								{settings.deployTargetMode === 'local' && <div style={S.modeConfigDesc}>Deploy to a local engine on this machine. The extension will manage a separate engine process for deployment.</div>}

								{/* ── Cloud deploy mode ──────────────────────────── */}
								{settings.deployTargetMode === 'cloud' && (
									<>
										<div style={S.modeConfigDesc}>Deploy to RocketRide Cloud. Sign-in is shared with the development section.</div>

										{/* Cloud sign-in status (shared state) */}
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

										{/* Team selector (only when signed in) */}
										{cloudSignedIn && teams.length > 0 && (
											<div style={S.formGroup}>
												<label htmlFor="deployTargetTeam" style={S.label}>
													Team
												</label>
												<select id="deployTargetTeam" value={settings.deployTargetTeamId} onChange={(e) => onSettingsChange({ deployTargetTeamId: e.target.value })}>
													<option value="">Select a team...</option>
													{teams.map((t) => (
														<option key={t.id} value={t.id}>
															{t.name}
														</option>
													))}
												</select>
												<div style={S.helpText}>Which team to deploy pipelines to</div>
											</div>
										)}

										{/* Auto-connect for deploy */}
										<div style={S.formGroup}>
											<label htmlFor="deployAutoConnect" style={S.label}>
												Auto-connect on startup
											</label>
											<div>
												<input type="checkbox" id="deployAutoConnect" checked={settings.deployAutoConnect} onChange={(e) => onSettingsChange({ deployAutoConnect: e.target.checked })} style={{ marginRight: 8, verticalAlign: 'middle' }} />
												<label htmlFor="deployAutoConnect" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
													Automatically connect to deploy target when extension starts
												</label>
											</div>
										</div>
									</>
								)}

								{/* ── On-prem deploy mode ────────────────────────── */}
								{settings.deployTargetMode === 'onprem' && (
									<>
										<div style={S.modeConfigDesc}>Deploy to your own hosted RocketRide server. Uses separate credentials from the development connection.</div>

										{/* Deploy host URL */}
										<div style={S.formGroup}>
											<label htmlFor="deployHostUrl" style={S.label}>
												Host URL
											</label>
											<input type="text" id="deployHostUrl" placeholder="your-server:5565" value={settings.deployHostUrl} onChange={(e) => onSettingsChange({ deployHostUrl: e.target.value })} />
											<div style={S.helpText}>Base URL of the deploy target server</div>
										</div>

										{/* Deploy API key (separate from dev) */}
										<div style={S.formGroup}>
											<label htmlFor="deployApiKey" style={S.label}>
												API Key
											</label>
											<div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
												<input type={showDeployApiKey ? 'text' : 'password'} id="deployApiKey" placeholder="Enter API key for deploy target" value={settings.deployApiKey} onChange={(e) => onSettingsChange({ deployApiKey: e.target.value })} style={{ flex: 1 }} />
												<button
													type="button"
													onClick={() => setShowDeployApiKey(!showDeployApiKey)}
													title={showDeployApiKey ? 'Hide API key' : 'Show API key'}
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
													{showDeployApiKey ? '\u{1F648}' : '\u{1F50D}'}
												</button>
											</div>
											<div style={S.helpText}>API key for the deploy target (saved securely, separate from dev key)</div>
										</div>

										{/* Auto-connect for deploy */}
										<div style={S.formGroup}>
											<label htmlFor="deployAutoConnectOnprem" style={S.label}>
												Auto-connect on startup
											</label>
											<div>
												<input type="checkbox" id="deployAutoConnectOnprem" checked={settings.deployAutoConnect} onChange={(e) => onSettingsChange({ deployAutoConnect: e.target.checked })} style={{ marginRight: 8, verticalAlign: 'middle' }} />
												<label htmlFor="deployAutoConnectOnprem" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
													Automatically connect to deploy target when extension starts
												</label>
											</div>
										</div>
									</>
								)}

								{/* ── Docker deploy mode ─────────────────────────── */}
								{settings.deployTargetMode === 'docker' && (
									<>
										<div style={S.modeConfigDesc}>Deploy pipelines to a Docker container.</div>
										<div style={S.formGroup}>
											<div>
												<input type="checkbox" id="deployAutoConnectDocker" checked={settings.deployAutoConnect} onChange={(e) => onSettingsChange({ deployAutoConnect: e.target.checked })} style={{ marginRight: 8, verticalAlign: 'middle' }} />
												<label htmlFor="deployAutoConnectDocker" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
													Automatically connect when extension starts
												</label>
											</div>
										</div>
									</>
								)}

								{/* ── Service deploy mode ────────────────────────── */}
								{settings.deployTargetMode === 'service' && (
									<>
										<div style={S.modeConfigDesc}>Deploy pipelines to a local system service.</div>
										<div style={S.formGroup}>
											<div>
												<input type="checkbox" id="deployAutoConnectService" checked={settings.deployAutoConnect} onChange={(e) => onSettingsChange({ deployAutoConnect: e.target.checked })} style={{ marginRight: 8, verticalAlign: 'middle' }} />
												<label htmlFor="deployAutoConnectService" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
													Automatically connect when extension starts
												</label>
											</div>
										</div>
									</>
								)}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
};
