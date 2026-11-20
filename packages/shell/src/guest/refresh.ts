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
// GUEST FRAME REFRESH — one `shell.frameToken.refresh` before expiry (PR2b, plan §3.4)
// =============================================================================
//
// The guest asks the root once, 120 s before `expiresAt`. The root already
// retries (2, 4, 8 s) and maps a final failure to the session-ended tile, so
// the guest never retries: a failure is reported and the cycle stops. A reply
// re-arms the timer from its own `expiresAt`.
// =============================================================================

/** How long before expiry the refresh is asked for, ms. */
export const REFRESH_LEAD_MS = 120_000;

export interface IFrameRefreshDeps<T> {
	expiresAt: number;
	now(): number;
	request(): Promise<{ entryPrefix: string; expiresAt: number }>;
	setTimer(cb: () => void, ms: number): T;
	clearTimer(timer: T): void;
	apply(entryPrefix: string): void;
	failed(err: unknown): void;
}

/** Starts the refresh cycle; `stop()` cancels the pending timer. */
export function startFrameRefresh<T>(deps: IFrameRefreshDeps<T>): { stop(): void } {
	let timer: T | null = null;
	let stopped = false;
	const arm = (expiresAt: number): void => {
		if (stopped) return;
		const delay = Math.max(0, expiresAt - REFRESH_LEAD_MS - deps.now());
		timer = deps.setTimer(() => {
			timer = null;
			deps.request().then(
				(reply) => {
					if (stopped) return;
					deps.apply(reply.entryPrefix);
					arm(reply.expiresAt);
				},
				(err) => {
					if (!stopped) deps.failed(err);
				}
			);
		}, delay);
	};
	arm(deps.expiresAt);
	return {
		stop() {
			stopped = true;
			if (timer !== null) deps.clearTimer(timer);
			timer = null;
		},
	};
}
