// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AuthWebview — authentication recovery page.
 *
 * Shown when a connection attempt fails with an AuthenticationException.
 * Uses ConnectionConfig with authOnly={true} to render the appropriate
 * credential form based on the failing connection's mode and group.
 */

import React, { useState, CSSProperties } from 'react';
import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';
import { useMessaging } from '../hooks/useMessaging';
import { ConnectionConfig } from '../components/ConnectionConfig';
import { settingsStyles as S } from '../Settings/SettingsWebview';
import type { SettingsData, ConnectionMode, ConnectionGroupSettings } from '../Settings/SettingsWebview';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		maxWidth: 560,
		margin: '40px auto',
		padding: '0 24px',
		display: 'flex',
		flexDirection: 'column',
		gap: 24,
	} as CSSProperties,
	errorBanner: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '12px 16px',
		borderRadius: 6,
		backgroundColor: 'var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1))',
		border: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
		color: 'var(--vscode-errorForeground, #f44336)',
		fontSize: 13,
	} as CSSProperties,
	title: {
		fontSize: 20,
		fontWeight: 600,
		margin: 0,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	saveButton: {
		width: 'auto',
		padding: '10px 24px',
		fontWeight: 600,
		alignSelf: 'flex-start',
	} as CSSProperties,
};

// =============================================================================
// DEFAULT GROUP SETTINGS
// =============================================================================

const DEFAULT_GROUP: ConnectionGroupSettings = {
	connectionMode: 'local',
	hostUrl: '',
	hasApiKey: false,
	apiKey: '',
	teamId: '',
	local: { engineVersion: 'latest', debugOutput: false, engineArgs: '' },
};

// =============================================================================
// COMPONENT
// =============================================================================

export const Auth: React.FC = () => {
	// ── State ────────────────────────────────────────────────────────────────
	const [group, setGroup] = useState<'development' | 'deployment'>('development');
	const [errorMessage, setErrorMessage] = useState<string>('Authentication failed');
	const [settings, setSettings] = useState<SettingsData>({
		development: { ...DEFAULT_GROUP },
		deployment: { ...DEFAULT_GROUP, connectionMode: null },
		defaultPipelinePath: 'pipelines',
		pipelineRestartBehavior: 'prompt',
		envVars: {},
		voiceBuilder: {
			enabled: false,
			plannerBaseUrl: 'https://api.openai.com/v1',
			plannerModel: 'gpt-4o-mini',
			hasDeepgramApiKey: false,
			deepgramApiKey: '',
			hasPlannerApiKey: false,
			plannerApiKey: '',
		},
		autoAgentIntegration: true,
		integrationCopilot: false,
		integrationClaudeCode: false,
		integrationCursor: false,
		integrationWindsurf: false,
		integrationClaudeMd: false,
		integrationAgentsMd: false,
	});

	// Cloud auth state
	const [cloudSignedIn, setCloudSignedIn] = useState(false);
	const [cloudUserName, setCloudUserName] = useState('');
	const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);

	// ── Messaging ────────────────────────────────────────────────────────────
	const { sendMessage } = useMessaging<Record<string, unknown>, Record<string, unknown>>({
		onMessage: (message) => {
			switch (message.type as string) {
				case 'init':
					if (message.group) setGroup(message.group as 'development' | 'deployment');
					if (message.connectionMode) {
						const g = (message.group as 'development' | 'deployment') || group;
						setSettings((prev) => ({
							...prev,
							[g]: {
								...prev[g],
								connectionMode: message.connectionMode as ConnectionMode,
								hostUrl: (message.hostUrl as string) || prev[g].hostUrl,
								apiKey: (message.apiKey as string) || prev[g].apiKey,
								hasApiKey: !!message.apiKey,
							},
						}));
					}
					if (message.errorMessage) setErrorMessage(message.errorMessage as string);
					break;

				case 'cloud:status':
					setCloudSignedIn((message.signedIn as boolean) ?? false);
					setCloudUserName((message.userName as string) ?? '');
					break;

				case 'teamsLoaded':
					setTeams((message.teams as Array<{ id: string; name: string }>) ?? []);
					break;
			}
		},
	});

	// ── Handlers ─────────────────────────────────────────────────────────────

	const handleSettingsChange = (changes: Partial<SettingsData>) => {
		setSettings((prev) => {
			const next = { ...prev };
			if (changes.development) {
				next.development = { ...prev.development, ...changes.development };
				if (changes.development.local) {
					next.development.local = { ...prev.development.local, ...changes.development.local };
				}
			}
			if (changes.deployment) {
				next.deployment = { ...prev.deployment, ...changes.deployment };
				if (changes.deployment.local) {
					next.deployment.local = { ...prev.deployment.local, ...changes.deployment.local };
				}
			}
			const { development, deployment, ...topLevel } = changes;
			Object.assign(next, topLevel);
			return next;
		});
	};

	/** Save credentials and trigger reconnect. */
	const handleSave = () => {
		const gc = settings[group];
		sendMessage({ type: 'saveCredentials', group, apiKey: gc.apiKey, hostUrl: gc.hostUrl });
	};

	const groupLabel = group === 'development' ? 'Development' : 'Deployment';
	const connectionMode = settings[group].connectionMode;

	// ── Render ───────────────────────────────────────────────────────────────
	return (
		<div style={styles.container}>
			<h2 style={styles.title}>{groupLabel}: Authentication Required</h2>

			<div style={styles.errorBanner}>
				<span style={{ fontSize: 18 }}>&#9888;</span>
				<span>{errorMessage}</span>
			</div>

			{/* Auth-only panel for the failing connection */}
			{connectionMode === 'local' ? (
				<div style={{ ...S.modeConfigBox, padding: 20 }}>
					<div style={S.sectionDescription}>Local mode authentication failed unexpectedly. Try restarting the local engine or check the Output panel (RocketRide: Extension) for details.</div>
				</div>
			) : (
				<>
					<ConnectionConfig
						simplified={false}
						authOnly
						idPrefix="auth"
						group={group}
						serverCapabilities={[]}
						onConnectionModeChange={() => {}}
						settings={settings}
						onSettingsChange={handleSettingsChange}
						cloudSignedIn={cloudSignedIn}
						cloudUserName={cloudUserName}
						onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' })}
						onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' })}
						teams={teams}
						onClearCredentials={() => {
							handleSettingsChange({ [group]: { apiKey: '', hasApiKey: false } } as Partial<SettingsData>);
						}}
						onTestConnection={() => {}}
						testMessage={null}
						engineVersions={[]}
						engineVersionsLoading={false}
						dockerStatus={{ state: 'not-installed', version: null, publishedAt: null, imageTag: null }}
						dockerProgress={null}
						dockerError={null}
						dockerBusy={false}
						dockerAction={null}
						dockerVersions={[]}
						dockerSelectedVersion="latest"
						onDockerVersionChange={() => {}}
						onDockerInstall={() => {}}
						onDockerUpdate={() => {}}
						onDockerRemove={() => {}}
						onDockerStart={() => {}}
						onDockerStop={() => {}}
						serviceStatus={{ state: 'not-installed', version: null, publishedAt: null, installPath: null }}
						serviceProgress={null}
						serviceError={null}
						serviceBusy={false}
						serviceAction={null}
						serviceVersions={[]}
						serviceSelectedVersion="latest"
						onServiceVersionChange={() => {}}
						onServiceInstall={() => {}}
						onServiceUpdate={() => {}}
						onServiceRemove={() => {}}
						onServiceStart={() => {}}
						onServiceStop={() => {}}
						sudoPromptVisible={false}
						sudoPasswordInput=""
						onSudoPasswordChange={() => {}}
						onSudoSubmit={() => {}}
					/>

					<button type="button" onClick={handleSave} style={styles.saveButton}>
						Save &amp; Connect
					</button>
				</>
			)}
		</div>
	);
};
