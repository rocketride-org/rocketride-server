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
// README CLAIMS — Apply (transactions) and Changing a table
// =============================================================================
//
// What the README says about Apply's transaction is what the code does: the
// budget, the dialects that get one, and the designer's notes. Kept beside
// readmeClaims.test.ts in its own file.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APPLY_STATEMENT_WAIT_MS, NODE_TX_IDLE_MS } from '../src/connect/tools';
import { designApplyMode } from '../src/views/TableDesignView';
import { rowApplyMode } from '../src/sql/applyMode';
import { pendingCountText, pendingDetailText } from '../src/components/PendingChangesBar';
import { leaveDataText } from '../src/sql/stagedGuard';
import { ROW_CONFLICT_TEXT, coerceValue, rowEditGate } from '../src/sql/rowEdits';

const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

describe('README claims: Changing rows', () => {
	it('quotes the bar the way the bar says it', () => {
		const counts = { edited: 1, inserted: 1, deleted: 1, total: 3 };
		assert.ok(prose.includes(`\`${pendingCountText(3)} ${pendingDetailText('orders', counts)}\``));
	});

	it('states the checks the model makes, and where editing is off', () => {
		assert.equal(coerceValue('INTEGER', '1.5').ok, false);
		assert.match(prose, /a fraction for a whole-number column is refused/);
		const def = { columns: [{ column: 'id', type: 'INT' }] };
		assert.notEqual(rowEditGate({ dialect: 'postgres', def, table: 't', executeState: 'on', ready: true }), null, 'no primary key');
		assert.notEqual(rowEditGate({ dialect: 'clickhouse', def: { ...def, primary_key: ['id'] }, table: 't', executeState: 'on', ready: true }), null, 'ClickHouse');
		assert.match(prose, /Rows cannot be changed in a table without a primary key, on ClickHouse/);
	});

	it('says exactly what the conflict check compares, in the words the apply uses (R2-I2)', () => {
		assert.ok(prose.includes(`\`${ROW_CONFLICT_TEXT}\``));
		assert.match(prose, /for an edit, by the old values of the columns you changed \(for a delete, of every column\)/);
		assert.match(prose, /Floating-point, date and time, JSON and binary columns, and longer or unconstrained decimals, are matched by key only/);
		assert.match(prose, /Review SQL names those columns, for edits and deletes alike/);
	});

	it('says a case- or accent-only change on an insensitive collation is not detected (R3-M2)', () => {
		assert.match(prose, /On a case- or accent-insensitive collation \(MySQL `_ci` and `_ai` collations, PostgreSQL `citext`\), the database calls two values equal when they differ only in case or accents, so a change of that kind alone is not detected\./);
		assert.match(prose, /decimals declared with up to 15 digits/);
	});

	it('quotes the question asked before staged changes would be dropped (R2-M2)', () => {
		assert.ok(prose.includes(`\`${leaveDataText(3, 'customers')}\``));
		assert.match(prose, /\*\*Apply\*\* waits until you open \*\*Review SQL\*\*/);
	});

	it('says an unknown outcome is never sent again, and when locks may stay', () => {
		assert.match(prose, /a row change in that state leaves the bar rather than being sent again/);
		assert.match(prose, /the database may hold locks on the table for up to 5 minutes/);
	});
});

describe('README claims: Apply', () => {
	it('says which designer statements wait like a Query statement, and lists every binary key type', async () => {
		const { isBinarySqlType } = await import('../src/sql/resultTypes');
		// Statement by statement: MySQL, ClickHouse, and a PostgreSQL node without the transaction tools.
		assert.match(prose, /On MySQL, on ClickHouse, and on a PostgreSQL node without the transaction tools, each statement commits on its own and waits like a Query-page statement, so a long `ALTER` is not cut off\./);
		assert.equal(designApplyMode('postgres', true).atomic, false);
		assert.match(prose, /binary column \(`binary`, `varbinary`, the blob types, `bytea`, `bit` or `varbit`\)/);
		for (const type of ['BINARY(16)', 'VARBINARY(8)', 'LONGBLOB', 'BYTEA', 'BIT(1)', 'VARBIT']) assert.equal(isBinarySqlType(type), true, type);
	});

	it('states the wait each statement of an apply gets, and that it is the node\'s idle-transaction time', () => {
		assert.equal(APPLY_STATEMENT_WAIT_MS, 5 * 60_000);
		assert.equal(APPLY_STATEMENT_WAIT_MS, NODE_TX_IDLE_MS);
		assert.match(prose, /Inside the transaction, each statement may take up to 5 minutes \(less if the node publishes a shorter deadline\), the time the node keeps an idle transaction open\./);
		assert.match(prose, /Where the node has no transaction tools \(an older node\), nothing is sent/);
	});

	it('names where there is no transaction, as the code decides', () => {
		assert.match(prose, /every MySQL or ClickHouse designer plan/);
		assert.equal(rowApplyMode('clickhouse', {}).atomic, false);
		assert.equal(rowApplyMode('postgres', {}).atomic && rowApplyMode('mysql', { engine: 'InnoDB' }).atomic, true);
	});

	it('says the designer applies as one transaction on PostgreSQL only, and quotes the notes the code shows', () => {
		assert.equal(designApplyMode('postgres').atomic, true);
		assert.equal(designApplyMode('mysql').atomic || designApplyMode('clickhouse').atomic, false);
		// The README's bullet is labelled `**MySQL** —`; the sentence after the label is the code's.
		assert.ok(prose.includes((designApplyMode('mysql').note as string).replace(/^MySQL: /, '')));
		assert.match(prose, /The result says `The plan runs as one transaction: a failure rolls back the whole plan` only when the node confirms the plan ran as one\./);
		assert.doesNotMatch(prose, /each statement runs in its own autocommit transaction/, 'the old PostgreSQL note is gone');
		assert.doesNotMatch(prose, /SQL Explorer does not use it/);
	});
});
