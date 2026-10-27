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
//   begin            40 s     (a connection out of the node's pool: SQLAlchemy's
//                             30 s pool timeout, plus the 10 s pad)
//   commit/rollback  60 s     (each first waits for the session's lock, behind
//                             a statement still running in it)
//   an Apply's       inside a transaction, 300 s EACH at most (the node's
//   statements       idle-transaction timeout: a stalled statement is not
//                    waited on longer than the node would keep an abandoned
//                    transaction, and a long plan is not cut off as a
//                    whole); committed one by one, as `execute` above (no
//                    transaction to outlast, so a long ALTER is not cut off)
//   get_sql          120 s    (Ask: the node's LLM writes a query and the node
//                             checks it with EXPLAIN, up to five drafts; it
//                             executes nothing, so a TASK_STOPPED refusal may
//                             be sent again)
//
// The waits for the shared tools come from the library's documented table
// (shared/explorer/connect/session DEFAULT_TOOL_TIMEOUTS), so SQL and the
// other Explorers stay in step with the node's own budgets.
//
// Port of f63da6e22 (connect/tools.ts), with the waits above in place of its
// 5-minute reflection budget.
// =============================================================================

import { checkObject, isPlainObject } from 'shared/explorer/checks';
import { ExplorerToolError } from 'shared/explorer/errors';
import { DEFAULT_TIMEOUT_PAD_MS, DEFAULT_TOOL_TIMEOUTS } from 'shared/explorer/connect/session';
import type { IToolSessionOptions } from 'shared/explorer/connect/session';

/** Client wait of the `dialect` tool (ms). */
export const DIALECT_WAIT_MS = DEFAULT_TOOL_TIMEOUTS.dialect as number;

/** Client wait of the `get_schema` tool (ms). */
export const GET_SCHEMA_WAIT_MS = DEFAULT_TOOL_TIMEOUTS.get_schema as number;

/** Client wait of the `refresh_schema` tool (ms). */
export const REFRESH_SCHEMA_WAIT_MS = DEFAULT_TOOL_TIMEOUTS.refresh_schema as number;

/**
 * Client wait of the `get_sql` tool (ms): an LLM round trip per draft plus an
 * EXPLAIN of each, the budget the shared library documents for `get_data`
 * (which is `get_sql` and then the query).
 */
export const GET_SQL_WAIT_MS = 120_000;

/** The longest question Ask sends (characters). */
export const MAX_QUESTION_CHARS = 2_000;

/** Added to a node's published statement deadline, so the node's own error arrives first. */
export const STATEMENT_WAIT_PAD_MS = DEFAULT_TIMEOUT_PAD_MS;

/**
 * How long the node keeps an idle transaction session before it rolls it
 * back (`tx_idle_timeout`, 300 s by default; packages/ai/.../tx_registry.py).
 */
export const NODE_TX_IDLE_MS = 300_000;

/**
 * The longest one statement of an Apply's transaction is waited for (less
 * when the node publishes a shorter statement deadline); a statement that
 * commits on its own waits as `execute` does. The node's reaper skips a session
 * while a statement runs in it, so only the gap BETWEEN calls has to stay
 * under its idle timeout, which the app's back-to-back calls do: each
 * statement gets its own wait, and a long plan is not cut off as a whole. A
 * statement still running when its wait ends stops the apply: the
 * transaction is rolled back (it is never committed), and the reaper is the
 * backstop for a rollback that cannot get through.
 */
export const APPLY_STATEMENT_WAIT_MS = NODE_TX_IDLE_MS;

/** The most statements one apply may carry (a longer list is refused before anything is sent). */
export const MAX_APPLY_STATEMENTS = 1000;

/**
 * The code of the refusal an atomic apply gets where there is no transaction
 * to have (a ClickHouse node, or a node without the `begin` tool). Nothing
 * was sent; the caller asks the user before sending the statements again,
 * one by one (`atomic: false`).
 */
export const TRANSACTIONS_UNAVAILABLE_CODE = 'transactions-unavailable';

/**
 * Whether an apply was refused because the engine has no transactions.
 *
 * @param error - What the apply threw.
 * @returns True for {@link TRANSACTIONS_UNAVAILABLE_CODE}.
 */
export function isTransactionsUnavailable(error: unknown): boolean {
	return error instanceof ExplorerToolError && error.code === TRANSACTIONS_UNAVAILABLE_CODE;
}

/** Client wait of the `begin` tool: a connection out of the node's pool (SQLAlchemy's 30 s pool timeout) plus the pad. */
export const BEGIN_WAIT_MS = 30_000 + DEFAULT_TIMEOUT_PAD_MS;

/** Client wait of the `commit` and `rollback` tools: the session's lock (a statement still running in it), then the end of the transaction. */
export const END_TX_WAIT_MS = 60_000;

/** Per-tool specs for the SQL node tools. */
export const SQL_TOOLS: IToolSessionOptions['tools'] = {
	// A statement may write: never repeated unless the caller marks it a read.
	// Its wait is decided per call (see statementWaitMs).
	execute: { idempotent: false, check: checkObject },
	get_schema: { idempotent: true, timeoutMs: GET_SCHEMA_WAIT_MS, check: checkObject },
	refresh_schema: { idempotent: true, timeoutMs: REFRESH_SCHEMA_WAIT_MS, check: checkObject },
	dialect: { idempotent: true, timeoutMs: DIALECT_WAIT_MS, check: checkObject },
	// The transaction tools an Apply runs (connect/session.ts). Never
	// repeated: a second `begin` would open a second transaction, and a
	// session does not outlive the task restart a retry would follow.
	begin: { idempotent: false, timeoutMs: BEGIN_WAIT_MS, check: checkObject },
	commit: { idempotent: false, timeoutMs: END_TX_WAIT_MS, check: checkObject },
	rollback: { idempotent: false, timeoutMs: END_TX_WAIT_MS, check: checkObject },
	// Writes SQL without running it; every `valid: false` shape is the
	// node's answer (data), so only the object floor applies.
	get_sql: { idempotent: true, timeoutMs: GET_SQL_WAIT_MS, check: checkObject },
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
