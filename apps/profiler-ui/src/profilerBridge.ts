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
// PROFILER BRIDGE — controls panel ↔ profiler frame, local or cross-document
// =============================================================================
//
// The profiler's SESSION controls (target, session name, start/stop, view
// report, status) live in the SIDEBAR; the data, visualisations, and the viz
// toolbar (thread/style/depth/cutoff) live in the FRAME. The frame owns ALL
// state and server calls — the sidebar is a dumb panel that renders the
// frame's published ProfilerControlsState and sends ProfilerAction events
// back (single-owner rule; the explorerBridge pattern).
//
// Two transports behind one pair of channel faces:
//  - LOCAL: both mounts share one document (the full app) — an in-memory
//    emitter that replays the last state to a late subscriber.
//  - PEER: the mounts are isolated documents (VS Code webviews) — the same
//    messages ride the DevToolProps peer channel. Direction discipline per
//    the peer contract: the panel posts ONLY user actions; the frame PUSHES
//    a full state snapshot on every change, and the host retains the last
//    push so a reloaded sidebar renders without asking.

import type { DevToolProps } from 'shell';

// =============================================================================
// STATE + ACTIONS
// =============================================================================

/** One pickable profiling target (a running task; '' = the server process). */
export interface ProfilerTargetOption {
	token: string;
	label: string;
}

/** Everything the controls panel renders — published by the frame. */
export interface ProfilerControlsState {
	/** Shell connection up (controls disable while down). */
	connected: boolean;
	/** A profiling session is running (start becomes stop, pickers lock). */
	active: boolean;
	/** The rendered status line, e.g. 'Idle (report available)'. */
	statusLine: string;
	/** A finished report exists (enables View Report). */
	hasReport: boolean;
	/** Last action error ('' when none). */
	error: string;
	/** Target options (running tasks); '' is always the server process. */
	targets: ProfilerTargetOption[];
	/** The selected target token ('' = server process). */
	target: string;
}

/** Control events the sidebar sends — applied by the frame. */
export type ProfilerAction =
	| { op: 'setTarget'; target: string }
	| { op: 'start'; session: string }
	| { op: 'stop' }
	| { op: 'viewReport' };

// =============================================================================
// CHANNEL FACES
// =============================================================================

/** The frame's face: publish state, receive actions. */
export interface ProfilerFrameChannel {
	/** Publishes the latest controls state to the panel. */
	publishState(state: ProfilerControlsState): void;
	/** Subscribes to panel actions; returns unsubscribe. */
	subscribeActions(cb: (action: ProfilerAction) => void): () => void;
}

/** The sidebar's face: send actions, receive state. */
export interface ProfilerSidebarChannel {
	/** Sends one control event to the frame. */
	sendAction(action: ProfilerAction): void;
	/** Subscribes to state (replays the latest known); returns unsubscribe. */
	subscribeState(cb: (state: ProfilerControlsState) => void): () => void;
}

// =============================================================================
// LOCAL TRANSPORT — both mounts in one document (the full app)
// =============================================================================

let lastState: ProfilerControlsState | null = null;
const stateSubs = new Set<(s: ProfilerControlsState) => void>();
const actionSubs = new Set<(a: ProfilerAction) => void>();

/** The in-document frame face over the module-level emitter. */
export const localFrameChannel: ProfilerFrameChannel = {
	publishState(state) {
		lastState = state;
		for (const cb of stateSubs) cb(state);
	},
	subscribeActions(cb) {
		actionSubs.add(cb);
		return () => { actionSubs.delete(cb); };
	},
};

/** The in-document sidebar face over the module-level emitter. */
export const localSidebarChannel: ProfilerSidebarChannel = {
	sendAction(action) {
		for (const cb of actionSubs) cb(action);
	},
	subscribeState(cb) {
		// Replay the latest state so a late-mounting panel renders immediately.
		if (lastState) cb(lastState);
		stateSubs.add(cb);
		return () => { stateSubs.delete(cb); };
	},
};

// =============================================================================
// PEER TRANSPORT — isolated mounts (VS Code webviews)
// =============================================================================

/** The peer wire protocol between the two mounts (app-internal). */
type ProfilerPeerMessage =
	| { t: 'state'; state: ProfilerControlsState }
	| { t: 'action'; action: ProfilerAction };

/**
 * Builds the frame's channel face over the host-relayed peer. The frame
 * publishes on every state change (including right after mount), so the
 * host's retained last message keeps a reloaded sidebar current.
 *
 * @param peer - The host-relayed channel from DevToolProps.
 * @returns The frame face.
 */
export function createPeerFrameChannel(peer: DevToolProps['peer']): ProfilerFrameChannel {
	return {
		publishState(state) {
			peer.post({ t: 'state', state } satisfies ProfilerPeerMessage);
		},
		subscribeActions(cb) {
			return peer.subscribe((message) => {
				const msg = message as ProfilerPeerMessage;
				if (msg && msg.t === 'action') cb(msg.action);
			});
		},
	};
}

/**
 * Builds the sidebar's channel face over the host-relayed peer. Posts
 * nothing on mount — only user actions (a post to a closed frame summons
 * it, which is exactly right for a clicked control and exactly wrong for a
 * handshake).
 *
 * @param peer - The host-relayed channel from DevToolProps.
 * @returns The sidebar face.
 */
export function createPeerSidebarChannel(peer: DevToolProps['peer']): ProfilerSidebarChannel {
	return {
		sendAction(action) {
			peer.post({ t: 'action', action } satisfies ProfilerPeerMessage);
		},
		subscribeState(cb) {
			return peer.subscribe((message) => {
				const msg = message as ProfilerPeerMessage;
				if (msg && msg.t === 'state') cb(msg.state);
			});
		},
	};
}
