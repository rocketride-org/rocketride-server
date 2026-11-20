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
// CYPHER - STATEMENT CLASSIFIER (a text check, never a database safeguard)
// =============================================================================
//
// Decides, from the statement's TEXT, whether it can be sent to the read path.
// The answer is deliberately conservative: a statement counts as a read only
// when BOTH hold.
//
//   1. It starts with a read clause: MATCH, OPTIONAL MATCH, WITH, UNWIND,
//      RETURN, a SHOW of schema objects, or a CALL (decided by rule 2).
//   2. Its code (strings, comments and backtick names excluded) contains no
//      write or administration construct and no CALL of a procedure outside
//      the reviewed list. Nested writes (`CALL { ... SET ... }`, `FOREACH`,
//      `ON CREATE SET`) and backticked procedure names are found because every
//      code token is scanned, not just the first.
//
// Anything else is `write`, which routes to the write console and its
// confirmation, never to the read path. A `write` answer can be wrong in the
// safe direction (a read the checker does not recognise is simply sent to the
// write console). A `read` answer that is wrong cannot change data through the
// browse editor or the graph actions, because the node's read path and the
// database role enforce that on their own; in the write console it means the
// statement is sent WITHOUT the confirmation. That is why the confirmation
// dialog says "This is a text check, not a database safeguard."
//
// The write words, the SHOW targets and the SHOW modifiers are the node's own
// read-path sets (packages/ai/src/ai/common/graph/cypher_safety.py:
// _WRITE_WORDS, _SHOW_ALLOWED, _SHOW_MODIFIERS), so a statement the node's read
// path counts as a write is confirmed here before it is sent, and a SHOW the
// node always refuses is not offered to it as a read. tests/classify.test.ts
// reads those sets and fails when the two sides differ. The rest of the rule
// is this file's own and is not the node's: an administration word counts
// only as the first word (a few pairs anywhere), while the Neo4j node refuses
// GRANT, DENY, REVOKE, USE, a SHOW off its list and more pairs anywhere; and a
// word right before `:` in a pattern (`(set:Person)`) is a clause here but a
// name to the node. The FalkorDB and Apache AGE read paths use none of these
// sets.
//
// Words are only keywords in CLAUSE position. A word right after `.` is a
// property name (`n.set`), right after `:` a label or type (`(n:Delete)`), and a
// word that is a map key (`{create: 1}`) is not a clause either.
// =============================================================================

import { codeTokens, nameOf, tokenize } from './lexer';
import type { IToken } from './lexer';
import { isVettedProcedure } from './procedures';

// =============================================================================
// TYPES
// =============================================================================

/**
 * What the statement does, by text.
 *
 * - `read`  - starts with a read clause and contains nothing that writes.
 * - `write` - everything else: data changes, schema/administration commands,
 *             unvetted procedures, unrecognised or malformed statements.
 * - `empty` - only whitespace and comments.
 */
export type StatementKind = 'read' | 'write' | 'empty';

/** Why a statement was not classified as a read. */
export type FindingReason = 'write-clause' | 'admin-command' | 'load-csv' | 'call' | 'unrecognized-start' | 'malformed';

/** One construct that kept the statement from being a read. */
export interface IFinding {
	/** Why it counts. */
	reason: FindingReason;
	/** The words as written (for a CALL, the procedure name). */
	word: string;
	/** Offset of the finding in the statement text. */
	start: number;
	/** Offset one past the finding. */
	end: number;
}

/** The classifier's full answer for one statement. */
export interface IClassification {
	/** The kind. */
	kind: StatementKind;
	/** Every construct that made it a write (empty for reads). */
	findings: IFinding[];
	/** The leading verb, upper-cased, for strip and history labels. */
	verb: string;
}

/** What the pattern check saw (the shape the shared statement runner takes). */
export interface IPatternFinding {
	/** The shape detected, phrased for `Pattern check: <kind> detected.`. */
	kind: string;
}

// =============================================================================
// KEYWORD TABLES
// =============================================================================

/** Clauses that start a read. */
const READ_STARTS = new Set(['MATCH', 'WITH', 'UNWIND', 'RETURN']);

/**
 * Words that write data or schema wherever they appear in clause position: the
 * node's `_WRITE_WORDS`, word for word. `INSERT` is GQL's synonym of `CREATE`
 * (Neo4j 5). `DETACH` is reported together with the `DELETE` that follows it.
 */
export const WRITE_WORDS: ReadonlySet<string> = new Set(['CREATE', 'MERGE', 'SET', 'REMOVE', 'DELETE', 'DETACH', 'DROP', 'FOREACH', 'INSERT']);

/**
 * Administration commands. Each is a standalone command, so it only counts as
 * the FIRST word of a statement; mid-statement the same word is an ordinary
 * variable (`(start)-[:NEXT]->(end)`). The two forms that can follow a SHOW
 * clause (`TERMINATE TRANSACTIONS`) are matched as pairs below.
 */
const ADMIN_STARTS = new Set(['ALTER', 'GRANT', 'DENY', 'REVOKE', 'START', 'STOP', 'RENAME', 'TERMINATE', 'ENABLE', 'DISABLE', 'ALLOCATE', 'DEALLOCATE', 'REALLOCATE', 'DRYRUN']);

/** Word pairs that are administration commands wherever they appear. */
const ADMIN_PAIRS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
	['TERMINATE', new Set(['TRANSACTION', 'TRANSACTIONS'])],
	['START', new Set(['DATABASE', 'SERVER'])],
	['STOP', new Set(['DATABASE', 'SERVER'])],
	['RENAME', new Set(['ROLE', 'USER', 'DATABASE', 'SERVER'])],
];

/** Words allowed between SHOW and its target (`SHOW ALL UNIQUE CONSTRAINTS`): the node's `_SHOW_MODIFIERS`. */
export const SHOW_MODIFIERS: ReadonlySet<string> = new Set(['ALL', 'BTREE', 'RANGE', 'TEXT', 'POINT', 'LOOKUP', 'FULLTEXT', 'VECTOR', 'UNIQUE', 'NODE', 'RELATIONSHIP', 'EXISTENCE', 'EXIST', 'KEY', 'PROPERTY', 'TYPE', 'BUILT', 'IN', 'USER', 'DEFINED']);

/**
 * What SHOW may list and still count as a read of schema objects: the node's `_SHOW_ALLOWED`. The node's read path
 * refuses every other SHOW (`SHOW TRANSACTIONS`, `SHOW DATABASES`, `SHOW SETTINGS`), so those go to the write console.
 */
export const SHOW_TARGETS: ReadonlySet<string> = new Set(['INDEX', 'INDEXES', 'CONSTRAINT', 'CONSTRAINTS', 'PROCEDURE', 'PROCEDURES', 'FUNCTION', 'FUNCTIONS']);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Upper-cased text of a word token, or '' for anything else.
 *
 * @param token - A code token (may be undefined past the end).
 * @returns The upper-cased word, or ''.
 */
function upperWord(token: IToken | undefined): string {
	return token && token.kind === 'word' ? token.text.toUpperCase() : '';
}

/**
 * Whether a token is the given punctuation.
 *
 * @param token - A code token (may be undefined past the end).
 * @param text - The punctuation text.
 * @returns True on a match.
 */
function isPunct(token: IToken | undefined, text: string): boolean {
	return !!token && token.kind === 'punct' && token.text === text;
}

/**
 * Whether a word at index `i` is in CLAUSE position, i.e. could be a keyword
 * rather than a property name, a label or type, or a map key.
 *
 * @param tokens - The statement's code tokens.
 * @param i - Index of a word token.
 * @returns True when the word may be a keyword.
 */
function inClausePosition(tokens: IToken[], i: number): boolean {
	const prev = tokens[i - 1];
	if (isPunct(prev, '.') || isPunct(prev, ':')) return false;
	if (isPunct(tokens[i + 1], ':') && (isPunct(prev, '{') || isPunct(prev, ','))) return false;
	return true;
}

/**
 * Whether a SHOW statement lists schema objects the app treats as a read.
 *
 * @param tokens - The statement's code tokens (the first is SHOW).
 * @returns True for a supported read SHOW.
 */
function isReadShow(tokens: IToken[]): boolean {
	let i = 1;
	while (SHOW_MODIFIERS.has(upperWord(tokens[i]))) i += 1;
	return SHOW_TARGETS.has(upperWord(tokens[i]));
}

/**
 * Read the procedure name that follows a CALL, or report that the CALL opens a
 * subquery (`CALL { ... }`, `CALL (n) { ... }`).
 *
 * @param tokens - The statement's code tokens.
 * @param callIndex - Index of the CALL word.
 * @returns The unquoted name parts and their source span, `'subquery'`, or null when no name follows.
 */
function readCallTarget(tokens: IToken[], callIndex: number): 'subquery' | { parts: string[]; end: number } | null {
	let j = callIndex + 1;
	const first = tokens[j];
	if (isPunct(first, '{') || isPunct(first, '(')) return 'subquery';
	if (!first || (first.kind !== 'word' && first.kind !== 'backtick')) return null;
	const parts: string[] = [];
	for (;;) {
		parts.push(nameOf(tokens[j]));
		const dot = tokens[j + 1];
		const next = tokens[j + 2];
		if (isPunct(dot, '.') && next && (next.kind === 'word' || next.kind === 'backtick')) {
			j += 2;
			continue;
		}
		return { parts, end: tokens[j].end };
	}
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Classify one statement by its text.
 *
 * @param text - One statement (as produced by the splitter).
 * @returns The kind, the constructs that made it a write, and its leading verb.
 */
export function classifyStatement(text: string): IClassification {
	const all = tokenize(text);
	const tokens = codeTokens(all);
	if (tokens.length === 0) return { kind: 'empty', findings: [], verb: '' };

	const findings: IFinding[] = [];
	const first = upperWord(tokens[0]);
	const verb = first === 'OPTIONAL' && upperWord(tokens[1]) === 'MATCH' ? 'OPTIONAL MATCH' : first || tokens[0].text.toUpperCase();

	// Delimited tokens that never closed: the text is not a whole statement.
	for (const token of all) {
		if (token.unterminated) {
			const what = token.kind === 'string' ? 'unterminated string' : token.kind === 'backtick' ? 'unterminated quoted name' : 'unterminated comment';
			findings.push({ reason: 'malformed', word: what, start: token.start, end: token.end });
		}
	}

	// Rule 1: the statement must start with a read clause.
	const startsRead = READ_STARTS.has(first) || (first === 'OPTIONAL' && upperWord(tokens[1]) === 'MATCH') || (first === 'SHOW' && isReadShow(tokens)) || first === 'CALL';

	// Rule 2: scan every code token for write and administration constructs.
	if (ADMIN_STARTS.has(first)) findings.push({ reason: 'admin-command', word: tokens[0].text, start: tokens[0].start, end: tokens[0].end });
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind !== 'word' || !inClausePosition(tokens, i)) continue;
		const word = token.text.toUpperCase();

		if (word === 'DELETE' && upperWord(tokens[i - 1]) === 'DETACH') {
			// Already reported together with its DETACH.
		} else if (word === 'DETACH' && upperWord(tokens[i + 1]) === 'DELETE') {
			findings.push({ reason: 'write-clause', word: `${token.text} ${tokens[i + 1].text}`, start: token.start, end: tokens[i + 1].end });
		} else if (WRITE_WORDS.has(word)) {
			findings.push({ reason: 'write-clause', word: token.text, start: token.start, end: token.end });
		} else if (word === 'LOAD' && upperWord(tokens[i + 1]) === 'CSV') {
			findings.push({ reason: 'load-csv', word: `${token.text} ${tokens[i + 1].text}`, start: token.start, end: tokens[i + 1].end });
		} else if (i > 0) {
			// Pair forms count mid-statement; the first word was handled above.
			for (const [lead, followers] of ADMIN_PAIRS) {
				if (word === lead && followers.has(upperWord(tokens[i + 1]))) {
					findings.push({ reason: 'admin-command', word: `${token.text} ${tokens[i + 1].text}`, start: token.start, end: tokens[i + 1].end });
				}
			}
		}

		if (word === 'CALL') {
			const target = readCallTarget(tokens, i);
			if (target === 'subquery') continue;
			if (target === null) {
				findings.push({ reason: 'call', word: 'CALL', start: token.start, end: token.end });
			} else if (!isVettedProcedure(target.parts)) {
				findings.push({ reason: 'call', word: `CALL ${target.parts.join('.')}`, start: token.start, end: target.end });
			}
		}
	}

	// A start that is neither a read clause nor an already-named write or admin
	// command (`EXPLAIN`, `USE`, `SHOW USERS`, plain garbage) is reported as
	// unrecognised; one that IS a named command (`CREATE ...`) is not reported
	// twice.
	if (!startsRead && !findings.some((f) => f.reason !== 'malformed')) {
		findings.unshift({ reason: 'unrecognized-start', word: tokens[0].text, start: tokens[0].start, end: tokens[0].end });
	}

	return { kind: findings.length === 0 ? 'read' : 'write', findings, verb };
}

/**
 * Shorthand for {@link classifyStatement}'s kind.
 *
 * @param text - One statement.
 * @returns `read`, `write` or `empty`.
 */
export function statementKind(text: string): StatementKind {
	return classifyStatement(text).kind;
}

/**
 * The leading verb of a statement, for labels (`MATCH`, `OPTIONAL MATCH`, ...).
 *
 * @param text - One statement.
 * @returns The upper-cased verb, or '' for an empty statement.
 */
export function leadingVerb(text: string): string {
	return classifyStatement(text).verb;
}

/**
 * The pattern check: whether the statement needs the write confirmation, and
 * how to say what was seen. Phrased for the dialog sentence
 * `Pattern check: <kind> detected.`.
 *
 * @param text - One statement.
 * @returns The finding, or null for a read or an empty statement.
 */
export function patternCheck(text: string): IPatternFinding | null {
	const { kind, findings } = classifyStatement(text);
	if (kind !== 'write') return null;
	const seen: string[] = [];
	for (const finding of findings) {
		const label =
			finding.reason === 'unrecognized-start'
				? `unrecognized statement (${finding.word.toUpperCase()})`
				: finding.reason === 'malformed'
					? finding.word
					: finding.reason === 'call'
						? finding.word.replace(/^call\b/i, 'CALL')
						: finding.word.toUpperCase();
		if (!seen.includes(label)) seen.push(label);
	}
	return { kind: seen.join(', ') };
}
