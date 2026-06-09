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
 * WelcomeWebview — first-run onboarding page shown in a VS Code webview.
 *
 * Presents a branded split-panel layout: branding/features on the left,
 * simplified connection configuration on the right. Uses the same
 * ConnectionConfig component as the full Settings page but in `simplified`
 * mode (fewer fields, single "Save & Connect" action).
 *
 * Message flow mirrors SettingsWebview: the extension host sends
 * settingsLoaded/showMessage/ioProgress/ioResult, and the webview
 * responds with saveAndConnect/ioControl/cloud:signIn/etc.
 */

import React, { useState, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';
import { useTheme } from '../hooks/useTheme';
import { commonStyles } from 'shared/themes/styles';
import { ConnectionConfig } from '../components/ConnectionConfig';
import { MessageDisplay } from '../Settings/MessageDisplay';
import type { SettingsData, ConnectionMode, EngineVersionItem, MessageData } from '../Settings/SettingsWebview';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface WelcomeExtraSettings {}

type IncomingMessage = { type: 'settingsLoaded'; settings: SettingsData & WelcomeExtraSettings; logoDarkUri?: string; logoLightUri?: string } | { type: 'showMessage'; level: 'success' | 'error' | 'info' | 'warning'; message: string } | { type: 'versionsLoaded'; versions: EngineVersionItem[] } | { type: 'cloud:status'; signedIn: boolean; userName: string } | { type: 'teamsLoaded'; teams: Array<{ id: string; name: string }> } | { type: 'dockerStatus'; status: DockerStatus } | { type: 'dockerVersionsLoaded'; tags: string[] } | { type: 'serviceStatus'; status: ServiceStatus } | { type: 'serviceNeedsSudo' } | { type: 'ioProgress'; mode: string; command: string; message: string } | { type: 'ioResult'; mode: string; command: string; success: boolean; error?: string };

type OutgoingMessage = { type: string; [key: string]: unknown };

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	outer: {
		display: 'flex',
		maxWidth: 860,
		width: '100%',
		margin: '40px auto',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		overflow: 'hidden',
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
	brandPanel: {
		width: 280,
		minWidth: 280,
		background: 'var(--rr-bg-widget)',
		padding: '40px 30px',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		borderRight: '1px solid var(--rr-border)',
	} as CSSProperties,
	logoContainer: {
		width: 100,
		height: 100,
		marginBottom: 20,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 56,
	} as CSSProperties,
	featureItem: {
		padding: '6px 0',
		color: 'var(--rr-text-primary)',
		fontSize: 12.5,
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as CSSProperties,
	featureIcon: {
		color: 'var(--rr-accent)',
		fontSize: 14,
		width: 18,
		textAlign: 'center',
		flexShrink: 0,
	} as CSSProperties,
	configPanel: {
		flex: 1,
		padding: '40px 36px',
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	footerLink: {
		color: 'var(--rr-text-link)',
		textDecoration: 'none',
		fontSize: 12,
		cursor: 'pointer',
		background: 'none',
		border: 'none',
		padding: 0,
	} as CSSProperties,
};

// =============================================================================
// DEFAULT SETTINGS
// =============================================================================

const DEFAULT_SETTINGS: SettingsData = {
	development: {
		connectionMode: 'local',
		hostUrl: 'http://localhost:5565',
		apiKey: '',
		hasApiKey: false,
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
};

// =============================================================================
// COMPONENT
// =============================================================================

export const Welcome: React.FC = () => {
	const theme = useTheme();

	// Settings state
	const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);

	// Branding
	const [logoDarkUri, setLogoDarkUri] = useState<string | undefined>();
	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();

	// Messages
	const [message, setMessage] = useState<MessageData | null>(null);
	const [testMessage, setTestMessage] = useState<MessageData | null>(null);

	// Engine versions
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	// Server capabilities
	const [serverCapabilities, setServerCapabilities] = useState<string[]>([]);
	const [isSaasProbed, setIsSaasProbed] = useState<boolean | undefined>(undefined);

	// Cloud auth
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

	// Hover state
	const [hoveredLink, setHoveredLink] = useState<string | null>(null);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'settingsLoaded':
					setSettings(msg.settings);
					if (msg.logoDarkUri) setLogoDarkUri(msg.logoDarkUri);
					if (msg.logoLightUri) setLogoLightUri(msg.logoLightUri);
					if (msg.settings.development.connectionMode === 'local') {
						setEngineVersionsLoading(true);
						sendMessage({ type: 'fetchVersions' });
					}
					sendMessage({ type: 'cloud:getStatus' });
					break;

				case 'showMessage': {
					const data = { level: msg.level, message: msg.message };
					setMessage(data);
					if (msg.level === 'success') setTimeout(() => setMessage(null), 5000);
					break;
				}

				case 'versionsLoaded':
					setEngineVersions((msg as any).versions);
					setEngineVersionsLoading(false);
					break;

				case 'cloud:status':
					setCloudSignedIn((msg as any).signedIn);
					setCloudUserName((msg as any).userName || '');
					break;

				case 'teamsLoaded':
					setTeams((msg as any).teams || []);
					break;

				// Status polling — actual OS/Docker daemon state
				case 'dockerStatus':
					setDockerStatus((msg as any).status);
					if (!dockerBusy) setDockerProgress(null);
					break;
				case 'serviceStatus':
					setServiceStatus((msg as any).status);
					if (!serviceBusy) setServiceProgress(null);
					break;
				case 'dockerVersionsLoaded':
					setDockerTags((msg as any).tags || []);
					break;
				case 'serviceNeedsSudo':
					setSudoPromptVisible(true);
					break;

				// Unified ioControl progress — shows download/install status
				case 'ioProgress': {
					const mode = (msg as any).mode;
					const progressMsg = (msg as any).message;
					if (mode === 'service') {
						setServiceProgress(progressMsg);
						setServiceError(null);
					} else if (mode === 'docker') {
						setDockerProgress(progressMsg);
						setDockerError(null);
					}
					break;
				}

				// Unified ioControl result — clears busy state for the mode
				case 'ioResult': {
					const mode = (msg as any).mode;
					const command = (msg as any).command;
					const success = (msg as any).success;
					const error = (msg as any).error;

					// Test results show inline via testMessage
					if (command === 'test') {
						const data: MessageData = success
							? { level: 'success', message: 'Connection successful!' }
							: { level: 'error', message: error || 'Connection failed' };
						setTestMessage(data);
						if (success) setTimeout(() => setTestMessage(null), 5000);
						break;
					}

					if (mode === 'service') {
						setServiceBusy(false);
						setServiceAction(null);
						setServiceProgress(null);
						setSudoPromptVisible(false);
						setSudoPasswordInput('');
						if (!success && error) setServiceError(error);
					} else if (mode === 'docker') {
						setDockerBusy(false);
						setDockerAction(null);
						setDockerProgress(null);
						if (!success && error) setDockerError(error);
					}
					break;
				}

				case 'serverInfo' as string: {
					const caps = (msg as any).capabilities || [];
					setServerCapabilities(caps);
					setIsSaasProbed(caps.includes('saas'));
					break;
				}
			}
		},
	});

	// =========================================================================
	// HANDLERS
	// =========================================================================

	/**
	 * Merge partial changes into local settings state.
	 * Same deep-merge logic as SettingsWebview.handleSettingsChange,
	 * plus side effects for version/cloud fetching on mode switch.
	 */
	const handleSettingsChange = (changes: Partial<SettingsData>) => {
		// Clear stale test results when mode changes
		if (changes.development?.connectionMode) {
			setTestMessage(null);
		}
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

			// Side effects for mode switching
			const devMode = changes.development?.connectionMode;
			if (devMode === 'local' && prev.development.connectionMode !== 'local') {
				setEngineVersionsLoading(true);
				sendMessage({ type: 'fetchVersions' });
			}
			if (devMode === 'cloud' && prev.development.connectionMode !== 'cloud') {
				sendMessage({ type: 'cloud:getStatus' });
				// Teams are fetched by CloudPanel after it confirms the server is SaaS
			}

			return next;
		});
	};

	const handleConnectionModeChange = (mode: ConnectionMode) => {
		const groupUpdates: Partial<SettingsData['development']> = { connectionMode: mode };
		if (mode === 'onprem') {
			const hostUrl = settings.development.hostUrl;
			if (!hostUrl || hostUrl.includes('cloud.rocketride') || hostUrl.startsWith('http://localhost')) {
				groupUpdates.hostUrl = '';
			}
		}
		handleSettingsChange({ development: groupUpdates } as Partial<SettingsData>);
	};

	const handleSaveAndConnect = () => {
		sendMessage({ type: 'saveAndConnect', settings });
	};

	const handleProbeCloudServer = (cloudUrl: string) => {
		setIsSaasProbed(undefined);
		sendMessage({ type: 'probeServerInfo', hostUrl: cloudUrl } as any);
	};

	const handleFetchTeams = (cloudUrl: string) => {
		sendMessage({ type: 'fetchTeams', hostUrl: cloudUrl } as any);
	};

	/**
	 * Send a test connection request via ioControl.
	 * On-prem passes hostUrl/apiKey as params; docker/service use backend defaults.
	 */
	const handleTestConnection = (mode: string, params?: Record<string, unknown>) => {
		setTestMessage(null);
		sendMessage({ type: 'ioControl', mode, command: 'test', params } as any);
	};

	/**
	 * Factory for docker/service lifecycle actions.
	 * Sets busy/action state, attaches the selected version for install/update,
	 * and dispatches an ioControl message. The host streams ioProgress updates
	 * and sends a final ioResult to clear busy state.
	 */
	const makeEngineHandler = (mode: 'docker' | 'service', actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => () => {
		const setBusy = mode === 'docker' ? setDockerBusy : setServiceBusy;
		const setAction = mode === 'docker' ? setDockerAction : setServiceAction;
		const setError = mode === 'docker' ? setDockerError : setServiceError;
		const selectedVersion = mode === 'docker' ? dockerSelectedVersion : serviceSelectedVersion;

		setBusy(true);
		setAction(actionType);
		setError(null);

		const params: Record<string, unknown> = {};
		if (actionType === 'install' || actionType === 'update') {
			params.version = selectedVersion;
		}
		sendMessage({ type: 'ioControl', mode, command: actionType, params } as any);
	};

	const makeDockerHandler = (actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => makeEngineHandler('docker', actionType);
	const makeServiceHandler = (actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => makeEngineHandler('service', actionType);

	const handleSudoSubmit = () => {
		const password = sudoPasswordInput;
		setSudoPasswordInput('');
		setSudoPromptVisible(false);
		sendMessage({ type: 'sudoPassword', password });
	};

	const dockerVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...dockerTags.filter((t) => t !== 'latest' && t !== 'prerelease').map((t) => ({ value: t, label: t }))];

	const serviceVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...engineVersions.map((v) => ({ value: v.tag_name, label: v.tag_name.replace(/^server-/, '') }))];

	const logoUri = theme === 'dark' ? logoLightUri : logoDarkUri;

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={{ padding: '20px 24px', height: '100%', boxSizing: 'border-box', overflow: 'auto' }}>
			<div style={styles.outer}>
				{/* LEFT PANEL - Branding */}
				<div style={styles.brandPanel}>
					<div style={styles.logoContainer}>{logoUri ? <img src={logoUri} alt="RocketRide" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : '\u{1F680}'}</div>
					<div style={{ fontSize: 22, fontWeight: 700, color: 'var(--rr-text-primary)', letterSpacing: 0.5, marginBottom: 4 }}>RocketRide</div>
					<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', textAlign: 'center', marginBottom: 30, lineHeight: 1.6 }}>
						High-performance data processing
						<br />
						with AI/ML integration
					</div>

					<ul style={{ listStyle: 'none', width: '100%', margin: '0 0 30px', padding: 0 }}>
						{['Visual pipeline editor', 'High-performance C++ engine', '50+ pipeline nodes with AI/ML', 'Multi-agent workflows', 'Tool and model agnostic', 'TypeScript, Python & MCP SDKs'].map((feat) => (
							<li key={feat} style={styles.featureItem}>
								<span style={styles.featureIcon}>&#9670;</span> {feat}
							</li>
						))}
					</ul>

					<div style={{ width: '100%', height: 1, background: 'var(--rr-border)', margin: '10px 0 20px' }} />

					<div style={{ display: 'flex', gap: 20, marginTop: 'auto' }}>
						{[
							{ key: 'docs', label: 'Documentation', url: 'https://docs.rocketride.org' },
							{ key: 'discord', label: 'Discord', url: 'https://discord.gg/PMXrtenMsY' },
						].map(({ key, label, url }) => (
							<a
								key={key}
								href="#"
								style={{
									...styles.footerLink,
									color: hoveredLink === key ? 'var(--rr-text-link)' : 'var(--rr-text-secondary)',
									textDecoration: hoveredLink === key ? 'underline' : 'none',
								}}
								onMouseEnter={() => setHoveredLink(key)}
								onMouseLeave={() => setHoveredLink(null)}
								onClick={(e) => {
									e.preventDefault();
									sendMessage({ type: 'openExternal', url });
								}}
							>
								{label}
							</a>
						))}
					</div>
				</div>

				{/* RIGHT PANEL - Configuration */}
				<div style={styles.configPanel}>
					<h2 style={{ fontSize: 'var(--rr-font-size-h2)', fontWeight: 600, color: 'var(--rr-text-primary)', margin: '0 0 6px' }}>Get Started</h2>
					<div style={{ ...commonStyles.textMuted, fontSize: 12.5, marginBottom: 28 }}>Configure your connection to start building pipelines.</div>

					{/* Connection Config (dropdown + panel) */}
					<ConnectionConfig
						simplified
						idPrefix="welcome"
						group="development"
						serverCapabilities={serverCapabilities}
						onConnectionModeChange={handleConnectionModeChange}
						settings={settings}
						onSettingsChange={handleSettingsChange}
						cloudSignedIn={cloudSignedIn}
						cloudUserName={cloudUserName}
						onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' })}
						onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' })}
						onProbeCloudServer={handleProbeCloudServer}
						onFetchTeams={handleFetchTeams}
						isSaas={isSaasProbed}
						teams={teams}
						onClearCredentials={() => {
							setSettings((prev) => ({
								...prev,
								development: { ...prev.development, apiKey: '', hasApiKey: false },
							}));
						}}
						onTestConnection={handleTestConnection}
						testMessage={testMessage}
						engineVersions={engineVersions}
						engineVersionsLoading={engineVersionsLoading}
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

					{/* Agent integration */}
					<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, marginBottom: 4 }}>
						<input type="checkbox" id="autoAgentIntegration" checked={settings.autoAgentIntegration} style={{ width: 'auto', margin: 0 }} onChange={(e) => handleSettingsChange({ autoAgentIntegration: e.target.checked })} />
						<label htmlFor="autoAgentIntegration" style={{ fontWeight: 600, marginBottom: 0, fontSize: 13, color: 'var(--rr-text-primary)', cursor: 'pointer' }}>
							Automatic Agent Integration
						</label>
					</div>
					<div style={{ ...commonStyles.textMuted, marginTop: 4, lineHeight: 1.4, marginBottom: 20 }}>Automatically install RocketRide documentation for detected coding agents (Copilot, Claude Code, Cursor, Windsurf)</div>

					{/* General host messages — on-prem test results shown inline via testMessage in ConnectionConfig */}
					<MessageDisplay message={message} />

					{/* Action buttons */}
					<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
						<button style={commonStyles.buttonPrimary} onClick={handleSaveAndConnect}>
							Save &amp; Connect
						</button>
						<a
							href="#"
							style={{
								...styles.footerLink,
								color: hoveredLink === 'settings' ? 'var(--rr-text-link)' : 'var(--rr-text-secondary)',
								textDecoration: hoveredLink === 'settings' ? 'underline' : 'none',
							}}
							onMouseEnter={() => setHoveredLink('settings')}
							onMouseLeave={() => setHoveredLink(null)}
							onClick={(e) => {
								e.preventDefault();
								sendMessage({ type: 'openSettings' });
							}}
						>
							Advanced Settings
						</a>
					</div>
				</div>
			</div>
		</div>
	);
};
