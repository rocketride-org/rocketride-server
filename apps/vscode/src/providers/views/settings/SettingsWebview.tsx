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
import { ConnectionManager, SettingsPage, buildSettingsRegistry, registerSettings, getSettingsContributions, onSettingsContributionsChanged, AccountProvider, CheckoutFlow, createMirroredPrefsStore, useGridConfigAnswering } from 'shell';
import type { SettingsRichSection, ISettingsRichContext, AppManifestEntry } from 'shell';
import { SHELL_PARTITION } from 'shell/src/workspace/workspaceStore';
import { CheckoutUnavailableNotice } from '../components/CheckoutUnavailableNotice';
import type { StripeKeyReason } from 'shared/ops/hostOps';
import type { ConnectResult } from 'rocketride';
import { ConnectionSettings } from './ConnectionSettings';
import { DeploySettings } from './DeploySettings';
import { MessageDisplay } from './MessageDisplay';
import { commonStyles } from 'shell';
import type { CheckoutPlan } from 'shell';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';
import { PIPE_BUILDER_APP_ID } from '../../../shared/types';
import { TOOL_SETTINGS_CONTRIBUTIONS } from 'shared/tools/toolSettings';
import { INTEGRATIONS_SETTINGS, INTEGRATIONS_APP_ID } from '../../../shared/integrationsSettings';
import { useMirroredWorkspaceSettings } from './settingsMirror';
import { EnvironmentSection } from './EnvironmentSection';
import type { EnvSlotsPayload } from 'shared/ops/hostOps';
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

// ============================================================================
// SETTINGS CONTRIBUTIONS — this realm's registered sections
// ============================================================================
// The settings realm registers what IT serves, like every realm: the builtin
// tools' sections ride the shared leaf (the SAME rows the cloud derives from
// the manifests — same ids, same Rocket Builder group, same product storage
// partition), and the Integrations section is the VS Code host's own block
// (workspace-scoped; deltas in `vscode.integrations.workspace.json`). Module
// scope, never unregistered — builtins' machinery is resident for the host's
// lifetime.
// NOTE: pinned STORE tools do not contribute here yet — their manifests live
// in other realms; a cross-realm contribution feed is a follow-up.
for (const contribution of TOOL_SETTINGS_CONTRIBUTIONS) registerSettings(contribution);
registerSettings({
	appId: INTEGRATIONS_APP_ID,
	name: 'Integrations',
	shells: ['vscode'],
	// Nav order (product rule): Account 10, Environment Variables 20,
	// Integrations 30, Connections 40, every other category 100.
	order: 30,
	configuration: INTEGRATIONS_SETTINGS,
});

/** Rich-section nav group: the two connection pages fold under one parent. */
const CONNECTIONS_GROUP = { id: 'connections', label: 'Connections' };

/** Env nav group — used only when dev and deploy have DISTINCT connections
 *  (the nav is the server selector; shared mode renders one flat entry). */
const ENVIRONMENT_GROUP = { id: 'environment-group', label: 'Environment Variables' };

/** The Account group's nav identity (Profile / Billing / API Keys children). */
const ACCOUNT_GROUP = { id: 'account', label: 'Account' };

/** The one subscribable app this host offers (the identity the old Account
 *  page hardcoded into its CheckoutModal). */
const PIPE_BUILDER_APP = {
	id: 'rocketride.pipeBuilder',
	name: 'Pipe Builder',
	description: 'Visual AI pipeline editor: run and deploy pipelines on RocketRide Cloud.',
};

/** Legacy open-args focus ids → the new nav section ids. The development
 *  slot's env section always carries the id 'environment', so the env deep
 *  link is static regardless of shared/split mode. */
const FOCUS_TO_SECTION: Record<string, string> = {
	development: 'host:development',
	deployment: 'host:deployment',
	pipeline: 'builtin.pipelines',
	integrations: 'vscode.integrations',
	environment: 'environment',
	account: 'account:profile',
	'account:profile': 'account:profile',
	'account:billing': 'account:billing',
	'account:keys': 'account:keys',
};

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
// FOOTER STYLES — Save/Cancel action row (mirrors DetailPanel's footer)
// ============================================================================

/**
 * Connection-pane action row: a top-divided, right-aligned Save & Reconnect /
 * Cancel pair, rendered at the end of each Connections rich section while the
 * connection blob has unsaved edits (rich sections own their footers — the
 * schema sections' Save/Cancel is SettingsPage's own).
 */
const settingsFooterStyles = {
	bar: {
		flex: 'none',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 8,
		padding: '12px 0 0',
		marginTop: 16,
		borderTop: '1px solid var(--rr-border)',
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

	// Deep-link target — the nav section the page opens (or re-focuses) on.
	// SettingsPage follows changes live, so a re-fired open command retargets
	// the nav without a remount (an unsaved draft survives).
	const [initialSection, setInitialSection] = useState<string | undefined>(undefined);

	// The pre-run env gate's missing keys (from the open args) — seeded as
	// empty required rows in the DEVELOPMENT env section's user scope.
	const [envPrefill, setEnvPrefill] = useState<string[]>([]);

	// Env connection slots (shared vs distinct + per-slot state) — drives how
	// many Environment Variables sections the nav shows.
	const [envSlots, setEnvSlots] = useState<EnvSlotsPayload | null>(null);
	useEffect(() => {
		const off = cm.handle('host.envSlotsChanged', (p) => setEnvSlots(p as EnvSlotsPayload));
		void cm.request('host.envSlots', {}).then(
			(p) => setEnvSlots(p as EnvSlotsPayload),
			() => { /* host not ready — the first push will seed us */ }
		);
		return off;
	}, [cm]);

	// ── Account group plumbing (the old Account page's host seams) ──────────
	// Mirrored prefs (SHELL partition) answer DataGrid layout persistence for
	// the billing dashboard and member grids, exactly as the old page did.
	const gridPrefs = useMemo(() => createMirroredPrefsStore(cm, SHELL_PARTITION), [cm]);
	useGridConfigAnswering(gridPrefs.store);
	useEffect(() => gridPrefs.dispose, [gridPrefs]);

	// The Stripe publishable key (host-probed; matches the CONNECTED server).
	const [stripe, setStripe] = useState<{ key: string | null; reason?: StripeKeyReason } | null>(null);
	useEffect(() => {
		void cm.request('host.stripeKey', {}).then(
			(r) => setStripe(r as { key: string | null; reason?: StripeKeyReason }),
			() => setStripe({ key: null, reason: 'probe-failed' })
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Mirrored account info — gates the Account group (no account, no group).
	const [account, setAccount] = useState<ConnectResult | null>(() => (cm.getAccountInfo() as ConnectResult | undefined) ?? null);
	useEffect(() => cm.on('shell:accountUpdate', (data) => setAccount(data as ConnectResult)), [cm]);
	const checkoutOrgId = account?.organization?.id ?? '';

	// Subscribe entry point: hand off to CheckoutFlow, or explain why not.
	const [showUnavailable, setShowUnavailable] = useState(false);
	const handleAccountSubscribe = useCallback(() => {
		if (!stripe?.key) {
			setShowUnavailable(true);
			return;
		}
		cm.emit('shell:subscribe', { app: PIPE_BUILDER_APP } as never);
	}, [cm, stripe]);

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
		// Focus ids are the LEGACY tab names (the open command's public
		// vocabulary — commands and the auth-failure flow still speak them);
		// they map onto the unified page's section ids.
		const section = typeof args.focus === 'string' ? FOCUS_TO_SECTION[args.focus] : undefined;
		if (section) setInitialSection(section);
		if (args.authError) setAuthError(args.authError);
		// The env gate's keys REPLACE on every open — an argless open clears
		// any previous gate (the old page's stale-prefill bug, fixed here).
		setEnvPrefill(Array.isArray(args.envPrefill) ? args.envPrefill : []);
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
	// SETTINGS REGISTRY + MIRRORED VALUE STORES
	// ========================================================================

	// This realm's registered contributions (the module-scope registrations
	// above; a live feed so a future cross-realm source slots in unchanged).
	const [contributions, setContributions] = useState(() => getSettingsContributions());
	useEffect(() => onSettingsContributionsChanged(() => setContributions(getSettingsContributions())), []);

	// Account-mirrored apps — desktop apps with `contributes.configuration`
	// surface their sections here exactly as on the cloud.
	const [accountApps, setAccountApps] = useState<AppManifestEntry[]>(() => (cm.getAccountInfo()?.apps ?? []) as AppManifestEntry[]);
	useEffect(() => cm.on('shell:accountUpdate', () => setAccountApps((cm.getAccountInfo()?.apps ?? []) as AppManifestEntry[])), [cm]);

	const settingsRegistry = useMemo(
		() => buildSettingsRegistry(accountApps, { shell: 'vscode', contributions }),
		[accountApps, contributions],
	);

	// Values: workspace/user overrides over the per-partition mirror topics;
	// writes route to the owner partition the same way the cloud routes them.
	const { overrides, updateSetting } = useMirroredWorkspaceSettings(cm, settingsRegistry);

	// ── Checkout callbacks (passed to CloudPanel) — the realm client ─────────
	const needClient = useCallback(() => {
		const client = cm.getClient();
		if (!client || !cm.isConnected()) throw new Error('Not connected to server');
		return client;
	}, [cm]);

	const handleFetchPlans = useCallback((): Promise<CheckoutPlan[]> => {
		return needClient().billing.getProductPrices(PIPE_BUILDER_APP_ID) as Promise<CheckoutPlan[]>;
	}, [needClient]);

	const handleCreateCheckout = useCallback(
		(priceId: string): Promise<{ clientSecret: string; subscriptionId: string }> => {
			const orgId = cm.getAccountInfo()?.organization?.id;
			if (!orgId) return Promise.reject(new Error('No organisation found'));
			return needClient().billing.createCheckoutSession(orgId, PIPE_BUILDER_APP_ID, priceId) as Promise<{ clientSecret: string; subscriptionId: string }>;
		},
		[cm, needClient]
	);

	const handleConfirmPending = useCallback(
		async (subscriptionId: string, priceId: string): Promise<void> => {
			// No SDK method exists for confirm_pending; wrap the public call()
			// exactly as BillingApi wraps its other verbs.
			await needClient().call('rrext_account_billing', { subcommand: 'confirm_pending', appId: PIPE_BUILDER_APP_ID, subscriptionId, priceId });
		},
		[needClient]
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

	// The connection pages' shared footer — Save & Reconnect applies the whole
	// connection blob (atomic persist + staged cloud-auth commit + engine
	// reconcile), exactly the old page-level footer's semantics, now rendered
	// inside whichever Connections section is open while the blob is dirty.
	const connectionsFooter = dirty ? (
		<div style={settingsFooterStyles.bar}>
			<button style={settingsFooterStyles.cancel} onClick={handleCancelSettings}>
				Cancel
			</button>
			<button style={settingsFooterStyles.save} onClick={handleSaveSettings}>
				Save &amp; Reconnect
			</button>
		</div>
	) : null;

	// The two Connections rich sections — self-managed panes beside the schema
	// sections, rebuilt from the same state the old tabs rendered.
	const extraSections = useMemo<SettingsRichSection[]>(
		() => [
			{
				id: 'host:development',
				title: 'Development',
				group: CONNECTIONS_GROUP,
				render: () => (
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
						{connectionsFooter}
					</div>
				),
			},
			{
				id: 'host:deployment',
				title: 'Deployment',
				group: CONNECTIONS_GROUP,
				render: () => (
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
						{connectionsFooter}
					</div>
				),
			},
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[settings, dirty, message, testMessage, engineVersions, engineVersionsLoading, devProbe, deployProbe, cloudSignedIn, cloudUserName, cloudSignedInUrl, cloudWaitlisted, cloudWaitlistedName, cloudPending, subscribed, dockerStatus, dockerProgress, dockerError, dockerBusy, dockerAction, dockerSelectedVersion, serviceStatus, serviceProgress, serviceError, serviceBusy, serviceAction, serviceSelectedVersion, dockerTags, sudoPromptVisible, sudoPasswordInput]
	);

	// Environment Variables sections — one flat entry when dev and deploy
	// share a connection, else an accordion with the two slots as children
	// (the nav IS the server selector). The dev section always carries the
	// id 'environment' (the deep-link vocabulary) and receives the gate's
	// prefill keys; runs execute against the dev connection.
	const envSections = useMemo<SettingsRichSection[]>(() => {
		if (!envSlots) return [];
		const bySlot = new Map(envSlots.slots.map((s) => [s.slot, s]));
		const dev = bySlot.get('development');
		if (!dev) return [];
		const deploy = envSlots.shared ? undefined : bySlot.get('deployment');
		if (!deploy) {
			return [{ id: 'environment', title: 'Environment Variables', order: 20, render: () => <EnvironmentSection slot={dev} label="Environment" requiredKeys={envPrefill} /> }];
		}
		return [
			{ id: 'environment', title: 'Development', group: ENVIRONMENT_GROUP, order: 20, render: () => <EnvironmentSection slot={dev} label="Development" requiredKeys={envPrefill} /> },
			{ id: 'environment:deployment', title: 'Deployment', group: ENVIRONMENT_GROUP, order: 20, render: () => <EnvironmentSection slot={deploy} label="Deployment" /> },
		];
	}, [envSlots, envPrefill]);

	// Account group — Profile (identity + workspace master card, absorbing the
	// old Organization/Teams/Members tabs), Billing, API Keys. Only with a
	// signed-in account (the old page was gated on the cloud connection too).
	// The workspace-switch guard auto-discards a dirty schema draft: webviews
	// have no window.confirm, and a workspace-A draft must never save into
	// workspace B (the switch triggers a full reconnect anyway).
	const accountSections = useMemo<SettingsRichSection[]>(() => {
		if (!account?.organization) return [];
		const guardOf = (ctx?: ISettingsRichContext) => () => {
			if (ctx?.isDirty()) ctx.discardDraft();
			return true;
		};
		return [
			{
				id: 'account:profile', title: 'Profile', group: ACCOUNT_GROUP, order: 10,
				render: (ctx) => <AccountProvider embeddedSection="profile" confirmWorkspaceSwitch={guardOf(ctx)} {...(ctx ? { onNavigateSection: ctx.navigate } : {})} />,
			},
			{
				id: 'account:billing', title: 'Billing', group: ACCOUNT_GROUP, order: 10,
				render: (ctx) => <AccountProvider embeddedSection="billing" onSubscribe={handleAccountSubscribe} {...(ctx ? { onNavigateSection: ctx.navigate } : {})} />,
			},
			{
				id: 'account:keys', title: 'API Keys', group: ACCOUNT_GROUP, order: 10,
				render: (ctx) => <AccountProvider embeddedSection="api-keys" {...(ctx ? { onNavigateSection: ctx.navigate } : {})} />,
			},
		];
	}, [account?.organization, handleAccountSubscribe]);

	const allSections = useMemo<SettingsRichSection[]>(() => [...extraSections, ...accountSections, ...envSections], [extraSections, accountSections, envSections]);

	return (
		<div style={commonStyles.columnFill}>
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

			{/* ── The unified settings page: schema sections (Rocket Builder,
			     Integrations, desktop apps) + the Connections rich sections. ── */}
			<div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
				<SettingsPage
					registry={settingsRegistry}
					overrides={overrides}
					updateSetting={updateSetting}
					extraSections={allSections}
					{...(initialSection !== undefined ? { initialSectionId: initialSection } : {})}
				/>
			</div>

			{/* ── Checkout (the Billing section's Subscribe → shell:subscribe) ── */}
			<CheckoutFlow stripeKey={stripe?.key ?? ''} orgId={checkoutOrgId} />
			{showUnavailable && <CheckoutUnavailableNotice reason={stripe?.reason} onClose={() => setShowUnavailable(false)} />}
		</div>
	);
};

export default Settings;
