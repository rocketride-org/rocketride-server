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
// TOOL CHANNEL — the typed channel between a tool's two mounts
// =============================================================================
//
// The programming model every tool (store app or builtin) codes against —
// THE tool-facing transport (DevToolProps.channel; the raw peer pipe is a
// host-internal seam, see {@link IToolPeer}):
//
//   - STATE flows controller → documents. A snapshot per topic, RETAINED:
//     any subscriber — a document opening minutes later, a component
//     mounting late — receives the latest snapshot immediately. No
//     handshakes, no replicas, exactly one publisher (the controller).
//   - EVENTS flow in either direction, fire-and-forget. A document hands a
//     user action to the controller ('saveConnection'); a controller points
//     its documents somewhere ('openTableRecord'). Hosts may summon a
//     closed window for an event — never for a state publish.
//   - OPS are the correlated request/response lane (call/serveOp): a frame
//     asks the controller to execute an operation and awaits the result.
//     The typed surface over this lane lives in toolOps.ts
//     (createToolOpClient / createToolOpServer).
//
// Transport: the channel rides a host-built {@link IToolPeer} pipe in a
// reserved envelope (`__rrtool`). The envelope is deliberately
// host-INSPECTABLE: host relays retain the last snapshot per (tool, topic)
// and replay it to newly attached realms; they tell a state publish apart
// from an event so publishing never pops windows; and they keep calls out of
// retention and deliver replies to live subscribers only.
// =============================================================================

/**
 * The raw pipe a HOST builds a channel over — the transport seam between a
 * tool's two mounts. Host-internal: tools never see one (DevToolProps
 * carries only the channel); hosts obtain theirs from the bus peers
 * (busPeer.ts) or a loopback (toolHost.ts).
 */
export interface IToolPeer {
	/** Send a message to the other mount (buffered briefly while it opens). */
	post(message: unknown): void;
	/** Subscribe to messages from the other mount; returns unsubscribe. */
	subscribe(cb: (message: unknown) => void): () => void;
}

/** The envelope key — reserved for the channel's four kinds:
 *  'state' / 'event' here, 'call' / 'reply' for the op lane below. */
const ENVELOPE = '__rrtool';

/** Default per-call timeout for the op lane — generous because engine-side
 *  statements can legitimately run long; override per call. */
export const DEFAULT_OP_TIMEOUT_MS = 120_000;

/** Per-call options for the op lane. */
export interface IToolCallOptions {
	/** Overrides {@link DEFAULT_OP_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** A correlated request on the wire. */
export interface IToolCallMessage {
	[ENVELOPE]: 'call';
	id: string;
	op: string;
	args?: unknown;
}

/** A correlated reply on the wire. */
export interface IToolReplyMessage {
	[ENVELOPE]: 'reply';
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

/**
 * Narrows a peer payload to a CALL — for the channel and the host relays
 * (which must exclude calls from retention).
 *
 * @param message - Any peer payload.
 * @returns The call message, or null.
 */
export function asToolCallMessage(message: unknown): IToolCallMessage | null {
	const m = message as IToolCallMessage | null;
	return m && typeof m === 'object' && m[ENVELOPE] === 'call' && typeof m.id === 'string' && typeof m.op === 'string' ? m : null;
}

/**
 * Narrows a peer payload to a REPLY — for the channel and the host relays
 * (which deliver replies to live subscribers only).
 *
 * @param message - Any peer payload.
 * @returns The reply message, or null.
 */
export function asToolReplyMessage(message: unknown): IToolReplyMessage | null {
	const m = message as IToolReplyMessage | null;
	return m && typeof m === 'object' && m[ENVELOPE] === 'reply' && typeof m.id === 'string' && typeof m.ok === 'boolean' ? m : null;
}

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
	/**
	 * FRAME side of the op lane: ask the controller to execute one operation
	 * and await the result. Untyped core — tools call through the typed
	 * surface (createToolOpClient, toolOps.ts).
	 *
	 * Timeouts are honest: 'did not answer' is NOT 'did not happen' — the
	 * controller may still be executing. No automatic retries, ever.
	 *
	 * @param op - The op's wire name.
	 * @param args - The op's parameters.
	 * @param opts - Timeout override.
	 * @returns The handler's result.
	 */
	call(op: string, args?: unknown, opts?: IToolCallOptions): Promise<unknown>;
	/**
	 * CONTROLLER side of the op lane: serve one operation. Replaces any
	 * previous handler for the op. Untyped core — controllers register
	 * through the typed surface (createToolOpServer, toolOps.ts).
	 *
	 * Reply-iff-tracked: a CALL gets a correlated reply; a plain channel
	 * EVENT whose name matches a served op runs the same handler with NO
	 * reply (opt-in correlation — nothing dangles).
	 *
	 * @param op - The op's wire name.
	 * @param handler - Plain async function; a thrown error becomes the
	 *                  caller's rejection (its message crosses the wire).
	 * @returns Unregister for this op.
	 */
	serveOp(op: string, handler: (params: unknown) => unknown): ToolChannelUnsubscribe;
}

/** Collision-safe id prefix per channel (replies broadcast to every frame of
 *  the tool; each channel claims only ids it minted). */
function callerPrefix(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

/**
 * Builds a ToolChannel over a host transport pipe. Called by HOST mounts
 * (one channel per mount); tools receive the result as
 * {@link DevToolProps.channel} and never construct one themselves.
 *
 * The instance keeps a per-realm retained-snapshot map so a component that
 * subscribes after a snapshot arrived still gets it; cross-realm replay to
 * freshly attached documents is the host relay's job (it re-delivers its
 * retained state messages into the new realm, which lands here).
 *
 * @param peer - The mount's transport pipe (host-built; see IToolPeer).
 * @returns The channel.
 */
export function createToolChannel(peer: IToolPeer): ToolChannel {
	// Latest snapshot per topic seen (or published) in THIS realm.
	const lastState = new Map<string, unknown>();
	// One underlying peer subscription fans out to topic/event subscribers.
	const stateSubs = new Map<string, Set<(snapshot: unknown) => void>>();
	const eventSubs = new Map<string, Set<(payload: unknown) => void>>();

	// ── Op lane state ─────────────────────────────────────────────────────────
	/** Outstanding calls this channel minted (frame side). */
	const prefix = callerPrefix();
	let seq = 0;
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	/** Served ops (controller side). */
	const opHandlers = new Map<string, (params: unknown) => unknown>();

	/** Runs a served op; replies iff the invocation carried a correlation id. */
	const runOp = async (op: string, args: unknown, replyId: string | null): Promise<void> => {
		const handler = opHandlers.get(op);
		if (!handler) {
			if (replyId !== null) peer.post({ [ENVELOPE]: 'reply', id: replyId, ok: false, error: `No handler serves '${op}' in this controller.` } satisfies IToolReplyMessage);
			return;
		}
		try {
			const result = await handler(args);
			if (replyId !== null) peer.post({ [ENVELOPE]: 'reply', id: replyId, ok: true, result } satisfies IToolReplyMessage);
		} catch (error) {
			if (replyId !== null) peer.post({ [ENVELOPE]: 'reply', id: replyId, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies IToolReplyMessage);
			// Event-invoked (fire-and-forget): the failure has no addressee;
			// surfacing belongs to the handler (publish an error topic).
		}
	};

	peer.subscribe((message) => {
		const state = asToolStateMessage(message);
		if (state) {
			lastState.set(state.topic, state.snapshot);
			stateSubs.get(state.topic)?.forEach((cb) => cb(state.snapshot));
			return;
		}
		const event = asToolEventMessage(message);
		if (event) {
			eventSubs.get(event.name)?.forEach((cb) => cb(event.payload));
			// The op registry answers plain events too — opt-in correlation
			// means the uncorrelated path still executes, it just never replies.
			if (opHandlers.has(event.name)) void runOp(event.name, event.payload, null);
			return;
		}
		const call = asToolCallMessage(message);
		if (call) {
			// Only a channel that SERVES ops answers calls (including the
			// helpful "no handler" reply for an unserved name). A channel with
			// no registry stays silent — on a shared loopback pipe the caller's
			// own channel sees its own call, and answering it would race the
			// controller's real reply.
			if (opHandlers.size > 0) void runOp(call.op, call.args, call.id);
			return;
		}
		const reply = asToolReplyMessage(message);
		if (reply) {
			// Not ours / caller gave up (timeout) / duplicate: drop silently.
			const entry = pending.get(reply.id);
			if (!entry) return;
			pending.delete(reply.id);
			clearTimeout(entry.timer);
			if (reply.ok) entry.resolve(reply.result);
			else entry.reject(new Error(reply.error ?? `'${reply.id}' failed in the controller`));
		}
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
		call(op, args, opts) {
			const timeoutMs = opts?.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
			const id = `${prefix}:${++seq}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					// Honest timeout: not answering is NOT not happening.
					reject(new Error(`'${op}' did not answer within ${Math.round(timeoutMs / 1000)}s; the controller may still be executing it.`));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				peer.post({ [ENVELOPE]: 'call', id, op, args } satisfies IToolCallMessage);
			});
		},
		serveOp(op, handler) {
			opHandlers.set(op, handler);
			return () => {
				if (opHandlers.get(op) === handler) opHandlers.delete(op);
			};
		},
	};
}
