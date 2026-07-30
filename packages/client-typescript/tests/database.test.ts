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
import { DatabaseApi } from '../src/client/database';

function fakeClient() {
	return { tool: jest.fn(async (a: unknown) => ({ ok: true, a })) } as any;
}

describe('DatabaseApi transactions', () => {
	it('beginTransaction invokes the begin tool', async () => {
		const c = fakeClient();
		c.tool.mockResolvedValueOnce({ session_id: 's1' });
		const db = new DatabaseApi(c);
		const out = await db.beginTransaction({ token: 't', nodeId: 'n1' });
		expect(c.tool).toHaveBeenCalledWith({ token: 't', tool: 'begin', nodeId: 'n1', input: {} });
		expect(out).toEqual({ session_id: 's1' });
	});

	it('query forwards sessionId and params', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await db.query({ token: 't', sql: 'SELECT $1', params: [1], sessionId: 's1', nodeId: 'n1' });
		expect(c.tool).toHaveBeenCalledWith({
			token: 't',
			tool: 'execute',
			nodeId: 'n1',
			input: { sql: 'SELECT $1', session_id: 's1', params: [1] },
		});
	});

	it('commit invokes the commit tool', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await db.commit({ token: 't', sessionId: 's1', nodeId: 'n1' });
		expect(c.tool).toHaveBeenCalledWith({ token: 't', tool: 'commit', nodeId: 'n1', input: { session_id: 's1' } });
	});

	it('rollback invokes the rollback tool', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await db.rollback({ token: 't', sessionId: 's1', nodeId: 'n1' });
		expect(c.tool).toHaveBeenCalledWith({ token: 't', tool: 'rollback', nodeId: 'n1', input: { session_id: 's1' } });
	});

	it('commit rejects empty sessionId', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await expect(db.commit({ token: 't', sessionId: '' })).rejects.toThrow('sessionId must be a non-empty string');
		expect(c.tool).not.toHaveBeenCalled();
	});

	it('rollback rejects empty sessionId', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await expect(db.rollback({ token: 't', sessionId: '' })).rejects.toThrow('sessionId must be a non-empty string');
		expect(c.tool).not.toHaveBeenCalled();
	});

	it('beginTransaction rejects empty token', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await expect(db.beginTransaction({ token: '' })).rejects.toThrow('token must be a non-empty string');
		expect(c.tool).not.toHaveBeenCalled();
	});

	it('commit rejects empty token', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await expect(db.commit({ token: '', sessionId: 's1' })).rejects.toThrow('token must be a non-empty string');
		expect(c.tool).not.toHaveBeenCalled();
	});

	it('commit rejects whitespace-only token', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await expect(db.commit({ token: '   ', sessionId: 's1' })).rejects.toThrow('token must be a non-empty string');
		expect(c.tool).not.toHaveBeenCalled();
	});

	it('rollback rejects empty token', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await expect(db.rollback({ token: '', sessionId: 's1' })).rejects.toThrow('token must be a non-empty string');
		expect(c.tool).not.toHaveBeenCalled();
	});

	it('rollback rejects whitespace-only token', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await expect(db.rollback({ token: '   ', sessionId: 's1' })).rejects.toThrow('token must be a non-empty string');
		expect(c.tool).not.toHaveBeenCalled();
	});

	it('query omits session_id and params when not provided', async () => {
		const c = fakeClient();
		const db = new DatabaseApi(c);
		await db.query({ token: 't', sql: 'SELECT 1' });
		expect(c.tool).toHaveBeenCalledWith({
			token: 't',
			tool: 'execute',
			nodeId: undefined,
			input: { sql: 'SELECT 1' },
		});
	});
});
