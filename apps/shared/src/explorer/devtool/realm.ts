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
// EXPLORER DEV TOOL — REALM FACTS (what kind of realm, one channel per peer)
// =============================================================================
//
// Two facts every dev-tool mount needs and the platform does not hand over:
//
//  1. WHICH KIND OF REALM. A VS Code webview realm is SOCKETLESS: its
//     ConnectionManager has no client (`getClient()` is null) and answers
//     `isConnected()` from the framework root's mirror (connection.ts
//     `mirrorConnected`). A realm with a client (rocket-ui) can only be
//     connected through that client. So "connected without a client" proves a
//     socketless realm; a clientless realm that is down cannot be told apart
//     from one whose client is not built yet, and stays `unknown`.
//
//  2. ONE CHANNEL PER PEER. `createToolChannel(peer)` subscribes the peer at
//     construction and can never be disposed (toolChannel.ts). A mount that
//     builds one per render, or per StrictMode mount, leaks a subscription
//     each time (and on the sidebar peer, steals the single live slot,
//     busPeer.ts). {@link channelFor} caches one per peer for the realm's
//     lifetime, which is the peer's lifetime too (the hosts create one
//     sidebar peer per tool per realm).
// =============================================================================

import type { DevToolProps, ToolChannel } from 'shell';

/** A dev-tool mount's peer pipe. */
export type DevToolPeer = DevToolProps['peer'];

/**
 * State topics whose names start with this prefix belong to this library;
 * lanes never publish under it. (The shell reserves `host:` the same way,
 * toolProtocol.ts.)
 */
export const RESERVED_STATE_PREFIX = 'devtool:';

/**
 * The retained state topic a controller publishes its readiness on:
 * `{ ready: <nonce> }` once every handler is served, `{ ready: null }` when it
 * unmounts. Frames hold calls until they see a nonce (frame.ts).
 */
export const CONTROLLER_STATE_TOPIC = `${RESERVED_STATE_PREFIX}controller`;

/** What {@link CONTROLLER_STATE_TOPIC} carries. */
export interface IControllerState {
	/** A nonce per controller mount while it serves; null once it unmounted. */
	ready: string | null;
}

/**
 * A short random id (a controller mount's readiness nonce).
 *
 * @returns The id.
 */
export function mountNonce(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** What kind of realm a ConnectionManager lives in. */
export type RealmKind = 'socketless' | 'client' | 'unknown';

/** What {@link realmKind} reads. */
export interface IRealmProbe {
	/** Whether the realm is connected (mirrored in a socketless realm). */
	isConnected(): boolean;
	/** The realm's own client, or null in a socketless realm. */
	getClient?(): unknown;
}

/**
 * Tell a socketless realm from a realm that owns the client.
 *
 * @param cm - The realm's ConnectionManager (structural).
 * @returns `client` when it holds a client; `socketless` when it is connected
 *   without one; `unknown` otherwise (down and clientless, or no getClient).
 */
export function realmKind(cm: IRealmProbe): RealmKind {
	if (typeof cm.getClient !== 'function') return 'unknown';
	const client = cm.getClient();
	if (client !== null && client !== undefined) return 'client';
	let connected = false;
	try {
		connected = cm.isConnected() === true;
	} catch {
		connected = false;
	}
	return connected ? 'socketless' : 'unknown';
}

/** The channel built for each peer that arrived without a host channel. */
const channels = new WeakMap<DevToolPeer, ToolChannel>();

/**
 * The one channel for a peer: built on first use, reused for the peer's lifetime.
 *
 * @param peer - The mount's peer.
 * @param createToolChannel - The shell's factory (injected: no value import from 'shell').
 * @returns The channel.
 */
export function channelFor(peer: DevToolPeer, createToolChannel: (peer: DevToolPeer) => ToolChannel): ToolChannel {
	let channel = channels.get(peer);
	if (channel === undefined) {
		channel = createToolChannel(peer);
		channels.set(peer, channel);
	}
	return channel;
}
