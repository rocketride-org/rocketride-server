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
import { CTE_WRITE_WORDS, selectsInto } from './classify';
import { codeOnly, codeWithOperands, keywordSites, stripSqlComments } from './split';
import {
	formatBatchOutcome,
	formatElapsed,
	formatPriorStatements,
	formatRunLabel as formatSharedRunLabel,
	hasStatementInFlight,
} from 'shared/explorer/runner/format';
import type { IStatementRunBase, RunOutcome } from 'shared/explorer/runner/types';

// The outcome wording is shared with the other Explorers (shared/explorer/runner/format):
// SQL's defaults are the autocommit words, so what users read is unchanged.
// (Port of 4c584a214.)
export { formatBatchOutcome, formatElapsed, formatPriorStatements, hasStatementInFlight };
export type { RunOutcome };

// =============================================================================
// TYPES
// =============================================================================

/** One statement of a batch, with whatever is known about it so far. */
export interface StatementRun extends IStatementRunBase {
	/** The statement as sent (before the row limit is appended). */
	sql: string;
	/** Statement kind, by pattern. */
	kind: StatementKind;
	/** Returned rows, when the outcome is `rows`. */
	rows?: Record<string, unknown>[];
	/** How the row limit came about — decides which meta wording applies. */
	limitState?: LimitState;
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
 * The status strip's label for one statement, e.g.
 * `2 UPDATE · 3 affected · round trip 0.012 s`.
 *
 * The full text is in the label rather than carried by colour, so the strip's
 * buttons have complete accessible names.
 *
 * @param run - The statement.
 * @returns The label.
 */
export function formatRunLabel(run: StatementRun): string {
	return formatSharedRunLabel({ ...run, rowCount: run.rows?.length ?? run.rowCount });
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
 * ClickHouse's `LIMIT n BY expr`, also spelled `LIMIT m, n BY` and `LIMIT n
 * OFFSET m BY`: it caps the rows PER GROUP of `expr`, not the result, so it
 * is not the statement's row limit. ClickHouse accepts an ordinary `LIMIT`
 * after it, which is where the header's goes. `n` and `m` are constants or
 * query parameters (`{n:UInt32}`), so each is one token here; matched on
 * masked text sliced at a `limit` site, like {@link FETCH_LIMIT_HEAD}.
 */
const LIMIT_BY_HEAD = /^limit\s+[^\s,()]+(?:\s*,\s*[^\s,()]+)?(?:\s+offset\s+[^\s,()]+)?\s+by(?![\w$])/i;

/**
 * Whether the dialect may be one that has `LIMIT n BY`: ClickHouse, or a
 * connection whose dialect could not be probed. On PostgreSQL and MySQL the
 * clause does not parse at all, and the statement is left as it was.
 *
 * @param dialect - The engine dialect.
 * @returns True when a `LIMIT ... BY` may be a per-group limit.
 */
function mayLimitByGroup(dialect: SqlDialect): boolean {
	return dialect === 'clickhouse' || dialect === 'unknown';
}

/**
 * ClickHouse's trailing `SETTINGS name = value, ...` and `FORMAT Name`
 * clauses, matched on masked text sliced at a depth-0 `settings`/`format`
 * site. ClickHouse orders them after every LIMIT (`... LIMIT n SETTINGS ...
 * FORMAT ...`, or FORMAT first) and rejects a LIMIT that follows either.
 * `FORMAT` must also be the statement's last clause apart from a trailing
 * SETTINGS, so a column or alias named `format` or `settings` (`SELECT format
 * FROM t`, `WHERE settings = 1`) never matches.
 * Only a `;` and comments may follow the format name: `--` and block comments
 * are masked, but ClickHouse can read `#` as a line comment, which the
 * scanner masks on MySQL alone, so an unmasked `# ...` is allowed there too.
 */
const SETTINGS_CLAUSE_HEAD = /^settings\s+[a-z_][\w]*\s*=/i;
const FORMAT_CLAUSE = /^format\s+[a-z_][\w]*(?:\s+settings\s+[a-z_][\w]*\s*=[\s\S]*?)?\s*;?\s*(?:#[^\n]*\s*)*$/i;

/**
 * Masked text before a `settings`/`format` site that still expects an
 * operand: a comma, an opening parenthesis, a dot, an operator, or a keyword
 * such as BY, FROM or JOIN. There the word is a column, table or alias name
 * (`ORDER BY format DESC`, `ORDER BY a, format ASC`, `FROM format f`), never
 * the trailing clause, which only follows a complete query. `*` is left out
 * because `SELECT * FORMAT CSV` is a complete ClickHouse query. The word
 * boundary is the identifier class written out, not `\b`, for the reason
 * `keywordSites` gives, and without a lookbehind (Safari 13).
 */
const EXPECTS_OPERAND = /(?:[,(.=<>+\-/%|&^~!]|(?:^|[^A-Za-z0-9_$\u0080-\uffff])(?:by|from|join|select|distinct|where|prewhere|having|on|using|and|or|not|in|is|like|ilike|between|as|case|when|then|else))\s*$/i;

/**
 * Where a trailing ClickHouse `SETTINGS` or `FORMAT` clause starts (the first
 * of them when both are present), or -1. Only on a dialect that may be
 * ClickHouse (see {@link mayLimitByGroup}); neither clause parses on
 * PostgreSQL or MySQL.
 *
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @returns The clause's start index, or -1.
 */
function trailingClickHouseClauseAt(sql: string, dialect: SqlDialect): number {
	if (!mayLimitByGroup(dialect)) return -1;
	const masked = codeOnly(sql, dialect);
	// A literal or a quoted name right before the site is a complete operand,
	// which the plain mask would blank away (`kind = 'click' SETTINGS ...`).
	const operands = codeWithOperands(sql, dialect);
	for (const site of keywordSites(sql, ['settings', 'format'], dialect)) {
		if (site.depth !== 0 || EXPECTS_OPERAND.test(operands.slice(0, site.index))) continue;
		const rest = masked.slice(site.index);
		if (site.keyword === 'settings' ? SETTINGS_CLAUSE_HEAD.test(rest) : FORMAT_CLAUSE.test(rest)) return site.index;
	}
	return -1;
}

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
		if (site.keyword === 'limit') {
			// A per-group `LIMIT n BY` bounds each group, not the result: look on
			// for a real one (ClickHouse allows one after it).
			if (mayLimitByGroup(dialect) && LIMIT_BY_HEAD.test(masked.slice(site.index))) continue;
			return site.index;
		}
		if (FETCH_LIMIT_HEAD.test(masked.slice(site.index))) return site.index;
	}
	return -1;
}

/**
 * How a result's row limit came about.
 *
 * - `applied` — the app added the header's limit: appended at the end, or
 *   inserted before a trailing locking clause or, on ClickHouse and an
 *   unprobed dialect, before a trailing `SETTINGS` or `FORMAT` clause.
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
 * MySQL and PostgreSQL accept — and, on ClickHouse or a dialect that could not
 * be probed, on a statement that ends in `SETTINGS` or `FORMAT`, where it is
 * inserted before the first of them.
 *
 * A statement that already carries its own LIMIT is left alone: the user's
 * limit governs, and the meta line reports that none was applied by the app.
 * Nothing is added to writes, DDL, SHOW, EXPLAIN or DESCRIBE, where the clause
 * is either invalid or silently changes what the statement does — nor to a
 * `SELECT ... INTO` on any dialect ({@link selectsInto}), which writes its rows
 * into a table, a file or variables, so a limit would truncate what it writes.
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
	// A SELECT ... INTO returns no rows: it fills a new table (PostgreSQL), a
	// file or variables (MySQL), or a file (ClickHouse). An appended LIMIT would
	// silently truncate the copy, or follow MySQL's trailing INTO where it does
	// not parse. It goes out as typed, its own LIMIT included, and since no
	// rows come back no limit is reported either. Checked before the statement's
	// own limit for that reason, with the classification's own test, so the run
	// is a `write` there too.
	if (returnsRows && selectsInto(sql, dialect)) return { sql, limit: null, state: 'none' };
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
	// ClickHouse's SETTINGS and FORMAT clauses come after every LIMIT, so the
	// header's limit goes in front of the first of them, the same way it goes in
	// front of a locking clause. A LIMIT appended after either does not parse.
	const trailingAt = trailingClickHouseClauseAt(sql, dialect);
	if (trailingAt >= 0) {
		if (hashCommentPrecedesClause(sql, trailingAt, dialect)) return { sql, limit: null, state: 'none' };
		return { sql: `${sql.slice(0, trailingAt).trimEnd()}\nLIMIT ${value}\n${sql.slice(trailingAt)}`, limit: value, state: 'applied' };
	}
	// The clause is joined with a NEWLINE, not a space: the checks above run on
	// comment-stripped text but the statement is sent RAW, so appending after a
	// trailing `-- ...` comment would put LIMIT inside that comment and send an
	// unbounded SELECT while the meta line reported a limit.
	return { sql: `${sql.replace(/;\s*$/, '').trimEnd()}\nLIMIT ${value}`, limit: value, state: 'applied' };
}
