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
// APPLY — the engine core's rules, on both mounts
// =============================================================================
//
// `sql.applyBatch` (a dev-tool frame) and the full app's session both
// reach sqlCore.ts applyBatch, which checks the list with the node's
// dialect before anything is sent: an atomic apply on ClickHouse (its
// sessions undo nothing) is refused as `transactions-unavailable`, as on a
// node without `begin`, and an unknown dialect never gets one. The
// statement-level sequences are in applySession.test.ts; T3/T4/T10 for the
// op are in devtool.wiring.test.ts.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import { SQL_APP_ID } from '../src/appId';
import { TRANSACTIONS_UNAVAILABLE_CODE, getSavedConnections, isTransactionsUnavailable, resetSavedConnections } from '../src/connect';
import { createLocalSqlEnv } from '../src/localEnv';
import { APPLY_UNKNOWN_DIALECT_TEXT } from '../src/sql/gate';
import { createSqlCore } from '../src/sqlCore';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { taskRow } from './support';
import { USER, engineScript, scriptedClientRealm, until } from './realm';
import { PIPELINE, postgres, rig, toolRequests } from './devtoolRig';

const EDITS = [
	{ sql: 'UPDATE `orders` SET `status` = $1 WHERE `order_id` = $2', params: ['paid', 5] },
	{ sql: 'DELETE FROM `orders` WHERE `order_id` = $1', params: [14] },
];

/**
 * A node of one dialect (everything else answers like postgres).
 *
 * @param dialect - What `dialect` answers, or a function that throws.
 * @returns The tool answers.
 */
function nodeOf(dialect: string | (() => never)) {
	return (params: { tool: string; input?: Record<string, unknown> }): unknown => {
		if (params.tool === 'dialect') return typeof dialect === 'string' ? { dialect } : dialect();
		if (params.tool === 'execute') return { rows: [], affected_rows: 1 };
		return postgres(params);
	};
}

describe('the engine core decides the transaction with the node\'s dialect', () => {
	it('ClickHouse: asked for one transaction, nothing is sent and the refusal is typed; asked for none, each statement commits on its own', async () => {
		const r = await rig({ tool: nodeOf('clickhouse') });
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			await assert.rejects(session.applyBatch(EDITS, { atomic: true }), (error: unknown) => isTransactionsUnavailable(error) && error instanceof ExplorerToolError && error.code === TRANSACTIONS_UNAVAILABLE_CODE);
			assert.deepEqual(['begin', 'execute', 'commit', 'rollback'].map((tool) => toolRequests(r.engine, tool).length), [0, 0, 0, 0], 'nothing was sent');
			const result = await session.applyBatch(EDITS, { atomic: false });
			assert.deepEqual(result, { transactional: false, results: [{ affected_rows: 1 }, { affected_rows: 1 }], failure: null });
			assert.deepEqual(['begin', 'commit', 'rollback'].map((tool) => toolRequests(r.engine, tool).length), [0, 0, 0]);
			assert.equal(toolRequests(r.engine, 'execute').length, 2);
		} finally {
			r.dispose();
		}
	});

	it('a node without the begin tool: the frame gets the typed refusal, and nothing but begin reached the node', async () => {
		const r = await rig({ tool: (params) => (params.tool === 'begin' ? (() => { throw new Error('No handler found for tool "begin" on node "db_1"'); })() : nodeOf('postgres')(params)) });
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			await assert.rejects(session.applyBatch(EDITS, { atomic: true }), (error: unknown) => isTransactionsUnavailable(error));
			assert.deepEqual(['begin', 'execute'].map((tool) => toolRequests(r.engine, tool).length), [1, 0]);
		} finally {
			r.dispose();
		}
	});

	it('PostgreSQL and MySQL: one transaction', async () => {
		for (const dialect of ['postgres', 'mysql']) {
			const r = await rig({ tool: nodeOf(dialect) });
			try {
				const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
				const result = await session.applyBatch(EDITS, { atomic: true });
				assert.equal(result.transactional, true, dialect);
				assert.deepEqual(['begin', 'commit', 'rollback'].map((tool) => toolRequests(r.engine, tool).length), [1, 1, 0], dialect);
			} finally {
				r.dispose();
			}
		}
	});

	it('an unknown dialect: one transaction is refused before anything is sent; without one, each statement is sent once', async () => {
		const r = await rig({ tool: nodeOf(() => { throw new Error('connection refused'); }) });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const apply = (atomic: boolean) => r.frame.caller.callReply('sql.applyBatch', { connId: 'c-pipe', owner: r.frame.owner(), statements: EDITS, atomic }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.applyBatch'] });
			await assert.rejects(apply(true), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && error.message === APPLY_UNKNOWN_DIALECT_TEXT);
			assert.equal(toolRequests(r.engine, 'begin').length + toolRequests(r.engine, 'execute').length, 0, 'nothing was sent');
			assert.deepEqual(await apply(false), { transactional: false, results: [{ affected_rows: 1 }, { affected_rows: 1 }], failure: null });
		} finally {
			r.dispose();
		}
	});
});

describe('M-7: an apply writes, so a frame of another account is refused', () => {
	it('an apply sent for another account (or none) is refused before anything is resolved or sent', async () => {
		const r = await rig({ tool: nodeOf('postgres') });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const before = r.engine.requests.length;
			for (const owner of ['someone-else', null]) {
				await assert.rejects(
					r.frame.caller.callReply('sql.applyBatch', { connId: 'c-pipe', owner, statements: EDITS, atomic: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.applyBatch'] }),
					(error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale' && /nothing was changed/.test(error.message),
				);
			}
			assert.deepEqual(r.engine.requests.slice(before).map((q) => q.op), [], 'nothing reached the engine');
		} finally {
			r.dispose();
		}
	});
});

describe('the full app takes the same path: its session\'s apply goes through the core\'s gate', () => {
	it('refuses transaction text in the list, and runs a good list as one transaction', async () => {
		resetSavedConnections({ force: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], nodeOf('postgres')));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		const env = createLocalSqlEnv(core, true, () => undefined, { getPref: () => undefined, setPref: () => undefined });
		try {
			engine.realm.login(USER);
			await until(() => getSavedConnections().length === 1, 'the saved list');
			const session = env.getSession(await env.resolveEndpoint(PIPELINE));
			await assert.rejects(session.applyBatch([...EDITS, { sql: 'COMMIT' }], { atomic: true }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && error.tool === 'apply');
			const sent = (tool: string): number => engine.requests.filter((request) => request.op === 'client.tool' && (request.params as { tool: string }).tool === tool).length;
			assert.equal(sent('begin') + sent('execute'), 0);
			const result = await session.applyBatch(EDITS.map((statement) => ({ ...statement, expect: 1 })), { atomic: true });
			assert.deepEqual(result, { transactional: true, results: [{ affected_rows: 1 }, { affected_rows: 1 }], failure: null });
			assert.deepEqual([sent('begin'), sent('execute'), sent('commit')], [1, 2, 1]);
		} finally {
			core.dispose();
		}
	});
});
