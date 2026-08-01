// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppWebview — the VS Code App Builder screen (page-app webview).
 *
 * THIN by design (decision D7): the entire App Builder surface — the
 * DEVELOP | DEPLOY | STORE views, their panes, forms, and state — lives in
 * shared-ui's `modules/appdev`. This webview contributes exactly two things:
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

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AppBuilderScreen } from 'shared/modules/appdev';
import type { AppBuilderStage, AppErrorRow, AppEventRow, AppSummary, ConsoleRow, IAppBuilderHost, WatchStatus } from 'shared/modules/appdev';
import { useMessaging } from '../hooks/useMessaging';

// =============================================================================
// TYPES — messages between extension host and webview
// =============================================================================

type OutgoingMessage =
	| { type: 'view:ready' }
	| { type: 'appdev:debug' }
	| { type: 'appdev:restart' }
	| { type: 'appdev:reveal' }
	| { type: 'appdev:stage'; stage: AppBuilderStage }
	| { type: 'appdev:call'; id: number; method: string; args?: unknown[] };

type IncomingMessage =
	| {
			type: 'appdev:init';
			app: AppSummary;
			previewUrl: string;
			capabilities: { hasCodePane: boolean; hasNativeFiles: boolean; canDebug: boolean };
			stage?: AppBuilderStage;
	  }
	| { type: 'appdev:event'; row: AppEventRow }
	| { type: 'appdev:console'; row: ConsoleRow }
	| { type: 'appdev:error'; row: AppErrorRow }
	| { type: 'appdev:watch'; status: WatchStatus }
	| { type: 'appdev:devServer'; entry: string }
	| { type: 'appdev:reload' }
	| { type: 'appdev:result'; id: number; ok: boolean; value?: unknown; error?: string };

// Wire shapes for the publish-ladder RPC (mirrors the SDK's return rows)
interface WireRailEntry { registryVersion: number; appVersion: string; sha256: string; publishedAt: number; author: string; message: string; rungs?: string[] }
interface WirePin { rung: string; handle: string; version: number; appVersion: string; state: string; deployedAt?: number }

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
	iframeWrap: {
		position: 'absolute',
		inset: 0,
	},
	iframe: {
		width: '100%',
		height: '100%',
		border: 'none',
		background: 'var(--rr-bg-default)',
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
};

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
const PreviewFrame: React.FC<{ url: string; reloadSeq: number; injectSeq: number; app: AppSummary | null; devEntry: string }> = ({ url, reloadSeq, injectSeq, app, devEntry }) => {
	const [ready, setReady] = useState(false);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);

	// Latest registration facts, readable from the message listener without
	// re-subscribing: the shell can boot ANY number of times inside one
	// iframe mount (its auth flow navigates internally), and every boot
	// must be re-injected.
	const registrationRef = useRef<{ app: AppSummary | null; devEntry: string }>({ app: null, devEntry: '' });
	registrationRef.current = { app, devEntry };

	/** Posts the dev-remote registration into the (current) preview shell. */
	const inject = useCallback((): void => {
		const { app: a, devEntry: entry } = registrationRef.current;
		if (!a || !entry) return;
		iframeRef.current?.contentWindow?.postMessage({
			type: 'rrdev:registerRemote',
			appId: a.id,
			moduleId: a.moduleId,
			name: a.name,
			entry,
		}, '*');
	}, []);

	// Reveal on the shell's devReady handshake; fall back on iframe load +
	// grace delay for shells without the hooks (older engine builds).
	// EVERY devReady re-injects — internal shell navigations (auth redirect,
	// user reload) boot a fresh page that knows nothing of the dev remote.
	React.useEffect(() => {
		setReady(false);
		const onMsg = (e: MessageEvent): void => {
			if (e.data && typeof e.data === 'object' && (e.data as { type?: string }).type === 'shell:devReady') {
				setReady(true);
				inject();
			}
		};
		window.addEventListener('message', onMsg);
		const fallback = setTimeout(() => setReady(true), 3000);
		return () => {
			window.removeEventListener('message', onMsg);
			clearTimeout(fallback);
		};
	}, [reloadSeq, url, inject]);

	// Also inject when the dev server address ARRIVES after the shell was
	// already ready (first boot: rsbuild banner lands seconds after devReady),
	// and on every rebuild (injectSeq): the force re-registration + descriptor
	// invalidation remounts JUST the app with the fresh bundle. The shell page
	// itself is never reloaded for a rebuild — reloading it re-requests the
	// bundle, which re-triggers a compile-on-demand build, which would reload
	// it again, forever.
	React.useEffect(() => {
		if (ready && devEntry && app) inject();
	}, [ready, devEntry, app, injectSeq, inject]);

	return (
		<div style={styles.iframeWrap}>
			{!ready && <div style={styles.loading}>Loading preview…</div>}
			<iframe
				key={reloadSeq}
				ref={iframeRef}
				src={url}
				style={{ ...styles.iframe, visibility: ready ? 'visible' : 'hidden' }}
				allow="clipboard-read; clipboard-write"
			/>
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
	const [initialStage, setInitialStage] = useState<AppBuilderStage>('develop');
	const [reloadSeq, setReloadSeq] = useState(0);
	const [injectSeq, setInjectSeq] = useState(0);
	const [devEntry, setDevEntry] = useState('');

	// ── Feed registries — stable across renders ─────────────────────────
	const eventListeners = useRef<Registry<AppEventRow>>(new Set());
	const consoleListeners = useRef<Registry<ConsoleRow>>(new Set());
	const errorListeners = useRef<Registry<AppErrorRow>>(new Set());
	const watchListeners = useRef<Registry<WatchStatus>>(new Set());

	// ── RPC lane (appdev:call/appdev:result correlation) ────────────────
	const pendingCalls = useRef<Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map());
	const nextCallId = useRef(1);
	// Semver label → registry version, from the last rail load
	const registryByLabel = useRef<Map<string, number>>(new Map());

	// ── Messaging ───────────────────────────────────────────────────────
	const onMessage = useCallback((msg: IncomingMessage) => {
		switch (msg.type) {
			case 'appdev:init':
				setApp(msg.app);
				setPreviewUrl(msg.previewUrl);
				setCapabilities(msg.capabilities);
				if (msg.stage) setInitialStage(msg.stage);
				break;
			case 'appdev:event':
				for (const fn of eventListeners.current) fn(msg.row);
				break;
			case 'appdev:console':
				for (const fn of consoleListeners.current) fn(msg.row);
				break;
			case 'appdev:error':
				for (const fn of errorListeners.current) fn(msg.row);
				break;
			case 'appdev:watch':
				for (const fn of watchListeners.current) fn(msg.status);
				break;
			case 'appdev:devServer':
				setDevEntry(msg.entry);
				break;
			case 'appdev:reload':
				// Watch rebuild landed — re-inject the dev remote so the app
				// (and only the app) remounts with the fresh bundle. NEVER
				// reload the iframe here: dev servers compile on request, so a
				// page reload triggers a build, whose completion lands right
				// back here — an infinite reload loop.
				setInjectSeq((n) => n + 1);
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
	}, []);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({ onMessage });

	// ── Preview iframe console/errors (shell dev hooks postMessage) ─────
	// The preview shell is cross-origin to this webview, so its dev hooks
	// mirror console output + uncaught errors via postMessage — the third
	// Console feed beside pnpm and rsbuild.
	React.useEffect(() => {
		const stamp = (): string => new Date().toLocaleTimeString(undefined, { hour12: false });
		const onWindowMessage = (e: MessageEvent): void => {
			const data = e.data as { type?: string; level?: 'log' | 'warn' | 'error'; text?: string; message?: string; source?: string } | undefined;
			if (data?.type === 'shell:devConsole' && data.text !== undefined) {
				const row: ConsoleRow = { time: stamp(), level: data.level ?? 'log', text: `[preview] ${data.text}` };
				for (const fn of consoleListeners.current) fn(row);
			} else if (data?.type === 'shell:devError' && data.message) {
				const row: AppErrorRow = { time: stamp(), message: data.message, source: data.source ?? 'preview' };
				for (const fn of errorListeners.current) fn(row);
			}
		};
		window.addEventListener('message', onWindowMessage);
		return () => window.removeEventListener('message', onWindowMessage);
	}, []);

	/** One RPC round trip to the extension host over the bridge. */
	const rpc = useCallback(<T,>(method: string, args?: unknown[]): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			const id = nextCallId.current++;
			pendingCalls.current.set(id, { resolve: resolve as (v: unknown) => void, reject });
			sendMessage({ type: 'appdev:call', id, method, args });
		});
	}, [sendMessage]);

	// ── The BRIDGE adapter (IAppBuilderHost over useMessaging) ──────────
	const host: IAppBuilderHost = useMemo(() => ({
		capabilities,
		// Feeds: registry-backed subscriptions (stable identities)
		subscribeEvents: (fn) => { eventListeners.current.add(fn); return () => eventListeners.current.delete(fn); },
		subscribeConsole: (fn) => { consoleListeners.current.add(fn); return () => consoleListeners.current.delete(fn); },
		subscribeErrors: (fn) => { errorListeners.current.add(fn); return () => errorListeners.current.delete(fn); },
		subscribeWatch: (fn) => { watchListeners.current.add(fn); return () => watchListeners.current.delete(fn); },
		// Preview chrome
		getPreviewUrl: () => previewUrl,
		// Reload = full inner-loop reset in the extension host (kill dev
		// server → pnpm install → fresh rsbuild). The iframe is NOT bumped
		// here: remounting now would load against a dead dev server — the
		// restart's first successful build sends appdev:reload, which does.
		reloadPreview: () => sendMessage({ type: 'appdev:restart' }),
		// Host actions — ride the bridge to the extension host
		debug: capabilities.canDebug ? () => sendMessage({ type: 'appdev:debug' }) : undefined,
		revealFiles: capabilities.hasNativeFiles ? () => sendMessage({ type: 'appdev:reveal' }) : undefined,

		// ── Deploy (the publish ladder) — all data over the RPC lane ────
		listVersions: async () => {
			const rail = await rpc<WireRailEntry[]>('listVersions');
			registryByLabel.current = new Map(rail.map((v) => [v.appVersion || `r${v.registryVersion}`, v.registryVersion]));
			return rail.map((v) => ({
				version: v.appVersion || `r${v.registryVersion}`,
				author: v.author,
				publishedAt: v.publishedAt,
				sha: v.sha256,
				message: v.message,
				rungs: (v.rungs ?? []).filter((r): r is 'personal' | 'team' | 'org' => r === 'personal' || r === 'team' || r === 'org'),
			}));
		},
		publish: async (message) => { await rpc('publish', [message]); },
		deploy: async (version, target) => {
			const registryVersion = registryByLabel.current.get(version);
			if (registryVersion === undefined) throw new Error(`Unknown version: ${version}`);
			await rpc('deploy', [registryVersion, target]);
		},
		getWhereLive: async () => {
			const pins = await rpc<WirePin[]>('where');
			return pins.map((p) => ({
				rung: (p.rung === 'personal' || p.rung === 'team' || p.rung === 'org' ? p.rung : 'org') as 'personal' | 'team' | 'org',
				label: p.rung.charAt(0).toUpperCase() + p.rung.slice(1),
				handle: p.handle,
				version: p.appVersion || `r${p.version}`,
				state: (p.state === 'enabled' ? 'enabled' : 'pending') as 'enabled' | 'pending',
				audience: p.rung === 'personal' ? 'on your desktop' : p.rung === 'org' ? 'everyone in the org' : 'team members',
				deployedAt: p.deployedAt,
			}));
		},
		// Store loaders arrive in M5 — absent = teaching empty states
	}), [capabilities, previewUrl, sendMessage, rpc]);

	// ── Render ──────────────────────────────────────────────────────────
	if (!app) {
		return <div style={{ ...styles.root, ...styles.loading }}>Loading app…</div>;
	}

	return (
		<div style={styles.root}>
			<AppBuilderScreen
				host={host}
				app={app}
				previewPane={previewUrl ? <PreviewFrame url={previewUrl} reloadSeq={reloadSeq} injectSeq={injectSeq} app={app} devEntry={devEntry} /> : undefined}
				initialStage={initialStage}
				onStageChange={(stage) => sendMessage({ type: 'appdev:stage', stage })}
			/>
		</div>
	);
};

export default AppWebview;
