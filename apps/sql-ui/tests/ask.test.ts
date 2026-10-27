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
// ASK — a question becomes SQL through the node's get_sql, and nothing runs
// =============================================================================
//
// The node's `get_sql` writes SQL for a question with the LLM connected to it
// and returns it WITHOUT running it (db_instance_base.get_sql). Its answers:
// `{sql, valid: true}`; `{error, sql, valid: false}` when the SQL is not a
// plain SELECT (WITH is refused); `{error, valid: false}` when the database
// rejected every draft; `{answer, valid: false}` when the question is not one
// for the database. With no LLM connected it raises MissingLlmError. Direct
// connections never have one (their pipeline is the database node alone).
// =============================================================================

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer/types';
import type { SqlExecuteResult, SqlSession } from '../src/connect';
import { createSqlSession } from '../src/connect/session';
import { GET_SQL_WAIT_MS, MAX_QUESTION_CHARS } from '../src/connect/tools';
import { ASK_CONTEXT_TEXT, ASK_DIRECT_TEXT, askOutcome, askRefusal, askSeed, runAsk } from '../src/components/AskBar';
import { checkQuestionInput } from '../src/sqlController';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { describeEndpoint, registerEndpoint, resetEndpoints, sqlEndpoints } from './support';
import { DIRECT, PIPELINE, postgres, rig, toolRequests } from './devtoolRig';
import { endpointForConnection } from '../src/connect';

const SRC = path.resolve(__dirname, '..', 'src');
const MISSING_LLM = 'No LLM is connected to this PostgreSQL node. Natural-language questions need an llm connection; raw SQL through the execute tool (client.database.query) works without one.';

/** One recorded tool invocation. */
interface IToolCall {
	tool: string;
	input: Record<string, unknown>;
	timeout: number | undefined;
}

let endpoint: IExplorerEndpoint;

/**
 * SQL Explorer's session on the registered endpoint, over a client whose tools answer from `behave`.
 *
 * @param behave - The tool's answer per call (throw to fail it).
 * @returns The session and its call log.
 */
function sessionOver(behave: (call: IToolCall) => unknown): { session: SqlSession; calls: IToolCall[] } {
	const calls: IToolCall[] = [];
	const client: IExplorerClient = {
		getTasks: async () => [],
		getTaskPipeline: async () => undefined,
		tool: async <T,>({ tool, input, timeout }: { token: string; tool: string; input?: Record<string, unknown>; timeout?: number }): Promise<T> => {
			const call = { tool, input: input ?? {}, timeout };
			calls.push(call);
			return behave(call) as T;
		},
	};
	return { session: createSqlSession(sqlEndpoints.session(client, endpoint), describeEndpoint(endpoint)), calls };
}

beforeEach(async () => {
	resetEndpoints();
	endpoint = await registerEndpoint('ask');
});

describe('get_sql through the session: the question goes in, the node\'s answer comes back as data', () => {
	it('sends the question alone to get_sql, with an explicit 120 s wait', async () => {
		assert.equal(GET_SQL_WAIT_MS, 120_000);
		const { session, calls } = sessionOver(() => ({ sql: 'SELECT 1', valid: true }));
		assert.deepEqual(await session.getSql('how many orders'), { sql: 'SELECT 1', valid: true });
		assert.deepEqual(calls.map((call) => [call.tool, call.input]), [['get_sql', { question: 'how many orders' }]]);
		// The session's wait plus the SDK slack (shared session), never the 120 s lane default by accident.
		assert.equal(calls[0]!.timeout, GET_SQL_WAIT_MS + 1_000);
	});

	it('every valid: false shape is data, not a failure: unsafe SQL, a rejected draft, a prose answer', async () => {
		for (const answer of [
			{ error: 'Generated query contains unsafe SQL', sql: 'WITH x AS (SELECT 1) SELECT * FROM x', valid: false },
			{ error: 'relation "ordrs" does not exist', valid: false },
			{ answer: 'Rome fell in 410.', valid: false },
		]) {
			const { session } = sessionOver(() => answer);
			assert.deepEqual(await session.getSql('q'), answer);
		}
	});

	it('MissingLlmError reaches the caller as the node worded it', async () => {
		const { session } = sessionOver(() => { throw new Error(MISSING_LLM); });
		await assert.rejects(session.getSql('q'), (error: unknown) => error instanceof ExplorerToolError && error.tool === 'get_sql' && error.message === MISSING_LLM);
	});
});

describe('Ask: what the bar shows for each answer', () => {
	it('valid SQL opens; anything else is the node\'s own text, verbatim', () => {
		assert.deepEqual(askOutcome({ sql: 'SELECT 1', valid: true }), { kind: 'sql', sql: 'SELECT 1' });
		assert.deepEqual(askOutcome({ error: 'Generated query contains unsafe SQL', sql: 'WITH x AS (SELECT 1) SELECT * FROM x', valid: false }), { kind: 'refused', text: 'Generated query contains unsafe SQL' });
		assert.deepEqual(askOutcome({ error: 'relation "ordrs" does not exist', valid: false }), { kind: 'refused', text: 'relation "ordrs" does not exist' });
		assert.deepEqual(askOutcome({ answer: 'Rome fell in 410.', valid: false }), { kind: 'answer', text: 'Rome fell in 410.' });
		assert.deepEqual(askOutcome({ valid: true, sql: '   ' }), { kind: 'refused', text: 'The node returned no SQL and no answer.' });
		assert.deepEqual(askOutcome({ valid: false }), { kind: 'refused', text: 'The node returned no SQL and no answer.' });
	});

	it('a missing LLM, or any failure, is the failure\'s own text', async () => {
		const failing = { getSql: async () => { throw new ExplorerToolError({ kind: 'raised', tool: 'get_sql', message: MISSING_LLM }); } };
		assert.deepEqual(await runAsk(failing, 'q'), { kind: 'failed', text: MISSING_LLM });
	});

	it('the generated SQL opens in a NEW query instance marked generated, with the question as a comment above it', () => {
		assert.deepEqual(askSeed('orders\nfrom last  week', 'SELECT * FROM orders\n'), { sql: '-- Asked: orders from last week\nSELECT * FROM orders', origin: 'generated' });
		assert.equal((askSeed('x'.repeat(500), 'SELECT 1').sql ?? '').split('\n')[0]!.length, '-- Asked: '.length + 200);
	});

	it('is refused on a direct connection, with the reason, and while not connected', () => {
		assert.equal(ASK_DIRECT_TEXT, 'Ask needs a pipeline whose database node has an LLM connected.');
		assert.equal(askRefusal(endpointForConnection(DIRECT), true), ASK_DIRECT_TEXT);
		assert.equal(askRefusal(endpointForConnection(PIPELINE), false), 'Not connected.');
		assert.equal(askRefusal(endpointForConnection(PIPELINE), true), null);
	});

	it('says exactly what goes to the model, that nothing runs, and that WITH queries are refused', () => {
		assert.match(ASK_CONTEXT_TEXT, /get_sql/);
		assert.match(ASK_CONTEXT_TEXT, /table and column names, their types, primary and foreign keys/);
		assert.match(ASK_CONTEXT_TEXT, /description/);
		assert.match(ASK_CONTEXT_TEXT, /No rows are sent/);
		assert.match(ASK_CONTEXT_TEXT, /EXPLAIN/);
		assert.match(ASK_CONTEXT_TEXT, /error message goes back to the model/);
		assert.match(ASK_CONTEXT_TEXT, /Nothing runs until you press Run/);
		// get_sql's safety check (is_sql_safe) rejects CTEs: say so, in those words.
		assert.match(ASK_CONTEXT_TEXT, /The node's safety check refuses queries that start with WITH/);
	});
});

describe('Ask never executes anything', () => {
	it('a spy session: Ask asks get_sql and never calls execute', async () => {
		const executed: string[] = [];
		const asked: string[] = [];
		const spy: SqlSession = {
			endpoint: describeEndpoint(endpoint),
			execute: async (sql: string): Promise<SqlExecuteResult> => { executed.push(sql); return { rows: [], affected_rows: 0 }; },
			getSchema: async () => ({}),
			refreshSchema: async () => ({}),
			dialect: async () => 'postgres',
			getSql: async (question: string) => { asked.push(question); return { sql: 'DELETE FROM orders', valid: true }; },
			// An apply writes too: recorded with execute, so "never executes" covers it.
			applyBatch: async (statements) => { executed.push(...statements.map((statement) => statement.sql)); return { transactional: false, results: [], failure: null }; },
		};
		// Even SQL that writes is only handed back: Ask opens it, never runs it.
		assert.deepEqual(await runAsk(spy, 'remove every order'), { kind: 'sql', sql: 'DELETE FROM orders' });
		assert.deepEqual(asked, ['remove every order']);
		assert.deepEqual(executed, []);
	});

	it('the AskBar source opens the answer as a seed and calls nothing that runs', () => {
		const bar = fs.readFileSync(path.join(SRC, 'components', 'AskBar.tsx'), 'utf8');
		assert.match(bar, /pageNav\.openQuery\(askSeed\(asked, outcome\.sql\)\);/);
		assert.doesNotMatch(bar, /\.execute\(|runTargets|onRerun|runOne|runAll/);
	});

	it('Enter during IME composition does not ask, and a refusal (not connected, direct) is visible text, not only a tooltip (review M5)', () => {
		const bar = fs.readFileSync(path.join(SRC, 'components', 'AskBar.tsx'), 'utf8');
		assert.match(bar, /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Enter' && !event\.nativeEvent\.isComposing\) void ask\(\); \}\}/);
		// On the input's own row (live L2: a line below cost the results 17 px);
		// the row wraps it onto a line of its own where it does not fit.
		assert.match(bar, /\{refusal !== null && <span style=\{styles\.reason\}>\{refusal\}<\/span>\}/);
		assert.match(bar, /row: \{[\s\S]*?flexWrap: 'wrap',/);
		const panel = fs.readFileSync(path.join(SRC, 'components', 'SavedQueriesPanel.tsx'), 'utf8');
		const enters = [...panel.matchAll(/event\.key === 'Enter'([^)]*)\)/g)].map((m) => m[1]);
		assert.ok(enters.length >= 2 && enters.every((rest) => /!event\.nativeEvent\.isComposing/.test(rest!)), 'the save dialog and rename fields too');
	});

	it('the query view mounts the bar above the editor', () => {
		const view = fs.readFileSync(path.join(SRC, 'views', 'QueryView.tsx'), 'utf8');
		assert.match(view, /<AskBar endpoint=\{endpoint\} \/>[\s\S]*?\{\/\* Editor\. \*\/\}/);
	});

	it('over the dev tool\'s wire: sql.getSql reaches get_sql once and the engine sees no execute', async () => {
		const r = await rig({ tool: (params) => (params.tool === 'get_sql' ? { sql: 'DROP TABLE orders', valid: true } : postgres(params)) });
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			assert.deepEqual(await session.getSql('drop the orders table'), { sql: 'DROP TABLE orders', valid: true });
			assert.equal(toolRequests(r.engine, 'get_sql').length, 1);
			assert.deepEqual((toolRequests(r.engine, 'get_sql')[0]!.params as { input: unknown }).input, { question: 'drop the orders table' });
			assert.deepEqual(toolRequests(r.engine, 'execute'), []);
			assert.ok(r.frameCalls.some((call) => call.op === 'sql.getSql' && call.timeoutMs === SQL_OP_TIMEOUT_MS['sql.getSql']));
		} finally {
			r.dispose();
		}
	});

	it('the controller checks the question before anything is sent', async () => {
		assert.equal(MAX_QUESTION_CHARS, 2_000);
		for (const question of [undefined, 7, '', '   ', 'x'.repeat(MAX_QUESTION_CHARS + 1)]) {
			assert.throws(() => checkQuestionInput({ question }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && error.tool === 'get_sql');
		}
		assert.doesNotThrow(() => checkQuestionInput({ question: 'orders this week' }));
		const r = await rig();
		try {
			await assert.rejects(r.frame.caller.callReply('sql.getSql', { connId: 'c-pipe', question: '' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.getSql'] }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			assert.deepEqual(toolRequests(r.engine, 'get_sql'), [], 'nothing was sent');
		} finally {
			r.dispose();
		}
	});
});

describe('Ask: the README says what the code does', () => {
	it('names the tool, what goes to the model, the WITH refusal, the direct-connection reason and the wait', () => {
		const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
		assert.match(prose, /It sends the question to the database node's `get_sql` tool/);
		assert.match(prose, /table and column names, their types, primary and foreign keys/);
		assert.match(prose, /No rows are sent\./);
		assert.match(prose, /The node's safety check refuses queries that start with `WITH`/);
		assert.ok(prose.includes(`says \`${ASK_DIRECT_TEXT.replace(/\s+/g, ' ')}\``), 'the direct-connection reason, word for word');
		assert.match(prose, new RegExp(`Ask waits up to ${GET_SQL_WAIT_MS / 1000} seconds`));
		assert.match(prose, /Nothing runs until you press Run\./);
	});
});
