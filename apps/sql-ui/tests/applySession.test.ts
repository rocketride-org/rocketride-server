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
// CONNECT SESSION — APPLY (the node's begin / execute{session_id} / commit)
// =============================================================================
//
// An Apply is the one place the app opens a transaction. The sequence is
// begin, then every statement on the session, each checked against the rows
// it must change, then commit. Anything that goes wrong after begin rolls
// back, and never commits. Nothing is ever sent twice. A node without the
// transaction tools is told apart and NOTHING is sent: the caller asks the
// user again before it sends the statements one by one. An outcome counts as
// known only when the answer is one of the refusals listed in the session;
// anything else (a dropped connection, a timeout) is unknown.
// =============================================================================

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer/types';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { SqlApplyStatement, SqlSession } from '../src/connect';
import { createSqlSession } from '../src/connect/session';
import { APPLY_STATEMENT_WAIT_MS, BEGIN_WAIT_MS, END_TX_WAIT_MS, NODE_TX_IDLE_MS, STATEMENT_WAIT_PAD_MS, TRANSACTIONS_UNAVAILABLE_CODE, isTransactionsUnavailable } from '../src/connect/tools';
import { currentRows, describeEndpoint, registerEndpoint, resetEndpoints, sqlEndpoints } from './support';

/** The SDK is told to wait this much longer than the session (shared session.ts). */
const SDK_SLACK_MS = 1_000;

/** One recorded tool invocation. */
interface ICall {
	tool: string;
	input: Record<string, unknown>;
	timeout: number | undefined;
}

/**
 * A fake client: `tool` answers per call, every call recorded.
 *
 * @param behave - Answers one call (throw to fail it).
 * @returns The client and its log.
 */
function fakeClient(behave: (call: ICall) => unknown): { client: IExplorerClient; calls: ICall[] } {
	const calls: ICall[] = [];
	const client: IExplorerClient = {
		getTasks: async () => currentRows() as unknown as Array<Record<string, unknown>>,
		getTaskPipeline: async () => undefined,
		tool: async <T,>({ tool, input, timeout }: { tool: string; input?: Record<string, unknown>; timeout?: number }): Promise<T> => {
			const call: ICall = { tool, input: input ?? {}, timeout };
			calls.push(call);
			return behave(call) as T;
		},
	};
	return { client, calls };
}

/**
 * A node with the transaction tools: `begin` opens `tx-1`, every statement
 * changes one row unless `rows` says otherwise.
 *
 * @param over - Answers to replace, by tool (or by statement text for execute).
 * @returns The behaviour.
 */
function node(over: { begin?: (call: ICall) => unknown; commit?: (call: ICall) => unknown; rollback?: (call: ICall) => unknown; execute?: (call: ICall) => unknown } = {}) {
	return (call: ICall): unknown => {
		switch (call.tool) {
			case 'begin': return over.begin ? over.begin(call) : { session_id: 'tx-1' };
			case 'commit': return over.commit ? over.commit(call) : { ok: true };
			case 'rollback': return over.rollback ? over.rollback(call) : { ok: true };
			case 'execute': return over.execute ? over.execute(call) : { rows: [], affected_rows: 1 };
			default: return { dialect: 'postgres' };
		}
	};
}

/**
 * An error the way the SDK raises a node failure.
 *
 * @param message - The node's message.
 * @param code - The server's code, if any.
 * @returns The error.
 */
function raised(message: string, code?: string): Error {
	return Object.assign(new Error(message), code === undefined ? {} : { code });
}

/** Three row edits, each bound and expected to change one row. */
const EDITS: SqlApplyStatement[] = [
	{ sql: 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2', params: ['paid', 5], expect: 1 },
	{ sql: 'INSERT INTO "orders" ("customer_id") VALUES ($1)', params: [3], expect: 1 },
	{ sql: 'DELETE FROM "orders" WHERE "order_id" = $1', params: [14], expect: 1 },
];

let endpoint: IExplorerEndpoint;

/**
 * SQL Explorer's session on the registered endpoint.
 *
 * @param client - The fake client.
 * @returns The session.
 */
function sessionOn(client: IExplorerClient): SqlSession {
	return createSqlSession(sqlEndpoints.session(client, endpoint), describeEndpoint(endpoint));
}

/**
 * The tools a log called, in order.
 *
 * @param calls - The log.
 * @returns Tool names.
 */
const tools = (calls: ICall[]): string[] => calls.map((call) => call.tool);

beforeEach(async () => {
	resetEndpoints();
	endpoint = await registerEndpoint('apply-suite');
});

describe('apply in one transaction', () => {
	it('commits on success: begin, every statement on the session in order with its binds, then commit', async () => {
		const fake = fakeClient(node());
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.deepEqual(result, { transactional: true, results: [{ affected_rows: 1 }, { affected_rows: 1 }, { affected_rows: 1 }], failure: null });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'execute', 'commit']);
		assert.deepEqual(fake.calls.slice(1, 4).map((call) => call.input), EDITS.map((statement) => ({ sql: statement.sql, params: statement.params, session_id: 'tx-1' })));
		assert.deepEqual(fake.calls[4]!.input, { session_id: 'tx-1' });
	});

	it('a statement that fails rolls back: no commit, nothing after it sent, nothing retried, the error verbatim', async () => {
		// TASK_STOPPED is the one code a read may be retried on: a write in a
		// transaction never is.
		const fake = fakeClient(node({ execute: (call) => {
			if (String(call.input.sql).startsWith('INSERT')) throw raised('SQL execution failed: duplicate key value violates unique constraint "orders_pkey"', 'TASK_STOPPED');
			return { rows: [], affected_rows: 1 };
		} }));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'rollback']);
		assert.deepEqual(fake.calls[3]!.input, { session_id: 'tx-1' });
		assert.equal(result.transactional, true);
		assert.deepEqual(result.failure, {
			index: 1,
			stage: 'statement',
			message: 'SQL execution failed: duplicate key value violates unique constraint "orders_pkey"',
			code: 'TASK_STOPPED',
			committed: 0,
			unknown: false,
			rollbackConfirmed: true,
		});
	});

	it('a statement that changes another number of rows than expected rolls back, and nothing is committed', async () => {
		const fake = fakeClient(node({ execute: (call) => ({ rows: [], affected_rows: String(call.input.sql).startsWith('DELETE') ? 0 : 1 }) }));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'execute', 'rollback']);
		assert.equal(result.failure?.stage, 'expect');
		assert.equal(result.failure?.index, 2);
		assert.equal(result.failure?.committed, 0);
		assert.equal(result.failure?.unknown, false);
		assert.match(result.failure?.message ?? '', /changed 0 rows; it must change exactly 1/);
		// Two rows is a mismatch too: the key matched more than one row.
		const two = fakeClient(node({ execute: () => ({ rows: [], affected_rows: 2 }) }));
		const second = await sessionOn(two.client).applyBatch(EDITS.slice(0, 1), { atomic: true });
		assert.equal(second.failure?.stage, 'expect');
		assert.deepEqual(tools(two.calls), ['begin', 'execute', 'rollback']);
	});

	it('a refused commit is a failure: nothing is committed, the commit is not sent again, and the session is rolled back', async () => {
		const refusal = 'commit refused: an earlier statement failed and aborted this transaction. It has been rolled back and the session is closed; no changes were committed.';
		const fake = fakeClient(node({
			commit: () => { throw raised(refusal); },
			// The node closed the session when it refused the commit.
			rollback: () => { throw raised('unknown or expired transaction session: tx-1'); },
		}));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'execute', 'commit', 'rollback']);
		assert.deepEqual(result.failure, { index: 3, stage: 'commit', message: refusal, committed: 0, unknown: false, rollbackConfirmed: true });
		assert.equal(result.transactional, true);
	});

	it('a begin the node refuses applies nothing and is thrown (nothing else is sent, nothing retried)', async () => {
		const fake = fakeClient(node({ begin: () => { throw raised('execute tool is disabled for this node (set allow_execute=true)', 'TASK_STOPPED'); } }));
		await assert.rejects(sessionOn(fake.client).applyBatch(EDITS, { atomic: true }), (error: unknown) => error instanceof ExplorerToolError && error.tool === 'begin' && /allow_execute/.test(error.message) && !isTransactionsUnavailable(error));
		assert.deepEqual(tools(fake.calls), ['begin']);
	});

	it('a begin that answers without a session id applies nothing', async () => {
		const fake = fakeClient(node({ begin: () => ({ ok: true }) }));
		await assert.rejects(sessionOn(fake.client).applyBatch(EDITS, { atomic: true }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'malformed');
		assert.deepEqual(tools(fake.calls), ['begin']);
	});

	it('names every wait: begin 40 s, commit and rollback 60 s, each statement at most the node\'s 300 s idle-transaction time', async () => {
		const fake = fakeClient(node({ execute: (call) => {
			if (String(call.input.sql).startsWith('DELETE')) throw raised('SQL execution failed: permission denied');
			return { rows: [], affected_rows: 1 };
		} }));
		await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		const timeout = (tool: string): Array<number | undefined> => fake.calls.filter((call) => call.tool === tool).map((call) => call.timeout);
		assert.equal(BEGIN_WAIT_MS, 40_000);
		assert.equal(END_TX_WAIT_MS, 60_000);
		assert.equal(APPLY_STATEMENT_WAIT_MS, NODE_TX_IDLE_MS);
		assert.equal(NODE_TX_IDLE_MS, 300_000);
		assert.deepEqual(timeout('begin'), [BEGIN_WAIT_MS + SDK_SLACK_MS]);
		assert.deepEqual(timeout('rollback'), [END_TX_WAIT_MS + SDK_SLACK_MS]);
		// Each statement gets its own wait (not what is left of a shared one), so a long plan is not cut off as a whole.
		assert.deepEqual(timeout('execute'), [APPLY_STATEMENT_WAIT_MS + SDK_SLACK_MS, APPLY_STATEMENT_WAIT_MS + SDK_SLACK_MS, APPLY_STATEMENT_WAIT_MS + SDK_SLACK_MS]);
	});
});

// =============================================================================
// DA-R2 I2: ONLY A TRANSACTION CAPS A STATEMENT'S WAIT
// =============================================================================
//
// The 5-minute cap is the node's idle-transaction time: a statement inside a
// transaction is not waited on longer than the node would keep that
// transaction. A statement that commits on its own holds no transaction, and
// before applyBatch the designer sent each one with a plain execute: the
// node's published deadline plus the pad, or no client timeout at all. Capped
// at 5 minutes, a long MySQL ALTER was reported "may have run" and dropped
// from the plan while it kept running.
// =============================================================================

/**
 * Make the node publish a statement deadline: probe the endpoint through a
 * client whose `dialect` answer carries it, as the session reads it there.
 *
 * @param deadlineMs - The deadline the node publishes.
 */
async function publishDeadline(deadlineMs: number): Promise<void> {
	resetEndpoints();
	await registerEndpoint('apply-deadline');
	const prober: IExplorerClient = {
		getTasks: async () => currentRows() as unknown as Array<Record<string, unknown>>,
		getTaskPipeline: async () => undefined,
		tool: async () => ({ dialect: 'mysql', limits: { statement_timeout_ms: deadlineMs } }) as never,
	};
	await sqlEndpoints.refresh(prober, { reprobe: true });
	endpoint = sqlEndpoints.getState().endpoints.find((e) => e.projectId === 'apply-deadline')!;
}

describe('DA-R2 I2: the per-statement path waits as a statement always did; only a transaction caps it', () => {
	it('a node that publishes no deadline: each statement committed on its own gets no client timeout', async () => {
		const fake = fakeClient(node());
		await sessionOn(fake.client).applyBatch(EDITS, { atomic: false });
		const waits = fake.calls.filter((call) => call.tool === 'execute').map((call) => call.timeout);
		assert.deepEqual(waits, [undefined, undefined, undefined], 'not the transaction\'s 5-minute cap');
	});

	it('a node that publishes a deadline longer than 5 minutes: the statement waits all of it, plus the pad; inside a transaction it is still capped', async () => {
		const deadline = 2 * 60 * 60_000;
		await publishDeadline(deadline);
		const fake = fakeClient(node());
		const session = sessionOn(fake.client);
		await session.applyBatch(EDITS.slice(0, 1), { atomic: false });
		await session.applyBatch(EDITS.slice(0, 1), { atomic: true });
		const waits = fake.calls.filter((call) => call.tool === 'execute').map((call) => [call.input.session_id === undefined ? 'own' : 'tx', call.timeout]);
		assert.deepEqual(waits, [['own', deadline + STATEMENT_WAIT_PAD_MS + SDK_SLACK_MS], ['tx', APPLY_STATEMENT_WAIT_MS + SDK_SLACK_MS]]);
	});

	it('a node that publishes a shorter deadline: both paths wait that', async () => {
		const deadline = 30_000;
		await publishDeadline(deadline);
		const fake = fakeClient(node());
		const session = sessionOn(fake.client);
		await session.applyBatch(EDITS.slice(0, 1), { atomic: false });
		await session.applyBatch(EDITS.slice(0, 1), { atomic: true });
		const waits = fake.calls.filter((call) => call.tool === 'execute').map((call) => call.timeout);
		assert.deepEqual(waits, [deadline + STATEMENT_WAIT_PAD_MS + SDK_SLACK_MS, deadline + STATEMENT_WAIT_PAD_MS + SDK_SLACK_MS]);
	});
});

describe('C-1: a node without the transaction tools applies nothing until the user agrees to go without one', () => {
	it('asked for one transaction, a node with no begin tool gets nothing else: a typed refusal, transactions-unavailable', async () => {
		const fake = fakeClient(node({ begin: () => { throw raised('No handler found for tool "begin" on node "db_1"'); } }));
		await assert.rejects(sessionOn(fake.client).applyBatch(EDITS, { atomic: true }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.code, TRANSACTIONS_UNAVAILABLE_CODE);
			assert.equal(error.kind, 'upgrade');
			assert.ok(isTransactionsUnavailable(error));
			assert.match(error.message, /no transaction tools, so nothing was applied/);
			return true;
		});
		assert.deepEqual(tools(fake.calls), ['begin'], 'no statement was sent');
	});

	it('sent again without a transaction (after the user agreed), each statement commits on its own and the first failure stops the rest', async () => {
		const fake = fakeClient(node({ execute: (call) => {
			if (String(call.input.sql).startsWith('INSERT')) throw raised('SQL execution failed: null value in column "customer_id"');
			return { rows: [], affected_rows: 1 };
		} }));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: false });
		assert.deepEqual(tools(fake.calls), ['execute', 'execute']);
		assert.equal(fake.calls.some((call) => 'session_id' in call.input), false, 'no statement rides a session');
		assert.deepEqual(result, {
			transactional: false,
			results: [{ affected_rows: 1 }],
			failure: { index: 1, stage: 'statement', message: 'SQL execution failed: null value in column "customer_id"', committed: 1, unknown: false, rollbackConfirmed: true },
		});
	});
});

describe('I-1: an outcome is known only from an answer that says so', () => {
	it('a commit whose connection dropped (no code, no refusal text) may have committed: unknown', async () => {
		const fake = fakeClient(node({
			commit: () => { throw raised('Connection lost'); },
			rollback: () => { throw raised('Connection lost'); },
		}));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.equal(result.failure?.stage, 'commit');
		assert.equal(result.failure?.unknown, true);
		assert.equal(result.failure?.rollbackConfirmed, false);
	});

	it('a commit the client stopped waiting for, whose session the node no longer holds, may have committed: unknown', async () => {
		const fake = fakeClient(node({
			commit: () => { throw new ExplorerToolError({ kind: 'timeout', tool: 'commit', message: 'Stopped waiting for commit after 60 s.' }); },
			rollback: () => { throw raised('unknown or expired transaction session: tx-1'); },
		}));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.equal(result.failure?.unknown, true);
		assert.equal(result.failure?.committed, 0);
	});

	it('a lost commit answer followed by a rollback the node carried out: the transaction was still open, so nothing was committed', async () => {
		const fake = fakeClient(node({ commit: () => { throw raised('Connection lost'); } }));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.deepEqual(tools(fake.calls).slice(-2), ['commit', 'rollback']);
		assert.equal(result.failure?.unknown, false);
		assert.equal(result.failure?.rollbackConfirmed, true);
	});

	it('without a transaction: a dropped connection or a stopped wait is unknown; a database refusal or a request never sent is known', async () => {
		const failingWith = async (error: Error): Promise<{ unknown: boolean; committed: number }> => {
			const fake = fakeClient(node({ execute: (call) => {
				if (String(call.input.sql).startsWith('INSERT')) throw error;
				return { rows: [], affected_rows: 1 };
			} }));
			const failure = (await sessionOn(fake.client).applyBatch(EDITS, { atomic: false })).failure!;
			return { unknown: failure.unknown, committed: failure.committed };
		};
		assert.deepEqual(await failingWith(raised('Connection lost')), { unknown: true, committed: 1 });
		assert.deepEqual(await failingWith(raised('Connection closed unexpectedly')), { unknown: true, committed: 1 });
		assert.deepEqual(await failingWith(raised('Request timed out')), { unknown: true, committed: 1 });
		assert.deepEqual(await failingWith(new ExplorerToolError({ kind: 'timeout', tool: 'execute', message: 'Stopped waiting for execute after 300 s.' })), { unknown: true, committed: 1 });
		assert.deepEqual(await failingWith(raised('SQL execution failed: duplicate key value')), { unknown: false, committed: 1 });
		assert.deepEqual(await failingWith(raised('(pymysql.err.IntegrityError) (1062, "Duplicate entry")')), { unknown: false, committed: 1 });
		assert.deepEqual(await failingWith(raised('EXECUTE query exceeded max_execute_rows=25000')), { unknown: false, committed: 1 });
		assert.deepEqual(await failingWith(raised('Could not send request: WebSocket not connected')), { unknown: false, committed: 1 });
		assert.deepEqual(await failingWith(raised('Task was stopped', 'TASK_STOPPED')), { unknown: false, committed: 1 });
	});
});

describe('I-2: a rollback that was not confirmed is told apart from one that was', () => {
	it('the rollback after a failed statement timed out: rollbackConfirmed is false', async () => {
		const fake = fakeClient(node({
			execute: () => { throw raised('SQL execution failed: deadlock detected'); },
			rollback: () => { throw new ExplorerToolError({ kind: 'timeout', tool: 'rollback', message: 'Stopped waiting for rollback after 60 s.' }); },
		}));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.equal(result.failure?.committed, 0);
		assert.equal(result.failure?.rollbackConfirmed, false);
	});

	it('the node no longer holds the session (reaped, restarted): nothing of it is held, so the rollback counts as confirmed', async () => {
		const fake = fakeClient(node({
			execute: () => { throw raised('SQL execution failed: deadlock detected'); },
			rollback: () => { throw raised('unknown or expired transaction session: tx-1'); },
		}));
		assert.equal((await sessionOn(fake.client).applyBatch(EDITS, { atomic: true })).failure?.rollbackConfirmed, true);
	});
});

describe('M-1, M-2: an unexpected throw still rolls back; a session id never leaves in a message', () => {
	it('a throw that does not come from a tool call rolls the transaction back, then propagates', async () => {
		const fake = fakeClient(node());
		const trap = { sql: 'DELETE FROM "orders" WHERE "order_id" = $1', params: [14] } as SqlApplyStatement;
		Object.defineProperty(trap, 'expect', { get: () => { throw new RangeError('boom'); }, enumerable: true });
		await assert.rejects(sessionOn(fake.client).applyBatch([EDITS[0]!, trap], { atomic: true }), /boom/);
		assert.deepEqual(tools(fake.calls), ['begin', 'execute', 'execute', 'rollback']);
	});

	it('the node\'s message naming the session is redacted', async () => {
		const fake = fakeClient(node({ execute: () => { throw raised('unknown or expired transaction session: tx-1'); } }));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: true });
		assert.equal(result.failure?.message, 'unknown or expired transaction session: <session>');
		assert.equal(JSON.stringify(result).includes('tx-1'), false);
	});
});

describe('apply without a transaction', () => {
	it('asked for no transaction (ClickHouse, a MySQL plan) it sends no begin, commit or rollback', async () => {
		const fake = fakeClient(node());
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: false });
		assert.deepEqual(tools(fake.calls), ['execute', 'execute', 'execute']);
		assert.deepEqual(result, { transactional: false, results: [{ affected_rows: 1 }, { affected_rows: 1 }, { affected_rows: 1 }], failure: null });
	});

	it('a statement that changed the wrong number of rows has committed already: the result counts it, and nothing after it is sent', async () => {
		const fake = fakeClient(node({ execute: () => ({ rows: [], affected_rows: 0 }) }));
		const result = await sessionOn(fake.client).applyBatch(EDITS, { atomic: false });
		assert.deepEqual(tools(fake.calls), ['execute']);
		assert.equal(result.failure?.stage, 'expect');
		assert.equal(result.failure?.committed, 1);
	});

	it('a statement without `expect` may change any number of rows (a DDL plan)', async () => {
		const fake = fakeClient(node({ execute: () => ({ rows: [], affected_rows: 0 }) }));
		const result = await sessionOn(fake.client).applyBatch([{ sql: 'ALTER TABLE "orders" ADD COLUMN "notes" text' }], { atomic: true });
		assert.deepEqual(result, { transactional: true, results: [{ affected_rows: 0 }], failure: null });
		assert.deepEqual(fake.calls[1]!.input, { sql: 'ALTER TABLE "orders" ADD COLUMN "notes" text', session_id: 'tx-1' }, 'no params key when there is nothing to bind');
	});
});

describe('R2-I3: a connection that broke during a commit leaves the outcome unknown, never "refused"', () => {
	const LOST = [
		'(psycopg2.OperationalError) server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally before or while processing the request.',
		'SQL execution failed: server closed the connection unexpectedly',
		'(psycopg2.InterfaceError) connection already closed',
		"(pymysql.err.OperationalError) (2013, 'Lost connection to MySQL server during query')",
		"SQL execution failed: (2006, 'MySQL server has gone away')",
		'SQL execution failed: could not send data to server: Broken pipe',
		'SQL execution failed: canceling statement due to statement timeout',
	];

	it('at the COMMIT, whatever the follow-up rollback finds gone: unknown', async () => {
		for (const message of LOST) {
			const fake = fakeClient(node({
				commit: () => { throw raised(message); },
				rollback: () => { throw raised('unknown or expired transaction session: tx-1'); },
			}));
			const failure = (await sessionOn(fake.client).applyBatch(EDITS, { atomic: true })).failure!;
			assert.equal(failure.stage, 'commit', message);
			assert.equal(failure.unknown, true, message);
		}
	});

	it('at the implicit commit of a per-statement change: unknown, so it is settled and not sent again', async () => {
		for (const message of LOST) {
			const fake = fakeClient(node({ execute: (call) => {
				if (String(call.input.sql).startsWith('DELETE')) throw raised(message);
				return { rows: [], affected_rows: 1 };
			} }));
			const failure = (await sessionOn(fake.client).applyBatch(EDITS, { atomic: false })).failure!;
			// The DELETE is the third statement: the two before it committed.
			assert.deepEqual([failure.unknown, failure.committed], [true, 2], message);
		}
	});

	it('a refusal that is not about the connection stays known (the database said no)', async () => {
		const fake = fakeClient(node({ execute: () => { throw raised('SQL execution failed: duplicate key value violates unique constraint "orders_pkey"'); } }));
		assert.equal((await sessionOn(fake.client).applyBatch(EDITS, { atomic: false })).failure?.unknown, false);
		const refused = fakeClient(node({ commit: () => { throw raised('commit refused: an earlier statement failed and aborted this transaction.'); }, rollback: () => { throw raised('unknown or expired transaction session: tx-1'); } }));
		assert.equal((await sessionOn(refused.client).applyBatch(EDITS, { atomic: true })).failure?.unknown, false);
	});
});
