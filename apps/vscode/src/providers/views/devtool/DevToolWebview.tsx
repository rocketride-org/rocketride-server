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
 *   1. registers the tool's remote at the engine's versioned entry URL and
 *      loads its AppDescriptor (the same `<moduleId>/AppDescriptor` module
 *      the shell loads);
 *   2. mounts `descriptor.devToolFrame` with DevToolProps — the peer bus
 *      relayed through the extension host. This document opens NO engine
 *      socket: frames are controller-routed (all engine access rides the
 *      tool channel to the tool's sidebar controller).
 *
 * Theming is ambient: the tool styles itself with the `--rr-*` tokens this
 * document defines (rocketride-default.css + the VS Code variable mapping).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { registerRemotes, loadRemote } from '@module-federation/runtime';
import { createToolChannel, createFrameBusPeer, ConnectionManager } from 'shell';
import type { AppDescriptor, DevToolProps, ToolChannel } from 'shell';
import { useMessaging } from '../hooks/useMessaging';
import type { DevToolWebviewToHost } from '../../types/devToolTypes';
import type { DevToolViewPayload } from 'shared/ops/hostOps';

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

/** The panel's identity — stamped into the served HTML by the host,
 *  present before any script ran. */
const STAMPED_APP_ID = document.body.dataset.rrTool ?? '';
const STAMPED_DOC_KEY = document.body.dataset.rrDoc ?? '';

const DevToolWebview: React.FC = () => {
	const cm = ConnectionManager.getInstance();
	// Boot state is PULLED from the host (host.devtools.load), which owns the
	// catalog and the connection — a tool panel opens long after activation,
	// so this realm must not have to re-derive it from mirror replay.
	// `undefined` = the answer has not arrived yet (render Loading, not
	// "Not connected" — those are different states).
	const [data, setData] = useState<DevToolViewPayload | undefined>(undefined);
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	// One container per document: a loaded MF remote cannot be repointed —
	// the host recreates the whole panel on version change.
	const mountedRef = useRef<string | null>(null);

	// Pull on boot, and re-pull whenever this realm's mirrored connection
	// state moves — a reconnect brings a new engine origin and possibly new
	// versions, exactly what the host's re-sent init used to cover.
	useEffect(() => {
		let alive = true;
		let attempt = 0;
		const pull = (): void => {
			if (!alive) return;
			void cm.request('host.devtools.load', { appId: STAMPED_APP_ID } as never).then(
				(payload) => {
					if (!alive) return;
					attempt = 0;
					setData(payload as DevToolViewPayload);
				},
				() => {
					// A first pull can race this realm's attach handshake, and
					// a rejected answer must NEVER leave the frame parked on
					// 'Loading…' forever — back off and ask again. Status
					// changes re-pull too, but a panel opened while the host
					// is settling may see no further status tick at all.
					if (!alive || attempt >= 5) return;
					attempt += 1;
					setTimeout(pull, attempt * 500);
				}
			);
		};
		pull();
		const off = cm.on('shell:statusChange', () => {
			attempt = 0;
			pull();
		});
		return () => {
			alive = false;
			off();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const { sendMessage } = useMessaging<DevToolWebviewToHost, never>({});

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
				// Register + load the tool's remote descriptor. No engine
				// connection here, ever: frames are controller-routed — their
				// ops cross the tool channel to the sidebar controller, which
				// owns the tool's single socket.
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

	// ── DevToolProps (stable identity per tool) ──────────────────────────────
	// The frame-side BUS peer (shell busPeer): subscribing replays the host
	// connection state, then the retained channel state, then live traffic —
	// and announces this frame (HELLO) so the sidebar peer flushes buffered
	// events. The tool's identity is stamped — build once, immediately.
	const peerRef = useRef<{ appId: string; peer: DevToolProps['peer']; channel: ToolChannel } | null>(null);
	if (STAMPED_APP_ID && peerRef.current?.appId !== STAMPED_APP_ID) {
		const peer = createFrameBusPeer(STAMPED_APP_ID, ConnectionManager.getInstance());
		peerRef.current = { appId: STAMPED_APP_ID, peer, channel: createToolChannel(peer) };
	}

	// ── Render ───────────────────────────────────────────────────────────────
	if (!data || !data.connected || !data.app) {
		// `undefined` = the load answer has not arrived yet; a delivered
		// payload with no app/connection is a real disconnected state.
		return (
			<div style={styles.page}>
				<div style={styles.status}>
					<div style={{ textAlign: 'center', maxWidth: 420, padding: '0 24px' }}>
						<div style={styles.statusTitle}>{data === undefined ? 'Loading…' : 'Not connected'}</div>
						{data !== undefined && <div>Connect to a RocketRide server to open this tool.</div>}
					</div>
				</div>
			</div>
		);
	}

	if (phase.kind === 'ready') {
		const Frame = phase.Frame;
		return (
			<div style={styles.page}>
				<div style={styles.frameHost}>
					<Frame peer={peerRef.current!.peer} channel={peerRef.current!.channel} documents={documents} {...(STAMPED_DOC_KEY ? { docKey: STAMPED_DOC_KEY } : {})} />
				</div>
			</div>
		);
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
