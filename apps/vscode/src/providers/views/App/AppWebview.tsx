// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppWebview — the VS Code App Builder screen (page-app webview).
 *
 * THIN by design (decision D7): the entire App Builder surface — the
 * DEVELOP | DEPLOY | STORE views, their panes, forms, and state — lives in
 * shared's `modules/appdev`. This webview contributes exactly two things:
 *
 *  1. The BRIDGE adapter: an IAppBuilderHost whose data accessors and
 *     actions ride useMessaging to the extension host
 *     (appdev-message-handler.ts).
 *  2. The preview surface: the shell iframe (`?appid=<id>&rrdev=1`),
 *     hidden until the shell's dev hooks signal readiness so the theme
 *     never flashes.
 *
 * Capability flags select the VSCode variant: no Code pane (files are
 * native — bind, don't sync), native-files strip, F5 debugging.
 */

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AppBuilderScreen } from 'shared/modules/appdev';
import type { AppBuilderStage, AppErrorRow, AppEventRow, AppHistoryEntry, AppSummary, AppVersionInfo, BuildStatusTick, ConsoleRow, IAppBuilderHost, ListingDraft, PreflightCheck, WatchStatus } from 'shared/modules/appdev';
import { useMessaging } from '../hooks/useMessaging';

// =============================================================================
// TYPES — messages between extension host and webview
// =============================================================================

type OutgoingMessage = { type: 'view:ready' } | { type: 'appdev:debug' } | { type: 'appdev:login' } | { type: 'appdev:restart' } | { type: 'appdev:reveal' } | { type: 'appdev:stage'; stage: AppBuilderStage } | { type: 'appdev:pref'; key: string; value: unknown } | { type: 'appdev:call'; id: number; method: string; args?: unknown[] };

type IncomingMessage =
	| {
			type: 'appdev:init';
			app: AppSummary;
			previewUrl: string;
			capabilities: { hasCodePane: boolean; hasNativeFiles: boolean; canDebug: boolean };
			stage?: AppBuilderStage;
			prefs?: Record<string, unknown>;
	  }
	| { type: 'appdev:event'; row: AppEventRow }
	| { type: 'appdev:console'; row: ConsoleRow }
	| { type: 'appdev:error'; row: AppErrorRow }
	| { type: 'appdev:watch'; status: WatchStatus }
	| { type: 'appdev:buildStatus'; appId: string; version?: number; status: string }
	| { type: 'appdev:devServer'; entry: string }
	| { type: 'appdev:auth'; token: string }
	| { type: 'appdev:reload' }
	| { type: 'appdev:accountChanged' }
	| { type: 'appdev:result'; id: number; ok: boolean; value?: unknown; error?: string };

// Wire shapes for the publish-ladder RPC (mirrors the SDK's return rows)
interface WireRailEntry {
	registryVersion: number;
	appVersion: string;
	sha256: string;
	publishedAt: number;
	author: string;
	message: string;
	rungs?: string[];
	state?: string;
	buildStatus?: string;
}
interface WirePin {
	rung: string;
	handle: string;
	version: number;
	appVersion: string;
	state: string;
	deployedAt?: number;
}
interface WireHistoryRow {
	seq: number;
	at: number;
	action: string;
	teamId?: string | null;
	version?: number | null;
	actor?: { userId?: string; display?: string; email?: string } | null;
	data?: {
		side?: string;
		message?: string;
		audience?: { type?: string; id?: string; name?: string; handle?: string };
		previousVersion?: number;
		comment?: string;
		from?: string;
		to?: string;
	} | null;
}

// =============================================================================
// HISTORY PROJECTIONS — one 'history' RPC, two view shapes
// =============================================================================

/**
 * Normalizes raw history rows (oldest-first from the bridge) into the shared
 * AppHistoryEntry shape — SQL nulls become absent fields so the views only
 * deal in one vocabulary.
 *
 * @param rows - Raw bridge rows, oldest first.
 * @returns The Dashboard's history entries, oldest first.
 */
function toHistoryEntries(rows: WireHistoryRow[]): AppHistoryEntry[] {
	return rows.map((r) => ({
		seq: r.seq,
		at: r.at,
		action: r.action,
		version: r.version ?? undefined,
		actor: r.actor ?? undefined,
		data: r.data
			? {
					side: r.data.side === 'admin' || r.data.side === 'developer' ? r.data.side : undefined,
					message: r.data.message,
					// The audience marker is what separates a PUBLISH row (bind
					// to a rung) from the bare registry-write DEPLOY row.
					audience: r.data.audience,
					previousVersion: r.data.previousVersion,
					comment: r.data.comment,
					from: r.data.from,
					to: r.data.to,
				}
			: undefined,
	}));
}


// Bridge RPC bound — generous because publish builds are the slowest
// legitimate call; a host that never answers must not pend forever.
const RPC_TIMEOUT_MS = 5 * 60 * 1000;

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
 * On error the pane says WHY, center-screen: the host supplies the reason
 * with every error status (server unreachable, not connected, the failing
 * pnpm line, a compile failure). The generic console pointer is only the
 * fallback for a producer that failed to say.
 *
 * @param props.status - The latest watch status (state + error reason).
 */
const PreviewInitializing: React.FC<{ status: WatchStatus }> = ({ status }) => (
	<div style={styles.iframeWrap}>
		<div style={styles.loading}>
			<div style={{ textAlign: 'center', maxWidth: 460, padding: '0 24px' }}>
				<div style={styles.initTitle}>{status.state === 'error' ? 'Dev session failed' : 'Initializing Services'}</div>
				<div style={styles.initDetail}>{status.state === 'error' ? (status.reason ?? 'See the Console pane for the error output.') : status.state === 'building' ? 'Starting the dev server\u2026' : status.state === 'idle' ? 'Restarting the dev server\u2026' : 'Installing dependencies\u2026'}</div>
			</div>
		</div>
	</div>
);

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
const PreviewFrame: React.FC<{ url: string; reloadSeq: number; app: AppSummary | null; devEntry: string; authToken: string; inheritAuth: boolean; explicitAuthSeq: number }> = ({ url, reloadSeq, app, devEntry, authToken, inheritAuth, explicitAuthSeq }) => {
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
	const registrationRef = useRef<{ app: AppSummary | null; devEntry: string; authToken: string; inheritAuth: boolean }>({ app: null, devEntry: '', authToken: '', inheritAuth: true });
	registrationRef.current = { app, devEntry, authToken, inheritAuth };
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
		const { app: a, devEntry: entry } = registrationRef.current;
		if (!a || !entry) return;
		injectedRef.current = true;
		iframeRef.current?.contentWindow?.postMessage(
			{
				type: 'rrdev:registerRemote',
				appId: a.id,
				moduleId: a.moduleId,
				name: a.name,
				entry,
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
						<div style={styles.initDetail}>The shell at {shellOrigin} did not load — is the server running? Retrying automatically; the preview appears as soon as it answers.</div>
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
	const [capabilities, setCapabilities] = useState({ hasCodePane: false, hasNativeFiles: true, canDebug: true });
	const [initialStage, setInitialStage] = useState<AppBuilderStage>('dashboard');
	const [reloadSeq, setReloadSeq] = useState(0);
	const [devEntry, setDevEntry] = useState('');
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

	// ── RPC lane (appdev:call/appdev:result correlation) ────────────────
	const pendingCalls = useRef<Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map());
	const nextCallId = useRef(1);

	// Account identity generation — bumped when the host reports that the
	// connection's account/org changed. Salts the host memo below, so every
	// [host]-keyed data effect (developer namespace, publish rail, teams)
	// re-fetches under the new identity without remounting the screen.
	const [accountSeq, setAccountSeq] = useState(0);

	// ── Messaging ───────────────────────────────────────────────────────
	const onMessage = useCallback(
		(msg: IncomingMessage) => {
			switch (msg.type) {
				case 'appdev:init':
					// Prefs must land BEFORE the App Builder screen mounts (app
					// gates the render below), so host.getPref is synchronous by
					// the time the views initialize their state from it.
					prefsRef.current = msg.prefs ?? {};
					setApp(msg.app);
					setPreviewUrl(msg.previewUrl);
					setCapabilities(msg.capabilities);
					if (msg.stage) setInitialStage(msg.stage);
					break;
				case 'appdev:event':
					emitEvent(msg.row);
					break;
				case 'appdev:console':
					emitConsole(msg.row);
					break;
				case 'appdev:error':
					emitError(msg.row);
					break;
				case 'appdev:watch':
					setWatchStatus(msg.status);
					for (const fn of watchListeners.current) fn(msg.status);
					break;
				case 'appdev:buildStatus':
					emitBuildStatus({ version: msg.version, status: msg.status });
					break;
				case 'appdev:devServer': {
					// Same server, new build (?t only): HMR owns it — no action.
					// DIFFERENT origin (watch restarted on a new port): the
					// injected container and its HMR socket are DEAD — remount
					// the iframe so a fresh boot injects the live entry.
					const base = msg.entry.split('?')[0];
					if (prevDevEntryBaseRef.current && prevDevEntryBaseRef.current !== base) {
						setReloadSeq((n) => n + 1);
					}
					prevDevEntryBaseRef.current = base;
					setDevEntry(msg.entry);
					break;
				}
				case 'appdev:auth':
					setAuthToken(msg.token);
					// Credential arriving for an EXPLICIT sign-in click gets
					// delivered to the preview regardless of the Inherit Auth
					// checkbox — the user just asked for it.
					if (pendingExplicitLoginRef.current) {
						pendingExplicitLoginRef.current = false;
						setExplicitAuthSeq((n) => n + 1);
					}
					break;
				case 'appdev:reload':
					// Watch rebuild landed — deliberately a no-op. The container's
					// HMR client owns updates: it hot-applies in place (state
					// preserved), and on failure it reloads the page itself, which
					// re-injects the freshest entry via devReady. A second update
					// path here bred zombie container instances whose stale hashes
					// 404'd every hot-update. Non-HMR containers (hmr disabled in
					// the app config, prod-flavor shell) refresh via the Reload
					// button's full restart.
					break;
				case 'appdev:accountChanged':
					// The connection's identity changed (org switch reconnect or a
					// server account push) — re-mint the host so org-scoped data
					// re-fetches.
					setAccountSeq((n) => n + 1);
					break;
				case 'appdev:result': {
					// Settle the matching RPC promise
					const pending = pendingCalls.current.get(msg.id);
					if (pending) {
						pendingCalls.current.delete(msg.id);
						if (msg.ok) pending.resolve(msg.value);
						else pending.reject(new Error(msg.error ?? 'appdev call failed'));
					}
					break;
				}
			}
		},
		[emitEvent, emitConsole, emitError, emitBuildStatus]
	);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({ onMessage });

	// ── Preview iframe console/errors (shell dev hooks postMessage) ─────
	// The preview shell is cross-origin to this webview, so its dev hooks
	// mirror console output + uncaught errors via postMessage — the third
	// Console feed beside pnpm and rsbuild.
	React.useEffect(() => {
		// Only the preview shell's frame may drive the sign-in flow or write
		// diagnostic rows.
		const shellOrigin = ((): string => {
			try {
				return new URL(previewUrl).origin;
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
				// off: the checkbox governs AUTOMATIC inheritance only.
				(e.source as Window | null)?.postMessage({ type: 'rrdev:loginPending' }, e.origin);
				pendingExplicitLoginRef.current = true;
				sendMessage({ type: 'appdev:login' });
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
	}, [sendMessage, previewUrl, emitConsole, emitError]);

	/** One RPC round trip to the extension host over the bridge. */
	const rpc = useCallback(
		<T,>(method: string, args?: unknown[]): Promise<T> => {
			return new Promise<T>((resolve, reject) => {
				const id = nextCallId.current++;
				const timer = setTimeout(() => {
					pendingCalls.current.delete(id);
					reject(new Error(`appdev call "${method}" timed out`));
				}, RPC_TIMEOUT_MS);
				// Both settle paths clear the timer so a late answer cannot
				// double-settle after a timeout (the entry is gone by then).
				pendingCalls.current.set(id, {
					resolve: (v: unknown) => {
						clearTimeout(timer);
						(resolve as (v: unknown) => void)(v);
					},
					reject: (e: Error) => {
						clearTimeout(timer);
						reject(e);
					},
				});
				sendMessage({ type: 'appdev:call', id, method, args });
			});
		},
		[sendMessage]
	);

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

	// ── The BRIDGE adapter (IAppBuilderHost over useMessaging) ──────────
	const host: IAppBuilderHost = useMemo(() => {
		// accountSeq participates only as an identity salt: bumping it re-mints
		// the host object so [host]-keyed effects re-fetch org-scoped data.
		void accountSeq;
		return {
			capabilities,
			// Feeds: the stable subscriptions hoisted above — see their comment
			// for why they must not re-mint with the host.
			subscribeEvents,
			subscribeConsole,
			subscribeErrors,
			subscribeWatch,
			subscribeBuildStatus,
			// Preview chrome
			getPreviewUrl: () => previewUrl,
			// Reload = full inner-loop reset in the extension host (kill dev
			// server → pnpm install → fresh rsbuild). The iframe is NOT bumped
			// here: remounting now would load against a dead dev server — the
			// restart's first successful build sends appdev:reload, which does.
			reloadPreview: () => sendMessage({ type: 'appdev:restart' }),
			// Inherit Auth toggle — PreviewFrame reacts to the prop change (pushes
			// the session down, or tells the shell to drop it).
			setInheritAuth: (inherit: boolean) => setInheritAuthState(inherit),
			// Per-workspace UI preferences: reads from the init-delivered bag,
			// writes echo to the extension host (workspaceState).
			getPref: (key: string) => prefsRef.current[key],
			setPref: (key: string, value: unknown) => {
				prefsRef.current[key] = value;
				sendMessage({ type: 'appdev:pref', key, value });
			},
			// Host actions — ride the bridge to the extension host
			debug: capabilities.canDebug ? () => sendMessage({ type: 'appdev:debug' }) : undefined,
			revealFiles: capabilities.hasNativeFiles ? () => sendMessage({ type: 'appdev:reveal' }) : undefined,

			// ── Deploy (the publish ladder) — all data over the RPC lane ────
			listVersions: async () => {
				const rail = await rpc<WireRailEntry[]>('listVersions');
				return rail.map((v) => ({
					// The registry int is the row identity end-to-end; the semver is
					// display-only (may repeat across deploys, '' on legacy rows).
					registryVersion: v.registryVersion,
					version: v.appVersion || '',
					author: v.author,
					publishedAt: v.publishedAt,
					sha: v.sha256,
					message: v.message,
					rungs: (v.rungs ?? []).filter((r): r is 'personal' | 'team' | 'public' => r === 'personal' || r === 'team' || r === 'public'),
					state: (v.state || undefined) as AppVersionInfo['state'],
					buildStatus: v.buildStatus,
				}));
			},
			deploy: async (message) => {
				await rpc('deploy', [message]);
			},
			publish: async (version, target) => {
				await rpc('publish', [version, target]);
			},
			removePublish: async (target) => {
				await rpc('unpublish', [target]);
			},
			listTeams: async () => await rpc<Array<{ id: string; name: string }>>('teams'),
			// One version's server build log ('' = none) — the Deploy card's
			// "failed" badge opens it in the log modal.
			loadBuildLog: async (version) => await rpc<string>('buildLog', [version]),
			submitForReview: async (version) => {
				await rpc('submit', [version]);
			},
			withdrawReview: async (version) => {
				await rpc('withdraw', [version]);
			},
			getWhereLive: async () => {
				const pins = await rpc<WirePin[]>('where');
				return pins.map((p) => {
					const rung = (p.rung === 'personal' || p.rung === 'team' || p.rung === 'public' ? p.rung : 'personal') as 'personal' | 'team' | 'public';
					// p.state is the bound DEPLOYMENT's review state
					// (private|submit|ready|rejected). Internal rungs serve live;
					// the public rung shows the review gate — 'ready' = approved,
					// anything else = still in review.
					const state: 'enabled' | 'approved' | 'pending' = rung !== 'public' ? 'enabled' : p.state === 'ready' ? 'approved' : 'pending';
					return {
						rung,
						label: rung.charAt(0).toUpperCase() + rung.slice(1),
						handle: p.handle,
						registryVersion: p.version,
						// RAW semver only ('' on legacy rows) — the view composes the
						// shared v<registry> + semver-pill format itself, so any
						// fallback text here would render as a bogus pill.
						version: p.appVersion || '',
						state,
						audience: rung === 'personal' ? 'on your desktop' : rung === 'public' ? 'the app store' : 'team members',
						deployedAt: p.deployedAt,
					};
				});
			},
			getDeveloperId: async () => {
				const res = await rpc<{ developerId?: string | null }>('developerStatus');
				return res?.developerId ?? '';
			},
			registerDeveloper: async (developerId) => {
				const res = await rpc<{ developerId?: string }>('registerDeveloper', [developerId]);
				return res?.developerId ?? developerId;
			},
			// Store: the listing lives in the app's package.json appManifest —
			// load/save round-trip through the extension host (files are truth;
			// every deploy packs the manifest as the listing record).
			loadListing: async () => await rpc<ListingDraft | null>('loadListing'),
			saveListing: async (draft) => {
				await rpc<null>('saveListing', [draft]);
			},
			runPreflight: async () => await rpc<PreflightCheck[]>('preflight'),
			// Package assets: native pick (app-folder-relative result) + text
			// read for the icon/README previews.
			pickAppFile: async (kind) => await rpc<string | null>('pickFile', [kind]),
			pickIncludePath: async () => await rpc<string | null>('pickIncludePath'),
			readAppTextFile: async (relPath) => await rpc<string>('readFile', [relPath]),
			readAppImageDataUri: async (relPath) => await rpc<string | null>('readImage', [relPath]),

			// ── Dashboard + review thread ───────────────────────────────────
			// The bridge walks the server's 100-row pages and returns the
			// whole stream oldest-first; the Dashboard's conversation renders
			// it (the Store tab's review-history card retired into it).
			loadHistory: async () => toHistoryEntries(await rpc<WireHistoryRow[]>('history')),
			sendReply: async (message, version) => {
				await rpc('reply', version === undefined ? [message] : [message, version]);
			},
		};
	}, [capabilities, previewUrl, sendMessage, rpc, accountSeq, subscribeEvents, subscribeConsole, subscribeErrors, subscribeWatch, subscribeBuildStatus]);

	// ── Render ──────────────────────────────────────────────────────────
	if (!app) {
		return <div style={{ ...styles.root, ...styles.loading }}>Loading app…</div>;
	}

	return (
		<div style={styles.root}>
			<AppBuilderScreen host={host} app={app} previewPane={previewUrl && previewLive ? <PreviewFrame url={previewUrl} reloadSeq={reloadSeq} app={app} devEntry={devEntry} authToken={authToken} inheritAuth={inheritAuth} explicitAuthSeq={explicitAuthSeq} /> : <PreviewInitializing status={watchStatus} />} initialStage={initialStage} onStageChange={(stage) => sendMessage({ type: 'appdev:stage', stage })} />
		</div>
	);
};

export default AppWebview;
