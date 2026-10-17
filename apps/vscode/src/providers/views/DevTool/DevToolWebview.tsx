// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * DevToolWebview — mounts a store app's devToolFrame natively.
 *
 * This webview is a Module Federation HOST (built by
 * rsbuild.devtool.config.mjs with the react/react-dom/shell/rocketride share
 * singletons the store-app remotes require). On init it:
 *
 *   1. connects the shell's ConnectionManager singleton to the engine with
 *      the host-provided credential — so the mounted tool can use the
 *      standard shell hooks (useShellConnection, useDashboardData, …)
 *      exactly as it does inside the shell;
 *   2. registers the tool's remote at the engine's versioned entry URL and
 *      loads its AppDescriptor (the same `<moduleId>/AppDescriptor` module
 *      the shell loads);
 *   3. mounts `descriptor.devToolFrame` with DevToolProps — a live client
 *      and the peer bus relayed through the extension host.
 *
 * Theming is ambient: the tool styles itself with the `--rr-*` tokens this
 * document defines (rocketride-default.css + the VS Code variable mapping).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { registerRemotes, loadRemote } from '@module-federation/runtime';
import { ConnectionManager, createToolChannel } from 'shell';
import type { AppDescriptor, DevToolProps, ToolChannel } from 'shell';
import { useMessaging } from '../hooks/useMessaging';
import type { DevToolHostToWebview, DevToolInitPayload, DevToolWebviewToHost } from '../../types/devToolTypes';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Full-bleed page — the mounted tool owns every pixel. */
	page: {
		position: 'fixed' as const,
		inset: 0,
		display: 'flex',
		flexDirection: 'column' as const,
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Bounded flex host for the mounted devToolFrame: the tool gets a
	    definite-height flex parent (what AppLayout's client area gives it
	    in-shell), so flex:1 / height:100% layouts fill the panel and scroll
	    INTERNALLY instead of growing the page. */
	frameHost: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column' as const,
	} as CSSProperties,

	/** Centered status message (loading / error / disconnected). */
	status: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
	} as CSSProperties,

	statusTitle: {
		fontSize: 15,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		marginBottom: 6,
	} as CSSProperties,
};

// =============================================================================
// REMOTE LOADING
// =============================================================================

/** Phase state for the mount pipeline. */
type Phase =
	| { kind: 'idle' }
	| { kind: 'loading'; name: string }
	| { kind: 'ready'; Frame: React.ComponentType<DevToolProps> }
	| { kind: 'error'; name: string; message: string };

/**
 * The engine's versioned MF entry URL for an app (the shell constructs the
 * same path — see packages/shell/src/util/versionOverride.ts — but relative;
 * a webview origin needs it absolute).
 *
 * @param base - Engine base URL, no trailing slash.
 * @param appId - The app id.
 * @param version - Registry version number.
 * @returns Absolute remoteEntry.js URL.
 */
function entryUrl(base: string, appId: string, version: number): string {
	return `${base}/apps/${encodeURIComponent(appId)}/v${version}/remoteEntry.js`;
}

// =============================================================================
// COMPONENT
// =============================================================================

const DevToolWebview: React.FC = () => {
	const [data, setData] = useState<DevToolInitPayload | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	// Peer subscribers — host-relayed messages from the tool's sidebar mount.
	const peerSubsRef = useRef(new Set<(msg: unknown) => void>());
	// Messages that arrived BEFORE the frame subscribed: the host flushes its
	// buffer on view:ready, but the mounted tool only subscribes after the
	// remote loads and the connection comes up — hold them here and replay to
	// the first subscriber (the reopen-on-click flow depends on this).
	const peerPendingRef = useRef<unknown[]>([]);
	// One container per document: a loaded MF remote cannot be repointed —
	// the host recreates the whole panel on version change.
	const mountedRef = useRef<string | null>(null);

	const onMessage = useCallback((message: DevToolHostToWebview) => {
		if (message.type === 'devtool:init') {
			setData(message.payload);
		} else if (message.type === 'devtool:peer') {
			if (peerSubsRef.current.size === 0) {
				// Nothing mounted yet — buffer (bounded) for the first subscriber.
				if (peerPendingRef.current.length < 64) peerPendingRef.current.push(message.payload);
				return;
			}
			for (const cb of peerSubsRef.current) cb(message.payload);
		}
	}, []);

	const { sendMessage } = useMessaging<DevToolWebviewToHost, DevToolHostToWebview>({ onMessage });

	// The DevToolProps.documents API — the host opens one editor-area panel
	// per document key (e.g. one tab per database connection).
	const documents = useMemo<NonNullable<DevToolProps['documents']>>(() => ({
		open: (docKey: string, title: string) => sendMessage({ type: 'devtool:openDocument', docKey, title }),
		close: (docKey: string) => sendMessage({ type: 'devtool:closeDocument', docKey }),
	}), [sendMessage]);

	// ── Connect + load + mount ───────────────────────────────────────────────
	useEffect(() => {
		const app = data?.app;
		if (!data || !data.connected || !app || !data.engineHttpUrl) return;
		// Same tool, same version, already mounted (or mid-load): nothing to do.
		const mountKey = `${app.id}@${app.registryVersion}`;
		if (mountedRef.current === mountKey) return;
		mountedRef.current = mountKey;

		let alive = true;
		setPhase({ kind: 'loading', name: app.name });

		void (async () => {
			try {
				// 1. Bring the shell connection singleton up against the engine
				//    so the tool's shell hooks are live. initialize() is
				//    idempotent; connect() resolves the session from the
				//    host-provided credential.
				const cm = ConnectionManager.getInstance();
				cm.initialize({ uri: data.engineHttpUrl });
				if (!cm.isConnected()) await cm.connect(data.authToken || undefined);

				// 2. Register + load the tool's remote descriptor.
				registerRemotes([{ name: app.moduleId, entry: entryUrl(data.engineHttpUrl, app.id, app.registryVersion) }], { force: true });
				const mod = (await loadRemote(`${app.moduleId}/AppDescriptor`)) as { default: AppDescriptor } | null;
				const descriptor = mod?.default;
				if (!alive) return;

				const Frame = descriptor?.devToolFrame;
				if (!Frame) {
					setPhase({ kind: 'error', name: app.name, message: 'This app does not declare a devToolFrame.' });
					return;
				}
				setPhase({ kind: 'ready', Frame });
			} catch (err) {
				if (!alive) return;
				setPhase({ kind: 'error', name: app.name, message: err instanceof Error ? err.message : String(err) });
			}
		})();

		return () => {
			alive = false;
		};
	}, [data]);

	// ── DevToolProps (stable identity across renders) ────────────────────────
	const peerRef = useRef<DevToolProps['peer'] | null>(null);
	if (!peerRef.current) {
		peerRef.current = {
			post: (message: unknown) => sendMessage({ type: 'devtool:peer', payload: message }),
			subscribe: (cb: (message: unknown) => void) => {
				peerSubsRef.current.add(cb);
				// Replay anything that arrived before the tool mounted.
				const pending = peerPendingRef.current;
				peerPendingRef.current = [];
				for (const payload of pending) cb(payload);
				return () => peerSubsRef.current.delete(cb);
			},
		};
	}
	// The typed channel over the same transport — one per document lifetime.
	// The bridge replays retained state into this webview on registration,
	// and the channel replays it again to late component subscribers.
	const channelRef = useRef<ToolChannel | null>(null);
	if (!channelRef.current) channelRef.current = createToolChannel(peerRef.current);

	// ── Render ───────────────────────────────────────────────────────────────
	if (!data || !data.connected || !data.app) {
		return (
			<div style={styles.page}>
				<div style={styles.status}>
					<div style={{ textAlign: 'center', maxWidth: 420, padding: '0 24px' }}>
						<div style={styles.statusTitle}>{data === null ? 'Loading…' : 'Not connected'}</div>
						{data !== null && <div>Connect to a RocketRide server to open this tool.</div>}
					</div>
				</div>
			</div>
		);
	}

	if (phase.kind === 'ready') {
		const client = ConnectionManager.getInstance().getClient();
		if (client) {
			const Frame = phase.Frame;
			return (
				<div style={styles.page}>
					<div style={styles.frameHost}>
						<Frame client={client} peer={peerRef.current} channel={channelRef.current} documents={documents} {...(data.docKey ? { docKey: data.docKey } : {})} />
					</div>
				</div>
			);
		}
	}

	return (
		<div style={styles.page}>
			<div style={styles.status}>
				{phase.kind === 'error' ? (
					<div style={{ textAlign: 'center', maxWidth: 460, padding: '0 24px' }}>
						<div style={styles.statusTitle}>Could not load {phase.name}</div>
						<div>{phase.message}</div>
					</div>
				) : (
					<div>Starting {data.app.name}…</div>
				)}
			</div>
		</div>
	);
};

export default DevToolWebview;
