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
// VECTOR-UI — SAFE MARKDOWN (chat answers)
// =============================================================================
//
// A chat answer is model output written over the stored documents, so it is
// untrusted text. This module parses a safe subset of Markdown into a small
// node tree that src/chat/Markdown.tsx renders with plain React elements:
//
//   - HTML in the answer is TEXT. There is no node type that carries markup,
//     and nothing is ever inserted as HTML.
//   - No image is ever loaded: `![alt](src)` becomes its alt text, whatever
//     the source (remote, data: or relative).
//   - Links go only to http, https and mailto (`safeHref`); every link node
//     carries rel="noopener noreferrer nofollow" and opens in a new tab. A link
//     to anything else keeps its text and loses the link.
//   - Fenced code is shown as code; the fence's language is only a label.
//
// Supported: paragraphs, ATX headings, fenced code, block quotes, bullet and
// ordered lists (nested by indentation), GFM tables, thematic breaks, emphasis,
// strong, strikethrough, inline code, links, autolinks, bare http(s) URLs,
// backslash escapes, character references and hard breaks. Everything else
// renders as text.
//
// Hostile input cannot stall the page: the input is capped
// (MARKDOWN_MAX_CHARS), nesting is capped, no regular expression here can
// backtrack over a run of characters more than once (block shapes are read
// by hand), and the delimiter searches of one answer share a budget
// proportional to its length; once it is spent, the rest of the answer is
// plain text. The parse is therefore linear in the answer's length.
// No regex lookbehind (the app supports Safari 13). No platform imports.
// =============================================================================

/** rel of every link an answer renders. */
export const LINK_REL = 'noopener noreferrer nofollow';

/** Default cap on the characters of one answer that are parsed (the rest is cut, with an ellipsis). */
export const MARKDOWN_MAX_CHARS = 40_000;

/** Deepest block nesting (quotes, lists) parsed as structure; deeper input is text. */
const MAX_BLOCK_DEPTH = 8;

/** Deepest inline nesting (emphasis, link text) parsed as structure. */
const MAX_INLINE_DEPTH = 12;

/** Furthest a closing delimiter or bracket is searched for. */
const MAX_SPAN = 2_000;

/** Table caps. */
const MAX_TABLE_COLUMNS = 50;
const MAX_TABLE_ROWS = 500;

/**
 * Characters the delimiter searches of one answer may visit, per character of
 * the answer. A search that finds no closer costs up to MAX_SPAN, so an answer
 * full of openers that are never closed would otherwise cost length × MAX_SPAN.
 * Ordinary answers use a small fraction of this.
 */
const SEARCH_STEPS_PER_CHAR = 16;

/**
 * Search steps left in the parse in progress. parseMarkdown sets it before
 * parsing and restores it after (parsing is synchronous); once it is spent,
 * every further search reports "no closer" and the rest is plain text.
 */
let searchBudget = 0;

/**
 * Pay for a search.
 *
 * @param steps - Characters it visited.
 */
function spend(steps: number): void {
	searchBudget -= Math.max(1, steps);
}

/**
 * Whether one is a space or a tab.
 *
 * @param ch - One character, or undefined.
 * @returns True for ' ' and '\t'.
 */
function isBlank(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t';
}

// =============================================================================
// Node types
// =============================================================================

/** Inline nodes. There is deliberately no image and no HTML node. */
export type MdInline = { type: 'text'; text: string } | { type: 'code'; text: string } | { type: 'strong'; children: MdInline[] } | { type: 'em'; children: MdInline[] } | { type: 'del'; children: MdInline[] } | { type: 'link'; href: string; rel: string; children: MdInline[] } | { type: 'break' };

/** Column alignment of a table. */
export type MdAlign = 'left' | 'right' | 'center' | null;

/** Block nodes. */
export type MdBlock = { type: 'paragraph'; children: MdInline[] } | { type: 'heading'; level: number; children: MdInline[] } | { type: 'code'; lang: string | null; text: string } | { type: 'list'; ordered: boolean; start: number; items: MdBlock[][] } | { type: 'quote'; children: MdBlock[] } | { type: 'rule' } | { type: 'table'; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] };

/** Parse options. */
export interface MarkdownOptions {
	/** Characters parsed before the answer is cut with an ellipsis (default {@link MARKDOWN_MAX_CHARS}). */
	maxChars?: number;
}

// =============================================================================
// Links
// =============================================================================

/**
 * The link target an answer may use, or null. Only absolute http(s) URLs with
 * a host and mailto addresses pass; anything with whitespace or control
 * characters inside fails.
 *
 * @param raw - The destination as written.
 * @returns The trimmed destination, or null.
 */
export function safeHref(raw: string): string | null {
	const href = raw.trim();
	if (href === '') return null;
	for (let i = 0; i < href.length; i++) {
		const code = href.charCodeAt(i);
		if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
	}
	if (/^https?:\/\/[^/?#\\]/i.test(href)) return href;
	if (/^mailto:[^@]+@[^@]+$/i.test(href)) return href;
	return null;
}

// =============================================================================
// Character references
// =============================================================================

/** Named references decoded in text (the rest stay as written). */
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
	copy: '\u00a9',
	reg: '\u00ae',
	hellip: '\u2026',
	mdash: '\u2014',
	ndash: '\u2013',
	rsquo: '\u2019',
	lsquo: '\u2018',
	rdquo: '\u201d',
	ldquo: '\u201c',
};

/**
 * Decode one character reference at `text[at] === '&'`.
 *
 * @param text - The text.
 * @param at - Index of '&'.
 * @returns The decoded string and the index after the reference, or null.
 */
function readEntity(text: string, at: number): { value: string; end: number } | null {
	const match = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/.exec(text.slice(at, at + 40));
	if (!match) return null;
	if (match[3] !== undefined) {
		const named = NAMED_ENTITIES[match[3]];
		return named === undefined ? null : { value: named, end: at + match[0].length };
	}
	const code = match[1] !== undefined ? parseInt(match[1], 16) : parseInt(match[2], 10);
	const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
	return { value: valid ? String.fromCodePoint(code) : '\ufffd', end: at + match[0].length };
}

// =============================================================================
// Inline parsing
// =============================================================================

/** ASCII punctuation a backslash may escape. */
const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/**
 * Append text, merging with a preceding text node.
 *
 * @param out - The node list.
 * @param text - The text.
 */
function pushText(out: MdInline[], text: string): void {
	if (text === '') return;
	const last = out[out.length - 1];
	if (last !== undefined && last.type === 'text') last.text += text;
	else out.push({ type: 'text', text });
}

/**
 * Whether a character is a letter or digit (ASCII or not).
 *
 * @param ch - One character, or undefined.
 * @returns True for alphanumerics.
 */
function isAlnum(ch: string | undefined): boolean {
	return ch !== undefined && /[0-9A-Za-z\u00c0-\uffff]/.test(ch);
}

/**
 * Whether a character is whitespace (or absent).
 *
 * @param ch - One character, or undefined.
 * @returns True for whitespace or undefined.
 */
function isSpace(ch: string | undefined): boolean {
	return ch === undefined || /\s/.test(ch);
}

/**
 * The end of a code span starting with a run of backticks at `at`.
 *
 * @param text - The text.
 * @param at - Index of the first backtick.
 * @returns The span's content and end, or null when it is not closed.
 */
function readCodeSpan(text: string, at: number): { content: string; end: number } | null {
	if (searchBudget <= 0) return null;
	let run = 0;
	while (text[at + run] === '`') run++;
	const fence = '`'.repeat(run);
	let search = at + run;
	const limit = Math.min(text.length, at + run + MAX_SPAN);
	while (search < limit) {
		const close = text.indexOf(fence, search);
		if (close < 0 || close >= limit) break;
		// The closing run must be exactly as long.
		if (text[close + run] === '`') {
			search = close + run;
			while (text[search] === '`') search++;
			continue;
		}
		spend(close + run - at);
		let content = text.slice(at + run, close).replace(/\n/g, ' ');
		if (content.length > 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
			content = content.slice(1, -1);
		}
		return { content, end: close + run };
	}
	spend(limit - at);
	return null;
}

/**
 * Index of the bracket that closes `[` at `at`, honouring nesting, escapes and code spans.
 *
 * @param text - The text.
 * @param at - Index of '['.
 * @returns The index of the matching ']', or -1.
 */
function matchBracket(text: string, at: number): number {
	if (searchBudget <= 0) return -1;
	let depth = 0;
	const limit = Math.min(text.length, at + MAX_SPAN);
	let i = at;
	for (; i < limit; i++) {
		const ch = text[i];
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === '`') {
			const span = readCodeSpan(text, i);
			if (span) {
				i = span.end - 1;
				continue;
			}
			while (text[i + 1] === '`') i++;
			continue;
		}
		if (ch === '[') depth++;
		else if (ch === ']') {
			depth--;
			if (depth === 0) {
				spend(i - at);
				return i;
			}
		}
	}
	spend(i - at);
	return -1;
}

/**
 * Index of the parenthesis that closes `(` at `at`, honouring nesting and escapes.
 *
 * @param text - The text.
 * @param at - Index of '('.
 * @returns The index of the matching ')', or -1.
 */
function matchParen(text: string, at: number): number {
	if (searchBudget <= 0) return -1;
	let depth = 0;
	const limit = Math.min(text.length, at + MAX_SPAN);
	let i = at;
	for (; i < limit; i++) {
		const ch = text[i];
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === '\n' && text[i + 1] === '\n') break;
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) {
				spend(i - at);
				return i;
			}
		}
	}
	spend(i - at);
	return -1;
}

/**
 * The destination of an inline link `(dest "title")`: its first token, with
 * `<…>` brackets removed. The title is ignored.
 *
 * @param inner - What sits between the parentheses.
 * @returns The destination as written.
 */
function linkDestination(inner: string): string {
	const trimmed = inner.trim();
	if (trimmed.startsWith('<')) {
		const close = trimmed.indexOf('>');
		return close > 0 ? trimmed.slice(1, close) : trimmed;
	}
	const space = trimmed.search(/\s/);
	return space < 0 ? trimmed : trimmed.slice(0, space);
}

/**
 * Index of the closer of an emphasis delimiter opened at `at`.
 *
 * @param text - The text.
 * @param at - Index of the opener.
 * @param delim - The delimiter ('**', '__', '~~', '*' or '_').
 * @returns The closer's index, or -1.
 */
function findCloser(text: string, at: number, delim: string): number {
	if (searchBudget <= 0) return -1;
	const limit = Math.min(text.length, at + delim.length + MAX_SPAN);
	let i = at + delim.length + 1;
	for (; i < limit; i++) {
		const ch = text[i];
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === '`') {
			const span = readCodeSpan(text, i);
			if (span) {
				i = span.end - 1;
				continue;
			}
		}
		if (!text.startsWith(delim, i)) continue;
		if (isSpace(text[i - 1])) continue;
		if (delim.length === 1) {
			// A single delimiter must not be half of a double one.
			if (text[i + 1] === delim || text[i - 1] === delim) continue;
		}
		if (delim[0] === '_' && isAlnum(text[i + delim.length])) continue;
		spend(i - at);
		return i;
	}
	spend(i - at);
	return -1;
}

/**
 * Where a bare http(s) URL starting at `at` ends (trailing punctuation and
 * unbalanced closing parentheses excluded).
 *
 * @param text - The text.
 * @param at - Index of 'h'.
 * @returns The end index, or -1 when no URL starts here.
 */
function bareUrlEnd(text: string, at: number): number {
	if (searchBudget <= 0) return -1;
	const match = /^https?:\/\/[^\s<>"`]+/i.exec(text.slice(at, at + MAX_SPAN));
	if (!match) return -1;
	const url = match[0];
	spend(url.length);
	let opens = 0;
	let closes = 0;
	for (let i = 0; i < url.length; i++) {
		if (url[i] === '(') opens++;
		else if (url[i] === ')') closes++;
	}
	let end = url.length;
	while (end > 0) {
		const last = url[end - 1];
		if ('.,:;!?\'"*_~'.includes(last)) {
			end--;
			continue;
		}
		if (last === ')' && closes > opens) {
			closes--;
			end--;
			continue;
		}
		break;
	}
	return end > 'https://'.length - 1 ? at + end : -1;
}

/**
 * The autolink `<scheme:…>` or `<name@host.tld>` at `text[at] === '<'`, read
 * by hand: the scan stops at the first '>', '<' or whitespace.
 *
 * @param text - The text.
 * @param at - Index of '<'.
 * @returns The link target, its label and the index after '>', or null.
 */
function readAutolink(text: string, at: number): { href: string; label: string; end: number } | null {
	const limit = Math.min(text.length, at + MAX_SPAN);
	let close = -1;
	for (let i = at + 1; i < limit; i++) {
		const ch = text[i];
		if (ch === '>') {
			close = i;
			break;
		}
		if (ch === '<' || isSpace(ch)) return null;
	}
	if (close < 0) return null;
	const inner = text.slice(at + 1, close);
	let href: string | null;
	if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(inner)) href = safeHref(inner);
	else href = isEmailAddress(inner) ? safeHref(`mailto:${inner}`) : null;
	return href === null ? null : { href, label: inner, end: close + 1 };
}

/**
 * Whether the inside of `<…>` (no whitespace, '<' or '>') is an email
 * address: a local part without '@' or ':', one '@', and a host with a dot
 * that is neither its first nor its last character.
 *
 * @param inner - What sits between the angle brackets.
 * @returns True for an address.
 */
function isEmailAddress(inner: string): boolean {
	const atSign = inner.indexOf('@');
	if (atSign <= 0 || inner.indexOf('@', atSign + 1) >= 0 || inner.lastIndexOf(':', atSign) >= 0) return false;
	const host = inner.slice(atSign + 1);
	const dot = host.indexOf('.', 1);
	return dot > 0 && dot < host.length - 1;
}

/**
 * Parse inline Markdown.
 *
 * @param text - The text of one paragraph, heading or cell.
 * @param depth - Nesting depth.
 * @returns The inline nodes.
 */
function parseInline(text: string, depth = 0): MdInline[] {
	const out: MdInline[] = [];
	if (depth > MAX_INLINE_DEPTH) {
		pushText(out, text);
		return out;
	}
	let i = 0;
	let plainFrom = 0;
	const flush = (until: number): void => {
		pushText(out, text.slice(plainFrom, until));
	};
	while (i < text.length) {
		const ch = text[i];

		// Backslash escapes and hard breaks.
		if (ch === '\\') {
			const next = text[i + 1];
			if (next === '\n') {
				flush(i);
				out.push({ type: 'break' });
				i += 2;
				plainFrom = i;
				continue;
			}
			if (next !== undefined && ESCAPABLE.includes(next)) {
				flush(i);
				pushText(out, next);
				i += 2;
				plainFrom = i;
				continue;
			}
			i++;
			continue;
		}

		// Line breaks: two trailing spaces make a hard break, otherwise a space.
		if (ch === '\n') {
			let end = i;
			while (end > plainFrom && text[end - 1] === ' ') end--;
			flush(end);
			if (i - end >= 2) out.push({ type: 'break' });
			else pushText(out, ' ');
			i++;
			while (text[i] === ' ' || text[i] === '\t') i++;
			plainFrom = i;
			continue;
		}

		// Character references.
		if (ch === '&') {
			const entity = readEntity(text, i);
			if (entity) {
				flush(i);
				pushText(out, entity.value);
				i = entity.end;
				plainFrom = i;
				continue;
			}
			i++;
			continue;
		}

		// Code spans.
		if (ch === '`') {
			const span = readCodeSpan(text, i);
			if (span) {
				flush(i);
				out.push({ type: 'code', text: span.content });
				i = span.end;
				plainFrom = i;
				continue;
			}
			while (text[i] === '`') i++;
			continue;
		}

		// Images: never loaded; the alt text stands in.
		if (ch === '!' && text[i + 1] === '[') {
			const close = matchBracket(text, i + 1);
			if (close > 0 && text[close + 1] === '(') {
				const paren = matchParen(text, close + 1);
				if (paren > 0) {
					flush(i);
					const alt = inlineText(parseInline(text.slice(i + 2, close).trim(), depth + 1));
					pushText(out, alt === '' ? 'image' : alt);
					i = paren + 1;
					plainFrom = i;
					continue;
				}
			}
			i++;
			continue;
		}

		// Inline links: [label](destination "title").
		if (ch === '[') {
			const close = matchBracket(text, i);
			if (close > 0 && text[close + 1] === '(') {
				const paren = matchParen(text, close + 1);
				if (paren > 0) {
					flush(i);
					const children = parseInline(text.slice(i + 1, close), depth + 1);
					const href = safeHref(linkDestination(text.slice(close + 2, paren)));
					if (href !== null && !children.some((node) => node.type === 'link')) {
						out.push({ type: 'link', href, rel: LINK_REL, children });
					} else {
						for (const node of children) {
							if (node.type === 'text') pushText(out, node.text);
							else out.push(node);
						}
					}
					i = paren + 1;
					plainFrom = i;
					continue;
				}
			}
			i++;
			continue;
		}

		// Autolinks: <https://…> and <name@host>.
		if (ch === '<') {
			const autolink = readAutolink(text, i);
			if (autolink !== null) {
				flush(i);
				out.push({ type: 'link', href: autolink.href, rel: LINK_REL, children: [{ type: 'text', text: autolink.label }] });
				i = autolink.end;
				plainFrom = i;
				continue;
			}
			i++;
			continue;
		}

		// Bare http(s) URLs at a word boundary.
		if ((ch === 'h' || ch === 'H') && !isAlnum(text[i - 1])) {
			const end = bareUrlEnd(text, i);
			if (end > 0) {
				const url = text.slice(i, end);
				const href = safeHref(url);
				if (href !== null) {
					flush(i);
					out.push({ type: 'link', href, rel: LINK_REL, children: [{ type: 'text', text: url }] });
					i = end;
					plainFrom = i;
					continue;
				}
			}
			i++;
			continue;
		}

		// Emphasis, strong and strikethrough.
		if (ch === '*' || ch === '_' || ch === '~') {
			const double = text[i + 1] === ch;
			const delim = double ? ch + ch : ch;
			const opensWord = !isSpace(text[i + delim.length]) && !(ch === '_' && isAlnum(text[i - 1]));
			if (opensWord && (ch !== '~' || double)) {
				const close = findCloser(text, i, delim);
				if (close > 0) {
					flush(i);
					const children = parseInline(text.slice(i + delim.length, close), depth + 1);
					const type = ch === '~' ? 'del' : double ? 'strong' : 'em';
					out.push({ type, children });
					i = close + delim.length;
					plainFrom = i;
					continue;
				}
			}
			i += delim.length;
			continue;
		}

		i++;
	}
	flush(text.length);
	return out;
}

// =============================================================================
// Block parsing
// =============================================================================

// Each of these reads a line left to right with no two quantifiers able to
// claim the same characters, so a failed match costs one pass. Headings and
// table delimiter rows are read by hand (readHeading, isDelimiterRow): as
// regular expressions they need adjacent optional whitespace runs, which
// backtrack quadratically over a long run of spaces.
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^( {0,3})([-*+]|(\d{1,9})([.)]))(?:([ \t]+)(.*))?$/;

/** One cell of a table delimiter row, trimmed. */
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * An ATX heading: up to three spaces, one to six '#', then a space, a tab or
 * the end of the line; an optional closing run of '#' after a space or tab is
 * dropped.
 *
 * @param line - The line.
 * @returns The level and the heading's text, or null.
 */
function readHeading(line: string): { level: number; text: string } | null {
	let at = 0;
	while (at < 3 && line[at] === ' ') at++;
	let level = 0;
	while (line[at + level] === '#') level++;
	if (level < 1 || level > 6) return null;
	at += level;
	if (at < line.length && !isBlank(line[at])) return null;
	while (isBlank(line[at])) at++;
	let end = line.length;
	while (end > at && isBlank(line[end - 1])) end--;
	let hashes = end;
	while (hashes > at && line[hashes - 1] === '#') hashes--;
	if (hashes < end && hashes > at && isBlank(line[hashes - 1])) {
		end = hashes;
		while (end > at && isBlank(line[end - 1])) end--;
	}
	return { level, text: line.slice(at, end) };
}

/**
 * Leading spaces of a line (a tab counts as four).
 *
 * @param line - The line.
 * @returns The indent width.
 */
function indentOf(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === ' ') width++;
		else if (ch === '\t') width += 4;
		else break;
	}
	return width;
}

/**
 * Remove up to `width` columns of leading whitespace.
 *
 * @param line - The line.
 * @param width - Columns to remove.
 * @returns The line without them.
 */
function dedent(line: string, width: number): string {
	let removed = 0;
	let i = 0;
	while (i < line.length && removed < width) {
		if (line[i] === ' ') removed++;
		else if (line[i] === '\t') removed += 4;
		else break;
		i++;
	}
	return line.slice(i);
}

/**
 * Split a table row into cells (pipes inside code spans or escaped stay).
 *
 * @param line - The row.
 * @returns The raw cell texts.
 */
function splitRow(line: string): string[] {
	let row = line.trim();
	if (row.startsWith('|')) row = row.slice(1);
	if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
	const cells: string[] = [];
	let cell = '';
	for (let i = 0; i < row.length; i++) {
		const ch = row[i];
		if (ch === '\\' && row[i + 1] === '|') {
			cell += '|';
			i++;
			continue;
		}
		if (ch === '`') {
			const span = readCodeSpan(row, i);
			if (span) {
				cell += row.slice(i, span.end);
				i = span.end - 1;
				continue;
			}
		}
		if (ch === '|') {
			cells.push(cell.trim());
			cell = '';
			continue;
		}
		cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

/**
 * Whether lines[at] starts a GFM table (a header row followed by a delimiter row of the same width).
 *
 * @param lines - The lines.
 * @param at - Index of the candidate header.
 * @returns True when a table starts here.
 */
function tableStarts(lines: readonly string[], at: number): boolean {
	const header = lines[at];
	const delimiter = lines[at + 1];
	if (header === undefined || delimiter === undefined || !header.includes('|') || !delimiter.includes('|')) return false;
	const cells = splitRow(delimiter);
	if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return false;
	return splitRow(header).length === cells.length;
}

/**
 * Whether a line starts a block other than a paragraph.
 *
 * @param lines - The lines.
 * @param at - The line index.
 * @returns True when a paragraph must end before it.
 */
function startsBlock(lines: readonly string[], at: number): boolean {
	const line = lines[at];
	return FENCE.test(line) || readHeading(line) !== null || RULE.test(line) || QUOTE.test(line) || (LIST_ITEM.test(line) && (LIST_ITEM.exec(line)?.[6] ?? '').trim() !== '') || tableStarts(lines, at);
}

/**
 * Parse block Markdown.
 *
 * @param lines - The lines.
 * @param depth - Nesting depth.
 * @returns The blocks.
 */
function parseBlocks(lines: readonly string[], depth: number): MdBlock[] {
	const blocks: MdBlock[] = [];
	if (depth > MAX_BLOCK_DEPTH) {
		const text = lines.join('\n').trim();
		if (text !== '') blocks.push({ type: 'paragraph', children: [{ type: 'text', text }] });
		return blocks;
	}
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '') {
			i++;
			continue;
		}

		// Fenced code: shown as code, the info string is only a label.
		const fence = FENCE.exec(line);
		if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
			const indent = fence[1].length;
			const marker = fence[2];
			const info = fence[3].trim().split(/\s+/)[0] ?? '';
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
				if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
					i++;
					break;
				}
				body.push(dedent(lines[i], indent));
				i++;
			}
			blocks.push({ type: 'code', lang: /^[A-Za-z0-9_+.#-]{1,32}$/.test(info) ? info : null, text: body.join('\n') });
			continue;
		}

		const heading = readHeading(line);
		if (heading) {
			blocks.push({ type: 'heading', level: heading.level, children: parseInline(heading.text.trim()) });
			i++;
			continue;
		}

		if (RULE.test(line)) {
			blocks.push({ type: 'rule' });
			i++;
			continue;
		}

		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length && QUOTE.test(lines[i])) {
				inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
				i++;
			}
			blocks.push({ type: 'quote', children: parseBlocks(inner, depth + 1) });
			continue;
		}

		if (tableStarts(lines, i)) {
			const header = splitRow(lines[i]).slice(0, MAX_TABLE_COLUMNS);
			const align: MdAlign[] = splitRow(lines[i + 1])
				.slice(0, MAX_TABLE_COLUMNS)
				.map((cell) => {
					const left = cell.startsWith(':');
					const right = cell.endsWith(':');
					return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
				});
			i += 2;
			const rows: MdInline[][][] = [];
			while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && !(FENCE.test(lines[i]) || readHeading(lines[i]) !== null || QUOTE.test(lines[i]))) {
				if (rows.length < MAX_TABLE_ROWS) {
					const cells = splitRow(lines[i]);
					rows.push(header.map((_, column) => parseInline(cells[column] ?? '')));
				}
				i++;
			}
			blocks.push({ type: 'table', align, header: header.map((cell) => parseInline(cell)), rows });
			continue;
		}

		const item = LIST_ITEM.exec(line);
		if (item) {
			const ordered = item[3] !== undefined;
			const kind = ordered ? item[4] : item[2];
			const start = ordered ? parseInt(item[3], 10) : 1;
			const items: MdBlock[][] = [];
			while (i < lines.length) {
				const current = LIST_ITEM.exec(lines[i]);
				if (!current || (current[3] !== undefined) !== ordered || (ordered ? current[4] : current[2]) !== kind) break;
				const spacing = (current[5] ?? ' ').length;
				const contentIndent = current[1].length + current[2].length + (spacing > 4 ? 1 : spacing);
				const itemLines: string[] = [current[6] ?? ''];
				i++;
				while (i < lines.length) {
					const next = lines[i];
					if (next.trim() === '') {
						let ahead = i + 1;
						while (ahead < lines.length && lines[ahead].trim() === '') ahead++;
						if (ahead < lines.length && indentOf(lines[ahead]) >= contentIndent) {
							for (; i < ahead; i++) itemLines.push('');
							continue;
						}
						break;
					}
					if (indentOf(next) >= contentIndent) {
						itemLines.push(dedent(next, contentIndent));
						i++;
						continue;
					}
					if (LIST_ITEM.test(next) || startsBlock(lines, i)) break;
					// Lazy continuation of the item's paragraph.
					itemLines.push(next.trim());
					i++;
				}
				items.push(parseBlocks(itemLines, depth + 1));
				// Blank lines between items of the same list.
				let ahead = i;
				while (ahead < lines.length && lines[ahead].trim() === '') ahead++;
				const following = ahead < lines.length ? LIST_ITEM.exec(lines[ahead]) : null;
				if (following && (following[3] !== undefined) === ordered && (ordered ? following[4] : following[2]) === kind) i = ahead;
				else break;
			}
			blocks.push({ type: 'list', ordered, start, items });
			continue;
		}

		// Paragraph: up to a blank line or the start of another block.
		const para: string[] = [line.trim()];
		i++;
		while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines, i)) {
			para.push(lines[i].replace(/^[ \t]+/, ''));
			i++;
		}
		const joined = para.join('\n');
		let end = joined.length;
		while (end > 0 && isBlank(joined[end - 1])) end--;
		blocks.push({ type: 'paragraph', children: parseInline(joined.slice(0, end)) });
	}
	return blocks;
}

/**
 * Parse an answer into safe blocks.
 *
 * @param text - The answer.
 * @param options - Caps.
 * @returns The blocks.
 */
export function parseMarkdown(text: string, options: MarkdownOptions = {}): MdBlock[] {
	const max = options.maxChars ?? MARKDOWN_MAX_CHARS;
	let source = typeof text === 'string' ? text : String(text ?? '');
	if (source.length > max) source = `${source.slice(0, max)}…`;
	const outer = searchBudget;
	searchBudget = SEARCH_STEPS_PER_CHAR * source.length + 4 * MAX_SPAN;
	try {
		return parseBlocks(source.replace(/\r\n?/g, '\n').split(String.fromCharCode(0)).join('\ufffd').split('\n'), 0);
	} finally {
		searchBudget = outer;
	}
}

// =============================================================================
// Plain text
// =============================================================================

/**
 * The text of inline nodes, as a reader sees it.
 *
 * @param nodes - The nodes.
 * @returns The text.
 */
export function inlineText(nodes: readonly MdInline[]): string {
	let out = '';
	for (const node of nodes) {
		if (node.type === 'text' || node.type === 'code') out += node.text;
		else if (node.type === 'break') out += '\n';
		else out += inlineText(node.children);
	}
	return out;
}

/**
 * The text of a block tree (for announcements and copying).
 *
 * @param blocks - The blocks.
 * @returns The text, blocks separated by blank lines.
 */
export function plainText(blocks: readonly MdBlock[]): string {
	return blocks
		.map((block): string => {
			switch (block.type) {
				case 'paragraph':
				case 'heading':
					return inlineText(block.children);
				case 'code':
					return block.text;
				case 'quote':
					return plainText(block.children);
				case 'list':
					return block.items.map((item) => plainText(item)).join('\n');
				case 'table':
					return [block.header, ...block.rows].map((row) => row.map((cell) => inlineText(cell)).join(' | ')).join('\n');
				case 'rule':
					return '';
			}
			return '';
		})
		.filter((part) => part !== '')
		.join('\n\n');
}
