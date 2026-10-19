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
// DEV-TOOL MOUNT — mounts a tool's devToolFrame or devToolSidebar in-shell
// =============================================================================
//
// The rocket-ui counterpart of the VS Code extension's DevToolWebview (frame)
// and DevToolSidebarMount (sidebar) — far smaller here because this host IS
// an MF host already: the tool's descriptor loads through the workspace's
// standard app loading (useWorkspace().loadApp), sharing the shell/react
// singletons and the one authenticated client. No manual federation init, no
// CSP management, no second SDK connection.
// =============================================================================

import React, { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { activeDocKeyFor, ConnectionManager, HOST_CONNECTION_TOPIC, toolDocUri, useShellConnection, useWorkspace } from 'shell';
import { getBuiltinTools } from 'shared/tools/core';
import type { DevToolProps, Documents } from 'shell';
import { getFramePeer, getSidebarPeer, getToolChannel } from './peer';
import { getDocs } from '../../docs';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Bounded flex host: the tool fills it and scrolls internally. */
	host: {
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	/** Centered status message (loading / error / disconnected). */
	status: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		textAlign: 'center',
		padding: '0 24px',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link DevToolMount}. */
export interface DevToolMountProps {
	/** The tool's app id. */
	appId: string;
	/** Display name for the status messages. */
	name?: string;
	/** Which descriptor surface to mount. */
	slot: 'frame' | 'sidebar';
	/** The host-document key this frame serves (per-document tools — e.g.
	    one tab per database connection). Frame slot only. */
	docKey?: string;
}

/**
 * Mounts one surface of a dev tool. Loads the tool's AppDescriptor through
 * the workspace (idempotent; shared with every other consumer of the app),
 * then renders `devToolFrame` or `devToolSidebar` with DevToolProps — the
 * live shell client and the in-memory peer side matching the slot.
 */
const DevToolMount: React.FC<DevToolMountProps> = ({ appId, name, slot, docKey }) => {
	const { loadedApps, loadApp, appLoadErrors } = useWorkspace();
	const { client, isConnected } = useShellConnection();

	// BUILTIN tools resolve from the static registry — no MF load, no
	// workspace descriptor; a store tool can never shadow a builtin id.
	const builtin = getBuiltinTools().find((t) => t.id === appId);

	// Kick the descriptor load; loadApp no-ops when already loaded/loading.
	useEffect(() => {
		if (!builtin) loadApp(appId);
	}, [appId, loadApp, builtin]);

	// Host documents: one top-level tab per docKey, named by the tool. Handed
	// to BOTH slots — the sidebar is where "open this connection" starts.
	const documents = useMemo<NonNullable<DevToolProps['documents']>>(() => ({
		// The EMPTY key names the tool's generic/single pane (`tool:<id>`,
		// no suffix) — the pane a single-pane tool opens on activation.
		open: (key: string, title: string) => getDocs()?.openStaticDocument(toolDocUri(appId, key), title),
		close: (key: string) => getDocs()?.discardDocument(toolDocUri(appId, key)),
	}), [appId]);

	// The HOST owns the `host:connection` system topic (frames derive their
	// enablement from it; no tool publishes it). ONE retained topic for the
	// whole framework now — every frame peer subscribes it and forwards it as
	// the channel state message tools already read (useConnectionReady).
	// Per-mount publishes of the same value are idempotent overwrites.
	useEffect(() => {
		ConnectionManager.getInstance().publish(HOST_CONNECTION_TOPIC, { connected: isConnected });
	}, [isConnected]);

	const label = name ?? appId;
	const descriptor = loadedApps[appId];
	const loadError = appLoadErrors[appId];

	if (!client || !isConnected) {
		return <div style={styles.status}>Connect to a RocketRide server to open {label}.</div>;
	}
	if (!builtin && loadError) {
		return <div style={styles.status}>Could not load {label}: {loadError}</div>;
	}
	if (!builtin && !descriptor) {
		return <div style={styles.status}>Loading {label}…</div>;
	}

	const Component = builtin
		? (slot === 'frame' ? builtin.frame : builtin.sidebar)
		: (slot === 'frame' ? descriptor?.devToolFrame : descriptor?.devToolSidebar);
	if (!Component) {
		return <div style={styles.status}>{label} does not declare a {slot === 'frame' ? 'devToolFrame' : 'devToolSidebar'}.</div>;
	}

	const peer = slot === 'frame' ? getFramePeer(appId) : getSidebarPeer(appId);
	const channel = getToolChannel(appId, slot);

	// Sidebar mounts (controllers) follow the workbench's fronted tab via
	// activeDocKey — host-tracked, exactly like the VS Code extension. The
	// inner component exists so the Documents store hook is unconditional.
	const docs = getDocs();
	if (slot === 'sidebar' && docs) {
		return (
			<div style={styles.host}>
				<SidebarWithActiveDoc docs={docs} appId={appId} Component={Component} peer={peer} channel={channel} documents={documents} />
			</div>
		);
	}

	return (
		<div style={styles.host}>
			<Component peer={peer} channel={channel} documents={documents} {...(docKey !== undefined ? { docKey } : {})} />
		</div>
	);
};

/** Props for {@link SidebarWithActiveDoc}. */
interface ISidebarWithActiveDocProps {
	docs: Documents;
	appId: string;
	Component: React.ComponentType<DevToolProps>;
	peer: DevToolProps['peer'];
	channel: DevToolProps['channel'];
	documents: NonNullable<DevToolProps['documents']>;
}

/**
 * Renders a tool's sidebar (controller) with the workbench's fronted tool
 * document as `activeDocKey`: the active editor's `tool:<appId>/<docKey>`
 * URI maps to its key, the generic `tool:<appId>` frame maps to '', and any
 * other document — another tool, a pipeline, a file — maps to null so the
 * controller clears its selection.
 */
const SidebarWithActiveDoc: React.FC<ISidebarWithActiveDocProps> = ({ docs, appId, Component, peer, channel, documents }) => {
	const state = docs.useStore();
	const group = state.groups[state.activeGroupId];
	const editorId = group?.editorIds[group.activeEditorIndex];
	const uri = editorId ? state.editors[editorId]?.documentUri : undefined;
	const activeDocKey = activeDocKeyFor(uri, appId);
	return <Component peer={peer} channel={channel} documents={documents} activeDocKey={activeDocKey} />;
};

export default DevToolMount;
