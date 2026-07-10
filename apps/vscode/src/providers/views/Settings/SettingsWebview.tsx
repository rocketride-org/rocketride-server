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

import React, { useState, useRef, useMemo, useCallback, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';
import { ConnectionSettings } from './ConnectionSettings';
import { PipelineSettings } from './PipelineSettings';
import { DebuggingSettings } from './DebuggingSettings';
// EnvVariablesSettings removed — env is now managed in the Account page
import { IntegrationSettings } from './IntegrationSettings';
import { DeploySettings } from './DeploySettings';
import { MessageDisplay } from './MessageDisplay';
import { commonStyles } from 'shared/themes/styles';
import type { CheckoutPlan } from 'shared';
import { TabPanel } from 'shared/components/tab-panel/TabPanel';
import type { ITabPanelTab, ITabPanelPanel } from 'shared/components/tab-panel/TabPanel';
import type { ServiceStatus, DockerStatus, VersionOption } from '../components/panels/shared';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Available connection modes for dev/deploy targets. */
export type ConnectionMode = 'cloud' | 'docker' | 'service' | 'onprem' | 'local';

/**
 * Per-group (development or deployment) connection configuration.
 * Null connectionMode means "use the other group's target" (shared mode).
 */
export interface ConnectionGroupSettings {
	/** Active connection mode, or null when sharing the other group's target. */
	connectionMode: ConnectionMode | null;
	/** Server URL for cloud/onprem modes. */
	hostUrl: string;
	/** Whether the secret store already has an API key for this group. */
	hasApiKey: boolean;
	/** User-entered API key (cleared after save to secret storage). */
	apiKey: string;
	/** Selected team ID for cloud mode multi-tenant deployments. */
	teamId: string;
	/** Local engine settings (applies to local mode only). */
	local: {
		engineVersion: string;
		debugOutput: boolean;
		engineArgs: string;
	};
}

/** Root settings object persisted by the extension. */
export interface SettingsData {
	development: ConnectionGroupSettings;
	deployment: ConnectionGroupSettings;
	/** Workspace-relative path where pipeline files are stored. */
	defaultPipelinePath: string;
	/** How pipelines behave after file changes: auto-restart, manual, or prompt the user. */
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';
	envVars?: Record<string, string>;
	/** Auto-install RocketRide docs for detected coding agents. */
	autoAgentIntegration: boolean;
	integrationCopilot: boolean;
	integrationClaudeCode: boolean;
	integrationCursor: boolean;
	integrationWindsurf: boolean;
	integrationClaudeMd: boolean;
	integrationAgentsMd: boolean;
}

/** A version entry returned from the GitHub releases API. */
export interface EngineVersionItem {
	tag_name: string;
	prerelease: boolean;
}

/** Message displayed in the status banner (inline or global). */
export interface MessageData {
	level: 'success' | 'error' | 'info' | 'warning';
	message: string;
}

/**
 * Messages the extension host sends **to** this webview.
 * Additional message types (cloud:status, ioProgress, ioResult, etc.) are
 * handled via `as any` casts because the discriminated union only covers
 * the core types — engine/IO messages are added dynamically.
 */
export type SettingsIncomingMessage =
	| {
			type: 'settingsLoaded';
			settings: SettingsData;
			isSubscribed?: boolean;
	  }
	| {
			type: 'showMessage';
			level: 'success' | 'error' | 'info' | 'warning';
			message: string;
			/** 'development' routes to inline test banner; 'save' indicates successful settings save. */
			context?: 'development' | 'save';
	  }
	| {
			type: 'versionsLoaded';
			versions: EngineVersionItem[];
	  }
	| {
			type: 'subscriptionStatus';
			isSubscribed: boolean;
	  };

/** Messages this webview sends **to** the extension host. */
export type SettingsOutgoingMessage =
	| {
			type: 'view:ready';
	  }
	| {
			type: 'saveSettings';
			settings: SettingsData;
	  }
	| {
			type: 'testConnection';
			hostUrl: string;
			apiKey: string;
	  }
	| {
			type: 'clearCredentials';
	  }
	| {
			type: 'fetchVersions';
	  }
	| {
			type: 'fetchTeams';
	  }
	| {
			type: 'openSubscribe';
	  };

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
};

// ============================================================================
// SUBSCRIBE BANNER STYLES
// ============================================================================

const subscribeBannerStyles = {
	container: {
		background: 'var(--rr-color-warning-bg, rgba(255, 193, 7, 0.1))',
		borderBottom: '1px solid var(--rr-color-warning, #ffc107)',
		padding: '10px 16px',
	} as CSSProperties,
	content: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
	} as CSSProperties,
	text: {
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		flex: 1,
	} as CSSProperties,
	button: {
		...commonStyles.buttonPrimary,
		whiteSpace: 'nowrap',
		flexShrink: 0,
	} as CSSProperties,
};

// ============================================================================
// AUTH ERROR BANNER STYLES
// ============================================================================

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
// SHARED CARD HEADER WITH SAVE BUTTON
// ============================================================================

/**
 * Card header with title + conditional Save/Cancel buttons.
 * Buttons only render when `dirty` is true (user has unsaved edits).
 * A brief "Saved" confirmation appears after a successful save.
 */
export const SettingsCardHeader: React.FC<{
	title: string;
	onSave: () => void;
	onCancel?: () => void;
	dirty?: boolean;
	saved?: boolean;
}> = ({ title, onSave, onCancel, dirty, saved }) => (
	<div style={settingsStyles.cardHeader}>
		{title}
		<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
			{saved && <span style={{ fontSize: 11, color: 'var(--rr-color-success)' }}>Saved</span>}
			{dirty && (
				<>
					{onCancel && (
						<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onCancel}>
							Cancel
						</button>
					)}
					<button style={{ ...commonStyles.buttonPrimary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onSave}>
						Save All Settings
					</button>
				</>
			)}
		</div>
	</div>
);

// ============================================================================
// MAIN SETTINGS VIEW COMPONENT
// ============================================================================

/**
 * Settings - Configuration dashboard for VS Code extension webview
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
export const Settings: React.FC = () => {
	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================

	const [settings, setSettings] = useState<SettingsData>({
		development: {
			connectionMode: 'local',
			hostUrl: 'http://localhost:5565',
			hasApiKey: false,
			apiKey: '',
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
	});
	const [message, setMessage] = useState<MessageData | null>(null);
	const [testMessage, setTestMessage] = useState<MessageData | null>(null);
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	// Server capabilities (from probe)
	const [serverCapabilities, setServerCapabilities] = useState<string[]>([]);
	const [isSaasProbed, setIsSaasProbed] = useState<boolean | undefined>(undefined);

	// Cloud auth state
	const [cloudSignedIn, setCloudSignedIn] = useState(false);
	// Subscription state — defaults to false so the subscribe button shows until the host confirms
	const [subscribed, setSubscribed] = useState(false);
	const [cloudUserName, setCloudUserName] = useState('');
	const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);

	// Checkout modal state
	const checkoutResolvers = useRef<{
		plans?: { resolve: (v: CheckoutPlan[]) => void; reject: (e: Error) => void };
		session?: { resolve: (v: { clientSecret: string; subscriptionId: string }) => void; reject: (e: Error) => void };
		confirm?: { resolve: () => void; reject: (e: Error) => void };
	}>({});

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

	// Auth error banner — shown when the settings page opens due to an auth failure
	const [authError, setAuthError] = useState<string | null>(null);

	// Active settings tab
	const [activeTab, setActiveTab] = useState('development');

	// Dirty-state tracking — buttons only appear when user has edited something
	const [dirty, setDirty] = useState(false);
	const [saved, setSaved] = useState(false);
	const savedSettingsRef = useRef<SettingsData | null>(null);
	const pendingSaveSnapshotRef = useRef<SettingsData | null>(null);

	// ========================================================================
	// WEBVIEW MESSAGING
	// ========================================================================

	const { sendMessage, isReady: _isReady } = useMessaging<SettingsOutgoingMessage, SettingsIncomingMessage>({
		onMessage: (message) => {
			switch (message.type) {
				case 'settingsLoaded':
					setSettings(message.settings);
					// Deep-clone for cancel/reset so future edits don't mutate the snapshot
					savedSettingsRef.current = JSON.parse(JSON.stringify(message.settings));
					setDirty(false);
					// Subscription status is included in the settingsLoaded payload
					if (message.isSubscribed !== undefined) {
						setSubscribed(message.isSubscribed);
					}
					// Pre-fetch versions from GitHub (cached on backend, shared across all modes)
					setEngineVersionsLoading(true);
					sendMessage({ type: 'fetchVersions' });
					// Hydrate cloud auth status so the Cloud panel renders correctly
					sendMessage({ type: 'cloud:getStatus' } as any);
					break;

				case 'versionsLoaded' as any:
					setEngineVersions((message as any).versions ?? []);
					setEngineVersionsLoading(false);
					break;

				case 'cloud:status' as any:
					setCloudSignedIn((message as any).signedIn);
					setCloudUserName((message as any).userName || '');
					break;

				case 'subscriptionStatus':
					setSubscribed(message.isSubscribed);
					break;

				// -- Checkout flow responses ------------------------------------
				case 'checkout:plansResult' as any: {
					const r = checkoutResolvers.current.plans;
					if (r) {
						checkoutResolvers.current.plans = undefined;
						if ((message as any).error) r.reject(new Error((message as any).error));
						else r.resolve((message as any).plans ?? []);
					}
					break;
				}
				case 'checkout:sessionResult' as any: {
					const r = checkoutResolvers.current.session;
					if (r) {
						checkoutResolvers.current.session = undefined;
						if ((message as any).error) r.reject(new Error((message as any).error));
						else r.resolve({ clientSecret: (message as any).clientSecret, subscriptionId: (message as any).subscriptionId });
					}
					break;
				}
				case 'checkout:confirmResult' as any: {
					const r = checkoutResolvers.current.confirm;
					if (r) {
						checkoutResolvers.current.confirm = undefined;
						if ((message as any).error) r.reject(new Error((message as any).error));
						else r.resolve();
					}
					break;
				}

				case 'teamsLoaded' as any:
					setTeams((message as any).teams || []);
					break;

				case 'setFocus' as any:
					if ((message as any).focus) setActiveTab((message as any).focus);
					break;

				case 'authError' as any:
					setAuthError((message as any).message || 'Authentication failed');
					break;

				case 'serverInfo' as any: {
					const caps = (message as any).capabilities || [];
					setServerCapabilities(caps);
					setIsSaasProbed(caps.includes('saas'));
					break;
				}

				case 'showMessage': {
					const msg = { level: message.level, message: message.message };
					const clearAfter = message.level === 'success' ? 5000 : undefined;

					// Route to inline test banner vs. global banner based on context
					if (message.context === 'development') {
						setTestMessage(msg);
						if (clearAfter) setTimeout(() => setTestMessage(null), clearAfter);
					} else {
						setMessage(msg);
						if (clearAfter) setTimeout(() => setMessage(null), clearAfter);
						// On successful save acknowledgement: update the saved snapshot
						// so Cancel reverts to the newly saved values
						if (message.level === 'success' && message.context === 'save') {
							savedSettingsRef.current = pendingSaveSnapshotRef.current ?? JSON.parse(JSON.stringify(settings)) as SettingsData;
							pendingSaveSnapshotRef.current = null;
							setDirty(false);
							setSaved(true);
							setTimeout(() => setSaved(false), 5000);
						}
					}
					break;
				}

				// Status polling — actual OS/Docker daemon state
				case 'dockerStatus' as any:
					setDockerStatus((message as any).status);
					if (!dockerBusy) setDockerProgress(null);
					break;
				case 'serviceStatus' as any:
					setServiceStatus((message as any).status);
					if (!serviceBusy) setServiceProgress(null);
					break;
				case 'dockerVersionsLoaded' as any:
					setDockerTags((message as any).tags || []);
					break;
				case 'serviceNeedsSudo' as any:
					setSudoPromptVisible(true);
					break;

				// ioProgress: streamed progress updates during install/update/remove.
				// Clears any previous error so the progress message replaces it.
				case 'ioProgress' as any: {
					const mode = (message as any).mode;
					const progressMsg = (message as any).message;
					if (mode === 'service') {
						setServiceProgress(progressMsg);
						setServiceError(null);
					} else if (mode === 'docker') {
						setDockerProgress(progressMsg);
						setDockerError(null);
					}
					break;
				}

				// ioResult: final outcome of an ioControl command.
				// Resets busy/action/progress state and surfaces errors.
				case 'ioResult' as any: {
					const mode = (message as any).mode;
					const command = (message as any).command;
					const success = (message as any).success;
					const error = (message as any).error;

					// 'test' commands display results inline via testMessage
					// rather than resetting engine busy state
					if (command === 'test') {
						const msg: MessageData = success
							? { level: 'success', message: 'Connection successful!' }
							: { level: 'error', message: error || 'Connection failed' };
						setTestMessage(msg);
						// Clear the auth error banner on successful test connection
						if (success) {
							setAuthError(null);
							setTimeout(() => setTestMessage(null), 5000);
						}
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
		const snapshot = JSON.parse(JSON.stringify(settings)) as SettingsData;
		pendingSaveSnapshotRef.current = snapshot;
		sendMessage({ type: 'saveSettings', settings: snapshot });
	};

	/** Revert to last-saved settings and clear dirty state. */
	const handleCancelSettings = useCallback((): void => {
		if (savedSettingsRef.current) {
			setSettings(JSON.parse(JSON.stringify(savedSettingsRef.current)));
		}
		setDirty(false);
		setSaved(false);
	}, []);

	/**
	 * Test connection via ioControl. On-prem passes hostUrl/apiKey as params;
	 * service/docker use their known defaults on the backend.
	 */
	const handleTestConnection = (mode: string, params?: Record<string, unknown>): void => {
		setTestMessage(null);
		sendMessage({ type: 'ioControl', mode, command: 'test', params } as any);
	};

	/**
	 * Probe cloud server to check SaaS compatibility
	 */
	const handleProbeCloudServer = (cloudUrl: string): void => {
		setIsSaasProbed(undefined); // reset to loading
		sendMessage({ type: 'probeServerInfo', hostUrl: cloudUrl } as any);
	};

	const handleFetchTeams = (cloudUrl: string): void => {
		sendMessage({ type: 'fetchTeams', hostUrl: cloudUrl } as any);
	};

	/**
	 * Clear stored credentials
	 */
	const handleClearCredentials = (): void => {
		// Clear the API key from local state and send clear message
		setSettings((prev) => ({
			...prev,
			development: { ...prev.development, apiKey: '', hasApiKey: false },
		}));
		sendMessage({ type: 'clearCredentials' });
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
		setSaved(false);
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

			// Side effects: fetch engine versions when switching to local mode
			const devMode = changes.development?.connectionMode;
			const depMode = changes.deployment?.connectionMode;
			// Refresh versions when switching to any mode that needs them.
			// The handler caches results, so repeated calls are cheap.
			const needsVersions = ['local', 'service', 'docker'];
			if ((devMode && needsVersions.includes(devMode)) || (depMode && needsVersions.includes(depMode))) {
				sendMessage({ type: 'fetchVersions' });
			}

			// Teams are fetched by CloudPanel after it confirms the server is SaaS

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

	/**
	 * Factory for docker/service action handlers.
	 *
	 * Returns a zero-arg callback that sets the mode's busy/action state,
	 * attaches the selected version (for install/update), and sends an
	 * `ioControl` message to the extension host. The host streams back
	 * `ioProgress` updates and a final `ioResult` to clear busy state.
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


	const handleSudoSubmit = (): void => {
		const password = sudoPasswordInput;
		setSudoPasswordInput('');
		setSudoPromptVisible(false);
		sendMessage({ type: 'sudoPassword', password } as any);
	};

	// ========================================================================
	// RENDER
	// ========================================================================

	// ========================================================================
	// TAB DEFINITIONS
	// ========================================================================

	const tabs: ITabPanelTab[] = useMemo(
		() => [
			{ id: 'development', label: 'Development' },
			{ id: 'deployment', label: 'Deployment' },
			{ id: 'pipeline', label: 'Pipeline' },
			{ id: 'debugging', label: 'Debugging' },
			{ id: 'integrations', label: 'Integrations' },
		],
		[]
	);

	// ── Checkout callbacks (passed to CloudPanel) ──────────────────────
	const handleFetchPlans = useCallback((): Promise<CheckoutPlan[]> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.plans = { resolve, reject };
			sendMessage({ type: 'checkout:fetchPlans' } as any);
		});
	}, [sendMessage]);

	const handleCreateCheckout = useCallback((priceId: string): Promise<{ clientSecret: string; subscriptionId: string }> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.session = { resolve, reject };
			sendMessage({ type: 'checkout:createSession', priceId } as any);
		});
	}, [sendMessage]);

	const handleConfirmPending = useCallback((subscriptionId: string, priceId: string): Promise<void> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.confirm = { resolve, reject };
			sendMessage({ type: 'checkout:confirmPending', subscriptionId, priceId } as any);
		});
	}, [sendMessage]);

	const handleCheckoutSuccess = useCallback(() => {
		setSubscribed(true);
	}, []);

	const panels: Record<string, ITabPanelPanel> = useMemo(
		() => ({
			development: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<ConnectionSettings
							settings={settings}
							onSettingsChange={handleSettingsChange}
							onSave={handleSaveSettings}
							onCancel={handleCancelSettings}
							dirty={dirty}
							saved={saved}
							onClearCredentials={handleClearCredentials}
							onTestConnection={handleTestConnection}
							serverCapabilities={serverCapabilities}
							testMessage={testMessage}
							engineVersions={engineVersions}
							engineVersionsLoading={engineVersionsLoading}
							cloudSignedIn={cloudSignedIn}
							cloudUserName={cloudUserName}
							onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' } as any)}
							onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' } as any)}
							onProbeCloudServer={handleProbeCloudServer}
							onFetchTeams={handleFetchTeams}
							isSaas={isSaasProbed}
							teams={teams}
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
							onSave={handleSaveSettings}
							onCancel={handleCancelSettings}
							dirty={dirty}
							saved={saved}
							serverCapabilities={serverCapabilities}
							teams={teams}
							engineVersions={engineVersions}
							engineVersionsLoading={engineVersionsLoading}
							onClearCredentials={handleClearCredentials}
							onTestConnection={handleTestConnection}
							testMessage={testMessage}
							cloudSignedIn={cloudSignedIn}
							cloudUserName={cloudUserName}
							onCloudSignIn={() => sendMessage({ type: 'cloud:signIn' } as any)}
							onCloudSignOut={() => sendMessage({ type: 'cloud:signOut' } as any)}
							onProbeCloudServer={handleProbeCloudServer}
							onFetchTeams={handleFetchTeams}
							isSaas={isSaasProbed}
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
						<PipelineSettings settings={settings} onSettingsChange={handleSettingsChange} onSave={handleSaveSettings} onCancel={handleCancelSettings} dirty={dirty} saved={saved} />
					</div>
				),
			},
			debugging: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<DebuggingSettings settings={settings} onSettingsChange={handleSettingsChange} onSave={handleSaveSettings} onCancel={handleCancelSettings} dirty={dirty} saved={saved} />
					</div>
				),
			},
			integrations: {
				content: (
					<div style={commonStyles.tabContent}>
						<MessageDisplay message={message} />
						<IntegrationSettings settings={settings} onSettingsChange={handleSettingsChange} onSave={handleSaveSettings} onCancel={handleCancelSettings} dirty={dirty} saved={saved} />
					</div>
				),
			},
		}),
		[settings, message, testMessage, engineVersions, engineVersionsLoading, serverCapabilities, cloudSignedIn, cloudUserName, teams, dockerStatus, dockerProgress, dockerError, dockerBusy, dockerAction, dockerVersionOptions, dockerSelectedVersion, serviceStatus, serviceProgress, serviceError, serviceBusy, serviceAction, serviceVersionOptions, serviceSelectedVersion, sudoPromptVisible, sudoPasswordInput]
	);

	return (
		<div style={commonStyles.columnFill}>
			{/* ── Auth error banner (shown when opened due to auth failure) ── */}
			{authError && (
				<div style={authErrorBannerStyles.container}>
					<div style={authErrorBannerStyles.content}>
						<span style={{ fontSize: 18 }}>&#9888;</span>
						<span style={authErrorBannerStyles.text}>{authError}</span>
						<button
							style={authErrorBannerStyles.dismiss}
							onClick={() => setAuthError(null)}
							title="Dismiss"
						>
							&#10005;
						</button>
					</div>
				</div>
			)}
			{/* ── Tab panel ─────────────────────────────────────────── */}
			<TabPanel tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} panels={panels} />
		</div>
	);
};
