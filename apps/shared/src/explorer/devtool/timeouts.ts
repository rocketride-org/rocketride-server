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
// EXPLORER DEV TOOL — TIMEOUTS (one explicit wait per lane, R5)
// =============================================================================
//
// A dev-tool call crosses up to four timers, and each must outlive the one
// inside it, or the user hears "stopped waiting" from the wrong layer:
//
//   session wait W        the tool session's own timer (connect/session.ts);
//                         its ExplorerToolError is the honest answer
//   SDK timeout           W + SDK_TIMEOUT_SLACK_MS (the session sends it)
//   bus timeout           SDK timeout + BUS_TOOL_MARGIN_MS (busClient.ts asks
//                         `cm.request('client.tool', …, { timeoutMs })`)
//   frame timeout         controller timeout + FRAME_OP_MARGIN_MS (the frame's
//                         `call(…, { timeoutMs })`, frame.ts)
//
// Both platform lanes default to 120 s (DEFAULT_BUS_REQUEST_TIMEOUT_MS,
// DEFAULT_OP_TIMEOUT_MS) whatever the tool's own budget is, so nothing here
// ever relies on a default: every request names its wait.
//
// A wait is a setTimeout delay, and a delay above 2^31-1 ms fires AT ONCE. So
// "no client timeout" (the session's `timeoutMs: null`, where the app offers
// Stop waiting instead) is carried as a large finite cap, never as Infinity.
// =============================================================================

/** The largest delay setTimeout honours (2^31-1 ms, about 24.8 days); anything larger fires immediately. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * How much longer than the session the SDK is told to wait. MIRRORS the
 * private `SDK_TIMEOUT_SLACK_MS` in connect/session.ts (a test pins the two
 * together through a real session call).
 */
export const SDK_TIMEOUT_SLACK_MS = 1_000;

/**
 * Added to the SDK timeout of a `client.tool` request to get its bus timeout.
 * It covers the SDK's own slack in reporting its timeout plus the bus hops
 * (realm -> framework root -> SDK and back; in VS Code the root is the
 * extension host, whose event loop can lag under load), so the SDK's answer,
 * and before it the session's, always arrives before the bus gives up.
 */
export const BUS_TOOL_MARGIN_MS = 5_000;

/**
 * The bus timeout of a `client.tool` call the session deliberately left
 * unbounded (no SDK `timeout`). 24 hours: longer than any statement a person
 * waits on in an open editor, short enough that a lost answer eventually frees
 * the bus's pending entry, and far below {@link MAX_TIMER_MS} even with every
 * margin added.
 */
export const UNBOUNDED_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Bus timeout of `client.getTasks` (discovery's one list call). Equal to the
 * endpoint store's default discovery bound (connect/store.ts
 * `discoveryTimeoutMs`), so a wedged root is reported by whichever fires
 * first, never by the 120 s default.
 */
export const GET_TASKS_TIMEOUT_MS = 30_000;

/**
 * Bus timeout of `client.listTasks` (discovery's readable names only). Equal
 * to discovery's own wait for it (connect/discovery.ts `TASK_NAMES_TIMEOUT_MS`;
 * a test pins the two), so the bus gives up when discovery stops waiting.
 */
export const LIST_TASKS_TIMEOUT_MS = 10_000;

/** Bus timeout of `client.getTaskPipeline` (discovery's per-task fallback; it runs inside the same discovery bound). */
export const GET_TASK_PIPELINE_TIMEOUT_MS = 30_000;

/** Bus timeout of `client.addMonitor` / `client.removeMonitor` (a registration; failing it only costs live updates). */
export const MONITOR_TIMEOUT_MS = 15_000;

/** Added to the controller's own timeout to get the frame's op timeout, so the controller's honest answer arrives first. */
export const FRAME_OP_MARGIN_MS = 5_000;

/**
 * Check a wait is a usable setTimeout delay.
 *
 * @param timeoutMs - The wait.
 * @param what - What it is for (named in the error).
 * @returns The wait.
 * @throws RangeError unless it is a finite number in (0, {@link MAX_TIMER_MS}].
 */
export function assertTimeoutMs(timeoutMs: unknown, what = 'timeoutMs'): number {
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
		throw new RangeError(`${what} must be a finite number of milliseconds in (0, ${MAX_TIMER_MS}]; got ${String(timeoutMs)}.`);
	}
	return timeoutMs;
}

/**
 * The bus timeout for one `client.tool` request, from the SDK timeout the
 * request carries.
 *
 * @param sdkTimeoutMs - The request's `timeout` (undefined: deliberately unbounded).
 * @returns The bus `timeoutMs`.
 */
export function busToolTimeoutMs(sdkTimeoutMs: number | undefined): number {
	if (sdkTimeoutMs === undefined) return UNBOUNDED_TOOL_TIMEOUT_MS;
	return assertTimeoutMs(assertTimeoutMs(sdkTimeoutMs, 'client.tool timeout') + BUS_TOOL_MARGIN_MS, 'client.tool bus timeout');
}

/**
 * The bus timeout of one tool call whose session wait is known: what the
 * controller's adapter will pass for it.
 *
 * @param waitMs - The session wait (null: the session left it unbounded).
 * @returns The bus `timeoutMs` of that call.
 */
export function toolCallBudgetMs(waitMs: number | null): number {
	if (waitMs === null) return UNBOUNDED_TOOL_TIMEOUT_MS;
	return busToolTimeoutMs(assertTimeoutMs(waitMs, 'session wait') + SDK_TIMEOUT_SLACK_MS);
}

/**
 * The frame's op timeout for an op whose controller side is bounded by
 * `controllerTimeoutMs` (for one tool call: `toolCallBudgetMs(wait)`; sum the
 * budgets of sequential calls).
 *
 * @param controllerTimeoutMs - The longest the controller can take.
 * @returns The `timeoutMs` the frame passes to its call.
 * @throws RangeError when the result would not be a real timer.
 */
export function frameOpTimeoutMs(controllerTimeoutMs: number): number {
	return assertTimeoutMs(assertTimeoutMs(controllerTimeoutMs, 'controller timeout') + FRAME_OP_MARGIN_MS, 'frame op timeout');
}
