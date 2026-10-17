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
// DEV-TOOL PEER — in-memory frame ↔ sidebar channel, one per tool
// =============================================================================
//
// The DevToolProps.peer contract for THIS host. Both of a tool's mounts (the
// `tool:<appId>` document frame and the sidebar mount behind its rail/strip
// tab) live in one window, so no bridge or serialization hop exists — this is
// a plain pub/sub keyed by app id, mirroring the semantics the VS Code
// extension's DevToolBridge provides across webviews:
//
//   - frame → sidebar: delivered live; the LAST message is retained and
//     replayed to a (re)mounted sidebar so it renders without asking.
//   - sidebar → frame: delivered live when the frame is mounted; otherwise
//     buffered (bounded) and the registered frame opener is summoned — a
//     sidebar post to a closed frame is an implicit "open the tool".
//
// Delivery is ASYNCHRONOUS (a fresh macrotask per post), matching the
// webview postMessage semantics tools are written against: a mount that
// posts in reaction to the other mount's message must unwind the stack
// between hops — synchronous delivery turns that mutual reaction into
// direct recursion ("Maximum call stack size exceeded").
// =============================================================================

import { asToolStateMessage, createToolChannel } from 'shell';
import type { DevToolProps, ToolChannel } from 'shell';

/** The peer shape handed to both mounts. */
type Peer = DevToolProps['peer'];

/** Upper bound on sidebar→frame messages held while the frame opens. */
const BUFFER_LIMIT = 64;

/** Per-tool channel state. */
interface Channel {
	frameSubs: Set<(m: unknown) => void>;
	sidebarSubs: Set<(m: unknown) => void>;
	/** Last frame→sidebar message, replayed to a (re)mounted sidebar. */
	retainedToSidebar?: { payload: unknown };
	/** Sidebar→frame messages queued while no frame is mounted. */
	pendingToFrame: unknown[];
	/** Tool-channel STATE toward frames, retained per topic — replayed to a
	 *  frame mount that subscribes later. Unlike buffered events, a state
	 *  publish never summons the frame document. */
	retainedToFrame: Map<string, unknown>;
	/** Cached peer objects — stable identities across remounts. */
	framePeer?: Peer;
	sidebarPeer?: Peer;
	/** Cached ToolChannels — one peer subscription each, stable identities. */
	frameChannel?: ToolChannel;
	sidebarChannel?: ToolChannel;
}

const channels = new Map<string, Channel>();

/** Host hook: how to open a tool's frame when a sidebar post finds none. */
let frameOpener: ((appId: string) => void) | null = null;

/**
 * Registers the host's "open the tool frame" action (the document opener).
 * A sidebar post with no mounted frame buffers the message and calls this.
 *
 * @param open - Opens (or focuses) the tool's document; null to clear.
 */
export function setToolFrameOpener(open: ((appId: string) => void) | null): void {
	frameOpener = open;
}

/** The (lazily created) channel for one tool. */
function channel(appId: string): Channel {
	let ch = channels.get(appId);
	if (!ch) {
		ch = { frameSubs: new Set(), sidebarSubs: new Set(), pendingToFrame: [], retainedToFrame: new Map() };
		channels.set(appId, ch);
	}
	return ch;
}

/**
 * Delivers one message to a subscriber set on a FRESH task (see the file
 * header). The set is read at fire time, so a callback unsubscribed while
 * the message was in flight is not called.
 *
 * @param subs - The live subscriber set (frame or sidebar side).
 * @param message - The opaque payload.
 */
function deliver(subs: Set<(m: unknown) => void>, message: unknown): void {
	setTimeout(() => {
		for (const cb of subs) cb(message);
	}, 0);
}

/**
 * The peer handed to a tool's FRAME mount (`tool:<appId>` document).
 * Stable identity per tool — safe to pass as a React prop across remounts.
 *
 * @param appId - The tool's app id.
 * @returns The frame-side peer.
 */
export function getFramePeer(appId: string): Peer {
	const ch = channel(appId);
	if (!ch.framePeer) {
		ch.framePeer = {
			post: (message: unknown) => {
				// Frame pushes state; retain the last so a sidebar that mounts
				// later renders without a mount-time handshake.
				ch.retainedToSidebar = { payload: message };
				deliver(ch.sidebarSubs, message);
			},
			subscribe: (cb: (message: unknown) => void) => {
				ch.frameSubs.add(cb);
				// Retained channel state first (a late frame renders from the
				// controller's current snapshots), then the buffered events —
				// async like every delivery, skipped if cb unsubscribed first.
				const retained = [...ch.retainedToFrame.values()];
				const pending = ch.pendingToFrame;
				ch.pendingToFrame = [];
				if (retained.length || pending.length) {
					setTimeout(() => {
						if (!ch.frameSubs.has(cb)) return;
						for (const payload of retained) cb(payload);
						for (const payload of pending) cb(payload);
					}, 0);
				}
				return () => ch.frameSubs.delete(cb);
			},
		};
	}
	return ch.framePeer;
}

/**
 * The peer handed to a tool's SIDEBAR mount.
 * Stable identity per tool — safe to pass as a React prop across remounts.
 *
 * @param appId - The tool's app id.
 * @returns The sidebar-side peer.
 */
/**
 * The cached ToolChannel for one slot of one tool — built lazily over the
 * slot's peer, stable across remounts (a channel holds one standing peer
 * subscription; minting one per render would stack them).
 *
 * @param appId - The tool's app id.
 * @param slot - Which mount the channel serves.
 * @returns The channel.
 */
export function getToolChannel(appId: string, slot: 'frame' | 'sidebar'): ToolChannel {
	const ch = channel(appId);
	if (slot === 'frame') {
		if (!ch.frameChannel) ch.frameChannel = createToolChannel(getFramePeer(appId));
		return ch.frameChannel;
	}
	if (!ch.sidebarChannel) ch.sidebarChannel = createToolChannel(getSidebarPeer(appId));
	return ch.sidebarChannel;
}

export function getSidebarPeer(appId: string): Peer {
	const ch = channel(appId);
	if (!ch.sidebarPeer) {
		ch.sidebarPeer = {
			post: (message: unknown) => {
				// Tool-channel STATE: retain per topic (replayed to frames that
				// mount later) and deliver to whoever is mounted. Never buffer,
				// never summon — publishing state must not open documents.
				const state = asToolStateMessage(message);
				if (state) {
					ch.retainedToFrame.set(state.topic, message);
					if (ch.frameSubs.size > 0) deliver(ch.frameSubs, message);
					return;
				}
				if (ch.frameSubs.size > 0) {
					deliver(ch.frameSubs, message);
					return;
				}
				// No frame yet: buffer (bounded, oldest evicted) and summon it —
				// a sidebar post (event / legacy raw message) is a user action
				// per the peer contract.
				ch.pendingToFrame.push(message);
				if (ch.pendingToFrame.length > BUFFER_LIMIT) ch.pendingToFrame.shift();
				frameOpener?.(appId);
			},
			subscribe: (cb: (message: unknown) => void) => {
				ch.sidebarSubs.add(cb);
				// Replay the frame's retained state push — async like every
				// delivery, skipped if cb unsubscribed first.
				const retained = ch.retainedToSidebar;
				if (retained) {
					setTimeout(() => {
						if (ch.sidebarSubs.has(cb)) cb(retained.payload);
					}, 0);
				}
				return () => ch.sidebarSubs.delete(cb);
			},
		};
	}
	return ch.sidebarPeer;
}
