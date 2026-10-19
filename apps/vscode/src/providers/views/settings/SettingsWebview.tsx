// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SettingsWebview — the Settings framework page as a shell bus realm.
 *
 * Configuration dashboard for the extension: connection settings with
 * cloud/local mode support, pipeline defaults, engine lifecycle, and
 * integrations. Everything the page needs from the host rides the bus:
 * settings via `host.settings.*`, staged cloud auth via `host.cloud.*`,
 * engine installs/status via `host.engine.*`, the server probe via
 * `host.server.probe`, and checkout via the brokered `client.billing.*`
 * ops. Results answer each call directly — there is no message switch, no
 * resolver table, and no echo-routing.
 *
 * NOTE (scope): the VS Code and cloud settings surfaces are intentionally
 * different UIs today — unifying them is a later sprint. This page migrated
 * MECHANICS only.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback, CSSProperties } from 'react';
import { ConnectionManager } from 'shell';
import { ConnectionSettings } from './ConnectionSettings';
import { PipelineSettings } from './PipelineSettings';
import { IntegrationSettings } from './IntegrationSettings';
import { DeploySettings } from './DeploySettings';
import { MessageDisplay } from './MessageDisplay';
import { commonStyles } from 'shell';
import type { CheckoutPlan } from 'shell';
import type { ViewMenu } from 'shell';
import { TabPanel } from 'shell';
import type { ITabPanelPanel } from 'shell';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';
import { PIPE_BUILDER_APP_ID } from '../../../shared/types';
import type { SettingsData as SharedSettingsData, SettingsConnectionMode, SettingsPayload, SettingsOpenArgs, CloudAuthStatus, EngineVersionItem as SharedEngineVersionItem, EngineVersionsPayload, EngineStatusPayload, EngineControlResult, EngineProgress, ServerProbeResult } from 'shared/ops/settingsOps';

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================
// The form's wire shapes are declared with the ops (shared/ops/settingsOps);
// they are re-exported here under their established names because the whole
// panel tree (ConnectionConfig, CloudPanel, ...) imports them from this
// module.

/** Available connection modes for dev/deploy targets. */
export type ConnectionMode = SettingsConnectionMode;

/** Root settings object persisted by the extension (the ops wire shape). */
export type SettingsData = SharedSettingsData;

/** A version entry returned from the GitHub releases API. */
export type EngineVersionItem = SharedEngineVersionItem;

const SETTINGS_TAB_IDS = ['development', 'deployment', 'pipeline', 'integrations'] as const;
type SettingsTabId = typeof SETTINGS_TAB_IDS[number];

function isSettingsTabId(value: unknown): value is SettingsTabId {
	return typeof value === 'string' && (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

/** Message displayed in the status banner (inline or global). */
export interface MessageData {
	level: 'success' | 'error' | 'info' | 'warning';
	message: string;
}

// ============================================================================
// SHARED STYLES — reused by ConnectionSettings, DeploySettings, and panels
// ============================================================================

export const settingsStyles = {
	// Card structure (from commonStyles)
	card: {
		...commonStyles.card,
		overflow: 'visible', // Allow child dropdowns (e.g., version picker) to extend beyond the card
	} as CSSProperties,
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
		overflow: 'visible', // Allow version dropdown to extend beyond the card boundary
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
	// Per-page header — names the page the user is on (matches the browser
	// settings page's section head). Sits at the top of each flat page body.
	pageHeader: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 8,
	} as CSSProperties,
	pageTitle: {
		margin: 0,
		fontSize: 17,
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	// Flat page column — stacks header, description, and controls with a uniform
	// gap (replaces the old card body now that pages are card-less).
	pageBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,
};

// ============================================================================
// PAGE BODY STYLE
// ============================================================================

/**
 * Fills the space to the right of the left settings nav; TabPanel's
 * 100%-height wrapper resolves against this definite flex box.
 */
const pageBodyStyle: CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	flex: 1,
	minWidth: 0,
	minHeight: 0,
};

// ============================================================================
// SETTINGS NAV STYLES — left-hand section menu (replaces the top pill strip)
// ============================================================================

/**
 * Left-hand settings navigation, matching the browser settings page
 * (shell SettingsProvider): a fixed-width rail of `listRow` pills, one per
 * section, with the page bodies rendered to its right. The pages themselves
 * are unchanged — only the section selector moved from a top strip to here.
 */
const settingsNavStyles = {
	// Horizontal split: fixed nav column on the left, page bodies on the right.
	body: {
		display: 'flex',
		flex: 1,
		minWidth: 0,
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,
	// Fixed-width nav rail with its own scroll and a right divider.
	sidebar: {
		width: 200,
		flexShrink: 0,
		borderRight: '1px solid var(--rr-border)',
		overflowY: 'auto',
		padding: '12px 8px',
		backgroundColor: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	// One nav row — the shared listRow pill plus the button reset + active weight.
	navItem: (active: boolean): CSSProperties => ({
		...commonStyles.listRow(active),
		width: '100%',
		margin: '1px 0',
		border: 'none',
		textAlign: 'left',
		fontWeight: active ? 600 : 400,
		fontFamily: 'var(--rr-font-family)',
	}),
};

// ============================================================================
// TITLE BAR STYLES — page title + one-line description at the very top
// ============================================================================

/**
 * Top-of-page title bar, mirroring the browser settings page's ContentHeader
 * (24px title + 14px muted subtitle). Fixed height above the nav/body split.
 */
const settingsHeaderStyles = {
	container: {
		flex: 'none',
		padding: '24px 24px 16px',
	} as CSSProperties,
	title: {
		margin: 0,
		fontSize: 24,
		fontWeight: 700,
		letterSpacing: '-0.01em',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	subtitle: {
		marginTop: 4,
		fontSize: 14,
		fontWeight: 400,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// ============================================================================
// FOOTER STYLES — Save/Cancel action row (mirrors DetailPanel's footer)
// ============================================================================

/**
 * Bottom action row, matching DetailPanel's footer: a top-divided, right-
 * aligned Save/Cancel pair. Rendered only while there are unsaved edits — the
 * settings surface is "always editing", so the footer is the change affordance.
 */
const settingsFooterStyles = {
	bar: {
		flex: 'none',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 8,
		padding: '12px 20px',
		borderTop: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
	cancel: { ...commonStyles.buttonSecondary } as CSSProperties,
	save: { ...commonStyles.buttonPrimary } as CSSProperties,
};

const authErrorBannerStyles = {
	container: {
		background: 'var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1))',
		borderBottom: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
		padding: '10px 16px',
	} as CSSProperties,
	content: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as CSSProperties,
	text: {
		fontSize: 13,
		color: 'var(--vscode-errorForeground, #f44336)',
		flex: 1,
	} as CSSProperties,
	dismiss: {
		background: 'none',
		border: 'none',
		color: 'var(--vscode-errorForeground, #f44336)',
		cursor: 'pointer',
		fontSize: 14,
		padding: '2px 6px',
		flexShrink: 0,
	} as CSSProperties,
};

// ============================================================================
// DEFAULT FORM STATE (pre-hydration)
// ============================================================================

const DEFAULT_SETTINGS: SettingsData = {
	development: {
		connectionMode: 'local',
		hostUrl: 'http://localhost:5565',
		useCustomServer: false,
		cloudUrl: '',
		defaultCloudUrl: '',
		hasApiKey: false,
		apiKey: '',
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
	// Must match package.json's rocketride.pipelineTraceLevel default.
	pipelineTraceLevel: 'full',
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

// ============================================================================
// MAIN SETTINGS VIEW COMPONENT
// ============================================================================

/**
 * Settings — the extension's configuration dashboard, served by the
 * page-frame bundle as a socketless bus realm.
 */
export const Settings: React.FC = () => {
	const cm = ConnectionManager.getInstance();
	const req = useCallback(<T,>(op: string, params?: unknown): Promise<T> => cm.request(op, (params ?? {}) as never) as Promise<T>, [cm]);

	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================

	const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
	const [message, setMessage] = useState<MessageData | null>(null);
	const [testMessage, setTestMessage] = useState<MessageData | null>(null);
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	// Per-group cloud probe results. `isSaas` keeps its LAST value while a
	// re-probe is in flight so the auth UI doesn't flicker away on every
	// keystroke in the URL field; undefined = never probed ("Checking...").
	// Each probe answers its own request — a per-group sequence drops a stale
	// result that lands after a newer probe was issued.
	const [devProbe, setDevProbe] = useState<{ isSaas?: boolean; unreachable: boolean }>({ unreachable: false });
	const [deployProbe, setDeployProbe] = useState<{ isSaas?: boolean; unreachable: boolean }>({ unreachable: false });
	const probeSeqRef = useRef<{ development: number; deployment: number }>({ development: 0, deployment: 0 });

	// Cloud auth state
	const [cloudSignedIn, setCloudSignedIn] = useState(false);
	// Subscription state — defaults to false so the subscribe button shows until the host confirms
	const [subscribed, setSubscribed] = useState(false);
	const [cloudUserName, setCloudUserName] = useState('');
	// The server the session's token was minted against — CloudPanel's
	// subscribe gate compares the form's target against it.
	const [cloudSignedInUrl, setCloudSignedInUrl] = useState('');
	// Last sign-in attempt came back waitlisted (auth fine, access queued) —
	// CloudPanel renders the friendly access-queue banner.
	const [cloudWaitlisted, setCloudWaitlisted] = useState(false);
	const [cloudWaitlistedName, setCloudWaitlistedName] = useState('');
	// Staged (uncommitted) cloud auth change — sign-in/sign-out from the Cloud
	// panel applies only on Save, so it participates in dirty tracking.
	const [cloudPending, setCloudPending] = useState<{ signIn: boolean; signOut: boolean; userName: string; url: string }>({ signIn: false, signOut: false, userName: '', url: '' });

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

	// Auth error banner — shown when the settings page opens due to an auth failure
	const [authError, setAuthError] = useState<string | null>(null);

	// Active settings tab
	const [activeTab, setActiveTab] = useState('development');

	// Dirty-state tracking — the footer Save/Cancel appear only when the user has edited something
	const [dirty, setDirty] = useState(false);
	const savedSettingsRef = useRef<SettingsData | null>(null);

	// Busy flags cross the push handlers' closures — refs keep them current.
	const dockerBusyRef = useRef(dockerBusy);
	dockerBusyRef.current = dockerBusy;
	const serviceBusyRef = useRef(serviceBusy);
	serviceBusyRef.current = serviceBusy;

	// ========================================================================
	// BUS WIRING — initial pulls + push handlers
	// ========================================================================

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

	const applySettingsPayload = useCallback((payload: SettingsPayload): void => {
		setSettings(payload.settings);
		// Deep-clone for cancel/reset so future edits don't mutate the snapshot
		savedSettingsRef.current = JSON.parse(JSON.stringify(payload.settings));
		setDirty(false);
		setSubscribed(payload.isSubscribed);
	}, []);

	const applyCloudStatus = useCallback((status: CloudAuthStatus): void => {
		setCloudSignedIn(status.signedIn);
		setCloudUserName(status.userName || '');
		setCloudSignedInUrl(status.signedInUrl || '');
		setCloudWaitlisted(Boolean(status.waitlisted));
		setCloudWaitlistedName(status.waitlistedName || '');
		setCloudPending({ signIn: status.pendingSignIn, signOut: status.pendingSignOut, userName: status.pendingUserName || '', url: status.pendingUrl || '' });
		// A staged auth change is an unsaved edit — surface the Save/Cancel
		// footer so the user can commit or revert it.
		if (status.pendingSignIn || status.pendingSignOut) setDirty(true);
	}, []);

	const applyOpenArgs = useCallback((args: SettingsOpenArgs): void => {
		if (isSettingsTabId(args.focus)) setActiveTab(args.focus);
		if (args.authError) setAuthError(args.authError);
	}, []);

	useEffect(() => {
		// Initial hydration: settings, cloud auth, engine status, open args,
		// and the version catalogs (host-cached, so the eager fetch is cheap).
		req<SettingsPayload>('host.settings.get').then(applySettingsPayload, () => {});
		req<CloudAuthStatus>('host.cloud.status').then(applyCloudStatus, () => {});
		req<EngineStatusPayload>('host.engine.status').then((p) => {
			setServiceStatus(p.service as ServiceStatus);
			setDockerStatus(p.docker as DockerStatus);
		}, () => {});
		req<SettingsOpenArgs>('host.settings.getOpenArgs').then(applyOpenArgs, () => {});
		fetchVersions();

		// Pushes from the host.
		const offs = [
			// Settings were saved (by any surface) — refresh to authoritative state.
			cm.handle('host.settings.changed', (p) => applySettingsPayload(p as SettingsPayload)),
			// The open command fired again while this page is live.
			cm.handle('host.settings.openArgs', (p) => applyOpenArgs(p as SettingsOpenArgs)),
			// Any cloud auth change (stored or staged).
			cm.handle('host.cloud.statusChanged', (p) => applyCloudStatus(p as CloudAuthStatus)),
			// The host's 3s poll — external state changes (NSSM, Docker Desktop).
			cm.handle('host.engine.statusChanged', (p) => {
				const payload = p as EngineStatusPayload;
				setServiceStatus(payload.service as ServiceStatus);
				setDockerStatus(payload.docker as DockerStatus);
				if (!serviceBusyRef.current) setServiceProgress(null);
				if (!dockerBusyRef.current) setDockerProgress(null);
			}),
			// Streamed install/update progress (replaces any previous error).
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

	// ========================================================================
	// EVENT HANDLERS
	// ========================================================================

	/**
	 * Save all settings. The host persists atomically, commits any staged
	 * cloud auth change, reconciles engines in the background, and broadcasts
	 * `host.settings.changed`; resolution is the success signal.
	 */
	const handleSaveSettings = (): void => {
		const snapshot = JSON.parse(JSON.stringify(settings)) as SettingsData;
		req<void>('host.settings.save', { settings: snapshot }).then(
			() => {
				savedSettingsRef.current = snapshot;
				setDirty(false);
				setMessage({ level: 'success', message: 'Settings saved successfully!' });
				setTimeout(() => setMessage(null), 5000);
			},
			(error: unknown) => setMessage({ level: 'error', message: `Failed to save settings: ${error instanceof Error ? error.message : String(error)}` })
		);
	};

	/** Revert to last-saved settings and clear dirty state — including any
	 *  staged cloud sign-in/sign-out held on the host side. */
	const handleCancelSettings = useCallback((): void => {
		if (savedSettingsRef.current) {
			setSettings(JSON.parse(JSON.stringify(savedSettingsRef.current)));
		}
		cm.emitOp('host.cloud.clearPending', {});
		setDirty(false);
	}, [cm]);

	/**
	 * Test connection via host.engine.control. On-prem passes hostUrl/apiKey
	 * as params; service/docker use their known defaults on the backend. The
	 * result answers this call directly.
	 */
	const handleTestConnection = (mode: string, params?: Record<string, unknown>): void => {
		setTestMessage(null);
		req<EngineControlResult>('host.engine.control', { mode, command: 'test', params }).then(
			(result) => {
				setTestMessage(result.success ? { level: 'success', message: 'Connection successful!' } : { level: 'error', message: result.error || 'Connection failed' });
				if (result.success) {
					// Clear the auth error banner on successful test connection
					setAuthError(null);
					setTimeout(() => setTestMessage(null), 5000);
				}
			},
			(error: unknown) => setTestMessage({ level: 'error', message: error instanceof Error ? error.message : String(error) })
		);
	};

	/**
	 * Probe a group's cloud target for SaaS compatibility. The previous
	 * result stays on screen until the fresh one arrives (no flicker); a
	 * stale result (an older probe resolving late) is dropped by sequence.
	 */
	const handleProbeCloudServer = (group: 'development' | 'deployment', cloudUrl: string): void => {
		const seq = ++probeSeqRef.current[group];
		const setProbe = group === 'development' ? setDevProbe : setDeployProbe;
		req<ServerProbeResult>('host.server.probe', { hostUrl: cloudUrl }).then(
			(info) => {
				if (probeSeqRef.current[group] !== seq) return;
				const unreachable = Boolean(info.unreachable);
				setProbe({ isSaas: unreachable ? undefined : (info.capabilities || []).includes('saas'), unreachable });
			},
			() => {
				if (probeSeqRef.current[group] !== seq) return;
				setProbe({ isSaas: undefined, unreachable: true });
			}
		);
	};

	/**
	 * Clear stored credentials
	 */
	const handleClearCredentials = (): void => {
		// Clear the API key from local state and ask the host to delete it
		setSettings((prev) => ({
			...prev,
			development: { ...prev.development, apiKey: '', hasApiKey: false },
		}));
		req<{ hasApiKey: boolean }>('host.settings.clearCredentials').then(
			(r) => {
				if (r.hasApiKey) setMessage({ level: 'error', message: 'API Key may not have been fully cleared - please try again' });
			},
			(error: unknown) => setMessage({ level: 'error', message: `Failed to clear API key: ${error instanceof Error ? error.message : String(error)}` })
		);
	};

	/**
	 * Merge partial changes into settings state.
	 *
	 * Deep-merges nested `development` and `deployment` groups so callers
	 * can pass e.g. `{ development: { connectionMode: 'cloud' } }` without
	 * losing other group fields. Also triggers side effects like version
	 * fetching when modes that need engine versions are selected.
	 */
	const handleSettingsChange = (changes: Partial<SettingsData>): void => {
		setDirty(true);
		// Clear stale test results when the user switches mode —
		// previous test output is no longer relevant to the new mode
		if (changes.development?.connectionMode || changes.deployment?.connectionMode) {
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

			// Side effects: refresh versions when switching to any mode that
			// needs them. The host caches results, so repeated calls are cheap.
			const devMode = changes.development?.connectionMode;
			const depMode = changes.deployment?.connectionMode;
			const needsVersions = ['local', 'service', 'docker'];
			if ((devMode && needsVersions.includes(devMode)) || (depMode && needsVersions.includes(depMode))) {
				fetchVersions();
			}

			return next;
		});
	};

	// ========================================================================
	// DOCKER / SERVICE VERSION OPTIONS
	// ========================================================================

	const dockerVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...dockerTags.filter((t) => t !== 'latest' && t !== 'prerelease').map((t) => ({ value: t, label: t }))];

	const serviceVersionOptions: VersionOption[] = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...engineVersions.map((v) => ({ value: v.tag_name, label: v.tag_name.replace(/^server-/, '') }))];

	// ========================================================================
	// DOCKER / SERVICE ACTION HANDLERS
	// ========================================================================

	// ── Sudo entry (Linux/macOS service lifecycle) ──────────────────────────
	// host.engine.control answers { needsSudo } when sudo would prompt; the
	// ServicePanel shows its in-panel password field and the parked command
	// is re-sent with params.sudoPassword on submit.
	const [sudoPromptVisible, setSudoPromptVisible] = useState(false);
	const [sudoPasswordInput, setSudoPasswordInput] = useState('');
	const pendingSudoRef = useRef<{ mode: 'docker' | 'service'; command: 'install' | 'update' | 'remove' | 'start' | 'stop'; params: Record<string, unknown> } | null>(null);

	/**
	 * Runs one docker/service control: sets the mode's busy/action state and
	 * requests `host.engine.control`. Progress streams in on
	 * `host.engine.progress`; the request's own result clears the busy state.
	 * A `needsSudo` answer parks the command and opens the sudo entry instead.
	 */
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

	/** Factory for the panels' zero-arg action callbacks — attaches the
	 *  selected version (for install/update) and runs the control. */
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

	// ========================================================================
	// TAB DEFINITIONS
	// ========================================================================

	// ViewMenu declaration — rendered as this view's left-hand section nav.
	const settingsMenu = useMemo<ViewMenu>(
		() => ({
			entries: [
				{ id: 'development', label: 'Development' },
				{ id: 'deployment', label: 'Deployment' },
				{ id: 'pipeline', label: 'Pipeline' },
				{ id: 'integrations', label: 'Integrations' },
			],
		}),
		[]
	);

	// ── Checkout callbacks (passed to CloudPanel) — brokered billing ops ────
	const handleFetchPlans = useCallback((): Promise<CheckoutPlan[]> => {
		return req<CheckoutPlan[]>('client.billing.getProductPrices', { appId: PIPE_BUILDER_APP_ID });
	}, [req]);

	const handleCreateCheckout = useCallback(
		(priceId: string): Promise<{ clientSecret: string; subscriptionId: string }> => {
			const orgId = cm.getAccountInfo()?.organization?.id;
			if (!orgId) return Promise.reject(new Error('No organisation found'));
			return req<{ clientSecret: string; subscriptionId: string }>('client.billing.createCheckoutSession', { orgId, appId: PIPE_BUILDER_APP_ID, priceId });
		},
		[cm, req]
	);

	const handleConfirmPending = useCallback(
		async (subscriptionId: string, priceId: string): Promise<void> => {
			await req('client.billing.confirmPending', { appId: PIPE_BUILDER_APP_ID, subscriptionId, priceId });
		},
		[req]
	);

	const handleCheckoutSuccess = useCallback(() => {
		setSubscribed(true);
	}, []);

	// ── Cloud auth actions — staged on the host, status arrives on the push.
	// Sign-in targets the form's CURRENT effective server — the saved config
	// lags until Save, and exchanging the OAuth code against the wrong server
	// mints the wrong session.
	const handleCloudSignIn = (group: 'development' | 'deployment'): void => {
		const g = settings[group];
		cm.emitOp('host.cloud.signIn', { cloudUrl: (g.useCustomServer && g.cloudUrl) || g.defaultCloudUrl });
	};
	const handleCloudSignOut = (): void => cm.emitOp('host.cloud.signOutStaged', {});
	const handleCloudUndoPending = (): void => cm.emitOp('host.cloud.clearPending', {});

	// ========================================================================
	// RENDER
	// ========================================================================

	const panels: Record<string, ITabPanelPanel> = useMemo(
		() => ({
			development: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<ConnectionSettings
							settings={settings}
							onSettingsChange={handleSettingsChange}
							onClearCredentials={handleClearCredentials}
							onTestConnection={handleTestConnection}
							testMessage={testMessage}
							engineVersions={engineVersions}
							engineVersionsLoading={engineVersionsLoading}
							cloudSignedIn={cloudSignedIn}
							cloudUserName={cloudUserName}
							cloudSignedInUrl={cloudSignedInUrl}
							cloudWaitlisted={cloudWaitlisted}
							cloudWaitlistedName={cloudWaitlistedName}
							onCloudSignIn={() => handleCloudSignIn('development')}
							onCloudSignOut={handleCloudSignOut}
							cloudPending={cloudPending}
							onCloudUndoPending={handleCloudUndoPending}
							onProbeCloudServer={(url) => handleProbeCloudServer('development', url)}
							isSaas={devProbe.isSaas}
							probeUnreachable={devProbe.unreachable}
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
							isSubscribed={subscribed}
							onFetchPlans={handleFetchPlans}
							onCreateCheckout={handleCreateCheckout}
							onConfirmPending={handleConfirmPending}
							onCheckoutSuccess={handleCheckoutSuccess}
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
							engineVersions={engineVersions}
							engineVersionsLoading={engineVersionsLoading}
							onClearCredentials={handleClearCredentials}
							onTestConnection={handleTestConnection}
							testMessage={testMessage}
							cloudSignedIn={cloudSignedIn}
							cloudUserName={cloudUserName}
							cloudSignedInUrl={cloudSignedInUrl}
							cloudWaitlisted={cloudWaitlisted}
							cloudWaitlistedName={cloudWaitlistedName}
							onCloudSignIn={() => handleCloudSignIn('deployment')}
							onCloudSignOut={handleCloudSignOut}
							cloudPending={cloudPending}
							onCloudUndoPending={handleCloudUndoPending}
							onProbeCloudServer={(url) => handleProbeCloudServer('deployment', url)}
							isSaas={deployProbe.isSaas}
							probeUnreachable={deployProbe.unreachable}
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
							isSubscribed={subscribed}
							onFetchPlans={handleFetchPlans}
							onCreateCheckout={handleCreateCheckout}
							onConfirmPending={handleConfirmPending}
							onCheckoutSuccess={handleCheckoutSuccess}
						/>
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
			integrations: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<IntegrationSettings settings={settings} onSettingsChange={handleSettingsChange} />
					</div>
				),
			},
		}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[settings, message, testMessage, engineVersions, engineVersionsLoading, devProbe, deployProbe, cloudSignedIn, cloudUserName, cloudSignedInUrl, cloudWaitlisted, cloudWaitlistedName, cloudPending, subscribed, dockerStatus, dockerProgress, dockerError, dockerBusy, dockerAction, dockerSelectedVersion, serviceStatus, serviceProgress, serviceError, serviceBusy, serviceAction, serviceSelectedVersion, dockerTags, sudoPromptVisible, sudoPasswordInput]
	);

	return (
		<div style={commonStyles.columnFill}>
			{/* ── Title bar — names the page + one-line description ── */}
			<div style={settingsHeaderStyles.container}>
				<h1 style={settingsHeaderStyles.title}>Settings</h1>
				<div style={settingsHeaderStyles.subtitle}>Configure connections, pipelines, and integrations for the RocketRide extension.</div>
			</div>

			{/* ── Auth error banner (shown when opened due to auth failure) ── */}
			{authError && (
				<div style={authErrorBannerStyles.container}>
					<div style={authErrorBannerStyles.content}>
						<span style={{ fontSize: 18 }}>&#9888;</span>
						<span style={authErrorBannerStyles.text}>{authError}</span>
						<button style={authErrorBannerStyles.dismiss} onClick={() => setAuthError(null)} title="Dismiss">
							&#10005;
						</button>
					</div>
				</div>
			)}
			{/* ── Body: left section nav (was the top pill strip) + page bodies ── */}
			<div style={settingsNavStyles.body}>
				{/* Left nav — one pill per settings section, driving the same activeTab. */}
				<nav style={settingsNavStyles.sidebar} role="tablist" aria-orientation="vertical">
					{settingsMenu.entries.map((entry) => {
						// The selected section is highlighted and rendered by TabPanel.
						const isActive = entry.id === activeTab;
						return (
							<button key={entry.id} role="tab" aria-selected={isActive} style={settingsNavStyles.navItem(isActive)} onClick={() => setActiveTab(entry.id)}>
								{entry.label}
							</button>
						);
					})}
				</nav>

				{/* Page bodies fill the space to the right of the nav. */}
				<div style={pageBodyStyle}>
					<TabPanel panels={panels} activeId={activeTab} />
				</div>
			</div>

			{/* ── Footer — Save/Cancel appear once there are unsaved edits (DetailPanel pattern) ── */}
			{dirty && (
				<div style={settingsFooterStyles.bar}>
					<button style={settingsFooterStyles.cancel} onClick={handleCancelSettings}>
						Cancel
					</button>
					<button style={settingsFooterStyles.save} onClick={handleSaveSettings}>
						Save
					</button>
				</div>
			)}
		</div>
	);
};

export default Settings;
