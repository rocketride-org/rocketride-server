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

type DbQuery = DatabaseLike['query'];

function ctx() {
	const query = jest.fn<DbQuery>(async (_opts) => ({ rows: [{ v: 'a' }], affected_rows: 0 }));
	return { db: { query } as unknown as DatabaseLike, token: 'tok', nodeId: 'n1', _query: query };
}

describe('pg-shim Client (no transaction)', () => {
	// -------------------------------------------------------------------------
	// Core query forwarding (from task-A2-brief)
	// -------------------------------------------------------------------------

	it('forwards a plain query and maps the result', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.connect();
		const res = await client.query('SELECT v FROM t');
		expect(c._query).toHaveBeenCalledWith({ token: 'tok', sql: 'SELECT v FROM t', nodeId: 'n1' });
		expect(res.rows).toEqual([{ v: 'a' }]);
		expect(res.command).toBe('SELECT');
		await client.end();
	});

	it('forwards bind values as params', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query({ text: 'INSERT INTO t (v) VALUES ($1)', values: ['x'] });
		expect(c._query).toHaveBeenCalledWith({
			token: 'tok',
			sql: 'INSERT INTO t (v) VALUES ($1)',
			nodeId: 'n1',
			params: ['x'],
		});
	});

	it('derives rowCount from affected_rows for writes', async () => {
		const c = ctx();
		(c._query as jest.MockedFunction<DbQuery>).mockResolvedValueOnce({ rows: [], affected_rows: 3 });
		const { Client } = makePgShim(c);
		const client = new Client({});
		const res = await client.query('DELETE FROM t');
		expect(res.rowCount).toBe(3);
		expect(res.command).toBe('DELETE');
	});

	it('falls back to rows.length for rowCount when affected_rows is 0', async () => {
		const c = ctx();
		(c._query as jest.MockedFunction<DbQuery>).mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], affected_rows: 0 });
		const { Client } = makePgShim(c);
		const client = new Client({});
		const res = await client.query('SELECT id FROM t');
		expect(res.rowCount).toBe(2);
		expect(res.command).toBe('SELECT');
	});

	// -------------------------------------------------------------------------
	// Callback forms (A0 spike: Sequelize calls all three query forms)
	// -------------------------------------------------------------------------

	it('query(sql, cb) invokes cb(null, result) and returns undefined', async () => {
		const c = ctx();
		(c._query as jest.MockedFunction<DbQuery>).mockResolvedValueOnce({ rows: [{ v: 'b' }], affected_rows: 0 });
		const { Client } = makePgShim(c);
		const client = new Client({});
		let cbResult: unknown;
		let cbErr: unknown;
		const returnVal = (client as any).query('SELECT v FROM t', (err: unknown, res: unknown) => {
			cbErr = err;
			cbResult = res;
		});
		// Return value must NOT be a thenable (Sequelize distinguishes callback vs promise mode)
		expect(returnVal).toBeUndefined();
		// cb is async; wait a tick
		await Promise.resolve();
		await Promise.resolve();
		expect(cbErr).toBeNull();
		expect((cbResult as any).rows).toEqual([{ v: 'b' }]);
		expect((cbResult as any).command).toBe('SELECT');
	});

	it('query(sql, values, cb) invokes cb(null, result) and returns undefined', async () => {
		const c = ctx();
		(c._query as jest.MockedFunction<DbQuery>).mockResolvedValueOnce({ rows: [], affected_rows: 1 });
		const { Client } = makePgShim(c);
		const client = new Client({});
		let cbResult: unknown;
		const returnVal = (client as any).query('INSERT INTO t (v) VALUES ($1)', ['hello'], (err: unknown, res: unknown) => {
			cbResult = res;
		});
		expect(returnVal).toBeUndefined();
		await Promise.resolve();
		await Promise.resolve();
		expect(c._query).toHaveBeenCalledWith({
			token: 'tok',
			sql: 'INSERT INTO t (v) VALUES ($1)',
			nodeId: 'n1',
			params: ['hello'],
		});
		expect((cbResult as any).rowCount).toBe(1);
	});

	// -------------------------------------------------------------------------
	// connect() dual callback/promise shape (A0 spike requirement)
	// -------------------------------------------------------------------------

	it('connect(cb) calls cb(null) synchronously and does not return a Promise', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		let called = false;
		let capturedErr: unknown = 'UNSET';
		const returnVal = (client as any).connect((err: unknown) => {
			called = true;
			capturedErr = err;
		});
		expect(called).toBe(true);
		expect(capturedErr).toBeNull();
		// In callback mode the return value should be undefined (not a Promise)
		expect(returnVal).toBeUndefined();
	});

	it('connect() without cb returns a Promise', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		const p = (client as any).connect();
		expect(p).toBeInstanceOf(Promise);
		await p; // must not reject
	});

	// -------------------------------------------------------------------------
	// end() dual callback/promise shape (A0 spike: promisify wraps it)
	// -------------------------------------------------------------------------

	it('end(cb) calls cb() and returns undefined', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await (client as any).connect();
		let called = false;
		const returnVal = (client as any).end(() => {
			called = true;
		});
		expect(called).toBe(true);
		expect(returnVal).toBeUndefined();
	});

	it('end() without cb returns a Promise', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		const p = (client as any).end();
		expect(p).toBeInstanceOf(Promise);
		await p;
	});

	// -------------------------------------------------------------------------
	// on / once / removeListener (A0 spike requirement)
	// -------------------------------------------------------------------------

	it('on/once/removeListener return this (chainable)', () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		expect((client as any).on('error', () => {})).toBe(client);
		expect((client as any).once('end', () => {})).toBe(client);
		expect((client as any).removeListener('end', () => {})).toBe(client);
	});

	// -------------------------------------------------------------------------
	// client.connection inner object (A0 spike: parameterStatus hooks)
	// -------------------------------------------------------------------------

	it('client.connection supports on/removeListener and returns itself', () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		const conn = (client as any).connection;
		expect(conn).toBeDefined();
		expect(conn.on('parameterStatus', () => {})).toBe(conn);
		expect(conn.removeListener('parameterStatus', () => {})).toBe(conn);
		expect(conn.once('end', () => {})).toBe(conn);
	});

	// -------------------------------------------------------------------------
	// Module-level exports (A0 spike: Sequelize reads these off dialectModule)
	// -------------------------------------------------------------------------

	it('makePgShim exports types with getTypeParser, setTypeParser, arrayParser', () => {
		const c = ctx();
		const shim = makePgShim(c);
		expect(typeof shim.types.getTypeParser).toBe('function');
		expect(typeof shim.types.setTypeParser).toBe('function');
		expect(shim.types.arrayParser).toBeDefined();
		expect(typeof shim.types.arrayParser.create).toBe('function');
		// getTypeParser returns an identity parser
		const parser = shim.types.getTypeParser(0);
		expect(parser('hello')).toBe('hello');
		// arrayParser.create returns object with parse
		const ap = shim.types.arrayParser.create('anything');
		expect(ap.parse('val')).toBe('val');
	});

	it('makePgShim exports defaults as empty object', () => {
		const c = ctx();
		const shim = makePgShim(c);
		expect(shim.defaults).toBeDefined();
		expect(typeof shim.defaults).toBe('object');
	});

	it('escapeIdentifier wraps in double-quotes and escapes internal quotes', () => {
		const c = ctx();
		const shim = makePgShim(c);
		expect(shim.escapeIdentifier('myTable')).toBe('"myTable"');
		expect(shim.escapeIdentifier('my"Table')).toBe('"my""Table"');
	});

	it('escapeLiteral wraps in single-quotes and escapes single-quotes', () => {
		const c = ctx();
		const shim = makePgShim(c);
		expect(shim.escapeLiteral("it's")).toBe("'it''s'");
		expect(shim.escapeLiteral('hello')).toBe("'hello'");
	});

	// -------------------------------------------------------------------------
	// _sessionId placeholder (task requirement: field present but unused)
	// -------------------------------------------------------------------------

	it('client has _sessionId field initialized to undefined', () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		expect((client as any)._sessionId).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// Config-object query form: query({text, values}, cb?)
	// -------------------------------------------------------------------------

	it('query({text, values}, cb) invokes cb with result', async () => {
		const c = ctx();
		(c._query as jest.MockedFunction<DbQuery>).mockResolvedValueOnce({ rows: [], affected_rows: 5 });
		const { Client } = makePgShim(c);
		const client = new Client({});
		let cbResult: unknown;
		const returnVal = (client as any).query({ text: 'UPDATE t SET v=$1 WHERE id=$2', values: ['y', 2] }, (err: unknown, res: unknown) => {
			cbResult = res;
		});
		expect(returnVal).toBeUndefined();
		await Promise.resolve();
		await Promise.resolve();
		expect(c._query).toHaveBeenCalledWith({
			token: 'tok',
			sql: 'UPDATE t SET v=$1 WHERE id=$2',
			nodeId: 'n1',
			params: ['y', 2],
		});
		expect((cbResult as any).rowCount).toBe(5);
		expect((cbResult as any).command).toBe('UPDATE');
	});

	it('does not send sessionId to db.query when _sessionId is undefined', async () => {
		const c = ctx();
		const { Client } = makePgShim(c);
		const client = new Client({});
		await client.query('SELECT 1');
		// sessionId must not be forwarded when undefined
		expect(c._query).toHaveBeenCalledWith({ token: 'tok', sql: 'SELECT 1', nodeId: 'n1' });
	});
});
