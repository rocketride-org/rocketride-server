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
// CYPHER - LEXER
// =============================================================================
//
// A small, total lexer for Cypher text. It never throws and never loses a
// character: every offset of the input belongs to exactly one token, so
// concatenating the token texts reproduces the input. That property is what the
// splitter and the classifier build on, and it is asserted by the tests.
//
// Why a Cypher lexer of our own: SQL Explorer's lexer treats `--` as a line
// comment, which in Cypher is a relationship pattern (`(a)--(b)`). Here `--` is
// two ordinary `-` punctuation tokens, and the only comments are `//` to end of
// line and `/* ... */`.
//
// What it recognises (and nothing more):
//   - `//` line comments and `/* */` block comments (not nested)
//   - single- and double-quoted strings with backslash escapes
//   - backtick-quoted names, where a doubled backtick is a literal backtick
//   - words (Unicode identifiers), numbers, `$parameters`
//   - `;` as its own token, so a semicolon inside a string, comment or backtick
//     name can never be mistaken for a statement separator
//
// Compatibility: no regular-expression lookbehind anywhere (the app declares a
// Safari 13 floor). Unicode identifier classes use `\p{...}` with the `u` flag,
// which every supported engine has had since 2018.
//
// This module is a courtesy for the editor (statement boundaries, a text check
// before sending). It is NOT a security boundary: the database role and the
// node's own read path are.
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

/** The kinds of token the lexer emits. */
export type TokenKind =
	| 'space' // whitespace run
	| 'lineComment' // `// ...` up to (not including) the line break
	| 'blockComment' // `/* ... */`
	| 'string' // '...' or "..." (quotes included)
	| 'backtick' // `...` (backticks included)
	| 'word' // identifier or keyword
	| 'number' // integer, float, hex
	| 'param' // $name, $0, $`quoted`
	| 'semicolon' // ;
	| 'punct'; // everything else, one character (or `..`)

/** One token with the offsets it occupies in the source. */
export interface IToken {
	/** What the token is. */
	kind: TokenKind;
	/** The exact source text of the token. */
	text: string;
	/** Offset of the first character. */
	start: number;
	/** Offset one past the last character. */
	end: number;
	/** True for a string, block comment or backtick name that never closed. */
	unterminated?: boolean;
}

// =============================================================================
// CHARACTER CLASSES
// =============================================================================

/** First character of a word: Unicode ID_Start or underscore. */
const WORD_START = /^[\p{ID_Start}_]$/u;

/** Later characters of a word: Unicode ID_Continue, `$`, joiners. */
const WORD_CONTINUE = /^[\p{ID_Continue}$‌‍]$/u;

/**
 * Read the code point starting at `i` (surrogate pairs stay whole).
 *
 * @param src - The source text.
 * @param i - Offset of the first UTF-16 unit.
 * @returns The code point as a string (one or two UTF-16 units).
 */
function codePointAt(src: string, i: number): string {
	const first = src.charCodeAt(i);
	if (first >= 0xd800 && first <= 0xdbff && i + 1 < src.length) {
		const second = src.charCodeAt(i + 1);
		if (second >= 0xdc00 && second <= 0xdfff) return src.slice(i, i + 2);
	}
	return src[i];
}

/**
 * Whether a code point can start a word.
 *
 * @param ch - One code point.
 * @returns True when it can.
 */
function isWordStart(ch: string): boolean {
	return WORD_START.test(ch);
}

/**
 * Whether a code point can continue a word.
 *
 * @param ch - One code point.
 * @returns True when it can.
 */
function isWordContinue(ch: string): boolean {
	return WORD_CONTINUE.test(ch);
}

/**
 * Whether the character is ASCII whitespace or a Unicode space.
 *
 * @param ch - One UTF-16 unit.
 * @returns True for whitespace.
 */
function isSpace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ' || ch === ' ' || ch === ' ' || ch === '﻿' || (ch >= ' ' && ch <= ' ') || ch === ' ' || ch === ' ' || ch === ' ' || ch === '　';
}

/**
 * Whether the character is a decimal digit.
 *
 * @param ch - One UTF-16 unit (may be undefined past the end).
 * @returns True for 0-9.
 */
function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * Whether the character is a hexadecimal digit.
 *
 * @param ch - One UTF-16 unit (may be undefined past the end).
 * @returns True for 0-9 a-f A-F.
 */
function isHexDigit(ch: string | undefined): boolean {
	return ch !== undefined && ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F'));
}

// =============================================================================
// SCANNERS (each returns the offset one past the token)
// =============================================================================

/**
 * Scan a quoted string. A backslash makes the next character ordinary, so an
 * escaped quote does not end the string. An unterminated string runs to the end
 * of the input.
 *
 * @param src - The source text.
 * @param start - Offset of the opening quote.
 * @returns The end offset and whether the string closed.
 */
function scanString(src: string, start: number): { end: number; closed: boolean } {
	const quote = src[start];
	let i = start + 1;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === quote) return { end: i + 1, closed: true };
		i += 1;
	}
	return { end: src.length, closed: false };
}

/**
 * Scan a backtick-quoted name. A doubled backtick is a literal backtick and
 * does not end the name.
 *
 * @param src - The source text.
 * @param start - Offset of the opening backtick.
 * @returns The end offset and whether the name closed.
 */
function scanBacktick(src: string, start: number): { end: number; closed: boolean } {
	let i = start + 1;
	while (i < src.length) {
		if (src[i] === '`') {
			if (src[i + 1] === '`') {
				i += 2;
				continue;
			}
			return { end: i + 1, closed: true };
		}
		i += 1;
	}
	return { end: src.length, closed: false };
}

/**
 * Scan a number: decimal with optional fraction and exponent, or hexadecimal.
 * A `.` only joins the number when a digit follows it, so the `..` of a
 * variable-length pattern (`[*1..3]`) is left alone.
 *
 * @param src - The source text.
 * @param start - Offset of the first digit.
 * @returns The end offset.
 */
function scanNumber(src: string, start: number): number {
	let i = start;
	if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X') && isHexDigit(src[i + 2])) {
		i += 2;
		while (isHexDigit(src[i])) i += 1;
		return i;
	}
	while (isDigit(src[i])) i += 1;
	if (src[i] === '.' && isDigit(src[i + 1])) {
		i += 1;
		while (isDigit(src[i])) i += 1;
	}
	if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1]) || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2])))) {
		i += 2;
		while (isDigit(src[i])) i += 1;
	}
	return i;
}

/**
 * Scan a word (identifier or keyword).
 *
 * @param src - The source text.
 * @param start - Offset of the first character.
 * @returns The end offset.
 */
function scanWord(src: string, start: number): number {
	let i = start;
	while (i < src.length) {
		const ch = codePointAt(src, i);
		if (i !== start && !isWordContinue(ch)) break;
		if (i === start && !isWordStart(ch)) break;
		i += ch.length;
	}
	return i;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Tokenise Cypher text. Total: every input yields tokens that cover it exactly.
 *
 * @param src - The Cypher text.
 * @returns Every token, trivia (whitespace and comments) included.
 */
export function tokenize(src: string): IToken[] {
	const tokens: IToken[] = [];
	let i = 0;

	/**
	 * Record a token ending at `end`.
	 *
	 * @param kind - Token kind.
	 * @param start - Start offset.
	 * @param end - End offset (exclusive).
	 * @param unterminated - Set when a delimited token never closed.
	 */
	const push = (kind: TokenKind, start: number, end: number, unterminated?: boolean): void => {
		const token: IToken = { kind, text: src.slice(start, end), start, end };
		if (unterminated) token.unterminated = true;
		tokens.push(token);
		i = end;
	};

	while (i < src.length) {
		const ch = src[i];

		if (isSpace(ch)) {
			let j = i + 1;
			while (j < src.length && isSpace(src[j])) j += 1;
			push('space', i, j);
			continue;
		}

		if (ch === '/' && src[i + 1] === '/') {
			let j = i + 2;
			while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j += 1;
			push('lineComment', i, j);
			continue;
		}

		if (ch === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			if (close === -1) push('blockComment', i, src.length, true);
			else push('blockComment', i, close + 2);
			continue;
		}

		if (ch === "'" || ch === '"') {
			const { end, closed } = scanString(src, i);
			push('string', i, end, !closed);
			continue;
		}

		if (ch === '`') {
			const { end, closed } = scanBacktick(src, i);
			push('backtick', i, end, !closed);
			continue;
		}

		if (ch === ';') {
			push('semicolon', i, i + 1);
			continue;
		}

		if (ch === '$') {
			// $name, $0, $`quoted name`; a lone `$` is punctuation.
			const next = src[i + 1];
			if (next === '`') {
				const { end, closed } = scanBacktick(src, i + 1);
				push('param', i, end, !closed);
				continue;
			}
			if (isDigit(next)) {
				let j = i + 1;
				while (isDigit(src[j])) j += 1;
				push('param', i, j);
				continue;
			}
			if (next !== undefined && isWordStart(codePointAt(src, i + 1))) {
				push('param', i, scanWord(src, i + 1));
				continue;
			}
			push('punct', i, i + 1);
			continue;
		}

		if (isDigit(ch)) {
			push('number', i, scanNumber(src, i));
			continue;
		}

		const cp = codePointAt(src, i);
		if (isWordStart(cp)) {
			push('word', i, scanWord(src, i));
			continue;
		}

		if (ch === '.' && src[i + 1] === '.') {
			push('punct', i, i + 2);
			continue;
		}

		// Any other character (operators, brackets, an unknown symbol, a lone
		// surrogate) is one punctuation token, so coverage stays total.
		push('punct', i, i + cp.length);
	}

	return tokens;
}

/**
 * The tokens that carry meaning: everything except whitespace and comments.
 *
 * @param tokens - The output of {@link tokenize}.
 * @returns The code tokens, in order.
 */
export function codeTokens(tokens: IToken[]): IToken[] {
	return tokens.filter((t) => t.kind !== 'space' && t.kind !== 'lineComment' && t.kind !== 'blockComment');
}

/**
 * The source with every comment replaced by a single space, leaving strings and
 * backtick names untouched.
 *
 * @param src - The Cypher text.
 * @returns The text without comments.
 */
export function stripComments(src: string): string {
	return tokenize(src)
		.map((t) => (t.kind === 'lineComment' || t.kind === 'blockComment' ? ' ' : t.text))
		.join('');
}

/**
 * The text of a backtick name or a bare word, unquoted: the surrounding
 * backticks are removed and each doubled backtick becomes one.
 *
 * @param token - A `word` or `backtick` token.
 * @returns The name the token denotes.
 */
export function nameOf(token: IToken): string {
	if (token.kind !== 'backtick') return token.text;
	const body = token.text.length >= 2 && !token.unterminated ? token.text.slice(1, -1) : token.text.slice(1);
	return body.split('``').join('`');
}
