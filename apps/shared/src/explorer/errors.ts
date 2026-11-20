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
// EXPLORER — ERRORS (what a failed tool call looks like to an app)
// =============================================================================
//
// The platform reports failure four different ways depending on the TOOL, not
// the node family (see checks.ts), and a client that stops waiting is a fifth.
// Everything an app ever has to catch from a session is ONE class, with a
// `kind` that says which — so UI code branches on a closed set instead of on
// message text.
//
// `code` is the server's machine-readable code (`DAPException.code`, e.g.
// TASK_STOPPED) copied from the SDK error when the SDK preserved it. It is
// never parsed out of prose.
// =============================================================================

/**
 * How a tool call failed.
 *
 * - `raised`         — the client rejected: a database error, a safety refusal,
 *                      invalid input, a permission denial, a dead task.
 * - `invalid`        — get_data / get_query answered `{valid: false}` with an
 *                      `error`, or with neither an `error` nor an `answer`.
 *                      `{valid: false, answer}` with no error is a prose
 *                      answer, not a failure.
 * - `store`          — `{success: false, error}` (store and vector tools).
 * - `error-envelope` — `{error, columns: [], rows: []}` (FalkorDB's legacy `query`).
 * - `malformed`      — the result failed envelope validation.
 * - `timeout`        — THIS CLIENT stopped waiting. Nothing cancels the server
 *                      side, so the work may still be running.
 * - `upgrade`        — the node lacks the tool or capability. Never falls back
 *                      to another tool.
 * - `unavailable`    — there is no running task (or token) for the endpoint.
 * - `stale`          — the result belongs to a superseded request and was
 *                      dropped; callers ignore it.
 */
export type ExplorerErrorKind = 'raised' | 'invalid' | 'store' | 'error-envelope' | 'malformed' | 'timeout' | 'upgrade' | 'unavailable' | 'stale';

/** What to build an {@link ExplorerToolError} from. */
export interface IExplorerToolErrorInit {
	/** How the call failed. */
	kind: ExplorerErrorKind;
	/** The tool that was called. */
	tool: string;
	/** The full message, verbatim. */
	message: string;
	/** The server's machine-readable code, when the SDK preserved it. */
	code?: string;
}

/**
 * Split a message into the headline an error banner leads with and the rest.
 *
 * @param message - The full message.
 * @returns The first non-empty line, and everything after it (undefined when nothing).
 */
export function splitMessage(message: string): { headline: string; detail: string | undefined } {
	const text = (message ?? '').trim();
	const newline = text.indexOf('\n');
	if (newline < 0) return { headline: text, detail: undefined };
	const headline = text.slice(0, newline).trim();
	const rest = text.slice(newline + 1).trim();
	return { headline, detail: rest === '' ? undefined : rest };
}

/** The one error class a tool session throws. */
export class ExplorerToolError extends Error {
	/** How the call failed. */
	readonly kind: ExplorerErrorKind;

	/** The tool that was called. */
	readonly tool: string;

	/** The server's machine-readable code (e.g. TASK_STOPPED), when the SDK preserved it. */
	readonly code?: string;

	/** The first line of {@link message}: what a banner leads with. */
	readonly headline: string;

	/** Everything after the first line ("Database said"), when there is any. */
	readonly detail?: string;

	/**
	 * @param init - What failed and how.
	 */
	constructor(init: IExplorerToolErrorInit) {
		super(init.message);
		this.name = 'ExplorerToolError';
		this.kind = init.kind;
		this.tool = init.tool;
		if (typeof init.code === 'string' && init.code !== '') this.code = init.code;
		const { headline, detail } = splitMessage(init.message);
		this.headline = headline;
		if (detail !== undefined) this.detail = detail;
		// Keep `instanceof` working when compiled to an older target.
		Object.setPrototypeOf(this, ExplorerToolError.prototype);
	}
}

/**
 * Whether a caught value is a dropped-result marker. Callers ignore these: the
 * request that produced it was superseded (a newer run, a new connection, a
 * reset), so its outcome must never be shown.
 *
 * @param error - Anything thrown by a session call.
 * @returns True for a stale-result error.
 */
export function isStaleError(error: unknown): error is ExplorerToolError {
	return error instanceof ExplorerToolError && error.kind === 'stale';
}

/**
 * Read the machine-readable code off whatever an SDK call threw.
 *
 * @param error - The thrown value.
 * @returns The code, or undefined when there is none (plain Errors, today's SDK).
 */
export function readErrorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== 'object') return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' && code !== '' ? code : undefined;
}

/**
 * Read the message off whatever was thrown.
 *
 * @param error - The thrown value.
 * @returns The message text.
 */
export function readErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === 'string' ? error : String(error);
}
