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
// GRAPH - FAILURE NOTICES (what the banner says for each way a call can fail)
// =============================================================================
//
// The shared tool session turns every failure into one error with a `kind`; this
// module decides what the user reads. The banner leads with the first line of the
// node's message (the headline) and shows the rest under "Database said", exactly
// as SQL Explorer does, and adds ONE hint where the app knows what to do next.
//
//   Refused: ...                 a safety rule or the database refused the
//                                statement (graph_errors.py). Only the WRITE
//                                refusals ("this statement writes", "the database
//                                refused a write") point at the write console,
//                                which exists only where the node allows execute.
//                                The others (the first-row budget, AGE's resource
//                                rules, USE, SHOW, LOAD CSV, a procedure off the
//                                allowlist, a missing privilege) get no hint: the
//                                node's second line under "Database said" is the
//                                remedy, and the write console is not.
//   Not supported on Apache AGE  an AGE limit the node explains; its own text is
//                                the hint.
//   timeout                      this app stopped waiting; the database may still
//                                be running the query and nothing here can cancel it.
//   upgrade                      the node lacks read_query (or the tool): never
//                                a fallback to another tool.
//   malformed                    the node answered in a shape this app does not
//                                understand.
//   stale                        dropped: a newer request replaced this one, and the
//                                user never sees it.
// =============================================================================

import type { IFailureNotice as ISharedFailureNotice } from 'shared/explorer';
import { CONTROLLER_NOT_READY_TEXT, GRID_NOTICE, STOP_WAITING_NOTE, upgradeText } from './wording';

/** What the shared tool session threw, reduced to what this module reads. */
export interface IFailureInput {
	kind: string;
	tool: string;
	/** The full message, verbatim. */
	message: string;
	/** First line of the message. */
	headline: string;
	/** Everything after the first line. */
	detail?: string;
	code?: string;
}

/**
 * A failure as the banner shows it. It extends the shared notice (`headline`, the
 * verbatim "Database said" text, and whether the node withheld its text) with
 * what only Graph Explorer knows: a variant, one hint, and whether to drop it.
 */
export interface IFailureNotice extends ISharedFailureNotice {
	/** `error` for a failure, `warning` for one that is not a bug, `info` for a notice. */
	variant: 'error' | 'warning' | 'info';
	/** The node's text under "Database said"; the same text as `verbatim`. */
	detail: string;
	/** One sentence on what to do next, or null. */
	hint: string | null;
	/** True when the result of this call must not be shown at all. */
	ignore: boolean;
}

/** The label above the node's own text. */
export const DATABASE_SAID_LABEL = 'Database said';

/** The legacy refusal text of a node that has `execute` off (a plain error, no code). */
const LEGACY_EXECUTE_OFF = /execute tool is disabled for this node/i;

/** The node's refusals that mean the statement writes: the only ones the write console is the remedy for. */
const WRITE_REFUSAL = /^Refused: (read_query is read-only; this statement writes|the database refused a write)\b/i;

/** The engine's text when it does not know a tool; the tool name follows. */
const UNKNOWN_TOOL = /no handler found for tool\s+['"]?([A-Za-z0-9_.]+)/i;

/** The session's own text when a node does not advertise a tool; the tool name follows. */
const NOT_ADVERTISED = /This node cannot run ([A-Za-z0-9_.]+): it does not advertise/;

/**
 * The tool a failure is about: the thrown error's own field, else the name in the fixed wording.
 *
 * @param error - The failure.
 * @returns The tool name, or '' when it cannot be told.
 */
function toolOf(error: IFailureInput): string {
	return error.tool || UNKNOWN_TOOL.exec(error.message)?.[1] || NOT_ADVERTISED.exec(error.message)?.[1] || '';
}

/**
 * Describe a failed call for the banner.
 *
 * @param error - The failure.
 * @param canWrite - Whether this endpoint shows a write console (execute allowed).
 * @returns The notice.
 */
export function describeFailure(error: IFailureInput, canWrite: boolean): IFailureNotice {
	const notice = describeKind(error, canWrite);
	return { ...notice, verbatim: notice.detail, generic: false };
}

/**
 * The notice before the shared fields are filled in.
 *
 * @param error - The failure.
 * @param canWrite - Whether this endpoint shows a write console.
 * @returns The notice without `verbatim` and `generic`.
 */
function describeKind(error: IFailureInput, canWrite: boolean): Omit<IFailureNotice, 'verbatim' | 'generic'> {
	if (error.kind === 'stale') return { variant: 'info', headline: '', detail: '', hint: null, ignore: true };
	const base = { detail: error.detail ?? '', ignore: false };

	if (error.kind === 'upgrade' || UNKNOWN_TOOL.test(error.message)) return { variant: 'warning', headline: upgradeText(toolOf(error)), detail: '', hint: null, ignore: false };
	if (LEGACY_EXECUTE_OFF.test(error.message)) {
		return { ...base, variant: 'error', headline: 'This node does not allow execute (allow_execute is off).', detail: '', hint: 'Browsing with Cypher works. Statements that change data need a node with direct execution turned on.' };
	}
	if (error.kind === 'timeout') return { ...base, variant: 'warning', headline: error.headline, detail: error.detail ?? '', hint: STOP_WAITING_NOTE };
	// A dev-tool document whose call no controller took: the headline says to open the sidebar, and the pipeline is not
	// the problem, so no pipeline hint.
	if (error.kind === 'unavailable') return { ...base, variant: 'error', headline: error.headline, hint: error.headline === CONTROLLER_NOT_READY_TEXT ? null : 'Start the pipeline, then refresh the connections.' };
	if (error.kind === 'malformed') return { ...base, variant: 'error', headline: error.headline, hint: 'The node answered in a shape this app does not understand. It may need an upgrade.' };
	if (error.kind === 'invalid') return { ...base, variant: 'error', headline: error.headline, hint: null };

	if (WRITE_REFUSAL.test(error.headline)) {
		return { ...base, variant: 'error', headline: error.headline, hint: canWrite ? 'To change data, use the write console for this connection.' : 'Browsing is read-only. To change data, use a node with direct execution turned on.' };
	}
	if (/^Refused:/i.test(error.headline)) return { ...base, variant: 'error', headline: error.headline, hint: null };
	if (/^Not supported on Apache AGE/i.test(error.headline)) return { ...base, variant: 'error', headline: error.headline, hint: 'Apache AGE 1.5.0 does not support this Cypher construct; rewrite the query without it.' };
	if (/^Query timed out/i.test(error.headline)) return { ...base, variant: 'warning', headline: error.headline, hint: 'The node stopped the query. Narrow it, or lower the row limit.' };
	if (/^Invalid read_query input/i.test(error.headline)) return { ...base, variant: 'error', headline: error.headline, hint: null };
	return { ...base, variant: 'error', headline: error.headline || error.message, hint: null };
}

/** Messages the shared session writes itself, by the kind they stand for. */
const SESSION_MESSAGES: ReadonlyArray<readonly [string, RegExp]> = [
	['timeout', /^Stopped waiting for \S+ after \d+ s\./],
	['upgrade', /^This node cannot run \S+: it does not advertise/],
	['unavailable', /^No running task for pipeline /],
	['malformed', /returned a malformed result|needs an object for its input/],
];

/**
 * Describe a failure from its verbatim message alone. The shared statement runner
 * hands `describeFailure` the message, not the error, so the kinds the session
 * writes itself are recognised by their fixed wording; anything else is the
 * node's own text (a refusal, an AGE hint, a database error) and is read as such.
 *
 * @param message - The error message.
 * @param canWrite - Whether this endpoint shows a write console.
 * @returns The notice.
 */
export function describeFailureMessage(message: string, canWrite: boolean): IFailureNotice {
	const at = message.indexOf('\n');
	const kind = SESSION_MESSAGES.find(([, pattern]) => pattern.test(message))?.[0] ?? 'raised';
	return describeFailure({ kind, tool: '', message, headline: (at === -1 ? message : message.slice(0, at)).trim(), ...(at === -1 ? {} : { detail: message.slice(at + 1).trim() }) }, canWrite);
}

/**
 * Describe a failure from whatever the shared runner hands over: the message and,
 * when the session threw one, the original error (an ExplorerToolError carries its
 * `kind`, `headline` and `detail`, so nothing has to be guessed from wording).
 *
 * @param message - The error message.
 * @param error - The thrown value, when known.
 * @param canWrite - Whether this endpoint shows a write console.
 * @returns The notice.
 */
export function describeFailureOf(message: string, error: unknown, canWrite: boolean): IFailureNotice {
	if (error !== null && typeof error === 'object' && typeof (error as { kind?: unknown }).kind === 'string' && typeof (error as { headline?: unknown }).headline === 'string') {
		const e = error as { kind: string; tool?: string; message?: string; headline: string; detail?: string; code?: string };
		return describeFailure({ kind: e.kind, tool: e.tool ?? '', message: e.message ?? message, headline: e.headline, ...(e.detail !== undefined ? { detail: e.detail } : {}), ...(e.code !== undefined ? { code: e.code } : {}) }, canWrite);
	}
	return describeFailureMessage(message, canWrite);
}

// =============================================================================
// WRITES (the write console)
// =============================================================================
//
// `execute` runs the statement BEFORE the node builds its answer: Apache AGE commits
// first, FalkorDB's query returns only after the write ran, and Neo4j streams a
// short result to completion. So a failure that arrives after the call was sent
// (the answer could not be built, this app rejected it, it took too long, or the
// user stopped waiting) does not mean nothing changed. Only a refusal raised
// before anything reached the database means that.

/** Said under a write-console failure that can have come after the statement ran. */
export const WRITE_MAY_HAVE_APPLIED = 'The write may have been applied: this error can come after the database ran the statement, and nothing is rolled back. Check the data before running it again. Graphs drawn from this connection are marked out of date.';

/**
 * The kind of a failure: the thrown error's own `kind`, else the one the session's fixed wording stands for.
 *
 * @param error - What was thrown, or the message alone.
 * @returns The kind ('raised' when nothing else is known).
 */
function kindOf(error: unknown): string {
	if (error !== null && typeof error === 'object' && typeof (error as { kind?: unknown }).kind === 'string') return (error as { kind: string }).kind;
	const message = messageOf(error);
	return SESSION_MESSAGES.find(([, pattern]) => pattern.test(message))?.[0] ?? 'raised';
}

/**
 * The message of a failure.
 *
 * @param error - What was thrown, or the message alone.
 * @returns The text.
 */
function messageOf(error: unknown): string {
	if (typeof error === 'string') return error;
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
	return String(error);
}

/**
 * Whether a failed `execute` can have changed data: everything except a refusal raised before anything was sent (the
 * node does not advertise the tool, there is no running task, or the node has execute turned off).
 *
 * @param error - What the call threw (or its message).
 * @returns True when the statement may have run on the database.
 */
export function writeMayHaveApplied(error: unknown): boolean {
	const kind = kindOf(error);
	if (kind === 'upgrade' || kind === 'unavailable') return false;
	return !LEGACY_EXECUTE_OFF.test(messageOf(error));
}

/**
 * Describe a failure of the write console: as {@link describeFailureOf}, except that a failure that can have come after
 * the statement ran says so instead of the browse hints (there is no other console to point at).
 *
 * @param message - The error message.
 * @param error - The thrown value, when known.
 * @returns The notice.
 */
export function describeWriteFailure(message: string, error: unknown): IFailureNotice {
	const notice = describeFailureOf(message, error, true);
	if (notice.ignore || !writeMayHaveApplied(error ?? message)) return notice;
	return { ...notice, hint: WRITE_MAY_HAVE_APPLIED };
}

/** Re-exported so the canvas notice and the failure strip share one place for their wording. */
export { GRID_NOTICE };
