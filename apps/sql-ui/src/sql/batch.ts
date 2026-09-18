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
import { codeOnly, keywordSites, stripSqlComments } from './split';

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
 * The head of a locking clause — the part that identifies it as one.
 *
 * PostgreSQL spells it `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` or
 * `FOR KEY SHARE`; MySQL 8.0 adds the older `LOCK IN SHARE MODE`. Matching
 * the bare keyword would be wrong in both directions: `LOCK` is NON-RESERVED
 * in PostgreSQL, so `SELECT * FROM lock` is an ordinary unbounded read that
 * must still be bounded, and `FOR` alone would also catch a `FOR SYSTEM_TIME`
 * that sits in the middle of a statement.
 */
const LOCKING_CLAUSE_HEAD = /^(?:for\s+(?:no\s+key\s+update|key\s+share|update|share)|lock\s+in\s+share\s+mode)(?![\w$])/i;

/**
 * What may FOLLOW that head and still leave the clause LAST: its optional
 * `OF table[, ...]` list, `NOWAIT`, `SKIP LOCKED`, a second locking clause, a
 * trailing `;`, and the whitespace a masked comment leaves behind. Anything
 * else — a parenthesis, an operator, a comparison — means the statement goes
 * on, so the match was not the trailing clause.
 */
const LOCKING_CLAUSE_TAIL = /^[\w$.,;\s]*$/;

/**
 * A limit clause of the user's own in that tail. PostgreSQL also accepts
 * `... FOR UPDATE OFFSET 5`, where the statement ENDS in its own limit clause
 * rather than in the lock; inserting a `LIMIT` before the locking clause there
 * would produce `LIMIT 200 FOR UPDATE OFFSET 5`, which does not parse. Such a
 * statement keeps the plain append at the end, which is where that grammar
 * accepts it — and which is what the app did before the clause was recognised
 * at all.
 */
const LOCKING_CLAUSE_LIMIT_TAIL = /\b(?:offset|fetch)\b/i;

/**
 * Where the statement's trailing locking clause begins, or -1 when it has none.
 *
 * Read on MASKED text, so a `for update` inside a string literal, a comment or
 * a quoted identifier is not one, and at parenthesis depth 0 only, so a
 * locking clause inside a subquery is not the outer statement's last clause.
 * {@link codeOnly} preserves offsets, so the returned index points at the same
 * character in the statement itself. Sites come back in statement order, so
 * two stacked clauses (`FOR UPDATE OF a FOR SHARE OF b`) report the first —
 * the point the whole locking block starts at.
 *
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @returns The index the clause starts at, or -1 when none closes the
 *          statement.
 */
function trailingLockingClauseAt(sql: string, dialect: SqlDialect): number {
	const masked = codeOnly(sql, dialect);
	for (const site of keywordSites(sql, ['for', 'lock'], dialect)) {
		if (site.depth !== 0) continue;
		const rest = masked.slice(site.index);
		const head = LOCKING_CLAUSE_HEAD.exec(rest);
		if (head === null) continue;
		const tail = rest.slice(head[0].length);
		if (!LOCKING_CLAUSE_TAIL.test(tail) || LOCKING_CLAUSE_LIMIT_TAIL.test(tail)) continue;
		return site.index;
	}
	return -1;
}

/**
 * Whether inserting the limit at `lockingAt` would split a `#` line comment.
 *
 * `#` introduces a line comment in MySQL only, so {@link codeOnly} masks it
 * for that dialect alone. On every other dialect — `unknown` included, which
 * is where the app lands when the dialect probe fails — `SELECT * FROM t # for
 * update` reads as a statement whose last clause is a lock, and splicing the
 * limit in front of that clause would move `for update` onto a line of its
 * own, OUT of the comment the user wrote it in. Sent to the MySQL server that
 * `#` implies, the statement would then take row locks the user had commented
 * out — the one way this rewrite can change what a statement DOES.
 *
 * The test is deliberately blunt: any unmasked `#` between the start of the
 * clause's line and the clause itself sends the statement untouched with
 * `none`, the same path a statement the app cannot bound already takes. The
 * cost is that a PostgreSQL statement using `#` as an operator on the clause's
 * line (`SELECT a # b FROM t FOR UPDATE`) loses its limit and reports `no
 * limit applied` — an honest unbounded read rather than a rewritten statement.
 *
 * @param sql - The statement.
 * @param lockingAt - Index the trailing locking clause starts at.
 * @param dialect - The engine dialect.
 * @returns True when the limit must not be inserted there.
 */
function hashCommentPrecedesClause(sql: string, lockingAt: number, dialect: SqlDialect): boolean {
	if (dialect === 'mysql') return false;
	const masked = codeOnly(sql, dialect);
	return masked.slice(masked.lastIndexOf('\n', lockingAt) + 1, lockingAt).includes('#');
}

/**
 * The head of the SQL standard's own spelling of a row limit: `FETCH FIRST n
 * { ROW | ROWS } ONLY` or `FETCH NEXT n { ROW | ROWS } ONLY`, `ROW`/`ROWS`
 * interchangeable, `WITH TIES` allowed in place of `ONLY`, and `n` itself
 * optional (it defaults to 1). Only `first`/`next` need matching here — the
 * rest of the clause does not change whether one is present — anchored the
 * same way {@link LOCKING_CLAUSE_HEAD} is, against the text starting at a
 * `fetch` site rather than the bare keyword, so this is a test of what
 * FOLLOWS `fetch`, not of the keyword alone.
 */
const FETCH_LIMIT_HEAD = /^fetch\s+(?:first|next)(?![\w$])/i;

/**
 * Where the statement's own outermost row-limit clause starts — `LIMIT` or
 * the SQL standard's `FETCH { FIRST | NEXT } ... ONLY` — or -1 when it has
 * none. Either spelling shares `LIMIT`'s grammar slot, so a statement bounded
 * by one must never also receive the header's `LIMIT`: PostgreSQL's
 * `select_limit` admits at most one limit clause, however it is spelled, and
 * MySQL does not accept the `FETCH` spelling at all.
 *
 * {@link keywordSites} finds every `limit`/`fetch` in CODE (masked, so a
 * comment, a string literal or a quoted identifier cannot forge one) and
 * reports each one's parenthesis depth; only depth 0 counts, so a clause
 * inside a subquery, a CTE body or a parenthesised set-query member bounds
 * that member, not the outer statement, and must not be read as the result's
 * bound. A `limit` site is a clause on sight; a `fetch` site still needs
 * {@link FETCH_LIMIT_HEAD} to run on {@link codeOnly} text sliced at the
 * site's index — offsets are preserved, so that slice reads the same
 * characters the original statement has there — which is what keeps an
 * ordinary identifier like `fetch_count` or `prefetch` from matching: the
 * identifier-boundary check already lives inside {@link keywordSites}, so
 * this function does not repeat it.
 *
 * The index is what lets the caller run {@link hashCommentPrecedesClause} on
 * it: CodeRabbit review 5253101335 (thread r4051099532) noted that on
 * `dialect: 'unknown'` — where the app lands when the dialect probe fails,
 * and a MySQL server is a live possibility behind that failure — an unmasked
 * `#` on the same line as the clause makes it ambiguous exactly the way it
 * already makes a trailing locking clause ambiguous: on MySQL that text is a
 * comment and the SELECT runs unbounded, so reporting `in-statement` would
 * claim a bound that does not exist. The two clause spellings get the same
 * ruling here for the same reason `hashCommentPrecedesClause` already gives
 * it to the locking-clause case, and the guard returns before the append
 * path, so the SQL sent is never changed by it — only the meta line is, from
 * `in-statement` to `none`.
 *
 * This does NOT, on its own, tell a `FETCH` limit clause from a cursor's
 * `FETCH NEXT FROM <cursor>` statement — that also matches
 * `fetch\s+(?:first|next)` literally. It is the caller's `returnsRows` gate
 * that keeps this function from ever being asked about one: a bare cursor
 * `FETCH` statement does not start with `SELECT`, a `(`, or a read-only
 * `WITH`, so {@link RETURNS_ROWS} (and the checks beside it) already excludes
 * it before this runs.
 *
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @returns The clause's start index, or -1 when none is present.
 */
function inStatementLimitAt(sql: string, dialect: SqlDialect): number {
	const masked = codeOnly(sql, dialect);
	for (const site of keywordSites(sql, ['limit', 'fetch'], dialect)) {
		if (site.depth !== 0) continue;
		if (site.keyword === 'limit' || FETCH_LIMIT_HEAD.test(masked.slice(site.index))) return site.index;
	}
	return -1;
}

/**
 * How a result's row limit came about.
 *
 * - `applied` — the app added the header's limit: appended at the end, or
 *   inserted before a trailing locking clause.
 * - `in-statement` — the statement carried its own LIMIT, so the app added
 *   none and the row count is the STATEMENT's bound, not the table's size.
 * - `none` — no limit is in play at all.
 */
export type LimitState = 'applied' | 'in-statement' | 'none';

/**
 * Add the header's row limit to a statement that returns rows.
 *
 * The limit is APPENDED at the end, except on a statement whose last clause is
 * a lock, where it is INSERTED before that clause — the one placement both
 * MySQL and PostgreSQL accept.
 *
 * A statement that already carries its own LIMIT is left alone: the user's
 * limit governs, and the meta line reports that none was applied by the app.
 * Nothing is added to writes, DDL, SHOW, EXPLAIN or DESCRIBE, where the clause
 * is either invalid or silently changes what the statement does.
 *
 * @param sql - The statement.
 * @param limit - The header selection ('200', '1000' or 'All').
 * @param dialect - The engine dialect (comment syntax).
 * @returns The statement to send and the limit that was added (null when none
 *          was).
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
	// itself still reports the statement's limit instead of claiming none. Two
	// spellings count: `LIMIT n` and the SQL standard's `FETCH { FIRST | NEXT }
	// n { ROW | ROWS } { ONLY | WITH TIES }` — the same limit_clause production,
	// and PostgreSQL rejects a statement that carries both. Either way, only a
	// clause that bounds the OUTERMOST query counts: one inside a subquery, a
	// CTE body or a parenthesised set member bounds that member, and reporting
	// it as the result's bound would let an unbounded outer SELECT stream every
	// row into the browser under a meta line that says otherwise (`inStatementLimitAt`
	// reads depth off `keywordSites` for exactly this reason). A statement
	// bounded either way is always left untouched, never treated as an app cap:
	// `WITH TIES` can return MORE rows than the number named, which the header's
	// numeric limit could never express, so the honest report is `in-statement`
	// ("limit in statement"), not a row count the app claims to have enforced.
	// This is also why `FETCH ... ONLY` cannot be read with a plain top-level
	// keyword search: `LIMIT` is the only keyword that spells a row limit on
	// its own, but a bare `fetch` is not — it must be followed by `FIRST`/
	// `NEXT` to be one, which is what `FETCH_LIMIT_HEAD` tests for, and
	// `inStatementLimitAt` runs it. Neither that function nor this one needs to
	// rule out a cursor's `FETCH NEXT FROM <cursor>`: that statement does not
	// reach here at all, because it fails `returnsRows` above (it is not a
	// SELECT, a parenthesised set expression, or a read-only WITH chain) — the
	// same reason it never reached the old LIMIT-only check either.
	const ownLimitAt = returnsRows ? inStatementLimitAt(sql, dialect) : -1;
	if (ownLimitAt >= 0) {
		// Unless the clause sits behind an unmasked `#` on ITS OWN line, where —
		// same ruling as the locking-clause guard just below — the text may be a
		// comment on a dialect that does not mask `#`, and `unknown` is where the
		// app lands when the dialect probe fails, so a MySQL server reading that
		// text as a comment is a live possibility. Nothing is rewritten either
		// way: this guard returns before the append path runs, so the SQL sent
		// is byte-identical to the input; only the meta line changes, from
		// `limit in statement` to `no limit applied`, which is the honest read
		// when the clause might not exist on the server that actually runs it.
		if (hashCommentPrecedesClause(sql, ownLimitAt, dialect)) return { sql, limit: null, state: 'none' };
		return { sql, limit: null, state: 'in-statement' };
	}
	if (limit === 'All' || !returnsRows) return { sql, limit: null, state: 'none' };
	const value = Number(limit);
	if (!Number.isFinite(value) || value <= 0) return { sql, limit: null, state: 'none' };
	// A statement that ENDS in a locking clause takes the limit INSERTED before
	// that clause rather than appended after it. MySQL documents the order
	// `[LIMIT ...] [FOR UPDATE | LOCK IN SHARE MODE]` and rejects a LIMIT that
	// follows the lock, so appending would send it SQL that does not parse —
	// naming a clause the user never typed. PostgreSQL accepts either order, so
	// inserting is valid there too, and the read stays bounded on both engines
	// instead of streaming every row under a meta line that says so.
	const lockingAt = trailingLockingClauseAt(sql, dialect);
	if (lockingAt >= 0) {
		// Unless the clause sits behind an unmasked `#`, where it may be text
		// the user commented out on a dialect that does not mask `#`: breaking
		// the line would revive it. Such a statement goes out untouched.
		if (hashCommentPrecedesClause(sql, lockingAt, dialect)) return { sql, limit: null, state: 'none' };
		return { sql: `${sql.slice(0, lockingAt).trimEnd()}\nLIMIT ${value}\n${sql.slice(lockingAt)}`, limit: value, state: 'applied' };
	}
	// The clause is joined with a NEWLINE, not a space: the checks above run on
	// comment-stripped text but the statement is sent RAW, so appending after a
	// trailing `-- ...` comment would put LIMIT inside that comment and send an
	// unbounded SELECT while the meta line reported a limit.
	return { sql: `${sql.replace(/;\s*$/, '').trimEnd()}\nLIMIT ${value}`, limit: value, state: 'applied' };
}
