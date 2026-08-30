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
// CONNECTION ERRORS — typed failures surfaced by connection backends
// =============================================================================

/**
 * Message for a rejected credential. Shared so the two `userId` gates
 * (transport connect and the shell's own result check) can never drift apart.
 */
export const AUTH_REJECTED_MESSAGE = 'Authentication failed: unknown user or invalid credentials.';

/** A connection failure whose kind determines the UI recovery action. */
export class ConnectionFailure extends Error {
	constructor(
		message: string,
		public readonly kind: 'auth' | 'network' | 'server'
	) {
		super(message);
		this.name = 'ConnectionFailure';
	}
}

/**
 * Bound an operation and cancel its client-side state before reporting timeout.
 * Late completion is deliberately ignored after timeout so it cannot revive a
 * login that the caller has already treated as failed.
 *
 * @param operation - The promise to bound.
 * @param timeoutMs - Milliseconds to wait before treating the operation as failed.
 * @param timeoutError - The error surfaced to the caller once the timeout fires.
 * @param cleanup - Awaited before rejection so client-side state is cancelled first.
 * @returns The operation's value when it settles before the timeout.
 */
export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutError: Error, cleanup: () => Promise<unknown>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		// One-shot latches: whichever of settlement / timeout fires first wins.
		let settled = false;
		let timedOut = false;

		// Timeout path: run cleanup to completion, THEN reject with the
		// caller-supplied error. The operation's late settlement is ignored.
		const timeout = setTimeout(async () => {
			if (settled || timedOut) return;
			timedOut = true;
			clearTimeout(timeout);
			try {
				await cleanup();
			} catch {
				// The timeout error remains the recovery signal even if cleanup fails.
			}
			reject(timeoutError);
		}, timeoutMs);

		/** Cancel the pending timeout once the operation settles first. */
		const clearTimer = () => {
			clearTimeout(timeout);
		};

		// Settlement path: propagate the result only if the timeout hasn't won.
		operation.then(
			(value) => {
				if (settled || timedOut) return;
				settled = true;
				clearTimer();
				resolve(value);
			},
			(error) => {
				if (settled || timedOut) return;
				settled = true;
				clearTimer();
				reject(error);
			}
		);
	});
}
