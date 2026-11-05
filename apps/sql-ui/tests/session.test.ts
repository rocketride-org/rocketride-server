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
// CONNECT SESSION — SQL Explorer's face over the shared session
// =============================================================================
//
// A session reads the owning task's token from the endpoint store's vault. A
// task that restarts fails the call with the server's TASK_STOPPED code — the
// same failure a really-stopped task produces — so retrying is a per-CALL
// decision: reads may be repeated, a write must not be, and even a read is
// repeated only after re-discovery shows the SAME endpoint running again.
//
// Port of f63da6e22 (tests/session.test.ts; Rod's suite's cases kept under the
// new rule), plus the R5 waits each tool is sent with.
// =============================================================================

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer/types';
import type { SqlSession } from '../src/connect';
import { createSqlSession } from '../src/connect/session';
import { ExplorerToolError } from 'shared/explorer/errors';
import { createGeneration } from 'shared/explorer/generation';
import { currentRows, describeEndpoint, registerEndpoint, resetEndpoints, sqlEndpoints } from './support';

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
	/** The SDK timeout the session asked for (undefined: none). */
	timeout: number | undefined;
}

/** A fake client plus the call log it records. */
interface IFakeClient {
	/** The client handed to the session. */
	client: IExplorerClient;
	/** Every tool invocation, in order. */
	calls: IToolCall[];
}

/**
 * Build a fake client: `getTasks` answers a re-discovery from the registered
 * rows, and `tool` behaves per call.
 *
 * @param behave - Called per invocation; throw to fail it, return the result.
 * @returns The fake client and its call log.
 */
function fakeClient(behave: (call: IToolCall, index: number) => unknown): IFakeClient {
	const calls: IToolCall[] = [];
	const client: IExplorerClient = {
		getTasks: async () => currentRows() as unknown as Array<Record<string, unknown>>,
		getTaskPipeline: async () => undefined,
		tool: async <T,>({ token, tool, input, timeout }: { token: string; tool: string; input?: Record<string, unknown>; timeout?: number }): Promise<T> => {
			const call: IToolCall = { token, tool, input: input ?? {}, timeout };
			calls.push(call);
			return behave(call, calls.length - 1) as T;
		},
	};
	return { client, calls };
}

/**
 * An error shaped like the SDK's DAPException: a message and a server code.
 *
 * @param message - The message.
 * @param code - The code.
 * @returns The error.
 */
function stopped(message = 'Task was stopped', code: string | undefined = 'TASK_STOPPED'): Error {
	return Object.assign(new Error(message), code === undefined ? {} : { code });
}

/** A behaviour that fails the first invocation as a restarting task and succeeds afterwards. */
const failFirst = (result: unknown) => (_call: IToolCall, index: number): unknown => {
	if (index === 0) throw stopped();
	return result;
};

let endpoint: IExplorerEndpoint;

/**
 * SQL Explorer's session on the registered endpoint, over a fake client.
 *
 * @param client - The fake client.
 * @returns The session.
 */
function sessionOn(client: IExplorerClient): SqlSession {
	return createSqlSession(sqlEndpoints.session(client, endpoint), describeEndpoint(endpoint));
}

beforeEach(async () => {
	resetEndpoints();
	endpoint = await registerEndpoint('session-suite');
});

// =============================================================================
// EXECUTE — THE WRITE-SAFETY RULE
// =============================================================================

describe('execute retry policy', () => {
	it('does NOT re-send a statement that was not marked idempotent, even when the task restarted', async () => {
		// The regression this rule exists for: the task restarted and a blind
		// retry would run the INSERT twice.
		const fake = fakeClient(failFirst({ rows: [], affected_rows: 1 }));
		await assert.rejects(sessionOn(fake.client).execute("INSERT INTO orders (id) VALUES ('x')"), /Task was stopped/);
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0]!.token, 'tk_sentinel_session-suite');
	});

	it('retries an idempotent statement once, after re-discovery finds the same endpoint running', async () => {
		const fake = fakeClient(failFirst({ rows: [{ id: 1 }], affected_rows: 0 }));
		const result = await sessionOn(fake.client).execute('SELECT * FROM orders', { idempotent: true });
		assert.deepEqual(result, { rows: [{ id: 1 }], affected_rows: 0 });
		// Task tokens are deterministic: the restarted task has the SAME token.
		assert.deepEqual(fake.calls.map((c) => c.token), ['tk_sentinel_session-suite', 'tk_sentinel_session-suite']);
	});

	it('sends nothing more for a read whose generation ticket expired while it waited: the one retry is dropped', async () => {
		// The batch was abandoned (Stop waiting, the tab closed, the account
		// changed) after the first attempt was refused before dispatch: the
		// session must not send the statement again when the task comes back.
		const generation = createGeneration();
		const ticket = generation.next();
		const fake = fakeClient((_call, index) => {
			if (index === 0) {
				generation.invalidate();
				throw stopped();
			}
			return { rows: [{ id: 1 }], affected_rows: 0 };
		});
		await assert.rejects(
			sessionOn(fake.client).execute('SELECT * FROM orders', { idempotent: true, generation: ticket }),
			(error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale',
		);
		assert.equal(fake.calls.length, 1);
	});

	it('drops the answer of a read whose ticket expired while it ran, and still sends a current one', async () => {
		const generation = createGeneration();
		const stale = generation.next();
		const fake = fakeClient(() => {
			generation.next();
			return { rows: [{ id: 1 }], affected_rows: 0 };
		});
		await assert.rejects(sessionOn(fake.client).execute('SELECT 1', { idempotent: true, generation: stale }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		const current = generation.next();
		const quiet = fakeClient(() => ({ rows: [{ id: 2 }], affected_rows: 0 }));
		assert.deepEqual(await sessionOn(quiet.client).execute('SELECT 2', { generation: current }), { rows: [{ id: 2 }], affected_rows: 0 });
	});

	it('does not retry an idempotent statement whose failure carries no restart code', async () => {
		// A real SQL error: same message text a restart might produce, but no code.
		const fake = fakeClient((_call, index) => {
			if (index === 0) throw new Error('TASK_STOPPED: Task was stopped');
			return { rows: [], affected_rows: 0 };
		});
		await assert.rejects(sessionOn(fake.client).execute('SELECT 1', { idempotent: true }), /Task was stopped/);
		assert.equal(fake.calls.length, 1);
	});

	it('does not retry any other server code', async () => {
		for (const code of ['TASK_NOT_REGISTERED', 'TASK_COMPLETED', 'TASK_AMBIGUOUS']) {
			const failing = fakeClient(() => { throw stopped('nope', code); });
			await assert.rejects(sessionOn(failing.client).execute('SELECT 1', { idempotent: true }), /nope/);
			assert.equal(failing.calls.length, 1, code);
		}
	});

	it('forwards bind params and omits the field entirely when there is nothing to bind', async () => {
		const fake = fakeClient(() => ({ rows: [], affected_rows: 0 }));
		const session = sessionOn(fake.client);
		await session.execute('SELECT * FROM t WHERE a = $1', { params: ['x'] });
		await session.execute('SELECT 1', { params: [] });
		await session.execute('SELECT 2');
		assert.deepEqual(fake.calls[0]!.input, { sql: 'SELECT * FROM t WHERE a = $1', params: ['x'] });
		assert.deepEqual(fake.calls[1]!.input, { sql: 'SELECT 1' });
		assert.deepEqual(fake.calls[2]!.input, { sql: 'SELECT 2' });
	});
});

// =============================================================================
// WAITS (R5)
// =============================================================================

describe('the wait each tool is sent with (R5)', () => {
	it('sends dialect 15 s, get_schema 60 s and refresh_schema 135 s, each plus the SDK slack of 1 s', async () => {
		const fake = fakeClient((call) => (call.tool === 'dialect' ? { dialect: 'postgres' } : { tables: {} }));
		const session = sessionOn(fake.client);
		await session.dialect();
		await session.getSchema();
		await session.refreshSchema();
		assert.deepEqual(fake.calls.map((c) => [c.tool, c.timeout]), [['dialect', 16_000], ['get_schema', 61_000], ['refresh_schema', 136_000]]);
	});

	it('waits as long as a statement takes when the node publishes no statement deadline (today\'s SQL nodes)', async () => {
		const fake = fakeClient(() => ({ rows: [], affected_rows: 0 }));
		await sessionOn(fake.client).execute('SELECT 1');
		assert.equal(fake.calls[0]!.timeout, undefined);
	});

	it('waits the published statement deadline plus 10 s when the node publishes one', async () => {
		resetEndpoints();
		const client: IExplorerClient = {
			getTasks: async () => currentRows() as unknown as Array<Record<string, unknown>>,
			getTaskPipeline: async () => undefined,
			tool: async () => ({ dialect: 'postgres', limits: { statement_timeout_ms: 30_000 } }) as never,
		};
		await registerEndpoint('deadline-suite');
		// Probe through a client that publishes a deadline, so the session's info carries it.
		await sqlEndpoints.refresh(client, { reprobe: true });
		endpoint = sqlEndpoints.getState().endpoints.find((e) => e.projectId === 'deadline-suite')!;
		const fake = fakeClient(() => ({ rows: [], affected_rows: 0 }));
		await sessionOn(fake.client).execute('SELECT 1');
		assert.equal(fake.calls[0]!.timeout, 30_000 + 10_000 + 1_000);
	});
});

// =============================================================================
// REFLECTION CALLS — ALWAYS SAFE TO REPEAT
// =============================================================================

describe('reflection retry policy', () => {
	it('retries get_schema and dialect once on a restarted task', async () => {
		for (const run of [
			{ call: (s: SqlSession) => s.getSchema(), tool: 'get_schema', result: { tables: {} } },
			{ call: (s: SqlSession) => s.dialect(), tool: 'dialect', result: { dialect: 'mysql' } },
		]) {
			const fake = fakeClient(failFirst(run.result));
			await run.call(sessionOn(fake.client));
			assert.deepEqual(fake.calls.map((c) => c.tool), [run.tool, run.tool]);
		}
	});

	it('maps an unrecognised dialect string to unknown', async () => {
		const fake = fakeClient(() => ({ dialect: 'duckdb' }));
		assert.equal(await sessionOn(fake.client).dialect(), 'unknown');
	});

	it('refuses to call when no task is running for the endpoint', async () => {
		resetEndpoints();
		const fake = fakeClient(() => ({}));
		await assert.rejects(sessionOn(fake.client).getSchema(), /No running task/);
		assert.equal(fake.calls.length, 0);
	});
});

// =============================================================================
// REFRESH SCHEMA — FALL BACK ON ANY ERROR, NEVER ON ERROR TEXT
// =============================================================================

describe('refreshSchema fallback', () => {
	it('returns the refresh tool result unflagged when the node has the tool', async () => {
		const fake = fakeClient(() => ({ database: 'shop', tables: { orders: { columns: [] } } }));
		const schema = await sessionOn(fake.client).refreshSchema();
		assert.equal(schema.stale, undefined);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema']);
	});

	it('falls back to get_schema and flags the result stale, whatever the error says', async () => {
		// Three unrelated wordings, one behaviour: no text is inspected.
		for (const message of ['tool.invoke: refresh_schema not owned', 'socket hang up', '']) {
			const fake = fakeClient((call) => {
				if (call.tool === 'refresh_schema') throw new Error(message);
				return { database: 'shop', tables: {} };
			});
			const schema = await sessionOn(fake.client).refreshSchema();
			assert.equal(schema.stale, true);
			assert.equal(schema.database, 'shop');
			// No restart code, so refresh_schema is NOT retried: one attempt, then the fallback.
			assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'get_schema']);
		}
	});

	it('spends the restart retry on refresh_schema before falling back', async () => {
		// A restarting task makes refresh_schema worth repeating, and only the
		// second failure reaches get_schema — so a fallback is never taken on a
		// failure the retry would have fixed.
		const fake = fakeClient((call) => {
			if (call.tool === 'refresh_schema') throw stopped();
			return { database: 'shop', tables: {} };
		});
		const schema = await sessionOn(fake.client).refreshSchema();
		assert.equal(schema.stale, true);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'refresh_schema', 'get_schema']);
	});

	it('surfaces the fallback failure when get_schema fails too', async () => {
		const fake = fakeClient((call) => {
			throw new Error(call.tool === 'get_schema' ? 'reflection is down' : 'no such tool');
		});
		await assert.rejects(sessionOn(fake.client).refreshSchema(), /reflection is down/);
	});
});
