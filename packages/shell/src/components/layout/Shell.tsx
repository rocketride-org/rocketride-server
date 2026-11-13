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
import type { ConnectResult, SignupProperties } from 'rocketride';
import { ShellIdentityContext } from '../../hooks/useAuthUser';
import { ConnectionManager } from '../../connection/connection';
import { AuthPhase } from '../../types/connection';
import { registerClientOps } from '../../ops/clientOps';
import { registerShellHostOps } from '../../ops/hostOps';
import { CloudAuthProvider } from '../../auth/CloudAuthProvider';
import { useShellConnection } from '../../connection/ConnectionContext';
import { ShellApiConfigProvider } from '../../connection/ShellApiConfigContext';
import { WorkspaceProvider } from '../workspace/WorkspaceContext';
import type { ShellConfig } from '../workspace/types';
import { ShellLayout } from './ShellLayout';
import { CheckoutFlow } from './CheckoutFlow';
import { ApiKeyLogin } from './ApiKeyLogin';
import LoadingScreen from './LoadingScreen';
import { clearTelemetryOnSignOut, initTelemetryHost, markTelemetrySignedIn, setHostTelemetryEnabled, setTelemetryIdentity } from '../../telemetry/host';
import { subscribeConsent } from '../../telemetry/consentState';
import { isInVSCode } from '../../themes/vscode';
import { SignedOutScreen } from './SignedOutScreen';
import { getHomeAppId } from '../../constants';
import { registerAndMapApps, resolveServerEntry, getRegisteredEntry, invalidateAppDescriptor, getLocalAppEntries, setLocalAppsListener, isDevRemote, repointRemote } from '../../util/appLoader';
import { getAppVersionOverrides, setAppVersionOverride, versionedEntryUrl } from '../../util/versionOverride';
import type { ServerAppEntry } from '../../util/appLoader';
import { waitForEmbeddedSession } from '../../util/devMode';
import { devRelayOrigin, lockedAppId, tabSession } from '../../util/devGate';

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
 * - 'waitlisted' — authenticated but not yet granted access.
 */
type RenderPhase = 'loading' | 'shell' | 'error' | 'waitlisted';

// =============================================================================
// ONE-SHOT RELOAD GUARD
// =============================================================================

/** sessionStorage key prefix for spent automatic-reload claims. */
const SS_RELOAD_CLAIM_PREFIX = 'rr:reloadClaim:';

/**
 * Claims the ONE automatic reload allowed for a given (app, target) pair.
 *
 * An automatic reload is only worth taking when the next boot can change the
 * outcome. The claim marker records that this exact pair already spent its
 * reload: a second attempt means the assumption did not hold (a resolution
 * boot rebuilds the same way, or a storage write that failed silently), so
 * the caller must log and carry on rather than reload forever. The marker has
 * to survive the reload, so a tab without usable storage claims nothing — an
 * unbounded reload cannot be bounded without it.
 *
 * @param key - Stable identity of the reload attempt (app id + target URL).
 * @returns True when the marker was newly written AND read back.
 */
function claimReload(key: string): boolean {
	try {
		const ssKey = `${SS_RELOAD_CLAIM_PREFIX}${key}`;
		if (sessionStorage.getItem(ssKey) !== null) return false;
		sessionStorage.setItem(ssKey, '1');
		return sessionStorage.getItem(ssKey) !== null;
	} catch {
		return false;
	}
}

/**
 * Releases a spent reload claim once its target is in place.
 *
 * The reload did its job, so the pair may claim another one later in the
 * session (a second override switch onto the same version, say).
 *
 * @param key - The same identity passed to {@link claimReload}.
 */
function releaseReload(key: string): void {
	try {
		sessionStorage.removeItem(`${SS_RELOAD_CLAIM_PREFIX}${key}`);
	} catch { /* storage unavailable — nothing was claimed */ }
}

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

	// ── Telemetry host ────────────────────────────────────────────────────
	// Boot the one telemetry transport from the probe-served config. Keyless
	// (OSS, or no RR_POSTHOG_PUBLISHABLE_KEY on the server) this is a no-op
	// and the posthog chunk is never fetched. In a VS Code webview the consent
	// source is the editor's own telemetry setting ('host'); in the cloud it
	// is the device's stored record ('stored') — never both.
	useEffect(() => {
		initTelemetryHost({
			key: config.apiConfig.RR_POSTHOG_KEY ?? '',
			host: config.apiConfig.RR_POSTHOG_HOST ?? '',
			consentSource: isInVSCode() ? 'host' : 'stored',
		});
		// The sign-in/out lifecycle: capture modes and identity follow, and a
		// sign-out drops the queue's hold (one session's captures never forward
		// under the next account).
		const offLogin = cm.on('shell:login', () => {
			markTelemetrySignedIn();
		});
		const offLogout = cm.on('shell:logout', () => {
			clearTelemetryOnSignOut();
			setTelemetryIdentity(false, null);
		});
		// Consent is platform state: decisions (either surface, either tab)
		// fan out on the bus so apps can follow without owning a store.
		const offConsent = subscribeConsent((state, origin) => {
			cm.emit('shell:consentChange', { state, origin });
		});
		// In a VS Code webview the editor's telemetry setting is the one
		// consent switch; the extension host mirrors it on a retained topic.
		let offHostSetting: (() => void) | undefined;
		if (isInVSCode()) {
			offHostSetting = cm.subscribe('shell:telemetryEnabled', (snapshot) => {
				const s = snapshot as { enabled?: boolean } | null;
				setHostTelemetryEnabled(s?.enabled === true);
			});
		}
		return () => {
			offLogin();
			offLogout();
			offConsent();
			offHostSetting?.();
		};
	}, [cm, config.apiConfig.RR_POSTHOG_KEY, config.apiConfig.RR_POSTHOG_HOST]);

	// ── Session-locked app ────────────────────────────────────────────────
	// The tab session owns the URL parsing and per-tab persistence; authored
	// preview pages (blob-served by the App Builder) instead carry their
	// identity in the injected dev boot config — there is no URL to read.
	const [sessionAppId] = useState<string>(() => lockedAppId());

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
			// Number(), not parseInt(): a digit string too long for a safe
			// integer must be rejected (parseInt rounds, and overlong input
			// reaches Infinity — which passes a bare `> 0` check).
			const version = Number(raw);
			if (Number.isSafeInteger(version) && version > 0) {
				setAppVersionOverride(fromUrl, { version });
			}
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

	// The resolved identity drives telemetry's signed-in state and the opaque
	// id the consented instance identifies by (never an email or name).
	// identity === null means "signed out" only once the bootstrap has
	// resolved: while it runs (loading) or after it failed (error) the state
	// is unknown, and unknown must stay off the known-signed-out path (rich
	// capture, signed-out capture config, the stored-identity reset).
	const authResolved = renderPhase !== 'loading' && renderPhase !== 'error';
	useEffect(() => {
		if (!authResolved) return;
		setTelemetryIdentity(identity !== null, identity?.userId ?? null);
	}, [identity, authResolved]);
	const [activeAppId, setActiveAppId] = useState<string | null>(null);
	const [showApiKeyLogin, setShowApiKeyLogin] = useState(false);
	// Embedded (iframe) sign-in prompt — the popup-based OAuth entry point
	const [showEmbeddedSignIn, setShowEmbeddedSignIn] = useState(false);
	// Pending popup-fallback timer for the embedded sign-in (cancelled when
	// the embedder ACKs that it is running its own sign-in flow).
	const [apiKeyError] = useState<string | null>(null);
	const loginTargetRef = useRef<string | null>(null);
	const mountedRef = useRef(true);

	// ── In-process workspace rescope ──────────────────────────────────────
	// True while the shell is switching workspaces: the workspace subtree is
	// unmounted (a loading screen holds its place) between the teardown and
	// the re-authenticated remount. The epoch keys WorkspaceProvider so a
	// completed rescope remounts every store against the new workspace.
	const [rescoping, setRescoping] = useState(false);
	const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
	const rescopeRunningRef = useRef(false);
	// An orgChanged that arrives while a rescope is in flight — the running
	// pass may already have reconnected under an older default, so one more
	// pass runs when it finishes instead of dropping the notification.
	const rescopePendingRef = useRef<string | null>(null);

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
		// Local (dev) entries merge on both return paths. In dev the WORKSPACE
		// manifest is the truth: a locally-registered id REPLACES the server's
		// row wholesale — the registration IS the row (appStatus 'dev',
		// onDesktop true, billing gating moot in dev). No field-by-field
		// overlay to reason about; while the registration lives, the server's
		// opinion of this app simply does not exist. Ids the server has never
		// heard of append whole, exactly as before.
		const withLocal = (list: typeof config.apps): typeof config.apps => {
			const locals = getLocalAppEntries();
			if (locals.length === 0) return list;
			// IDENTITY CONTINUITY: the registration replaces the server row
			// wholesale, but where the dev metadata is SILENT about the icon
			// (URL-convention self-registration posts no manifest), the app
			// must not lose its face mid-session — inherit the registry's
			// stable icon URL. Dev metadata still wins wherever it speaks.
			const byId = new Map(list.map((a) => [a.id, a]));
			const patched = locals.map((l) => (!l.icon && byId.get(l.id)?.icon ? { ...l, icon: byId.get(l.id)!.icon } : l));
			const localIds = new Set(locals.map((e) => e.id));
			return [...list.filter((a) => !localIds.has(a.id)), ...patched];
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
			// Initialize and configure the auth provider (SaaS mode).
			// relayOrigin arms the dev relay for top-level dev shells
			// (terminal dev loop, F5 preview) — '' everywhere else, which
			// leaves the sign-in flow byte-identical to before.
			const authProvider = CloudAuthProvider.getInstance();
			if (RR_ZITADEL_URL && RR_ZITADEL_CLIENT_ID) {
				authProvider.initialize({ zitadelUrl: RR_ZITADEL_URL, clientId: RR_ZITADEL_CLIENT_ID, relayOrigin: devRelayOrigin() });
			}

			// Initialise the client singleton (idempotent). The uri is the
			// probe's resolved endpoints.api when the server declared one;
			// empty falls through to window.location.origin — the page's
			// own host IS the server on every single-host deployment.
			cm.init({
				uri: config.serverUri || undefined,
				clientName: 'Cloud Shell-UI',
				authProvider,
			});

			// FRAMEWORK ROOT: this realm owns the engine connection, so the
			// brokered client surface registers HERE — request('client.*')
			// resolves in-process for this realm and for any attached spokes.
			// Idempotent across remounts (already-registered ops are kept).
			registerClientOps(cm.ops(), cm);
			// The SHELL's own host.* ops — those whose capability belongs to
			// the shell and whose hooks are contract surface, so they cannot
			// depend on each host remembering to register them. The ops the
			// HOST APP owns are separate and live with the host
			// (apps/rocket-ui/src/ops, apps/vscode/src/ops), declared in
			// shared/ops/hostOps.ts. See ops/hostOps.ts for why the split
			// exists and which side a new op belongs on.
			registerShellHostOps(cm.ops(), cm);

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
					// No identity. THE top-level auth decision, made BEFORE the
					// shell phase is ever entered — nothing below this switch has
					// rendered yet, so nothing can flash. A tab locked to an
					// auth-required app (unknown manifest = auth-required, the
					// platform default) goes straight to login from the loading
					// screen, UNLESS the user explicitly signed out / abandoned a
					// sign-in here (the shell then renders the signed-out page)
					// or a failure is latched (the recovery dialog owns it).
					const phase = cm.getConnectionStatus().authPhase;
					const signedOutHeld = phase === AuthPhase.SIGNED_OUT || (phase === AuthPhase.AUTHORIZING && !cm.isSignInRedirectPending());
					const lockedEntry = config.apps.find((a) => a.id === sessionAppId);
					const lockedNeedsAuth = !!sessionAppId && sessionAppId !== defaultAppId && (lockedEntry ? lockedEntry.authenticated !== false : true);
					if (lockedNeedsAuth && !signedOutHeld && !cm.getConnectionStatus().lastFailure) {
						cm.emit('shell:loginRequest', { appId: sessionAppId, auto: true });
						return; // stay on the loading screen; the navigation takes the page
					}
					// Signed-out render is legitimate here (public app, home, or
					// the signed-out page): enter the shell phase.
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
			const claimKey = `${appId}@${url}`;
			if (getRegisteredEntry(app.moduleId) === url) {
				// The registration already sits at the override's URL — any
				// reload spent getting here did its job, so free the claim.
				releaseReload(claimKey);
				continue;
			}
			// repointRemote refuses a container that already loaded this
			// document (repointing corrupts its shared getters); a full
			// reload re-registers the override's URL at boot, before
			// anything loads.
			if (repointRemote(app.moduleId, url)) {
				invalidateAppDescriptor(appId);
			} else if (claimReload(claimKey)) {
				// EVERY automatic reload names itself — a silent reload turns
				// the next loop regression into an afternoon of inference.
				console.warn(`[shell] reloading: version override for ${appId} needs ${url} but its container already loaded`);
				window.location.reload();
				return;
			} else {
				// The reload for this exact target was already spent (or cannot
				// be recorded), so boot demonstrably does not resolve to it —
				// reloading again would only loop. Keep the loaded container.
				console.error(`[shell] version override for ${appId} still needs ${url} after its one reload — leaving the loaded container in place`);
			}
		}
	}, [identity, apps]);

	// (The waitlist screen needs no telemetry side-load any more: the shell owns
	// the transport and connection.ts reports auth:complete on the shell's own
	// reporter — it lands even when no app ever mounts.)

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
	// choice: an IN-PROCESS rescope — announce, unmount the workspace subtree
	// (its stores flush on the old connection), re-authenticate (the server
	// resolves the new default org), then remount everything under a fresh
	// epoch key. Any step failing falls back to the old full page reload —
	// degraded, never stranded. Why not just reload: a reload tears down the
	// whole JS world to change one scope; the rescope keeps the page, the MF
	// containers, and the session, and lands the user back where the switch
	// started (the Profile section re-opens via the sessionStorage flag the
	// picker sets — a flag deliberately chosen so the reload FALLBACK lands
	// there too).
	useEffect(() => {
		const runRescope = (orgId: string): void => {
			rescopeRunningRef.current = true;
			void (async () => {
				try {
					cm.emit('shell:workspaceWillChange', { orgId });
					// Unmount the workspace subtree FIRST: unmount cleanups flush
					// pending workspace writes while the OLD connection is still
					// up — flushing after reconnect would write workspace-A state
					// into workspace B.
					setRescoping(true);
					// One macrotask so the unmount commit (and its synchronous
					// cleanup effects) run before the connection drops.
					await new Promise((resolve) => setTimeout(resolve, 0));
					const token = cm.loadToken();
					if (!token) throw new Error('no session token to re-authenticate with');
					await cm.disconnect();
					const result = await cm.connect(token);
					if (!result) throw new Error('re-authentication under the new workspace returned no identity');
					if (!mountedRef.current) return;
					// Fresh identity = the new org's app manifest/entitlements;
					// the epoch key remounts WorkspaceProvider so every store
					// re-reads the new workspace's data.
					setIdentity(result);
					setWorkspaceEpoch((e) => e + 1);
					setRescoping(false);
					cm.emit('shell:workspaceChanged', { orgId });
				} catch (err) {
					console.warn('[shell] reloading: in-process workspace rescope failed — falling back to a full reload', err);
					window.location.reload();
				} finally {
					rescopeRunningRef.current = false;
					// A switch arrived mid-rescope: reconnect once more so the
					// tab ends scoped to the LATEST default org.
					const pending = rescopePendingRef.current;
					if (pending !== null) {
						rescopePendingRef.current = null;
						runRescope(pending);
					}
				}
			})();
		};
		return cm.on('shell:orgChanged', ({ orgId }: { orgId: string }) => {
			if (rescopeRunningRef.current) {
				rescopePendingRef.current = orgId;
				return;
			}
			runRescope(orgId);
		});
	}, [cm]);

	// The embedded sign-in KICK — deterministic, no timers: try the popup
	// ON the click gesture, the one moment it can succeed. A blocked popup
	// is a SYNCHRONOUS fact (VS Code webviews return null without throwing)
	// and means the embedder owns sign-in — ask it to run its native flow
	// (it answers with rrdev:auth). Shared by the prompt screen's button
	// and by loginRequest handling for requests that already carry a
	// gesture.
	const kickEmbeddedSignIn = useCallback(() => {
		const popup = window.open(`${window.location.origin}/?rrauth=1`, 'rrauth', 'popup=yes,width=520,height=780');
		if (!popup) {
			try { window.parent.postMessage({ type: 'rrdev:loginRequest' }, '*'); } catch { /* parentless */ }
		}
	}, []);

	// Sign-in request from marketplace
	useEffect(() => {
		return cm.on('shell:loginRequest', ({ appId, register, auto, signupProperties }: { appId?: string; register?: boolean; auto?: boolean; signupProperties?: SignupProperties }) => {
			if (appId) {
				cm.setPendingAppId(appId);
				loginTargetRef.current = appId;
			}
			if (isSaas) {
				// EMBEDDED: never navigate the iframe to the IdP (framed IdPs
				// go blank). A USER-GESTURE request (the signed-out screen's
				// button) kicks the popup flow directly — a second prompt
				// demanding a second click is a speed bump. The AUTO gate has
				// no gesture yet (popup rules), so it shows the prompt whose
				// button provides one.
				if (window.self !== window.top) {
					if (!auto) kickEmbeddedSignIn();
					else if (mountedRef.current) setShowEmbeddedSignIn(true);
					return;
				}
				// "Get Started" CTAs pass register:true; it is reported on auth:start (every
				// flow lands on the IdP login page, which offers Register). The auth:start
				// fact and the round-trip stamp are raised inside startOAuth, behind its
				// one-shot guard, for this and every other entry.
				cm.startOAuth(register, { appId, auto, signupProperties });
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
		// (rrdev:loginPending — the embedder's ACK — needs no listener since
		// the popup-or-embedder choice became synchronous; embedders keep
		// posting it for older shells, and it is simply ignored here.)
		return () => {
			channel.close();
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
		if (sessionAppId || tabSession().dev) {
			// SESSION-LOCKED tab (deployed ?appId= deep link or dev preview):
			// stay exactly where you are. The signed-out state has honest
			// surfaces of its own — ShellLayout renders the shared
			// SignedOutScreen ("You are signed out of <app>" + the app's
			// icon) for an auth-required app, and a public app simply renders
			// signed out. The retired 'goodbye' phase showed a bespoke
			// RocketRide-chromed page here instead — off-brand for a deep-app
			// tab and a THIRD signed-out surface to keep consistent.
			cm.logout().finally(() => {
				if (mountedRef.current) setRenderPhase('shell');
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
		// The SAME surface as the top-level signed-out hold — only the
		// sign-in MECHANICS differ (the popup flow; a frame cannot run the
		// redirect), stated in the note. Identity resolves like everywhere
		// else: probe manifest first, then the dev registration.
		const lockedEntry = config.apps.find((a) => a.id === sessionAppId) ?? getLocalAppEntries().find((a) => a.id === sessionAppId);
		return (
			<SignedOutScreen
				appName={lockedEntry?.name ?? tabSession().appName ?? sessionAppId ?? 'this app'}
				iconUrl={lockedEntry?.icon ?? tabSession().appIcon}
				note="Sign in opens in a separate window; this preview continues automatically afterwards."
				onSignIn={kickEmbeddedSignIn}
			/>
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
						your account is activated. It shouldn&apos;t be long!
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
				{/* Mid-rescope the workspace subtree is OUT of the tree (its
				    unmount flushed the old workspace's stores on the old
				    connection); the epoch key makes a finished rescope remount
				    everything against the new workspace's data. */}
				{rescoping ? (
					<LoadingScreen />
				) : (
					<WorkspaceProvider
						key={workspaceEpoch}
						apps={apps}
						workspaceDir={config.workspaceDir}
						startupAppId={activeAppId || sessionAppId || cm.getPendingAppId() || defaultAppId}
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
				)}
			</ShellApiConfigProvider>

			{/* Checkout overlay — renders outside the shell layout */}
			<CheckoutFlow stripeKey={stripeKey} orgId={orgId} />
		</ShellIdentityContext.Provider>
	);
};

export default Shell;
