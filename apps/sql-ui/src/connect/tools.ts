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
// CONNECT — TOOLS (how SQL Explorer calls each node tool)
// =============================================================================
//
// The per-tool table the shared session is built from: which tools may be
// repeated, how long the client waits, and how a result is judged. Every wait
// is explicit (R5), so neither platform lane's 120 s default ever decides:
//
//   dialect          15 s     (the probe and the engine check)
//   get_schema       60 s     (serves the snapshot the node already holds)
//   refresh_schema   135 s    (may queue behind another reflection, then
//                             reflect: 2 x 60 s + 5 s lock slack + 10 s pad)
//   execute          the node's published `limits.statement_timeout_ms` plus
//                    10 s; a node that publishes none (today's SQL nodes:
//                    their `dialect` answer is `{ dialect }` only, and the
//                    engine sets no statement deadline) gets NO client
//                    timeout, so a long analytical query is not cut off; the
//                    app offers "Stop waiting" instead. On the bus that is
//                    carried as the dev-tool library's 24 h cap
//                    (UNBOUNDED_TOOL_TIMEOUT_MS), never as the 120 s default.
//
// The waits for the shared tools come from the library's documented table
// (shared/explorer/connect/session DEFAULT_TOOL_TIMEOUTS), so SQL and the
// other Explorers stay in step with the node's own budgets.
//
// Port of f63da6e22 (connect/tools.ts), with the waits above in place of its
// 5-minute reflection budget.
// =============================================================================

import { checkObject, isPlainObject } from 'shared/explorer/checks';
import { DEFAULT_TIMEOUT_PAD_MS, DEFAULT_TOOL_TIMEOUTS } from 'shared/explorer/connect/session';
import type { IToolSessionOptions } from 'shared/explorer/connect/session';

/** Client wait of the `dialect` tool (ms). */
export const DIALECT_WAIT_MS = DEFAULT_TOOL_TIMEOUTS.dialect as number;

/** Client wait of the `get_schema` tool (ms). */
export const GET_SCHEMA_WAIT_MS = DEFAULT_TOOL_TIMEOUTS.get_schema as number;

/** Client wait of the `refresh_schema` tool (ms). */
export const REFRESH_SCHEMA_WAIT_MS = DEFAULT_TOOL_TIMEOUTS.refresh_schema as number;

/** Added to a node's published statement deadline, so the node's own error arrives first. */
export const STATEMENT_WAIT_PAD_MS = DEFAULT_TIMEOUT_PAD_MS;

/** Per-tool specs for the SQL node tools. */
export const SQL_TOOLS: IToolSessionOptions['tools'] = {
	// A statement may write: never repeated unless the caller marks it a read.
	// Its wait is decided per call (see statementWaitMs).
	execute: { idempotent: false, check: checkObject },
	get_schema: { idempotent: true, timeoutMs: GET_SCHEMA_WAIT_MS, check: checkObject },
	refresh_schema: { idempotent: true, timeoutMs: REFRESH_SCHEMA_WAIT_MS, check: checkObject },
	dialect: { idempotent: true, timeoutMs: DIALECT_WAIT_MS, check: checkObject },
};

/**
 * How long one statement may take: the node's published statement deadline
 * plus {@link STATEMENT_WAIT_PAD_MS}, or null (no client timeout) when the
 * node publishes none.
 *
 * @param info - The node's last `dialect` answer (the session's `info()`), or null.
 * @returns The wait in ms, or null.
 */
export function statementWaitMs(info: Record<string, unknown> | null): number | null {
	const limits = info !== null && isPlainObject(info.limits) ? info.limits : null;
	const value = limits?.statement_timeout_ms;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value + STATEMENT_WAIT_PAD_MS : null;
}
