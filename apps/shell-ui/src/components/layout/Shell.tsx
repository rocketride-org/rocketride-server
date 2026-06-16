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
import { WorkspaceProvider } from '../../workspace/WorkspaceContext';
import type { ShellConfig } from '../../workspace/types';
import { ShellLayout } from './ShellLayout';
import { CheckoutFlow } from './CheckoutFlow';
import { ApiKeyLogin } from './ApiKeyLogin';
import LoadingScreen from './LoadingScreen';
import { SS_PENDING_APP_ID } from '../../constants';
import { registerAndMapApps } from '../../lib/appLoader';
import type { ServerAppEntry } from '../../lib/appLoader';

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
	const { ROCKETRIDE_URI, RR_APIKEY, RR_ZITADEL_URL, RR_ZITADEL_CLIENT_ID } = config.apiConfig;

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

	// ── Derived flags ─────────────────────────────────────────────────────
	const isSaas = (config.capabilities ?? []).includes('saas');
	const defaultAppId = isSaas ? 'rocketride.home' : 'rocketride.hello';

	// ── React state ───────────────────────────────────────────────────────
	const [renderPhase, setRenderPhase] = useState<RenderPhase>('loading');
	const [identity, setIdentity] = useState<ConnectResult | null>(null);
	const [activeAppId, setActiveAppId] = useState<string | null>(null);
	const [showApiKeyLogin, setShowApiKeyLogin] = useState(false);
	const [apiKeyError] = useState<string | null>(null);
	const loginTargetRef = useRef<string | null>(null);
	const mountedRef = useRef(true);

	// ── Connection state ──────────────────────────────────────────────────
	const { client, isConnected, statusMessage } = useShellConnection();

	// ── Apps — probe catalog + post-auth merge ────────────────────────────
	// The pre-auth probe registers public MF remotes. Post-auth, the
	// ConnectResult may include additional apps the user is entitled to
	// (e.g. apps gated by requiredPermissions). Those need to be registered
	// as MF remotes and merged into the app list so they can be launched.
	const apps = useMemo(() => {
		if (!identity?.apps?.length) return config.apps;

		// Index ConnectResult apps by id
		const identityApps = identity.apps as Array<ServerAppEntry & { appStatus?: string; onDesktop?: boolean }>;
		const identityById = new Map(identityApps.map((a) => [a.id, a]));

		// Overlay desktop metadata onto probe entries
		const probeIds = new Set(config.apps.map((a) => a.id));
		const merged = config.apps.map((a) => {
			const da = identityById.get(a.id);
			return da ? { ...a, appStatus: da.appStatus, onDesktop: da.onDesktop } : a;
		});

		// Register and append apps that were NOT in the probe (e.g. permission-gated)
		const newApps = identityApps.filter((a) => !probeIds.has(a.id) && a.entry && a.moduleId);
		if (newApps.length > 0) {
			const registered = registerAndMapApps(newApps);
			for (const app of registered) {
				const da = identityById.get(app.id);
				merged.push(da ? { ...app, appStatus: da.appStatus, onDesktop: da.onDesktop } : app);
			}
		}

		return merged;
	}, [identity?.apps, config.apps]);

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

			// Initialise the client singleton (idempotent)
			cm.init({
				uri: RR_APIKEY ? undefined : ROCKETRIDE_URI,
				clientName: 'Cloud Shell-UI',
				authProvider,
				zitadelUrl: RR_ZITADEL_URL,
				zitadelClientId: RR_ZITADEL_CLIENT_ID,
			});

			// Run the optional init callback (e.g. theme initialisation)
			config.onInit?.();

			// Run the auth bootstrap
			try {
				const result = await cm.bootstrap({
					apps: config.apps,
					workspaceDir: config.workspaceDir,
					onThemeChange: config.themeConfig?.onThemeChange,
				});
				if (!mountedRef.current) return;

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

	// Sign-in request from marketplace
	useEffect(() => {
		return cm.on('shell:loginRequest', ({ appId, register }: { appId?: string; register?: boolean }) => {
			if (appId) {
				cm.setPendingAppId(appId);
				loginTargetRef.current = appId;
			}
			if (isSaas) {
				// "Get Started" CTAs pass register:true → Zitadel sign-up form.
				cm.startOAuth(register);
			} else {
				if (mountedRef.current) setShowApiKeyLogin(true);
			}
		});
	}, [cm, isSaas]);

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
					client={client}
					isConnected={isConnected}
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
