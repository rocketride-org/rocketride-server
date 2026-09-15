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
// SQL — BATCH RUN MODEL (per-statement outcomes and their wording)
// =============================================================================
//
// Running N statements produces N outcomes, and the node runs each one in its
// OWN transaction (db_instance_base's plain execute wraps a single
// `engine.begin()`), so a batch that fails on statement 3 leaves 1 and 2
// COMMITTED and 4 onward not run. That is the single most important thing the
// UI has to say out loud, so the wording for it lives here, next to the data,
// and is unit-tested rather than assembled inline in a component.
//
// Elapsed time is always called ROUND TRIP: it measures the tool call leaving
// the browser and coming back, which includes queueing and transport. It is
// not the database's execution time and must never be labelled as such.
// =============================================================================

import type { SqlDialect } from '../connect';
import type { StatementKind } from './classify';
import { CTE_WRITE_WORDS } from './classify';
import { hasTopLevelKeyword, keywordSites, stripSqlComments } from './split';

// =============================================================================
// TYPES
// =============================================================================

/**
 * How one statement of a batch ended.
 *
 * - `pending` — queued, not started.
 * - `running` — sent, no answer yet.
 * - `rows` — returned a result set.
 * - `affected` — reported an affected-row count.
 * - `error` — the node or the database rejected it.
 * - `abandoned` — the user stopped waiting; it MAY still be running remotely.
 * - `skipped` — an earlier statement failed, so this one was never sent.
 */
export type RunOutcome = 'pending' | 'running' | 'rows' | 'affected' | 'error' | 'abandoned' | 'skipped';

/** One statement of a batch, with whatever is known about it so far. */
export interface IStatementRun {
	/** Zero-based position in the batch. */
	index: number;
	/** The statement as sent (before the row limit is appended). */
	sql: string;
	/** Statement kind, by pattern. */
	kind: StatementKind;
	/** Leading keyword, for the strip label. */
	verb: string;
	/** Start offset in the editor buffer, when the statement came from one. */
	start?: number;
	/** End offset in the editor buffer, when the statement came from one. */
	end?: number;
	/**
	 * One-based first line in the editor buffer. ABSENT for a statement that
	 * did not come from the editor — a history rerun has no position, and
	 * inventing line 1 would decorate and name unrelated text.
	 */
	startLine?: number;
	/** One-based last line in the editor buffer; absent with {@link startLine}. */
	endLine?: number;
	/** Current outcome. */
	outcome: RunOutcome;
	/** Returned rows, when the outcome is `rows`. */
	rows?: Record<string, unknown>[];
	/** Affected-row count, when the outcome is `affected`. */
	affected?: number;
	/** Round-trip milliseconds, once an answer (or an abandonment) landed. */
	ms?: number;
	/** Verbatim failure text, when the outcome is `error`. */
	error?: string;
	/** Row limit appended to this statement, or null when none was. */
	limitApplied?: number | null;
	/** How the row limit came about — decides which meta wording applies. */
	limitState?: LimitState;
}

// =============================================================================
// WHAT IS AT THE DATABASE
// =============================================================================

/**
 * Whether one of these statements is AT THE DATABASE right now.
 *
 * NOT the same question as "is the batch running". The batch is running from
 * the moment Run is pressed, which includes the time a pattern-check dialog
 * sits open with nothing yet sent; only a run whose outcome is `running` has
 * been handed to `session.execute` and is waiting on an answer.
 *
 * The "Stop waiting" affordance keys on THIS, because what it says when it is
 * used — that the database may still be running the statement and cannot be
 * told to stop — is only true of a request that was actually made.
 *
 * @param runs - The batch's statements, in order.
 * @returns True when one of them has been sent and has not answered yet.
 */
export function hasStatementInFlight(runs: IStatementRun[]): boolean {
	return runs.some((run) => run.outcome === 'running');
}

// =============================================================================
// WORDING
// =============================================================================

/**
 * The leading keyword of a statement, for the status strip's label.
 *
 * @param sql - The statement text.
 * @param dialect - The engine dialect (comment syntax).
 * @returns The keyword in upper case, or 'SQL' when there is none.
 */
export function leadingVerb(sql: string, dialect: SqlDialect = 'unknown'): string {
	const match = /[A-Za-z_][A-Za-z0-9_]*/.exec(stripSqlComments(sql, dialect).replace(/^[\s(]+/, ''));
	return match ? match[0].toUpperCase() : 'SQL';
}

/**
 * Format a round-trip duration.
 *
 * @param ms - Milliseconds measured in the browser.
 * @returns e.g. `round trip 0.031 s`.
 */
export function formatElapsed(ms: number): string {
	return `round trip ${(ms / 1000).toFixed(3)} s`;
}

/** The words a batch position can be described with. */
type OutcomeGroup = 'ran' | 'committed' | 'failed' | 'not run' | 'abandoned';

/**
 * Which word describes a finished statement.
 *
 * A read `ran`; anything else `committed`. The distinction matters because
 * "committed" is the app's way of saying the change is already durable and
 * cannot be undone from here — saying it about a SELECT dilutes the one word
 * that has to carry that weight. Anything not clearly read-only is called
 * committed, which is the safe direction.
 *
 * @param run - The statement.
 * @returns The group, or null for a statement that has not resolved.
 */
function groupOf(run: IStatementRun): OutcomeGroup | null {
	if (run.outcome === 'rows' || run.outcome === 'affected') return run.kind === 'read' ? 'ran' : 'committed';
	if (run.outcome === 'error') return 'failed';
	if (run.outcome === 'abandoned') return 'abandoned';
	if (run.outcome === 'skipped' || run.outcome === 'pending') return 'not run';
	return null;
}

/**
 * Summarise a finished batch in one line, e.g.
 * `1 ran · 2 committed · 3 failed · 4–5 not run`.
 *
 * Positions are one-based and consecutive positions in the same group collapse
 * into a range. A statement still running contributes nothing, so the line is
 * only complete once the batch is.
 *
 * @param runs - The batch's statements, in order.
 * @returns The summary line ('' when there is nothing to say).
 */
export function formatBatchOutcome(runs: IStatementRun[]): string {
	const parts: string[] = [];
	let groupStart = -1;
	let groupName: OutcomeGroup | null = null;

	/**
	 * Close the open range and push its phrase.
	 *
	 * @param endIndex - One-based position of the range's last statement.
	 */
	const flush = (endIndex: number): void => {
		if (groupName === null || groupStart < 0) return;
		const span = groupStart === endIndex ? `${groupStart}` : `${groupStart}–${endIndex}`;
		parts.push(`${span} ${groupName}`);
	};

	for (let i = 0; i < runs.length; i++) {
		const group = groupOf(runs[i]);
		if (group === groupName) continue;
		flush(i);
		groupName = group;
		groupStart = group === null ? -1 : i + 1;
	}
	flush(runs.length);
	return parts.join(' · ');
}

/**
 * What the failure banner says about the statements BEFORE the one that
 * failed — the sentence that has to stop a reader assuming a failed batch
 * rolled back.
 *
 * @param runs - The batch, in order.
 * @param failedIndex - Zero-based index of the statement that failed.
 * @returns The sentence, or '' when nothing ran before the failure.
 */
export function formatPriorStatements(runs: IStatementRun[], failedIndex: number): string {
	const prior = runs.slice(0, Math.max(0, failedIndex));
	if (prior.length === 0) return '';
	const span = prior.length === 1 ? 'Statement 1' : `Statements 1\u2013${prior.length}`;
	// One write or DDL before the failure is enough: something is durable.
	const changed = prior.some((run) => run.kind !== 'read');
	return changed
		? `${span} already committed (each statement runs in its own autocommit transaction).`
		: `${span} already ran.`;
}

/**
 * The status strip's label for one statement, e.g.
 * `2 UPDATE · 3 affected · round trip 0.012 s`.
 *
 * The full text is in the label rather than carried by colour, so the strip's
 * buttons have complete accessible names.
 *
 * @param run - The statement.
 * @returns The label.
 */
export function formatRunLabel(run: IStatementRun): string {
	const head = `${run.index + 1} ${run.verb}`;
	const elapsed = run.ms === undefined ? '' : ` · ${formatElapsed(run.ms)}`;
	switch (run.outcome) {
		case 'rows':
			return `${head} · ${(run.rows?.length ?? 0).toLocaleString()} rows${elapsed}`;
		case 'affected':
			return `${head} · ${(run.affected ?? 0).toLocaleString()} affected${elapsed}`;
		case 'error':
			return `${head} · error${elapsed}`;
		case 'abandoned':
			return `${head} · abandoned${elapsed}`;
		case 'running':
			return `${head} · running…`;
		case 'skipped':
			return `${head} · not run`;
		default:
			return `${head} · queued`;
	}
}

// =============================================================================
// ROW LIMIT
// =============================================================================

/**
 * Row-returning statements: SELECT, a parenthesised set expression, and
 * read-only WITH chains. A data-modifying CTE (`WITH ... INSERT/UPDATE/DELETE`)
 * is NOT one — appending LIMIT there is invalid SQL. Whether a chain modifies
 * is decided on code, by {@link CTE_WRITE_WORDS}, exactly as the statement's
 * kind is.
 */
const RETURNS_ROWS = /^select\b/i;

/**
 * How a result's row limit came about.
 *
 * - `applied` — the app appended the header's limit.
 * - `in-statement` — the statement carried its own LIMIT, so the app added
 *   none and the row count is the STATEMENT's bound, not the table's size.
 * - `none` — no limit is in play at all.
 */
export type LimitState = 'applied' | 'in-statement' | 'none';

/**
 * Append the header's row limit to a statement that returns rows.
 *
 * A statement that already carries its own LIMIT is left alone: the user's
 * limit governs, and the meta line reports that none was applied by the app.
 * Nothing is appended to writes, DDL, SHOW, EXPLAIN or DESCRIBE, where the
 * clause is either invalid or silently changes what the statement does.
 *
 * @param sql - The statement.
 * @param limit - The header selection ('200', '1000' or 'All').
 * @param dialect - The engine dialect (comment syntax).
 * @returns The statement to send and the limit that was appended (null when
 *          none was).
 */
export function applyRowLimit(sql: string, limit: string, dialect: SqlDialect = 'unknown'): { sql: string; limit: number | null; state: LimitState } {
	const stripped = stripSqlComments(sql, dialect).replace(/;\s*$/, '').trim();
	const bare = stripped.replace(/^[\s(]+/, '');
	// The WITH test reads the same masked text and the same word list as
	// `classifyStatement`, so the two cannot disagree about whether a chain
	// writes: a `delete` inside a literal or a quoted identifier is not a
	// mutation, and such a chain gets the header's limit like any other read.
	const returnsRows = RETURNS_ROWS.test(bare)
		|| stripped.startsWith('(')
		|| (/^with\b/i.test(bare) && keywordSites(bare, CTE_WRITE_WORDS, dialect).length === 0);
	// Checked BEFORE the header selection, so `All` on a statement that limits
	// itself still reports the statement's limit instead of claiming none.
	// Only a LIMIT that bounds the OUTERMOST query counts: one inside a
	// subquery bounds that subquery, and reporting it as the result's bound
	// would let an unbounded outer SELECT stream every row into the browser
	// under a meta line that says otherwise.
	if (returnsRows && hasTopLevelKeyword(sql, 'limit', dialect)) return { sql, limit: null, state: 'in-statement' };
	if (limit === 'All' || !returnsRows) return { sql, limit: null, state: 'none' };
	const value = Number(limit);
	if (!Number.isFinite(value) || value <= 0) return { sql, limit: null, state: 'none' };
	// The clause is joined with a NEWLINE, not a space: the checks above run on
	// comment-stripped text but the statement is sent RAW, so appending after a
	// trailing `-- ...` comment would put LIMIT inside that comment and send an
	// unbounded SELECT while the meta line reported a limit.
	return { sql: `${sql.replace(/;\s*$/, '').trimEnd()}\nLIMIT ${value}`, limit: value, state: 'applied' };
}
