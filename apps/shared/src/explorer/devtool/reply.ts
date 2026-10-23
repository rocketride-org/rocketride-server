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
// EXPLORER DEV TOOL — REPLY (tool failures are data, not throws, R3)
// =============================================================================
//
// The op lane (toolOps.ts) carries a handler's failure as `error.message`
// ONLY: the frame gets `new Error(text)`, and `kind`, `code` and the class are
// gone. So every engine-facing op returns a Reply instead of throwing:
//
//   controller   handler: (params) => toReply(() => session.invoke(…))
//   frame        value = fromReply(await call(…))   // or callReply, frame.ts
//
// `fromReply` rebuilds a REAL ExplorerToolError with the same kind, code,
// tool and message, so failures.ts, the wording tables and every
// `error.code === …` switch work unchanged in a frame.
//
// VOID OPS answer `Reply<null>`. JSON has no `undefined`: `{ ok: true, value:
// undefined }` arrives in a VS Code webview as `{ ok: true }`. So `replyOk`
// and `toReply` turn an undefined value into null, and a success that lost
// its value on the wire still reads as a Reply (its value is null).
//
// What still throws (and crosses as a plain message): programming errors
// (TypeError, ReferenceError, RangeError, SyntaxError) and protocol errors (a
// malformed Reply, an unknown op, a missing deadline). Those are bugs.
//
// Kind for failures that are not ExplorerToolErrors. Only the lanes' OWN texts
// are classified, each anchored at the start of the message:
//
//   toolOps.ts      "'<op>' did not answer within <n>s; …"          -> timeout
//   busOps.ts       "Op '<op>' timed out after <n>ms"               -> timeout
//   busBridge.ts    "… (bridged)" / "… (routed to <host>)"          -> timeout
//   clientOps.ts    "Not connected to server"                       -> unavailable
//
// Everything else is `raised`, message verbatim. A `code` is copied only when
// the thrown value carries one (the SDK's DAPException, in a realm that has
// the client); it is never parsed out of text (R10). Over the VS Code bridge
// the controller's own `client.tool` failures arrive without one.
// =============================================================================

import { ExplorerToolError, readErrorCode, readErrorMessage } from '../errors';
import type { ExplorerErrorKind } from '../errors';

// =============================================================================
// TYPES
// =============================================================================

/** A value that survives `JSON.parse(JSON.stringify(x))` unchanged. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A failure, as data. */
export interface ReplyError {
	/** How it failed (the library's closed set). */
	kind: ExplorerErrorKind;
	/** The server's machine-readable code, when the thrown error carried one. */
	code?: string;
	/** The full message, verbatim. */
	message: string;
	/** The node tool that failed, when known. */
	tool?: string;
	/** Everything after the message's first line (informational; the frame re-derives it from `message`). */
	detail?: JsonValue;
	/** Seconds to wait before retrying, when the failure said so. */
	retryAfterS?: number;
}

/** What an engine-facing op returns. */
export type Reply<T> = { ok: true; value: T } | { ok: false; error: ReplyError };

/** The value type a Reply carries (not distributive: `Reply<T>` is itself a union). */
export type ReplyValue<R> = [R] extends [Reply<infer T>] ? T : never;

/** What a void body answers: `void` / `undefined` become `null` (JSON has no undefined). */
export type VoidAsNull<T> = [T] extends [never] ? never : [T] extends [void] ? null : T;

/** Every {@link ExplorerErrorKind}, at runtime (a Reply naming any other kind is a protocol error). */
export const EXPLORER_ERROR_KINDS = ['raised', 'invalid', 'store', 'error-envelope', 'malformed', 'timeout', 'upgrade', 'unavailable', 'stale'] as const satisfies readonly ExplorerErrorKind[];

/** Compile-time check that {@link EXPLORER_ERROR_KINDS} lists every kind errors.ts declares. */
type MissingKind = Exclude<ExplorerErrorKind, (typeof EXPLORER_ERROR_KINDS)[number]>;
const _EVERY_KIND_LISTED: [MissingKind] extends [never] ? true : never = true;
void _EVERY_KIND_LISTED;

const KINDS: ReadonlySet<string> = new Set(EXPLORER_ERROR_KINDS);

// =============================================================================
// CLASSIFICATION
// =============================================================================

/** The op lane's timeout (toolOps.ts): `'<op>' did not answer within <n>s; …`. */
const OP_LANE_TIMEOUT = /^'[^']*' did not answer within \d+s;/;

/** The bus lane's timeout (busOps.ts, busBridge.ts): `Op '<op>' timed out after <n>ms[ (…)]`. */
const BUS_LANE_TIMEOUT = /^Op '[^']*' timed out after \d+ms(?: \([^)]*\))?$/;

/** The brokered client's not-connected refusal (clientOps.ts). */
const NOT_CONNECTED = 'Not connected to server';

/**
 * Whether a message is one of the lanes' own timeout texts.
 *
 * @param message - The message.
 * @returns True for an op-lane or bus-lane timeout.
 */
export function isLaneTimeoutText(message: string): boolean {
	return OP_LANE_TIMEOUT.test(message) || BUS_LANE_TIMEOUT.test(message);
}

/**
 * Whether a thrown value is a programming error (rethrown, never turned into data).
 *
 * @param error - The thrown value.
 * @returns True for TypeError, ReferenceError, RangeError and SyntaxError.
 */
export function isProgrammingError(error: unknown): boolean {
	return error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError;
}

/**
 * The kind of a failure that is not an ExplorerToolError.
 *
 * @param message - Its message.
 * @returns timeout, unavailable or raised.
 */
function kindOfForeign(message: string): ExplorerErrorKind {
	if (isLaneTimeoutText(message)) return 'timeout';
	if (message === NOT_CONNECTED) return 'unavailable';
	return 'raised';
}

/**
 * A finite, non-negative `retryAfterS` off a thrown value.
 *
 * @param error - The thrown value.
 * @returns The seconds, or undefined.
 */
function readRetryAfter(error: unknown): number | undefined {
	if (error === null || typeof error !== 'object') return undefined;
	const value = (error as { retryAfterS?: unknown }).retryAfterS;
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// =============================================================================
// CONTROLLER SIDE
// =============================================================================

/**
 * A successful Reply. An undefined value (a void op) becomes null.
 *
 * @param value - The (JSON-safe) value.
 * @returns The Reply.
 */
export function replyOk<T>(value: T): Reply<VoidAsNull<T>> {
	return { ok: true, value: (value === undefined ? null : value) as VoidAsNull<T> };
}

/**
 * Turn a thrown value into Reply data.
 *
 * @param error - What was thrown.
 * @param tool - The tool to name when the failure names none.
 * @returns The error data.
 * @throws The value itself when it is a programming error.
 */
export function toReplyError(error: unknown, tool?: string): ReplyError {
	if (isProgrammingError(error)) throw error;
	const out: ReplyError = error instanceof ExplorerToolError
		? { kind: error.kind, message: error.message, tool: error.tool }
		: { kind: kindOfForeign(readErrorMessage(error)), message: readErrorMessage(error) };
	if (!(error instanceof ExplorerToolError) && tool !== undefined && tool !== '') out.tool = tool;
	const code = readErrorCode(error);
	if (code !== undefined) out.code = code;
	if (error instanceof ExplorerToolError && error.detail !== undefined) out.detail = error.detail;
	const retryAfterS = readRetryAfter(error);
	if (retryAfterS !== undefined) out.retryAfterS = retryAfterS;
	return out;
}

/**
 * Run a controller handler body and return its outcome as a Reply.
 *
 * @param fn - The body.
 * @param opts - `tool`: the node tool to name when a failure names none.
 * @returns The Reply.
 * @throws Programming errors, unchanged.
 */
export async function toReply<T>(fn: () => T | Promise<T>, opts: { tool?: string } = {}): Promise<Reply<VoidAsNull<T>>> {
	try {
		return replyOk(await fn());
	} catch (error) {
		return { ok: false, error: toReplyError(error, opts.tool) };
	}
}

/**
 * Make a Reply-returning op handler out of a plain one.
 *
 * @param handler - The plain handler.
 * @param opts - `tool`: the node tool to name when a failure names none.
 * @returns The handler, answering Replies.
 */
export function replying<P, T>(handler: (params: P) => T | Promise<T>, opts: { tool?: string } = {}): (params: P) => Promise<Reply<VoidAsNull<T>>> {
	return (params: P) => toReply(() => handler(params), opts);
}

// =============================================================================
// FRAME SIDE
// =============================================================================

/**
 * Whether a value is a well-formed Reply, as it arrives over the wire.
 *
 * @param value - Anything (it arrived over the wire).
 * @returns True for `{ok: true[, value]}` (JSON drops an undefined value) or
 *   `{ok: false, error: {kind, message}}` with a known kind.
 */
export function isReply(value: unknown): value is Reply<unknown> {
	if (value === null || typeof value !== 'object') return false;
	const reply = value as { ok?: unknown; value?: unknown; error?: unknown };
	if (reply.ok === true) return true;
	if (reply.ok !== false || reply.error === null || typeof reply.error !== 'object') return false;
	const error = reply.error as { kind?: unknown; message?: unknown };
	return typeof error.kind === 'string' && KINDS.has(error.kind) && typeof error.message === 'string';
}

/**
 * Rebuild the ExplorerToolError a Reply error describes.
 *
 * @param error - The Reply's error.
 * @param fallbackTool - The tool to name when it names none (frames pass the op).
 * @returns The error.
 */
export function errorFromReply(error: ReplyError, fallbackTool = ''): ExplorerToolError {
	const rebuilt = new ExplorerToolError({
		kind: error.kind,
		tool: typeof error.tool === 'string' && error.tool !== '' ? error.tool : fallbackTool,
		message: error.message,
		...(typeof error.code === 'string' && error.code !== '' ? { code: error.code } : {}),
	});
	if (typeof error.retryAfterS === 'number' && Number.isFinite(error.retryAfterS) && error.retryAfterS >= 0) {
		Object.defineProperty(rebuilt, 'retryAfterS', { value: error.retryAfterS, enumerable: true });
	}
	return rebuilt;
}

/**
 * The value of a Reply, or a REAL ExplorerToolError equal to the failure.
 *
 * @param reply - What the op answered.
 * @param opts - `tool`: named when the failure names none (frames pass the op name).
 * @returns The value.
 * @throws ExplorerToolError for a failed Reply; a plain Error (protocol) for anything that is not a Reply.
 */
export function fromReply<T>(reply: Reply<T>, opts: { tool?: string } = {}): T {
	if (!isReply(reply)) throw new Error(`Protocol error: expected a Reply, got ${describe(reply)}.`);
	if (reply.ok) return (reply.value === undefined ? null : reply.value) as T;
	throw errorFromReply(reply.error, opts.tool);
}

/**
 * Normalise what a controller handler produced into the Reply it answers
 * (attachController applies it to every handler, so a lane cannot lose a
 * failure's kind or code by forgetting `toReply`):
 *
 *   - a returned Reply, recognised STRICTLY (its keys are exactly `ok` +
 *     `value`, or `ok` + a well-formed `error`), passes through, an undefined
 *     value becoming null; a plain result that merely has an `ok` field (such
 *     as a probe result) is NOT taken for one;
 *   - any other value becomes `replyOk(value)` (undefined: null).
 *
 * THE TWO RESERVED SHAPES. A plain domain value whose keys are exactly
 * `{ ok, value }`, or exactly `{ ok: false, error: { kind, message, … } }`,
 * is indistinguishable from a Reply and is taken for one. A handler that
 * answers such a value returns `replyOk(value)` explicitly. (An exact marker
 * would change what hand-built Reply literals, which the handler types
 * accept, mean at runtime; the shapes are reserved instead.)
 *
 * @param out - The handler's resolved result.
 * @returns The Reply.
 */
export function asReply(out: unknown): Reply<unknown> {
	if (out !== null && typeof out === 'object' && !Array.isArray(out)) {
		const keys = Object.keys(out).sort().join(',');
		const reply = out as { ok?: unknown; value?: unknown };
		if (reply.ok === true && keys === 'ok,value') return replyOk(reply.value);
		if (reply.ok === false && keys === 'error,ok' && isReply(out)) return out as Reply<unknown>;
	}
	return replyOk(out);
}

/**
 * A short description of an unexpected value (never its content).
 *
 * @param value - The value.
 * @returns Its type.
 */
function describe(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	return typeof value === 'object' ? 'an object without a valid ok/value/error shape' : typeof value;
}
