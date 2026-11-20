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
// CYPHER - STATEMENT SPLITTING
// =============================================================================
//
// The node's tools take one statement per call (AGE needs it, and the others
// accept it), so a buffer holding several statements is split in the app before
// anything is sent. A `;` ends a statement only when the lexer sees it as code:
// a semicolon inside a string, a backtick name, a line comment or a block
// comment is an ordinary character. A stretch that holds only whitespace and
// comments produces no statement, so a trailing `;` or a closing comment never
// yields an empty run.
// =============================================================================

import { tokenize } from './lexer';

// =============================================================================
// TYPES
// =============================================================================

/** One statement found in a buffer, with the offsets it occupies. */
export interface IStatement {
	/** Zero-based position among the buffer's non-blank statements. */
	index: number;
	/** The statement text, trimmed, WITHOUT its terminating semicolon. */
	text: string;
	/** Offset of the first character of {@link text} in the buffer. */
	start: number;
	/** Offset one past the last character of {@link text}. */
	end: number;
	/** One-based line holding {@link start}. */
	startLine: number;
	/** One-based line holding the last character of {@link text}. */
	endLine: number;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Offsets at which each line of the buffer starts.
 *
 * @param src - The buffer.
 * @returns Ascending line-start offsets (the first is 0).
 */
function buildLineStarts(src: string): number[] {
	const starts = [0];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === '\n') starts.push(i + 1);
		else if (src[i] === '\r' && src[i + 1] !== '\n') starts.push(i + 1);
	}
	return starts;
}

/**
 * One-based line number holding an offset (binary search over line starts).
 *
 * @param lineStarts - Output of {@link buildLineStarts}.
 * @param offset - A buffer offset.
 * @returns The one-based line number.
 */
function lineAt(lineStarts: number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (lineStarts[mid] <= offset) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Split a buffer into its statements.
 *
 * @param src - The buffer (one or more statements).
 * @returns The statements, in buffer order.
 */
export function splitStatements(src: string): IStatement[] {
	const tokens = tokenize(src);
	const lineStarts = buildLineStarts(src);
	const out: IStatement[] = [];
	let segStart = 0;
	let hasCode = false;

	/**
	 * Emit the segment `[segStart, segEnd)` when it holds code (more than
	 * whitespace and comments).
	 *
	 * @param segEnd - End offset of the segment (exclusive).
	 */
	const emit = (segEnd: number): void => {
		if (!hasCode) return;
		let start = segStart;
		let end = segEnd;
		while (start < end && /\s/.test(src[start])) start += 1;
		while (end > start && /\s/.test(src[end - 1])) end -= 1;
		if (end <= start) return;
		out.push({
			index: out.length,
			text: src.slice(start, end),
			start,
			end,
			startLine: lineAt(lineStarts, start),
			endLine: lineAt(lineStarts, end - 1),
		});
	};

	for (const token of tokens) {
		if (token.kind === 'semicolon') {
			emit(token.start);
			segStart = token.end;
			hasCode = false;
			continue;
		}
		if (token.kind !== 'space' && token.kind !== 'lineComment' && token.kind !== 'blockComment') hasCode = true;
	}
	emit(src.length);
	return out;
}

/**
 * Split a SLICE of a buffer, reporting offsets and lines in the WHOLE buffer.
 *
 * A selection is not necessarily one statement (`MATCH (n) RETURN n; MATCH (m)
 * RETURN m` can be dragged in one gesture), and sending it as one call would
 * misclassify it by its first keyword alone. Splitting the slice and rebasing
 * the offsets keeps every per-statement check working while decorations and
 * line numbers still point at the real text in the editor.
 *
 * @param buffer - The whole editor buffer.
 * @param start - Start offset of the slice (inclusive).
 * @param end - End offset of the slice (exclusive).
 * @returns The statements, with buffer-absolute offsets and line numbers.
 */
export function splitStatementsIn(buffer: string, start: number, end: number): IStatement[] {
	const from = Math.max(0, Math.min(start, buffer.length));
	const to = Math.max(from, Math.min(end, buffer.length));
	const lineStarts = buildLineStarts(buffer);
	return splitStatements(buffer.slice(from, to)).map((statement) => ({
		...statement,
		start: from + statement.start,
		end: from + statement.end,
		startLine: lineAt(lineStarts, from + statement.start),
		endLine: lineAt(lineStarts, from + statement.end - 1),
	}));
}

/**
 * The statement the cursor sits in.
 *
 * When the offset falls between statements (in the whitespace or comment after
 * a `;`) the PRECEDING statement is returned, so pressing Run with the caret
 * just after a semicolon re-runs what the caret is sitting behind. With no
 * preceding statement the first one is returned; an empty buffer returns null.
 *
 * @param src - The buffer.
 * @param offset - Cursor offset in the buffer.
 * @returns The statement, or null when the buffer holds none.
 */
export function statementAtOffset(src: string, offset: number): IStatement | null {
	const statements = splitStatements(src);
	if (statements.length === 0) return null;
	let previous: IStatement | null = null;
	for (const statement of statements) {
		if (offset >= statement.start && offset <= statement.end) return statement;
		if (statement.end < offset) previous = statement;
	}
	return previous ?? statements[0];
}
