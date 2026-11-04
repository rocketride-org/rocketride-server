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
 * DevToolSidebarMount - this realm's descriptor source for the shared tool
 * mount.
 *
 * The MOUNT itself is shared (tools/core ToolMount): builtin resolution,
 * slot selection, DevToolProps wiring and every status state live there, so
 * this host cannot hold a different opinion about them - which it used to,
 * most visibly about WHEN to mount.
 *
 * What is genuinely this realm's own is how a descriptor is obtained. The
 * sidebar bundle is built WITHOUT the MF rsbuild plugin (its chunk graph is
 * deliberately all-in-one), so there is no bootstrap to inherit registered
 * remotes from: this module initialises a Module Federation host MANUALLY on
 * first use - `init()` from `@module-federation/runtime` with the four share
 * singletons provided programmatically from this bundle's own module
 * instances (react, react-dom, shell, rocketride), the exact contract the
 * store-app remotes (`runtime: false`, `import: false`) require of their
 * host - and composes each remote entry URL from the engine URL itself.
 *
 * The mount reaches the engine over the shell bus (brokered client.* ops),
 * never its own socket, and talks to the tool's frame panel over the
 * host-relayed peer.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as ReactNS from 'react';
import * as ReactDOMNS from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { init, registerRemotes, loadRemote } from '@module-federation/runtime';
import * as shellNS from 'shell';
import * as rocketrideNS from 'rocketride';
import { createToolChannel } from 'shell';
import type { AppDescriptor, DevToolProps, IToolPeer } from 'shell';
import { ToolMount } from 'shared/tools/core';
import type { ToolDescriptorSource } from 'shared/tools/core';
import type { ToolTab } from 'shared/tools/core/chrome/types';

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
	status: {
		padding: 16,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Connection facts delivered by the extension host. NO TOKEN: engine
 *  access rides the shell bus (brokered client.* ops); the URL exists only
 *  to resolve the tool's MF remote entry. */
export interface DevToolHostInfo {
	engineHttpUrl: string;
}

/** Props for {@link DevToolSidebarMount}. */
export interface DevToolSidebarMountProps {
	/** The pinned tool (needs moduleId + registryVersion to mount). */
	tool: ToolTab;
	/** Engine connection facts; null while disconnected. */
	host: DevToolHostInfo | null;
	/** The transport pipe to the tool's frame panel (host-internal; the
	 *  channel below is built over it). */
	peer: IToolPeer;
	/** Host-relayed documents API (one editor panel per document key). */
	documents?: DevToolProps['documents'];
	/** The tool's fronted document key (null = a non-tool tab is fronted;
	 *  undefined = the host has not reported yet). */
	activeDocKey?: string | null;
	/** Rendered when the tool declares no devToolSidebar (the built-in card). */
	fallback: ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Loads one tool's descriptor through this realm's MF host and hands it to
 * {@link ToolMount}.
 *
 * @param props - See {@link DevToolSidebarMountProps}.
 * @returns The mounted tool sidebar.
 */
export const DevToolSidebarMount: React.FC<DevToolSidebarMountProps> = ({ tool, host, peer, documents, activeDocKey, fallback }) => {
	const [source, setSource] = useState<ToolDescriptorSource>({ status: 'loading' });
	// The typed channel rides the same peer transport; one instance per peer
	// identity (the peer is cached per tool by the webview, so this is one
	// channel per tool for the document's lifetime).
	const channel = useMemo(() => createToolChannel(peer), [peer]);
	// One mount per tool@version per document - a loaded MF container cannot
	// be repointed; a version change re-runs the pipeline for the NEW remote
	// name registration (force) but the stale container may require a reload.
	const mountKeyRef = useRef<string | null>(null);

	useEffect(() => {
		if (!host || !tool.moduleId || tool.registryVersion === undefined) {
			// Forget the mounted key so a reconnect with the SAME facts re-runs
			// the pipeline instead of early-returning into a dead state. No
			// descriptor and no error: disconnected is not a load FAILURE, so
			// the shared mount renders the card rather than an error line.
			mountKeyRef.current = null;
			setSource({ status: 'ready', descriptor: null });
			return;
		}
		const mountKey = `${tool.id}@${tool.registryVersion}@${host.engineHttpUrl}`;
		// `host` arrives as a fresh object on every full update, so this effect
		// re-runs with unchanged facts while the pipeline below is still in
		// flight - the key match skips the re-run, and the in-flight run stays
		// authoritative (its results are gated on key CURRENCY, not on this
		// effect instance, so a skipped re-run cannot orphan it in 'loading').
		if (mountKeyRef.current === mountKey) return;
		mountKeyRef.current = mountKey;

		setSource({ status: 'loading' });

		void (async () => {
			try {
				ensureMfHost();

				// NO realm socket: the mounted sidebar's shell hooks read the
				// realm singleton, whose state is BUS-MIRRORED from the
				// extension host (CM mirror subscriptions) and whose engine
				// access is request('client.*') through the broker.
				registerRemotes([{ name: tool.moduleId!, entry: `${host.engineHttpUrl}/apps/${encodeURIComponent(tool.id)}/v${tool.registryVersion}/remoteEntry.js` }], { force: true });
				const mod = (await loadRemote(`${tool.moduleId}/AppDescriptor`)) as { default: AppDescriptor } | null;
				if (mountKeyRef.current !== mountKey) return;
				setSource({ status: 'ready', descriptor: mod?.default ?? null });
			} catch (err) {
				if (mountKeyRef.current !== mountKey) return;
				setSource({ status: 'error', error: err instanceof Error ? err.message : String(err) });
			}
		})();
	}, [tool.id, tool.moduleId, tool.registryVersion, host]);

	// This realm words its own wait: the shared mount's centred status suits
	// a document surface, not a narrow sidebar column.
	if (source.status === 'loading') return <div style={styles.status}>Loading {tool.name}...</div>;

	return (
		<ToolMount
			appId={tool.id}
			name={tool.name}
			slot="sidebar"
			channel={channel}
			source={source}
			fallback={fallback}
			{...(documents !== undefined ? { documents } : {})}
			{...(activeDocKey !== undefined ? { activeDocKey } : {})}
		/>
	);
};

export default DevToolSidebarMount;
