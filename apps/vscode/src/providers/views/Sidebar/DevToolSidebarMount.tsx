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
 * DevToolSidebarMount — mounts a tool's devToolSidebar in the RocketRide
 * sidebar webview.
 *
 * The sidebar bundle is built WITHOUT the MF rsbuild plugin (its chunk graph
 * is deliberately all-in-one), so this component initialises a Module
 * Federation host MANUALLY on first use: `init()` from
 * `@module-federation/runtime` with the four share singletons provided
 * programmatically from this bundle's own module instances (react,
 * react-dom, shell, rocketride) — the exact contract the store-app remotes
 * (`runtime: false`, `import: false`) require of their host.
 *
 * The mount gets its own SDK connection (the shell ConnectionManager
 * singleton of THIS document, connected with the host credential) and the
 * host-relayed peer channel to the tool's frame panel. A tool without a
 * devToolSidebar renders the provided fallback (the built-in tool card).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as ReactNS from 'react';
import * as ReactDOMNS from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { init, registerRemotes, loadRemote } from '@module-federation/runtime';
import * as shellNS from 'shell';
import * as rocketrideNS from 'rocketride';
import { ConnectionManager, createToolChannel } from 'shell';
import type { AppDescriptor, DevToolProps } from 'shell';
import type { ToolTab } from 'shared/modules/sidebar/types';

// =============================================================================
// MANUAL MF HOST (one per sidebar document, created on first tool mount)
// =============================================================================

let hostInited = false;

/** Initialises the runtime MF host with this bundle's share singletons. */
function ensureMfHost(): void {
	if (hostInited) return;
	hostInited = true;
	const shareConfig = { singleton: true, requiredVersion: false as const };
	init({
		name: 'rocketride_vscode_sidebar',
		remotes: [],
		shareStrategy: 'loaded-first',
		shared: {
			react: { version: ReactNS.version, scope: 'default', lib: () => ReactNS, shareConfig },
			'react-dom': { version: ReactNS.version, scope: 'default', lib: () => ReactDOMNS, shareConfig },
			shell: { version: '1.0.0', scope: 'default', lib: () => shellNS, shareConfig },
			rocketride: { version: '0.0.0', scope: 'default', lib: () => rocketrideNS, shareConfig },
		},
	});
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	fill: {
		display: 'flex',
		flexDirection: 'column' as const,
		height: '100%',
		minHeight: 0,
	} as CSSProperties,
	status: {
		padding: 16,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Connection facts delivered by the extension host. */
export interface DevToolHostInfo {
	engineHttpUrl: string;
	authToken: string;
}

export interface DevToolSidebarMountProps {
	/** The pinned tool (needs moduleId + registryVersion to mount). */
	tool: ToolTab;
	/** Engine connection facts; null while disconnected. */
	host: DevToolHostInfo | null;
	/** Host-relayed peer channel to the tool's frame panel. */
	peer: DevToolProps['peer'];
	/** Host-relayed documents API (one editor panel per document key). */
	documents?: DevToolProps['documents'];
	/** The tool's fronted document key (null = a non-tool tab is fronted;
	 *  undefined = the host has not reported yet). */
	activeDocKey?: string | null;
	/** Rendered when the tool declares no devToolSidebar (the built-in card). */
	fallback: ReactNode;
}

/** Mount pipeline state. */
type Phase =
	| { kind: 'loading' }
	| { kind: 'ready'; Sidebar: React.ComponentType<DevToolProps> }
	| { kind: 'none' }
	| { kind: 'error'; message: string };

// =============================================================================
// COMPONENT
// =============================================================================

export const DevToolSidebarMount: React.FC<DevToolSidebarMountProps> = ({ tool, host, peer, documents, activeDocKey, fallback }) => {
	const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
	// The typed channel rides the same peer transport; one instance per peer
	// identity (the peer is cached per tool by the webview, so this is one
	// channel per tool for the document's lifetime).
	const channel = useMemo(() => createToolChannel(peer), [peer]);
	// One mount per tool@version per document — a loaded MF container cannot
	// be repointed; a version change re-runs the pipeline for the NEW remote
	// name registration (force) but the stale container may require a reload.
	const mountKeyRef = useRef<string | null>(null);

	useEffect(() => {
		if (!host || !tool.moduleId || tool.registryVersion === undefined) {
			// Forget the mounted key so a reconnect with the SAME facts re-runs
			// the pipeline instead of early-returning into a dead 'none'.
			mountKeyRef.current = null;
			setPhase({ kind: 'none' });
			return;
		}
		const mountKey = `${tool.id}@${tool.registryVersion}@${host.engineHttpUrl}`;
		// `host` arrives as a fresh object on every full update, so this effect
		// re-runs with unchanged facts while the pipeline below is still in
		// flight — the key match skips the re-run, and the in-flight run stays
		// authoritative (its results are gated on key CURRENCY, not on this
		// effect instance, so a skipped re-run cannot orphan it in 'loading').
		if (mountKeyRef.current === mountKey) return;
		mountKeyRef.current = mountKey;

		setPhase({ kind: 'loading' });

		void (async () => {
			try {
				ensureMfHost();

				// This document's shell connection singleton — the mounted
				// sidebar's shell hooks read it, exactly like the frame panel.
				const cm = ConnectionManager.getInstance();
				cm.initialize({ uri: host.engineHttpUrl });
				if (!cm.isConnected()) await cm.connect(host.authToken || undefined);

				registerRemotes([{ name: tool.moduleId!, entry: `${host.engineHttpUrl}/apps/${encodeURIComponent(tool.id)}/v${tool.registryVersion}/remoteEntry.js` }], { force: true });
				const mod = (await loadRemote(`${tool.moduleId}/AppDescriptor`)) as { default: AppDescriptor } | null;
				if (mountKeyRef.current !== mountKey) return;

				const Sidebar = mod?.default?.devToolSidebar;
				setPhase(Sidebar ? { kind: 'ready', Sidebar } : { kind: 'none' });
			} catch (err) {
				if (mountKeyRef.current !== mountKey) return;
				setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
			}
		})();
	}, [tool.id, tool.moduleId, tool.registryVersion, host]);

	if (phase.kind === 'ready') {
		const client = ConnectionManager.getInstance().getClient();
		if (client) {
			const Sidebar = phase.Sidebar;
			return (
				<div style={styles.fill}>
					<Sidebar client={client} peer={peer} channel={channel} {...(documents ? { documents } : {})} {...(activeDocKey !== undefined ? { activeDocKey } : {})} />
				</div>
			);
		}
	}

	if (phase.kind === 'loading') return <div style={styles.status}>Loading {tool.name}…</div>;
	if (phase.kind === 'error') return <div style={styles.status}>Could not load {tool.name}: {phase.message}</div>;
	// No devToolSidebar (or disconnected): the built-in tool card.
	return <>{fallback}</>;
};

export default DevToolSidebarMount;
