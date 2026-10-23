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
// EXPLORER DEV TOOL — DEADLINES (a call the frame gave up on never runs, R2)
// =============================================================================
//
// The op lane has no cancellation, and the sidebar peer HOLDS frame calls
// while no controller is subscribed (busPeer.ts holdToSidebar), delivering
// them to the next subscriber. A frame that already reported "did not answer"
// could otherwise have its write executed minutes later.
//
// So every op carries `deadlineAt` (epoch ms: the frame's now + the call's
// timeoutMs), and the controller serves every handler through
// {@link guardDeadline}: a call delivered after its deadline is refused
// without running. A missing deadline is a protocol error, which also stops
// the op server from executing a plain channel EVENT that happens to share an
// op's name (toolOps.ts runs those through the same registry).
//
// Both ends read the wall clock of the same machine (VS Code webviews, the
// rocket-ui page), so the comparison needs no clock sync.
// =============================================================================

import { assertTimeoutMs } from './timeouts';

/** The field every op's params carry. */
export interface IDeadline {
	/** Epoch ms after which the controller must not execute the call. */
	deadlineAt: number;
}

/** Why a call was refused. */
export type DeadlineRefusal = 'missing' | 'expired';

/** A call the deadline guard refused (it was NOT executed). */
export class DeadlineError extends Error {
	/** Why. */
	readonly reason: DeadlineRefusal;

	/** The op's wire name. */
	readonly op: string;

	/** How late the call arrived, in ms (expired calls only). */
	readonly lateMs?: number;

	/**
	 * @param op - The op's wire name.
	 * @param reason - Why the call was refused.
	 * @param lateMs - How late it arrived (expired calls only).
	 */
	constructor(op: string, reason: DeadlineRefusal, lateMs?: number) {
		super(reason === 'missing'
			? `'${op}' carries no deadlineAt; refused without running it (protocol error).`
			: `'${op}' arrived ${lateMs ?? 0} ms after its deadline; the caller had given up, so it was not run.`);
		this.name = 'DeadlineError';
		this.reason = reason;
		this.op = op;
		if (lateMs !== undefined) this.lateMs = lateMs;
		Object.setPrototypeOf(this, DeadlineError.prototype);
	}
}

/** The expired-refusal text (see {@link DeadlineError}): `'<op>' arrived <n> ms after its deadline; …`. */
const EXPIRED_TEXT = /^'[^']*' arrived \d+ ms after its deadline;/;

/**
 * Whether a message is the controller's refusal of an expired call. It
 * crosses the op lane as text only; a frame still waiting for that call
 * (timers throttled in a hidden webview) treats it as a timeout.
 *
 * @param message - The message.
 * @returns True for an expired-call refusal.
 */
export function isDeadlineExpiredText(message: string): boolean {
	return EXPIRED_TEXT.test(message);
}

/**
 * Stamp a call's deadline onto a copy of its params.
 *
 * @param params - The op params (undefined: none).
 * @param timeoutMs - The call's timeout (required, see timeouts.ts).
 * @param now - The clock (default `Date.now`).
 * @returns The params plus `deadlineAt = now() + timeoutMs`.
 * @throws RangeError when the timeout is not a usable delay.
 */
export function stampDeadline<P extends object>(params: P | undefined, timeoutMs: number, now: () => number = Date.now): P & IDeadline {
	const wait = assertTimeoutMs(timeoutMs, 'timeoutMs');
	return { ...(params ?? {}), deadlineAt: now() + wait } as P & IDeadline;
}

/**
 * Read the deadline off received params.
 *
 * @param params - Whatever arrived.
 * @returns The deadline, or null when there is no finite one.
 */
export function readDeadline(params: unknown): number | null {
	if (params === null || typeof params !== 'object') return null;
	const value = (params as { deadlineAt?: unknown }).deadlineAt;
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** What {@link guardDeadline} reports. */
export interface IDeadlineGuardOptions {
	/** The clock (default `Date.now`). */
	now?: () => number;
	/** Told about every refused call (for logging; the call did not run). */
	onRefused?: (error: DeadlineError) => void;
	/** Told about every accepted call, just before its handler runs. */
	onAccepted?: (op: string) => void;
}

/**
 * Wrap an op handler so a call without a deadline, or delivered after it,
 * never runs. The params reach the handler unchanged (deadline included, so
 * a handler may bound its own work by it).
 *
 * @param op - The op's wire name.
 * @param handler - The handler.
 * @param opts - Clock and reporting.
 * @returns The guarded handler; it rejects with a {@link DeadlineError} when it refuses.
 */
export function guardDeadline<P, R>(op: string, handler: (params: P) => R | Promise<R>, opts: IDeadlineGuardOptions = {}): (params: P) => Promise<R> {
	const now = opts.now ?? Date.now;
	return async (params: P): Promise<R> => {
		const deadlineAt = readDeadline(params);
		let refusal: DeadlineError | null = null;
		if (deadlineAt === null) refusal = new DeadlineError(op, 'missing');
		else {
			const late = now() - deadlineAt;
			if (late > 0) refusal = new DeadlineError(op, 'expired', late);
		}
		if (refusal !== null) {
			opts.onRefused?.(refusal);
			throw refusal;
		}
		opts.onAccepted?.(op);
		return handler(params);
	};
}
