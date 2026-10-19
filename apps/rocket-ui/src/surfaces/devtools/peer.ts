// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV TOOL PEERS — this host's cached bus-peer identities
// =============================================================================
//
// The peer POLICY and TRANSPORT both live in the shell now (busPeer.ts over
// the bus's retained/signal lanes) — this module only caches the per-tool
// peer and channel objects so React props keep stable identities across
// remounts (a channel holds one standing peer subscription; minting one per
// render would stack them).
//
// The cloud root realm IS the bus authority, so peers here ride the local
// registry — same code path a VS Code webview realm uses over its wire port.
// The frame SUMMON (`host.openToolPanel`) is served by the sidebar provider
// (it owns the document-opening verb).
// =============================================================================

import { ConnectionManager, createToolChannel, createSidebarBusPeer, createFrameBusPeer } from 'shell';
import type { DevToolProps, ToolChannel } from 'shell';

/** The peer shape handed to both mounts. */
type Peer = DevToolProps['peer'];

/** Cached per-tool objects — stable identities across remounts. */
interface Slots {
	framePeer?: Peer;
	sidebarPeer?: Peer;
	frameChannel?: ToolChannel;
	sidebarChannel?: ToolChannel;
}

const slots = new Map<string, Slots>();

function slot(appId: string): Slots {
	let s = slots.get(appId);
	if (!s) {
		s = {};
		slots.set(appId, s);
	}
	return s;
}

/**
 * The peer handed to a tool's FRAME mount (`tool:<appId>` document).
 * Stable identity per tool — safe to pass as a React prop across remounts.
 *
 * @param appId - The tool's app id.
 * @returns The frame-side peer.
 */
export function getFramePeer(appId: string): Peer {
	const s = slot(appId);
	if (!s.framePeer) s.framePeer = createFrameBusPeer(appId, ConnectionManager.getInstance());
	return s.framePeer;
}

/**
 * The peer handed to a tool's SIDEBAR mount.
 * Stable identity per tool — safe to pass as a React prop across remounts.
 *
 * @param appId - The tool's app id.
 * @returns The sidebar-side peer.
 */
export function getSidebarPeer(appId: string): Peer {
	const s = slot(appId);
	if (!s.sidebarPeer) s.sidebarPeer = createSidebarBusPeer(appId, ConnectionManager.getInstance());
	return s.sidebarPeer;
}

/**
 * The cached ToolChannel for one slot of one tool — built lazily over the
 * slot's peer, stable across remounts.
 *
 * @param appId - The tool's app id.
 * @param slotName - Which mount the channel serves.
 * @returns The channel.
 */
export function getToolChannel(appId: string, slotName: 'frame' | 'sidebar'): ToolChannel {
	const s = slot(appId);
	if (slotName === 'frame') {
		if (!s.frameChannel) s.frameChannel = createToolChannel(getFramePeer(appId));
		return s.frameChannel;
	}
	if (!s.sidebarChannel) s.sidebarChannel = createToolChannel(getSidebarPeer(appId));
	return s.sidebarChannel;
}
