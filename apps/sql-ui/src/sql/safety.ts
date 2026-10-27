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
// SQL — SAFETY (which statements ask first, and what they ask)
// =============================================================================
//
// A connection's safety level (connect/savedConnections.ts) decides which
// statements ask before they are sent:
//
//   - `off`   — none.
//   - `risky` — the shapes the pattern check flags (classify.ts): UPDATE or
//               DELETE without WHERE or inside a WITH clause, TRUNCATE, DROP,
//               ALTER, and EXPLAIN ANALYZE (DESCRIBE ANALYZE) of anything
//               but a read, since ANALYZE runs it.
//   - `every` — every statement the classifier does not call a read: the
//               `write`, `ddl` and `other` kinds (CALL, GRANT, SET, DO,
//               VALUES…, since a procedure can change rows), and everything
//               `risky` flags. Transaction control is refused before anything
//               asks.
//
// At `risky` and `every`, DROP and TRUNCATE also ask for the target's name to
// be typed, exactly as the statement spells it (GitHub's pattern for deleting
// a repository). Several targets, or a name this cannot read, ask for the verb.
//
// The dialog can also say how many rows a write would change. The number is
// the planner's estimate from a plain EXPLAIN, which plans without running:
// PostgreSQL's `Plan Rows` and MySQL's `rows`. ClickHouse, and anything else
// those two cannot explain, gets no estimate.
//
// A dialect that is not known yet (the schema read has not landed) is read
// every way it could be: the default comment rules, MySQL's (`#` comments,
// `--` needs a space, `/*! … */` is code) and ClickHouse's. A statement asks
// when ANY reading says it should, so a `#` line cannot hide a DELETE from a
// connection that turns out to be MySQL.
//
// Everything here reads the statement TEXT. It prevents nothing the database
// would do on its own, and the dialog says so.
// =============================================================================

import type { IPatternFinding } from 'shared/explorer/runner/types';
import type { SqlDialect } from '../connect';
import { DEFAULT_SAFETY_LEVEL } from '../connect/savedConnections';
import type { SafetyLevel } from '../connect/savedConnections';
import { leadingVerb } from './batch';
import { CTE_WRITE_WORDS, classifyStatement, patternCheck } from './classify';
import { buildExplain } from './explain';
import { hasTopLevelKeyword, keywordSites, stripSqlComments } from './split';

// =============================================================================
// TYPES
// =============================================================================

/** What a DROP or a TRUNCATE removes, and what must be typed to confirm it. */
export interface DestructiveTarget {
	/** The statement's verb. */
	verb: 'DROP' | 'TRUNCATE';
	/** What is removed, in lower case: `table`, `view`, `database`… (`table` for TRUNCATE). */
	object: string;
	/**
	 * Every target as written, quotes removed and schema kept (`public.orders`).
	 * Empty when the names could not be read.
	 */
	names: string[];
	/** What the user types: the one target's own name, or the verb when there are several or none could be read. */
	confirmText: string;
}

/** Why a statement asks before it is sent. */
export interface WriteConfirmation extends IPatternFinding {
	/**
	 * What was seen: the pattern check's shape (`UPDATE without WHERE`,
	 * `DROP`…), or at `every` the statement's kind (`a write`, `a schema
	 * change`, `a statement that is not a read`).
	 */
	kind: string;
	/** The connection's level that asked. */
	level: Exclude<SafetyLevel, 'off'>;
	/** For DROP and TRUNCATE: the target whose name must be typed. */
	target: DestructiveTarget | null;
	/** The comment rules the statement was read with when it asked (one of an unknown dialect's readings). */
	reading: SqlDialect;
}

/** The affected-row estimate, as the dialog shows it. */
export type RowEstimate = { state: 'estimating' } | { state: 'rows'; rows: number } | { state: 'none' };

/** The dialog's sentences for one confirmation. */
export interface WriteConfirmCopy {
	/** The dialog title, a question naming the action. */
	title: string;
	/** What the statement does, in plain words. */
	consequence: string;
	/** How it runs. */
	runsAs: string;
	/** Why the dialog was shown. */
	why: string;
	/** The confirm button, repeating the action. */
	confirmLabel: string;
}

// =============================================================================
// THE RULE
// =============================================================================

/** The kind `every` reports for a statement that is neither a read, a write nor DDL. */
const NOT_A_READ = 'a statement that is not a read';

/** The kinds `every` reports by statement kind rather than by a pattern finding. */
const EVERY_KINDS = new Set(['a write', 'a schema change', NOT_A_READ]);

/**
 * The comment rules to read a statement with: the dialect's own, or, for a
 * dialect not known yet, every set it could turn out to be.
 *
 * @param dialect - The engine dialect.
 * @returns The readings.
 */
function readingsOf(dialect: SqlDialect): SqlDialect[] {
	return dialect === 'unknown' ? ['unknown', 'mysql', 'clickhouse'] : [dialect];
}

/**
 * The confirmation one reading of a statement asks for.
 *
 * @param sql - The statement.
 * @param reading - The comment rules to read it with.
 * @param level - The connection's level (not `off`).
 * @returns The confirmation, or null.
 */
function confirmationUnder(sql: string, reading: SqlDialect, level: Exclude<SafetyLevel, 'off'>): WriteConfirmation | null {
	if (stripSqlComments(sql, reading).trim() === '') return null;
	const target = targetUnder(sql, reading);
	const finding = patternCheck(sql, reading);
	if (finding) return { kind: finding.kind, level, target, reading };
	if (level === 'every') {
		const kind = classifyStatement(sql, reading);
		if (kind === 'write') return { kind: 'a write', level, target, reading };
		if (kind === 'ddl') return { kind: 'a schema change', level, target, reading };
		if (kind === 'other') return { kind: NOT_A_READ, level, target, reading };
	}
	return null;
}

/**
 * Whether a statement asks before it is sent at a connection's level, and why.
 *
 * A dialect not known yet is read every way it could be, and the statement
 * asks when any reading says so. The strictest reading is the one reported:
 * one that needs a typed name, then a pattern finding, then a statement kind.
 *
 * @param sql - The statement as it would be sent.
 * @param dialect - The engine dialect.
 * @param level - The connection's safety level.
 * @returns The confirmation to show, or null when the statement runs at once.
 */
export function needsConfirmation(sql: string, dialect: SqlDialect, level: SafetyLevel): WriteConfirmation | null {
	if (level === 'off') return null;
	const found = readingsOf(dialect)
		.map((reading) => confirmationUnder(sql, reading, level))
		.filter((confirmation): confirmation is WriteConfirmation => confirmation !== null);
	const chosen = found.find((c) => c.target !== null) ?? found.find((c) => !EVERY_KINDS.has(c.kind)) ?? found[0];
	return chosen ? { ...chosen, target: destructiveTarget(sql, dialect) } : null;
}

/**
 * Whether a runner finding is one {@link needsConfirmation} made.
 *
 * @param finding - The finding the runner hands back.
 * @returns True when it carries a level.
 */
export function isWriteConfirmation(finding: IPatternFinding): finding is WriteConfirmation {
	const level = (finding as { level?: unknown }).level;
	return level === 'risky' || level === 'every';
}

/**
 * The confirmation a runner finding stands for. Every finding the query view
 * gets comes from {@link needsConfirmation}; anything else is shown as a
 * risky write without a typed name rather than left unanswered.
 *
 * @param finding - The finding the runner hands back.
 * @returns The confirmation.
 */
export function toWriteConfirmation(finding: IPatternFinding): WriteConfirmation {
	return isWriteConfirmation(finding) ? finding : { kind: finding.kind, level: 'risky', target: null, reading: 'unknown' };
}

/** How much each level asks, lowest first. */
const SAFETY_RANK: Record<SafetyLevel, number> = { off: 0, risky: 1, every: 2 };

/**
 * Whether moving from one level to another asks LESS, which the Query page
 * confirms before it saves: the one change that should be hard to make by
 * accident.
 *
 * @param from - The level in force.
 * @param to - The level chosen.
 * @returns True for a lower level.
 */
export function isSafetyDowngrade(from: SafetyLevel, to: SafetyLevel): boolean {
	return SAFETY_RANK[to] < SAFETY_RANK[from];
}

/**
 * The level the connection editor shows and saves, and whether saving it asks.
 *
 * The editor rebuilds the whole record on Save, and the level can change
 * while it is open (the Query page sets it in place). So until the user picks
 * a level, the editor shows and saves the LIVE stored one, never the one it
 * opened with; a level the user picked is kept, and one lower than the stored
 * level asks first, as the Query page does.
 *
 * @param stored - The stored level, or null for a new connection.
 * @param picked - The level the user picked in the editor, or null.
 * @returns The level, and whether saving it asks first.
 */
export function editorSafetyChoice(stored: SafetyLevel | null, picked: SafetyLevel | null): { level: SafetyLevel; asks: boolean } {
	const level = picked ?? stored ?? DEFAULT_SAFETY_LEVEL;
	return { level, asks: stored !== null && picked !== null && isSafetyDowngrade(stored, picked) };
}

/**
 * The question asked before a connection's level is lowered.
 *
 * @param to - The lower level chosen.
 * @param connection - The connection's name.
 * @returns The dialog's title, message and confirm label.
 */
export function safetyDowngradeCopy(to: SafetyLevel, connection: string): { title: string; message: string; confirmLabel: string } {
	if (to === 'off') {
		return {
			title: `Never ask before writes on ${connection}?`,
			message: "Every statement will run as typed, DROP and TRUNCATE included, in every document of this connection. The node's allow_execute still decides what may run at all.",
			confirmLabel: "Don't ask",
		};
	}
	return {
		title: `Ask only before risky writes on ${connection}?`,
		message: 'A bounded UPDATE or DELETE, an INSERT, a CALL and similar statements will run without asking, in every document of this connection. DROP, TRUNCATE, ALTER and an UPDATE or DELETE without WHERE still ask.',
		confirmLabel: 'Ask before risky writes',
	};
}

/**
 * Whether the typed text confirms a target. The match is EXACT: case
 * sensitive, and nothing is trimmed, so the user types what the dialog shows.
 *
 * @param typed - What the user typed.
 * @param target - The target.
 * @returns True when the confirm button may be used.
 */
export function confirmTextMatches(typed: string, target: DestructiveTarget): boolean {
	return typed === target.confirmText;
}

// =============================================================================
// DROP AND TRUNCATE TARGETS
// =============================================================================

/** DROP object kinds whose names are read, longest spelling first. */
const DROP_OBJECTS: string[][] = [
	['materialized', 'view'],
	['foreign', 'table'],
	['table'],
	['view'],
	['index'],
	['schema'],
	['database'],
	['sequence'],
	['dictionary'],
];

/** A character that can start an unquoted identifier. */
const IDENT_START = /[A-Za-z_\u0080-￿]/;

/** A character that can continue an unquoted identifier. */
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

/** A read position in comment-free statement text. */
interface Cursor {
	/** The text. */
	text: string;
	/** The current offset. */
	at: number;
}

/**
 * Skip whitespace.
 *
 * @param cursor - The read position.
 */
function skipSpace(cursor: Cursor): void {
	while (cursor.at < cursor.text.length && /\s/.test(cursor.text[cursor.at] as string)) cursor.at += 1;
}

/**
 * Consume a sequence of keywords, case-insensitively and as whole words; the
 * cursor does not move unless all of them match.
 *
 * @param cursor - The read position.
 * @param words - The keywords, in order.
 * @returns True when they were consumed.
 */
function takeWords(cursor: Cursor, ...words: string[]): boolean {
	const start = cursor.at;
	for (const word of words) {
		skipSpace(cursor);
		const next = cursor.text.slice(cursor.at, cursor.at + word.length);
		const after = cursor.text[cursor.at + word.length];
		if (next.toLowerCase() !== word || (after !== undefined && IDENT_PART.test(after))) {
			cursor.at = start;
			return false;
		}
		cursor.at += word.length;
	}
	return true;
}

/**
 * Read one bare word, without consuming it.
 *
 * @param cursor - The read position.
 * @returns The word, or null when an identifier does not start here.
 */
function peekWord(cursor: Cursor): string | null {
	const probe = { ...cursor };
	skipSpace(probe);
	if (!IDENT_START.test(probe.text[probe.at] ?? '')) return null;
	let end = probe.at;
	while (end < probe.text.length && IDENT_PART.test(probe.text[end] as string)) end += 1;
	return probe.text.slice(probe.at, end);
}

/**
 * Read one name part: a quoted identifier (its quotes removed, a doubled
 * quote undone) or a bare one (as written).
 *
 * @param cursor - The read position.
 * @param dialect - The engine dialect (backticks quote on MySQL and ClickHouse).
 * @returns The part, or null when no identifier starts here.
 */
function namePart(cursor: Cursor, dialect: SqlDialect): string | null {
	skipSpace(cursor);
	const open = cursor.text[cursor.at];
	const quotes = dialect === 'postgres' ? ['"'] : ['"', '`'];
	if (open !== undefined && quotes.includes(open)) {
		let out = '';
		let at = cursor.at + 1;
		while (at < cursor.text.length) {
			const ch = cursor.text[at] as string;
			if (ch === open) {
				if (cursor.text[at + 1] === open) {
					out += open;
					at += 2;
					continue;
				}
				cursor.at = at + 1;
				return out;
			}
			out += ch;
			at += 1;
		}
		return null;
	}
	const word = peekWord(cursor);
	if (word === null) return null;
	skipSpace(cursor);
	cursor.at += word.length;
	return word;
}

/**
 * Read a list of possibly qualified names separated by commas.
 *
 * @param cursor - The read position.
 * @param dialect - The engine dialect.
 * @param star - Whether a name may carry PostgreSQL's trailing `*` (TRUNCATE).
 * @returns Each name as its parts, or null when the list could not be read.
 */
function nameList(cursor: Cursor, dialect: SqlDialect, star: boolean): string[][] | null {
	const names: string[][] = [];
	for (;;) {
		const parts: string[] = [];
		for (;;) {
			const part = namePart(cursor, dialect);
			if (part === null) return null;
			parts.push(part);
			skipSpace(cursor);
			if (cursor.text[cursor.at] !== '.') break;
			cursor.at += 1;
		}
		names.push(parts);
		skipSpace(cursor);
		if (star && cursor.text[cursor.at] === '*') {
			cursor.at += 1;
			skipSpace(cursor);
		}
		if (cursor.text[cursor.at] !== ',') return names;
		cursor.at += 1;
	}
}

/**
 * What a DROP or a TRUNCATE removes, under one reading's comment rules.
 *
 * @param sql - The statement.
 * @param dialect - The comment rules to read it with.
 * @returns The target, or null when the statement is not a DROP or a TRUNCATE.
 */
function targetUnder(sql: string, dialect: SqlDialect): DestructiveTarget | null {
	const cursor: Cursor = { text: stripSqlComments(sql, dialect).trim(), at: 0 };
	let verb: DestructiveTarget['verb'];
	let object = 'table';
	let names: string[][] | null = null;

	if (takeWords(cursor, 'drop')) {
		verb = 'DROP';
		if (!takeWords(cursor, 'temporary')) takeWords(cursor, 'temp');
		const known = DROP_OBJECTS.find((words) => takeWords(cursor, ...words));
		if (known) {
			object = known.join(' ');
			if (object === 'index') takeWords(cursor, 'concurrently');
			takeWords(cursor, 'if', 'exists');
			names = nameList(cursor, dialect, false);
		} else {
			object = peekWord(cursor)?.toLowerCase() ?? 'object';
		}
	} else if (takeWords(cursor, 'truncate')) {
		verb = 'TRUNCATE';
		if (takeWords(cursor, 'database')) object = 'database';
		else takeWords(cursor, 'table');
		// ClickHouse's `TRUNCATE ALL TABLES FROM db` names no table.
		if (!takeWords(cursor, 'all', 'tables')) {
			takeWords(cursor, 'if', 'exists');
			takeWords(cursor, 'only');
			names = nameList(cursor, dialect, true);
		}
	} else {
		return null;
	}

	const read = names ?? [];
	// One target is confirmed by its own name; several, none, or an empty
	// quoted name (which would match an empty field) by the verb.
	const parts = read.length === 1 ? read[0] : undefined;
	const only = parts?.[parts.length - 1];
	return {
		verb,
		object,
		names: read.map((parts) => parts.join('.')),
		confirmText: only || verb,
	};
}

/**
 * What a DROP or a TRUNCATE removes, read from the statement text.
 *
 * Reads past comments (with the dialect's rules), `TEMPORARY`, `IF EXISTS`,
 * `CONCURRENTLY` and `ONLY`; strips quotes from quoted names and keeps the
 * schema of a qualified one. A DROP of something other than a table, view,
 * materialized view, foreign table, index, schema, database, sequence or
 * dictionary (a function with its argument list, a role…) is reported with no
 * names, and is confirmed by typing the verb. A dialect not known yet is read
 * every way it could be; when the readings disagree on the name, the verb is
 * typed.
 *
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @returns The target, or null when the statement is not a DROP or a TRUNCATE.
 */
export function destructiveTarget(sql: string, dialect: SqlDialect = 'unknown'): DestructiveTarget | null {
	const targets = readingsOf(dialect)
		.map((reading) => targetUnder(sql, reading))
		.filter((target): target is DestructiveTarget => target !== null);
	const first = targets[0];
	if (!first) return null;
	// Readings that disagree on the name are confirmed by the verb.
	return targets.every((target) => target.confirmText === first.confirmText) ? first : { ...first, confirmText: first.verb };
}

// =============================================================================
// AFFECTED-ROW ESTIMATE
// =============================================================================

/** Statements the estimate explains: the writes PostgreSQL and MySQL plan. */
const ESTIMATED_VERBS = new Set(['UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'MERGE']);

/**
 * The plain EXPLAIN whose plan estimates how many rows a write changes, or
 * null when there is none to ask for.
 *
 * PostgreSQL gets the JSON plan; MySQL the classic table, whose `rows` and
 * `filtered` columns are documented for UPDATE and DELETE. Neither runs the
 * statement (no ANALYZE), and the gate classifies both as reads. ClickHouse,
 * an unknown dialect, DDL, TRUNCATE (which PostgreSQL cannot explain) and a
 * WITH chain (whose plan root is not the write) get none.
 *
 * @param sql - The statement as it would be sent.
 * @param dialect - The engine dialect.
 * @returns The EXPLAIN statement, or null.
 */
export function rowEstimateStatement(sql: string, dialect: SqlDialect): string | null {
	if (dialect !== 'postgres' && dialect !== 'mysql') return null;
	if (classifyStatement(sql, dialect) !== 'write' || !ESTIMATED_VERBS.has(leadingVerb(sql, dialect))) return null;
	if (dialect === 'postgres') return buildExplain(dialect, sql);
	const body = sql.replace(/\s*;\s*$/, '').trim();
	return body ? `EXPLAIN ${body}` : null;
}

/**
 * A planner number, from a JSON number or the numeric text MySQL sends.
 *
 * @param value - The raw value.
 * @returns The number, or null.
 */
function plannerNumber(value: unknown): number | null {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Read PostgreSQL's estimate: the rows the write's input plan produces. A
 * `ModifyTable` root reports 0 rows on newer servers, so its first child (the
 * scan that finds the rows) is read instead.
 *
 * @param rows - The EXPLAIN (FORMAT JSON) result rows.
 * @returns The estimate, or null.
 */
function postgresEstimate(rows: Record<string, unknown>[]): number | null {
	const first = rows[0];
	let doc: unknown = first?.['QUERY PLAN'] ?? first?.['query plan'];
	if (typeof doc === 'string') {
		try {
			doc = JSON.parse(doc);
		} catch {
			return null;
		}
	}
	const entry = Array.isArray(doc) ? doc[0] : doc;
	const plan = (entry as { Plan?: Record<string, unknown> } | null)?.Plan;
	if (!plan || typeof plan !== 'object') return null;
	const children = Array.isArray(plan.Plans) ? plan.Plans as Record<string, unknown>[] : [];
	const source = plan['Node Type'] === 'ModifyTable' && children[0] ? children[0] : plan;
	return plannerNumber(source['Plan Rows']);
}

/**
 * Read MySQL's estimate from the classic EXPLAIN table: the target table's
 * row (its `select_type` is the verb), `rows` scaled by `filtered` percent.
 *
 * @param rows - The EXPLAIN result rows.
 * @returns The estimate, or null.
 */
function mysqlEstimate(rows: Record<string, unknown>[]): number | null {
	const target = rows.find((row) => typeof row.select_type === 'string' && ESTIMATED_VERBS.has(row.select_type.toUpperCase())) ?? rows[0];
	const examined = plannerNumber(target?.rows);
	if (examined === null) return null;
	const filtered = plannerNumber(target?.filtered);
	return Math.round(filtered === null ? examined : (examined * filtered) / 100);
}

/**
 * Read the affected-row estimate out of an estimate EXPLAIN's result.
 *
 * @param dialect - The engine dialect.
 * @param rows - The EXPLAIN result rows.
 * @returns The estimate, or null when the plan does not give one.
 */
export function parseRowEstimate(dialect: SqlDialect, rows: Record<string, unknown>[]): number | null {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	if (dialect === 'postgres') return postgresEstimate(rows);
	if (dialect === 'mysql') return mysqlEstimate(rows);
	return null;
}

/**
 * The dialog's "Rows that change" value, or null when the line does not
 * apply (schema changes other than TRUNCATE).
 *
 * @param confirmation - Why the statement asks.
 * @param sql - The statement.
 * @param estimate - Where the estimate is.
 * @returns The text, or null.
 */
export function rowsChangeText(confirmation: WriteConfirmation, sql: string, estimate: RowEstimate): string | null {
	if (confirmation.target?.verb === 'TRUNCATE') return 'Every row';
	if (classifyStatement(sql, confirmation.reading) !== 'write') return null;
	const reach = writeReach(sql, statementVerb(confirmation, sql), confirmation.reading);
	// The body says every row, so this line does too; the planner's number
	// sits beside it rather than in place of it.
	if (reach === 'table') return estimate.state === 'rows' ? `Every row (about ${estimate.rows.toLocaleString()} by the planner's estimate)` : 'Every row';
	if (estimate.state === 'estimating') return 'Estimating…';
	if (estimate.state === 'none') return 'No estimate';
	const about = `about ${estimate.rows.toLocaleString()} ${estimate.rows === 1 ? 'row' : 'rows'}`;
	return reach === 'unclear' ? `${about} (planner estimate, which may be wrong for a LIMIT or a join)` : `${about} (planner estimate)`;
}

// =============================================================================
// WORDING
// =============================================================================

/** How far an UPDATE or a DELETE reaches, as far as its text tells (see {@link writeReach}). */
type WriteReach = 'table' | 'filtered' | 'unclear';

/**
 * How far an UPDATE or a DELETE reaches, as far as its text tells:
 *
 * - `table`: one plain table, no WHERE, LIMIT or join: every row in it;
 * - `filtered`: one plain table with a WHERE and no LIMIT or join: the rows
 *   the WHERE matches, which is what the planner estimates;
 * - `unclear`: a LIMIT, a join (`JOIN`, PostgreSQL's `UPDATE … FROM` and
 *   `DELETE … USING`), several tables, or a prefix (WITH, EXPLAIN ANALYZE):
 *   only the rows the statement reaches, which the planner's number may not
 *   count (MySQL's `rows` does not apply a LIMIT).
 *
 * @param sql - The statement.
 * @param verb - Its verb ({@link statementVerb}).
 * @param reading - The comment rules to read it with.
 * @returns The reach, or null for any other statement.
 */
function writeReach(sql: string, verb: string, reading: SqlDialect): WriteReach | null {
	if (verb !== 'UPDATE' && verb !== 'DELETE') return null;
	const joined = hasTopLevelKeyword(sql, verb === 'UPDATE' ? 'from' : 'using', reading);
	if (writeTable(sql, reading) === null || joined || hasTopLevelKeyword(sql, 'limit', reading)) return 'unclear';
	return hasTopLevelKeyword(sql, 'where', reading) ? 'filtered' : 'table';
}

/**
 * What the statement does, for a confirmation without a DROP or TRUNCATE target.
 *
 * @param kind - The confirmation's kind.
 * @param reach - How far an UPDATE or a DELETE reaches (null for anything else).
 * @returns The sentence.
 */
function plainConsequence(kind: string, reach: WriteReach | null): string {
	// "Every row in the table" only when nothing else bounds it: a LIMIT or a
	// join does, and then only the rows the statement reaches are at stake.
	if (kind === 'UPDATE without WHERE') return reach === 'table' ? 'No WHERE clause: this changes every row in the table.' : 'No WHERE clause: this can change every row the statement reaches.';
	if (kind === 'DELETE without WHERE') return reach === 'table' ? 'No WHERE clause: this deletes every row in the table.' : 'No WHERE clause: this can delete every row the statement reaches.';
	const inWith = /^(UPDATE|DELETE) inside a WITH clause$/.exec(kind);
	if (inWith) return `A WITH clause in it runs ${inWith[1]}; this check cannot tell which rows that reaches.`;
	if (kind === 'EXPLAIN ANALYZE') return 'ANALYZE runs the statement to measure it, so what it changes is changed for real.';
	if (kind === 'ALTER' || kind === 'a schema change') return 'It changes the schema.';
	if (kind === NOT_A_READ) return 'It is not a read, so it may change data.';
	return 'It changes data.';
}

/**
 * The verb a confirmation names: the mutation a pattern finding saw, `SELECT
 * INTO` for a SELECT that writes, the write a WITH chain carries, and the
 * statement's leading keyword otherwise.
 *
 * @param confirmation - Why the statement asks.
 * @param sql - The statement.
 * @returns The verb, in upper case.
 */
function statementVerb(confirmation: WriteConfirmation, sql: string): string {
	const named = /^(UPDATE|DELETE) (?:without WHERE|inside a WITH clause)$/.exec(confirmation.kind);
	if (named) return named[1] as string;
	const verb = leadingVerb(sql, confirmation.reading);
	if (verb === 'SELECT' && classifyStatement(sql, confirmation.reading) === 'write') return 'SELECT INTO';
	if (verb === 'WITH') return keywordSites(sql, CTE_WRITE_WORDS, confirmation.reading)[0]?.keyword.toUpperCase() ?? verb;
	return verb;
}

/**
 * The table an UPDATE or a DELETE writes to, as written (quotes removed), or
 * null when it is not one plain table (a multi-table form, a join).
 *
 * @param sql - The statement.
 * @param reading - The comment rules to read it with.
 * @returns The table, or null.
 */
function writeTable(sql: string, reading: SqlDialect): string | null {
	const cursor: Cursor = { text: stripSqlComments(sql, reading).trim(), at: 0 };
	let names: string[][] | null = null;
	if (takeWords(cursor, 'update')) {
		for (const modifier of ['only', 'low_priority', 'ignore']) takeWords(cursor, modifier);
		names = nameList(cursor, reading, true);
		// Then `SET`, optionally after an alias: anything else (a join, a
		// second table) is not one plain table.
		if (!takeWords(cursor, 'set')) {
			takeWords(cursor, 'as');
			const alias = peekWord(cursor);
			if (alias !== null) {
				skipSpace(cursor);
				cursor.at += alias.length;
			}
			if (!takeWords(cursor, 'set')) return null;
		}
	} else if (takeWords(cursor, 'delete')) {
		for (const modifier of ['low_priority', 'quick', 'ignore']) takeWords(cursor, modifier);
		if (!takeWords(cursor, 'from')) return null;
		takeWords(cursor, 'only');
		names = nameList(cursor, reading, true);
	}
	return names?.length === 1 ? (names[0] as string[]).join('.') : null;
}

/**
 * The dialog's sentences for one confirmation. With an estimate, an UPDATE or
 * a DELETE names the rows and the table: "Update about 20 rows in orders?"
 * for one with a WHERE, "Update every row in orders?" for one without. One
 * with a LIMIT or a join keeps the plain title: the planner's number may not
 * count what it reaches, and the title never states a count the body
 * contradicts.
 *
 * @param confirmation - Why the statement asks.
 * @param sql - The statement.
 * @param connection - The connection's name.
 * @param estimate - The affected-row estimate, when there is one.
 * @returns The sentences.
 */
export function writeConfirmCopy(confirmation: WriteConfirmation, sql: string, connection: string, estimate?: RowEstimate): WriteConfirmCopy {
	const why = `${connection} is set to ask before ${confirmation.level === 'every' ? 'every write' : 'risky writes'}. This is a check on the statement text, not a database permission.`;
	const runsAs = 'It runs at once and commits on its own. It cannot be undone here.';
	const { target } = confirmation;
	const undo = 'This cannot be undone from SQL Explorer.';
	if (target?.verb === 'DROP') {
		const several = target.names.length > 1;
		const named = target.names.length > 0 ? ` ${target.names.join(', ')}` : '';
		const rows = target.object === 'table' ? (several ? ' and every row in them' : ' and every row in it') : '';
		return {
			title: `Drop ${target.object}${named}?`,
			consequence: `Deletes ${several ? `all ${target.names.length} of them` : `the ${target.object}`}${rows}. ${undo}`,
			runsAs,
			why,
			confirmLabel: several ? `Drop all ${target.names.length}` : `Drop ${target.object}`,
		};
	}
	if (target?.verb === 'TRUNCATE') {
		const several = target.names.length > 1;
		const named = target.names.length > 0 ? ` ${target.names.join(', ')}` : '';
		return {
			title: `Empty ${target.object}${several ? 's' : ''}${named}?`,
			consequence: `Deletes every row in ${target.names.length === 1 ? target.names[0] : 'each table'}; the table structure stays. ${undo}`,
			runsAs,
			why,
			confirmLabel: `Empty ${target.object}${several ? 's' : ''}`,
		};
	}
	const verb = statementVerb(confirmation, sql);
	const reach = writeReach(sql, verb, confirmation.reading);
	const consequence = plainConsequence(confirmation.kind, reach);
	if (estimate?.state === 'rows' && (reach === 'filtered' || reach === 'table')) {
		const action = verb === 'UPDATE' ? 'Update' : 'Delete';
		const count = reach === 'table' ? 'every row' : `${estimate.rows.toLocaleString()} ${estimate.rows === 1 ? 'row' : 'rows'}`;
		// Both reaches have one plain table.
		const where = `${verb === 'UPDATE' ? ' in' : ' from'} ${writeTable(sql, confirmation.reading) ?? ''}`;
		return {
			title: `${action} ${reach === 'table' ? count : `about ${count}`}${where}?`,
			consequence,
			runsAs,
			why,
			confirmLabel: `${action} ${count}`,
		};
	}
	return {
		title: `Run this ${verb}?`,
		consequence,
		runsAs,
		why,
		confirmLabel: `Run ${verb}`,
	};
}
