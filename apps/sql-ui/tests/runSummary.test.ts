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
// RUN SUMMARY — what a finished batch announces, cancellations included
// =============================================================================
//
// The app's live region keeps its last sentence until the next one. When the
// user cancelled a write confirmation (or the typed-name confirmation for
// DROP and TRUNCATE), the batch ended without a summary, so the region still
// read the previous run's "Statement returned 10 rows". A cancelled batch now
// says what happened: nothing was sent, or which statement it stopped at.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { RunOutcome, StatementRun } from '../src/sql/batch';
import { CANCELLED_NOTHING_SENT, formatBatchOutcome, runSummary } from '../src/sql/batch';

const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

/**
 * A batch with these outcomes.
 *
 * @param outcomes - One per statement.
 * @returns The runs.
 */
function batch(...outcomes: RunOutcome[]): StatementRun[] {
	return outcomes.map((outcome, index) => ({ index, sql: 'UPDATE t SET a = 1', kind: 'write', verb: 'UPDATE', outcome, rows: outcome === 'rows' ? [{ a: 1 }, { a: 2 }] : undefined, affected: outcome === 'affected' ? 3 : undefined }));
}

/**
 * The summary of a finished batch, the way the runner reports it.
 *
 * @param runs - The batch.
 * @param failedAt - The failed index, or -1.
 * @returns The sentence.
 */
function summary(runs: StatementRun[], failedAt = -1): string | null {
	const reversed = [...runs].reverse();
	const shown = reversed.find((run) => run.outcome === 'rows') ?? reversed.find((run) => run.outcome === 'affected') ?? null;
	return runSummary({ runs, shown, failedAt });
}

describe('runSummary', () => {
	it('a cancelled statement says nothing was sent', () => {
		assert.equal(summary(batch('skipped')), 'Cancelled; nothing was sent.');
		assert.equal(summary(batch('skipped', 'skipped', 'skipped')), 'Cancelled; nothing was sent.');
	});

	it('a batch cancelled part way says where, and what ran before', () => {
		const runs = batch('affected', 'skipped', 'skipped');
		assert.equal(summary(runs), `Cancelled at statement 2. ${formatBatchOutcome(runs)}`);
	});

	it('a finished statement or batch reads as before', () => {
		assert.equal(summary(batch('rows')), 'Statement returned 2 rows');
		assert.equal(summary(batch('affected')), 'Statement affected 3 rows');
		const runs = batch('affected', 'rows');
		assert.equal(summary(runs), `2 statements: ${formatBatchOutcome(runs)}`);
	});

	it('a failure is left to the error banner, which is a live region of its own', () => {
		assert.equal(summary(batch('error'), 0), null);
	});
});

describe('QueryView announces it', () => {
	it('summarises every finished batch with runSummary', () => {
		assert.match(view, /summarize: \(info\) => runSummary\(info\),/);
	});

	it('the history drawer\'s rerun confirmation says the same when it is cancelled', () => {
		const panel = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'HistoryPanel.tsx'), 'utf8');
		assert.match(panel, /onCancel=\{\(\) => \{\s*setConfirmRerun\(null\);[\s\S]*?announce\(CANCELLED_NOTHING_SENT\);\s*\}\}/);
		assert.equal(CANCELLED_NOTHING_SENT, 'Cancelled; nothing was sent.');
	});
});
