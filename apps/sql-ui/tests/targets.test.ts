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
// RUN TARGETS — what a Run press sends, decided from ONE live buffer
// =============================================================================
//
// The regression: pressing Ctrl/Cmd+Enter right after typing sent a TRUNCATED
// statement ("syntax error at or near \"orde\""). The query view paired the
// editor's LIVE caret offset with the React copy of the text, which lags the
// editor by a render when Monaco's run action fires synchronously after the last
// keystrokes. The caret then sat past the end of the stale text, and the
// statement found "at" it was the stale, shorter one.
//
// The wiring (reading the text from the editor model at run time) lives in
// QueryView and the editor handle, which have no component harness; what is
// tested here is the pure selection and the choice of text, plus a fake editor
// that reproduces the lag. The end-to-end check needs a real browser (Chrome,
// real shell, typing then Ctrl/Cmd+Enter at once).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { liveBufferText, selectRunTargets } from '../src/sql/targets';
import { statementAtOffset } from '../src/sql/split';

// =============================================================================
// FIXTURES
// =============================================================================

/** What the user typed. */
const LIVE = 'select * from users order by id';
/** What the React state still holds: two keystrokes behind. */
const STALE = 'select * from users orde';

/**
 * A fake editor whose text moves ahead of the React copy, like Monaco does.
 *
 * @param text - The editor's current text.
 * @returns A handle exposing only what the run path reads.
 */
function editorWith(text: string): { getText(): string | null; getCursorOffset(): number } {
	return { getText: () => text, getCursorOffset: () => text.length };
}

// =============================================================================
// THE REGRESSION
// =============================================================================

describe('selectRunTargets — the statement under the caret of the SAME text', () => {
	it('sends the whole statement when the text and the caret come from the same live buffer', () => {
		const editor = editorWith(LIVE);
		const targets = selectRunTargets(liveBufferText(editor, STALE), null, editor.getCursorOffset(), 'postgres');
		assert.deepEqual(targets.map((t) => t.sql), [LIVE]);
	});

	it('documents the failure mode: the live caret against the lagging copy selects a truncated statement', () => {
		// This is the OLD wiring, kept as an assertion of what went wrong so the
		// fix is not mistaken for a no-op: the caret (end of LIVE) is past the end
		// of STALE, so the "statement at the caret" is the stale, shorter one.
		const wrong = statementAtOffset(STALE, LIVE.length, 'postgres');
		assert.equal(wrong?.sql, STALE);
		assert.notEqual(wrong?.sql, LIVE);
	});

	it('picks the right statement of several when the caret is in text the lagging copy does not have yet', () => {
		const live = 'select 1; select * from users order by id';
		const stale = 'select 1; select * from users or';
		const offset = live.length;
		assert.deepEqual(selectRunTargets(live, null, offset, 'postgres').map((t) => t.sql), ['select * from users order by id']);
		// The lagging copy would have produced a truncated second statement.
		assert.deepEqual(selectRunTargets(stale, null, offset, 'postgres').map((t) => t.sql), ['select * from users or']);
	});

	it('keeps the statement offsets and lines consistent with the live text (decorations point at real text)', () => {
		const live = 'select 1;\nselect * from users order by id';
		const [target] = selectRunTargets(live, null, live.length, 'postgres');
		assert.equal(live.slice(target!.start, target!.end), 'select * from users order by id');
		assert.equal(target!.startLine, 2);
		assert.equal(target!.endLine, 2);
	});
});

// =============================================================================
// SELECTION, CARET, EMPTY
// =============================================================================

describe('selectRunTargets — selection and edge cases', () => {
	it('splits a selection that holds several statements, so the per-statement guards still see each one', () => {
		const text = 'select 1; delete from t; select 2';
		const targets = selectRunTargets(text, { text: 'select 1; delete from t', start: 0, end: 23 }, 5, 'postgres');
		assert.deepEqual(targets.map((t) => t.sql), ['select 1', 'delete from t']);
		assert.deepEqual(targets.map((t) => t.start), [0, 10]);
	});

	it('ignores a selection that is only whitespace and falls back to the caret', () => {
		const text = 'select 1;   \nselect 2';
		const targets = selectRunTargets(text, { text: '  ', start: 9, end: 11 }, text.length, 'postgres');
		assert.deepEqual(targets.map((t) => t.sql), ['select 2']);
	});

	it('uses the preceding statement when the caret is just after a semicolon, and the first when before all', () => {
		const text = 'select 1;\nselect 2;';
		assert.deepEqual(selectRunTargets(text, null, text.length, 'postgres').map((t) => t.sql), ['select 2']);
		assert.deepEqual(selectRunTargets('  select 1', null, 0, 'postgres').map((t) => t.sql), ['select 1']);
	});

	it('returns nothing for an empty or comment-only buffer', () => {
		assert.deepEqual(selectRunTargets('', null, 0, 'postgres'), []);
		assert.deepEqual(selectRunTargets('-- just a comment', null, 17, 'postgres'), []);
	});

	it('clamps a caret beyond the end of the text to the last statement instead of throwing', () => {
		assert.deepEqual(selectRunTargets('select 1', null, 9_999, 'postgres').map((t) => t.sql), ['select 1']);
	});
});

// =============================================================================
// WHICH TEXT
// =============================================================================

describe('liveBufferText — the editor wins, the state copy is only a fallback', () => {
	it('prefers the editor text over the (possibly stale) state copy', () => {
		assert.equal(liveBufferText(editorWith(LIVE), STALE), LIVE);
	});

	it('falls back to the state copy when there is no editor, or the editor has no model yet', () => {
		assert.equal(liveBufferText(null, STALE), STALE);
		assert.equal(liveBufferText(undefined, STALE), STALE);
		assert.equal(liveBufferText({ getText: () => null }, STALE), STALE);
	});

	it('treats an EMPTY editor as empty, not as missing: a cleared buffer must not run the old statement', () => {
		assert.equal(liveBufferText({ getText: () => '' }, STALE), '');
		assert.deepEqual(selectRunTargets(liveBufferText({ getText: () => '' }, STALE), null, 0, 'postgres'), []);
	});
});
