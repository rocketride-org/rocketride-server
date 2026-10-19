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
// APP BUILDER PROVIDER — the `app:<appId>` document surface
// =============================================================================

/**
 * Direct-mounts the shared AppBuilderScreen for one app document (opened by
 * the sidebar's MY APPS list as the static doc `app:<appId>`). The web
 * host: the adapter wraps the live client, and the preview is a same-origin
 * iframe of this very shell. There is NO Code tab here — the workspace
 * Explorer + file-editor tabs are the code surface; the dev session runs
 * headless (models + design loop) and adopts those tabs' saves off the
 * notification bus.
 *
 * The preview is LIVE only — `?appid=<id>&rrdev=1`: the dev-flavor shell;
 * the session injects the LINKED build via registerLocalApp after the
 * rrdev:auth handshake. Save-to-render with Fast Refresh. (Server-built
 * versions are verified from the Deploy stage, same as VS Code.)
 *
 * The debug verb opens the LIVE preview in a new browser tab; the session
 * switches its injection target to the tab (same-origin window handle), so
 * DevTools debugs the real linked app against VFS sources.
 *
 * The document is STATIC — the shell's dirty/save hooks never fire; the
 * Code pane owns its whole save lifecycle.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection, ConnectionManager } from 'shell';
import { AppBuilderScreen } from 'shared/tools/appdev/views';
import type { AppBuilderStage, AppSummary } from 'shared/tools/appdev';
import { readAppPackage, scanApps } from './session/appStore';
import { getWorkspaceVfs } from '../workspace/vfs/workspace';
import type { StoredApp } from './session/appStore';
import { createWebAppBuilderHost } from './session/webHost';
import { WebDevSession } from './session/devSession';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	root: {
		position: 'relative',
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
		background: 'var(--rr-bg-default)',
	},
	loading: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	},
	previewRoot: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		flexDirection: 'column',
		borderRadius: 'inherit',
	},
	// borderRadius:'inherit' down the chain: composited iframes do not
	// reliably take an ancestor's rounded overflow clip.
	iframeWrap: {
		position: 'relative',
		flex: 1,
		minHeight: 0,
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
};

// =============================================================================
// PREVIEW SURFACE
// =============================================================================

/**
 * The preview surface: the same-origin shell iframe on the rrdev
 * linked-preview URL. Kept visibility:hidden until the document loads
 * (hidden panels report zero dimensions with display:none — never that).
 *
 * @param props.liveUrl - The rrdev linked-preview URL.
 * @param props.reloadSeq - Bumping remounts the iframe.
 * @param props.onIframe - Exposes the live iframe element to the provider.
 */
const PreviewSurface: React.FC<{
	liveUrl: string;
	reloadSeq: number;
	onIframe: (el: HTMLIFrameElement | null) => void;
}> = ({ liveUrl, reloadSeq, onIframe }) => {
	const [loaded, setLoaded] = useState(false);
	// step: a reload starts hidden again
	useEffect(() => {
		setLoaded(false);
	}, [reloadSeq]);
	return (
		<div style={styles.previewRoot}>
			<div style={styles.iframeWrap}>
				<iframe
					key={reloadSeq}
					ref={onIframe}
					src={liveUrl}
					title="App preview"
					style={{ ...styles.iframe, visibility: loaded ? 'visible' : 'hidden' }}
					onLoad={() => setLoaded(true)}
				/>
			</div>
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Resolves the app's working copy, runs the dev session, and mounts the
 * shared AppBuilderScreen with the web host adapter.
 *
 * @param props.uri - The document URI (`app:<appId>` or `tool:apps/<appId>`).
 */
const AppBuilderProvider: React.FC<{
	uri: string;
}> = ({ uri }) => {
	const { client, isConnected } = useShellConnection();
	const appId = uri.slice('app:'.length);

	// ── Resolve the working copy ─────────────────────────────────────────
	const [stored, setStored] = useState<StoredApp | null | undefined>(undefined);
	useEffect(() => {
		if (!client || !isConnected) return;
		let cancelled = false;
		void scanApps().then((apps) => {
			if (!cancelled) setStored(apps.find((a) => a.id === appId) ?? null);
		});
		return () => {
			cancelled = true;
		};
	}, [client, isConnected, appId]);

	// ── The dev session (models + design loop) ───────────────────────────
	// Keyed on the working copy's VALUES, not the `stored` object identity:
	// the scan effect mints a fresh object on every reconnect, and rebuilding
	// the live session from it would dispose the Monaco models (unsaved edits
	// included) for a layout that did not change.
	const storedFolder = stored?.folder;
	const storedName = stored?.name;
	const [session, setSession] = useState<WebDevSession | null>(null);
	useEffect(() => {
		if (!client || !storedFolder || storedName === undefined) return;
		const next = new WebDevSession(client, appId, storedFolder, storedName);
		setSession(next);
		void next.open();
		return () => {
			next.dispose();
			setSession(null);
		};
	}, [client, storedFolder, storedName, appId]);

	// ── Preview state ────────────────────────────────────────────────────
	const [reloadSeq, setReloadSeq] = useState(0);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const debugWindowRef = useRef<Window | null>(null);
	const liveUrl = `${window.location.origin}/?appid=${encodeURIComponent(appId)}&rrdev=1`;

	// ── Preview handshake + feed routing ─────────────────────────────────
	// The embedded (or debug-tab) dev shell posts shell:devReady, waits for
	// rrdev:auth (its token store is frame-local in-memory), then the
	// session adopts it as the injection target.
	useEffect(() => {
		if (!session) return;
		const handler = (e: MessageEvent): void => {
			const fromIframe = iframeRef.current?.contentWindow && e.source === iframeRef.current.contentWindow;
			const fromDebug = debugWindowRef.current && e.source === debugWindowRef.current;
			if (!fromIframe && !fromDebug) return;
			const data = e.data as { type?: string } | undefined;
			if (data?.type === 'shell:devReady') {
				// step: ALWAYS answer with the definitive session state ('' =
				// signed out) so any embedded dev shell boots authenticated.
				// Through loadToken(), NOT raw localStorage: when this shell is
				// itself an embedded dev preview (VS Code hosting), its adopted
				// token lives in the frame-local store (devGate.tokenStore).
				const token = ConnectionManager.getInstance().loadToken();
				(e.source as Window).postMessage({ type: 'rrdev:auth', token }, window.location.origin);
				// step: the embedded preview and the debug tab both become
				// the linked-injection target
				void session.attachPreview(e.source as Window);
			} else {
				session.handlePreviewMessage(e.data as Record<string, unknown>);
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, [session]);

	// ── Server build feed -> Console pane ────────────────────────────────
	useEffect(() => {
		if (!client || !session) return;
		client.addMonitor({ token: '*' }, ['deploy']).catch(() => { /* feed degrades */ });
		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: { event: { event?: string; body?: { appId?: string; phase?: string; lines?: string[] } } }) => {
			const body = event?.body;
			if (!body || body.appId !== appId) return;
			if (event.event === 'apaevt_build' && Array.isArray(body.lines)) {
				for (const line of body.lines) session.pushConsole('log', `[build:${body.phase ?? '?'}] ${line}`);
			}
		});
		return () => {
			unsub();
		};
	}, [client, session, appId]);

	// ── The host adapter ─────────────────────────────────────────────────
	const host = useMemo(() => {
		if (!client || !stored) return null;
		// hasReviewLadder mirrors the server's account backend: only a server
		// declaring 'oss' publishes @public directly (same rule as VSCode).
		const hasReviewLadder = !(client.getAccountInfo()?.capabilities ?? []).includes('oss');
		return createWebAppBuilderHost({
			client,
			appId,
			folder: stored.folder,
			hasReviewLadder,
			previewUrl: liveUrl,
			session,
			onReloadPreview: () => setReloadSeq((n) => n + 1),
			onOpenDebugTab: () => {
				// step: open the LIVE preview as a first-class tab; the
				// message handler above adopts it as the injection target
				debugWindowRef.current = window.open(liveUrl, '_blank');
			},
		});
	}, [client, stored, appId, liveUrl, session]);

	// ── Live manifest facts for the header ──────────────────────────────
	// `stored` stays FROZEN on purpose (the dev-session effect keys on its
	// folder/name values — re-scanning would tear the session down whenever
	// a manifest save changes them); the header overlays these instead,
	// refreshed whenever package.json changes.
	const [liveMeta, setLiveMeta] = useState<{ name?: string; version?: string; description?: string } | null>(null);
	useEffect(() => {
		if (!client || !stored) return;
		// Through the view's change stream (staged writes tick it even when
		// nothing reaches the server); cross-page writes arrive as view
		// ticks too via the session's bus translation. The re-read is
		// cache-served except right after an actual change.
		return getWorkspaceVfs().subscribe(() => {
			void readAppPackage(stored.folder)
				.then((pkg) => {
					const m = (pkg.appManifest ?? {}) as Record<string, unknown>;
					setLiveMeta({
						name: typeof m.name === 'string' && m.name ? m.name : undefined,
						version: typeof pkg.version === 'string' ? pkg.version : undefined,
						description: typeof m.description === 'string' ? m.description : undefined,
					});
				})
				.catch(() => { /* unreadable mid-edit — keep the last header */ });
		});
	}, [client, stored]);

	// ── App summary for the screen header ────────────────────────────────
	const app: AppSummary | null = useMemo(() => {
		if (!stored) return null;
		return {
			id: stored.id,
			moduleId: stored.moduleId,
			name: liveMeta?.name ?? stored.name,
			version: liveMeta?.version ?? (stored.version || undefined),
			status: 'local',
			description: liveMeta?.description ?? (stored.description || undefined),
		};
	}, [stored, liveMeta]);

	// ── Stage persistence (the per-app host pref bag) ────────────────────
	const initialStage = useMemo(() => {
		const persisted = host?.getPref?.('stage');
		// 'code' is deliberately NOT accepted: the web host dropped the CODE
		// tab (the Explorer's file tabs are the code surface), and restoring
		// a pre-drop persisted 'code' stage would land on a tab that no
		// longer exists — those fall through to the default landing view.
		return persisted === 'dashboard' || persisted === 'design' || persisted === 'package' || persisted === 'store' || persisted === 'deploy' ? (persisted as AppBuilderStage) : undefined;
	}, [host]);

	// ── Render ───────────────────────────────────────────────────────────
	if (!isConnected) return <div style={styles.root}><div style={styles.loading}>Connect to a server to open the App Builder.</div></div>;
	if (stored === undefined || !host || !app) return <div style={styles.root}><div style={styles.loading}>Loading app&hellip;</div></div>;
	if (stored === null) return <div style={styles.root}><div style={styles.loading}>No working copy for &quot;{appId}&quot; in your store.</div></div>;

	return (
		<div style={styles.root}>
			<AppBuilderScreen
				host={host}
				app={app}
				previewPane={
					<PreviewSurface
						liveUrl={liveUrl}
						reloadSeq={reloadSeq}
						onIframe={(el) => {
							iframeRef.current = el;
						}}
					/>
				}
				initialStage={initialStage}
				onStageChange={(stage) => {
					host.setPref?.('stage', stage);
				}}
			/>
		</div>
	);
};

export default AppBuilderProvider;
