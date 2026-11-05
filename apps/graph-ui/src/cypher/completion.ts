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
// CYPHER - AUTOCOMPLETE (pure: what to suggest at the caret)
// =============================================================================
//
// Decides the context from the lexer's tokens before the caret, so a string, a
// comment or a quoted name is never mistaken for code:
//
//   (x:  [x:  [:  :A|     labels, or relationship types inside a relationship's [ ]
//   x.                    the properties of x's label when x is bound in a pattern of
//                         the same statement ((x:Person) or [x:KNOWS]); otherwise
//                         every property key the schema knows
//   statement start       clause keywords and a few snippets
//   after a typed word    the clauses that can follow
//
// The schema is what the last load returned: property keys are SAMPLED (a few
// rows per label), so every property suggestion says so. Names are inserted
// quoted when they need it; an engine that cannot take a quoted name (AGE) is
// never offered one.
// =============================================================================

import { codeTokens, tokenize } from './lexer';
import type { IToken } from './lexer';
import { quoteIdentifier } from './quote';
import type { GraphDialect } from './quote';
import { countText } from '../graph/schema';
import type { ISchemaProperty, ISchemaView } from '../graph/schema';

// =============================================================================
// TYPES
// =============================================================================

/** What suggestions are made from. */
export interface ICompletionModel {
	/** The connection's loaded schema; null when none is loaded yet. */
	schema: ISchemaView | null;
	/** The engine, which decides how a name is quoted; null when not known. */
	dialect: GraphDialect | null;
	/** True in the write console, which is also offered the write clauses. */
	writes?: boolean;
}

/** What a suggestion is. */
export type CandidateKind = 'label' | 'type' | 'property' | 'keyword' | 'snippet';

/** One suggestion. */
export interface ICandidate {
	/** What the list shows and filters on. */
	label: string;
	kind: CandidateKind;
	/** What replaces the word being typed. */
	insertText: string;
	/** True when {@link insertText} uses snippet syntax (`${1:n}`). */
	snippet?: boolean;
	/** The short line beside the label. */
	detail: string;
	/** The longer text in the details pane. */
	documentation?: string;
	/** Orders the list: kinds in the order they are likely wanted, then the schema's order. */
	sortText: string;
}

// =============================================================================
// WORDS
// =============================================================================

/** Clauses a statement can start with in the read workbench. */
const START_READS = ['MATCH', 'OPTIONAL MATCH', 'WITH', 'UNWIND', 'RETURN'];

/** The write clauses, offered in the write console only. */
const START_WRITES = ['CREATE', 'MERGE', 'SET', 'DELETE', 'DETACH DELETE', 'REMOVE'];

/** What can follow once a statement has begun (read words only). */
const CONTINUATIONS = ['WHERE', 'RETURN', 'WITH', 'MATCH', 'OPTIONAL MATCH', 'UNWIND', 'ORDER BY', 'SKIP', 'LIMIT', 'DISTINCT', 'AS', 'ASC', 'DESC', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'STARTS WITH', 'ENDS WITH', 'CONTAINS', 'UNION', 'CASE'];

/** A few whole statements, as snippets. */
const SNIPPETS: ReadonlyArray<readonly [string, string, string]> = [
	['MATCH (n) RETURN n LIMIT 25', 'MATCH (${1:n}) RETURN ${1:n} LIMIT ${2:25}', 'Return a few nodes'],
	['MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 25', 'MATCH (${1:a})-[${2:r}]->(${3:b}) RETURN ${1:a}, ${2:r}, ${3:b} LIMIT ${4:25}', 'Return a few relationships with both ends'],
	['MATCH (n) RETURN count(n) AS nodes', 'MATCH (${1:n}) RETURN count(${1:n}) AS ${2:nodes}', 'Count nodes'],
];

/** A name that needs no quoting in any engine. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Sort rank per kind: the first character of `sortText`. */
const RANK: Record<CandidateKind, string> = { label: '0', type: '0', property: '0', snippet: '1', keyword: '2' };

// =============================================================================
// TOKENS BEFORE THE CARET
// =============================================================================

/**
 * Whether the caret sits inside a string, a comment or a quoted name that has not closed (nothing is suggested there).
 *
 * @param tokens - Every token of the text before the caret.
 * @param length - The length of that text.
 * @returns True when the caret is inside one.
 */
function insideLiteral(tokens: readonly IToken[], length: number): boolean {
	const last = tokens[tokens.length - 1];
	if (!last || last.end !== length) return false;
	if (last.kind === 'lineComment') return true;
	return (last.kind === 'string' || last.kind === 'backtick' || last.kind === 'blockComment') && last.unterminated === true;
}

/**
 * The name a word or backtick token stands for.
 *
 * @param token - A token.
 * @returns The name, or null for any other token.
 */
function nameOf(token: IToken | undefined): string | null {
	if (!token) return null;
	if (token.kind === 'word') return token.text;
	if (token.kind === 'backtick' && !token.unterminated) return token.text.slice(1, -1).split('``').join('`');
	return null;
}

/**
 * Whether a token is the given punctuation.
 *
 * @param token - A token.
 * @param text - The punctuation.
 * @returns True when it is.
 */
function isPunct(token: IToken | undefined, text: string): boolean {
	return token !== undefined && token.kind === 'punct' && token.text === text;
}

/**
 * The bracket that is still open at a token: the nearest `(`, `[` or `{` not yet closed, and the token before it.
 *
 * @param tokens - The statement's code tokens.
 * @param before - Index of the last token to consider.
 * @returns The opener's index and text, or null when none is open.
 */
function openBracket(tokens: readonly IToken[], before: number): { index: number; text: string } | null {
	let depth = 0;
	for (let i = before; i >= 0; i--) {
		const token = tokens[i];
		if (token.kind !== 'punct') continue;
		if (token.text === ')' || token.text === ']' || token.text === '}') depth += 1;
		else if (token.text === '(' || token.text === '[' || token.text === '{') {
			if (depth === 0) return { index: i, text: token.text };
			depth -= 1;
		}
	}
	return null;
}

/**
 * The labels or relationship types a variable is bound to in the statement: `(x:A:B`, `(x:A|B`, `[x:T`.
 *
 * @param tokens - The statement's code tokens.
 * @param variable - The variable's name.
 * @returns The names bound, in order of appearance, and which kind of pattern bound them.
 */
function bindings(tokens: readonly IToken[], variable: string): { names: string[]; pattern: 'node' | 'relationship' | null } {
	const names: string[] = [];
	let pattern: 'node' | 'relationship' | null = null;
	for (let i = 1; i + 2 < tokens.length; i++) {
		const open = tokens[i - 1];
		if (!(isPunct(open, '(') || isPunct(open, '[')) || nameOf(tokens[i]) !== variable || !isPunct(tokens[i + 1], ':')) continue;
		const kind = open.text === '(' ? 'node' : 'relationship';
		let at = i + 1;
		while (at + 1 < tokens.length && (isPunct(tokens[at], ':') || isPunct(tokens[at], '|') || isPunct(tokens[at], '&'))) {
			const name = nameOf(tokens[at + 1]);
			if (name === null) break;
			if (!names.includes(name)) names.push(name);
			at += 2;
		}
		pattern = kind;
	}
	return { names, pattern };
}

// =============================================================================
// CANDIDATES
// =============================================================================

/**
 * How a name is written into a query, or null when the engine cannot take it.
 *
 * @param name - A label, type or property key.
 * @param dialect - The engine, or null.
 * @returns The text to insert.
 */
function written(name: string, dialect: GraphDialect | null): string | null {
	if (PLAIN_NAME.test(name)) return name;
	// Until the engine is known, only names that need no quoting: AGE cannot take a quoted one.
	return dialect === null ? null : quoteIdentifier(name, dialect);
}

/**
 * Plural-aware noun for a count.
 *
 * @param count - The count.
 * @param estimated - Whether it is an estimate.
 * @param singular - The noun.
 * @returns For example `about 2 nodes`, or '' when there is no count.
 */
function counted(count: number | null, estimated: boolean, singular: string): string {
	if (count === null) return '';
	return `${countText(count, estimated)} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * The labels as suggestions.
 *
 * @param model - What suggestions are made from.
 * @returns One per label the engine can take.
 */
function labelCandidates(model: ICompletionModel): ICandidate[] {
	const out: ICandidate[] = [];
	for (const label of model.schema?.labels ?? []) {
		const insertText = written(label.name, model.dialect);
		if (insertText === null) continue;
		const count = counted(label.count, label.countEstimated, 'node');
		out.push({ label: label.name, kind: 'label', insertText, detail: count ? `label · ${count}` : 'label', sortText: `${RANK.label}${String(out.length).padStart(4, '0')}` });
	}
	return out;
}

/**
 * The relationship types as suggestions.
 *
 * @param model - What suggestions are made from.
 * @returns One per type the engine can take.
 */
function typeCandidates(model: ICompletionModel): ICandidate[] {
	const out: ICandidate[] = [];
	for (const type of model.schema?.relationshipTypes ?? []) {
		const insertText = written(type.type, model.dialect);
		if (insertText === null) continue;
		const seen = type.endpoints.filter((e) => e.observed);
		const ends = (seen.length > 0 ? seen : type.endpoints).map((e) => `${e.start} -> ${e.end}`).join('; ');
		out.push({ label: type.type, kind: 'type', insertText, detail: ends ? `relationship · ${ends}` : 'relationship', sortText: `${RANK.type}${String(out.length).padStart(4, '0')}` });
	}
	return out;
}

/**
 * The property keys of some labels or relationship types, merged by name, as suggestions.
 *
 * @param model - What suggestions are made from.
 * @param lists - The property lists to merge.
 * @param documentation - The details-pane text.
 * @returns One per key the engine can take, in name order.
 */
function propertyCandidates(model: ICompletionModel, lists: ReadonlyArray<readonly ISchemaProperty[]>, documentation: string): ICandidate[] {
	const merged = new Map<string, string[]>();
	for (const list of lists) {
		for (const property of list) {
			const types = merged.get(property.name) ?? [];
			for (const type of property.types) if (!types.includes(type)) types.push(type);
			merged.set(property.name, types);
		}
	}
	const out: ICandidate[] = [];
	for (const name of [...merged.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
		const insertText = written(name, model.dialect);
		if (insertText === null) continue;
		const types = merged.get(name) ?? [];
		out.push({ label: name, kind: 'property', insertText, detail: types.length > 0 ? `${types.join(' | ')} · sampled` : 'sampled', documentation, sortText: `${RANK.property}${String(out.length).padStart(4, '0')}` });
	}
	return out;
}

/**
 * The properties after `variable.`.
 *
 * @param model - What suggestions are made from.
 * @param statement - The statement's code tokens.
 * @param variable - The variable before the dot.
 * @returns The suggestions.
 */
function propertiesOf(model: ICompletionModel, statement: readonly IToken[], variable: string): ICandidate[] {
	const schema = model.schema;
	if (!schema) return [];
	const bound = bindings(statement, variable);
	if (bound.pattern === 'node') {
		const known = schema.labels.filter((l) => bound.names.includes(l.name));
		if (known.length > 0) {
			const names = known.map((l) => l.name);
			return propertyCandidates(model, known.map((l) => l.properties), `${names.join(', ')} properties · ${variable} is (:${names.join(':')}) · sampled`);
		}
	}
	if (bound.pattern === 'relationship') {
		const known = schema.relationshipTypes.filter((t) => bound.names.includes(t.type));
		if (known.length > 0) {
			const names = known.map((t) => t.type);
			return propertyCandidates(model, known.map((t) => t.properties), `${names.join(', ')} properties · ${variable} is [:${names.join('|')}] · sampled`);
		}
	}
	return propertyCandidates(model, [...schema.labels.map((l) => l.properties), ...schema.relationshipTypes.map((t) => t.properties)], 'Every property key the schema lists · sampled');
}

/**
 * The clause keywords and snippets for a position.
 *
 * @param model - What suggestions are made from.
 * @param atStart - True at the start of a statement.
 * @param typed - True when a word is being typed.
 * @returns The suggestions.
 */
function keywordCandidates(model: ICompletionModel, atStart: boolean, typed: boolean): ICandidate[] {
	if (!atStart && !typed) return [];
	const words = atStart ? (model.writes ? [...START_READS, ...START_WRITES] : START_READS) : CONTINUATIONS;
	const out: ICandidate[] = words.map((word, i) => ({ label: word, kind: 'keyword', insertText: word, detail: 'clause', sortText: `${RANK.keyword}${String(i).padStart(4, '0')}` }));
	if (atStart) {
		SNIPPETS.forEach(([label, insertText, detail], i) => out.push({ label, kind: 'snippet', insertText, snippet: true, detail, sortText: `${RANK.snippet}${String(i).padStart(4, '0')}` }));
	}
	return out;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * What to suggest at the caret.
 *
 * @param model - The schema and engine suggestions are made from.
 * @param before - The editor text before the caret.
 * @returns The suggestions, unfiltered (the editor filters them by the word being typed); none inside a string or comment.
 */
export function suggestAt(model: ICompletionModel, before: string): ICandidate[] {
	const all = tokenize(before);
	if (insideLiteral(all, before.length)) return [];
	const code = codeTokens(all);
	// The word being typed is not context: what comes before it is.
	const last = code[code.length - 1];
	const typed = last !== undefined && last.kind === 'word' && last.end === before.length;
	const context = typed ? code.slice(0, -1) : code;
	// Only the current statement: tokens after the last `;`.
	let from = 0;
	for (let i = context.length - 1; i >= 0; i--) {
		if (context[i].kind === 'semicolon') {
			from = i + 1;
			break;
		}
	}
	const statement = context.slice(from);
	const prev = statement[statement.length - 1];
	if (!prev) return keywordCandidates(model, true, typed);

	if (isPunct(prev, ':') || isPunct(prev, '|')) {
		const open = openBracket(statement, statement.length - 2);
		if (open === null) return isPunct(prev, ':') && nameOf(statement[statement.length - 2]) !== null ? labelCandidates(model) : [];
		if (open.text === '(') return labelCandidates(model);
		if (open.text === '[' && isPunct(statement[open.index - 1], '-')) return typeCandidates(model);
		return [];
	}
	if (isPunct(prev, '.')) {
		const variable = nameOf(statement[statement.length - 2]);
		if (variable === null || isPunct(statement[statement.length - 3], '.')) return [];
		return propertiesOf(model, statement, variable);
	}
	return keywordCandidates(model, false, typed);
}
