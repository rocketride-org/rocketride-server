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
// TOOL OPS — the TYPED surface over the tool channel's op lane
// =============================================================================
//
// The one request/response mechanism between a tool's document frames and
// its CONTROLLER (sidebar realm). The LANE itself — correlation, timeouts,
// reply-iff-tracked dispatch, the `__rrtool` call/reply wire kinds — lives
// in the channel (toolChannel.ts `call`/`serveOp`); this module is the typed
// view tools code against. A tool declares its op vocabulary ONCE as an
// interface extending {@link ToolOpMap} — the protocol-map pattern the shell
// event bus uses (ShellEventMap), applied per tool:
//
//   // In the tool's ops/types.ts — private to the tool, strict end to end:
//   interface SqlOps extends ToolOpMap {
//       'sql.resolveEndpoint': ToolOpSpec<{ connId: string }, SqlEndpoint>;
//   }
//
//   // In a frame (ops/client.ts):
//   const call = createToolOpClient<SqlOps>(channel);
//   const endpoint = await call('sql.resolveEndpoint', { connId });
//
//   // In the controller (ops/server.ts), beside its state publishing:
//   const server = createToolOpServer<SqlOps>(channel);
//   server.serve('sql.resolveEndpoint', async ({ connId }) => resolve(connId));
//
// OPT-IN BY CONSTRUCTION: a reply exists if and only if the request carried
// a correlation id — which only the channel's `call` stamps. The SAME
// handler registry also answers plain channel EVENTS whose name matches a
// served op: the handler runs, no reply is produced, nothing dangles.
// Handlers are plain async functions — no knowledge of correlation or
// transport — so controller code stays directly testable.
//
// HOST RELAY RULES (enforced by the bus peers, busPeer.ts): replies are
// delivered to LIVE subscribers only — never retained, never buffered,
// never summoning a window (a reply to a closed caller is dropped); calls
// are never written to a retention slot (a reloaded sidebar must not
// re-execute them).
//
// Timeouts are honest: 'did not answer' is NOT 'did not happen' — the
// controller may still be executing. No automatic retries, ever; op
// authors prefer idempotent shapes for writes.
// =============================================================================

import type { IToolCallOptions, ToolChannel } from './toolChannel';

// The wire types and guards moved into the channel module with the lane;
// re-exported here so host relays keep their one import site.
export { DEFAULT_OP_TIMEOUT_MS, asToolCallMessage, asToolReplyMessage } from './toolChannel';
export type { IToolCallMessage, IToolReplyMessage, IToolCallOptions } from './toolChannel';

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

/**
 * The calling function a frame holds: ask this tool's controller to execute
 * an operation and await the result. Keys and both payload types come from
 * the tool's op map.
 */
export type ToolControllerFn<O extends ToolOpMap = ToolOpMap> =
	<K extends keyof O & string>(op: K, params: ToolOpParams<O, K>, opts?: IToolCallOptions) => Promise<ToolOpResult<O, K>>;

/**
 * The frame's typed controller function over its mount's channel.
 *
 * @param channel - The mount's channel (DevToolProps.channel).
 * @returns The calling function, typed by the tool's op map.
 */
export function createToolOpClient<O extends ToolOpMap = ToolOpMap>(channel: ToolChannel): ToolControllerFn<O> {
	return ((op: string, params?: unknown, opts?: IToolCallOptions) => channel.call(op, params, opts)) as ToolControllerFn<O>;
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
	/** Unregisters everything this server registered. */
	dispose(): void;
}

/**
 * The controller's typed op server over its mount's channel. One per
 * controller mount, created beside its state publishing.
 *
 * @param channel - The controller mount's channel (DevToolProps.channel).
 * @returns The registry, typed by the tool's op map.
 */
export function createToolOpServer<O extends ToolOpMap = ToolOpMap>(channel: ToolChannel): IToolOpServer<O> {
	const offs = new Set<() => void>();
	return {
		serve(op, handler) {
			const off = channel.serveOp(op, handler as (params: unknown) => unknown);
			offs.add(off);
			return () => {
				offs.delete(off);
				off();
			};
		},
		dispose() {
			for (const off of offs) off();
			offs.clear();
		},
	};
}
