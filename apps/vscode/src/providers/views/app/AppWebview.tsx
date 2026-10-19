// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppWebview — the VS Code App Builder screen (page-app webview).
 *
 * THIN by design (decision D7): the entire App Builder surface — the
 * DEVELOP | DEPLOY | STORE views, their panes, forms, and state — lives in
 * shared's `modules/appdev`. This webview is a BUS REALM: its identity is
 * stamped into the served HTML (`data-rr-app`), boot state rides
 * `host.appbuilder.load`, the SDK half of its IAppBuilderHost rides the
 * brokered `client.app.*` ops (the shared adapter), host verbs ride
 * `host.appbuilder.*`, and the dev-session feeds arrive on the app's
 * `appbuilder:app:<id>:*` topics. The only remaining window.postMessage is
 * the rrdev:* mini-protocol INTO the preview iframe (cross-origin shell).
 *
 * Capability flags select the VSCode variant: no Code pane (files are
 * native — bind, don't sync), native-files strip.
 */

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionManager } from 'shell';
import { AppBuilderScreen } from 'shared/tools/appdev/views';
import { createBusAppBuilderHost } from 'shared/tools/appdev';
import type { AppErrorRow, AppEventRow, AppSummary, BuildStatusTick, ConsoleRow, IAppBuilderHost, ListingDraft, PreflightCheck, WatchStatus } from 'shared/tools/appdev';
import type { AppBuilderStage } from 'shared/tools/appdev';
import type { AppBuilderLoadPayload } from 'shared/ops/appBuilderOps';

// =============================================================================
// IDENTITY + WIRING
// =============================================================================

/** The panel's app id — stamped into the served HTML by the host, present
 *  before any script ran. */
const STAMPED_APP_ID = document.body.dataset.rrApp ?? '';

// The staged sign-in resolves when the browser flow lands a session — give
// it the host's own five-minute window plus slack.
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;

// Per-feed backlog cap. Feed rows can arrive before the consuming pane
// subscribes (see the buffers below), so each feed retains its most recent
// rows for replay. Bounded so a long-running dev session cannot grow it
// without limit — a full pnpm install + rsbuild pass is a few hundred lines,
// well inside this ceiling.
const FEED_BACKLOG = 500;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	root: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		flexDirection: 'column',
		background: 'var(--rr-bg-default)',
	},
	// borderRadius:'inherit' down the chain: when the App Builder's device
	// frame rounds its glass, the iframe must round WITH it — Chromium does
	// not reliably apply an ancestor's rounded overflow clip to a composited
	// iframe, so the rounding is carried onto the iframe element itself.
	iframeWrap: {
		position: 'absolute',
		inset: 0,
		borderRadius: 'inherit',
		overflow: 'hidden',
	},
	iframe: {
		width: '100%',
		height: '100%',
		border: 'none',
		background: 'var(--rr-bg-default)',
		borderRadius: 'inherit',
	},
	loading: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	},
	// Initializing pane (pre-iframe): headline + one-line phase detail.
	initBody: {
		textAlign: 'center',
		maxWidth: 460,
		padding: '0 24px',
	},
	initTitle: {
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-default)',
		marginBottom: 4,
	},
	initDetail: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	},
	// Elapsed-in-phase ticker under the phase line (stall visibility).
	initElapsed: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
		fontVariantNumeric: 'tabular-nums',
	},
	// Live tail of the latest Console row — what the dev session is DOING.
	initTail: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginTop: 12,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	// Unresponsive-shell overlay actions (Retry / Show anyway).
	overlayButton: {
		fontFamily: 'inherit',
		fontSize: 12,
		padding: '4px 12px',
		borderRadius: 3,
		border: '1px solid transparent',
		cursor: 'pointer',
		background: 'var(--rr-brand)',
		color: 'var(--rr-text-on-brand, #ffffff)',
	},
	overlayButtonGhost: {
		fontFamily: 'inherit',
		fontSize: 12,
		padding: '4px 12px',
		borderRadius: 3,
		border: '1px solid var(--rr-border)',
		cursor: 'pointer',
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
	},
};

// =============================================================================
// PREVIEW INITIALIZING
// =============================================================================

/**
 * Pre-iframe placeholder: the dev session is still coming up (pnpm install,
 * rsbuild dev startup, first build). The preview iframe intentionally does
 * NOT mount yet — a shell booted now could only race a dev server that is
 * not listening, and the first descriptor load would fail with RUNTIME-004.
 *
 * While waiting, the pane ticks the elapsed time in the current phase and
 * tails the latest Console row \u2014 a multi-minute first build (pnpm resolving,
 * rsbuild's first compile) shows what it is actually doing instead of a
 * frozen label, and a genuinely hung session is distinguishable by a tail
 * that stops advancing while the clock keeps counting.
 *
 * On error the pane says WHY, center-screen: the host supplies the reason
 * with every error status (server unreachable, not connected, the failing
 * pnpm line, a compile failure). The generic console pointer is only the
 * fallback for a producer that failed to say.
 *
 * @param props.status - The latest watch status (state + error reason).
 * @param props.subscribeConsole - Console feed (backlog replayed first) whose newest row is tailed.
 */
const PreviewInitializing: React.FC<{ status: WatchStatus; subscribeConsole: (fn: (row: ConsoleRow) => void) => () => void }> = ({ status, subscribeConsole }) => {
	// Newest console row \u2014 the live "what is it doing" line. The backlog
	// replay on subscribe lands the latest pre-mount row immediately.
	const [tail, setTail] = useState<ConsoleRow | null>(null);
	useEffect(() => subscribeConsole((row) => setTail(row)), [subscribeConsole]);
	// Seconds spent in the CURRENT phase; restarts on every phase change.
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		setElapsed(0);
		const started = Date.now();
		const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
		return () => clearInterval(timer);
	}, [status.state]);
	const error = status.state === 'error';
	return (
		<div style={styles.iframeWrap}>
			<div style={styles.loading}>
				<div style={styles.initBody}>
					<div style={styles.initTitle}>{error ? 'Dev session failed' : 'Initializing Services'}</div>
					<div style={styles.initDetail}>{error ? (status.reason ?? 'See the Console pane for the error output.') : status.state === 'building' ? 'Starting the dev server\u2026' : status.state === 'idle' ? 'Restarting the dev server\u2026' : 'Installing dependencies\u2026'}</div>
					{!error && elapsed >= 5 && <div style={styles.initElapsed}>{formatElapsed(elapsed)} in this phase</div>}
					{!error && tail && <div style={styles.initTail} title={tail.text}>{tail.text}</div>}
				</div>
			</div>
		</div>
	);
};

/**
 * Formats whole seconds for the Initializing pane's phase clock.
 *
 * @param sec - Whole seconds elapsed.
 * @returns "45s" under a minute, "1m 05s" above.
 */
function formatElapsed(sec: number): string {
	return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

// =============================================================================
// PREVIEW IFRAME
// =============================================================================

/**
 * The live shell preview. Kept `visibility:hidden` until the shell's dev
 * hooks post `shell:devReady` (hidden panels report zero dimensions with
 * display:none — never that), with a timeout fallback so a shell without
 * dev hooks still appears.
 *
 * Once the shell is ready AND the dev server's entry URL is known, the dev
 * remote is injected straight into the shell over postMessage — the shell
 * wires the MF remote itself, so the preview works against ANY shell with
 * dev hooks, regardless of which server it came from.
 *
 * @param props.url - The shell URL (`<engine>/?appid=<id>&rrdev=1`).
 * @param props.reloadSeq - Bumping remounts the iframe (a full reload).
 * @param props.app - App facts for the injected registration.
 * @param props.devEntry - The dev server's remoteEntry.js URL, when up.
 */
const PreviewFrame: React.FC<{ url: string; reloadSeq: number; app: AppSummary | null; devEntry: string; devManifest?: Record<string, unknown>; authToken: string; inheritAuth: boolean; explicitAuthSeq: number }> = ({ url, reloadSeq, app, devEntry, devManifest, authToken, inheritAuth, explicitAuthSeq }) => {
	// Shell page lifecycle: 'loading' until the shell's dev hooks post
	// devReady; 'unresponsive' when they never arrive (server down, wrong
	// URL — the iframe would be sitting on a silent chrome error page);
	// 'ready' reveals the frame.
	const [phase, setPhase] = useState<'loading' | 'ready' | 'unresponsive'>('loading');
	// Bumped per retry: remounts the iframe with a FRESH cache-buster so
	// every attempt is a clean parent-initiated navigation (an errored
	// frame cannot be re-navigated from script, and a cached error page
	// must not satisfy the reload).
	const [attemptSeq, setAttemptSeq] = useState(0);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	// Every credential-bearing post targets the shell origin explicitly so a
	// navigated-away frame can never receive the token.
	const shellOrigin = ((): string => {
		try {
			return new URL(url).origin;
		} catch {
			return url;
		}
	})();
	const ready = phase === 'ready';

	// Latest registration facts, readable from the message listener without
	// re-subscribing: the shell can boot ANY number of times inside one
	// iframe mount (its auth flow navigates internally), and every boot
	// must be re-injected.
	const registrationRef = useRef<{ app: AppSummary | null; devEntry: string; devManifest?: Record<string, unknown>; authToken: string; inheritAuth: boolean }>({ app: null, devEntry: '', authToken: '', inheritAuth: true });
	registrationRef.current = { app, devEntry, devManifest, authToken, inheritAuth };
	// Whether THIS shell page has been injected already. Every injection
	// spawns a live container instance with its own HMR client — injecting
	// per rebuild leaves zombie instances whose hot-update hashes are gone
	// (endless ChunkLoadError "missing" + full reloads). One container per
	// page; HMR keeps IT current; re-injection only on explicit fallback.
	const injectedRef = useRef(false);

	/**
	 * Answers the shell's session handshake with the DEFINITIVE state: the
	 * credential when Inherit Auth allows it, empty for "no session". The
	 * shell reconciles idempotently (adopt/drop + reboot when the state
	 * differs, no-op when it matches), so re-answering is always safe.
	 */
	const postAuthState = useCallback((): void => {
		const { authToken: token, inheritAuth: inherit } = registrationRef.current;
		iframeRef.current?.contentWindow?.postMessage({ type: 'rrdev:auth', token: inherit && token ? token : '' }, shellOrigin);
	}, [shellOrigin]);

	/** Posts the dev-remote registration into the (current) preview shell. */
	const inject = useCallback((): void => {
		const { app: a, devEntry: entry, devManifest } = registrationRef.current;
		if (!a || !entry) return;
		injectedRef.current = true;
		iframeRef.current?.contentWindow?.postMessage(
			{
				type: 'rrdev:registerRemote',
				appId: a.id,
				moduleId: a.moduleId,
				name: a.name,
				entry,
				// The WORKSPACE manifest rides the registration — in dev it is
				// the truth for the shell's app metadata (name, icon path under
				// the /dev/ prefix, settings schema), not the server registry.
				manifest: devManifest,
			},
			shellOrigin
		);
	}, [shellOrigin]);

	// Inherit Auth toggled live: re-answer with the resulting state — the
	// token (shell reboots authenticated) or empty (shell drops its session
	// and reboots signed out; apps demanding auth then run the preview's
	// own OAuth cycle).
	const inheritMountedRef = useRef(false);
	React.useEffect(() => {
		if (!inheritMountedRef.current) {
			inheritMountedRef.current = true;
			return;
		}
		postAuthState();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fires on toggle only
	}, [inheritAuth]);

	// Credential arriving AFTER the boot answer (slow resolve in the host,
	// sign-in completing in another flow): re-answer so the running shell
	// adopts it — otherwise the session would sit here unused until the
	// next boot.
	const authMountedRef = useRef(false);
	React.useEffect(() => {
		if (!authMountedRef.current) {
			authMountedRef.current = true;
			return;
		}
		postAuthState();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fires on credential change only
	}, [authToken]);

	// Explicit sign-in result: deliver the credential regardless of the
	// Inherit Auth gate — the user clicked Sign In.
	React.useEffect(() => {
		if (explicitAuthSeq === 0) return;
		const { authToken: token } = registrationRef.current;
		if (token) iframeRef.current?.contentWindow?.postMessage({ type: 'rrdev:auth', token }, shellOrigin);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fires per explicit sign-in only
	}, [explicitAuthSeq]);

	// Reveal on the shell's devReady handshake. A shell that never answers
	// is a FAILED page (server down, wrong URL — the frame silently sits on
	// a chrome error page), so the timeout declares it UNRESPONSIVE and the
	// pane says so center-screen instead of revealing a blank error frame.
	// EVERY devReady re-injects — internal shell navigations (auth redirect,
	// user reload) boot a fresh page that knows nothing of the dev remote.
	React.useEffect(() => {
		setPhase('loading');
		const onMsg = (e: MessageEvent): void => {
			if (e.data && typeof e.data === 'object' && (e.data as { type?: string }).type === 'shell:devReady') {
				// A devReady is a FRESH page (boot, auth navigation, the HMR
				// client's own failure reload) — it knows nothing; inject.
				setPhase('ready');
				injectedRef.current = false;
				// Answer the session handshake FIRST and unconditionally: the
				// fresh shell holds its boot behind this answer, and it must
				// not wait for registration facts that can lag (the dev
				// server entry can land seconds later).
				postAuthState();
				inject();
			}
		};
		window.addEventListener('message', onMsg);
		const fallback = setTimeout(() => setPhase((p) => (p === 'ready' ? p : 'unresponsive')), 6000);
		return () => {
			window.removeEventListener('message', onMsg);
			clearTimeout(fallback);
		};
	}, [reloadSeq, attemptSeq, url, inject, postAuthState]);

	// Unresponsive auto-retry: keep re-attempting politely (fresh iframe +
	// fresh cache-buster each time) so a server coming back turns the
	// message into a live preview without any click.
	React.useEffect(() => {
		if (phase !== 'unresponsive') return;
		const timer = setTimeout(() => setAttemptSeq((n) => n + 1), 8000);
		return () => clearTimeout(timer);
	}, [phase]);

	// First-arrival inject: the rsbuild banner (and thus the entry URL) can
	// land seconds after devReady on first boot. LATER entry updates do NOT
	// inject — the live container's HMR client owns updates; injecting per
	// rebuild is what bred the zombie-container hash churn.
	React.useEffect(() => {
		if (ready && devEntry && app && !injectedRef.current) inject();
	}, [ready, devEntry, app, inject]);

	// Manifest-only change (package.json saved, same container): re-post the
	// registration so the shell refreshes metadata (name/icon/settings) —
	// registerLocalApp is re-entrant; no container re-injection happens.
	// Keyed by CONTENT: every build mints a fresh manifest object, and an
	// identity-keyed effect would force-re-register per build (zombie-
	// container churn) even when nothing in the manifest changed.
	const manifestKeyRef = useRef<string | null>(null);
	React.useEffect(() => {
		const key = JSON.stringify(devManifest ?? null);
		const prev = manifestKeyRef.current;
		manifestKeyRef.current = key;
		if (prev === null || prev === key) return;
		if (ready && injectedRef.current) inject();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fires on manifest change only
	}, [devManifest]);

	// Fresh cache-buster per attempt: the _ts from the init payload is fixed
	// for the panel's lifetime, so retries mint their own.
	const attemptUrl = attemptSeq === 0 ? url : `${url.replace(/([?&])_ts=\d+/, '$1_ts=' + Date.now())}`;

	return (
		<div style={styles.iframeWrap}>
			{phase === 'loading' && <div style={styles.loading}>Loading preview…</div>}
			{phase === 'unresponsive' && (
				<div style={styles.loading}>
					<div style={{ textAlign: 'center', maxWidth: 460, padding: '0 24px' }}>
						<div style={styles.initTitle}>Preview shell not responding</div>
						<div style={styles.initDetail}>The shell at {shellOrigin} did not load. Is the server running? Retrying automatically; the preview appears as soon as it answers.</div>
						<div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
							<button type="button" style={styles.overlayButton} onClick={() => setAttemptSeq((n) => n + 1)}>
								Retry now
							</button>
							<button type="button" style={styles.overlayButtonGhost} onClick={() => setPhase('ready')}>
								Show anyway
							</button>
						</div>
					</div>
				</div>
			)}
			<iframe key={`${reloadSeq}:${attemptSeq}`} ref={iframeRef} src={attemptUrl} style={{ ...styles.iframe, visibility: ready ? 'visible' : 'hidden' }} allow="clipboard-read; clipboard-write" />
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/** A feed listener registry: subscribe returns an unsubscribe. */
type Registry<T> = Set<(row: T) => void>;

const AppWebview: React.FC = () => {
	// ── Init payload from the extension host ────────────────────────────
	const [app, setApp] = useState<AppSummary | null>(null);
	const [previewUrl, setPreviewUrl] = useState('');
	// hasReviewLadder defaults true (the gated flow) until init declares the
	// server; an OSS server flips it off and @public publishes directly.
	const [capabilities, setCapabilities] = useState({ hasNativeFiles: true, canDebug: false, hasReviewLadder: true });
	const [initialStage, setInitialStage] = useState<AppBuilderStage>('dashboard');
	const [reloadSeq, setReloadSeq] = useState(0);
	const [devEntry, setDevEntry] = useState('');
	// The workspace manifest riding the dev registration (dev = local truth)
	const [devManifest, setDevManifest] = useState<Record<string, unknown> | undefined>(undefined);

	// LOCAL-FIRST: the preview loads through the dev server's passthrough
	// proxy, so its URL is the DEV ORIGIN carrying the init URL's path and
	// query (?appid, rrdev, rrsession). Derived, never configured — the
	// frame only renders once the dev entry is known (previewLive gates on
	// it), so the origin is always available by then. Falls back to the
	// init URL while no dev entry exists (e.g. watch disabled).
	const proxyPreviewUrl = React.useMemo(() => {
		if (!previewUrl) return '';
		if (!devEntry) return previewUrl;
		try {
			const init = new URL(previewUrl);
			return `${new URL(devEntry).origin}${init.pathname}${init.search}`;
		} catch {
			return previewUrl;
		}
	}, [previewUrl, devEntry]);
	// Latest watch status — drives the Initializing pane's phase line and,
	// on error, its center-screen reason.
	const [watchStatus, setWatchStatus] = useState<WatchStatus>({ state: 'installing' });
	// True while the dev session is genuinely serving: latched at a
	// successful build with a known dev entry, and RELEASED when the server
	// stops serving ('idle' — stopped or exited — or 'error'), so a cold
	// restart shows the phase pane instead of a dead shell holding on a
	// black page. 'building' deliberately keeps the latch: incremental
	// rebuilds are HMR's job, and flipping to Initializing on every save
	// would flash the preview away.
	const [previewLive, setPreviewLive] = useState(false);
	// MUST stay above the conditional loading return so hook order is
	// render-stable.
	React.useEffect(() => {
		if (!previewLive && devEntry && watchStatus.state === 'ok') setPreviewLive(true);
		else if (previewLive && (watchStatus.state === 'idle' || watchStatus.state === 'error')) setPreviewLive(false);
	}, [previewLive, devEntry, watchStatus]);
	// The extension's auth credential — handed to the preview shell so apps
	// that require authentication render with a real signed-in session.
	const [authToken, setAuthToken] = useState('');
	// Cache-buster-stripped dev entry — detects dev-server ORIGIN changes
	// (watch restarts land on new ports; the old container is dead).
	const prevDevEntryBaseRef = useRef('');
	// Inherit Auth (toolbar checkbox): hand this window's session to the
	// preview, or let it run its own OAuth cycle. Ref-mirrored so message
	// listeners and inject() read the live value.
	const [inheritAuth, setInheritAuthState] = useState(true);
	// Explicit Sign In in flight: the next credential is user-requested and
	// bypasses the Inherit Auth gate; the seq delivers it to the iframe.
	const pendingExplicitLoginRef = useRef(false);
	const [explicitAuthSeq, setExplicitAuthSeq] = useState(0);
	// App Builder UI preferences (per-workspace, per-app): seeded from
	// appdev:init, written back over appdev:pref. A ref, not state — reads
	// are synchronous via host.getPref and never drive a re-render here.
	const prefsRef = useRef<Record<string, unknown>>({});

	// ── Feed registries — stable across renders ─────────────────────────
	const eventListeners = useRef<Registry<AppEventRow>>(new Set());
	const consoleListeners = useRef<Registry<ConsoleRow>>(new Set());
	const errorListeners = useRef<Registry<AppErrorRow>>(new Set());
	const watchListeners = useRef<Registry<WatchStatus>>(new Set());

	// ── Feed backlogs — retained history for replay on late subscribe ───
	// Rows can arrive before the consuming pane has subscribed: VSCode queues
	// webview messages until view:ready, but the Console/Errors pane may still
	// be unmounted (the Preview tab is active during dev-session startup, where
	// pnpm/rsbuild output and failures are emitted). Without a backlog those
	// rows reach the webview, find no listener, and are dropped — so opening
	// the Console afterward shows nothing. Each feed retains a bounded backlog
	// and replays it on subscribe, mirroring how the watch STATUS is retained
	// (setWatchStatus) and replayed. The watch feed needs no backlog: its
	// latest value already lives in component state.
	const eventBuffer = useRef<AppEventRow[]>([]);
	const consoleBuffer = useRef<ConsoleRow[]>([]);
	const errorBuffer = useRef<AppErrorRow[]>([]);

	// Push a row into a bounded backlog (oldest dropped past FEED_BACKLOG),
	// then fan it out to the currently-subscribed listeners. Stable identities
	// ([] deps) so message handlers can depend on them without churn.
	const emitEvent = useCallback((row: AppEventRow) => {
		const buf = eventBuffer.current;
		buf.push(row);
		if (buf.length > FEED_BACKLOG) buf.shift();
		for (const fn of eventListeners.current) fn(row);
	}, []);
	const emitConsole = useCallback((row: ConsoleRow) => {
		const buf = consoleBuffer.current;
		buf.push(row);
		if (buf.length > FEED_BACKLOG) buf.shift();
		for (const fn of consoleListeners.current) fn(row);
	}, []);
	const emitError = useCallback((row: AppErrorRow) => {
		const buf = errorBuffer.current;
		buf.push(row);
		if (buf.length > FEED_BACKLOG) buf.shift();
		for (const fn of errorListeners.current) fn(row);
	}, []);

	// ── Server build-status ticker (apaevt_build_status relay) ──────────
	// Latest word per version is RETAINED (not a backlog): a late-mounted
	// DEPLOY view replays the current words, and '' (the success clear)
	// removes the retained entry so nothing stale replays.
	const buildStatusListeners = useRef<Set<(tick: BuildStatusTick) => void>>(new Set());
	const buildTicks = useRef<Map<number, string>>(new Map());
	const emitBuildStatus = useCallback((tick: BuildStatusTick) => {
		if (typeof tick.version === 'number') {
			if (tick.status === '') buildTicks.current.delete(tick.version);
			else buildTicks.current.set(tick.version, tick.status);
		}
		for (const fn of buildStatusListeners.current) fn(tick);
	}, []);

	// ── Deployment-change relay (apaevt_deploy for this app) ────────────
	const deployChangedListeners = useRef<Set<() => void>>(new Set());

	// Account identity generation — bumped when the connection's account/org
	// changes. Salts the host memo below, so every [host]-keyed data effect
	// (developer namespace, publish rail, teams) re-fetches under the new
	// identity without remounting the screen.
	const [accountSeq, setAccountSeq] = useState(0);

	// ── The bus: boot state + topics + realm-local event derivations ─────
	const cm = ConnectionManager.getInstance();
	useEffect(() => {
		const appId = STAMPED_APP_ID;

		// Boot state — pulled, with one retry when the first attempt raced
		// the realm attachment.
		const applyLoad = (payload: AppBuilderLoadPayload): void => {
			// Prefs must land BEFORE the App Builder screen mounts (app gates
			// the render below), so host.getPref is synchronous by the time
			// the views initialize their state from it.
			prefsRef.current = payload.prefs ?? {};
			setApp(payload.app);
			setPreviewUrl(payload.previewUrl);
			setCapabilities(payload.capabilities);
			if (payload.stage) setInitialStage(payload.stage);
		};
		void cm.request('host.appbuilder.load', { app: appId } as never).then(
			(payload) => applyLoad(payload as AppBuilderLoadPayload),
			() => {
				const offRetry = cm.on('shell:connected', () => {
					offRetry();
					void cm.request('host.appbuilder.load', { app: appId } as never).then((payload) => applyLoad(payload as AppBuilderLoadPayload), () => {});
				});
			}
		);

		// The build ticker + compile feed are org-scoped DEPLOY-type pushes:
		// without this monitor the server filters every apaevt_build* event
		// out for this connection. Broker-refcounted; the SDK replays a
		// successful monitor across reconnects on its own.
		const monitorArmed = { current: false };
		const armMonitor = (): void => {
			if (monitorArmed.current) return;
			monitorArmed.current = true;
			cm.request('client.addMonitor', { key: { token: '*' }, types: ['deploy'] } as never).catch(() => {
				// Not connected yet — re-arm on the next connect.
				monitorArmed.current = false;
			});
		};
		armMonitor();

		const feedTime = (): string => new Date().toLocaleTimeString(undefined, { hour12: false });

		const offs = [
			// Watch/build status (RETAINED — replay covers a reloaded webview;
			// an undefined delivery is the close-time retraction).
			cm.subscribe(`appbuilder:app:${appId}:watch`, (snap) => {
				const status = snap as WatchStatus | undefined;
				if (!status) return;
				setWatchStatus(status);
				for (const fn of watchListeners.current) fn(status);
			}),
			// The dev server's entry (RETAINED). Same server, new build (?t
			// only): HMR owns it — no action. DIFFERENT origin (watch
			// restarted on a new port): the injected container and its HMR
			// socket are DEAD — remount the iframe so a fresh boot injects
			// the live entry.
			cm.subscribe(`appbuilder:app:${appId}:dev`, (snap) => {
				const dev = snap as { entry?: string; manifest?: Record<string, unknown> } | undefined;
				if (!dev?.entry) return;
				const base = dev.entry.split('?')[0];
				if (prevDevEntryBaseRef.current && prevDevEntryBaseRef.current !== base) {
					setReloadSeq((n) => n + 1);
				}
				prevDevEntryBaseRef.current = base;
				setDevEntry(dev.entry);
				setDevManifest(dev.manifest);
			}),
			// Console/error rows — SIGNALS; this realm keeps the bounded
			// backlog (see the buffers above).
			cm.subscribe(`appbuilder:app:${appId}:console`, (payload) => {
				const row = payload as ConsoleRow | undefined;
				if (row) emitConsole(row);
			}),
			cm.subscribe(`appbuilder:app:${appId}:errors`, (payload) => {
				const row = payload as AppErrorRow | undefined;
				if (row) emitError(row);
			}),
			// The host's session handoff — a one-shot credential, RETAINED
			// until applied; this page retracts after taking it.
			cm.subscribe(`appbuilder:app:${appId}:session`, (snap) => {
				const session = snap as { token?: string } | undefined;
				if (!session?.token) return;
				setAuthToken(session.token);
				cm.publish(`appbuilder:app:${appId}:session`, undefined);
				// A credential arriving for an EXPLICIT sign-in click gets
				// delivered to the preview regardless of the Inherit Auth
				// checkbox — the user just asked for it.
				if (pendingExplicitLoginRef.current) {
					pendingExplicitLoginRef.current = false;
					setExplicitAuthSeq((n) => n + 1);
				}
			}),
			// Platform events, derived realm-locally from the mirror's
			// shell:event re-emission: the Events pane rows, the server build
			// feed + status ticker, the deploy-changed signal, and the
			// review-state account re-mint.
			cm.on('shell:event', (payload: { event?: { event?: string; body?: unknown } }) => {
				const event = payload?.event;
				if (!event?.event) return;
				// Server BUILD feed (apaevt_build): the build worker's live
				// pnpm/tsc/rsbuild output — one Console row PER LINE.
				if (event.event === 'apaevt_build' && event.body) {
					const b = event.body as { appId?: string; phase?: string; lines?: string[] };
					if (b.appId === appId && Array.isArray(b.lines)) {
						const prefix = `[build:${b.phase || '?'}]`;
						for (const line of b.lines) emitConsole({ time: feedTime(), level: 'log', text: `${prefix} ${line}` });
					}
				}
				// Server BUILD status ticker (apaevt_build_status): one short
				// display word per lifecycle transition ('' clears).
				if (event.event === 'apaevt_build_status' && event.body) {
					const b = event.body as { appId?: string; version?: number; status?: string };
					if (b.appId === appId && typeof b.status === 'string') {
						emitBuildStatus({ version: b.version, status: b.status });
					}
				}
				// Review-state push (app:statusChanged): re-fetch org-scoped
				// data through the account re-mint (the retained build words
				// are keyed by version alone — drop them with the identity).
				if (event.event === 'app:statusChanged' && event.body) {
					const b = event.body as { appId?: string };
					if (b.appId === appId) {
						buildTicks.current.clear();
						setAccountSeq((n) => n + 1);
					}
				}
				// Deployment change (apaevt_deploy — an app's deploy events
				// carry the app id as projectId): a pure re-fetch signal; the
				// identity is unchanged, so the retained build words stay.
				if (event.event === 'apaevt_deploy' && event.body) {
					const b = event.body as { projectId?: string };
					if (b.projectId === appId) {
						for (const fn of deployChangedListeners.current) fn();
					}
				}
				// Every event is Events-pane context.
				emitEvent({ time: feedTime(), name: String(event.event), payload: event.body ? JSON.stringify(event.body).slice(0, 200) : undefined });
			}),
			// Connection status changes are feed-worthy context too; a
			// reconnect may carry a NEW identity (org switch) — re-mint.
			cm.on('shell:statusChange', () => {
				emitEvent({ time: feedTime(), name: 'shell:statusChange', payload: cm.isConnected() ? 'connected' : 'disconnected' });
				if (cm.isConnected()) armMonitor();
			}),
			// The server pushed a refreshed account (developer registration,
			// org change, subscription move, reconnect identity) — the same
			// org-scoped data is stale; re-mint the host.
			cm.on('shell:accountUpdate', () => {
				buildTicks.current.clear();
				setAccountSeq((n) => n + 1);
			}),
		];
		return () => offs.forEach((off) => off());
		// eslint-disable-next-line react-hooks/exhaustive-deps -- one realm wiring per mount
	}, []);

	// ── Preview iframe console/errors (shell dev hooks postMessage) ─────
	// The preview shell is cross-origin to this webview, so its dev hooks
	// mirror console output + uncaught errors via postMessage — the third
	// Console feed beside pnpm and rsbuild.
	React.useEffect(() => {
		// Only the preview shell's frame may drive the sign-in flow or write
		// diagnostic rows. LOCAL-FIRST: the frame lives on the PROXY origin.
		const shellOrigin = ((): string => {
			try {
				return new URL(proxyPreviewUrl || previewUrl).origin;
			} catch {
				return '';
			}
		})();
		const stamp = (): string => new Date().toLocaleTimeString(undefined, { hour12: false });
		const onWindowMessage = (e: MessageEvent): void => {
			if (!shellOrigin || e.origin !== shellOrigin) return;
			const data = e.data as { type?: string; level?: 'log' | 'warn' | 'error'; text?: string; message?: string; source?: string } | undefined;
			if (data?.type === 'rrdev:loginRequest') {
				// The OAuth cycle always runs through the EXTENSION (VSCode
				// webviews block window.open, so the shell's popup fallback is
				// dead here — ACK immediately to cancel it). An explicit Sign
				// In click authenticates the preview even with Inherit Auth
				// off: the checkbox governs AUTOMATIC inheritance only. The op
				// resolves when the browser flow lands a session; the credential
				// itself arrives on the app's retained :session topic.
				(e.source as Window | null)?.postMessage({ type: 'rrdev:loginPending' }, e.origin);
				pendingExplicitLoginRef.current = true;
				void cm.request('host.appbuilder.login', { app: STAMPED_APP_ID } as never, { timeoutMs: LOGIN_TIMEOUT_MS }).catch(() => {
					/* sign-in abandoned — the preview keeps its prompt */
				});
			} else if (data?.type === 'shell:devConsole' && data.text !== undefined) {
				const row: ConsoleRow = { time: stamp(), level: data.level ?? 'log', text: `[preview] ${data.text}` };
				emitConsole(row);
			} else if (data?.type === 'shell:devError' && data.message) {
				const row: AppErrorRow = { time: stamp(), message: data.message, source: data.source ?? 'preview' };
				emitError(row);
			}
		};
		window.addEventListener('message', onWindowMessage);
		return () => window.removeEventListener('message', onWindowMessage);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- cm is a singleton
	}, [previewUrl, proxyPreviewUrl, emitConsole, emitError]);

	/** One typed host-op round trip (the bus correlates — no requestId). */
	const req = useCallback(<T,>(op: string, params: unknown): Promise<T> => cm.request(op, params as never) as Promise<T>, [cm]);

	// Feed subscriptions — STABLE identities, deliberately hoisted out of the
	// host memo: the accountSeq re-mint must re-run org-scoped data effects,
	// but a feed resubscription replays the retained backlog into panes that
	// already rendered it (duplicate log rows). Stable functions keep the
	// panes' [host.subscribeX]-keyed effects from re-firing. A new subscriber
	// still receives the backlog first (rows emitted before it mounted), then
	// the live stream — so a late-opened Console/Errors pane shows the full
	// history instead of starting blank.
	const subscribeEvents = useCallback((fn: (row: AppEventRow) => void) => {
		for (const r of eventBuffer.current) fn(r);
		eventListeners.current.add(fn);
		return () => eventListeners.current.delete(fn);
	}, []);
	const subscribeConsole = useCallback((fn: (row: ConsoleRow) => void) => {
		for (const r of consoleBuffer.current) fn(r);
		consoleListeners.current.add(fn);
		return () => consoleListeners.current.delete(fn);
	}, []);
	const subscribeErrors = useCallback((fn: (row: AppErrorRow) => void) => {
		for (const r of errorBuffer.current) fn(r);
		errorListeners.current.add(fn);
		return () => errorListeners.current.delete(fn);
	}, []);
	const subscribeWatch = useCallback((fn: (status: WatchStatus) => void) => {
		watchListeners.current.add(fn);
		return () => watchListeners.current.delete(fn);
	}, []);
	const subscribeBuildStatus = useCallback((fn: (tick: BuildStatusTick) => void) => {
		// Replay the retained latest word per version so a late-mounted
		// DEPLOY view shows the current tick, then stream live.
		for (const [version, status] of buildTicks.current) fn({ version, status });
		buildStatusListeners.current.add(fn);
		return () => buildStatusListeners.current.delete(fn);
	}, []);
	const subscribeDeployChanged = useCallback((fn: () => void) => {
		deployChangedListeners.current.add(fn);
		return () => {
			deployChangedListeners.current.delete(fn);
		};
	}, []);

	// ── The host adapter (IAppBuilderHost over the bus) ──────────────────
	const host: IAppBuilderHost = useMemo(() => {
		// accountSeq participates only as an identity salt: bumping it re-mints
		// the host object so [host]-keyed effects re-fetch org-scoped data.
		void accountSeq;
		const appId = STAMPED_APP_ID;
		return {
			// The SDK half — the brokered client.app.* ops, shared with the
			// cloud host (shared/tools/appdev/busHost.ts).
			...createBusAppBuilderHost({ bus: cm, appId, hasReviewLadder: capabilities.hasReviewLadder }),

			capabilities,
			// Feeds: the stable subscriptions hoisted above — see their comment
			// for why they must not re-mint with the host. These OVERRIDE the
			// adapter's buildStatus/deployChanged derivations on purpose: this
			// page retains the latest tick per version for late-mounted DEPLOY
			// views (and clears it on identity change) — the adapter's plain
			// stream has no replay.
			subscribeEvents,
			subscribeConsole,
			subscribeErrors,
			subscribeWatch,
			subscribeBuildStatus,
			subscribeDeployChanged,
			// Preview chrome
			// External opens (browser tab) get the PROXY URL — the tab
			// self-registers from it by URL convention (?appid + rrdev on the
			// dev origin), no message channel needed.
			getPreviewUrl: () => proxyPreviewUrl || previewUrl,
			// Reload = full inner-loop reset in the extension host (kill dev
			// server → pnpm install → fresh rsbuild). The iframe is NOT bumped
			// here: remounting now would load against a dead dev server — the
			// restart's rebuild repoints the retained :dev topic, and the
			// origin-change comparison remounts then.
			reloadPreview: () => cm.emitOp('host.appbuilder.restart', { app: appId } as never),
			// Inherit Auth toggle — PreviewFrame reacts to the prop change (pushes
			// the session down, or tells the shell to drop it).
			setInheritAuth: (inherit: boolean) => setInheritAuthState(inherit),
			// Per-workspace UI preferences: reads from the load-delivered bag,
			// writes echo to the extension host (workspaceState).
			getPref: (key: string) => prefsRef.current[key],
			setPref: (key: string, value: unknown) => {
				prefsRef.current[key] = value;
				cm.emitOp('host.appbuilder.pref', { app: appId, key, value } as never);
			},
			// Host actions. No `debug`: the external-browser debug flow was
			// removed (2026-10-16); the capability stays declared and false.
			revealFiles: capabilities.hasNativeFiles ? () => cm.emitOp('host.appbuilder.reveal', { app: appId } as never) : undefined,

			// ── The host-specific SDK member: DEPLOY packs the NATIVE folder ─
			deploy: async (message) => {
				await req('host.appbuilder.deploy', { app: appId, message });
			},

			// Store: the listing lives in the app's package.json appManifest —
			// load/save round-trip through the extension host (files are truth;
			// every deploy packs the manifest as the listing record).
			loadListing: async () => await req<ListingDraft | null>('host.appbuilder.loadListing', { app: appId }),
			saveListing: async (draft) => {
				await req('host.appbuilder.saveListing', { app: appId, draft });
			},
			runPreflight: async () => await req<PreflightCheck[]>('host.appbuilder.preflight', { app: appId }),
			// Package assets: native pick (app-folder-relative result) + text
			// read for the icon/README previews.
			pickAppFile: async (kind) => await req<string | null>('host.appbuilder.pickAppFile', { app: appId, kind }),
			pickIncludePath: async () => await req<string | null>('host.appbuilder.pickIncludePath', { app: appId }),
			readAppTextFile: async (relPath) => await req<string>('host.appbuilder.readTextFile', { app: appId, relPath }),
			readAppImageDataUri: async (relPath) => await req<string | null>('host.appbuilder.readImage', { app: appId, relPath }),
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- cm is a singleton
	}, [capabilities, previewUrl, proxyPreviewUrl, req, accountSeq, subscribeEvents, subscribeConsole, subscribeErrors, subscribeWatch, subscribeBuildStatus, subscribeDeployChanged]);

	// ── Render ──────────────────────────────────────────────────────────
	if (!app) {
		return <div style={{ ...styles.root, ...styles.loading }}>Loading app…</div>;
	}

	return (
		<div style={styles.root}>
			<AppBuilderScreen host={host} app={app} previewPane={proxyPreviewUrl && previewLive ? <PreviewFrame url={proxyPreviewUrl} reloadSeq={reloadSeq} app={app} devEntry={devEntry} devManifest={devManifest} authToken={authToken} inheritAuth={inheritAuth} explicitAuthSeq={explicitAuthSeq} /> : <PreviewInitializing status={watchStatus} subscribeConsole={subscribeConsole} />} initialStage={initialStage} onStageChange={(stage: AppBuilderStage) => cm.emitOp('host.appbuilder.stage', { app: STAMPED_APP_ID, stage } as never)} />
		</div>
	);
};

export default AppWebview;
