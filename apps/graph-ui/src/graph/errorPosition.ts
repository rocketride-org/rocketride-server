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
// GRAPH - WHERE A FAILED STATEMENT WENT WRONG (pure)
// =============================================================================
//
// Reads the line and column out of a database's error text, so the editor can
// mark the place. What each engine says (tests/fixtures/v1/live/*_errors.json):
//
//   Neo4j     `... (line 1, column 10 (offset: 9))`, one-based, in the statement
//             that was sent.
//   AGE       `Cypher syntax error: line 1:0 extraneous input ...`, only for a
//             syntax error; the column is zero-based, and later positions in the
//             same text are knock-on errors, so the first one is read.
//   FalkorDB  4.22.2 (seen live): `errMsg: Invalid input 'R': ... line: 1, column: 10, offset: 9
//             errCtx: ...`, one-based. The 6.0.1 fixtures carry no position, and a text
//             without the form is null.
//
// The position is inside the statement that was sent, which is a statement of the
// buffer (the splitter's trimmed text), so it is mapped to buffer offsets through
// that statement's start.
// =============================================================================

import { tokenize } from '../cypher/lexer';
import type { GraphDialect } from '../cypher/quote';

/** A one-based line and column. */
export interface IPosition {
	line: number;
	column: number;
}

/** A failure placed in the editor buffer. */
export interface IFailureLocation extends IPosition {
	/** Offset of the first marked character in the buffer. */
	start: number;
	/** Offset one past the last marked character. */
	end: number;
}

/** Neo4j: `(line 1, column 10 (offset: 9))`. */
const NEO4J_POSITION = /\(line (\d+), column (\d+)(?: \(offset: \d+\))?\)/;

/** AGE's translator: `line 1:7`, a zero-based column. */
const AGE_POSITION = /\bline (\d+):(\d+)\b/;

/** FalkorDB: `line: 1, column: 10, offset: 9` (one-based line and column), before its `errCtx:` echo of the query. */
const FALKORDB_POSITION = /\bline: (\d+), column: (\d+), offset: \d+/;

/** Past this a number is not a position (a hostile text must not make a huge loop or offset). */
const MAX_COORDINATE = 1_000_000;

/**
 * A one-based position from two captured numbers, or null when they are not one.
 *
 * @param line - The captured line.
 * @param column - The captured column, already one-based.
 * @returns The position, or null.
 */
function position(line: string, column: number): IPosition | null {
	const l = Number(line);
	if (!Number.isInteger(l) || l < 1 || l > MAX_COORDINATE || !Number.isInteger(column) || column < 1 || column > MAX_COORDINATE) return null;
	return { line: l, column };
}

/**
 * The position a database's error text names, within the failed statement.
 *
 * @param text - The database's text.
 * @param dialect - The engine that wrote it, or null when not known (both forms are tried).
 * @returns One-based line and column, or null when the text names none.
 */
export function failurePosition(text: string, dialect: GraphDialect | null): IPosition | null {
	if (dialect === null || dialect === 'neo4j') {
		const match = NEO4J_POSITION.exec(text);
		if (match) {
			const found = position(match[1], Number(match[2]));
			if (found) return found;
		}
		if (dialect === 'neo4j') return null;
	}
	if (dialect === null || dialect === 'falkordb') {
		// Only what comes before the node's echo of the query (`errCtx:`), which is the user's own text.
		const match = FALKORDB_POSITION.exec(text.split(' errCtx:')[0]);
		if (match) {
			const found = position(match[1], Number(match[2]));
			if (found) return found;
		}
		if (dialect === 'falkordb') return null;
	}
	const match = AGE_POSITION.exec(text);
	return match ? position(match[1], Number(match[2]) + 1) : null;
}

/**
 * Offsets at which each line of a text starts (a bare carriage return ends a line too, as the splitter counts them).
 *
 * @param text - The text.
 * @returns Ascending line starts; the first is 0.
 */
function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n' || (text[i] === '\r' && text[i + 1] !== '\n')) starts.push(i + 1);
	}
	return starts;
}

/**
 * Place a failure in the editor buffer: the characters to mark and where they are in buffer lines and columns.
 *
 * @param buffer - The editor text the batch was run from.
 * @param statement - The failed statement's offsets in that buffer.
 * @param text - The database's text.
 * @param dialect - The engine, or null when not known.
 * @returns The location, or null when the text names no position or the statement has no text.
 */
export function locateFailure(buffer: string, statement: { start: number; end: number }, text: string, dialect: GraphDialect | null): IFailureLocation | null {
	const at = failurePosition(text, dialect);
	const from = Math.max(0, Math.min(statement.start, buffer.length));
	const to = Math.max(from, Math.min(statement.end, buffer.length));
	if (!at || to === from) return null;
	const own = buffer.slice(from, to);
	const lines = lineStartsOf(own);
	// A line past the statement's last is the end of the statement.
	const within = at.line > lines.length ? own.length : Math.min(own.length, lines[at.line - 1] + at.column - 1);
	let start = within;
	let end = within + 1;
	if (within >= own.length) {
		start = own.length - 1;
		end = own.length;
	} else {
		const token = tokenize(own).find((t) => t.start <= within && within < t.end);
		if (token && token.kind !== 'space' && token.kind !== 'punct') {
			start = token.start;
			end = token.end;
		}
	}
	const offset = from + start;
	const bufferLines = lineStartsOf(buffer.slice(0, offset + 1));
	const line = bufferLines.length;
	return { line, column: offset - bufferLines[line - 1] + 1, start: offset, end: from + end };
}
