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
// EXPLORER DEV TOOL — CONTROLLER WIRING (the sidebar mount's op server, R6)
// =============================================================================
//
// The host builds the controller mount's channel (DevToolProps.channel) and
// that channel is the ONLY subscriber of the sidebar peer: its op registry
// (`serveOp`) answers calls on the same subscription that carries state and
// events. So wiring a controller is just:
//
//   1. one op server over that channel, serving every handler through the
//      deadline guard, each answering a Reply;
//   2. publishing readiness once every handler is served.
//
// Nothing here subscribes a peer, builds a channel, or posts anything but
// retained state at mount (a quiet sidebar, R7). The React shell calls
// `attachController` inside a `useEffect` and returns `dispose` as the
// cleanup; under StrictMode that is mount -> dispose -> mount, which leaves one
// live op server (a handler registered later replaces the earlier one, and a
// disposed server only removes handlers that are still its own).
//
// READINESS. Once every handler is served, the controller publishes
// `{ ready: <nonce> }` on the reserved state topic CONTROLLER_STATE_TOPIC
// (`devtool:controller`), and `{ ready: null }` when it unmounts (a later mount
// that superseded it is left alone). Frames hold their calls until they see a
// nonce (frame.ts). This is not optional: the host builds the channel during
// RENDER, before this effect runs, and a call the sidebar peer held for the
// unmounted controller is flushed into that channel at construction, where
// there is no handler yet, and dropped without an answer (platform behavior,
// pinned by a test against the real toolChannel).
//
// EVERY OP ANSWERS A REPLY (R3, applied uniformly). The op map must declare a
// `Reply<T>` result and an IDeadline in the params of every op (void ops:
// `Reply<null>`), and each handler is wrapped so that:
//
//   - a returned Reply passes through (an undefined value becomes null);
//   - a plain returned value becomes `replyOk(value)` (undefined: null);
//   - a tool failure that ESCAPES the handler (an ExplorerToolError, a timeout,
//     "Not connected to server", …) becomes Reply data with kind and code
//     intact (reply.ts toReplyError). A lane cannot lose them by forgetting
//     `toReply`;
//   - a programming error (TypeError, ReferenceError, RangeError,
//     SyntaxError) is still thrown, and reaches the frame as a plain Error.
//
// PLAIN EVENTS THAT SHARE AN OP'S NAME RUN ITS HANDLER. The channel's registry
// answers events as well as calls (toolChannel.ts: opt-in correlation: a call
// gets a reply, an event runs the handler with none). The deadline guard
// refuses an event that carries no `deadlineAt`, but it cannot tell a frame's
// call from a frame's event that carries one. So: never name an event like an
// op (`assertNoOpEventCollisions` checks it), and a MUTATING handler enforces
// its own authority (identity, endpoint, permission) and never relies on event
// filtering.
// =============================================================================

import type { IToolOpServer, ToolChannel, ToolOpMap, ToolOpParams, ToolOpResult, ToolOpSpec } from 'shell';
import { DeadlineError, guardDeadline } from './deadline';
import type { IDeadline } from './deadline';
import { frameOpTimeoutMs, toolCallBudgetMs } from './timeouts';
import { CONTROLLER_STATE_TOPIC, mountNonce } from './realm';
import type { IControllerState } from './realm';
import { asReply, toReplyError } from './reply';
import type { Reply, ReplyValue } from './reply';

/** True for `any` (the only type `1 & T` widens to accept `0` for). */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * The shape every controller op map has: each op takes a deadline and answers
 * a Reply. `attachController<O>` requires `O` to satisfy it, so a lane cannot
 * declare a plain result (or forget the deadline) without a compile error.
 * An op whose params or result is `any`, or whose result is `never`, maps to
 * `never` and is refused too (an op that never answers is `Reply<never>`).
 */
export type DevToolOps<O> = {
	[K in keyof O]: O[K] extends ToolOpSpec<infer P, infer R>
		? IsAny<P> extends true ? never : IsAny<R> extends true ? never : [R] extends [never] ? never : ToolOpSpec<IDeadline, Reply<unknown>>
		: never;
};

/**
 * What a handler may produce for an op answering `R` (a Reply): the Reply
 * itself (from `toReply`/`replyOk`), its plain value, or nothing at all for a
 * void op (`Reply<null>`).
 *
 * TWO SHAPES ARE RESERVED. A returned object whose keys are exactly `ok` and
 * `value`, or `ok` (false) and a well-formed `error`, is taken for a Reply
 * (reply.ts asReply). To answer a domain value that happens to have one of
 * those shapes, return `replyOk(value)` explicitly.
 */
export type HandlerResult<R> = R | ReplyValue<R> | (null extends ReplyValue<R> ? void : never);

/** One handler of a controller op map. */
export type ControllerHandler<O extends ToolOpMap, K extends keyof O & string> =
	(params: ToolOpParams<O, K>) => HandlerResult<ToolOpResult<O, K>> | Promise<HandlerResult<ToolOpResult<O, K>>>;

/** The handlers a controller serves, by op wire name (each optional; see {@link RequiredControllerHandlers}). */
export type ControllerHandlers<O extends ToolOpMap> = {
	[K in keyof O & string]?: ControllerHandler<O, K>;
};

/**
 * Every op of the map, handled: annotate production wiring with it
 * (`const handlers: RequiredControllerHandlers<SqlOps> = { … }`) so a missing
 * or misspelt op is a compile error rather than a "No handler serves" at
 * runtime. Assignable to {@link ControllerHandlers}.
 */
export type RequiredControllerHandlers<O extends ToolOpMap> = {
	[K in keyof O & string]-?: ControllerHandler<O, K>;
};

/** What {@link attachController} wires. */
export interface IAttachControllerOptions<O extends ToolOpMap> {
	/** The host's channel for this mount (DevToolProps.channel). */
	channel: ToolChannel;
	/** The shell's `createToolOpServer` (injected: no value import from 'shell'). */
	createToolOpServer: (channel: ToolChannel) => IToolOpServer<O>;
	/** The op handlers; each is served through the deadline guard and answers a Reply. */
	handlers: ControllerHandlers<O>;
	/** The clock the deadline guard reads (default `Date.now`). */
	now?: () => number;
	/** Told once, about the first call the guard accepts. */
	onFirstOp?: (op: string) => void;
	/** Told about every call the guard refused (it did not run). */
	onRefused?: (error: DeadlineError) => void;
	/**
	 * The furthest ahead a call's `deadlineAt` may be, per op, in ms: the op's
	 * largest legal budget (default for an op not listed: {@link MAX_OP_BUDGET_MS}).
	 */
	maxBudgetMs?: Partial<Record<keyof O & string, number>>;
	/**
	 * Every channel EVENT name the lane sends or listens for. Checked against
	 * the served ops at attach: a name in both throws (the channel would run an
	 * op's handler for that event).
	 */
	events?: readonly string[];
}

/** The largest budget any op's frame may have: an unbounded tool call (24 h) plus the margins. */
export const MAX_OP_BUDGET_MS = frameOpTimeoutMs(toolCallBudgetMs(null));

/** A mounted controller. */
export interface IAttachedController {
	/** The channel the controller publishes state on and hears frame events from. */
	readonly channel: ToolChannel;
	/** Dispose the op server (idempotent). The channel stays: it cannot be disposed. */
	dispose(): void;
}

/** The live attachment per channel (the readiness topic has one owner). */
const live = new WeakMap<ToolChannel, IAttachedController>();

/**
 * Check that no event name a lane sends or listens for is also an op it serves
 * (the channel runs a handler for an event named like its op).
 *
 * @param ops - The served op names.
 * @param events - The event names.
 * @returns The names in both (empty when the lane is clean).
 */
export function assertNoOpEventCollisions(ops: readonly string[], events: readonly string[]): string[] {
	const served = new Set(ops);
	return events.filter((name) => served.has(name));
}

/**
 * Wrap a handler so that it always answers a Reply (see the header).
 *
 * @param handler - The lane's handler.
 * @returns The Reply-answering handler.
 */
function answering(handler: (params: unknown) => unknown): (params: unknown) => Promise<Reply<unknown>> {
	return async (params) => {
		try {
			return asReply(await handler(params));
		} catch (error) {
			return { ok: false, error: toReplyError(error) };
		}
	};
}

/**
 * Wire a controller mount: the channel first, then ONE op server serving
 * every handler through the deadline guard, each answering a Reply.
 *
 * @param opts - See {@link IAttachControllerOptions}.
 * @returns The channel and `dispose` (the effect's cleanup).
 */
export function attachController<O extends ToolOpMap & DevToolOps<O>>(opts: IAttachControllerOptions<O>): IAttachedController {
	const { channel } = opts;

	const served = Object.keys(opts.handlers) as Array<keyof O & string>;
	const collisions = assertNoOpEventCollisions(served, opts.events ?? []);
	if (collisions.length > 0) {
		throw new RangeError(`Event names that are also served ops: ${collisions.join(', ')}. The channel would run the op's handler for such an event; rename the event.`);
	}

	// A mount that was never cleaned up must not keep a second op server: the
	// registry holds one handler per op, and the new server replaces it.
	live.get(channel)?.dispose();

	const server = opts.createToolOpServer(channel);

	let first = true;
	const onAccepted = (op: string): void => {
		if (!first) return;
		first = false;
		opts.onFirstOp?.(op);
	};
	// The channel runs `onEvent` listeners synchronously BEFORE it runs the op's
	// handler for a plain event of the same name, with the same payload object
	// (toolChannel.ts). So a listener per served op can mark every event payload,
	// and a handler invocation whose params ARE such a payload is refused: only
	// a correlated call (which the channel never shows to onEvent) runs.
	const eventPayloads = new WeakSet<object>();
	const offs: Array<() => void> = [];
	for (const op of served) {
		const handler = opts.handlers[op] as ((params: unknown) => unknown) | undefined;
		if (handler === undefined) continue;
		offs.push(channel.onEvent(op, (payload) => {
			if (payload !== null && typeof payload === 'object') eventPayloads.add(payload);
		}));
		const guarded = guardDeadline(op, answering(handler), { now: opts.now, onAccepted, onRefused: opts.onRefused, maxAheadMs: opts.maxBudgetMs?.[op] ?? MAX_OP_BUDGET_MS });
		const callsOnly = async (params: unknown): Promise<Reply<unknown>> => {
			if (params !== null && typeof params === 'object' && eventPayloads.has(params)) {
				const refusal = new DeadlineError(op, 'event');
				opts.onRefused?.(refusal);
				throw refusal;
			}
			return guarded(params);
		};
		server.serve(op, callsOnly as unknown as Parameters<IToolOpServer<O>['serve']>[1]);
	}

	let disposed = false;
	const attachment: IAttachedController = {
		channel,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			server.dispose();
			if (live.get(channel) !== attachment) return;
			live.delete(channel);
			channel.publishState(CONTROLLER_STATE_TOPIC, { ready: null } satisfies IControllerState);
		},
	};
	live.set(channel, attachment);
	// Every handler is served: frames may send now.
	channel.publishState(CONTROLLER_STATE_TOPIC, { ready: mountNonce() } satisfies IControllerState);
	return attachment;
}
