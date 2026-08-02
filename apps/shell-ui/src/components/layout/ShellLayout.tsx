// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// SHELL LAYOUT — four-zone layout with workspace context
// =============================================================================
//
// ┌──────────┬─────────────────────────┬────────────┐
// │          │                         │            │
// │ Sidebar  │      Client Area        │   Debug    │
// │          │                         │  (ALT+D)   │
// │          │                         │            │
// ├──────────┴─────────────────────────┴────────────┤
// │ ● Connected    Ready                  Ln 1 Col 1│
// └──────────────────────────────────────────────────┘
// =============================================================================

import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ShellIdentityContext } from '../../hooks/useAuthUser';
import { useWorkspace } from '../../workspace/WorkspaceContext';
import { PrefsProvider } from 'shared';
import { ConnectionManager } from '../../connection/connection';
import { isDevPreviewPending } from '../../lib/appLoader';
import { ShellApiConfigProvider } from '../../connection/ShellApiConfigContext';
import { AppErrorBoundary } from './AppErrorBoundary';
import { OverlayManager, useOverlay } from './OverlayManager';
import { HostChromeProvider } from './HostChromeContext';
import Sidebar from './Sidebar';
import StatusBar from './StatusBar';
import LoadingScreen from './LoadingScreen';
import DebugPanel from './DebugPanel';
import type { ShellConfig } from '../../workspace/types';
import { commonStyles } from 'shared/themes/styles';

// =============================================================================
// APP-LOAD ERROR CLASSIFICATION
// =============================================================================

/**
 * Translate a raw app-load error into a user-facing explanation. The raw
 * text (module-federation / webpack internals) remains available behind the
 * error view's "Show Details" button for debugging.
 *
 * @param raw - The raw error message recorded by WorkspaceContext.
 * @param name - Display name of the app that failed.
 * @returns Plain-language explanation of the failure.
 */
function friendlyLoadError(raw: string, name: string): string {
	// Shared-module negotiation failures — and the TDZ artifact a failed first
	// attempt leaves behind — mean the bundle was built against a different
	// platform build than the one now serving it.
	if (/RUNTIME-012|shared module|shareKey|before initialization/i.test(raw)) {
		return `${name} was built for a different version of the platform and needs to be rebuilt or redeployed.`;
	}
	// Network-shaped failures: missing bundle, unreachable server, timeout.
	if (/failed to load within|failed to fetch|load(ing)? script|ChunkLoadError|404/i.test(raw)) {
		return `${name} isn't installed on this server, or its files are unreachable.`;
	}
	// WorkspaceContext's own validation messages are already human-readable.
	if (/missing its UI|requires shell API/i.test(raw)) return raw;
	return `${name} failed to start.`;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	shell: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
	} as CSSProperties,
	main: {
		display: 'flex',
		flex: 1,
		minHeight: 0,
	} as CSSProperties,
	clientArea: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minWidth: 0,
		minHeight: 0,
	} as CSSProperties,
	appLoading: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 13,
	} as CSSProperties,
	// Load-failure state — fills the same client-area slot as appLoading but
	// stacks a title/message/Retry, mirroring AppErrorBoundary's error screen.
	appLoadError: {
		display: 'flex',
		flex: 1,
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 16,
		padding: 40,
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-text-primary)',
		backgroundColor: 'var(--rr-bg-default)',
		textAlign: 'center',
	} as CSSProperties,
	appLoadErrorTitle: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-color-error, #ef4444)',
	} as CSSProperties,
	appLoadErrorMessage: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		maxWidth: 480,
		lineHeight: 1.6,
		wordBreak: 'break-word',
	} as CSSProperties,
	appLoadErrorButton: {
		...commonStyles.buttonPrimary,
		padding: '8px 20px',
		fontWeight: 600,
	} as CSSProperties,
	appLoadErrorButtonSecondary: {
		padding: '8px 20px',
		fontWeight: 600,
		fontSize: 13,
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	appLoadErrorActions: {
		display: 'flex',
		gap: 10,
		marginTop: 8,
	} as CSSProperties,
	/** Backdrop for the load-failure modal shown over the active app. */
	loadFailureBackdrop: {
		...commonStyles.modalOverlay,
		zIndex: 1200,
	} as CSSProperties,
	/** Dialog card for the load-failure modal. */
	loadFailureDialog: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: 16,
		padding: '28px 32px',
		maxWidth: 620,
		borderRadius: 12,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
		fontFamily: 'var(--rr-font-family)',
		textAlign: 'center' as const,
	} as CSSProperties,
	/** Raw error text panel behind the "Show Details" button. */
	appLoadErrorDetails: {
		margin: 0,
		maxWidth: 640,
		maxHeight: 240,
		overflow: 'auto',
		padding: '12px 14px',
		borderRadius: 8,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		color: 'var(--rr-text-secondary)',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		textAlign: 'left' as const,
		whiteSpace: 'pre-wrap' as const,
		wordBreak: 'break-word' as const,
	} as CSSProperties,
	overlayContainer: {
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minWidth: 0,
		minHeight: 0,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Props for the ShellLayout component.
 */
export interface ShellLayoutProps {
	/** Shell configuration (with identity merged in). */
	config: ShellConfig;
	/** Whether the RocketRide WebSocket is open. */
	isConnected: boolean;
	/** Current status bar message. */
	statusMessage: string | null;
	/** Whether to hide the app switcher in sidebar. */
	hideAppSwitcher?: boolean;
	/** Default app ID (home or hello). */
	defaultAppId: string;
}

/**
 * Four-zone shell layout that renders the active app, sidebar, status bar,
 * and debug panel.
 *
 * Reads workspace state to determine the active app and mounts the app's
 * `<App />` component in the client area and `<Sidebar />` in the sidebar zone.
 *
 * Wraps content in OverlayManager so shell-owned overlays (Account, Settings)
 * can render over the client area.
 */
export const ShellLayout: React.FC<ShellLayoutProps> = ({
	config, isConnected, statusMessage, hideAppSwitcher, defaultAppId,
}) => {
	const { loaded, seeded, appLoading, prefs, updatePrefs, activeAppId, loadedApps, settings, appManifest, appLoadErrors, retryApp, loadFailure, dismissLoadFailure } = useWorkspace();

	// The ONE workspace-prefs accessor (getPref/setPref) handed to every app and
	// overlay the shell renders — the same API the canvas uses via ProjectView.
	// Reads/writes the active app's prefs bag; updatePrefs persists it.
	const prefsApi = useMemo(
		() => ({
			getPref: (key: string): unknown => prefs[key],
			setPref: (key: string, value: unknown): void => updatePrefs({ [key]: value }),
		}),
		[prefs, updatePrefs],
	);

	// Technical-details panel on the app-load error view; collapses whenever
	// the active app changes so a stale trace never shows for a new app.
	const [showErrorDetails, setShowErrorDetails] = useState(false);
	useEffect(() => { setShowErrorDetails(false); }, [activeAppId]);

	// Load-failure modal's own details toggle (the page view and the modal can
	// coexist), reset whenever a new failure arrives.
	const [showModalDetails, setShowModalDetails] = useState(false);
	useEffect(() => { setShowModalDetails(false); }, [loadFailure]);

	/**
	 * Retry from the load-failure modal: re-attempts the load (retryApp tears
	 * down the failed container first); on success closes the modal and
	 * completes the switch the user originally asked for.
	 */
	const handleModalRetry = async () => {
		if (!loadFailure) return;
		const ok = await retryApp(loadFailure.appId);
		if (ok) {
			dismissLoadFailure();
			ConnectionManager.getInstance().emit('shell:switchApp', { appId: loadFailure.appId });
		}
	};

	// --- Merge API config: build-time config + effective settings -------------
	// `settings` from useWorkspace() is already the EFFECTIVE map (declared
	// defaults overlaid with the user's overrides via the settings registry),
	// so no per-key default collection or per-app override resolution is needed
	// here. ShellApiConfig is an env-style string map handed to remote apps, so
	// typed setting values (number/boolean) are coerced to strings at this
	// boundary — the one place the two representations meet.
	const mergedApiConfig = useMemo(
		() => ({
			...config.apiConfig,
			...Object.fromEntries(
				Object.entries(settings).map(([key, value]) => [key, String(value)]),
			),
		}),
		[config.apiConfig, settings],
	);

	// --- Active app descriptor (undefined while loading) ---------------------
	const activeApp = loadedApps[activeAppId];

	// --- First-content latch --------------------------------------------------
	// True once the client area has EVER had something real to show (the app,
	// or a terminal error surface). Until then the whole layout stays on the
	// full-screen boot rocket: rendering the chrome skeleton around a loading
	// client area made startup a chrome-pop followed by an app-pop instead of
	// one cut from "loading" to "ready". A ref, not state — it is a render
	// latch that must flip in the SAME render that first has content, and it
	// never flips back (later app SWITCHES keep the chrome and show the
	// in-pane rocket, as before).
	const firstContentRef = useRef(false);

	// --- Debug panel state (ALT+D toggle) ------------------------------------
	const [debugOpen, setDebugOpen] = useState(false);

	// --- ALT+D keyboard handler ----------------------------------------------
	useEffect(() => {
		/** Toggles the debug panel when ALT+D is pressed. */
		const handler = (e: KeyboardEvent) => {
			if (e.altKey && (e.key === 'd' || e.key === 'D')) {
				e.preventDefault();
				setDebugOpen((prev) => !prev);
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);

	// --- Apply theme on load and when it changes -----------------------------
	useEffect(() => {
		if (!loaded) return;
		config.themeConfig.onThemeChange?.(prefs.theme);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loaded, prefs.theme]);

	// --- Ctrl+S forwarding ---------------------------------------------------
	useEffect(() => {
		/** Intercepts Ctrl+S / Cmd+S for Documents save handling. */
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				window.dispatchEvent(new CustomEvent('tab:save'));
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);

	// --- Identity for passing to app components ------------------------------
	const identity = useContext(ShellIdentityContext);

	// --- Auth gate: auto-trigger login for authenticated apps ----------------
	const activeManifest = appManifest.find((m) => m.id === activeAppId);
	const authGateTriggeredRef = useRef<string | null>(null);
	const prevIdentityRef = useRef(identity);
	const suppressGateRef = useRef(false);

	useEffect(() => {
		// Detect a logout transition (had an identity, now none). On logout the
		// shell switches the active app back to home via shell:switchApp, but that
		// event is delivered on a microtask, so the workspace's activeAppId flips a
		// tick AFTER identity clears. During that gap the check below would see
		// "no identity + auth-required app still active" and fire shell:loginRequest
		// → startOAuth, bouncing a signing-out user to the Zitadel login screen
		// instead of leaving them on the logged-out home. Suppress the gate from the
		// moment identity drops until the active app settles back on the default.
		const wasLoggedIn = !!prevIdentityRef.current;
		prevIdentityRef.current = identity;
		if (wasLoggedIn && !identity) suppressGateRef.current = true;
		if (identity || activeAppId === defaultAppId) suppressGateRef.current = false;

		// Only gate when the manifest is loaded and explicitly requires auth.
		// Skip for the default app (home/hello) — it must always be accessible.
		if (!suppressGateRef.current && !identity && activeManifest && activeManifest.authenticated !== false && activeAppId !== defaultAppId) {
			if (authGateTriggeredRef.current === activeAppId) return;
			authGateTriggeredRef.current = activeAppId;
			ConnectionManager.getInstance().emit('shell:loginRequest', { appId: activeAppId });
		} else {
			authGateTriggeredRef.current = null;
		}
	}, [identity, activeAppId, activeManifest, defaultAppId]);

	// --- Subscription gate: auto-trigger checkout for subscription apps ------
	const subGateTriggeredRef = useRef<string | null>(null);
	const subGateActive = identity
		&& activeManifest
		&& activeAppId !== defaultAppId
		&& activeManifest.appStatus === 'unsubscribed';

	useEffect(() => {
		// When a logged-in user navigates to an app they haven't subscribed to,
		// open the checkout flow automatically. Skip the default app (always accessible).
		if (subGateActive && activeManifest) {
			if (subGateTriggeredRef.current === activeAppId) return;
			subGateTriggeredRef.current = activeAppId;
			// AppManifestEntry structurally satisfies the minimal ShellAppEntry
			// contract, so it is passed directly.
			ConnectionManager.getInstance().emit('shell:subscribe', { app: activeManifest });
		} else {
			subGateTriggeredRef.current = null;
		}
	}, [subGateActive, activeAppId, activeManifest]);

	// --- Loading guard -------------------------------------------------------
	// Workspace still hydrating: hold the SAME phase-anchored rocket as the
	// boot LoadingScreen — returning null here put a blank frame between two
	// otherwise-continuous loading screens.
	if (!loaded && !seeded) return <LoadingScreen />;

	// First boot: stay full-screen on the rocket until the first activation
	// resolves to real content — the mounted app, or a terminal error surface
	// (load failure, unknown app id) that the user must see. A pending dev
	// preview counts as still-loading: its registration self-corrects when
	// the embedder's injection lands (see the client-area branch below).
	const devPending = isDevPreviewPending(activeAppId);
	const hasFirstContent =
		!!activeApp?.components?.App ||
		(!devPending && !!appLoadErrors[activeAppId]) ||
		(!devPending && appManifest.length > 0 && !activeManifest);
	if (hasFirstContent) firstContentRef.current = true;
	if (!firstContentRef.current) return <LoadingScreen />;

	// --- Derived layout info -------------------------------------------------
	// The sidebar is always mounted (inside HostChromeProvider) and self-hides
	// when it has no content: a legacy `components.Sidebar` or app-registered
	// sidebar content. Apps with neither render no sidebar and the client area
	// spans full width — exactly as before, when the sidebar was gated on
	// `components.Sidebar` here.
	const appName = activeApp?.branding?.appName ?? config.apps[0]?.name ?? 'RocketRide';
	// Only show the status bar once the app has actually loaded. During the app-load gap the
	// client area shows the boot rocket (LoadingScreen); rendering the StatusBar there made it
	// blink in and then get covered by home-ui's AuthTransitionPage overlay — a one-frame
	// "flash" between the otherwise-identical loading/transition screens.
	const showStatusBar = activeManifest?.showStatusBar !== false && !!activeApp?.components?.App;

	// --- Render --------------------------------------------------------------
	return (
		<PrefsProvider value={prefsApi}>
		<ShellApiConfigProvider config={mergedApiConfig}>
		<HostChromeProvider>
		<OverlayManager>
		<div style={styles.shell}>
			{/* Main row: Sidebar | Client Area | Debug Panel */}
			<div style={styles.main}>
				{/* Sidebar zone — always mounted; self-hides when it has no content. */}
				<SidebarWithOverlay
					themeConfig={config.themeConfig}
					account={config.account}
					hideAppSwitcher={hideAppSwitcher}
					isSaas={(config.capabilities ?? []).includes('saas')}
				/>

				{/* Client area */}
				<div style={styles.overlayContainer}>
					<div style={styles.clientArea}>
						{activeApp?.components?.App ? (
							<AppErrorBoundary key={activeAppId} appName={appName}>
								<activeApp.components.App
									isConnected={isConnected}
									identity={identity}
								/>
							</AppErrorBoundary>
					) : isDevPreviewPending(activeAppId) ? (
							// DEV PREVIEW, registration not yet injected: the dev
							// server may still be starting — showing an error here
							// is a lie that flashes and self-corrects (the injection
							// invalidates + retries the load when it lands). Hold
							// the loading animation instead.
							<LoadingScreen />
						) : appLoadErrors[activeAppId] ? (
							<div style={styles.appLoadError}>
								<div style={styles.appLoadErrorTitle}>Could not load {activeManifest?.name ?? activeAppId}</div>
								{/* Plain-language explanation; raw error lives behind Show Details */}
								<div style={styles.appLoadErrorMessage} role="alert">
									{friendlyLoadError(appLoadErrors[activeAppId], activeManifest?.name ?? activeAppId)}
								</div>
								<div style={styles.appLoadErrorActions}>
									{/* Home is the guaranteed exit — $HOME resolves to the platform default */}
									<button type="button" style={styles.appLoadErrorButton} onClick={() => ConnectionManager.getInstance().emit('shell:switchApp', { appId: '$HOME' })}>
										Go to Home
									</button>
									<button type="button" style={styles.appLoadErrorButtonSecondary} onClick={() => retryApp(activeAppId)}>
										Try Again
									</button>
									<button type="button" style={styles.appLoadErrorButtonSecondary} onClick={() => setShowErrorDetails((v) => !v)}>
										{showErrorDetails ? 'Hide Details' : 'Show Details'}
									</button>
								</div>
								{/* Raw loader error, verbatim — for debugging (user-requested) */}
								{showErrorDetails && (
									<pre style={styles.appLoadErrorDetails}>{appLoadErrors[activeAppId]}</pre>
								)}
							</div>
						) : (loaded || seeded) && appManifest.length > 0 && !activeManifest ? (
							// The active app id is not in this server's manifest — e.g. a
							// stale per-tab session id left by a different shell flavour on
							// the same origin, or an app that was renamed/removed. Say so
							// explicitly with an exit; never strand the user on the splash
							// (loadDescriptor returns false silently for unknown ids).
							<div style={styles.appLoadError}>
								<div style={styles.appLoadErrorTitle}>App not found</div>
								<div style={styles.appLoadErrorMessage} role="alert">
									This server has no app with the id &quot;{activeAppId}&quot;. It may have been
									renamed, removed, or belong to a different RocketRide deployment.
								</div>
								<div style={styles.appLoadErrorActions}>
									{/* Home is the guaranteed exit — $HOME resolves to the platform default */}
									<button type="button" style={styles.appLoadErrorButton} onClick={() => ConnectionManager.getInstance().emit('shell:switchApp', { appId: '$HOME' })}>
										Go to Home
									</button>
								</div>
							</div>
						) : appLoading || !activeApp ? (
							// Same bobbing rocket as the boot LoadingScreen and home-ui's
							// AuthTransitionPage (all phase-anchored) so the post-login
							// boot → app-load → transition handoff is one continuous animation
							// with no "Loading…" text frame flashing between them.
							<LoadingScreen />
						) : null}
					</div>
				</div>

				{/* Load-failure modal — a switch-to-app failed while the current app
				    stayed on screen; shown over it instead of a page takeover. */}
				{loadFailure && (
					/* Backdrop is inert like every shell dialog (OverlayManager is the
					   source of truth for the no-backdrop-dismiss rule); the footer
					   Close button is the dismiss control. */
					<div style={styles.loadFailureBackdrop}>
						<div style={styles.loadFailureDialog} role="dialog" aria-modal="true">
							<div style={styles.appLoadErrorTitle}>Could not load {loadFailure.name}</div>
							{/* Plain-language explanation; raw error behind Show Details */}
							<div style={styles.appLoadErrorMessage} role="alert">
								{friendlyLoadError(appLoadErrors[loadFailure.appId] ?? '', loadFailure.name)}
							</div>
							<div style={styles.appLoadErrorActions}>
								<button type="button" style={styles.appLoadErrorButton} onClick={dismissLoadFailure}>
									Close
								</button>
								<button type="button" style={styles.appLoadErrorButtonSecondary} onClick={handleModalRetry}>
									Try Again
								</button>
								<button type="button" style={styles.appLoadErrorButtonSecondary} onClick={() => setShowModalDetails((v) => !v)}>
									{showModalDetails ? 'Hide Details' : 'Show Details'}
								</button>
							</div>
							{/* Raw loader error, verbatim — for debugging */}
							{showModalDetails && (
								<pre style={styles.appLoadErrorDetails}>{appLoadErrors[loadFailure.appId]}</pre>
							)}
						</div>
					</div>
				)}

				{/* Debug panel (ALT+D) */}
				{debugOpen && (
					<DebugPanel onClose={() => setDebugOpen(false)} />
				)}
			</div>

			{/* Status bar */}
			{showStatusBar && (
				<StatusBar
					appName={appName}
					isConnected={isConnected}
					isAuthenticated={identity !== null}
					statusMessage={statusMessage}
					onToggleBottomPanel={() => {}}
				/>
			)}
		</div>
		</OverlayManager>
		</HostChromeProvider>
		</ShellApiConfigProvider>
		</PrefsProvider>
	);
};

// =============================================================================
// SIDEBAR WRAPPER — connects Sidebar to OverlayManager context
// =============================================================================

/**
 * Thin wrapper that connects the Sidebar component to the OverlayManager
 * context so it can trigger Account/Settings overlays.
 */
const SidebarWithOverlay: React.FC<{
	themeConfig: ShellConfig['themeConfig'];
	account: ShellConfig['account'];
	hideAppSwitcher?: boolean;
	/** Server-probed edition flag ('saas' capability) — gates SaaS-only menu items. */
	isSaas?: boolean;
}> = ({ themeConfig, account, hideAppSwitcher, isSaas }) => {
	const onOverlay = useOverlay();
	return (
		<Sidebar
			themeConfig={themeConfig}
			account={account}
			hideAppSwitcher={hideAppSwitcher}
			isSaas={isSaas}
			onOverlay={onOverlay}
		/>
	);
};
