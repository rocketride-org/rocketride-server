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
// DEV-TOOL MOUNT — this host's descriptor source for the shared tool mount
// =============================================================================
//
// The MOUNT itself is shared (tools/core ToolMount): builtin resolution,
// slot selection, DevToolProps wiring and every status state live there, so
// this host cannot hold a different opinion about them. What belongs here
// is the one genuinely host-specific fact — HOW A DESCRIPTOR IS OBTAINED.
//
// In a framework root that is the shell's own app loader
// (useWorkspace().loadApp): the remotes the bootstrap registered, the
// shared shell/react singletons, one authenticated client. No manual
// federation init, no CSP management, no second SDK connection.
// =============================================================================

import React, { useEffect, useMemo } from 'react';
import { activeDocKeyFor, announceFramePresence, ConnectionManager, toolDocUri, useShellConnection, useWorkspace } from 'shell';
import { isBuiltinTool, ToolMount } from 'shared/tools/core';
import type { ToolDescriptorSource } from 'shared/tools/core';
import type { DevToolProps, Documents } from 'shell';
import { getToolChannel } from './peer';
import { getDocs } from '../../docs';

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
 * Resolves this host's descriptor for a tool and hands it to {@link ToolMount}.
 *
 * @param props - See {@link DevToolMountProps}.
 * @returns The mounted tool surface.
 */
const DevToolMount: React.FC<DevToolMountProps> = ({ appId, name, slot, docKey }) => {
	const { loadedApps, loadApp, appLoadErrors } = useWorkspace();
	const { client, isConnected } = useShellConnection();

	// Builtins never load — the shared mount resolves them from the registry.
	const builtin = isBuiltinTool(appId);

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

	// NOTE: the `host:connection` system topic is published by the HOST at
	// registration time (registerRocketHostOps — level-driven, re-published
	// on every connection edge), NOT here: a per-mount effect keyed on
	// [isConnected] cannot repair a stale retained value when its own hook
	// value never changes, which stranded tools on false while connected.

	const descriptor = loadedApps[appId];
	const loadError = appLoadErrors[appId];
	const source = useMemo<ToolDescriptorSource>(() => {
		if (loadError) return { status: 'error', error: loadError };
		if (!descriptor) return { status: 'loading' };
		return { status: 'ready', descriptor };
	}, [descriptor, loadError]);

	const unavailable = !client || !isConnected ? `Connect to a RocketRide server to open ${name ?? appId}.` : null;
	const channel = getToolChannel(appId, slot);

	// FRAME liveness: announce this mount to the tool's sidebar peer — HELLO
	// on mount (flips it to direct delivery + flushes buffered events), BYE
	// on unmount (re-arms buffering and the panel summon). The channel above
	// is cached per tool (one standing subscription), so presence must ride
	// the MOUNT lifecycle, not the subscription count.
	useEffect(() => {
		if (slot !== 'frame') return;
		return announceFramePresence(appId, ConnectionManager.getInstance());
	}, [appId, slot]);

	// Sidebar mounts (controllers) follow the workbench's fronted tab via
	// activeDocKey — host-tracked, exactly like the VS Code extension. The
	// inner component exists so the Documents store hook is unconditional.
	const docs = getDocs();
	const shared = { appId, slot, channel, documents, source, unavailable, ...(name !== undefined ? { name } : {}) };
	if (slot === 'sidebar' && docs) {
		return <SidebarWithActiveDoc docs={docs} mount={shared} />;
	}

	return <ToolMount {...shared} {...(docKey !== undefined ? { docKey } : {})} />;
};

/** Props for {@link SidebarWithActiveDoc}. */
interface ISidebarWithActiveDocProps {
	docs: Documents;
	mount: Omit<React.ComponentProps<typeof ToolMount>, 'activeDocKey' | 'docKey'>;
}

/**
 * Mounts a tool's sidebar (controller) with the workbench's fronted tool
 * document as `activeDocKey`: the active editor's `tool:<appId>/<docKey>`
 * URI maps to its key, the generic `tool:<appId>` frame maps to '', and any
 * other document — another tool, a pipeline, a file — maps to null so the
 * controller clears its selection.
 *
 * @param props - See {@link ISidebarWithActiveDocProps}.
 * @returns The mounted sidebar.
 */
const SidebarWithActiveDoc: React.FC<ISidebarWithActiveDocProps> = ({ docs, mount }) => {
	const state = docs.useStore();
	const group = state.groups[state.activeGroupId];
	const editorId = group?.editorIds[group.activeEditorIndex];
	const uri = editorId ? state.editors[editorId]?.documentUri : undefined;
	return <ToolMount {...mount} activeDocKey={activeDocKeyFor(uri, mount.appId)} />;
};

export default DevToolMount;
