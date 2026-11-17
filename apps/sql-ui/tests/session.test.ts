// MIT License
//
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
// SESSION — tool calls by address, and the revival retry of direct connections
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RocketRideClient } from 'shell';
import type { DirectConnection, SqlEndpoint } from '../src/connect';
import { createSqlSession } from '../src/connect/session';
import { resolveEndpoint } from '../src/connect/resolver';

// =============================================================================
// FAKES
// =============================================================================

/** One recorded `client.tool()` call. */
interface IToolCall {
	address: string;
	nodeId: string;
	tool: string;
	input: Record<string, unknown>;
}

/** The fake client and what it recorded. */
interface IFakeClient {
	client: RocketRideClient;
	calls: IToolCall[];
	/** How many times `use()` started (or revived) a temp pipeline. */
	starts: number;
}

/** A pipeline-bound endpoint: no revival exists for it. */
const ENDPOINT: SqlEndpoint = {
	key: 'acme.p1:db_1',
	address: 'acme.p1',
	pipelineName: 'Pipeline A',
	nodeId: 'db_1',
	nodeName: 'Orders DB',
};

/** A direct connection: its temp pipeline can be revived. */
const DIRECT: DirectConnection = {
	id: 'c1',
	name: 'Shop',
	mode: 'direct',
	provider: 'db_mysql',
	config: { host: 'localhost' },
};

/**
 * Build a fake client whose `tool()` answers through `behave` and whose
 * `use()` starts a temp pipeline at the address `acme.sqlconn-c1.tools_1`.
 *
 * @param behave - Answer (or throw) per recorded call and its index.
 * @returns The fake and its records.
 */
function fakeClient(behave: (call: IToolCall, index: number) => unknown): IFakeClient {
	const calls: IToolCall[] = [];
	const state = { starts: 0 };
	const client = {
		use: async () => {
			state.starts += 1;
			return { token: 'acme.sqlconn-c1.tools_1' };
		},
		terminate: async () => undefined,
		tool: async ({ address, nodeId, tool, input }: { address: string; nodeId: string; tool: string; input: Record<string, unknown> }) => {
			const call: IToolCall = { address, nodeId, tool, input };
			calls.push(call);
			return behave(call, calls.length - 1);
		},
	} as unknown as RocketRideClient;
	return {
		client,
		calls,
		get starts() {
			return state.starts;
		},
	};
}

/** Fail the first call, answer `result` afterwards. */
const failFirst = (result: unknown) => (_call: IToolCall, index: number): unknown => {
	if (index === 0) throw new Error('tool call failed');
	return result;
};

// =============================================================================
// ADDRESSING
// =============================================================================

describe('tool calls by address', () => {
	it('makes every call on the endpoint address and node, with no token lookup', async () => {
		const fake = fakeClient(() => ({ rows: [], affected_rows: 0 }));
		const session = createSqlSession(fake.client, ENDPOINT);
		await session.execute('SELECT 1');
		await session.getSchema('orders');
		assert.deepEqual(
			fake.calls.map((c) => [c.address, c.nodeId, c.tool]),
			[['acme.p1', 'db_1', 'execute'], ['acme.p1', 'db_1', 'get_schema']],
		);
		assert.deepEqual(fake.calls[1]!.input, { table: 'orders' });
	});

	it('forwards bind params and omits the field entirely when there is nothing to bind', async () => {
		const fake = fakeClient(() => ({ rows: [], affected_rows: 0 }));
		const session = createSqlSession(fake.client, ENDPOINT);
		await session.execute('SELECT * FROM t WHERE a = $1', { params: ['x'] });
		await session.execute('SELECT 1', { params: [] });
		await session.execute('SELECT 2');
		assert.deepEqual(fake.calls[0]!.input, { sql: 'SELECT * FROM t WHERE a = $1', params: ['x'] });
		assert.deepEqual(fake.calls[1]!.input, { sql: 'SELECT 1' });
		assert.deepEqual(fake.calls[2]!.input, { sql: 'SELECT 2' });
	});

	it('maps an unrecognised dialect string to unknown', async () => {
		const fake = fakeClient(() => ({ dialect: 'duckdb' }));
		assert.equal(await createSqlSession(fake.client, ENDPOINT).dialect(), 'unknown');
	});
});

// =============================================================================
// RETRY POLICY
// =============================================================================

describe('retry policy', () => {
	it('never retries on a pipeline-bound endpoint: the server starts a dormant engine itself', async () => {
		const fake = fakeClient(failFirst({ rows: [], affected_rows: 0 }));
		const session = createSqlSession(fake.client, ENDPOINT);
		await assert.rejects(session.execute('SELECT 1', { idempotent: true }), /tool call failed/);
		assert.equal(fake.calls.length, 1);
	});

	it('does NOT re-send a statement that was not marked idempotent, even with a revival at hand', async () => {
		const fake = fakeClient(failFirst({ rows: [], affected_rows: 1 }));
		const endpoint = await resolveEndpoint(fake.client, DIRECT);
		const session = createSqlSession(fake.client, endpoint);
		await assert.rejects(session.execute("INSERT INTO orders (id) VALUES ('x')"), /tool call failed/);
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.starts, 1);
	});

	it('revives a direct connection once and retries an idempotent statement on the same address', async () => {
		const fake = fakeClient(failFirst({ rows: [{ id: 1 }], affected_rows: 0 }));
		const endpoint = await resolveEndpoint(fake.client, DIRECT);
		assert.equal(endpoint.address, 'acme.sqlconn-c1.tools_1');
		const session = createSqlSession(fake.client, endpoint);
		const result = await session.execute('SELECT * FROM orders', { idempotent: true });
		assert.deepEqual(result, { rows: [{ id: 1 }], affected_rows: 0 });
		assert.deepEqual(fake.calls.map((c) => c.address), ['acme.sqlconn-c1.tools_1', 'acme.sqlconn-c1.tools_1']);
		assert.equal(fake.starts, 2);
	});

	it('retries get_schema and dialect after a revival', async () => {
		for (const run of [
			{ call: (s: ReturnType<typeof createSqlSession>) => s.getSchema(), tool: 'get_schema', result: { tables: {} } },
			{ call: (s: ReturnType<typeof createSqlSession>) => s.dialect(), tool: 'dialect', result: { dialect: 'mysql' } },
		]) {
			const fake = fakeClient(failFirst(run.result));
			const endpoint = await resolveEndpoint(fake.client, DIRECT);
			await run.call(createSqlSession(fake.client, endpoint));
			assert.deepEqual(fake.calls.map((c) => c.tool), [run.tool, run.tool]);
			assert.equal(fake.starts, 2);
		}
	});
});

// =============================================================================
// refreshSchema FALLBACK
// =============================================================================

describe('refreshSchema fallback', () => {
	it('returns the refresh tool result unflagged when the node has the tool', async () => {
		const fake = fakeClient(() => ({ database: 'shop', tables: { orders: { columns: [] } } }));
		const schema = await createSqlSession(fake.client, ENDPOINT).refreshSchema();
		assert.equal(schema.stale, undefined);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema']);
	});

	it('falls back to get_schema and flags the result stale, whatever the error says', async () => {
		for (const message of ['tool.invoke: refresh_schema not owned', 'socket hang up', '']) {
			const fake = fakeClient((call) => {
				if (call.tool === 'refresh_schema') throw new Error(message);
				return { database: 'shop', tables: {} };
			});
			const schema = await createSqlSession(fake.client, ENDPOINT).refreshSchema();
			assert.equal(schema.stale, true);
			assert.equal(schema.database, 'shop');
			assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'get_schema']);
		}
	});

	it('spends the revival retry on refresh_schema before falling back', async () => {
		const fake = fakeClient((call) => {
			if (call.tool === 'refresh_schema') throw new Error('tool call failed');
			return { database: 'shop', tables: {} };
		});
		const endpoint = await resolveEndpoint(fake.client, DIRECT);
		const schema = await createSqlSession(fake.client, endpoint).refreshSchema();
		assert.equal(schema.stale, true);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'refresh_schema', 'get_schema']);
	});

	it('surfaces the fallback failure when get_schema fails too', async () => {
		const fake = fakeClient((call) => {
			throw new Error(call.tool === 'get_schema' ? 'reflection is down' : 'no such tool');
		});
		await assert.rejects(createSqlSession(fake.client, ENDPOINT).refreshSchema(), /reflection is down/);
	});
});
