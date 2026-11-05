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
// EXPLORER RUNNER WORDING — the sentences the UI promises
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTOCOMMIT_WORDS, clock, formatAbandonNotice, formatBatchOutcome, formatElapsed, formatPriorStatements, formatRunLabel, hasStatementInFlight, lineRange } from './format';
import type { IStatementRunBase, RunOutcome } from './types';

/**
 * Build a run.
 *
 * @param index - Zero-based position.
 * @param outcome - How it ended.
 * @param kind - Statement kind.
 * @param over - Other fields.
 * @returns The run.
 */
function run(index: number, outcome: RunOutcome, kind = 'read', over: Partial<IStatementRunBase> = {}): IStatementRunBase {
	return { index, kind, verb: 'MATCH', outcome, ...over };
}

describe('formatBatchOutcome', () => {
	it('collapses consecutive positions in one group into a range', () => {
		const runs = [run(0, 'rows'), run(1, 'rows'), run(2, 'affected', 'write'), run(3, 'error'), run(4, 'skipped'), run(5, 'pending')];
		assert.equal(formatBatchOutcome(runs), '1–2 ran · 3 committed · 4 failed · 5–6 not run');
	});

	it('calls a read "ran" and any other finished statement by the app\'s word for a change', () => {
		const runs = [run(0, 'rows', 'read'), run(1, 'rows', 'write'), run(2, 'affected', 'ddl')];
		assert.equal(formatBatchOutcome(runs), '1 ran · 2–3 committed');
		assert.equal(formatBatchOutcome(runs, { changed: 'executed' }), '1 ran · 2–3 executed');
	});

	it('says abandoned, and says nothing for a statement still running', () => {
		assert.equal(formatBatchOutcome([run(0, 'rows'), run(1, 'abandoned'), run(2, 'skipped')]), '1 ran · 2 abandoned · 3 not run');
		assert.equal(formatBatchOutcome([run(0, 'rows'), run(1, 'running')]), '1 ran');
		assert.equal(formatBatchOutcome([]), '');
	});
});

describe('formatPriorStatements', () => {
	it('stops a reader assuming a failed batch rolled back when something before it changed data', () => {
		const runs = [run(0, 'affected', 'write'), run(1, 'error')];
		assert.equal(formatPriorStatements(runs, 1), 'Statement 1 already committed (each statement runs in its own autocommit transaction).');
		assert.equal(formatPriorStatements([run(0, 'rows'), run(1, 'rows'), run(2, 'error')], 2), 'Statements 1–2 already ran.');
		assert.equal(formatPriorStatements([run(0, 'error')], 0), '');
	});

	it('takes the app\'s own words and can say nothing about atomicity at all', () => {
		const words = { priorChanged: (span: string) => `${span} already executed.`, priorRead: (span: string) => `${span} returned.` };
		assert.equal(formatPriorStatements([run(0, 'affected', 'write'), run(1, 'error')], 1, words), 'Statement 1 already executed.');
		assert.equal(AUTOCOMMIT_WORDS.changed, 'committed');
	});
});

describe('formatRunLabel / formatElapsed / lineRange / clock / formatAbandonNotice', () => {
	it('puts the whole outcome in words, never colour alone', () => {
		assert.equal(formatRunLabel(run(1, 'affected', 'write', { verb: 'UPDATE', affected: 3, ms: 12 })), '2 UPDATE · 3 affected · round trip 0.012 s');
		assert.equal(formatRunLabel(run(0, 'rows', 'read', { rowCount: 1234 })), `1 MATCH · ${(1234).toLocaleString()} rows`);
		assert.equal(formatRunLabel(run(0, 'rows')), '1 MATCH · 0 rows');
		assert.equal(formatRunLabel(run(0, 'error', 'read', { ms: 5 })), '1 MATCH · error · round trip 0.005 s');
		assert.equal(formatRunLabel(run(0, 'abandoned')), '1 MATCH · abandoned');
		assert.equal(formatRunLabel(run(0, 'running')), '1 MATCH · running…');
		assert.equal(formatRunLabel(run(0, 'skipped')), '1 MATCH · not run');
		assert.equal(formatRunLabel(run(0, 'pending')), '1 MATCH · queued');
	});

	it('labels elapsed time as ROUND TRIP, never as database time', () => {
		assert.equal(formatElapsed(31), 'round trip 0.031 s');
	});

	it('names a line range, and nothing for a statement with no position', () => {
		assert.equal(lineRange(4, 4), 'line 4');
		assert.equal(lineRange(4, 6), 'lines 4–6');
		assert.equal(lineRange(), '');
		assert.equal(lineRange(1), '');
	});

	it('formats a clock time as HH:MM', () => {
		assert.match(clock(Date.UTC(2026, 9, 4, 9, 5)), /^\d\d:\d\d$/);
	});

	it('tells the user the statement may still be running', () => {
		assert.equal(formatAbandonNotice(4_200), 'Stopped waiting after 4.2 s. The statement may still be running on the database; this tool cannot cancel it.');
	});
});

describe('hasStatementInFlight', () => {
	it('is true only for a statement that was sent and has not answered (not while a dialog is open)', () => {
		assert.equal(hasStatementInFlight([run(0, 'rows'), run(1, 'running')]), true);
		assert.equal(hasStatementInFlight([run(0, 'pending')]), false);
		assert.equal(hasStatementInFlight([]), false);
	});
});
