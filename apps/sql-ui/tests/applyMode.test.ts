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
// APPLY MODE — what an Apply may promise before it is sent
// =============================================================================
//
// sql/applyMode.ts decides, before the confirmation, whether staged row
// changes are one transaction: PostgreSQL yes; MySQL by the table's storage
// engine (read from information_schema, bound), hedged when that read
// fails; and per statement on a node the app has learnt has no transaction
// tools (C-1). The words follow the mode.
// =============================================================================

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlExecuteResult, SqlSession } from '../src/connect';
import { engineKeepsTransactions, forgetNoTransactions, knownNoTransactions, noteNoTransactions, readTableEngine, rowApplyMode, tableEngineStatement } from '../src/sql/applyMode';

/**
 * A session whose execute answers once (or fails), recording what it was sent.
 *
 * @param answer - The rows, or an error to throw.
 * @returns The session and its log.
 */
function sessionAnswering(answer: Record<string, unknown>[] | Error): { session: SqlSession; sent: Array<{ sql: string; params?: unknown[]; idempotent?: boolean }> } {
	const sent: Array<{ sql: string; params?: unknown[]; idempotent?: boolean }> = [];
	const session = {
		endpoint: { key: 'p:s:n' },
		execute: async (sql: string, opts?: { params?: unknown[]; idempotent?: boolean }): Promise<SqlExecuteResult> => {
			sent.push({ sql, ...(opts?.params ? { params: opts.params } : {}), ...(opts?.idempotent !== undefined ? { idempotent: opts.idempotent } : {}) });
			if (answer instanceof Error) throw answer;
			return { rows: answer, affected_rows: 0 };
		},
	} as unknown as SqlSession;
	return { session, sent };
}

beforeEach(() => forgetNoTransactions());

describe('I-4: a MySQL table\'s storage engine decides whether its row changes can be one transaction', () => {
	it('reads the engine for the current database, the table name bound, as a read', async () => {
		assert.deepEqual(tableEngineStatement('my`table'), {
			sql: 'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1',
			params: ['my`table'],
		});
		const { session, sent } = sessionAnswering([{ engine: 'InnoDB' }]);
		assert.equal(await readTableEngine(session, 'orders'), 'InnoDB');
		assert.deepEqual(sent, [{ sql: tableEngineStatement('orders').sql, params: ['orders'], idempotent: true }]);
	});

	it('a read that fails, or finds no row, is no answer (null), never a guess', async () => {
		assert.equal(await readTableEngine(sessionAnswering(new Error('denied')).session, 'orders'), null);
		assert.equal(await readTableEngine(sessionAnswering([]).session, 'orders'), null);
		assert.equal(await readTableEngine(sessionAnswering([{ ENGINE: 'MyISAM' }]).session, 'orders'), 'MyISAM');
	});

	it('knows which engines keep transactions, and says so only for the ones it knows', () => {
		for (const engine of ['InnoDB', 'innodb', 'NDB', 'ndbcluster']) assert.equal(engineKeepsTransactions(engine), true, engine);
		for (const engine of ['MyISAM', 'MEMORY', 'ARCHIVE', 'CSV', 'MRG_MyISAM', 'BLACKHOLE', 'Aria']) assert.equal(engineKeepsTransactions(engine), false, engine);
		for (const engine of [null, 'SomethingNew']) assert.equal(engineKeepsTransactions(engine), null, String(engine));
	});

	it('InnoDB: one transaction; MyISAM: each change on its own; not known: one transaction asked for, the words hedged', () => {
		assert.deepEqual(rowApplyMode('mysql', { engine: 'InnoDB' }), { atomic: true, wording: 'transaction' });
		assert.deepEqual(rowApplyMode('mysql', { engine: 'MyISAM' }), { atomic: false, wording: 'each' });
		assert.deepEqual(rowApplyMode('mysql', { engine: null }), { atomic: true, wording: 'hedged' });
		assert.deepEqual(rowApplyMode('mysql', {}), { atomic: true, wording: 'hedged' });
	});
});

describe('the mode by dialect, and what the app has learnt about a node', () => {
	it('PostgreSQL is one transaction; ClickHouse and an unknown engine are each on their own', () => {
		assert.deepEqual(rowApplyMode('postgres', {}), { atomic: true, wording: 'transaction' });
		assert.deepEqual(rowApplyMode('clickhouse', {}), { atomic: false, wording: 'each' });
		assert.deepEqual(rowApplyMode('unknown', {}), { atomic: false, wording: 'each' });
	});

	it('C-1: once a node said it has no transaction tools, its next confirmation already says each change commits on its own', () => {
		assert.equal(knownNoTransactions('p:s:n', 100), false);
		noteNoTransactions('p:s:n', 100);
		assert.equal(knownNoTransactions('p:s:n', 100), true);
		assert.equal(knownNoTransactions('p:s:other', 100), false);
		assert.deepEqual(rowApplyMode('postgres', { noTransactions: knownNoTransactions('p:s:n', 100) }), { atomic: false, wording: 'each' });
		forgetNoTransactions();
		assert.equal(knownNoTransactions('p:s:n', 100), false);
	});

	it('R2-M4: a schema refresh, or the reload after a reconnect, forgets it (the node may have been upgraded)', () => {
		noteNoTransactions('p:s:n', 100);
		assert.equal(knownNoTransactions('p:s:n', 200), false, 'a newer schema snapshot');
		assert.equal(knownNoTransactions('p:s:n', 100), false, 'and it stays forgotten');
	});
});
