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
// The sidebar peer keeps ONE live subscriber: each `peer.subscribe` replaces
// the last, and calls reach only whoever subscribed last (busPeer.ts). Both
// the channel and the op server subscribe it, so the ORDER decides who gets
// the calls:
//
//   1. the channel first: the host's `DevToolProps.channel` when given, else
//      ONE channel per peer (realm.ts channelFor, never disposed);
//   2. exactly ONE op server last, created here and disposed by `dispose`.
//
// Frame events still reach the channel after the op server took the live
// slot: every subscriber also follows the retained last-payload lane. Nothing
// may subscribe the sidebar peer after the op server (a stray channel built
// in a render steals every call); a lane test pins that with testing.ts
// `assertSidebarSubscribers`.
//
// Nothing here calls `peer.subscribe` itself, and nothing but retained state
// is posted at mount (a quiet sidebar, R7). The React shell calls
// `attachController` inside a `useEffect` and returns `dispose` as the
// cleanup; under StrictMode that is mount -> dispose -> mount, which leaves
// one live op server.
//
// READINESS. Once every handler is served, the controller publishes
// `{ ready: <nonce> }` on the reserved state topic CONTROLLER_STATE_TOPIC
// (`devtool:controller`), and `{ ready: null }` when it unmounts (a later
// mount that superseded it is left alone). Frames hold their calls until they
// see a nonce (frame.ts), because a call that arrives BEFORE the op server
// subscribed is lost when anything else already holds the live slot: the
// hosts build the sidebar channel during RENDER (VS Code
// DevToolSidebarMount.tsx useMemo, rocket-ui DevToolMount.tsx), before this
// effect runs, and the channel ignores calls.
//
// EVERY OP ANSWERS A REPLY (R3, applied uniformly). The op map must declare
// a `Reply<T>` result and an IDeadline in the params of every op (void ops:
// `Reply<null>`), and each handler is wrapped so that:
//
//   - a returned Reply passes through (an undefined value becomes null);
//   - a plain returned value becomes `replyOk(value)` (undefined: null);
//   - a tool failure that ESCAPES the handler (an ExplorerToolError, a bus
//     timeout, "Not connected to server", …) becomes Reply data with kind and
//     code intact (reply.ts toReplyError). A lane cannot lose them by
//     forgetting `toReply`;
//   - a programming error (TypeError, ReferenceError, RangeError,
//     SyntaxError) is still thrown, and reaches the frame as a plain Error.
//
// The op server only ever sees CALLS. The shim it subscribes through drops
// every other envelope, so a channel event that happens to share an op's name
// can never run a handler, whatever its payload (busPeer quirk 7; the frame
// side of quirk 2 makes such an event arrive twice). The controller's channel
// keeps its own subscription and still hears every event.
//
// HELD CALLS. While NO subscriber at all is on the sidebar peer (not even a
// channel; e.g. after the op server unsubscribed and before the next mount,
// with a fallback channel that already lost the live slot), the peer holds
// frame calls (up to 64) and hands them over SYNCHRONOUSLY inside the next
// subscribe. A call sent while some other subscriber holds the slot is NOT
// held: it goes to that subscriber, which drops it; readiness above is what
// keeps frames from sending then.
// With Rod's op server that would be inside `createToolOpServer`, before any
// handler could be served, so they would all be answered "No handler serves".
// So the op server subscribes through the shim, which queues that synchronous
// burst and releases it once every handler is registered. Each released call
// then meets the deadline guard (deadline.ts): on time, it runs; its frame
// gave up, it does not.
//
// The fallback channel (no host channel; both real hosts pass one, see
// DevToolSidebarMount.tsx and DevToolMount.tsx, so this path is for tests and
// for hosts yet to come) subscribes FIRST, so on the very first mount the
// held burst would land in the channel, which ignores calls. Its subscription
// therefore captures the calls in that burst and hands them to the op server
// shim, ahead of anything else.
// =============================================================================

import type { IToolOpServer, ToolChannel, ToolOpMap, ToolOpParams, ToolOpResult, ToolOpSpec } from 'shell';
import { guardDeadline } from './deadline';
import type { DeadlineError, IDeadline } from './deadline';
import { channelFor, CONTROLLER_STATE_TOPIC, mountNonce } from './realm';
import type { DevToolPeer, IControllerState } from './realm';
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
	/** The sidebar mount's peer (DevToolProps.peer). */
	peer: DevToolPeer;
	/** The host's channel (DevToolProps.channel), when it gave one. */
	channel?: ToolChannel;
	/** The shell's `createToolChannel` (injected: no value import from 'shell'). */
	createToolChannel: (peer: DevToolPeer) => ToolChannel;
	/** The shell's `createToolOpServer`. */
	createToolOpServer: (peer: DevToolPeer) => IToolOpServer<O>;
	/** The op handlers; each is served through the deadline guard and answers a Reply. */
	handlers: ControllerHandlers<O>;
	/** The clock the deadline guard reads (default `Date.now`). */
	now?: () => number;
	/** Told once, about the first call the guard accepts (the activation gate's "first op from a frame"). */
	onFirstOp?: (op: string) => void;
	/** Told about every call the guard refused (it did not run). */
	onRefused?: (error: DeadlineError) => void;
}

/** A mounted controller. */
export interface IAttachedController {
	/** The channel the controller publishes state on and hears frame events from. */
	readonly channel: ToolChannel;
	/** Dispose the op server (idempotent). The channel stays: it cannot be disposed. */
	dispose(): void;
}

/** The live attachment per sidebar peer (exactly one op server per peer). */
const live = new WeakMap<DevToolPeer, IAttachedController>();

/** Calls the fallback channel's first subscription caught in the held burst, per peer. */
const caught = new WeakMap<DevToolPeer, unknown[]>();

/**
 * Whether a peer payload is an op CALL (the only envelope the op server must see).
 *
 * @param message - Any peer payload.
 * @returns True for `{ __rrtool: 'call', … }`.
 */
function isCall(message: unknown): boolean {
	return message !== null && typeof message === 'object' && (message as { __rrtool?: unknown }).__rrtool === 'call';
}

/**
 * Build the fallback channel so that the calls in the held burst its first
 * subscription receives are kept for the op server.
 *
 * @param peer - The sidebar peer.
 * @param createToolChannel - The shell's factory.
 * @returns The channel.
 */
function fallbackChannel(peer: DevToolPeer, createToolChannel: (peer: DevToolPeer) => ToolChannel): ToolChannel {
	return channelFor(peer, (real) => {
		let building = true;
		const held: unknown[] = [];
		const channel = createToolChannel({
			post: (message) => real.post(message),
			subscribe: (cb) => real.subscribe((message) => {
				if (building && isCall(message)) held.push(message);
				else cb(message);
			}),
		});
		building = false;
		if (held.length > 0) caught.set(peer, held);
		return channel;
	});
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
	const { peer } = opts;

	// 1. The channel, BEFORE the op server takes the live slot.
	const channel = opts.channel ?? fallbackChannel(peer, opts.createToolChannel);

	// A mount that was never cleaned up must not keep a second op server.
	live.get(peer)?.dispose();

	// 2. The op server, LAST, through a shim that passes CALLS only and holds
	//    the synchronous burst of held calls until every handler is served.
	let released = false;
	const early: unknown[] = caught.get(peer)?.splice(0) ?? [];
	caught.delete(peer);
	let deliver: ((message: unknown) => void) | null = null;
	const shim: DevToolPeer = {
		post: (message) => peer.post(message),
		subscribe: (cb) => {
			deliver = cb;
			return peer.subscribe((message) => {
				if (!isCall(message)) return;
				if (released) cb(message);
				else early.push(message);
			});
		},
	};
	const server = opts.createToolOpServer(shim);

	let first = true;
	const onAccepted = (op: string): void => {
		if (!first) return;
		first = false;
		opts.onFirstOp?.(op);
	};
	for (const op of Object.keys(opts.handlers) as Array<keyof O & string>) {
		const handler = opts.handlers[op] as ((params: unknown) => unknown) | undefined;
		if (handler === undefined) continue;
		const served = guardDeadline(op, answering(handler), { now: opts.now, onAccepted, onRefused: opts.onRefused });
		server.serve(op, served as unknown as Parameters<IToolOpServer<O>['serve']>[1]);
	}

	released = true;
	const flush = deliver as ((message: unknown) => void) | null;
	if (flush !== null) for (const message of early.splice(0)) flush(message);

	let disposed = false;
	const attachment: IAttachedController = {
		channel,
		dispose() {
			if (disposed) return;
			disposed = true;
			server.dispose();
			if (live.get(peer) !== attachment) return;
			live.delete(peer);
			channel.publishState(CONTROLLER_STATE_TOPIC, { ready: null } satisfies IControllerState);
		},
	};
	live.set(peer, attachment);
	// Every handler is served: frames may send now.
	channel.publishState(CONTROLLER_STATE_TOPIC, { ready: mountNonce() } satisfies IControllerState);
	return attachment;
}
