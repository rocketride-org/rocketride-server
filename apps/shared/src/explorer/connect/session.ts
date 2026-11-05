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
// EXPLORER CONNECT — TOOL SESSION (one endpoint, one way to call it)
// =============================================================================
//
// Every node tool call an Explorer makes goes through ONE function: `invoke`.
// It is where five platform facts are turned into behaviour:
//
//  1. FAILURE DEPENDS ON THE TOOL. A per-tool ResultCheck judges what a call
//     that did not raise actually returned (see checks.ts).
//
//  2. NOTHING CAN BE CANCELLED. A client that stops waiting only stops
//     listening; the server finishes the work. So every call carries an
//     EXPLICIT client timeout, owned by this session (never read out of an
//     SDK message), set above the node's own statement deadline so the node's
//     error normally arrives first; and a generation ticket makes a late
//     answer from an abandoned call get dropped instead of landing on top of
//     what the user is looking at now.
//
//  3. THE SERVER HAS NO "RESTARTING" CODE. A call that lands while a task is
//     being restarted fails with TASK_STOPPED from `wait_for_running`, BEFORE
//     the request reaches the node — and a task the user really stopped fails
//     with the same code. So a retry is allowed only when ALL of these hold:
//       - the call is idempotent: its tool spec says so, or the CALLER marks
//         this call so (`opts.idempotent`). A write never is; `execute` is
//         not by default, and SQL Explorer marks an `execute` idempotent only
//         for a statement its classifier calls a read. Such a replay is safe
//         ONLY because TASK_STOPPED is raised before dispatch: nothing ran;
//       - the error carries the transient code (read off the SDK error's
//         `code`, never parsed out of its message);
//       - re-discovery, within a bounded window, finds the SAME endpoint
//         running again (task tokens are deterministic, so the token may be
//         identical — what proves the restart is that the endpoint is back);
//       - it is the first retry: at most ONE, and the whole call, retry
//         included, still finishes inside its own timeout.
//     Permission errors, malformed input, timeouts and anything ambiguous are
//     never retried.
//
//  4. A NODE MAY NOT HAVE THE TOOL. A tool can name the dialect capability it
//     needs; when the node's `dialect` answer does not advertise it, the call
//     is refused locally as `upgrade` — it never falls back to another tool
//     (browsing must not drift onto `execute`, or onto FalkorDB's writable
//     `query`).
//
//  5. THE TOKEN IS A SECRET. The session reads it from the store's vault at
//     call time and never keeps it, so nothing the session exposes (or logs,
//     or serialises) contains one.
// =============================================================================

import { isPlainObject } from '../checks';
import type { CheckOutcome, ResultCheck } from '../checks';
import { ExplorerToolError, readErrorCode, readErrorMessage } from '../errors';
import type { IGenerationTicket } from '../generation';
import type { IExplorerClient, IExplorerEndpoint } from '../types';
import { checkObject } from '../checks';

// =============================================================================
// DEFAULTS
// =============================================================================

/** The server code a call receives while its task is restarting (and also when it was really stopped). */
export const TRANSIENT_TASK_CODE = 'TASK_STOPPED';

/** Wait for an unknown tool when the node's deadline is not published: node 30 s + 10 s. */
export const DEFAULT_TIMEOUT_MS = 40_000;

/** Added to `dialect.limits.statement_timeout_ms` so the node's own error arrives first. */
export const DEFAULT_TIMEOUT_PAD_MS = 10_000;

/** How long re-discovery may look for a restarted endpoint. */
export const DEFAULT_RETRY_WINDOW_MS = 15_000;

/** Pause between re-discovery attempts. */
export const DEFAULT_RETRY_POLL_MS = 1_000;

/** The SDK is told to wait this much LONGER than the session, so the session's typed timeout always wins and the SDK frees its pending-request entry. */
const SDK_TIMEOUT_SLACK_MS = 1_000;

/**
 * The node's own budget for one schema reflection
 * (`SCHEMA_REFRESH_BUDGET_MS`, packages/ai/src/ai/common/graph/schema.py).
 */
const NODE_SCHEMA_REFRESH_BUDGET_MS = 60_000;

/**
 * How much longer than its own budget a refresh may wait for the per-node lock
 * (`refresh_schema_snapshot` waits up to budget + 5 s before refusing).
 */
const NODE_SCHEMA_LOCK_SLACK_MS = 5_000;

/**
 * Documented per-tool client budgets for the tools every Explorer shares.
 * Apps spread this into their `tools` map and override where they know better.
 * Query tools are NOT listed: their budget derives from the node's published
 * statement deadline (see {@link IToolSessionOptions.timeoutPadMs}).
 *
 * A client wait must sit ABOVE the node's deadline, or the app says "stopped
 * waiting" just before the node returns its honest stale/error answer:
 *
 * - `refresh_schema` can queue behind another refresh (up to budget + 5 s) and
 *   then reflect for up to its own budget, so the worst honest answer arrives
 *   after 2 x budget + 5 s; plus the usual 10 s pad = 135 s.
 * - `get_schema` serves the snapshot the node already holds, so 60 s stands.
 */
export const DEFAULT_TOOL_TIMEOUTS: Readonly<Record<string, number>> = {
	dialect: 15_000,
	get_schema: 60_000,
	refresh_schema: 2 * NODE_SCHEMA_REFRESH_BUDGET_MS + NODE_SCHEMA_LOCK_SLACK_MS + DEFAULT_TIMEOUT_PAD_MS,
	get_data: 120_000,
	get_query: 120_000,
};

// =============================================================================
// TYPES
// =============================================================================

/** How one tool is called and judged. */
export interface IToolSpec {
	/** Safe to send twice (reads, reflection). Default false: never retried. */
	idempotent?: boolean;
	/** Judges the resolved value. Default {@link checkObject}. */
	check?: ResultCheck;
	/**
	 * Client wait in ms. A number is used as is; `null` is an explicit "no
	 * client timeout" (the app offers Stop waiting instead); omitted derives
	 * from the node's published statement deadline, else the default.
	 */
	timeoutMs?: number | null;
	/** The `dialect.capabilities` key that must be `true`, else the call is refused locally as `upgrade`. */
	capability?: string;
}

/** Session behaviour shared by all its tools. */
export interface IToolSessionOptions {
	/** Per-tool specs; a tool absent from the map gets the defaults (not idempotent, object check). */
	tools: Readonly<Record<string, IToolSpec>>;
	/** Wait when nothing else applies (default {@link DEFAULT_TIMEOUT_MS}). */
	defaultTimeoutMs?: number;
	/** Added to the node's published statement deadline (default {@link DEFAULT_TIMEOUT_PAD_MS}). */
	timeoutPadMs?: number;
	/** The one-retry rule. */
	retry?: {
		/** Codes that make a retry possible (default [TASK_STOPPED]). */
		transientCodes?: readonly string[];
		/** How long re-discovery may look (default {@link DEFAULT_RETRY_WINDOW_MS}). */
		windowMs?: number;
		/** Pause between re-discovery attempts (default {@link DEFAULT_RETRY_POLL_MS}). */
		pollMs?: number;
	};
}

/** Per-call options. */
export interface IInvokeOptions {
	/** Override the tool's idempotency for this call. */
	idempotent?: boolean;
	/** Override the client wait for this call. */
	timeoutMs?: number | null;
	/** The ticket of the request this call belongs to; a result whose ticket expired is dropped (kind `stale`). */
	generation?: IGenerationTicket;
	/** Forbid the retry for this call (probes use it so a restarting task cannot make probing recurse). */
	retry?: false;
}

/** One endpoint, one way to call it. */
export interface IToolSession {
	/** The endpoint this session is bound to. */
	readonly endpoint: IExplorerEndpoint;
	/**
	 * Call a node tool. Resolves with the value once its ResultCheck passed;
	 * rejects with an {@link ExplorerToolError}.
	 */
	invoke<T = unknown>(tool: string, input?: Record<string, unknown>, opts?: IInvokeOptions): Promise<T>;
	/** The last probed `dialect` answer (engine, version, database, graph, allow_execute, capabilities, limits), or null. */
	info(): Record<string, unknown> | null;
}

/** What a session needs from the store that owns the token. */
export interface ISessionDeps {
	/** The endpoint's current task token (read at call time, never kept), or undefined when none is known. */
	token(): string | undefined;
	/** The last probed `dialect` answer, or null. */
	info(): Record<string, unknown> | null;
	/**
	 * Re-discover and report whether the SAME endpoint key is running again,
	 * giving up at `deadlineAt` (epoch ms). Must refresh the token the session
	 * reads. Optional: without it no retry ever happens.
	 */
	rebind?(deadlineAt: number): Promise<boolean>;
	/** Current time in ms (injected for tests). */
	now?(): number;
	/** Timer used for the session's own timeout (injected for tests). */
	setTimer?(fn: () => void, ms: number): unknown;
	/** Cancels a timer from {@link ISessionDeps.setTimer}. */
	clearTimer?(handle: unknown): void;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Read the statement deadline a node published in its `dialect` answer.
 *
 * @param info - The dialect answer, or null.
 * @returns The deadline in ms, or undefined when not published.
 */
function publishedDeadlineMs(info: Record<string, unknown> | null): number | undefined {
	const limits = info !== null && isPlainObject(info.limits) ? info.limits : null;
	const value = limits?.statement_timeout_ms;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Whether the node advertises a capability.
 *
 * @param info - The dialect answer, or null.
 * @param capability - The capability key.
 * @returns True only when `capabilities[capability] === true`.
 */
function hasCapability(info: Record<string, unknown> | null, capability: string): boolean {
	const capabilities = info !== null && isPlainObject(info.capabilities) ? info.capabilities : null;
	return capabilities !== null && capabilities[capability] === true;
}

/**
 * Turn a failed check into an error.
 *
 * @param tool - The tool.
 * @param outcome - The failing verdict.
 * @returns The error.
 */
function checkFailure(tool: string, outcome: Extract<CheckOutcome, { ok: false }>): ExplorerToolError {
	const message = outcome.detail ? `${outcome.message}\n${outcome.detail}` : outcome.message;
	return new ExplorerToolError({ kind: outcome.kind, tool, message });
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a session over one endpoint.
 *
 * @param client - The shell's RocketRide client.
 * @param endpoint - The endpoint (token-free).
 * @param deps - The token, info and rebind seams the owning store provides.
 * @param options - The tools, budgets and retry rule.
 * @returns The session.
 */
export function createToolSession(client: IExplorerClient, endpoint: IExplorerEndpoint, deps: ISessionDeps, options: IToolSessionOptions): IToolSession {
	const now = deps.now ?? (() => Date.now());
	const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const padMs = options.timeoutPadMs ?? DEFAULT_TIMEOUT_PAD_MS;
	const transientCodes = options.retry?.transientCodes ?? [TRANSIENT_TASK_CODE];
	const windowMs = options.retry?.windowMs ?? DEFAULT_RETRY_WINDOW_MS;

	/**
	 * The client wait for one call.
	 *
	 * @param spec - The tool's spec.
	 * @param override - The per-call override.
	 * @returns Milliseconds, or null for no client timeout.
	 */
	function budgetFor(spec: IToolSpec, override: number | null | undefined): number | null {
		if (override !== undefined) return override;
		if (spec.timeoutMs !== undefined) return spec.timeoutMs;
		const deadline = publishedDeadlineMs(deps.info());
		return deadline !== undefined ? deadline + padMs : defaultTimeoutMs;
	}

	/**
	 * One attempt: send, wait (bounded), return the raw value.
	 *
	 * @param tool - The tool.
	 * @param input - Its input.
	 * @param waitMs - The wait in ms, or null for none.
	 * @returns The resolved value.
	 */
	async function attempt(tool: string, input: Record<string, unknown>, waitMs: number | null): Promise<unknown> {
		const token = deps.token();
		if (token === undefined || token === '') {
			throw new ExplorerToolError({ kind: 'unavailable', tool, message: `No running task for pipeline '${endpoint.pipelineName}'. Start the pipeline and retry.` });
		}
		const call = client.tool({
			token,
			tool,
			nodeId: endpoint.nodeId,
			input,
			...(waitMs === null ? {} : { timeout: waitMs + SDK_TIMEOUT_SLACK_MS }),
		});
		if (waitMs === null) return call;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimer(() => {
				// The SDK entry is still pending: an answer that arrives later must not surface.
				call.catch(() => undefined);
				reject(new ExplorerToolError({
					kind: 'timeout',
					tool,
					message: `Stopped waiting for ${tool} after ${Math.round(waitMs / 1000)} s. The node may still be running it; there is no way to cancel it from here.`,
				}));
			}, waitMs);
			call.then(
				(value) => { clearTimer(timer); resolve(value); },
				(error) => { clearTimer(timer); reject(error); },
			);
		});
	}

	/**
	 * Map anything an attempt threw onto the one error class.
	 *
	 * @param tool - The tool.
	 * @param error - What was thrown.
	 * @returns The error.
	 */
	function toToolError(tool: string, error: unknown): ExplorerToolError {
		if (error instanceof ExplorerToolError) return error;
		return new ExplorerToolError({ kind: 'raised', tool, message: readErrorMessage(error), code: readErrorCode(error) });
	}

	async function invoke<T = unknown>(tool: string, input: Record<string, unknown> = {}, opts: IInvokeOptions = {}): Promise<T> {
		if (!isPlainObject(input)) {
			throw new ExplorerToolError({ kind: 'malformed', tool, message: `${tool} needs an object for its input` });
		}
		const spec: IToolSpec = options.tools[tool] ?? {};
		const ticket = opts.generation;
		const dropIfStale = (): void => {
			if (ticket !== undefined && !ticket.isCurrent()) {
				throw new ExplorerToolError({ kind: 'stale', tool, message: `The result of ${tool} was dropped: a newer request replaced it.` });
			}
		};

		// A tool that needs a capability the node does not advertise is refused
		// before anything is sent, and never falls back to another tool.
		if (spec.capability !== undefined && !hasCapability(deps.info(), spec.capability)) {
			throw new ExplorerToolError({
				kind: 'upgrade',
				tool,
				message: `This node cannot run ${tool}: it does not advertise "${spec.capability}". Update the pipeline's node to a version that supports it.`,
			});
		}

		const idempotent = opts.idempotent ?? spec.idempotent ?? false;
		const waitMs = budgetFor(spec, opts.timeoutMs);
		const started = now();
		const deadlineAt = waitMs === null ? Number.POSITIVE_INFINITY : started + waitMs;

		let value: unknown;
		try {
			value = await attempt(tool, input, waitMs);
		} catch (first) {
			dropIfStale();
			const failure = toToolError(tool, first);
			const code = failure.code;
			const retryable = idempotent && opts.retry !== false && failure.kind === 'raised' && code !== undefined
				&& transientCodes.includes(code) && deps.rebind !== undefined;
			if (!retryable) throw failure;

			// ONE retry, only if the endpoint is demonstrably back, and only inside the call's own deadline.
			const remaining = deadlineAt - now();
			const window = Math.min(windowMs, remaining);
			if (!(window >= SDK_TIMEOUT_SLACK_MS)) throw failure;
			let back = false;
			try {
				back = await (deps.rebind as NonNullable<ISessionDeps['rebind']>)(now() + window);
			} catch {
				back = false;
			}
			dropIfStale();
			const left = deadlineAt - now();
			if (!back || !(left > 0)) throw failure;
			try {
				value = await attempt(tool, input, waitMs === null ? null : left);
			} catch (second) {
				dropIfStale();
				throw toToolError(tool, second);
			}
		}

		dropIfStale();
		const outcome = (spec.check ?? checkObject)(value, { tool });
		if (!outcome.ok) throw checkFailure(tool, outcome);
		return value as T;
	}

	return { endpoint, invoke, info: () => deps.info() };
}
