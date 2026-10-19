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
// TOOL CHANNEL — typed state/event channel between a tool's two mounts
// =============================================================================
//
// The programming model every tool (store app or builtin) codes against:
//
//   - STATE flows controller → documents. A snapshot per topic, RETAINED:
//     any subscriber — a document opening minutes later, a component
//     mounting late — receives the latest snapshot immediately. No
//     handshakes, no replicas, exactly one publisher (the controller).
//   - EVENTS flow in either direction, fire-and-forget. A document hands a
//     user action to the controller ('saveConnection'); a controller points
//     its documents somewhere ('openTableRecord'). Hosts may summon a
//     closed window for an event — never for a state publish.
//
// Transport: the channel rides the DevToolProps.peer pipe in a reserved
// envelope (`__rrtool`). Unlike raw peer payloads, the envelope is
// deliberately host-INSPECTABLE: host relays retain the last snapshot per
// (tool, topic) and replay it to newly attached realms, and they tell a
// state publish apart from an event so publishing never pops windows.
// Messages without the envelope pass through untouched — tools still on the
// raw peer keep working beside channel-based ones.
// =============================================================================

import type { DevToolProps } from './types';

/** The envelope key — reserved; raw peer payloads must not carry it.
 *  Kinds 'state' and 'event' are defined here; kinds 'call' and 'reply'
 *  belong to the op-call lane (toolOps.ts) and are ignored by this
 *  channel's subscriptions. */
const ENVELOPE = '__rrtool';

/** A retained state snapshot on the wire. */
export interface IToolStateMessage {
	[ENVELOPE]: 'state';
	topic: string;
	snapshot: unknown;
}

/** A fire-and-forget event on the wire. */
export interface IToolEventMessage {
	[ENVELOPE]: 'event';
	name: string;
	payload?: unknown;
}

/**
 * Narrows a peer payload to a channel STATE message — for host relays
 * (retention, replay, no-summon) and the channel itself.
 *
 * @param message - Any peer payload.
 * @returns The state message, or null.
 */
export function asToolStateMessage(message: unknown): IToolStateMessage | null {
	const m = message as IToolStateMessage | null;
	return m && typeof m === 'object' && m[ENVELOPE] === 'state' && typeof m.topic === 'string' ? m : null;
}

/**
 * Narrows a peer payload to a channel EVENT message.
 *
 * @param message - Any peer payload.
 * @returns The event message, or null.
 */
export function asToolEventMessage(message: unknown): IToolEventMessage | null {
	const m = message as IToolEventMessage | null;
	return m && typeof m === 'object' && m[ENVELOPE] === 'event' && typeof m.name === 'string' ? m : null;
}

/** Unsubscribe handle. */
export type ToolChannelUnsubscribe = () => void;

/**
 * The typed channel between a tool's controller (devToolSidebar) and its
 * document views (devToolFrame mounts). See the file header for the model.
 */
export interface ToolChannel {
	/**
	 * CONTROLLER ONLY: publish a state snapshot. Retained — late subscribers
	 * receive the latest immediately. One publisher per topic by contract.
	 *
	 * @param topic - Tool-scoped topic name (e.g. 'connections').
	 * @param snapshot - The full snapshot (replaces the previous one).
	 */
	publishState(topic: string, snapshot: unknown): void;
	/**
	 * Subscribe to a state topic. The retained snapshot (if any) is replayed
	 * synchronously before live updates.
	 *
	 * @param topic - The topic to follow.
	 * @param cb - Receives each snapshot.
	 * @returns Unsubscribe.
	 */
	onState(topic: string, cb: (snapshot: unknown) => void): ToolChannelUnsubscribe;
	/**
	 * Send an event to the other side (documents → controller, or
	 * controller → documents). Buffered by the host while the other side
	 * opens; an event MAY summon a closed window, so send only for user
	 * actions and directed commands.
	 *
	 * @param name - Tool-scoped event name (e.g. 'saveConnection').
	 * @param payload - Optional payload.
	 */
	sendEvent(name: string, payload?: unknown): void;
	/**
	 * Subscribe to an event by name. Events are not retained.
	 *
	 * @param name - The event name to follow.
	 * @param cb - Receives each payload.
	 * @returns Unsubscribe.
	 */
	onEvent(name: string, cb: (payload: unknown) => void): ToolChannelUnsubscribe;
}

/**
 * Builds a ToolChannel over a DevToolProps.peer pipe. Called by HOST mounts
 * (one channel per mount); tools receive the result as
 * {@link DevToolProps.channel} and never construct one themselves.
 *
 * The instance keeps a per-realm retained-snapshot map so a component that
 * subscribes after a snapshot arrived still gets it; cross-realm replay to
 * freshly attached documents is the host relay's job (it re-delivers its
 * retained state messages into the new realm, which lands here).
 *
 * @param peer - The mount's peer pipe.
 * @returns The channel.
 */
export function createToolChannel(peer: DevToolProps['peer']): ToolChannel {
	// Latest snapshot per topic seen (or published) in THIS realm.
	const lastState = new Map<string, unknown>();
	// One underlying peer subscription fans out to topic/event subscribers.
	const stateSubs = new Map<string, Set<(snapshot: unknown) => void>>();
	const eventSubs = new Map<string, Set<(payload: unknown) => void>>();

	peer.subscribe((message) => {
		const state = asToolStateMessage(message);
		if (state) {
			lastState.set(state.topic, state.snapshot);
			stateSubs.get(state.topic)?.forEach((cb) => cb(state.snapshot));
			return;
		}
		const event = asToolEventMessage(message);
		if (event) eventSubs.get(event.name)?.forEach((cb) => cb(event.payload));
	});

	return {
		publishState(topic, snapshot) {
			// Retain locally too: in-realm subscribers (the controller's own
			// components) replay without a transport round trip.
			lastState.set(topic, snapshot);
			stateSubs.get(topic)?.forEach((cb) => cb(snapshot));
			peer.post({ [ENVELOPE]: 'state', topic, snapshot } satisfies IToolStateMessage);
		},
		onState(topic, cb) {
			const subs = stateSubs.get(topic) ?? new Set();
			subs.add(cb);
			stateSubs.set(topic, subs);
			if (lastState.has(topic)) cb(lastState.get(topic));
			return () => { subs.delete(cb); };
		},
		sendEvent(name, payload) {
			peer.post({ [ENVELOPE]: 'event', name, payload } satisfies IToolEventMessage);
		},
		onEvent(name, cb) {
			const subs = eventSubs.get(name) ?? new Set();
			subs.add(cb);
			eventSubs.set(name, subs);
			return () => { subs.delete(cb); };
		},
	};
}
