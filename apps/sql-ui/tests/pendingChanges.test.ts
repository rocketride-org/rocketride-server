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
// PENDING CHANGES — the bar, Review SQL, the Apply confirmation and result
// =============================================================================
//
// The wording of the staged-edits flow, from the components' pure text
// helpers (the shell is stubbed, so nothing is rendered here). The rule that
// matters most: BEGIN / COMMIT framing, and "all or none", appear only when
// the apply will run as one transaction; otherwise the words say each change
// commits on its own. The action is "Apply", never "Commit".
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SqlApplyResult, SqlApplyStatement } from '../src/connect';
import { applyButtonLabel, discardConfirmText, discardNeedsConfirm, pendingCountText, pendingDetailText } from '../src/components/PendingChangesBar';
import { applyConfirmText, applyConfirmTitle, applyResultText, conflictCheckNote, previewSql, reviewIntroText, reviewScript, reviewSummaryText, rowStatementLabels, sqlLiteral } from '../src/components/ReviewSqlDialog';
import { EACH_COMMITS_TEXT, perStatementConfirmText, rowApplyMode } from '../src/sql/applyMode';
import { emptyRowEdits, stageDelete, stageInsert, stageUpdate } from '../src/sql/rowEdits';
import type { RowEditTarget } from '../src/sql/rowEdits';

const STATEMENTS: SqlApplyStatement[] = [
	{ sql: 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2', params: ['paid', 5], expect: 1 },
	{ sql: 'INSERT INTO "orders" ("customer_id", "status") VALUES ($1, $2)', params: [3, 'pending'], expect: 1 },
	{ sql: 'DELETE FROM "orders" WHERE "order_id" = $1', params: [14], expect: 1 },
];

describe('the pending-changes bar', () => {
	// DA-R2 M4: neither mount lets the app ask before a tab closes (SQL
	// Explorer's documents are static, which the shell never treats as
	// dirty, and a dev-tool frame cannot veto its close), so the bar says
	// what closing does.
	it('counts the changes, says nothing is saved yet, and that closing the tab discards them', () => {
		assert.equal(pendingCountText(3), '3 pending changes');
		assert.equal(pendingCountText(1), '1 pending change');
		assert.equal(pendingDetailText('orders', { edited: 1, inserted: 1, deleted: 1, total: 3 }), 'to orders: 1 edited row, 1 new row, 1 deleted row. Nothing is saved yet, and closing this tab discards them.');
		assert.equal(pendingDetailText('orders', { edited: 2, inserted: 0, deleted: 3, total: 5 }), 'to orders: 2 edited rows, 3 deleted rows. Nothing is saved yet, and closing this tab discards them.');
		assert.equal(pendingDetailText('orders', { edited: 1, inserted: 0, deleted: 0, total: 1 }), 'to orders: 1 edited row. Nothing is saved yet, and closing this tab discards it.');
	});

	it('the README quotes the bar and lists closing the tab as a limit', () => {
		const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
		assert.ok(prose.includes(`\`3 pending changes ${pendingDetailText('orders', { edited: 1, inserted: 1, deleted: 1, total: 3 })}\``));
		assert.match(prose, /- \*\*Closing a connection's tab discards its staged changes\.\*\* Neither the app nor the dev tool can ask before a tab closes, so the pending-changes bar says so instead\. Reloading the page discards them too\. Apply or Discard first\./);
	});

	it('the action is Apply, with its count; never Commit', () => {
		assert.equal(applyButtonLabel(3), 'Apply 3 changes');
		assert.equal(applyButtonLabel(1), 'Apply 1 change');
		for (const file of ['PendingChangesBar.tsx', 'ReviewSqlDialog.tsx']) {
			const text = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', file), 'utf8');
			assert.doesNotMatch(text, />\s*Commit\b|label: 'Commit|'Commit'/, `${file} names a Commit button`);
		}
	});

	it('Discard asks first only when there are two or more changes, and says it cannot be undone', () => {
		assert.equal(discardNeedsConfirm(1), false);
		assert.equal(discardNeedsConfirm(2), true);
		assert.equal(discardConfirmText(3), 'Discard 3 pending changes? This cannot be undone.');
	});
});

describe('Review SQL: BEGIN / COMMIT framing only when the apply is one transaction', () => {
	it('transactional: the statements between BEGIN and COMMIT, and the intro says none are applied if any fails', () => {
		const script = reviewScript(STATEMENTS, 'postgres', 'transaction');
		assert.deepEqual(script.split('\n'), [
			"BEGIN; -- through the node's begin tool",
			'UPDATE "orders" SET "status" = \'paid\' WHERE "order_id" = 5;',
			'INSERT INTO "orders" ("customer_id", "status") VALUES (3, \'pending\');',
			'DELETE FROM "orders" WHERE "order_id" = 14;',
			'COMMIT; -- all 3, or none',
		]);
		assert.equal(reviewIntroText('transaction'), 'These statements run in one transaction. If any fails, none are applied and your edits stay staged.');
	});

	it('not transactional: no BEGIN, no COMMIT, and the intro says each commits on its own', () => {
		const script = reviewScript(STATEMENTS, 'clickhouse', 'each');
		assert.doesNotMatch(script, /\bBEGIN\b|\bCOMMIT\b/);
		assert.equal(script.split('\n').length, 3);
		assert.equal(reviewIntroText('each'), 'Each statement runs and commits on its own. If one fails, the ones before it stay applied and the rest are not run.');
		assert.doesNotMatch(reviewIntroText('each'), /transaction/);
	});

	it('hedged (a MySQL table whose engine could not be read): BEGIN / COMMIT are sent, and the words say the engine may ignore them', () => {
		// R2-M1: no "all 3, or none" where the engine may keep no transactions.
		assert.match(reviewScript(STATEMENTS, 'mysql', 'hedged'), /^BEGIN;[\s\S]*\nCOMMIT;$/);
		assert.equal(reviewIntroText('hedged'), 'These statements run in one transaction if the table\'s storage engine keeps transactions (InnoDB does; MyISAM does not, and there each commits on its own).');
	});

	it('the apply mode comes from the dialect and the table: one transaction on PostgreSQL and on a MySQL InnoDB table', () => {
		assert.deepEqual(['postgres', 'clickhouse', 'unknown'].map((dialect) => rowApplyMode(dialect as never, {}).wording), ['transaction', 'each', 'each']);
		assert.equal(rowApplyMode('mysql', { engine: 'InnoDB' }).wording, 'transaction');
	});

	it('counts the statements and the rows they must change', () => {
		assert.equal(reviewSummaryText(STATEMENTS), '3 statements · 3 rows');
		assert.equal(reviewSummaryText(STATEMENTS.slice(0, 1)), '1 statement · 1 row');
		assert.equal(reviewSummaryText([{ sql: 'ALTER TABLE "t" ADD COLUMN "c" int' }]), '1 statement');
	});

	it('labels each statement with its rows and what kind of change it is', () => {
		const target: RowEditTarget = { dialect: 'postgres', table: 'orders', def: { columns: [{ column: 'order_id', type: 'INTEGER' }, { column: 'status', type: 'TEXT' }], primary_key: ['order_id'] } };
		let edits = stageUpdate(emptyRowEdits(), target, { order_id: 5, status: 'pending' }, { status: 'paid' });
		edits = stageInsert(edits, target, { status: 'new' });
		edits = stageDelete(edits, target, { order_id: 14, status: 'x' });
		assert.deepEqual(rowStatementLabels(edits), ['1 row · edited', '1 row · new', '1 row · deleted']);
	});
});

describe('Review SQL shows values inline (Apply binds them)', () => {
	it('renders each value as a literal of the dialect', () => {
		assert.equal(sqlLiteral(null, 'postgres'), 'NULL');
		assert.equal(sqlLiteral(true, 'mysql'), 'TRUE');
		assert.equal(sqlLiteral(96.5, 'postgres'), '96.5');
		assert.equal(sqlLiteral('9007199254740993', 'postgres'), "'9007199254740993'");
		assert.equal(sqlLiteral("O'Brien", 'postgres'), "'O''Brien'");
		assert.equal(sqlLiteral('a\\b\'c', 'mysql'), "'a\\\\b''c'", 'MySQL reads a backslash as an escape');
		assert.equal(sqlLiteral('a\\b', 'postgres'), "'a\\b'");
	});

	it('replaces only real placeholders: never one inside a quoted name, and $10 is not $1 followed by 0', () => {
		assert.equal(previewSql({ sql: 'UPDATE "t$1" SET "a" = $1 WHERE "b" = $2', params: ['x', 2] }, 'postgres'), 'UPDATE "t$1" SET "a" = \'x\' WHERE "b" = 2');
		assert.equal(previewSql({ sql: 'UPDATE `t$1` SET `a` = $1', params: [null] }, 'mysql'), 'UPDATE `t$1` SET `a` = NULL');
		const ten = Array.from({ length: 10 }, (_, i) => i + 1);
		assert.equal(previewSql({ sql: 'SELECT $1, $10', params: ten }, 'postgres'), 'SELECT 1, 10');
		assert.equal(previewSql({ sql: 'ALTER TABLE "t" ADD COLUMN "c" int' }, 'postgres'), 'ALTER TABLE "t" ADD COLUMN "c" int');
	});
});

describe('the Apply confirmation says whether the changes are one transaction', () => {
	it('names the count, the table and the connection', () => {
		assert.equal(applyConfirmTitle(3), 'Apply 3 changes?');
		assert.equal(applyConfirmTitle(1), 'Apply 1 change?');
		assert.match(applyConfirmText({ total: 3, table: 'orders', connection: 'Shop Postgres', wording: 'transaction', deletes: 1 }), /^Apply 3 changes to orders on Shop Postgres\?/);
	});

	it('one transaction: all or none, and a delete cannot be undone once committed', () => {
		const text = applyConfirmText({ total: 3, table: 'orders', connection: 'Shop Postgres', wording: 'transaction', deletes: 1 });
		assert.match(text, /They run together in one transaction: all 3 are saved, or none\./);
		assert.match(text, /A delete cannot be undone after it commits\./);
		assert.doesNotMatch(applyConfirmText({ total: 3, table: 'orders', connection: 'Shop Postgres', wording: 'transaction', deletes: 0 }), /delete/);
	});

	it('not one transaction: says so, and that earlier changes stay applied when one fails', () => {
		const text = applyConfirmText({ total: 3, table: 'events', connection: 'Analytics', wording: 'each', deletes: 0 });
		assert.ok(text.endsWith(EACH_COMMITS_TEXT));
		assert.equal(EACH_COMMITS_TEXT, 'Each change commits on its own; a failure leaves earlier changes saved.');
		assert.doesNotMatch(text, /one transaction|or none/);
		const hedged = applyConfirmText({ total: 3, table: 'orders', connection: 'Shop MySQL', wording: 'hedged', deletes: 0 });
		assert.match(hedged, /They run in one transaction if the table's storage engine keeps transactions; if it does not, each change commits on its own and a failure leaves earlier changes saved\./);
	});

	it('C-1: where there was no transaction, nothing was applied, and the user is asked again in the per-statement words', () => {
		assert.deepEqual(perStatementConfirmText('This node has no transaction tools, so nothing was applied.'), {
			title: 'Apply without a transaction?',
			text: 'This node has no transaction tools, so nothing was applied. Each change commits on its own; a failure leaves earlier changes saved.',
			confirmLabel: 'Apply anyway',
		});
	});
});

describe('the Apply result says what is saved', () => {
	const at = new Date(2026, 9, 23, 14, 39).getTime();
	const ok = (transactional: boolean): SqlApplyResult => ({ transactional, results: [{ affected_rows: 1 }, { affected_rows: 1 }, { affected_rows: 1 }], failure: null });

	it('success: how many, and whether as one transaction', () => {
		assert.deepEqual(applyResultText(ok(true), { total: 3, table: 'orders', at }), { variant: 'info', title: '3 changes applied to orders', detail: '1 transaction · committed 14:39', message: null });
		assert.deepEqual(applyResultText(ok(false), { total: 3, table: 'orders', at }), { variant: 'info', title: '3 changes applied to orders', detail: 'each committed on its own · 14:39', message: null });
	});

	it('a failure in one transaction: nothing was applied, the database\'s words verbatim, the edits stay staged', () => {
		const result: SqlApplyResult = { transactional: true, results: [{ affected_rows: 1 }], failure: { index: 1, stage: 'statement', message: 'SQL execution failed: duplicate key', committed: 0, unknown: false, rollbackConfirmed: true } };
		assert.deepEqual(applyResultText(result, { total: 3, table: 'orders', at }), {
			variant: 'error',
			title: 'Apply failed. No changes were applied.',
			detail: 'Change 2 of 3 failed. Your edits are still staged.',
			message: 'SQL execution failed: duplicate key',
		});
	});

	it('a row count that did not match is the app\'s own sentence, not the database\'s', () => {
		const sentence = 'The statement changed 2 rows; it must change exactly 1 row. Its key matched more rows than it names.';
		const result: SqlApplyResult = { transactional: true, results: [{ affected_rows: 2 }], failure: { index: 0, stage: 'expect', message: sentence, committed: 0, unknown: false, rollbackConfirmed: true } };
		const text = applyResultText(result, { total: 1, table: 'orders', at });
		assert.equal(text.detail, `Change 1 of 1 failed. ${sentence} Your edits are still staged.`);
		assert.equal(text.message, null);
	});

	it('a refused commit is a failure too', () => {
		const result: SqlApplyResult = { transactional: true, results: [], failure: { index: 3, stage: 'commit', message: 'commit refused', committed: 0, unknown: false, rollbackConfirmed: true } };
		const text = applyResultText(result, { total: 3, table: 'orders', at });
		assert.equal(text.title, 'Apply failed. No changes were applied.');
		assert.equal(text.detail, 'The commit was refused. Your edits are still staged.');
		assert.equal(text.message, 'commit refused');
	});

	it('a commit whose answer never arrived: may or may not have been saved', () => {
		const result: SqlApplyResult = { transactional: true, results: [], failure: { index: 3, stage: 'commit', message: 'Connection lost', committed: 0, unknown: true, rollbackConfirmed: true } };
		const text = applyResultText(result, { total: 3, table: 'orders', at });
		assert.equal(text.title, 'The commit\'s answer did not arrive.');
		assert.equal(text.detail, 'These changes may or may not have been saved; check the data.');
	});

	it('I-2: a rollback that was not confirmed says the locks may stay', () => {
		const result: SqlApplyResult = { transactional: true, results: [], failure: { index: 0, stage: 'statement', message: 'SQL execution failed: deadlock', committed: 0, unknown: false, rollbackConfirmed: false } };
		assert.equal(applyResultText(result, { total: 2, table: 'orders', at }).detail, 'Change 1 of 2 failed. Your edits are still staged. The rollback was not confirmed; the database may hold locks on orders for up to 5 minutes.');
	});

	it('I-4: a hedged apply that failed does not claim nothing was saved', () => {
		const result: SqlApplyResult = { transactional: true, results: [], failure: { index: 1, stage: 'statement', message: 'x', committed: 0, unknown: false, rollbackConfirmed: true } };
		const text = applyResultText(result, { total: 2, table: 'orders', at, wording: 'hedged' });
		assert.equal(text.title, 'Apply failed.');
		assert.match(text.detail, /If the table's storage engine keeps no transactions, changes before the failure may be saved; check the data\./);
	});

	it('without a transaction: how many are applied and what was not run', () => {
		const result: SqlApplyResult = { transactional: false, results: [{ affected_rows: 1 }], failure: { index: 1, stage: 'statement', message: 'denied', committed: 1, unknown: false, rollbackConfirmed: true } };
		assert.deepEqual(applyResultText(result, { total: 3, table: 'events', at }), { variant: 'error', title: 'Apply stopped at change 2 of 3. 1 of 3 applied.', detail: 'Change 3 was not run.', message: 'denied' });
		const unknown: SqlApplyResult = { transactional: false, results: [], failure: { index: 0, stage: 'statement', message: 'Stopped waiting', committed: 0, unknown: true, rollbackConfirmed: true } };
		assert.equal(applyResultText(unknown, { total: 3, table: 'events', at }).detail, 'Change 1 may have been saved: its answer did not arrive. It is no longer staged; check the data. Changes 2–3 were not run.');
	});
});

describe('R2-I2: a row changed by someone else is a conflict, said plainly; what cannot be checked is named', () => {
	it('a change that matched no row reads as a conflict', () => {
		const result: SqlApplyResult = { transactional: true, results: [{ affected_rows: 0 }], failure: { index: 0, stage: 'expect', message: 'The statement changed 0 rows; it must change exactly 1 row.', committed: 0, unknown: false, rollbackConfirmed: true } };
		assert.equal(applyResultText(result, { total: 1, table: 'orders', at: 0 }).detail, 'Change 1 of 1 failed. This row was changed by someone else since you loaded it. Reload, then edit again. Your edits are still staged.');
	});

	it('Review names the changed columns matched by key only', () => {
		assert.equal(conflictCheckNote([]), null);
		assert.equal(conflictCheckNote(['price']), 'Changes to price can\'t be checked for conflicts: its value may not come back exactly, so it is not compared.');
		assert.equal(conflictCheckNote(['price', 'seen_at']), 'Changes to price and seen_at can\'t be checked for conflicts: their values may not come back exactly, so they are not compared.');
	});
});
