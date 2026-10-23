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
// SQL — WAITS (every lane's timeout, explicit; R5)
// =============================================================================
//
// One place for every wait SQL Explorer names, on both lanes:
//
//   CONTROLLER   the bus timeout of each engine request the engine core makes
//                (sqlCore.ts) — user-store reads and writes, `client.use`,
//                discovery, release, services, validation, environment keys;
//                tool calls take theirs from connect/tools.ts.
//   FRAME        the op timeout a dev-tool frame passes to its controller
//                (`call(op, args, { timeoutMs })`): the longest the controller
//                can take for that op, plus the dev-tool library's frame
//                margin, so the controller's honest answer arrives first.
//
// Neither lane's 120 s default ever decides. A statement on a node that
// publishes no deadline has no client timeout (the app offers Stop waiting);
// on the bus that is the library's 24 h cap, and the frame waits that plus
// its margins (toolCallBudgetMs(null)).
// =============================================================================

import { DEFAULT_RETRY_WINDOW_MS } from 'shared/explorer/connect/session';
import { GET_TASKS_TIMEOUT_MS, frameOpTimeoutMs, toolCallBudgetMs } from 'shared/explorer/devtool/timeouts';
import { DIALECT_WAIT_MS, GET_SCHEMA_WAIT_MS, REFRESH_SCHEMA_WAIT_MS } from './connect/tools';

// =============================================================================
// CONTROLLER (engine requests)
// =============================================================================

/** Bus timeout of each user-store request (the saved-connection file). */
export const FS_TIMEOUT_MS = 15_000;

/** How long a call waits for the saved-connection list to finish loading (mkdir + read). */
export const LIST_WAIT_MS = 2 * FS_TIMEOUT_MS;

/** Bus timeout of `client.use` (starting or reattaching a direct connection's pipeline). */
export const USE_TIMEOUT_MS = 60_000;

/**
 * How long resolution waits for a discovery it asked for: the store's own
 * discovery bound (30 s) plus one probe (15 s). Discovery merges endpoints
 * before it probes them, so an endpoint is usually found well before this.
 */
export const DISCOVERY_WAIT_MS = 45_000;

/** The longest a resolution can take: the list, a direct pipeline's start, and a discovery. */
export const RESOLVE_BUDGET_MS = LIST_WAIT_MS + USE_TIMEOUT_MS + DISCOVERY_WAIT_MS;

/**
 * The longest the shared session's one retry of a statement can add: it
 * re-discovers the restarted pipeline for up to its retry window, plus one
 * discovery request already in flight when the window ends, and then sends
 * the statement again, unbounded (a statement's deadline is open-ended, so
 * the retry gets a second full wait). Only a statement marked idempotent (a
 * read) is ever retried, and only after TASK_STOPPED.
 */
export const STATEMENT_RETRY_BUDGET_MS = DEFAULT_RETRY_WINDOW_MS + GET_TASKS_TIMEOUT_MS + toolCallBudgetMs(null);

/** Bus timeout of `client.getTaskToken` and `client.terminate` (releasing a direct pipeline). */
export const RELEASE_STEP_TIMEOUT_MS = 15_000;

/** Bus timeout of `client.getService` (one service definition). */
export const SERVICE_TIMEOUT_MS = 30_000;

/** Bus timeout of `client.validate` (one component). */
export const VALIDATE_TIMEOUT_MS = 30_000;

/** Bus timeout of `client.getEnvironmentKeys`. */
export const ENV_KEYS_TIMEOUT_MS = 15_000;

// =============================================================================
// FRAME (op timeouts)
// =============================================================================

/** The frame's timeout per op (ms). */
export const SQL_OP_TIMEOUT_MS = {
	'sql.resolveEndpoint': frameOpTimeoutMs(RESOLVE_BUDGET_MS),
	'sql.releaseEndpoint': frameOpTimeoutMs(2 * RELEASE_STEP_TIMEOUT_MS),
	'sql.discoverEndpoints': frameOpTimeoutMs(DISCOVERY_WAIT_MS),
	// Resolve, then (when no probe has the dialect) one bounded `dialect` call
	// for the controller's gate, then the statement (unbounded: the 24 h cap),
	// and the session's one retry of a read (a rebind and a second 24 h wait).
	// About 48 h in all, well inside MAX_TIMER_MS.
	'sql.execute': frameOpTimeoutMs(RESOLVE_BUDGET_MS + toolCallBudgetMs(DIALECT_WAIT_MS) + toolCallBudgetMs(null) + STATEMENT_RETRY_BUDGET_MS),
	'sql.getSchema': frameOpTimeoutMs(RESOLVE_BUDGET_MS + toolCallBudgetMs(GET_SCHEMA_WAIT_MS)),
	// refresh_schema, then (on any failure) get_schema.
	'sql.refreshSchema': frameOpTimeoutMs(RESOLVE_BUDGET_MS + toolCallBudgetMs(REFRESH_SCHEMA_WAIT_MS) + toolCallBudgetMs(GET_SCHEMA_WAIT_MS)),
	'sql.dialect': frameOpTimeoutMs(RESOLVE_BUDGET_MS + toolCallBudgetMs(DIALECT_WAIT_MS)),
	'sql.getService': frameOpTimeoutMs(SERVICE_TIMEOUT_MS),
	'sql.validate': frameOpTimeoutMs(VALIDATE_TIMEOUT_MS),
	'sql.envKeys': frameOpTimeoutMs(ENV_KEYS_TIMEOUT_MS),
	// Once the saved list is read, a lookup in memory.
	'sql.connection': frameOpTimeoutMs(LIST_WAIT_MS),
	'sql.saveConnection': frameOpTimeoutMs(LIST_WAIT_MS + FS_TIMEOUT_MS),
	'sql.deleteConnection': frameOpTimeoutMs(LIST_WAIT_MS + 2 * RELEASE_STEP_TIMEOUT_MS + FS_TIMEOUT_MS),
	// History ops only touch the controller's memory (the file is written
	// later, debounced) once the saved list is read.
	'sql.history': frameOpTimeoutMs(LIST_WAIT_MS),
	'sql.historyRecord': frameOpTimeoutMs(LIST_WAIT_MS),
	'sql.historyEdit': frameOpTimeoutMs(LIST_WAIT_MS),
} as const;
