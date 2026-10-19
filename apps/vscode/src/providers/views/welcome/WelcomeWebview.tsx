// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * WelcomeWebview — first-run onboarding as a shell bus realm.
 *
 * Presents a branded split-panel layout: branding/features on the left,
 * simplified connection configuration on the right. Uses the same
 * ConnectionConfig component as the full Settings page but in `simplified`
 * mode (fewer fields, single "Save & Connect" action).
 *
 * Everything host-side rides the bus: settings via `host.settings.*`
 * (`save` with `connect: true` is the Save & Connect — the host initializes
 * connections and reconciles engines before resolving, and this page then
 * retires itself via `host.closePage`), staged cloud auth via `host.cloud.*`,
 * engine lifecycle via `host.engine.*`, and the server probe via
 * `host.server.probe`. The logos ship in the bundle — no branding payload.
 */

import React, { useState, useEffect, useRef, useCallback, CSSProperties } from 'react';
import { ConnectionManager } from 'shell';
import { useTheme } from '../hooks/useTheme';
import { commonStyles } from 'shell';
import { ConnectionConfig } from '../components/ConnectionConfig';
import { MessageDisplay } from '../settings/MessageDisplay';
import type { SettingsData, ConnectionMode, EngineVersionItem, MessageData } from '../settings/SettingsWebview';
import type { SettingsPayload, CloudAuthStatus, EngineVersionsPayload, EngineStatusPayload, EngineControlResult, EngineProgress, ServerProbeResult } from 'shared/ops/settingsOps';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';
import logoDark from '../../../../rocketride-dark-icon.png';
import logoLight from '../../../../rocketride-light-icon.png';

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

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
		useCustomServer: false,
		cloudUrl: '',
		defaultCloudUrl: '',
		apiKey: '',
		hasApiKey: false,
		local: { engineVersion: 'latest' },
	},
	deployment: {
		connectionMode: null,
		hostUrl: '',
		useCustomServer: false,
		cloudUrl: '',
		defaultCloudUrl: '',
		hasApiKey: false,
		apiKey: '',
		local: { engineVersion: 'latest' },
	},
	defaultPipelinePath: 'pipelines',
	pipelineRestartBehavior: 'prompt',
	pipelineTtl: 900,
	pipelineTraceLevel: 'summary',
	taskArguments: '',
	pipelineDebugOutput: false,
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
	const cm = ConnectionManager.getInstance();
	const req = useCallback(<T,>(op: string, params?: unknown): Promise<T> => cm.request(op, (params ?? {}) as never) as Promise<T>, [cm]);

	// Settings state
	const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);

	// Messages
	const [message, setMessage] = useState<MessageData | null>(null);
	const [testMessage, setTestMessage] = useState<MessageData | null>(null);

	// Engine versions
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);
	const [dockerTags, setDockerTags] = useState<string[]>([]);

	// Cloud probe result — `isSaas` keeps its last value during a re-probe
	// (no flicker); undefined = never probed ("Checking...").
	const [probe, setProbe] = useState<{ isSaas?: boolean; unreachable: boolean }>({ unreachable: false });
	const probeSeqRef = useRef(0);

	// Cloud auth
	const [cloudSignedIn, setCloudSignedIn] = useState(false);
	const [cloudUserName, setCloudUserName] = useState('');
	const [cloudSignedInUrl, setCloudSignedInUrl] = useState('');
	const [cloudWaitlisted, setCloudWaitlisted] = useState(false);
	const [cloudWaitlistedName, setCloudWaitlistedName] = useState('');
	// Staged (uncommitted) cloud auth change — applies on Save & Connect.
	const [cloudPending, setCloudPending] = useState<{ signIn: boolean; signOut: boolean; userName: string; url: string }>({ signIn: false, signOut: false, userName: '', url: '' });

	// Docker state
	const [dockerStatus, setDockerStatus] = useState<DockerStatus>({ state: 'not-installed', version: null, publishedAt: null, imageTag: null });
	const [dockerProgress, setDockerProgress] = useState<string | null>(null);
	const [dockerError, setDockerError] = useState<string | null>(null);
	const [dockerBusy, setDockerBusy] = useState(false);
	const [dockerAction, setDockerAction] = useState<'install' | 'update' | 'remove' | 'start' | 'stop' | null>(null);
	const [dockerSelectedVersion, setDockerSelectedVersion] = useState('latest');

	// Service state
	const [serviceStatus, setServiceStatus] = useState<ServiceStatus>({ state: 'not-installed', version: null, publishedAt: null, installPath: null });
	const [serviceProgress, setServiceProgress] = useState<string | null>(null);
	const [serviceError, setServiceError] = useState<string | null>(null);
	const [serviceBusy, setServiceBusy] = useState(false);
	const [serviceAction, setServiceAction] = useState<'install' | 'update' | 'remove' | 'start' | 'stop' | null>(null);
	const [serviceSelectedVersion, setServiceSelectedVersion] = useState('latest');

	// Hover state
	const [hoveredLink, setHoveredLink] = useState<string | null>(null);

	// Busy flags cross the push handlers' closures — refs keep them current.
	const dockerBusyRef = useRef(dockerBusy);
	dockerBusyRef.current = dockerBusy;
	const serviceBusyRef = useRef(serviceBusy);
	serviceBusyRef.current = serviceBusy;

	// =========================================================================
	// BUS WIRING — initial pulls + push handlers
	// =========================================================================

	const fetchVersions = useCallback((): void => {
		setEngineVersionsLoading(true);
		req<EngineVersionsPayload>('host.engine.versions').then(
			(v) => {
				setEngineVersions(v.releases);
				setDockerTags(v.dockerTags);
				setEngineVersionsLoading(false);
			},
			() => setEngineVersionsLoading(false)
		);
	}, [req]);

	const applyCloudStatus = useCallback((status: CloudAuthStatus): void => {
		setCloudSignedIn(status.signedIn);
		setCloudUserName(status.userName || '');
		setCloudSignedInUrl(status.signedInUrl || '');
		setCloudWaitlisted(Boolean(status.waitlisted));
		setCloudWaitlistedName(status.waitlistedName || '');
		setCloudPending({ signIn: status.pendingSignIn, signOut: status.pendingSignOut, userName: status.pendingUserName || '', url: status.pendingUrl || '' });
	}, []);

	useEffect(() => {
		req<SettingsPayload>('host.settings.get').then((payload) => {
			setSettings(payload.settings);
			if (payload.settings.development.connectionMode === 'local') fetchVersions();
		}, () => {});
		req<CloudAuthStatus>('host.cloud.status').then(applyCloudStatus, () => {});
		req<EngineStatusPayload>('host.engine.status').then((p) => {
			setServiceStatus(p.service as ServiceStatus);
			setDockerStatus(p.docker as DockerStatus);
		}, () => {});

		const offs = [
			cm.handle('host.cloud.statusChanged', (p) => applyCloudStatus(p as CloudAuthStatus)),
			cm.handle('host.engine.statusChanged', (p) => {
				const payload = p as EngineStatusPayload;
				setServiceStatus(payload.service as ServiceStatus);
				setDockerStatus(payload.docker as DockerStatus);
				if (!serviceBusyRef.current) setServiceProgress(null);
				if (!dockerBusyRef.current) setDockerProgress(null);
			}),
			cm.handle('host.engine.progress', (p) => {
				const { mode, message: progressMsg } = p as EngineProgress;
				if (mode === 'service') {
					setServiceProgress(progressMsg);
					setServiceError(null);
				} else if (mode === 'docker') {
					setDockerProgress(progressMsg);
					setDockerError(null);
				}
			}),
		];
		return () => offs.forEach((off) => off());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

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
				fetchVersions();
			}
			if (devMode === 'cloud' && prev.development.connectionMode !== 'cloud') {
				req<CloudAuthStatus>('host.cloud.status').then(applyCloudStatus, () => {});
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

	/**
	 * Save & Connect: the host persists the form, commits any staged cloud
	 * auth, initializes connections, and reconciles engines before resolving
	 * — then this page retires itself.
	 */
	const handleSaveAndConnect = () => {
		req<void>('host.settings.save', { settings, connect: true }).then(
			() => cm.emitOp('host.closePage', { page: 'welcome' }),
			(error: unknown) => setMessage({ level: 'error', message: `Failed to save settings: ${error instanceof Error ? error.message : String(error)}` })
		);
	};

	const handleProbeCloudServer = (cloudUrl: string) => {
		// The previous result stays on screen until the fresh one arrives; a
		// stale result (an older probe resolving late) is dropped by sequence.
		const seq = ++probeSeqRef.current;
		req<ServerProbeResult>('host.server.probe', { hostUrl: cloudUrl }).then(
			(info) => {
				if (probeSeqRef.current !== seq) return;
				const unreachable = Boolean(info.unreachable);
				setProbe({ isSaas: unreachable ? undefined : (info.capabilities || []).includes('saas'), unreachable });
			},
			() => {
				if (probeSeqRef.current !== seq) return;
				setProbe({ isSaas: undefined, unreachable: true });
			}
		);
	};

	/**
	 * Test connection via host.engine.control. On-prem passes hostUrl/apiKey
	 * as params; docker/service use backend defaults.
	 */
	const handleTestConnection = (mode: string, params?: Record<string, unknown>) => {
		setTestMessage(null);
		req<EngineControlResult>('host.engine.control', { mode, command: 'test', params }).then(
			(result) => {
				setTestMessage(result.success ? { level: 'success', message: 'Connection successful!' } : { level: 'error', message: result.error || 'Connection failed' });
				if (result.success) setTimeout(() => setTestMessage(null), 5000);
			},
			(error: unknown) => setTestMessage({ level: 'error', message: error instanceof Error ? error.message : String(error) })
		);
	};

	/**
	 * Factory for docker/service lifecycle actions.
	 * Sets busy/action state, attaches the selected version for install/update,
	 * and requests host.engine.control. Progress streams in on the push; the
	 * request's own result clears busy state.
	 */
	// Sudo entry (Linux/macOS service lifecycle) — host.engine.control answers
	// { needsSudo } when sudo would prompt; the ServicePanel shows its
	// in-panel password field and the parked command is re-sent with
	// params.sudoPassword on submit.
	const [sudoPromptVisible, setSudoPromptVisible] = useState(false);
	const [sudoPasswordInput, setSudoPasswordInput] = useState('');
	const pendingSudoRef = useRef<{ mode: 'docker' | 'service'; command: 'install' | 'update' | 'remove' | 'start' | 'stop'; params: Record<string, unknown> } | null>(null);

	const runEngineControl = (mode: 'docker' | 'service', actionType: 'install' | 'update' | 'remove' | 'start' | 'stop', params: Record<string, unknown>): void => {
		const setBusy = mode === 'docker' ? setDockerBusy : setServiceBusy;
		const setAction = mode === 'docker' ? setDockerAction : setServiceAction;
		const setError = mode === 'docker' ? setDockerError : setServiceError;
		const setProgress = mode === 'docker' ? setDockerProgress : setServiceProgress;

		setBusy(true);
		setAction(actionType);
		setError(null);

		const finish = (error?: string): void => {
			setBusy(false);
			setAction(null);
			setProgress(null);
			if (error) setError(error);
		};
		req<EngineControlResult>('host.engine.control', { mode, command: actionType, params }).then(
			(result) => {
				if (result.needsSudo) {
					pendingSudoRef.current = { mode, command: actionType, params };
					setSudoPromptVisible(true);
					finish();
					return;
				}
				finish(result.success ? undefined : result.error || 'Operation failed');
			},
			(error: unknown) => finish(error instanceof Error ? error.message : String(error))
		);
	};

	const makeEngineHandler = (mode: 'docker' | 'service', actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => () => {
		const selectedVersion = mode === 'docker' ? dockerSelectedVersion : serviceSelectedVersion;
		const params: Record<string, unknown> = {};
		if (actionType === 'install' || actionType === 'update') {
			params.version = selectedVersion;
		}
		runEngineControl(mode, actionType, params);
	};

	/** The sudo entry's Continue — re-sends the parked command with the password. */
	const handleSudoSubmit = (): void => {
		const pending = pendingSudoRef.current;
		const password = sudoPasswordInput;
		pendingSudoRef.current = null;
		setSudoPasswordInput('');
		setSudoPromptVisible(false);
		if (!pending) return;
		runEngineControl(pending.mode, pending.command, { ...pending.params, sudoPassword: password });
	};

	const makeDockerHandler = (actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => makeEngineHandler('docker', actionType);
	const makeServiceHandler = (actionType: 'install' | 'update' | 'remove' | 'start' | 'stop') => makeEngineHandler('service', actionType);

	const dockerVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...dockerTags.filter((t) => t !== 'latest' && t !== 'prerelease').map((t) => ({ value: t, label: t }))];

	const serviceVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...engineVersions.map((v) => ({ value: v.tag_name, label: v.tag_name.replace(/^server-/, '') }))];

	// Logos ship in the bundle — pick by theme (light logo on dark surfaces).
	const logoUri = theme === 'dark' ? logoLight : logoDark;

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
						{['Visual pipeline editor', 'High-performance C++ engine', '100+ pipeline nodes with AI/ML', 'Multi-agent workflows', 'Tool and model agnostic', 'TypeScript, Python & MCP SDKs'].map((feat) => (
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
									cm.emitOp('host.openExternal', { url });
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
						onConnectionModeChange={handleConnectionModeChange}
						settings={settings}
						onSettingsChange={handleSettingsChange}
						cloudSignedIn={cloudSignedIn}
						cloudUserName={cloudUserName}
						cloudSignedInUrl={cloudSignedInUrl}
						cloudWaitlisted={cloudWaitlisted}
						cloudWaitlistedName={cloudWaitlistedName}
						// Sign-in targets the form's CURRENT effective server, same as
						// the Settings page — the simplified panel exposes no custom
						// server UI, so this is normally the default cloud.
						onCloudSignIn={() => cm.emitOp('host.cloud.signIn', { cloudUrl: (settings.development.useCustomServer && settings.development.cloudUrl) || settings.development.defaultCloudUrl })}
						onCloudSignOut={() => cm.emitOp('host.cloud.signOutStaged', {})}
						cloudPending={cloudPending}
						onCloudUndoPending={() => cm.emitOp('host.cloud.clearPending', {})}
						onProbeCloudServer={handleProbeCloudServer}
						isSaas={probe.isSaas}
						probeUnreachable={probe.unreachable}
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
								// Hand off to the full Settings page and retire this one.
								cm.emitOp('host.openPage', { page: 'settings' });
								cm.emitOp('host.closePage', { page: 'welcome' });
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

export default Welcome;
