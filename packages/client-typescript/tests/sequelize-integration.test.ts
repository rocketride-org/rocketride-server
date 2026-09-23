/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { Sequelize, DataTypes, Transaction } from 'sequelize';
import { DatabaseApi } from '../src/client/database';

function fakeClient() {
	const tool = jest.fn(async (o: any) => {
		if (o.tool === 'begin') return { session_id: 's1' };
		if (o.tool === 'commit' || o.tool === 'rollback') return { ok: true };
		const sql: string = o.input?.sql ?? '';
		// Sequelize issues SHOW SERVER_VERSION on first connection to check pg version
		if (/^\s*SHOW\s+SERVER_VERSION\s*$/i.test(sql)) return { rows: [{ server_version: '14.0.0' }], affected_rows: 0 };
		if (/^\s*SELECT/i.test(sql)) return { rows: [{ id: 1, v: 'a' }], affected_rows: 0 };
		return { rows: [], affected_rows: 1 };
	});
	return { tool } as any;
}

describe('client.database.sequelize()', () => {
	it('runs findAll through the pipe', async () => {
		const client = fakeClient();
		const db = new DatabaseApi(client);
		const sq = db.sequelize({ Sequelize, token: 'tok', nodeId: 'n1' });
		const M = sq.define('M', { v: DataTypes.STRING }, { tableName: 't', timestamps: false });
		const rows = await M.findAll();
		expect(client.tool).toHaveBeenCalled();
		expect(rows[0].get('v')).toBe('a');
	});

	it('runs a transaction through begin/commit', async () => {
		const client = fakeClient();
		const db = new DatabaseApi(client);
		const sq = db.sequelize({ Sequelize, token: 'tok', nodeId: 'n1' });
		const M = sq.define('M', { v: DataTypes.STRING }, { tableName: 't', timestamps: false });
		await sq.transaction(async (t: Transaction) => {
			await M.create({ v: 'x' }, { transaction: t });
		});
		const beginCalls = client.tool.mock.calls.filter((c: any[]) => c[0].tool === 'begin');
		const commitCalls = client.tool.mock.calls.filter((c: any[]) => c[0].tool === 'commit');
		expect(beginCalls.length).toBe(1);
		expect(commitCalls.length).toBe(1);
	});
});
