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
// SQL BATCH — unit tests for the multi-statement outcome wording
// =============================================================================
//
// The summary line is the app's one chance to say that a failed batch left
// earlier statements COMMITTED, so its grouping is pinned here.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IStatementRun, RunOutcome } from '../src/sql/batch';
import type { StatementKind } from '../src/sql/classify';
import { formatBatchOutcome, formatElapsed, formatPriorStatements, formatRunLabel, hasStatementInFlight, leadingVerb } from '../src/sql/batch';

/**
 * Build a batch from a list of outcomes, all of them reads.
 *
 * @param outcomes - One outcome per statement, in order.
 * @param kinds - Statement kind per position; defaults to read throughout.
 * @returns The statement runs.
 */
function batch(outcomes: RunOutcome[], kinds: StatementKind[] = []): IStatementRun[] {
	return outcomes.map((outcome, index) => ({
		index,
		sql: 'SELECT 1',
		kind: kinds[index] ?? ('read' as StatementKind),
		verb: 'SELECT',
		startLine: index + 1,
		endLine: index + 1,
		outcome,
	}));
}

describe('leadingVerb', () => {
	it('reads the first keyword', () => {
		assert.equal(leadingVerb('select * from t'), 'SELECT');
	});

	it('skips a leading comment', () => {
		assert.equal(leadingVerb('-- note\nUPDATE t SET a = 1'), 'UPDATE');
	});

	it('skips a leading parenthesis', () => {
		assert.equal(leadingVerb('(SELECT 1) UNION (SELECT 2)'), 'SELECT');
	});

	it('falls back when there is no keyword', () => {
		assert.equal(leadingVerb('   '), 'SQL');
	});
});

describe('formatElapsed', () => {
	it('reports milliseconds as seconds, never as query time', () => {
		assert.equal(formatElapsed(31.4), 'round trip 0.031 s');
	});
});

describe('formatBatchOutcome', () => {
	it('produces the bound wording for a partly failed batch', () => {
		// A read that finished "ran"; a write that finished "committed".
		const runs = batch(['rows', 'affected', 'error', 'skipped', 'skipped'], ['read', 'write', 'read', 'read', 'read']);
		assert.equal(formatBatchOutcome(runs), '1 ran · 2 committed · 3 failed · 4–5 not run');
	});

	it('says ran, never committed, for a batch of reads', () => {
		assert.equal(formatBatchOutcome(batch(['rows', 'rows'])), '1–2 ran');
	});

	it('says committed for writes and DDL', () => {
		assert.equal(formatBatchOutcome(batch(['affected', 'affected'], ['write', 'ddl'])), '1–2 committed');
	});

	it('calls an unclassifiable statement committed, not ran', () => {
		assert.equal(formatBatchOutcome(batch(['affected'], ['other'])), '1 committed');
	});

	it('collapses one statement to a single number', () => {
		assert.equal(formatBatchOutcome(batch(['error'])), '1 failed');
	});

	it('reports a fully successful batch', () => {
		assert.equal(formatBatchOutcome(batch(['rows', 'rows', 'affected'])), '1–3 ran');
	});

	it('reports an abandoned statement separately', () => {
		assert.equal(formatBatchOutcome(batch(['rows', 'abandoned', 'skipped'])), '1 ran · 2 abandoned · 3 not run');
	});

	it('leaves a running statement out of the line', () => {
		assert.equal(formatBatchOutcome(batch(['rows', 'running', 'pending'])), '1 ran · 3 not run');
	});

	it('says nothing about an empty batch', () => {
		assert.equal(formatBatchOutcome([]), '');
	});
});

describe('formatPriorStatements', () => {
	it('says nothing when the first statement failed', () => {
		assert.equal(formatPriorStatements(batch(['error', 'skipped']), 0), '');
	});

	it('says only "ran" when every earlier statement was a read', () => {
		const runs = batch(['rows', 'rows', 'error'], ['read', 'read', 'read']);
		assert.equal(formatPriorStatements(runs, 2), 'Statements 1\u20132 already ran.');
	});

	it('says "committed" as soon as one earlier statement changed anything', () => {
		const runs = batch(['rows', 'affected', 'error'], ['read', 'write', 'read']);
		assert.equal(
			formatPriorStatements(runs, 2),
			'Statements 1\u20132 already committed (each statement runs in its own autocommit transaction).',
		);
	});

	it('uses the singular for a single earlier statement', () => {
		assert.equal(formatPriorStatements(batch(['rows', 'error']), 1), 'Statement 1 already ran.');
	});

	it('uses the singular for a single earlier write', () => {
		const runs = batch(['affected', 'error'], ['ddl', 'read']);
		assert.equal(
			formatPriorStatements(runs, 1),
			'Statement 1 already committed (each statement runs in its own autocommit transaction).',
		);
	});
});

describe('formatRunLabel', () => {
	it('labels a row result', () => {
		const [run] = batch(['rows']);
		assert.equal(formatRunLabel({ ...run, rows: [{}, {}], ms: 31 }), '1 SELECT · 2 rows · round trip 0.031 s');
	});

	it('labels an affected-row result', () => {
		const [run] = batch(['affected']);
		assert.equal(formatRunLabel({ ...run, verb: 'UPDATE', affected: 3, ms: 12 }), '1 UPDATE · 3 affected · round trip 0.012 s');
	});

	it('labels a failure', () => {
		assert.equal(formatRunLabel(batch(['error'])[0]), '1 SELECT · error');
	});

	it('labels a skipped statement', () => {
		assert.equal(formatRunLabel(batch(['skipped'])[0]), '1 SELECT · not run');
	});

	it('labels a running statement', () => {
		assert.equal(formatRunLabel(batch(['running'])[0]), '1 SELECT · running…');
	});

	it('labels an abandoned statement', () => {
		const [run] = batch(['abandoned']);
		assert.equal(formatRunLabel({ ...run, ms: 1200 }), '1 SELECT · abandoned · round trip 1.200 s');
	});
});

// =============================================================================
// A STATEMENT AT THE DATABASE
// =============================================================================
//
// The distinction the "Stop waiting" affordance rests on: the batch is running
// from the moment Run is pressed, which includes the time a pattern-check
// dialog sits open with nothing sent. Only `running` means a request is out.
// =============================================================================

describe('hasStatementInFlight', () => {
	it('is false for an empty batch', () => {
		assert.equal(hasStatementInFlight([]), false);
	});

	it('is false while every statement is still queued', () => {
		assert.equal(hasStatementInFlight(batch(['pending', 'pending'])), false);
	});

	it('is true while one statement is at the database', () => {
		assert.equal(hasStatementInFlight(batch(['rows', 'running', 'pending'])), true);
	});

	it('is false once the batch has finished', () => {
		assert.equal(hasStatementInFlight(batch(['rows', 'affected', 'error', 'skipped'])), false);
	});

	for (const outcome of ['rows', 'affected', 'error', 'abandoned', 'skipped'] as RunOutcome[]) {
		it(`is false for a batch holding only ${outcome}`, () => {
			assert.equal(hasStatementInFlight(batch([outcome])), false);
		});
	}

	it('is false again after an abandoned statement was remapped', () => {
		// `stopWaiting` maps every `running` to `abandoned`, so a stale
		// in-flight flag cannot outlive the click that abandoned it.
		assert.equal(hasStatementInFlight(batch(['abandoned', 'skipped'])), false);
	});
});
