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
// CONNECT SESSION — unit tests for the retry policy and the refresh fallback
// =============================================================================
//
// A session caches the owning task's token. The token goes stale when the
// task restarts, and a stale token fails EXACTLY like a statement the
// database refused — the transport carries no distinguishing signal. So the
// retry is a per-call decision: reads may be repeated, writes must not be.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RocketRideClient } from 'shell';
import type { ISqlEndpoint } from '../src/connect';
import { createSqlSession } from '../src/connect/session';

// =============================================================================
// FAKE CLIENT
// =============================================================================

/** One recorded tool invocation. */
interface IToolCall {
	/** The token the call rode on. */
	token: string;
	/** The tool name. */
	tool: string;
	/** The tool input. */
	input: Record<string, unknown>;
}

/** A fake client plus the call log it records. */
interface IFakeClient {
	/** The client handed to the session. */
	client: RocketRideClient;
	/** Every tool invocation, in order. */
	calls: IToolCall[];
	/** How many times the token was resolved. */
	tokenLookups: number;
}

/** The endpoint every session in this suite binds to. */
const ENDPOINT: ISqlEndpoint = {
	key: 'p1:s1:db_1',
	projectId: 'p1',
	pipelineName: 'Pipeline A',
	source: 's1',
	nodeId: 'db_1',
	nodeName: 'Orders DB',
	provider: 'db_mysql',
	running: true,
};

/**
 * Build a fake client over a token sequence and a per-call tool behaviour.
 *
 * @param tokens - Tokens handed out by successive getTaskToken calls; the
 *                 last one repeats once exhausted.
 * @param behave - Called per invocation; throw to fail it, return the result.
 * @returns The fake client and its call log.
 */
function fakeClient(tokens: string[], behave: (call: IToolCall, index: number) => unknown): IFakeClient {
	const calls: IToolCall[] = [];
	const state = { tokenLookups: 0 };
	const client = {
		getTaskToken: async () => {
			const token = tokens[Math.min(state.tokenLookups, tokens.length - 1)];
			state.tokenLookups += 1;
			return token;
		},
		tool: async ({ token, tool, input }: { token: string; tool: string; input: Record<string, unknown> }) => {
			const call: IToolCall = { token, tool, input };
			calls.push(call);
			return behave(call, calls.length - 1);
		},
	} as unknown as RocketRideClient;
	return {
		client,
		calls,
		get tokenLookups() {
			return state.tokenLookups;
		},
	};
}

/** A behaviour that fails the first invocation and succeeds afterwards. */
const failFirst = (result: unknown) => (_call: IToolCall, index: number): unknown => {
	if (index === 0) throw new Error('tool call failed');
	return result;
};

// =============================================================================
// EXECUTE — THE WRITE-SAFETY RULE
// =============================================================================

describe('execute retry policy', () => {
	it('does NOT re-send a statement that was not marked idempotent, even on a fresh token', async () => {
		// The regression this rule exists for: the task restarted, the cached
		// token is stale, and a blind retry would run the INSERT twice.
		const fake = fakeClient(['stale', 'fresh'], failFirst({ rows: [], affected_rows: 1 }));
		const session = createSqlSession(fake.client, ENDPOINT);

		await assert.rejects(
			session.execute("INSERT INTO orders (id) VALUES ('x')"),
			/tool call failed/,
		);
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0]!.token, 'stale');
	});

	it('retries an idempotent statement once with the re-resolved token', async () => {
		const fake = fakeClient(['stale', 'fresh'], failFirst({ rows: [{ id: 1 }], affected_rows: 0 }));
		const session = createSqlSession(fake.client, ENDPOINT);

		const result = await session.execute('SELECT * FROM orders', { idempotent: true });
		assert.deepEqual(result, { rows: [{ id: 1 }], affected_rows: 0 });
		assert.deepEqual(fake.calls.map((c) => c.token), ['stale', 'fresh']);
	});

	it('does not retry an idempotent statement when the token came back unchanged', async () => {
		// Same token = the task did not restart, so the failure was real SQL.
		const fake = fakeClient(['same'], failFirst({ rows: [], affected_rows: 0 }));
		const session = createSqlSession(fake.client, ENDPOINT);

		await assert.rejects(session.execute('SELECT 1', { idempotent: true }), /tool call failed/);
		assert.equal(fake.calls.length, 1);
	});

	it('forwards bind params and omits the field entirely when there is nothing to bind', async () => {
		const fake = fakeClient(['t'], () => ({ rows: [], affected_rows: 0 }));
		const session = createSqlSession(fake.client, ENDPOINT);

		await session.execute('SELECT * FROM t WHERE a = $1', { params: ['x'] });
		await session.execute('SELECT 1', { params: [] });
		await session.execute('SELECT 2');

		assert.deepEqual(fake.calls[0]!.input, { sql: 'SELECT * FROM t WHERE a = $1', params: ['x'] });
		assert.deepEqual(fake.calls[1]!.input, { sql: 'SELECT 1' });
		assert.deepEqual(fake.calls[2]!.input, { sql: 'SELECT 2' });
	});
});

// =============================================================================
// REFLECTION CALLS — ALWAYS SAFE TO REPEAT
// =============================================================================

describe('reflection retry policy', () => {
	it('retries get_schema and dialect on a token change', async () => {
		for (const run of [
			{ call: (s: ReturnType<typeof createSqlSession>) => s.getSchema(), tool: 'get_schema', result: { tables: {} } },
			{ call: (s: ReturnType<typeof createSqlSession>) => s.dialect(), tool: 'dialect', result: { dialect: 'mysql' } },
		]) {
			const fake = fakeClient(['stale', 'fresh'], failFirst(run.result));
			await run.call(createSqlSession(fake.client, ENDPOINT));
			assert.deepEqual(fake.calls.map((c) => c.tool), [run.tool, run.tool]);
			assert.deepEqual(fake.calls.map((c) => c.token), ['stale', 'fresh']);
		}
	});

	it('maps an unrecognised dialect string to unknown', async () => {
		const fake = fakeClient(['t'], () => ({ dialect: 'duckdb' }));
		assert.equal(await createSqlSession(fake.client, ENDPOINT).dialect(), 'unknown');
	});

	it('refuses to bind when no task is running', async () => {
		const fake = fakeClient([''], () => ({}));
		await assert.rejects(createSqlSession(fake.client, ENDPOINT).getSchema(), /No running task/);
	});
});

// =============================================================================
// REFRESH SCHEMA — FALL BACK ON ANY ERROR, NEVER ON ERROR TEXT
// =============================================================================

describe('refreshSchema fallback', () => {
	it('returns the refresh tool result unflagged when the node has the tool', async () => {
		const fake = fakeClient(['t'], () => ({ database: 'shop', tables: { orders: { columns: [] } } }));
		const schema = await createSqlSession(fake.client, ENDPOINT).refreshSchema();
		assert.equal(schema.stale, undefined);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema']);
	});

	it('falls back to get_schema and flags the result stale, whatever the error says', async () => {
		// Three unrelated wordings, one behaviour: no text is inspected.
		for (const message of ['tool.invoke: refresh_schema not owned', 'socket hang up', '']) {
			const fake = fakeClient(['t'], (call) => {
				if (call.tool === 'refresh_schema') throw new Error(message);
				return { database: 'shop', tables: {} };
			});
			const schema = await createSqlSession(fake.client, ENDPOINT).refreshSchema();
			assert.equal(schema.stale, true);
			assert.equal(schema.database, 'shop');
			// The token came back unchanged, so refresh_schema is NOT retried:
			// one attempt, then the fallback. Asserting the whole sequence
			// rather than its last entry is what makes that visible.
			assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'get_schema']);
		}
	});

	it('spends the token retry on refresh_schema before falling back', async () => {
		// The other half of the sequence: a stale token makes refresh_schema
		// worth repeating, and only the second failure reaches get_schema — so
		// a fallback is never taken on a failure the retry would have fixed.
		const fake = fakeClient(['stale', 'fresh'], (call) => {
			if (call.tool === 'refresh_schema') throw new Error('tool call failed');
			return { database: 'shop', tables: {} };
		});
		const schema = await createSqlSession(fake.client, ENDPOINT).refreshSchema();
		assert.equal(schema.stale, true);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'refresh_schema', 'get_schema']);
		assert.deepEqual(fake.calls.map((c) => c.token), ['stale', 'fresh', 'fresh']);
	});

	it('surfaces the fallback failure when get_schema fails too', async () => {
		const fake = fakeClient(['t'], (call) => {
			throw new Error(call.tool === 'get_schema' ? 'reflection is down' : 'no such tool');
		});
		await assert.rejects(createSqlSession(fake.client, ENDPOINT).refreshSchema(), /reflection is down/);
	});
});
