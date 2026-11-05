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
// SQL — RUN TARGETS (which statements a Run press would send)
// =============================================================================
//
// What Run sends is decided from THREE live facts that must all describe the
// SAME buffer: the buffer's text, the selection, and the caret. The editor owns
// all three. React state holds a copy of the text that lags the editor by a
// render: Monaco's run action can fire synchronously after the last keystrokes,
// before React has committed them. Combining the editor's LIVE caret offset
// with that lagging copy of the text put the caret past the end of the old text,
// and the statement under the caret was then the old one — a TRUNCATED statement
// ("syntax error at or near \"orde\"") sent to the database.
//
// So the text is read from the editor at run time ({@link liveBufferText}) and
// the choice itself is a pure function of (text, selection, offset)
// ({@link selectRunTargets}), tested without an editor.
// =============================================================================

import type { SqlDialect } from '../connect';
import { splitStatementsIn, statementAtOffset } from './split';
import type { IStatement } from './split';

/** The live selection, as the editor reports it. */
export interface LiveSelection {
	/** The selected text ('' when the selection is empty). */
	text: string;
	/** Start offset in the buffer. */
	start: number;
	/** End offset in the buffer. */
	end: number;
}

/** The part of the editor handle that exposes the live buffer text. */
export interface LiveTextSource {
	/** The editor's current text, or null when it has no model (not mounted yet). */
	getText(): string | null;
}

/**
 * The buffer text a run must use: the editor's own, falling back to the React
 * copy only when there is no editor to ask.
 *
 * @param editor - The editor handle (null when not mounted).
 * @param fallback - The React-state copy of the text.
 * @returns The text to split.
 */
export function liveBufferText(editor: LiveTextSource | null | undefined, fallback: string): string {
	return editor?.getText() ?? fallback;
}

/**
 * The statements a Run press would send: the selection when it holds text,
 * otherwise the statement the caret is in.
 *
 * A selection is NOT necessarily one statement — `SELECT …; DELETE …` can be
 * dragged in one gesture. Sending it whole would classify it by its first
 * keyword alone, so the pattern check would never see the DELETE, a trailing
 * ROLLBACK would never be refused, and the whole thing would be marked read-only
 * and become eligible for the session's retry. It is split exactly like the
 * buffer.
 *
 * @param text - The buffer text (the editor's, not a lagging copy).
 * @param selection - The live selection, or null when there is none.
 * @param offset - The live caret offset in `text`.
 * @param dialect - The engine dialect.
 * @returns The statements to run (possibly empty).
 */
export function selectRunTargets(text: string, selection: LiveSelection | null, offset: number, dialect: SqlDialect): IStatement[] {
	if (selection && selection.text.trim()) return splitStatementsIn(text, selection.start, selection.end, dialect);
	const statement = statementAtOffset(text, offset, dialect);
	return statement ? [statement] : [];
}
