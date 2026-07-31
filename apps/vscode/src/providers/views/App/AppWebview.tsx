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
	| { type: 'appdev:reveal' }
	| { type: 'appdev:stage'; stage: AppBuilderStage };

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
	| { type: 'appdev:reload' };

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
 * @param props.url - The shell URL (`<engine>/?appid=<id>&rrdev=1`).
 * @param props.reloadSeq - Bumping remounts the iframe (a full reload).
 */
const PreviewFrame: React.FC<{ url: string; reloadSeq: number }> = ({ url, reloadSeq }) => {
	const [ready, setReady] = useState(false);

	// Reveal on the shell's devReady handshake; fall back on iframe load +
	// grace delay for shells without the hooks (older engine builds).
	React.useEffect(() => {
		setReady(false);
		const onMsg = (e: MessageEvent): void => {
			if (e.data && typeof e.data === 'object' && (e.data as { type?: string }).type === 'shell:devReady') setReady(true);
		};
		window.addEventListener('message', onMsg);
		const fallback = setTimeout(() => setReady(true), 3000);
		return () => {
			window.removeEventListener('message', onMsg);
			clearTimeout(fallback);
		};
	}, [reloadSeq, url]);

	return (
		<div style={styles.iframeWrap}>
			{!ready && <div style={styles.loading}>Loading preview…</div>}
			<iframe
				key={reloadSeq}
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

	// ── Feed registries — stable across renders ─────────────────────────
	const eventListeners = useRef<Registry<AppEventRow>>(new Set());
	const consoleListeners = useRef<Registry<ConsoleRow>>(new Set());
	const errorListeners = useRef<Registry<AppErrorRow>>(new Set());
	const watchListeners = useRef<Registry<WatchStatus>>(new Set());

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
			case 'appdev:reload':
				// Watch rebuild landed — remount the preview iframe
				setReloadSeq((n) => n + 1);
				break;
		}
	}, []);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({ onMessage });

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
		reloadPreview: () => setReloadSeq((n) => n + 1),
		// Host actions — ride the bridge to the extension host
		debug: capabilities.canDebug ? () => sendMessage({ type: 'appdev:debug' }) : undefined,
		revealFiles: capabilities.hasNativeFiles ? () => sendMessage({ type: 'appdev:reveal' }) : undefined,
		// Deploy/Store loaders arrive in M4/M5 — absent = teaching empty states
	}), [capabilities, previewUrl, sendMessage]);

	// ── Render ──────────────────────────────────────────────────────────
	if (!app) {
		return <div style={{ ...styles.root, ...styles.loading }}>Loading app…</div>;
	}

	return (
		<div style={styles.root}>
			<AppBuilderScreen
				host={host}
				app={app}
				previewPane={previewUrl ? <PreviewFrame url={previewUrl} reloadSeq={reloadSeq} /> : undefined}
				initialStage={initialStage}
				onStageChange={(stage) => sendMessage({ type: 'appdev:stage', stage })}
			/>
		</div>
	);
};

export default AppWebview;
