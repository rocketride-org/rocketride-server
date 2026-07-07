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
import { ConnectionManager } from '../../connection/connection';
import { ShellApiConfigProvider } from '../../connection/ShellApiConfigContext';
import { getCommonKeys, resolveSettingsForApp } from '../../views/settings/settingsUtils';
import { AppErrorBoundary } from './AppErrorBoundary';
import { OverlayManager, useOverlay } from './OverlayManager';
import Sidebar from './Sidebar';
import StatusBar from './StatusBar';
import LoadingScreen from './LoadingScreen';
import DebugPanel from './DebugPanel';
import type { ShellConfig } from '../../workspace/types';
import { commonStyles } from 'shared/themes/styles';

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
		marginTop: 8,
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
	const { loaded, seeded, appLoading, prefs, activeAppId, loadedApps, settings, appManifest, appLoadErrors, retryApp } = useWorkspace();

	// --- Merge API config: build-time -> setting defaults -> user settings ----
	const mergedApiConfig = useMemo(() => {
		// Collect default values from all app settings declarations
		const settingDefaults = appManifest.reduce<Record<string, string>>((acc, app) => {
			for (const s of app.settings ?? []) {
				if (s.default !== undefined && !(s.key in acc)) acc[s.key] = s.default;
			}
			return acc;
		}, {});
		const base = { ...config.apiConfig, ...settingDefaults, ...settings };
		// Resolve per-app overrides for the active app
		const commonKeys = getCommonKeys(appManifest);
		return resolveSettingsForApp(base, activeAppId, commonKeys);
	}, [config.apiConfig, appManifest, settings, activeAppId]);

	// --- Active app descriptor (undefined while loading) ---------------------
	const activeApp = loadedApps[activeAppId];

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
		if (subGateActive) {
			if (subGateTriggeredRef.current === activeAppId) return;
			subGateTriggeredRef.current = activeAppId;
			ConnectionManager.getInstance().emit('shell:subscribe', { app: activeManifest });
		} else {
			subGateTriggeredRef.current = null;
		}
	}, [subGateActive, activeAppId, activeManifest]);

	// --- Loading guard -------------------------------------------------------
	if (!loaded && !seeded) return null;

	// --- Derived layout info -------------------------------------------------
	const hasSidebar = !!activeApp?.components?.Sidebar;
	const appName = activeApp?.branding?.appName ?? config.apps[0]?.name ?? 'RocketRide';
	// Only show the status bar once the app has actually loaded. During the app-load gap the
	// client area shows the boot rocket (LoadingScreen); rendering the StatusBar there made it
	// blink in and then get covered by home-ui's AuthTransitionPage overlay — a one-frame
	// "flash" between the otherwise-identical loading/transition screens.
	const showStatusBar = activeManifest?.showStatusBar !== false && !!activeApp?.components?.App;

	// --- Render --------------------------------------------------------------
	return (
		<ShellApiConfigProvider config={mergedApiConfig}>
		<OverlayManager>
		<div style={styles.shell}>
			{/* Main row: Sidebar | Client Area | Debug Panel */}
			<div style={styles.main}>
				{/* Sidebar zone */}
				{hasSidebar && (
					<SidebarWithOverlay
						themeConfig={config.themeConfig}
						account={config.account}
						hideAppSwitcher={hideAppSwitcher}
					/>
				)}

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
						) : appLoadErrors[activeAppId] ? (
							<div style={styles.appLoadError}>
								<div style={styles.appLoadErrorTitle}>Could not load {activeManifest?.name ?? activeAppId}</div>
								<div style={styles.appLoadErrorMessage} role="alert">
									{appLoadErrors[activeAppId]}
								</div>
								<button type="button" style={styles.appLoadErrorButton} onClick={() => retryApp(activeAppId)}>
									Retry
								</button>
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
		</ShellApiConfigProvider>
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
}> = ({ themeConfig, account, hideAppSwitcher }) => {
	const onOverlay = useOverlay();
	return (
		<Sidebar
			themeConfig={themeConfig}
			account={account}
			hideAppSwitcher={hideAppSwitcher}
			onOverlay={onOverlay}
		/>
	);
};
