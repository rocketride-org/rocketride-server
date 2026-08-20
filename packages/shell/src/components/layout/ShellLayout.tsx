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
import { useWorkspace } from '../workspace/WorkspaceContext';
import { PrefsProvider } from '../contexts/PrefsContext';
import { ConnectionManager } from '../../connection/connection';
import { isDevPreviewPending } from '../../util/appLoader';
import { ShellApiConfigProvider } from '../../connection/ShellApiConfigContext';
import { AppErrorBoundary } from './AppErrorBoundary';
import { OverlayManager, useOverlay } from './OverlayManager';
import { HostChromeProvider, useHostChromeState } from './HostChromeContext';
import { AppFrame } from './AppFrame';
import RocketRideWordmark from '../../assets/icons/RocketRideWordmark';
import Sidebar, { useHasSidebarContent } from './Sidebar';
import { BxMenu } from '../BoxIcon';
import { useIsCompact } from '../../hooks/useIsCompact';
import { CompactNavProvider } from './CompactNavContext';
import StatusBar from './StatusBar';
import LoadingScreen from './LoadingScreen';
import DebugPanel from './DebugPanel';
import { ConnectionErrorBanner } from './ConnectionErrorBanner';
import type { ShellConfig } from '../workspace/types';
import { commonStyles } from '../../themes/styles';

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
/**
 * True for the stale-platform failure class: shared-module negotiation
 * breakage (and the TDZ artifact a failed first attempt leaves behind).
 * Usually the PAGE outlived a platform rebuild — the live MF runtime
 * negotiated against bundles since replaced on disk — which one reload
 * fixes; only when it recurs immediately is the bundle truly mismatched.
 *
 * @param raw - The raw error message recorded by WorkspaceContext.
 * @returns True when the failure is shared-module/TDZ shaped.
 */
function isStalePlatformError(raw: string): boolean {
	return /RUNTIME-012|shared module|shareKey|before initialization/i.test(raw);
}

function friendlyLoadError(raw: string, name: string): string {
	// Shared-module negotiation failures — and the TDZ artifact a failed first
	// attempt leaves behind — mean the bundle was built against a different
	// platform build than the one now serving it.
	if (isStalePlatformError(raw)) {
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
	/** Faint brand wordmark pinned to the client area's lower-left; shown only
	    while a chrome-less (no sidebar AND no status bar) app owns the client
	    area. The wrapper carries the theme text color so the SVG
	    (fill=currentColor) tracks theme changes without a palette-mode
	    observer. */
	fullScreenWatermark: {
		position: 'absolute',
		left: 16,
		bottom: 12,
		opacity: 0.15,
		pointerEvents: 'none',
		color: 'var(--rr-text-primary)',
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

	// --- The navigation, when there is no room for a column ------------------
	// Below the breakpoint the sidebar leaves the flex row and becomes a drawer
	// over the client area. The state lives here because this is the one place
	// that can hand the same answer to the sidebar and to the hamburger; two
	// subscriptions to one media query can disagree for a frame mid-drag, and a
	// sidebar that thinks it is a drawer while the layout thinks it is a column
	// renders a blank screen.
	const isCompact = useIsCompact();
	const [drawerOpen, setDrawerOpen] = useState(false);

	// Crossing the breakpoint, either way, puts the drawer away. It cannot race a
	// deliberate open — nobody is tapping the hamburger at the instant a window
	// crosses 1024 — so no "the user meant it" latch is needed, and the desktop
	// rail state is never written, so coming back up restores exactly the column
	// that was left behind.
	useEffect(() => {
		setDrawerOpen(false);
		if (isCompact) ConnectionManager.getInstance().emit('shell:sidebarCollapsing', {});
	}, [isCompact]);

	// Anything that moves the user somewhere else closes it. `shell:switchApp`
	// and `shell:openOverlay` are the two that matter; `shell:sidebarCollapsing`
	// is here so an app that navigates internally can ask for the same thing
	// using an event that already exists, rather than a new API.
	useEffect(() => {
		if (!isCompact) return undefined;
		const bus = ConnectionManager.getInstance();
		const close = () => setDrawerOpen(false);
		const offs = [
			bus.on('shell:switchApp', close),
			bus.on('shell:openOverlay', close),
			bus.on('shell:viewActivated', close),
		];
		return () => offs.forEach((off) => off?.());
	}, [isCompact]);

	// The app changing is a navigation even when no event announced it.
	useEffect(() => {
		setDrawerOpen(false);
	}, [activeAppId]);

	// Escape, while it is open. `defaultPrevented` first: a dialog above the
	// drawer — a DetailPanel at z-index 1500, a confirm — has already handled
	// the key, and closing the nav underneath it would be the wrong answer.
	useEffect(() => {
		if (!isCompact || !drawerOpen) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !event.defaultPrevented) setDrawerOpen(false);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [isCompact, drawerOpen]);

	const compactNav = useMemo(
		() => ({ isCompact, drawerOpen, requestClose: () => setDrawerOpen(false) }),
		[isCompact, drawerOpen],
	);

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

	// ── Stale-build self-heal ─────────────────────────────────────────────
	// A stale-platform load failure (isStalePlatformError) usually means this
	// PAGE outlived a platform rebuild: bundles were replaced on disk under a
	// live MF runtime, and one reload brings host + remotes back coherent.
	// Reload ONCE automatically instead of stranding the user on the
	// "rebuilt or redeployed" dialog; a sessionStorage guard ensures that if
	// the SAME app fails the same way right after that reload — a REAL
	// contract mismatch — the dialog shows as before. If storage is
	// unavailable the guard cannot prevent a reload loop, so don't auto-heal.
	const [autoReloading, setAutoReloading] = useState(false);
	useEffect(() => {
		const failedAppId = loadFailure?.appId ?? (appLoadErrors[activeAppId] ? activeAppId : null);
		if (!failedAppId) return;
		if (!isStalePlatformError(appLoadErrors[failedAppId] ?? '')) return;
		try {
			// Guard keyed PER APP (appId → last-reload epoch ms): a single
			// {appId, at} record let alternating failures defeat the guard —
			// after reloading for app A, a stale failure of app B overwrote the
			// record, and A's next failure no longer matched, looping inside the
			// 60s window. A per-app map gives every app its own cooldown, so a
			// SAME-app failure right after its reload (a REAL contract mismatch)
			// still surfaces the dialog while distinct apps can't reset each
			// other's guard.
			const guard = JSON.parse(sessionStorage.getItem('rr.staleReload') ?? '{}') as Record<string, number>;
			const lastReload = guard[failedAppId];
			if (typeof lastReload === 'number' && Date.now() - lastReload < 60_000) return;
			guard[failedAppId] = Date.now();
			sessionStorage.setItem('rr.staleReload', JSON.stringify(guard));
		} catch {
			return;
		}
		console.log('[SL] stale platform bundle for', failedAppId, '— auto-reloading once to resync');
		setAutoReloading(true);
		window.location.reload();
	}, [appLoadErrors, activeAppId, loadFailure]);

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

	// --- Active app mount contract -------------------------------------------
	// Mounting is AppFrame's job: the descriptor's ONE `app` component is
	// rendered raw, and the app declares its layout via <AppLayout> props
	// (sidebar presence, status bar). The layout only needs to know whether
	// there is an app UI at all.
	const hasAppUi = !!activeApp?.app;

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
	// Watchdog latch: set when the client area has shown the boot rocket past a
	// grace period without ever resolving to real content (a mounted app, a
	// load error, or the not-found surface). Flips the render off the endless
	// spinner and onto a diagnostic surface — see the watchdog effect and the
	// loading guard below.
	const [bootStalled, setBootStalled] = useState(false);

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
		// A latched connection failure owns the recovery UX: while the banner is
		// showing (network down / session expired), bouncing the visitor into an
		// OAuth redirect would hide it — and with the server unreachable the
		// redirect can't complete anyway. The banner's actions restart the flow.
		const failureLatched = !!ConnectionManager.getInstance().getConnectionStatus().lastFailure;
		if (!suppressGateRef.current && !identity && !failureLatched && activeManifest && activeManifest.authenticated !== false && activeAppId !== defaultAppId) {
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

	// --- Boot watchdog -------------------------------------------------------
	// The client area must always resolve to SOMETHING — a mounted app, a load
	// error, or the not-found surface. A seed/manifest that never completes
	// would otherwise strand the user on the boot rocket forever with no
	// explanation. If no first content has appeared after a grace period, latch
	// bootStalled so the render falls through to a diagnostic surface instead
	// of spinning indefinitely. Harmless once content exists: firstContentRef
	// short-circuits the timer, and the real-content branches take precedence
	// over the stalled fallthrough.
	const BOOT_STALL_MS = 15_000;
	useEffect(() => {
		if (firstContentRef.current || bootStalled) return;
		const timer = setTimeout(() => {
			if (!firstContentRef.current) setBootStalled(true);
		}, BOOT_STALL_MS);
		return () => clearTimeout(timer);
	}, [loaded, seeded, activeAppId, hasAppUi, bootStalled]);

	// --- Loading guard -------------------------------------------------------
	// Workspace still hydrating: hold the SAME phase-anchored rocket as the
	// boot LoadingScreen — returning null here put a blank frame between two
	// otherwise-continuous loading screens. Once the watchdog latches, stop
	// holding here so the render can reach the diagnostic surface below.
	if (!loaded && !seeded && !bootStalled) return <LoadingScreen />;

	// First boot: stay full-screen on the rocket until the first activation
	// resolves to real content — the mounted app, or a terminal error surface
	// (load failure, unknown app id) that the user must see. A pending dev
	// preview counts as still-loading: its registration self-corrects when
	// the embedder's injection lands (see the client-area branch below).
	const devPending = isDevPreviewPending(activeAppId);
	// The active app id resolves to nothing on this server. Gated on a SETTLED
	// signal so it never fires during the brief empty-while-loading window:
	//   • appManifest.length > 0 — the manifest loaded and has no such id
	//     (a stale per-tab session id, or a renamed/removed app), OR
	//   • loaded — the workspace finished hydrating with an empty manifest, OR
	//   • bootStalled — the watchdog gave up waiting (a manifest that never
	//     arrived, e.g. the SaaS home app on a server built without it).
	// loadDescriptor returns false silently for unknown ids, so without this
	// the user is stranded on the boot rocket forever.
	const activeAppUnresolvable = !devPending && !activeManifest
		&& (appManifest.length > 0 || loaded || bootStalled);
	const hasFirstContent =
		hasAppUi ||
		(!devPending && !!appLoadErrors[activeAppId]) ||
		activeAppUnresolvable;
	if (hasFirstContent) firstContentRef.current = true;
	if (!firstContentRef.current) {
		// A latched failure (server unreachable, session expired) can strand the
		// boot on this rocket forever — no app content will ever arrive to flip
		// the latch. Surface the recovery banner OVER the rocket so the user
		// gets the Retry / Sign in path instead of an indefinite spinner.
		return (
			<>
				<ConnectionErrorBanner />
				<LoadingScreen />
			</>
		);
	}

	// --- Derived layout info -------------------------------------------------
	// The sidebar is always mounted (inside HostChromeProvider) and self-hides
	// when it has no content — i.e. when the app's AppLayout declares no
	// sidebar, the client area spans full width.
	const appName = activeApp?.branding?.appName ?? config.apps[0]?.name ?? 'RocketRide';
	// Only consider the status bar once the app has actually loaded. During the app-load gap
	// the client area shows the boot rocket (LoadingScreen); rendering the StatusBar there made
	// it blink in and then get covered by home-ui's AuthTransitionPage overlay — a one-frame
	// "flash" between the otherwise-identical loading/transition screens. Whether the bar
	// actually renders is the app's declaration (AppLayout showStatus/status), read by
	// StatusBarWithChrome from the chrome slot.
	const considerStatusBar = hasAppUi;

	// --- Render --------------------------------------------------------------
	return (
		<PrefsProvider value={prefsApi}>
		<ShellApiConfigProvider config={mergedApiConfig}>
		<HostChromeProvider>
		<OverlayManager>
		<CompactNavProvider value={compactNav}>
		<div style={styles.shell}>
			<ConnectionErrorBanner />
			{/* The way to the navigation once it is a drawer. Renders nothing for
			    an app that has no sidebar to open. */}
			{isCompact && <CompactChromeBar open={drawerOpen} onOpen={() => setDrawerOpen(true)} />}

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
						{hasAppUi && activeApp ? (
							// The framing control mounts the descriptor's `app`
							// component raw; the app declares its layout inside.
							<AppErrorBoundary key={activeAppId} appName={appName}>
								<AppFrame
									app={activeApp}
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
						) : appLoadErrors[activeAppId] && !autoReloading ? (
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
						) : activeAppUnresolvable ? (
							// The active app id resolves to nothing on this server: the
							// manifest is settled (loaded, non-empty, or the watchdog gave
							// up) and has no entry for it — a stale per-tab session id from
							// a different shell flavour, a renamed/removed app, or (empty
							// manifest) an app this deployment simply does not have, e.g.
							// the SaaS home app on a server built without it. Say so with
							// an exit; never strand the user on the splash (loadDescriptor
							// returns false silently for unknown ids).
							<div style={styles.appLoadError}>
								<div style={styles.appLoadErrorTitle}>
									{activeAppId === defaultAppId ? 'Home app unavailable' : 'App not found'}
								</div>
								<div style={styles.appLoadErrorMessage} role="alert">
									{activeAppId === defaultAppId
										? `This server has no home app (“${activeAppId}”) installed. It may not have been built and registered on this deployment.`
										: `This server has no app with the id “${activeAppId}”. It may have been renamed, removed, or belong to a different RocketRide deployment.`}
								</div>
								<div style={styles.appLoadErrorActions}>
									{activeAppId === defaultAppId ? (
										// "Go to Home" would loop straight back here. retryApp
										// can't help either: this branch requires NO manifest
										// entry, so loadDescriptor returns false immediately and
										// nothing changes. Reload the page instead so a refreshed
										// manifest (with the home app) can arrive.
										<button type="button" style={styles.appLoadErrorButton} onClick={() => window.location.reload()}>
											Try Again
										</button>
									) : (
										// Home is the guaranteed exit — $HOME resolves to the platform default
										<button type="button" style={styles.appLoadErrorButton} onClick={() => ConnectionManager.getInstance().emit('shell:switchApp', { appId: '$HOME' })}>
											Go to Home
										</button>
									)}
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

					{/* Faint brand mark for chrome-less (no sidebar, no status bar) apps;
					    gated on a mounted app UI so it never overlays boot/loading/error
					    surfaces. */}
					{hasAppUi && <FullScreenWatermark />}
				</div>

				{/* Load-failure modal — a switch-to-app failed while the current app
				    stayed on screen; shown over it instead of a page takeover. */}
				{loadFailure && !autoReloading && (
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

			{/* Status bar — presence is the app's AppLayout declaration */}
			{considerStatusBar && (
				<StatusBarWithChrome
					appName={appName}
					isConnected={isConnected}
					isAuthenticated={identity !== null}
					statusMessage={statusMessage}
					onToggleBottomPanel={() => {}}
				/>
			)}
		</div>
		</CompactNavProvider>
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

// =============================================================================
// FULL-SCREEN WATERMARK — faint brand mark for chrome-less apps
// =============================================================================

/**
 * Faint RocketRide wordmark overlaid on the client area's lower-left corner.
 *
 * Presence mirrors the chrome's self-hide rules, inverted: an app whose
 * AppLayout declares neither a sidebar nor a status bar registers nothing in
 * the host-chrome slots, the standard chrome (and the wordmark in its header)
 * is absent, and the app spans the full client area — so the brand mark
 * surfaces here instead. Any registered chrome zone (sidebar OR status bar)
 * already anchors the shell's identity on screen, so the watermark withdraws.
 * Must render inside HostChromeProvider.
 *
 * Purely decorative: pointer events pass through and it is hidden from the
 * accessibility tree.
 */
const FullScreenWatermark: React.FC = () => {
	const { sidebarContent, statusBarContent } = useHostChromeState();
	// Any registered chrome zone means shell branding is on screen — no mark.
	if (sidebarContent != null || statusBarContent != null) return null;
	return (
		<div style={styles.fullScreenWatermark} aria-hidden="true">
			{/* currentColor fills from the wrapper's --rr-text-primary */}
			<RocketRideWordmark height={15} color="currentColor" />
		</div>
	);
};

// =============================================================================
// STATUS BAR WRAPPER — connects StatusBar to the host-chrome app slot
// =============================================================================

/**
 * Thin wrapper that reads the app-declared status-bar content from the
 * host-chrome state (it must render INSIDE HostChromeProvider, which
 * ShellLayout itself mounts) and decides the bar's presence: the bar exists
 * exactly when the app declared it (AppLayout `showStatus`/`status`, which
 * registers a non-null node in the slot).
 */
const StatusBarWithChrome: React.FC<{
	appName: string;
	isConnected: boolean;
	isAuthenticated: boolean;
	statusMessage: string | null;
	onToggleBottomPanel: () => void;
}> = (props) => {
	const { statusBarContent } = useHostChromeState();
	// Presence rule: the app declared a status bar, or there is no bar.
	if (statusBarContent == null) return null;
	return <StatusBar {...props} appContent={statusBarContent} />;
};
// COMPACT CHROME BAR — the only way to the navigation below the breakpoint
// =============================================================================

/**
 * A 44px bar with a hamburger, shown only while the sidebar is a drawer.
 *
 * Above `styles.main` rather than floating over the client area: eleven apps
 * draw their own top-left content — grids, canvases, chat headers — and a
 * floating button would sit on top of some of them. A bar costs every app 44px
 * below the breakpoint and is the only placement that cannot occlude anything.
 *
 * Defined here, inside `HostChromeProvider`, so it can ask the same question
 * the sidebar asks: an app with no sidebar gets no bar and no hamburger, and is
 * byte-for-byte unchanged at every width.
 *
 * @param props.open - Whether the drawer is currently showing.
 * @param props.onOpen - Asks for the drawer.
 * @returns The bar, or nothing when this app has no navigation.
 */
const CompactChromeBar: React.FC<{ open: boolean; onOpen: () => void }> = ({ open, onOpen }) => {
	const hasSidebar = useHasSidebarContent();
	const { activeAppId, loadedApps, appManifest } = useWorkspace();
	if (!hasSidebar) return null;

	// The app's own branding first, its manifest entry second — the same order
	// the client area uses for the error boundary's label.
	const title =
		loadedApps[activeAppId]?.branding?.appName
		?? appManifest.find((entry) => entry.id === activeAppId)?.name
		?? '';

	return (
		<div
			style={{
				display: 'flex', alignItems: 'center', gap: 8,
				height: 44, flexShrink: 0, padding: '0 4px',
				background: 'var(--rr-bg-paper)',
				borderBottom: '1px solid var(--rr-border)',
			}}
		>
			<button
				type="button"
				aria-label="Open navigation"
				aria-expanded={open}
				aria-controls="rr-shell-sidebar"
				onClick={onOpen}
				style={{
					display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
					width: 44, height: 44, padding: 0,
					border: 'none', background: 'transparent', cursor: 'pointer',
					color: 'var(--rr-text-primary)',
				}}
			>
				<BxMenu size={22} />
			</button>
			<span style={{ fontSize: 15, fontWeight: 600, color: 'var(--rr-text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{title}
			</span>
		</div>
	);
};
