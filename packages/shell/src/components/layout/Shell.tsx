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
// SHELL — auth bootstrap orchestrator + providers
// =============================================================================
//
// Slim orchestrator that:
//   1. Initialises the ConnectionManager
//   2. Runs the auth bootstrap sequence
//   3. Wraps the ShellLayout in identity/connection/workspace providers
//   4. Renders the CheckoutFlow overlay
//
// The heavy lifting is delegated to:
//   - ShellLayout   — four-zone layout (sidebar, client area, status, debug)
//   - CheckoutFlow  — Stripe checkout wired to shell:subscribe events
//   - OverlayManager — Account/Settings modal dialogs
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ConnectResult } from 'rocketride';
import { ShellIdentityContext } from '../../hooks/useAuthUser';
import { ConnectionManager } from '../../connection/connection';
import { CloudAuthProvider } from '../../auth/CloudAuthProvider';
import { useShellConnection } from '../../connection/ConnectionContext';
import { ShellApiConfigProvider } from '../../connection/ShellApiConfigContext';
import { WorkspaceProvider } from '../workspace/WorkspaceContext';
import type { ShellConfig } from '../workspace/types';
import { ShellLayout } from './ShellLayout';
import { CheckoutFlow } from './CheckoutFlow';
import { ApiKeyLogin } from './ApiKeyLogin';
import LoadingScreen from './LoadingScreen';
import { SS_PENDING_APP_ID, getHomeAppId } from '../../constants';
import { registerAndMapApps, resolveServerEntry, getRegisteredEntry, invalidateAppDescriptor, getLocalAppEntries, setLocalAppsListener, isDevRemote, repointRemote } from '../../util/appLoader';
import { getAppVersionOverrides, setAppVersionOverride, versionedEntryUrl } from '../../util/versionOverride';
import type { ServerAppEntry } from '../../util/appLoader';
import { waitForEmbeddedSession } from '../../util/devMode';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	statusScreen: {
		display: 'flex',
		height: '100vh',
		alignItems: 'center',
		justifyContent: 'center',
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	signInButton: {
		padding: '7px 18px',
		borderRadius: 6,
		border: 'none',
		background: 'var(--rr-brand)',
		color: 'var(--rr-fg-button)',
		fontSize: 13,
		cursor: 'pointer',
	} as CSSProperties,
	// Matches the landing page's "elevated" 3D button — brand fill with a colored
	// bottom shadow that presses down on hover (see LandingNav.tsx).
	elevatedButton: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '7px 18px',
		borderRadius: 6,
		border: 'none',
		backgroundColor: '#00b9ec',
		color: '#ffffff',
		fontSize: 14,
		fontWeight: 600,
		cursor: 'pointer',
		boxShadow: '0 3px 0 0 #00708f',
		transform: 'translateY(0)',
		transition: 'background-color 0.1s ease, box-shadow 0.1s ease, transform 0.1s ease',
	} as CSSProperties,
	goodbyeContainer: {
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		fontFamily: 'var(--rr-font-family)',
		background: 'var(--rr-bg-default)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	goodbyeHeader: {
		display: 'flex',
		justifyContent: 'flex-end',
		alignItems: 'center',
		padding: '12px 24px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,
	goodbyeBody: {
		display: 'flex',
		flex: 1,
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 12,
	} as CSSProperties,
};

// =============================================================================
// RENDER PHASE
// =============================================================================

/**
 * What the component should render during the auth bootstrap sequence.
 *
 * - 'loading'    — bootstrap in progress; show spinner.
 * - 'shell'      — show Shell (identity may be null for marketplace).
 * - 'error'      — unrecoverable auth failure.
 * - 'goodbye'    — post-logout screen for session-locked apps.
 * - 'waitlisted' — authenticated but not yet granted access.
 */
type RenderPhase = 'loading' | 'shell' | 'error' | 'goodbye' | 'waitlisted';

// =============================================================================
// SHELL COMPONENT
// =============================================================================

/**
 * Props for the top-level Shell component.
 */
export interface ShellProps {
	/** Full shell configuration assembled by the host (bootstrap.tsx). */
	config: ShellConfig;
}

/**
 * Top-level Shell component — auth bootstrap + provider composition.
 *
 * On mount, initialises the ConnectionManager and runs the auth bootstrap
 * sequence. Once auth resolves, renders the ShellLayout with providers.
 *
 * @param props.config - The complete ShellConfig assembled by the host.
 */
const Shell: React.FC<ShellProps> = ({ config }) => {
	const cm = ConnectionManager.getInstance();
	const { RR_ZITADEL_URL, RR_ZITADEL_CLIENT_ID } = config.apiConfig;

	// ── Session-locked app ────────────────────────────────────────────────
	const [sessionAppId] = useState<string>(() => {
		const params = new URLSearchParams(window.location.search);
		const fromUrl = params.get('appId') || params.get('appid') || '';
		if (fromUrl) {
			cm.setSessionAppId(fromUrl);
			return fromUrl;
		}
		return cm.getSessionAppId();
	});

	// Deep-link version pin (?appid=X&version=7): seed the session override on
	// mount — NOT in the useState initializer above, which is impure and would
	// fire the write twice under StrictMode. REGISTRY INTS ONLY (semver is
	// developer-controlled display, never a wire identity); a value with any
	// trailing non-digit (?version=7abc) is REJECTED outright rather than
	// silently pinned to 7 by parseInt's prefix parsing. The int IS the whole
	// identity — registration constructs the versioned URL from it directly.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const fromUrl = params.get('appId') || params.get('appid') || '';
		const raw = params.get('version') ?? '';
		if (fromUrl && /^\d+$/.test(raw)) {
			const version = Number.parseInt(raw, 10);
			if (version > 0) setAppVersionOverride(fromUrl, { version });
		}
	}, []);

	// Surface a version pin dropped by the PREVIOUS document: the load
	// failure path clears the override and reloads, so the notice has to
	// survive that reload via sessionStorage.
	useEffect(() => {
		try {
			const dropped = sessionStorage.getItem('rr:droppedOverride');
			if (dropped) {
				sessionStorage.removeItem('rr:droppedOverride');
				console.warn(`[shell] pinned version ${dropped} could not be loaded — reverted to the default version`);
			}
		} catch { /* storage unavailable */ }
	}, []);

	// ── Derived flags ─────────────────────────────────────────────────────
	const isSaas = (config.capabilities ?? []).includes('saas');
	const defaultAppId = getHomeAppId(isSaas);

	// ── React state ───────────────────────────────────────────────────────
	const [renderPhase, setRenderPhase] = useState<RenderPhase>('loading');
	const [identity, setIdentity] = useState<ConnectResult | null>(null);
	const [activeAppId, setActiveAppId] = useState<string | null>(null);
	const [showApiKeyLogin, setShowApiKeyLogin] = useState(false);
	// Embedded (iframe) sign-in prompt — the popup-based OAuth entry point
	const [showEmbeddedSignIn, setShowEmbeddedSignIn] = useState(false);
	// Pending popup-fallback timer for the embedded sign-in (cancelled when
	// the embedder ACKs that it is running its own sign-in flow).
	const loginPopupTimerRef = useRef<number | null>(null);
	const [apiKeyError] = useState<string | null>(null);
	const loginTargetRef = useRef<string | null>(null);
	const mountedRef = useRef(true);

	// ── Connection state ──────────────────────────────────────────────────
	const { isConnected, statusMessage } = useShellConnection();

	// ── Local dev apps — synthetic client-side entries ────────────────────
	// registerLocalApp with meta creates manifest presence for apps the
	// server has never heard of (in-browser compile + inject, zero server
	// round trips). The listener bumps this seq so the memo re-merges.
	const [localAppsSeq, setLocalAppsSeq] = useState(0);
	useEffect(() => {
		setLocalAppsListener(() => setLocalAppsSeq((n) => n + 1));
		return () => setLocalAppsListener(null);
	}, []);

	// ── Apps — probe catalog + post-auth merge ────────────────────────────
	// The pre-auth probe registers public MF remotes. Post-auth, the
	// ConnectResult may include additional apps the user is entitled to
	// (e.g. apps gated by requiredPermissions). Those need to be registered
	// as MF remotes and merged into the app list so they can be launched.
	const apps = useMemo(() => {
		// Synthetic local entries first computed so both return paths merge them
		const withLocal = (list: typeof config.apps): typeof config.apps => {
			const present = new Set(list.map((a) => a.id));
			const locals = getLocalAppEntries().filter((e) => !present.has(e.id));
			return locals.length > 0 ? [...list, ...locals] : list;
		};
		if (!identity?.apps?.length) return withLocal(config.apps);

		// Index ConnectResult apps by id
		const identityApps = identity.apps as Array<ServerAppEntry & { appStatus?: string; onDesktop?: boolean }>;
		const identityById = new Map(identityApps.map((a) => [a.id, a]));

		// Overlay desktop metadata onto probe entries
		const probeIds = new Set(config.apps.map((a) => a.id));
		const merged = config.apps.map((a) => {
			const da = identityById.get(a.id);
			return da ? { ...a, appStatus: da.appStatus, onDesktop: da.onDesktop } : a;
		});

		// Register and append apps that were NOT in the probe (e.g. permission-gated).
		// Registrable = anything resolveServerEntry can produce a load URL for:
		// the wire carries version NUMBERS since the store restructure (entry
		// URLs exist only on dev-overlay rows), so gating on `a.entry` here
		// would silently drop every auth-only app from the workspace map —
		// visible tile, dead click.
		const newApps = identityApps.filter((a) => !probeIds.has(a.id) && a.moduleId && resolveServerEntry(a) !== null);
		if (newApps.length > 0) {
			const registered = registerAndMapApps(newApps);
			for (const app of registered) {
				const da = identityById.get(app.id);
				merged.push(da ? { ...app, appStatus: da.appStatus, onDesktop: da.onDesktop } : app);
			}
		}

		return withLocal(merged);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- localAppsSeq re-merges synthetic entries
	}, [identity?.apps, config.apps, localAppsSeq]);

	// =====================================================================
	// BOOTSTRAP — one-time auth sequence on mount
	// =====================================================================

	useEffect(() => {
		mountedRef.current = true;

		(async () => {
			// Initialize and configure the auth provider (SaaS mode)
			const authProvider = CloudAuthProvider.getInstance();
			if (RR_ZITADEL_URL && RR_ZITADEL_CLIENT_ID) {
				authProvider.initialize({ zitadelUrl: RR_ZITADEL_URL, clientId: RR_ZITADEL_CLIENT_ID });
			}

			// Initialise the client singleton (idempotent). The uri is the
			// probe's resolved endpoints.api when the server declared one;
			// empty falls through to window.location.origin — the page's
			// own host IS the server on every single-host deployment.
			cm.init({
				uri: config.serverUri || undefined,
				clientName: 'Cloud Shell-UI',
				authProvider,
				zitadelUrl: RR_ZITADEL_URL,
				zitadelClientId: RR_ZITADEL_CLIENT_ID,
			});

			// Run the optional init callback (e.g. theme initialisation)
			config.onInit?.();

			// ── Auth-popup role ─────────────────────────────────────────────
			// An EMBEDDED shell cannot run the OAuth redirect (IdPs send
			// frame-ancestors 'none' — the iframe goes blank). Instead the
			// embedded sign-in prompt opens THIS ORIGIN in a popup named
			// 'rrauth': the popup runs the normal top-level round trip, then
			// hands the session token back over BroadcastChannel and closes.
			const bootParams = new URLSearchParams(window.location.search);
			const isAuthPopup = window.name === 'rrauth' || bootParams.get('rrauth') === '1';
			if (isAuthPopup && !bootParams.get('code') && !cm.loadToken()) {
				// Fresh popup: head straight to the IdP (top-level — allowed)
				void cm.startOAuth();
				return;
			}

			// Embedded dev preview: the App Builder host answers this shell's
			// shell:devReady with the definitive session state (rrdev:auth —
			// a token to adopt, or empty for "no session"). Hold the loading
			// phase for that answer so the FIRST boot comes up already
			// authenticated: without the wait the auth gate renders "Sign in
			// required" for the length of the postMessage round-trip and the
			// late token then forces a reload. The timeout only guards
			// embedders that do not speak the protocol; hosts always answer,
			// so the common paths resolve immediately.
			if (window.self !== window.top && !cm.loadToken()) {
				await waitForEmbeddedSession(2000);
				if (!mountedRef.current) return;
			}

			// Run the auth bootstrap
			try {
				const result = await cm.bootstrap({
					apps: config.apps,
					workspaceDir: config.workspaceDir,
					onThemeChange: config.themeConfig?.onThemeChange,
				});
				if (!mountedRef.current) return;

				// Popup completion: deliver the session to the opener's iframe
				// and close — the popup never renders the shell.
				if (isAuthPopup) {
					try {
						const token = cm.loadToken();
						if (token) new BroadcastChannel('rr:auth').postMessage({ type: 'login', token });
					} catch { /* channel unavailable — the user closes the popup */ }
					window.close();
					return;
				}

				if (result) {
					setIdentity(result.result);
					if (result.appId) setActiveAppId(result.appId);
					// Gate on waitlist — authenticated but not yet granted access
					setRenderPhase(result.result?.waitlisted ? 'waitlisted' : 'shell');
				} else {
					// No auth — render unauthenticated shell with the default app
					setRenderPhase('shell');
				}
			} catch (err) {
				console.error('[Shell] Bootstrap failed:', err);
				if (mountedRef.current) setRenderPhase('error');
			}
		})();

		return () => { mountedRef.current = false; };
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// =====================================================================
	// EVENT LISTENERS
	// =====================================================================

	// Repoint remotes whose RESOLVED entry URL changed and evict their
	// cached descriptors. The apps memo above only registers apps ABSENT from
	// the probe set — an account push that changes an EXISTING app's
	// resolution (dev overlay upsert/expiry, a repointed default version)
	// would otherwise leave the old MF container registered and the stale
	// descriptor cached. resolveServerEntry is the ONE resolution (dev URL,
	// or a URL constructed from the tab override / manifest default), and
	// the swap goes through repointRemote — which REFUSES dev-owned
	// containers and containers that have LOADED this document (a loaded
	// container is committed to its version; force re-registering it
	// corrupts the shared getters). A refused loaded container simply keeps
	// running its current code; the next boot registers the new resolution.
	// Runs as an effect (not in the memo) because invalidation sets state.
	useEffect(() => {
		const identityApps = (identity?.apps ?? []) as ServerAppEntry[];
		for (const a of identityApps) {
			if (!a.moduleId || isDevRemote(a.moduleId)) continue;
			const target = resolveServerEntry(a);
			if (!target) continue;
			const registered = getRegisteredEntry(a.moduleId);
			if (registered === undefined || registered === target) continue;
			// Invalidate ONLY when the repoint actually happened — evicting
			// the descriptor of a still-old container would remount the same
			// stale code for nothing.
			if (repointRemote(a.moduleId, target)) {
				invalidateAppDescriptor(a.id);
			}
		}
	}, [identity?.apps]);

	// Reconcile session version overrides once authenticated. The override's
	// version number constructs its stable URL directly (versionedEntryUrl —
	// zero server round trips; entitlement is enforced by the serve route at
	// fetch time), and containers registered elsewhere are repointed — the
	// same reconciliation the entry-change effect above performs for
	// server-side resolution changes. Overrides for apps not (yet) in the
	// manifest stay dormant; an override the serve route refuses simply 404s
	// at load, where the load-failure path drops it.
	useEffect(() => {
		const overrides = getAppVersionOverrides();
		const appIds = Object.keys(overrides);
		if (!identity || appIds.length === 0) return;
		for (const appId of appIds) {
			const app = apps.find((a) => a.id === appId);
			// Dev-owned containers keep the live build; unknown apps keep
			// their override dormant until the app appears in the manifest.
			if (!app || isDevRemote(app.moduleId)) continue;
			const url = versionedEntryUrl(appId, overrides[appId].version);
			if (getRegisteredEntry(app.moduleId) === url) continue;
			// repointRemote refuses a container that already loaded this
			// document (repointing corrupts its shared getters); a full
			// reload re-registers the override's URL at boot, before
			// anything loads.
			if (repointRemote(app.moduleId, url)) {
				invalidateAppDescriptor(appId);
			} else {
				// EVERY automatic reload names itself — a silent reload turns
				// the next loop regression into an afternoon of inference.
				console.warn(`[shell] reloading: version override for ${appId} needs ${url} but its container already loaded`);
				window.location.reload();
				return;
			}
		}
	}, [identity, apps]);

	// Refresh identity on account update
	useEffect(() => {
		return cm.on('shell:accountUpdate', (result: ConnectResult) => {
			if (result.userToken) cm.saveToken(result.userToken);
			if (mountedRef.current) {
				setIdentity(result);
				// Auto-transition off waitlist when an admin grants access
				if (renderPhase === 'waitlisted' && result.waitlisted === false) {
					setRenderPhase('shell');
				}
			}
		});
	}, [cm, renderPhase]);

	// The user's default org changed (this tab or any other connection). The
	// server only NOTIFIES — what to do is this client's choice. The shell's
	// choice: reload, which re-authenticates and re-bootstraps under the
	// user's current default org.
	useEffect(() => {
		return cm.on('shell:orgChanged', () => {
			console.warn('[shell] reloading: default org changed — re-authenticating under the new org');
			window.location.reload();
		});
	}, [cm]);

	// Sign-in request from marketplace
	useEffect(() => {
		return cm.on('shell:loginRequest', ({ appId, register }: { appId?: string; register?: boolean }) => {
			if (appId) {
				cm.setPendingAppId(appId);
				loginTargetRef.current = appId;
			}
			if (isSaas) {
				// EMBEDDED: never navigate the iframe to the IdP (framed IdPs
				// go blank) — show the sign-in prompt whose button opens the
				// popup flow instead.
				if (window.self !== window.top) {
					if (mountedRef.current) setShowEmbeddedSignIn(true);
					return;
				}
				// "Get Started" CTAs pass register:true → Zitadel sign-up form.
				cm.startOAuth(register);
			} else {
				if (mountedRef.current) setShowApiKeyLogin(true);
			}
		});
	}, [cm, isSaas]);

	// Embedded session handoff: an auth popup (or the embedding host's dev
	// tooling) delivers a token over BroadcastChannel — persist it into THIS
	// tab's sessionStorage and reboot into the authenticated flow. The
	// window listener hears the embedder ACK a login request (it is running
	// its own sign-in), cancelling the popup fallback timer.
	useEffect(() => {
		if (window.self === window.top) return;
		const channel = new BroadcastChannel('rr:auth');
		channel.onmessage = (e: MessageEvent) => {
			const data = e.data as { type?: string; token?: string } | undefined;
			if (data?.type === 'login' && data.token) {
				cm.saveToken(data.token);
				console.warn('[shell] reloading: auth popup delivered a session over rr:auth');
				window.location.reload();
			}
		};
		const onWindowMessage = (e: MessageEvent): void => {
			if ((e.data as { type?: string } | undefined)?.type === 'rrdev:loginPending' && loginPopupTimerRef.current !== null) {
				window.clearTimeout(loginPopupTimerRef.current);
				loginPopupTimerRef.current = null;
			}
		};
		window.addEventListener('message', onWindowMessage);
		return () => {
			channel.close();
			window.removeEventListener('message', onWindowMessage);
		};
	}, [cm]);

	// =====================================================================
	// LOGOUT
	// =====================================================================

	const handleLogout = useCallback(() => {
		setIdentity(null);
		// Clear the pending-sign-in flag so HomeApp doesn't get stuck on
		// the auth transition screen when it mounts after logout.
		try { sessionStorage.removeItem('rr:auth:pending'); } catch { /* noop */ }
		if (sessionAppId) {
			cm.logout().finally(() => {
				if (mountedRef.current) setRenderPhase('goodbye');
			});
		} else {
			// Return to the home app before the auth gate re-runs. Otherwise
			// ShellLayout still sees an auth-required app (e.g. Pipeline Builder)
			// active with identity===null and emits shell:loginRequest →
			// startOAuth, bouncing the signing-out user to the Zitadel login
			// screen instead of the logged-out home. switchApp updates the live
			// workspace (and clears the persisted rr:appId via persistActiveApp);
			// setActiveAppId keeps the startup seed in sync for any later remount.
			setActiveAppId(defaultAppId);
			cm.emit('shell:switchApp', { appId: defaultAppId });
			cm.logout().finally(() => {
				if (mountedRef.current) setRenderPhase('shell');
			});
		}
	}, [cm, sessionAppId, defaultAppId]);

	useEffect(() => {
		return cm.on('shell:logoutRequest', () => handleLogout());
	}, [cm, handleLogout]);

	// "Back to Home" on the waitlist screen must LEAVE the session-locked app —
	// not just sign out in place. A session-locked app (e.g. Canvas) is launched
	// via the ?appId= URL param, which Shell reads on mount. logout() clears the
	// token and SS_APP_ID but does NOT strip the URL, so a state-only logout
	// leaves ?appId= in place; any re-init re-seeds the session lock and bootstrap
	// fires OAuth again, dropping a still-waitlisted user right back on this screen
	// (the infinite re-auth loop). Hard-navigate to the clean origin so ?appId= is
	// gone and the next load starts fresh on the home experience. logout() clears
	// the token + session app ids synchronously before its async disconnect, so
	// those are wiped before the navigation unloads the page.
	const handleBackToHome = useCallback(() => {
		try { sessionStorage.removeItem('rr:auth:pending'); } catch { /* noop */ }
		cm.logout();
		window.location.href = window.location.origin + window.location.pathname;
	}, [cm]);

	// =====================================================================
	// SIGN-IN HELPERS
	// =====================================================================

	const startSignIn = useCallback(() => {
		if (isSaas) {
			cm.startOAuth();
		} else {
			setShowApiKeyLogin(true);
		}
	}, [cm, isSaas]);

	const handleApiKeySubmit = useCallback(async (apiKey: string) => {
		const result = await cm.connect(apiKey);
		if (!result) return;
		if (mountedRef.current) {
			const target = loginTargetRef.current;
			loginTargetRef.current = null;
			setIdentity(result);
			setShowApiKeyLogin(false);
			// Set activeAppId so WorkspaceProvider mounts with the correct
			// startupAppId — emitting shell:switchApp here would be lost
			// because WorkspaceContext hasn't mounted its listener yet.
			if (target) setActiveAppId(target);
			setRenderPhase('shell');
		}
	}, [cm]);

	// =====================================================================
	// RENDER — AUTH PHASES
	// =====================================================================

	// Embedded sign-in (iframe previews): the OAuth redirect cannot run in a
	// frame, so a user-gesture button opens this origin as an auth POPUP
	// ('rrauth' — see the bootstrap popup role); the popup hands the session
	// back over BroadcastChannel and this shell reboots authenticated.
	if (showEmbeddedSignIn) {
		return (
			<div style={styles.statusScreen}>
				<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center', maxWidth: 380, padding: '0 24px' }}>
					<div style={{ fontSize: 15, fontWeight: 600, color: 'var(--rr-text-primary)' }}>Sign in required</div>
					<div style={{ fontSize: 12.5 }}>
						This app requires authentication. Sign in opens in a separate window; this preview continues automatically afterwards.
					</div>
					<button
						style={styles.signInButton}
						onClick={() => {
							// Ask the EMBEDDER to run its own sign-in first (the
							// VSCode host authenticates natively and hands the
							// session down via rrdev:auth, which reboots this
							// shell). The popup is the fallback for embedders
							// without an auth flow of their own — if no session
							// arrived after a grace period, this page is still
							// here and opens it.
							try { window.parent.postMessage({ type: 'rrdev:loginRequest' }, '*'); } catch { /* parentless */ }
							loginPopupTimerRef.current = window.setTimeout(() => {
								loginPopupTimerRef.current = null;
								window.open(`${window.location.origin}/?rrauth=1`, 'rrauth', 'popup=yes,width=520,height=780');
							}, 1500);
						}}
					>Sign In</button>
				</div>
			</div>
		);
	}

	// API Key Login (OSS mode)
	if (showApiKeyLogin) {
		return (
			<ApiKeyLogin
				onSubmit={handleApiKeySubmit}
				onCancel={() => { setShowApiKeyLogin(false); loginTargetRef.current = null; }}
				appName={config.loginBranding?.appName ?? 'RocketRide'}
				initialError={apiKeyError}
			/>
		);
	}

	// Error
	if (renderPhase === 'error') {
		if (!isSaas) {
			return (
				<ApiKeyLogin
					onSubmit={handleApiKeySubmit}
					onCancel={() => setRenderPhase('shell')}
					appName={config.loginBranding?.appName ?? 'RocketRide'}
					initialError="Sign in failed. Please try again."
				/>
			);
		}
		return (
			<div style={{
				display: 'flex', height: '100vh', flexDirection: 'column',
				alignItems: 'center', justifyContent: 'center', gap: 16,
				fontFamily: 'var(--rr-font-family)',
			}}>
				<div style={{ color: 'var(--rr-color-error)', fontSize: 15 }}>Sign in failed. Please try again.</div>
				<button onClick={startSignIn} style={styles.signInButton}>Sign In</button>
			</div>
		);
	}

	// Goodbye (session-locked post-logout)
	if (renderPhase === 'goodbye') {
		return (
			<div style={styles.goodbyeContainer}>
				<div style={styles.goodbyeHeader}>
					<button onClick={startSignIn} style={styles.signInButton}>Sign In</button>
				</div>
				<div style={styles.goodbyeBody as CSSProperties}>
					<div style={{ fontSize: 16, fontWeight: 600 }}>You have been signed out</div>
					<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)' }}>
						Close this tab or sign in again to continue.
					</div>
				</div>
			</div>
		);
	}

	// Waitlisted — authenticated but not yet granted access
	if (renderPhase === 'waitlisted') {
		const displayName = identity?.displayName || identity?.email || '';
		return (
			<div style={styles.statusScreen}>
				<div style={{
					display: 'flex', flexDirection: 'column', alignItems: 'center',
					gap: 20, textAlign: 'center', maxWidth: 440, padding: '0 24px',
				}}>
					<div style={{ fontSize: 28, lineHeight: 1.2 }}>
						&#x1F389;
					</div>
					<div style={{ fontSize: 20, fontWeight: 600, color: 'var(--rr-text-primary)' }}>
						Thanks for signing up{displayName ? `, ${displayName}` : ''}!
					</div>
					<div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--rr-text-secondary)' }}>
						Your account is all set. We&apos;re rolling out access in waves and
						you&apos;re in the queue. We&apos;ll send you an email as soon as
						your account is activated &mdash; it shouldn&apos;t be long!
					</div>
					<button
						onClick={handleBackToHome}
						style={styles.elevatedButton}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor = '#0099cc';
							e.currentTarget.style.transform       = 'translateY(3px)';
							e.currentTarget.style.boxShadow        = '0 1px 0 0 #00708f';
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = '#00b9ec';
							e.currentTarget.style.transform       = 'translateY(0)';
							e.currentTarget.style.boxShadow        = '0 3px 0 0 #00708f';
						}}
					>
						Back to Home
					</button>
				</div>
			</div>
		);
	}

	// Loading
	if (renderPhase === 'loading') {
		return <LoadingScreen />;
	}

	// =====================================================================
	// RENDER — SHELL (providers + layout + checkout)
	// =====================================================================

	const resolvedConfig = identity ? {
		...config,
		account: {
			...config.account,
			userName: identity.displayName ?? config.account?.userName,
			userEmail: identity.email ?? config.account?.userEmail,
			onLogout: handleLogout,
		},
	} : config;

	const stripeKey = config.apiConfig.RR_STRIPE_PUBLISHABLE_KEY ?? '';
	const orgId = identity?.organization?.id ?? '';

	return (
		<ShellIdentityContext.Provider value={identity}>
			<ShellApiConfigProvider config={config.apiConfig}>
				<WorkspaceProvider
					apps={apps}
					workspaceDir={config.workspaceDir}
					startupAppId={activeAppId || sessionAppId || (() => { try { return sessionStorage.getItem(SS_PENDING_APP_ID); } catch { return null; } })() || defaultAppId}
					defaultAppId={defaultAppId}
					themeOptions={config.themeConfig.options}
					onThemeChange={config.themeConfig.onThemeChange}
				>
					<ShellLayout
						config={resolvedConfig}
						isConnected={isConnected}
						statusMessage={statusMessage}
						hideAppSwitcher={!!sessionAppId}
						defaultAppId={defaultAppId}
					/>
				</WorkspaceProvider>
			</ShellApiConfigProvider>

			{/* Checkout overlay — renders outside the shell layout */}
			<CheckoutFlow stripeKey={stripeKey} orgId={orgId} />
		</ShellIdentityContext.Provider>
	);
};

export default Shell;
