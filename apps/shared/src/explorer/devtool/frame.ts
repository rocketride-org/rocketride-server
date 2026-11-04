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
// EXPLORER DEV TOOL — FRAME CALLER (how a document frame calls its controller)
// =============================================================================
//
// Frames hold no client (R1): every engine-facing step is an op on the
// controller. This is the frame's runtime for those ops:
//
//   - The host's channel (DevToolProps.channel) is the frame's only transport.
//     A frame never builds a channel (one subscribes its peer for good and can
//     never be disposed): the typed op client is a thin closure over it, so a
//     StrictMode double mount adds nothing.
//   - Every call names an explicit `timeoutMs` (timeouts.ts) and is stamped
//     with `deadlineAt` (deadline.ts), which the controller enforces.
//   - The moment `host:connection` turns false, every pending call is
//     rejected: the caller stops waiting, and since nothing can be cancelled
//     the error says the call may still have run (kind `timeout`).
//   - FAIL FAST: a call made while `host:connection` is already false is
//     rejected at once, before anything is posted, as kind `unavailable`
//     (it was not sent, so it cannot have run). Before the host has published
//     the topic at all (`connected()` is null) calls pass through.
//   - The op lane's own timeout text, and the controller's refusal of a call
//     that arrived after its deadline, become an ExplorerToolError of kind
//     `timeout`; Reply ops are unwrapped by `callReply` (reply.ts), which
//     rebuilds the controller's ExplorerToolError. Anything else (an op no
//     controller serves, a missing deadline, a programming error in a
//     handler) is a protocol error and stays a plain Error.
//   - A missing or unusable `timeoutMs` is a programming error: `call` and
//     `callReply` THROW it synchronously (a RangeError), so it never reaches
//     a `.catch` on the returned promise.
//   - READINESS. A call is SENT only while the controller's readiness state
//     (`devtool:controller`, controller.ts) carries a nonce. Until then it
//     waits, inside its own timeout: the deadline stays the one stamped at
//     call time, and the op lane gets what is left of it. If readiness never
//     comes, the call rejects as kind `timeout`, unsent. This is what makes a
//     call made in the host's render -> controller-effect window (when the
//     host channel already holds the sidebar's live slot and would drop it)
//     succeed. A stale nonce left by a dead controller is bounded the same
//     way, by the deadline. `waitForController: false` sends at once (a
//     controller that publishes no readiness).
//   - IDENTITY FENCE (optional, `identityNow`). A call is not SENT while the
//     frame knows no identity: like the controller wait it holds inside the
//     call's own deadline (looking again every IDENTITY_POLL_MS) and, if the
//     deadline passes first, rejects as kind `unavailable`, unsent. Once sent it
//     is bound to the identity the frame is under then; if the frame is under
//     another identity, or none, when the answer arrives, the answer is
//     discarded and the call rejects as kind `stale` (callers ignore it), so
//     account A's answer never reaches a frame that has adopted B, and there is
//     no unknown -> A -> B gap. The identity is read at send and at answer.
//   - `dispose` (the effect cleanup) stops following host:connection and
//     rejects what is still pending as `stale`, which callers ignore.
// =============================================================================

import type { ToolChannel, ToolControllerFn, ToolOpMap, ToolOpParams, ToolOpResult } from 'shell';
import { ExplorerToolError, readErrorMessage } from '../errors';
import { isDeadlineExpiredText, stampDeadline } from './deadline';
import { CONTROLLER_STATE_TOPIC } from './realm';
import { fromReply, isLaneTimeoutText } from './reply';
import type { Reply, ReplyValue } from './reply';
import { assertTimeoutMs } from './timeouts';

/** How often a call waiting for the frame's identity looks again. */
const IDENTITY_POLL_MS = 25;

/** The host-published connection topic (the shell's HOST_CONNECTION_TOPIC, toolRelay.ts; a test pins the two). */
export const HOST_CONNECTION_TOPIC = 'host:connection';

/** The params a frame passes: the op's params without the deadline it stamps. */
export type FrameParams<O, K extends keyof O> = Omit<ToolOpParams<O, K>, 'deadlineAt'>;

/** Per-call options: the timeout is REQUIRED. */
export interface IFrameCallOptions {
	/** How long the frame waits (see timeouts.ts `frameOpTimeoutMs`). */
	timeoutMs: number;
}

/** What {@link createFrameCaller} needs. */
export interface IFrameCallerOptions {
	/** The host's channel for this mount (DevToolProps.channel). */
	channel: ToolChannel;
	/** The shell's `createToolOpClient` (injected: no value import from 'shell'). */
	createToolOpClient: <O extends ToolOpMap>(channel: ToolChannel) => ToolControllerFn<O>;
	/** The clock deadlines are stamped from (default `Date.now`). */
	now?: () => number;
	/** Hold calls until the controller publishes readiness (default true; see the header). */
	waitForController?: boolean;
	/**
	 * The identity fingerprint the frame is under now (frameIdentity.ts guard
	 * `first()`/current, or the tracker's). While it returns null a call is HELD
	 * (inside its own deadline; kind `unavailable`, unsent, if the deadline passes
	 * first). Once sent a call is bound to the identity it was sent under, and its
	 * answer, success or failure, is discarded as kind `stale` if the identity
	 * changed (to another, or to none) before it arrived.
	 */
	identityNow?: () => string | null;
}

/** A frame's way to call its controller. */
export interface IFrameCaller<O extends ToolOpMap> {
	/**
	 * Call an op and return its raw result (a Reply, for every op a controller
	 * wired with attachController serves).
	 *
	 * @throws RangeError (synchronously) when `timeoutMs` is missing or unusable.
	 */
	call<K extends keyof O & string>(op: K, params: FrameParams<O, K>, opts: IFrameCallOptions): Promise<ToolOpResult<O, K>>;
	/**
	 * Call a Reply op and return its value, or reject with the controller's ExplorerToolError.
	 *
	 * @throws RangeError (synchronously) when `timeoutMs` is missing or unusable.
	 */
	callReply<K extends keyof O & string>(op: K, params: FrameParams<O, K>, opts: IFrameCallOptions): Promise<ReplyValue<ToolOpResult<O, K>>>;
	/** Calls still waiting. */
	pending(): number;
	/** The last `host:connection` snapshot: true / false, or null before the host published one. */
	connected(): boolean | null;
	/** Whether the controller's readiness state currently carries a nonce. */
	controllerReady(): boolean;
	/** Stop following host:connection and reject what is pending as `stale` (idempotent). */
	dispose(): void;
}

/**
 * Build a frame's caller.
 *
 * @param opts - See {@link IFrameCallerOptions}.
 * @returns The caller; dispose it in the mount's cleanup.
 */
export function createFrameCaller<O extends ToolOpMap>(opts: IFrameCallerOptions): IFrameCaller<O> {
	const now = opts.now ?? Date.now;
	const { channel } = opts;
	const send = opts.createToolOpClient<ToolOpMap>(channel) as unknown as (op: string, params: unknown, options: { timeoutMs: number }) => Promise<unknown>;

	const waitForController = opts.waitForController ?? true;

	/** One pending call: its op, how to reject it, and whether it was sent yet. */
	interface IPending {
		op: string;
		reject: (error: unknown) => void;
		sent: boolean;
		/** Sends it (calls waiting for readiness). */
		go: (() => void) | null;
		/** Its readiness-wait bound. */
		timer: ReturnType<typeof setTimeout> | null;
		/** Its identity look-out, while the frame knows no identity. */
		poll: ReturnType<typeof setInterval> | null;
	}
	const pending = new Set<IPending>();
	let connected: boolean | null = null;
	let ready: string | null = null;
	let disposed = false;

	/**
	 * Forget a pending call.
	 *
	 * @param entry - The call.
	 * @returns Whether it was still pending.
	 */
	const settle = (entry: IPending): boolean => {
		if (entry.timer !== null) clearTimeout(entry.timer);
		if (entry.poll !== null) clearInterval(entry.poll);
		entry.timer = null;
		entry.poll = null;
		entry.go = null;
		return pending.delete(entry);
	};

	/**
	 * Reject every pending call.
	 *
	 * @param make - Builds the error for one call (sent or not).
	 */
	const rejectAll = (make: (op: string, sent: boolean) => ExplorerToolError): void => {
		for (const entry of [...pending]) {
			if (settle(entry)) entry.reject(make(entry.op, entry.sent));
		}
	};

	const offConnection = channel.onState(HOST_CONNECTION_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { connected?: unknown }).connected : undefined;
		if (typeof value !== 'boolean') return;
		connected = value;
		if (!value) {
			rejectAll((op, sent) => (sent
				? new ExplorerToolError({
					kind: 'timeout',
					tool: op,
					message: `Lost the connection while '${op}' was running. It may still have run; there is no way to cancel it from here.`,
				})
				: new ExplorerToolError({ kind: 'unavailable', tool: op, message: `Lost the connection before '${op}' was sent; it did not run.` })));
		}
	});

	const offReady = channel.onState(CONTROLLER_STATE_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { ready?: unknown }).ready : undefined;
		ready = typeof value === 'string' && value !== '' ? value : null;
		if (ready === null) return;
		for (const entry of [...pending]) {
			const go = entry.go;
			if (go !== null) go();
		}
	});

	/**
	 * What a failed call rejects with.
	 *
	 * @param op - The op.
	 * @param error - What the op lane rejected with.
	 * @returns An ExplorerToolError for the lane's timeout; anything else unchanged.
	 */
	const mapFailure = (op: string, error: unknown): unknown => {
		const message = readErrorMessage(error);
		return isLaneTimeoutText(message) || isDeadlineExpiredText(message) ? new ExplorerToolError({ kind: 'timeout', tool: op, message }) : error;
	};

	const stale = (op: string): ExplorerToolError => new ExplorerToolError({ kind: 'stale', tool: op, message: `'${op}' was dropped: its frame closed.` });

	const call = (op: string, params: unknown, options: IFrameCallOptions): Promise<unknown> => {
		const timeoutMs = assertTimeoutMs(options?.timeoutMs, `'${op}' timeoutMs`);
		if (disposed) return Promise.reject(stale(op));
		if (connected === false) {
			return Promise.reject(new ExplorerToolError({ kind: 'unavailable', tool: op, message: `Not connected to a server, so '${op}' was not sent.` }));
		}
		// Bound to the identity the frame is under WHEN THE CALL IS SENT, and a
		// call is not sent while `identityNow` says none is known (it waits, like
		// it waits for the controller, inside its own deadline): so there is no
		// unknown -> A -> B gap, and only A -> B or A -> null before the answer
		// arrives is a change.
		let issuedUnder: string | null = null;
		const changedSince = (): boolean => {
			if (opts.identityNow === undefined || issuedUnder === null) return false;
			return (opts.identityNow() ?? null) !== issuedUnder;
		};
		const identityKnown = (): boolean => opts.identityNow === undefined || (opts.identityNow() ?? null) !== null;
		const controllerOk = (): boolean => !waitForController || ready !== null;
		const staleIdentity = (): ExplorerToolError => new ExplorerToolError({
			kind: 'stale',
			tool: op,
			message: `'${op}' was answered after the identity changed; the answer was discarded.`,
		});
		const args = stampDeadline(params as object | undefined, timeoutMs, now);
		const { deadlineAt } = args;
		return new Promise<unknown>((resolve, reject) => {
			const entry: IPending = { op, reject, sent: false, go: null, timer: null, poll: null };
			pending.add(entry);
			const notSent = (): ExplorerToolError => (controllerOk()
				? new ExplorerToolError({
					kind: 'unavailable',
					tool: op,
					message: `'${op}' was not sent: no signed-in identity became known within ${Math.round(timeoutMs / 1000)}s.`,
				})
				: new ExplorerToolError({
					kind: 'timeout',
					tool: op,
					message: `'${op}' was not sent: the tool's controller did not become ready within ${Math.round(timeoutMs / 1000)}s.`,
				}));
			const go = (): void => {
				if (!pending.has(entry)) return;
				if (!controllerOk() || !identityKnown()) return; // still waiting: a nonce, the poll or the deadline decides
				if (entry.timer !== null) clearTimeout(entry.timer);
				if (entry.poll !== null) clearInterval(entry.poll);
				entry.timer = null;
				entry.poll = null;
				entry.go = null;
				// The wait comes out of the call's own budget.
				const left = Math.floor(deadlineAt - now());
				if (left < 1) {
					if (settle(entry)) reject(notSent());
					return;
				}
				issuedUnder = opts.identityNow?.() ?? null;
				entry.sent = true;
				send(op, args, { timeoutMs: left }).then(
					(value) => { if (settle(entry)) { if (changedSince()) reject(staleIdentity()); else resolve(value); } },
					(error: unknown) => { if (settle(entry)) reject(changedSince() ? staleIdentity() : mapFailure(op, error)); },
				);
			};
			if (controllerOk() && identityKnown()) {
				go();
				return;
			}
			entry.go = go;
			entry.timer = setTimeout(() => { if (settle(entry)) reject(notSent()); }, timeoutMs);
			// The identity has no event to wait on here, so it is looked at on a short interval.
			if (!identityKnown()) entry.poll = setInterval(go, IDENTITY_POLL_MS);
		});
	};

	return {
		call: (op, params, options) => call(op, params, options) as Promise<ToolOpResult<O, typeof op>>,
		callReply: (op, params, options) => call(op, params, options).then((reply) => fromReply(reply as Reply<unknown>, { tool: op })) as Promise<ReplyValue<ToolOpResult<O, typeof op>>>,
		pending: () => pending.size,
		connected: () => connected,
		controllerReady: () => ready !== null,
		dispose() {
			if (disposed) return;
			disposed = true;
			offConnection();
			offReady();
			rejectAll(stale);
		},
	};
}
