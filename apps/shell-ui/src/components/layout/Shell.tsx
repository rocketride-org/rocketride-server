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
import { useShellConnection } from '../../connection/ConnectionContext';
import { ShellApiConfigProvider } from '../../connection/ShellApiConfigContext';
import { WorkspaceProvider } from '../../workspace/WorkspaceContext';
import type { ShellConfig } from '../../workspace/types';
import { ShellLayout } from './ShellLayout';
import { CheckoutFlow } from './CheckoutFlow';
import { ApiKeyLogin } from './ApiKeyLogin';

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
 * - 'loading'  — bootstrap in progress; show spinner.
 * - 'shell'    — show Shell (identity may be null for marketplace).
 * - 'error'    — unrecoverable auth failure.
 * - 'goodbye'  — post-logout screen for session-locked apps.
 */
type RenderPhase = 'loading' | 'shell' | 'error' | 'goodbye';

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

	// ── Apps — probe catalog + post-auth desktop metadata ─────────────────
	// MF remotes are registered once at bootstrap from the probe — they
	// never change after auth. Post-auth, ConnectResult.apps only adds
	// desktop metadata (appStatus, onDesktop) onto existing probe entries.
	const apps = useMemo(() => {
		if (!identity?.apps?.length) return config.apps;

		// Index desktop metadata by app id for fast lookup
		const desktopById = new Map(
			(identity.apps as Array<{ id: string; appStatus?: string; onDesktop?: boolean }>)
				.map((a) => [a.id, a]),
		);
		// Overlay desktop metadata onto probe entries
		return config.apps.map((a) => {
			const da = desktopById.get(a.id);
			return da ? { ...a, appStatus: da.appStatus, onDesktop: da.onDesktop } : a;
		});
	}, [identity?.apps, config.apps]);

	// =====================================================================
	// BOOTSTRAP — one-time auth sequence on mount
	// =====================================================================

	useEffect(() => {
		mountedRef.current = true;

		(async () => {
			// Initialise the client singleton (idempotent)
			cm.init({
				uri: RR_APIKEY ? undefined : ROCKETRIDE_URI,
				clientName: config.apps[0]?.id ?? 'shell-ui',
				zitadelUrl: RR_ZITADEL_URL,
				zitadelClientId: RR_ZITADEL_CLIENT_ID,
			});

			// Run the optional init callback (e.g. theme initialisation)
			config.onInit?.();

			// Run the auth bootstrap
			try {
				console.log('[Shell] calling bootstrap...');
				const result = await cm.bootstrap({
					apps: config.apps,
					workspaceDir: config.workspaceDir,
					onThemeChange: config.themeConfig?.onThemeChange,
				});
				console.log('[Shell] bootstrap returned, mounted=%s, result=%s', mountedRef.current, !!result);

				if (!mountedRef.current) return;

				if (result) {
					setIdentity(result.result);
					if (result.appId) setActiveAppId(result.appId);
				}
				console.log('[Shell] setting renderPhase=shell');
				setRenderPhase('shell');
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
			if (mountedRef.current) setIdentity(result);
		});
	}, [cm]);

	// Sign-in request from marketplace
	useEffect(() => {
		return cm.on('shell:loginRequest', ({ appId }: { appId?: string }) => {
			if (appId) {
				cm.setPendingAppId(appId);
				loginTargetRef.current = appId;
			}
			if (isSaas) {
				cm.startOAuth();
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
		if (sessionAppId) {
			cm.logout().finally(() => {
				if (mountedRef.current) setRenderPhase('goodbye');
			});
		} else {
			cm.logout().finally(() => { window.location.href = '/'; });
		}
	}, [cm, sessionAppId]);

	useEffect(() => {
		return cm.on('shell:logoutRequest', () => handleLogout());
	}, [cm, handleLogout]);

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

	// Loading
	if (renderPhase === 'loading') {
		return <div style={styles.statusScreen}>Loading...</div>;
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
	const orgId = identity?.organizations?.[0]?.id ?? '';

	return (
		<ShellIdentityContext.Provider value={identity}>
			<ShellApiConfigProvider config={config.apiConfig}>
				<WorkspaceProvider
					client={client}
					isConnected={isConnected}
					apps={apps}
					workspaceDir={config.workspaceDir}
					startupAppId={activeAppId || sessionAppId || defaultAppId}
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
