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
// TOOL OPS — the correlated operation lane between a tool's two mounts
// =============================================================================
//
// The one request/response mechanism between a tool's document frames and
// its CONTROLLER (sidebar realm). A tool declares its op vocabulary ONCE as
// an interface extending {@link ToolOpMap} — the protocol-map pattern the
// shell event bus uses (ShellEventMap), applied per tool:
//
//   // In the tool's ops.ts — private to the tool, strict-typed end to end:
//   interface SqlOps extends ToolOpMap {
//       'sql.execute': ToolOpSpec<{ connId: string; sql: string }, ISqlExecuteResult>;
//   }
//
//   // In a frame:
//   const call = createToolController<SqlOps>(peer);
//   const result = await call('sql.execute', { connId, sql });
//
//   // In the controller, beside its state publishing:
//   const server = createToolOpServer<SqlOps>(peer);
//   server.serve('sql.execute', async ({ connId, sql }) => session.execute(sql));
//
// OPT-IN BY CONSTRUCTION: a reply exists if and only if the request carried
// a correlation id — which only the controller function stamps. The SAME
// handler registry also answers plain channel EVENTS whose name matches a
// served op: the handler runs, no reply is produced, nothing dangles.
// Handlers are plain async functions — no knowledge of correlation or
// transport — so controller code stays directly testable.
//
// Wire: two reserved kinds on the tool-channel envelope (`__rrtool`),
// coexisting with 'state'/'event' (toolChannel.ts). HOST RELAY RULES
// (enforced in the VS Code DevToolBridge and rocket-ui's peer): replies are
// delivered to LIVE subscribers only — never retained, never buffered,
// never summoning a window (a reply to a closed caller is dropped); calls
// are never written to a retention slot (a reloaded sidebar must not
// re-execute them).
//
// Timeouts are honest: 'did not answer' is NOT 'did not happen' — the
// controller may still be executing. No automatic retries, ever; op
// authors prefer idempotent shapes for writes.
// =============================================================================

import type { DevToolProps } from './types';
import { asToolEventMessage } from './toolChannel';

/** The envelope key (shared with the tool channel's state/event kinds). */
const ENVELOPE = '__rrtool';

/** Default per-call timeout — generous because engine-side statements can
 *  legitimately run long; override per call. */
export const DEFAULT_OP_TIMEOUT_MS = 120_000;

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
 * Narrows a peer payload to a CALL — for the server and the host relays
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
 * Narrows a peer payload to a REPLY — for the client and the host relays
 * (which deliver replies to live subscribers only).
 *
 * @param message - Any peer payload.
 * @returns The reply message, or null.
 */
export function asToolReplyMessage(message: unknown): IToolReplyMessage | null {
	const m = message as IToolReplyMessage | null;
	return m && typeof m === 'object' && m[ENVELOPE] === 'reply' && typeof m.id === 'string' && typeof m.ok === 'boolean' ? m : null;
}

// =============================================================================
// TYPED OP MAPS
// =============================================================================

/** One operation's compile-time shape: params in, result out. */
export interface ToolOpSpec<P, R> {
	/** Phantom carriers — never read at runtime. */
	readonly params: P;
	readonly result: R;
}

/**
 * The base op map every tool's op vocabulary extends. Deliberately empty —
 * ops are tool-private by nature (unlike state topics, where the host owns
 * a base set). A tool declares, in its own module:
 *
 *   interface MyOps extends ToolOpMap {
 *       'myTool.verb': ToolOpSpec<{ id: string }, MyResult>;
 *   }
 *
 * Op names are `<tool>.<verb>` by convention; the interface key is the wire
 * name, so a typo'd string or drifted payload shape fails to compile.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface ToolOpMap {}

/** The params type of one op in a map. */
export type ToolOpParams<O, K extends keyof O> = O[K] extends ToolOpSpec<infer P, unknown> ? P : never;

/** The result type of one op in a map. */
export type ToolOpResult<O, K extends keyof O> = O[K] extends ToolOpSpec<unknown, infer R> ? R : never;

// =============================================================================
// CLIENT — the frame's controller function
// =============================================================================

/** Per-call options. */
export interface IToolCallOptions {
	/** Overrides {@link DEFAULT_OP_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * The calling function a frame holds: ask this tool's controller to execute
 * an operation and await the result. Keys and both payload types come from
 * the tool's op map.
 */
export type ToolControllerFn<O extends ToolOpMap = ToolOpMap> =
	<K extends keyof O & string>(op: K, params: ToolOpParams<O, K>, opts?: IToolCallOptions) => Promise<ToolOpResult<O, K>>;

/** Collision-safe id prefix per client (replies broadcast to every frame of
 *  the tool; each client claims only ids it minted). */
function clientPrefix(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

/**
 * Builds the frame's controller function over a mount's peer pipe. One
 * client per mount lifetime (it holds a standing peer subscription).
 *
 * @param peer - The mount's peer pipe (DevToolProps.peer).
 * @returns The calling function, typed by the tool's op map.
 */
export function createToolController<O extends ToolOpMap = ToolOpMap>(peer: DevToolProps['peer']): ToolControllerFn<O> {
	const prefix = clientPrefix();
	let seq = 0;
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	peer.subscribe((message) => {
		const reply = asToolReplyMessage(message);
		if (!reply) return;
		// Not ours / caller gave up (timeout) / duplicate: drop silently —
		// "ignored based on what the original caller did", by construction.
		const entry = pending.get(reply.id);
		if (!entry) return;
		pending.delete(reply.id);
		clearTimeout(entry.timer);
		if (reply.ok) entry.resolve(reply.result);
		else entry.reject(new Error(reply.error ?? `'${reply.id}' failed in the controller`));
	});

	const call = (op: string, args?: unknown, opts?: IToolCallOptions): Promise<unknown> => {
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
	};

	return call as ToolControllerFn<O>;
}

// =============================================================================
// SERVER — the controller side
// =============================================================================

/** The controller-side registry, typed by the tool's op map. */
export interface IToolOpServer<O extends ToolOpMap = ToolOpMap> {
	/**
	 * Serves one operation. Replaces any previous handler for the op.
	 *
	 * @param op - The op's wire name (a key of the tool's op map).
	 * @param handler - Plain async function; a thrown error becomes the
	 *                  caller's rejection (its message crosses the wire).
	 * @returns Unregister for this op.
	 */
	serve<K extends keyof O & string>(op: K, handler: (params: ToolOpParams<O, K>) => ToolOpResult<O, K> | Promise<ToolOpResult<O, K>>): () => void;
	/** Tears the whole registry down (unsubscribes from the peer). */
	dispose(): void;
}

/**
 * Builds the controller's op server over its peer pipe. One per controller
 * mount, created beside its state publishing.
 *
 * Reply-iff-tracked: a CALL gets a correlated reply; a plain channel EVENT
 * whose name matches a served op runs the same handler with NO reply.
 *
 * @param peer - The controller mount's peer pipe.
 * @returns The registry, typed by the tool's op map.
 */
export function createToolOpServer<O extends ToolOpMap = ToolOpMap>(peer: DevToolProps['peer']): IToolOpServer<O> {
	const handlers = new Map<string, (params: unknown) => unknown>();

	const run = async (op: string, args: unknown, replyId: string | null): Promise<void> => {
		const handler = handlers.get(op);
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

	const unsubscribe = peer.subscribe((message) => {
		const call = asToolCallMessage(message);
		if (call) {
			void run(call.op, call.args, call.id);
			return;
		}
		// The SAME registry answers plain events — opt-in correlation means
		// the uncorrelated path still executes, it just never replies.
		const event = asToolEventMessage(message);
		if (event && handlers.has(event.name)) void run(event.name, event.payload, null);
	});

	return {
		serve(op, handler) {
			handlers.set(op, handler as (params: unknown) => unknown);
			return () => {
				if (handlers.get(op) === (handler as (params: unknown) => unknown)) handlers.delete(op);
			};
		},
		dispose() {
			handlers.clear();
			unsubscribe();
		},
	};
}
