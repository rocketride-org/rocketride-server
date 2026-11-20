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
// EXPLORER RUNNER — TYPES (what a batch of statements is made of)
// =============================================================================
//
// The runner's honesty rules come from how the platform actually executes a
// tool call, and they are the same for every Explorer:
//
//   1. ONE STATEMENT PER CALL. A buffer is split client-side and sent
//      statement by statement. A batch that fails on statement 3 leaves 1 and 2
//      done and 4 onward not run; the UI says that, and says nothing about
//      atomicity it cannot honour.
//   2. THERE IS NO CANCEL. "Stop waiting" bumps a generation so the late answer
//      is dropped, and the statement is marked abandoned: it MAY still be
//      running remotely.
//   3. A STATEMENT THAT FAILS ENDS THE BATCH; the rest are `skipped`.
//
// Everything language-specific (what a statement is, how it is classified,
// what a row limit means, what a failure says) is a hook the app supplies.
// =============================================================================

/**
 * How one statement of a batch ended.
 *
 * - `pending`   — queued, not started.
 * - `running`   — sent, no answer yet.
 * - `rows`      — returned a result set.
 * - `affected`  — reported an affected-row count.
 * - `error`     — the node or the database rejected it.
 * - `abandoned` — the user stopped waiting; it MAY still be running remotely.
 * - `skipped`   — an earlier statement failed (or the user declined), so it was never sent.
 */
export type RunOutcome = 'pending' | 'running' | 'rows' | 'affected' | 'error' | 'abandoned' | 'skipped';

/** One statement to send. Positions are optional: a history rerun has no place in the editor. */
export interface IRunTarget {
	/** The statement text. */
	text: string;
	/** Start offset in the editor buffer, when it has one. */
	start?: number;
	/** End offset in the editor buffer, when it has one. */
	end?: number;
	/** One-based first line, when it has one. */
	startLine?: number;
	/** One-based last line, when it has one. */
	endLine?: number;
}

/**
 * The part of a run the runner and its strip need. An app's own run type
 * extends it with the statement text under whatever name it persists
 * (`sql`, `cypher`) and its own result fields.
 */
export interface IStatementRunBase {
	/** Zero-based position in the batch. */
	index: number;
	/** What the statement is, by pattern (the vocabulary belongs to the app; `read` is the one the wording keys on). */
	kind: string;
	/** Leading keyword, for the strip label. */
	verb: string;
	/** Start offset in the editor buffer, when the statement came from one. */
	start?: number;
	/** End offset in the editor buffer, when the statement came from one. */
	end?: number;
	/** One-based first line in the editor buffer; absent for a statement that did not come from the editor. */
	startLine?: number;
	/** One-based last line in the editor buffer; absent with {@link IStatementRunBase.startLine}. */
	endLine?: number;
	/** Current outcome. */
	outcome: RunOutcome;
	/** How many rows came back, for the strip label (set when the outcome is `rows`). */
	rowCount?: number;
	/** Affected-row count, when the outcome is `affected`. */
	affected?: number;
	/** Round-trip milliseconds, once an answer (or an abandonment) landed. */
	ms?: number;
	/** Verbatim failure text, when the outcome is `error`. */
	error?: string;
	/** The row limit that was sent with this statement, or null when none was. */
	limitApplied?: number | null;
	/** How the row limit came about (the app's vocabulary). */
	limitState?: string;
}

/** What a text pattern check saw; the sentence is `Pattern check: <kind> detected.` */
export interface IPatternFinding {
	/** The shape detected, e.g. `DELETE without WHERE`. */
	kind: string;
}

/** The user's answer to a pattern-check confirmation. */
export type PatternAnswer = 'run' | 'always' | 'cancel';

/** What a failed statement means and what to show for it. */
export interface IFailureNotice {
	/** Banner headline. */
	headline: string;
	/** The full message, shown verbatim in the collapsible block. */
	verbatim: string;
	/** True when the node returned its generic placeholder instead of real text. */
	generic: boolean;
}

/** A failed statement, and where in the batch it was. */
export interface IFailureState<TNotice extends IFailureNotice = IFailureNotice> {
	/** What the failure means and what to show. */
	notice: TNotice;
	/** Zero-based index of the statement that failed. */
	index: number;
	/** Line range of the failing statement; '' when it has no editor position. */
	lines: string;
	/** What is true of everything before the failure ('' when it failed first). */
	prior: string;
}
