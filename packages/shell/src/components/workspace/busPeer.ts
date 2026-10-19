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

// =============================================================================
// BUS PEER — the tool peer carried on the shell bus's retained/signal lanes
// =============================================================================
//
// The `DevToolProps['peer']` transport between a tool's two mounts (sidebar ↔
// frame), re-carried on the bus so NO host ships a relay: the old policy
// (toolRelay.ts) ran once per tool inside a host-specific bridge (VS Code's
// DevToolBridge across webviews; the cloud's in-process twin). Here the same
// policy is expressed as lane choices, identical in every host:
//
//   - CALLS (frame→sidebar) and REPLIES (sidebar→frame): SIGNALS — live-only
//     by nature (a signal with no subscriber drops; the caller's timeout
//     reports it). toolChannel's own correlation is untouched.
//   - Channel STATE (sidebar→frame): ONE retained topic per tool holding the
//     {topic → state message} map. The root retains it, a (re)attached frame
//     REPLAYS it — retained state arrives before any later event by the
//     transport's FIFO (the frame subscribes state before events).
//   - Other frame→sidebar payloads: a SIGNAL plus a single-slot retained
//     topic (the last payload) — a remounted sidebar renders without a
//     mount-time handshake, exactly the old `retainedToSidebar` slot.
//   - Other sidebar→frame payloads (events — user actions by the peer
//     contract): SIGNALS when a frame is live; otherwise buffered (bounded,
//     oldest-evicted) in the sidebar peer and the frame is SUMMONED via the
//     `host.openToolPanel` op. The buffer flushes on the frame's HELLO.
//
// Frame liveness: every frame mount announces itself with a HELLO signal
// (and a BYE from its unsubscribe, where unmount cleanup runs — in-process
// hosts); hosts whose panels can die without cleanup (VS Code webviews)
// additionally publish the authoritative panel count on the tool's presence
// topic. The sidebar peer trusts presence when published, hellos otherwise.
//
// ORDER CONTRACT a frame mount relies on: `host:connection` state first,
// then retained channel state, then buffered events — guaranteed here by
// subscribing in that order (the root replays in subscribeTopic receipt
// order; the transport is FIFO).
// =============================================================================

import type { DevToolProps } from './types';
import { asToolStateMessage } from './toolChannel';
import { asToolCallMessage, asToolReplyMessage } from './toolOps';
import { HOST_CONNECTION_TOPIC, hostConnectionPayload, TOOL_RELAY_BUFFER_LIMIT } from './toolRelay';

/**
 * What the peers need from a realm's bus — STRUCTURAL on purpose: a nominal
 * class (ConnectionManager) in an input position on the frozen shell surface
 * flips the contract check contravariant (see contract-hold.ts). Any realm
 * ConnectionManager satisfies this.
 */
export interface IBusPeerBus {
	publish(topic: string, snapshot: unknown): void;
	signal(topic: string, payload: unknown): void;
	subscribe(topic: string, cb: (snapshot: unknown) => void): () => void;
	read(topic: string): Promise<unknown>;
	emitOp(op: string, params: unknown): void;
}

/** The peer-internal handshake envelope (never forwarded to tools). */
interface IPeerHandshake {
	__rrpeer: 'hello' | 'bye';
}

function asHandshake(message: unknown): IPeerHandshake | null {
	const m = message as IPeerHandshake | null;
	return m && typeof m === 'object' && (m.__rrpeer === 'hello' || m.__rrpeer === 'bye') ? m : null;
}

/** Topic names for one tool's peer lanes. */
const topics = (appId: string) => ({
	/** RETAINED: { toolTopic → state message } (sidebar → frames). */
	state: `tool:${appId}:state`,
	/** SIGNALS: replies + events toward the frames. */
	toFrame: `tool:${appId}:toFrame`,
	/** SIGNALS: calls + events + hello/bye toward the sidebar. */
	toSidebar: `tool:${appId}:toSidebar`,
	/** RETAINED single slot: the last non-call frame payload. */
	lastToSidebar: `tool:${appId}:lastToSidebar`,
	/** RETAINED: authoritative open-panel count (hosts that publish it). */
	panels: `tool:${appId}:panels`,
});

type Peer = DevToolProps['peer'];

// =============================================================================
// SIDEBAR SIDE — singleton per tool
// =============================================================================

/**
 * The sidebar mount's peer for one tool. Create ONE per tool per realm and
 * keep it for the realm's lifetime (mounts subscribe and unsubscribe; the
 * peer's buffers and liveness tracking persist across remounts).
 *
 * @param appId - The tool's app id.
 * @param cm - The realm's bus verbs (its ConnectionManager).
 * @returns The peer.
 */
export function createSidebarBusPeer(appId: string, cm: IBusPeerBus): Peer {
	const t = topics(appId);

	// ── Frame liveness ───────────────────────────────────────────────────────
	/** Authoritative panel count when a host publishes it; null = none does. */
	let presence: number | null = null;
	/** Hello/bye ledger — the in-process fallback. */
	let helloCount = 0;
	/** True once a frame said hello while the current frames were live —
	 *  events signal directly only then (a panel that EXISTS but has not
	 *  subscribed yet must not eat signals into the void). */
	let frameReady = false;

	const frameExists = (): boolean => (presence !== null ? presence > 0 : helloCount > 0);

	// ── Channel state (this peer is the topic's ONE writer) ─────────────────
	// The map lives here; the root's retained copy is for frame replay. A
	// reborn sidebar realm reads before it writes (doctrine) so republishing
	// one topic never drops the others; the chain serializes folds so rapid
	// posts cannot interleave.
	const stateMap: Record<string, unknown> = {};
	let stateChain: Promise<void> = cm
		.read(t.state)
		.then((current) => {
			Object.assign(stateMap, (current as Record<string, unknown>) ?? {});
		})
		.catch(() => {});

	// ── Buffers ──────────────────────────────────────────────────────────────
	/** Events awaiting a ready frame (bounded, oldest-evicted). */
	const bufferToFrame: unknown[] = [];
	const push = (payload: unknown): void => {
		bufferToFrame.push(payload);
		if (bufferToFrame.length > TOOL_RELAY_BUFFER_LIMIT) bufferToFrame.shift();
	};
	const flushToFrame = (): void => {
		for (const payload of bufferToFrame.splice(0)) cm.signal(t.toFrame, payload);
	};

	// ── Sidebar mount delivery (hold until the mount subscribes) ────────────
	let sidebarCb: ((message: unknown) => void) | null = null;
	const holdToSidebar: unknown[] = [];
	const deliverToSidebar = (message: unknown): void => {
		if (sidebarCb) sidebarCb(message);
		else {
			holdToSidebar.push(message);
			if (holdToSidebar.length > TOOL_RELAY_BUFFER_LIMIT) holdToSidebar.shift();
		}
	};

	// ── Standing subscriptions (the peer lives as long as the realm) ────────
	cm.subscribe(t.toSidebar, (message) => {
		const handshake = asHandshake(message);
		if (handshake) {
			if (handshake.__rrpeer === 'hello') {
				helloCount += 1;
				frameReady = true;
				flushToFrame();
			} else {
				helloCount = Math.max(0, helloCount - 1);
				if (!frameExists()) frameReady = false;
			}
			return;
		}
		deliverToSidebar(message);
	});
	cm.subscribe(t.panels, (snapshot) => {
		presence = typeof snapshot === 'number' ? snapshot : null;
		if (!frameExists()) frameReady = false;
	});

	return {
		post(message) {
			// REPLY: live-only — a signal with no subscriber drops, which IS
			// the policy (a closed caller already gave up).
			if (asToolReplyMessage(message)) {
				cm.signal(t.toFrame, message);
				return;
			}
			// Channel STATE: retained per topic at the root; never buffers,
			// never summons. The map REPLACES wholesale (immutable snapshot),
			// folded through the chain so posts never interleave.
			const state = asToolStateMessage(message);
			if (state) {
				stateChain = stateChain.then(() => {
					stateMap[state.topic] = message;
					cm.publish(t.state, { ...stateMap });
				});
				return;
			}
			// EVENT (a user action by the peer contract): deliver to a ready
			// frame, else buffer and summon one.
			if (frameReady) {
				cm.signal(t.toFrame, message);
				return;
			}
			push(message);
			if (!frameExists()) cm.emitOp('host.openToolPanel', { appId });
		},
		subscribe(cb) {
			sidebarCb = cb;
			// The retained last frame payload replays via the root on this
			// subscription (remount render without a handshake).
			const offLast = cm.subscribe(t.lastToSidebar, (snapshot) => {
				if (snapshot !== undefined) cb(snapshot);
			});
			for (const held of holdToSidebar.splice(0)) cb(held);
			return () => {
				if (sidebarCb === cb) sidebarCb = null;
				offLast();
			};
		},
	};
}

// =============================================================================
// FRAME SIDE — one per frame mount
// =============================================================================

/**
 * A frame mount's peer for one tool. Create one per mount; its subscribe's
 * cleanup says BYE (hosts whose panels die without cleanup publish the
 * presence topic instead).
 *
 * @param appId - The tool's app id.
 * @param cm - The realm's bus verbs (its ConnectionManager).
 * @returns The peer.
 */
export function createFrameBusPeer(appId: string, cm: IBusPeerBus): Peer {
	const t = topics(appId);

	return {
		post(message) {
			// CALL: live-only toward the sidebar (never retained — a reloaded
			// sidebar must not re-execute it).
			if (asToolCallMessage(message)) {
				cm.signal(t.toSidebar, message);
				return;
			}
			// Everything else: live signal + the single retained slot so a
			// remounted sidebar renders from the last push.
			cm.publish(t.lastToSidebar, message);
			cm.signal(t.toSidebar, message);
		},
		subscribe(cb) {
			// SUBSCRIPTION ORDER IS THE REPLAY ORDER (root replays FIFO):
			// host connection first, retained channel state second, live
			// replies/events last.
			const offConnection = cm.subscribe(HOST_CONNECTION_TOPIC, (snapshot) => {
				const s = snapshot as { connected?: boolean } | undefined;
				if (s && typeof s.connected === 'boolean') cb(hostConnectionPayload(s.connected));
			});
			// The state map: forward only CHANGED entries (the map replaces
			// wholesale on every publish; unchanged topics keep identity).
			let lastSeen: Record<string, unknown> = {};
			const offState = cm.subscribe(t.state, (snapshot) => {
				const map = (snapshot as Record<string, unknown>) ?? {};
				for (const [topic, stateMessage] of Object.entries(map)) {
					if (lastSeen[topic] !== stateMessage) cb(stateMessage);
				}
				lastSeen = map;
			});
			const offFrame = cm.subscribe(t.toFrame, (message) => cb(message));
			// Announce AFTER the subscriptions so a flushed buffer lands here.
			cm.signal(t.toSidebar, { __rrpeer: 'hello' } satisfies IPeerHandshake);
			return () => {
				cm.signal(t.toSidebar, { __rrpeer: 'bye' } satisfies IPeerHandshake);
				offConnection();
				offState();
				offFrame();
			};
		},
	};
}
