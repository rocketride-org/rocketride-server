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
import type { DatabaseLike } from '../src/client/database';
import { makePgShim } from '../src/client/database/sequelize/pg-shim';

// Object-mode call shape the shim uses (DatabaseLike['query'] is overloaded,
// which jest.fn cannot infer; the shim never passes rowMode).
type DbQuery = (options: { token: string; sql: string; nodeId?: string; sessionId?: string; params?: unknown[] }) => Promise<{ rows: Record<string, unknown>[]; affected_rows: number }>;
type DbBeginTransaction = DatabaseLike['beginTransaction'];
type DbCommit = DatabaseLike['commit'];
type DbRollback = DatabaseLike['rollback'];

function ctx() {
	const db = {
		query: jest.fn<DbQuery>(async (_opts) => ({ rows: [], affected_rows: 1 })),
		beginTransaction: jest.fn<DbBeginTransaction>(async () => ({ session_id: 's1' })),
		commit: jest.fn<DbCommit>(async () => ({ ok: true })),
		rollback: jest.fn<DbRollback>(async () => ({ ok: true })),
	};
	return { db: db as unknown as DatabaseLike, token: 'tok', nodeId: 'n1', _db: db };
}

describe('pg-shim transactions', () => {
	// -------------------------------------------------------------------------
	// START TRANSACTION / BEGIN → opens a session; subsequent queries carry it
	// -------------------------------------------------------------------------

	it('START TRANSACTION opens a session and later queries carry it', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('START TRANSACTION');
		expect(c._db.beginTransaction).toHaveBeenCalledWith({ token: 'tok', nodeId: 'n1' });
		await client.query({ text: 'INSERT INTO t (v) VALUES ($1)', values: ['x'] });
		expect(c._db.query).toHaveBeenCalledWith({ token: 'tok', sql: 'INSERT INTO t (v) VALUES ($1)', nodeId: 'n1', sessionId: 's1', params: ['x'] });
		await client.query('COMMIT');
		expect(c._db.commit).toHaveBeenCalledWith({ token: 'tok', sessionId: 's1', nodeId: 'n1' });
	});

	it('BEGIN (alias) also opens a session', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		expect(c._db.beginTransaction).toHaveBeenCalledWith({ token: 'tok', nodeId: 'n1' });
		expect((client as any)._sessionId).toBe('s1');
	});

	// -------------------------------------------------------------------------
	// COMMIT → calls db.commit and clears the session
	// -------------------------------------------------------------------------

	it('COMMIT calls db.commit and clears the session so later queries have no sessionId', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		await client.query('COMMIT');
		expect(c._db.commit).toHaveBeenCalledWith({ token: 'tok', sessionId: 's1', nodeId: 'n1' });
		expect((client as any)._sessionId).toBeUndefined();
		// A query after COMMIT must NOT carry sessionId
		await client.query('SELECT 1');
		expect(c._db.query).toHaveBeenCalledWith({ token: 'tok', sql: 'SELECT 1', nodeId: 'n1' });
	});

	it('COMMIT without a prior BEGIN is a no-op (no error)', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await expect(client.query('COMMIT')).resolves.toBeDefined();
		expect(c._db.commit).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// ROLLBACK → calls db.rollback and clears the session
	// -------------------------------------------------------------------------

	it('ROLLBACK ends the session and clears it so a later query has no sessionId', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		await client.query('ROLLBACK');
		expect(c._db.rollback).toHaveBeenCalledWith({ token: 'tok', sessionId: 's1', nodeId: 'n1' });
		expect((client as any)._sessionId).toBeUndefined();
		await client.query('SELECT 1');
		expect(c._db.query).toHaveBeenCalledWith({ token: 'tok', sql: 'SELECT 1', nodeId: 'n1' });
	});

	it('ROLLBACK without a prior BEGIN is a no-op (no error)', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await expect(client.query('ROLLBACK')).resolves.toBeDefined();
		expect(c._db.rollback).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Transaction control result shape
	// -------------------------------------------------------------------------

	it('transaction-control SQL returns the expected empty result shape', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		const res = await client.query('BEGIN');
		expect(res).toEqual({ rows: [], rowCount: 0, fields: [], command: 'BEGIN' });
	});

	// -------------------------------------------------------------------------
	// Callback mode — transaction control must honour the dual-mode contract
	// -------------------------------------------------------------------------

	it('COMMIT callback-style invokes cb(null, result) and calls db.commit', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		// Open a transaction in promise mode first
		await client.query('BEGIN');
		// Now commit via callback form
		let cbErr: unknown = 'UNSET';
		let cbResult: unknown = 'UNSET';
		const returnVal = (client as any).query('COMMIT', (err: unknown, res: unknown) => {
			cbErr = err;
			cbResult = res;
		});
		// Must return undefined, not a Promise
		expect(returnVal).toBeUndefined();
		// Let the microtask queue flush
		await Promise.resolve();
		await Promise.resolve();
		expect(cbErr).toBeNull();
		expect((cbResult as any).command).toBe('COMMIT');
		expect((cbResult as any).rows).toEqual([]);
		expect(c._db.commit).toHaveBeenCalledWith({ token: 'tok', sessionId: 's1', nodeId: 'n1' });
	});

	it('BEGIN callback-style invokes cb(null, result) and calls db.beginTransaction', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		let cbErr: unknown = 'UNSET';
		let cbResult: unknown = 'UNSET';
		const returnVal = (client as any).query('BEGIN', (err: unknown, res: unknown) => {
			cbErr = err;
			cbResult = res;
		});
		expect(returnVal).toBeUndefined();
		await Promise.resolve();
		await Promise.resolve();
		expect(cbErr).toBeNull();
		expect((cbResult as any).command).toBe('BEGIN');
		expect(c._db.beginTransaction).toHaveBeenCalledWith({ token: 'tok', nodeId: 'n1' });
	});

	// -------------------------------------------------------------------------
	// end() rolls back a still-open session (leak safety)
	// -------------------------------------------------------------------------

	it('end() rolls back a still-open session (promise mode)', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		await client.end();
		expect(c._db.rollback).toHaveBeenCalledWith({ token: 'tok', sessionId: 's1', nodeId: 'n1' });
		expect((client as any)._sessionId).toBeUndefined();
	});

	it('end(cb) rolls back a still-open session and then calls cb', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		let cbCalled = false;
		const returnVal = (client as any).end(() => {
			cbCalled = true;
		});
		// Must return undefined
		expect(returnVal).toBeUndefined();
		// Rollback is async; let microtasks flush
		await Promise.resolve();
		await Promise.resolve();
		expect(c._db.rollback).toHaveBeenCalledWith({ token: 'tok', sessionId: 's1', nodeId: 'n1' });
		expect(cbCalled).toBe(true);
	});

	it('end() without an open session resolves cleanly (no rollback call)', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await expect(client.end()).resolves.toBeUndefined();
		expect(c._db.rollback).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Pass-through: SAVEPOINT / RELEASE SAVEPOINT / SET TRANSACTION
	// -------------------------------------------------------------------------

	it('SAVEPOINT falls through as an ordinary session query (not intercepted)', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		await client.query('SAVEPOINT sp1');
		// Forwarded to db.query, NOT intercepted
		expect(c._db.query).toHaveBeenCalledWith({ token: 'tok', sql: 'SAVEPOINT sp1', nodeId: 'n1', sessionId: 's1' });
	});

	it('SET TRANSACTION falls through as an ordinary session query (not intercepted)', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
		expect(c._db.query).toHaveBeenCalledWith({ token: 'tok', sql: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', nodeId: 'n1', sessionId: 's1' });
	});

	it('ROLLBACK TO SAVEPOINT is a nested rollback: forwarded as a query, session stays open', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('BEGIN');
		await client.query('ROLLBACK TO SAVEPOINT sp1');
		// Must be forwarded to db.query, NOT treated as a top-level ROLLBACK.
		expect(c._db.query).toHaveBeenCalledWith({ token: 'tok', sql: 'ROLLBACK TO SAVEPOINT sp1', nodeId: 'n1', sessionId: 's1' });
		expect(c._db.rollback).not.toHaveBeenCalled();
		// The outer transaction is still open.
		expect((client as any)._sessionId).toBe('s1');
	});
});
