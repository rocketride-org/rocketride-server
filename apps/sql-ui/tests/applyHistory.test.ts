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
// APPLY HISTORY — every statement an apply ran, in the connection's history
// =============================================================================
//
// sql/applyHistory.ts turns an apply's reply into history entries: one per
// statement that ran, readable (values shown in place), and honest about the
// outcome: saved, rolled back, failed, or not known.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlApplyResult, SqlApplyStatement } from '../src/connect';
import { applyHistoryEntries } from '../src/sql/applyHistory';

const STATEMENTS: SqlApplyStatement[] = [
	{ sql: 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2', params: ['paid', 5], expect: 1 },
	{ sql: 'DELETE FROM "orders" WHERE "order_id" = $1', params: [14], expect: 1 },
	{ sql: 'INSERT INTO "orders" ("status") VALUES ($1)', params: ['new'], expect: 1 },
];

const facts = { dialect: 'postgres' as const, at: 1_000, ms: 42 };

/** The parts of the entries the tests compare. */
const brief = (entries: ReturnType<typeof applyHistoryEntries>) => entries.map(({ sql, outcome, affected, error, kind }) => ({ sql, outcome, ...(affected !== undefined ? { affected } : {}), ...(error !== undefined ? { error } : {}), kind }));

describe('an apply in history', () => {
	it('success: every statement, values in place, with the rows it changed', () => {
		const result: SqlApplyResult = { transactional: true, results: [{ affected_rows: 1 }, { affected_rows: 1 }, { affected_rows: 1 }], failure: null };
		const entries = applyHistoryEntries(STATEMENTS, result, facts);
		assert.deepEqual(brief(entries), [
			{ sql: 'UPDATE "orders" SET "status" = \'paid\' WHERE "order_id" = 5', outcome: 'affected', affected: 1, kind: 'write' },
			{ sql: 'DELETE FROM "orders" WHERE "order_id" = 14', outcome: 'affected', affected: 1, kind: 'write' },
			{ sql: 'INSERT INTO "orders" ("status") VALUES (\'new\')', outcome: 'affected', affected: 1, kind: 'write' },
		]);
		assert.equal(new Set(entries.map((e) => e.id)).size, 3, 'distinct ids');
		assert.ok(entries.every((e) => e.at === 1_000 && e.ms === 42));
		assert.doesNotMatch(JSON.stringify(entries), /undefined/);
	});

	it('a rolled-back transaction: what ran is recorded as rolled back, the failing statement with the database\'s words, nothing after it', () => {
		const result: SqlApplyResult = { transactional: true, results: [{ affected_rows: 1 }], failure: { index: 1, stage: 'statement', message: 'SQL execution failed: permission denied', committed: 0, unknown: false, rollbackConfirmed: true } };
		assert.deepEqual(brief(applyHistoryEntries(STATEMENTS, result, facts)).map((e) => [e.outcome, e.error]), [
			['error', 'Rolled back: change 2 of 3 failed, so nothing was saved.'],
			['error', 'SQL execution failed: permission denied'],
		]);
	});

	it('a commit whose answer never arrived: every statement is recorded as not known', () => {
		const result: SqlApplyResult = { transactional: true, results: [{ affected_rows: 1 }, { affected_rows: 1 }, { affected_rows: 1 }], failure: { index: 3, stage: 'commit', message: 'Connection lost', committed: 0, unknown: true, rollbackConfirmed: false } };
		const entries = brief(applyHistoryEntries(STATEMENTS, result, facts));
		assert.deepEqual(entries.map((e) => e.outcome), ['abandoned', 'abandoned', 'abandoned']);
		assert.match(entries[0]!.error ?? '', /may or may not have been saved/);
	});

	it('statement by statement: the saved ones as saved, the failing one as failed (or not known), nothing after it', () => {
		const failed: SqlApplyResult = { transactional: false, results: [{ affected_rows: 1 }], failure: { index: 1, stage: 'statement', message: 'denied', committed: 1, unknown: false, rollbackConfirmed: true } };
		assert.deepEqual(brief(applyHistoryEntries(STATEMENTS, failed, facts)).map((e) => e.outcome), ['affected', 'error']);
		const lost: SqlApplyResult = { ...failed, failure: { ...failed.failure!, unknown: true } };
		assert.deepEqual(brief(applyHistoryEntries(STATEMENTS, lost, facts)).map((e) => e.outcome), ['affected', 'abandoned']);
	});

	it('R2-M1: hedged (a MySQL table whose engine was not known): a failed apply never says "nothing was saved"', () => {
		const result: SqlApplyResult = { transactional: true, results: [{ affected_rows: 1 }], failure: { index: 1, stage: 'statement', message: 'denied', committed: 0, unknown: false, rollbackConfirmed: true } };
		const entries = brief(applyHistoryEntries(STATEMENTS, result, { ...facts, wording: 'hedged' }));
		assert.deepEqual(entries.map((e) => e.outcome), ['abandoned', 'error']);
		assert.equal(entries[0]!.error, 'Change 2 of 3 failed. If the table\'s storage engine keeps no transactions, this change may be saved; check the data.');
		assert.doesNotMatch(JSON.stringify(entries), /nothing was saved/);
	});
});
