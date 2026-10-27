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
// SQL DEV TOOL — the controller and its frames over the REAL shell modules
// =============================================================================
//
// The controller (sqlController.ts) and a frame (sqlFrame.ts + the REMOTE
// SqlEnv) wired exactly as the hosts wire them, over the shell's real
// busPeer, toolOps, toolChannel and retained registry (the dev-tool
// library's harness), with the JSON wire ON: every payload crosses as its
// JSON image, as VS Code's postMessage carries it. The engine behind the
// controller is a scripted fake realm (realm.ts).
//
// T1 descriptor and manifest; T2 frames hold no client; T3 every op
// round-trips; T4 timeouts on both lanes; T5 lifecycle; T6 quiet sidebar;
// T9 docKey routing; T10 the controller's own write checks; T11 retained
// state stays small; T13 deadlines. T7/T8 (identity, host connection) are in
// devtool.identity.test.ts.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ExplorerToolError } from 'shared/explorer/errors';
import { assertJsonSafe, assertSidebarSubscribers, createDevToolHarness, findToolFactoryImports, installHostGridBridge, manualNow, settle, shellProtocol, spyPeer, tabulatorSetSort } from 'shared/explorer/devtool/testing';
import { BUS_TOOL_MARGIN_MS, FRAME_OP_MARGIN_MS, GET_TASKS_TIMEOUT_MS, LIST_TASKS_TIMEOUT_MS, MAX_TIMER_MS, SDK_TIMEOUT_SLACK_MS, UNBOUNDED_TOOL_TIMEOUT_MS } from 'shared/explorer/devtool/timeouts';
import { TASK_NAMES_REQUEST } from 'shared/explorer/connect/discovery';
import { DEFAULT_RETRY_WINDOW_MS } from 'shared/explorer/connect/session';
import { MAX_RETAINED_STATE_BYTES, MAX_RETAINED_TOTAL_BYTES, jsonByteLength } from 'shared/explorer/devtool/state';
import { CONTROLLER_STATE_TOPIC, RESERVED_STATE_PREFIX } from 'shared/explorer/devtool/realm';
import { SQL_APP_ID } from '../src/appId';
import { applyReplicaConnections, deleteSavedConnection, endpointForConnection, endpointKeyForConnection, getSavedConnections, getSavedConnectionsPartial, getSavedConnectionsStatus, ownSavedConnections, resetSavedConnections } from '../src/connect';
import type { PipelineBoundConnection, SavedSqlConnection } from '../src/connect';
import { lookupConnection } from '../src/connectionRecord';
import { MAX_WATCHED_HISTORY_KEYS, attachSqlController, checkApplyInput, checkExecuteInput, checkSchemaInput } from '../src/sqlController';
import type { ConnectionsState, HistoryState, SqlOps, SavedQueriesState } from '../src/ops';
import { attachSqlFrame, connectionDocState, directReleaseKey, frameGates, routeDocKey, sqlChannel } from '../src/sqlFrame';
import { SESSION_GRIDS, createRemoteSqlEnv } from '../src/sqlEnv';
import { setActiveConnection } from '../src/navigation';
import { SUMMON_EVENT, SUMMON_SETTLE_MS } from 'shared/explorer/devtool/summon';
import { createFrameCaller } from 'shared/explorer/devtool/frame';
import { RESOLVE_BUDGET_MS, SQL_OP_TIMEOUT_MS, applyBatchTimeoutMs, LIST_WAIT_MS, SAVED_QUERIES_LOAD_WAIT_MS } from '../src/sqlTimeouts';
import { APPLY_STATEMENT_WAIT_MS, BEGIN_WAIT_MS, DIALECT_WAIT_MS, END_TX_WAIT_MS, GET_SCHEMA_WAIT_MS, MAX_APPLY_STATEMENTS, NODE_TX_IDLE_MS, REFRESH_SCHEMA_WAIT_MS, GET_SQL_WAIT_MS } from '../src/connect/tools';
import { SAVED_PATH, USER, engineScript, scriptedClientRealm, until } from './realm';
import { taskRow } from './support';
import { DIRECT, PIPELINE, manualTimers, postgres, rig, toolRequests } from './devtoolRig';
import { createLocalSqlEnv } from '../src/localEnv';
import type { SqlCore } from '../src/sqlCore';
import { PREFS_FS_TIMEOUT_MS } from 'shared/explorer/devtool/prefs';
import { SAVED_QUERIES_PATH } from '../src/history/savedQueries';

const SRC = path.resolve(__dirname, '..', 'src');

/**
 * Many saved connections, each bound to its own pipeline (about 230 bytes of
 * JSON each, so a few hundred exceed the 64 KiB retained-state cap).
 *
 * @param n - How many.
 * @returns The records.
 */
function many(n: number): PipelineBoundConnection[] {
	return Array.from({ length: n }, (_, i) => ({ id: `c-${i}`, mode: 'pipeline' as const, name: `Warehouse connection ${i}`, projectId: `p-${i}-0f8fad5b-d9cb-469f-a165-70867728950e`, pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' }));
}

/**
 * The last snapshot the controller retained on each topic.
 *
 * @param posts - The sidebar peer's posts.
 * @returns Snapshot by topic.
 */
function retained(posts: unknown[]): Map<string, unknown> {
	const last = new Map<string, unknown>();
	for (const post of posts) {
		const p = post as { __rrtool?: string; topic?: string; snapshot?: unknown };
		if (p.__rrtool === 'state' && typeof p.topic === 'string') last.set(p.topic, p.snapshot);
	}
	return last;
}

/**
 * Read a source file of the app.
 *
 * @param rel - Path under src/.
 * @returns Its text.
 */
function source(rel: string): string {
	return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/**
 * Every source file reachable from one file through relative imports.
 *
 * @param entry - Path under src/.
 * @returns The reachable files (paths under src/).
 */
function importGraph(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (rel: string): void => {
		if (seen.has(rel)) return;
		seen.add(rel);
		const text = source(rel);
		for (const match of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
			const target = path.normalize(path.join(path.dirname(rel), match[1] as string));
			const candidates = [`${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts')];
			const found = candidates.find((candidate) => fs.existsSync(path.join(SRC, candidate)));
			if (found) visit(found);
		}
	};
	visit(entry);
	return [...seen].sort();
}


// =============================================================================
// T1 — DESCRIPTOR AND MANIFEST
// =============================================================================

describe('T1 — the descriptor exports both dev-tool mounts; the manifest is a dev tool; the id is unchanged', () => {
	it('AppDescriptor names SqlDevTool as devToolFrame and SqlDevToolSidebar as devToolSidebar, under the manifest id', () => {
		const descriptor = source('AppDescriptor.ts');
		assert.match(descriptor, /devToolFrame: SqlDevTool,/);
		assert.match(descriptor, /devToolSidebar: SqlDevToolSidebar,/);
		assert.match(descriptor, /id: SQL_APP_ID,/);
		assert.match(source('SqlDevTool.tsx'), /export const SqlDevTool: React\.FC<DevToolProps>/);
		assert.match(source('SqlSidebar.tsx'), /export const SqlDevToolSidebar: React\.FC<DevToolProps>/);
		const manifest = JSON.parse(fs.readFileSync(path.resolve(SRC, '..', 'package.json'), 'utf8')).appManifest as { id: string; categories: string[] };
		assert.equal(manifest.id, 'rocketride.sql');
		assert.equal(SQL_APP_ID, manifest.id);
		assert.ok(manifest.categories.includes('devTool'));
	});
});

// =============================================================================
// T2 — FRAMES HOLD NO CLIENT
// =============================================================================

describe('T2 — frame modules never import or use a client', () => {
	it('nothing reachable from the frame mount imports the engine core, the bus client, or a ConnectionManager / shell connection', () => {
		const files = importGraph('SqlDevTool.tsx');
		assert.ok(files.includes('sqlFrame.ts') && files.includes('sqlEnv.ts') && files.includes('views/QueryView.tsx'), 'the walk reaches the frame wiring and the views');
		for (const forbidden of ['sqlCore.ts', 'localEnv.ts', 'sqlController.ts', 'SqlApp.tsx', 'SqlSidebar.tsx']) {
			assert.equal(files.includes(forbidden), false, `the frame reaches ${forbidden}`);
		}
		for (const file of files) {
			const text = source(file);
			assert.doesNotMatch(text, /shared\/explorer\/devtool\/busClient/, `${file} imports the bus client`);
			assert.doesNotMatch(text, /\bConnectionManager\b/, `${file} names ConnectionManager`);
			assert.doesNotMatch(text, /\buseShellConnection\b/, `${file} reads the shell connection`);
			assert.doesNotMatch(text, /\.request\(\s*'client\./, `${file} sends a client op`);
		}
	});

	it('the protocol factories are imported in ONE wiring module (sqlBridge.ts), so no view can build a stray subscriber', () => {
		const all = fs.readdirSync(SRC, { recursive: true }).filter((file): file is string => typeof file === 'string' && /\.tsx?$/.test(file));
		const files = all.map((file) => ({ path: file.split(path.sep).join('/'), text: source(file) }));
		assert.deepEqual(findToolFactoryImports(files), ['sqlBridge.ts']);
	});

	it('a frame works with no client at all: its only way out is its peer', async () => {
		const r = await rig();
		try {
			// attachSqlFrame takes no ConnectionManager and no client; everything below rides the peer.
			assert.deepEqual(await r.env.resolveEndpoint(PIPELINE), { key: 'p1:s1:db_1', connId: 'c-pipe', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', nodeName: 'Orders', provider: 'db_postgres', running: true });
			assert.ok(r.frameCalls.some((call) => call.op === 'sql.resolveEndpoint'));
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T3 — EVERY OP ROUND-TRIPS
// =============================================================================

describe('T3 — every op round-trips JSON-safe; failures come back as equal ExplorerToolErrors', () => {
	it('each op answers through the JSON wire, args and results JSON-safe, nothing JSON would change on the wire', async () => {
		const r = await rig();
		r.engine.script['client.getService'] = () => ({ title: 'MySQL', Pipe: { schema: {} } });
		r.engine.script['client.validate'] = () => ({ errors: [], warnings: [] });
		r.engine.script['client.getEnvironmentKeys'] = () => ['ROCKETRIDE_DB_PASSWORD'];
		r.engine.script['client.use'] = () => ({});
		r.engine.script['client.getTaskToken'] = () => 'tk_sentinel_direct';
		r.engine.script['client.terminate'] = () => ({});
		try {
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			const session = r.env.getSession(endpoint);
			const results: Record<string, unknown> = {
				execute: await session.execute('SELECT * FROM orders', { params: ['x', 1, null], idempotent: true }),
				getSchema: await session.getSchema(),
				refreshSchema: await session.refreshSchema(),
				dialect: await session.dialect(),
				apply: await session.applyBatch([{ sql: 'UPDATE "orders" SET "name" = $1 WHERE "id" = $2', params: ['b', 2] }, { sql: 'DELETE FROM "orders" WHERE "id" = $1', params: [1] }], { atomic: true }),
				discover: await r.env.discoverEndpoints(),
				service: await r.env.getService('db_mysql'),
				validate: await r.env.validate({ version: 1, component: { id: 'db_mysql_1', provider: 'db_mysql', config: {} } }),
				envKeys: await r.env.getEnvironmentKeys(),
				connection: await r.env.getConnection('c-pipe'),
				noConnection: await r.env.getConnection('c-none'),
			};
			assert.deepEqual(results.connection, PIPELINE);
			assert.equal(results.noConnection, null);
			const owner = r.frame.owner();
			const entry = { id: 'h1', sql: 'SELECT 1', at: 1, ms: 2, outcome: 'rows' as const, rows: 1, kind: 'read' as const };
			await r.frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
			await r.frame.caller.callReply('sql.historyEdit', { connId: 'c-pipe', edit: { action: 'pin', id: 'h1' }, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyEdit'] });
			results.history = await r.frame.caller.callReply('sql.history', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			assert.deepEqual(results.history, [{ ...entry, pinned: true }]);
			await r.env.saveConnection({ ...PIPELINE, id: 'c-new', name: 'New' });
			await r.env.setConnectionSafety('c-new', 'every');
			assert.equal(getSavedConnections().find((c) => c.id === 'c-new')?.safety, 'every');
			await r.env.deleteConnection({ ...PIPELINE, id: 'c-new', name: 'New' });
			// The direct document's release carries the key it opened, and the
			// controller sees it.
			const released: Array<[string, string | undefined]> = [];
			const release = r.mount.core.release.bind(r.mount.core);
			r.mount.core.release = (connId, key) => {
				released.push([connId, key]);
				return release(connId, key);
			};
			const directKey = endpointForConnection(DIRECT).key;
			r.env.releaseEndpoint('c-direct', directKey);
			await until(() => r.engine.ops().includes('client.terminate'), 'the release');
			assert.deepEqual(released, [['c-direct', directKey]]);
			assert.deepEqual(results.execute, { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 });
			assert.equal(results.dialect, 'postgres');
			assert.deepEqual(results.apply, { transactional: true, results: [{ affected_rows: 0 }, { affected_rows: 0 }], failure: null });
			assert.deepEqual(toolRequests(r.engine, 'begin').length, 1, 'the apply ran its transaction in the controller');
			assert.deepEqual(toolRequests(r.engine, 'commit').length, 1);
			assert.deepEqual(results.discover, [{ key: 'p1:s1:db_1', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', nodeName: 'Orders DB', provider: 'db_postgres', running: true }]);
			assert.deepEqual(results.envKeys, ['ROCKETRIDE_DB_PASSWORD']);
			// Saved queries: an owned save, then the owned read (the list is an op result).
			const query = { id: 'sq1', name: 'Orders', sql: 'SELECT * FROM orders', at: 1 };
			await r.frame.caller.callReply('sql.savedQueryEdit', { connId: 'c-pipe', edit: { action: 'add', query }, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueryEdit'] });
			results.savedQueries = await r.frame.caller.callReply('sql.savedQueries', { connId: 'c-pipe', owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueries'] });
			assert.deepEqual(results.savedQueries, { storage: 'file', queries: [query] });
			// Ask: the node writes SQL and it comes back as data, nothing executed.
			const executes = toolRequests(r.engine, 'execute').length;
			results.getSql = await session.getSql('orders from the last 7 days');
			assert.deepEqual(results.getSql, { sql: 'SELECT * FROM orders', valid: true });
			assert.equal(toolRequests(r.engine, 'execute').length, executes);
			for (const [name, value] of Object.entries(results)) assertJsonSafe(value, name);
			const ops = new Set(r.frameCalls.map((call) => call.op));
			for (const op of Object.keys(SQL_OP_TIMEOUT_MS)) assert.ok(ops.has(op), `${op} was called`);
			for (const [i, entry] of r.h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
			assert.deepEqual(r.h.violations, [], 'nothing JSON would change crossed the wire');
			// No task token and no owner-aware key ever reached the wire.
			const wire = JSON.stringify(r.h.wire);
			assert.equal(wire.includes('tk_sentinel'), false);
			assert.equal(wire.includes('k1|'), false);
			// Nor a transaction session id: the apply's transaction lives in the controller.
			assert.equal(wire.includes('tx_sentinel'), false);
			assert.equal(wire.includes('session_id'), false);
		} finally {
			r.dispose();
		}
	});

	it('a node failure reaches the frame as an ExplorerToolError equal to the controller\'s, kind and code intact', async () => {
		const r = await rig({ tool: (params) => {
			if (params.tool === 'execute') throw Object.assign(new Error('Task is gone\nIt finished'), { code: 'TASK_COMPLETED' });
			return postgres(params);
		} });
		try {
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			await assert.rejects(r.env.getSession(endpoint).execute('SELECT 1'), (error: unknown) => {
				assert.ok(error instanceof ExplorerToolError);
				assert.equal(error.kind, 'raised');
				assert.equal(error.code, 'TASK_COMPLETED');
				assert.equal(error.tool, 'execute');
				assert.equal(error.headline, 'Task is gone');
				assert.equal(error.detail, 'It finished');
				return true;
			});
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('an unresolvable connection is Reply data (`unavailable`), not a thrown protocol error', async () => {
		const r = await rig({ rows: [] });
		try {
			await assert.rejects(r.env.resolveEndpoint(PIPELINE), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && /not running/.test(error.message));
			// A resolution failure inside an op names that op's tool (reviewer F6).
			const fails = (op: 'sql.execute' | 'sql.getSchema' | 'sql.refreshSchema' | 'sql.dialect' | 'sql.applyBatch', tool: string, params: Record<string, unknown> = {}) => assert.rejects(
				r.frame.caller.callReply(op, { connId: 'c-pipe', ...params } as never, { timeoutMs: SQL_OP_TIMEOUT_MS[op] }),
				(error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && error.tool === tool,
			);
			await fails('sql.execute', 'execute', { sql: 'SELECT 1' });
			await fails('sql.getSchema', 'get_schema');
			await fails('sql.refreshSchema', 'refresh_schema');
			await fails('sql.dialect', 'dialect');
			await fails('sql.applyBatch', 'apply', { owner: r.frame.owner(), statements: [{ sql: 'DELETE FROM "orders" WHERE "id" = $1', params: [1], expect: 1 }], atomic: true });
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T4 — TIMEOUTS ON BOTH LANES
// =============================================================================

describe('T4 — the frame\'s timeouts and the controller\'s bus timeouts match R5', () => {
	it('the controller names dialect 15 s, get_schema 60 s, refresh_schema 135 s (each + SDK slack + bus margin), and a statement on a node with no published deadline the 24 h cap', async () => {
		const r = await rig();
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			await session.dialect();
			await session.getSchema();
			await session.refreshSchema();
			// A row count that does not match, so the apply's rollback is sent too.
			await session.applyBatch([{ sql: 'DELETE FROM "orders" WHERE "id" = $1', params: [1], expect: 1 }], { atomic: true });
			await session.applyBatch([{ sql: 'DELETE FROM "orders" WHERE "id" = $1', params: [1] }], { atomic: true });
			await session.applyBatch([{ sql: 'DELETE FROM "orders" WHERE "id" = $2', params: [2] }], { atomic: false });
			await session.execute('SELECT 1');
			const bus = (tool: string): number | undefined => toolRequests(r.engine, tool).at(-1)?.timeoutMs;
			assert.equal(bus('dialect'), DIALECT_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('get_schema'), GET_SCHEMA_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('refresh_schema'), REFRESH_SCHEMA_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('execute'), UNBOUNDED_TOOL_TIMEOUT_MS);
			// The apply's transaction tools, and its statements bounded by the node's idle-transaction timeout, never the 24 h cap.
			assert.equal(bus('begin'), BEGIN_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('commit'), END_TX_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('rollback'), END_TX_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			const applied = toolRequests(r.engine, 'execute').filter((request) => (request.params as { input: { session_id?: string } }).input.session_id !== undefined);
			assert.equal(applied.length, 2);
			for (const request of applied) assert.equal(request.timeoutMs, APPLY_STATEMENT_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS, 'each statement of an apply waits the node\'s idle-transaction time');
			// A statement committed on its own holds no transaction: it waits as
			// any statement does, the 24 h cap on the bus (DA-R2 I2).
			const own = toolRequests(r.engine, 'execute').filter((request) => (request.params as { input: { sql: string; session_id?: string } }).input.sql.endsWith('$2'));
			assert.equal(own.length, 1);
			assert.equal((own[0]!.params as { input: { session_id?: string } }).input.session_id, undefined);
			assert.equal(own[0]!.timeoutMs, UNBOUNDED_TOOL_TIMEOUT_MS);
			assert.equal(DIALECT_WAIT_MS, 15_000);
			assert.equal(GET_SCHEMA_WAIT_MS, 60_000);
			assert.equal(REFRESH_SCHEMA_WAIT_MS, 135_000);
			assert.deepEqual(r.engine.requests.filter((request) => typeof request.timeoutMs !== 'number').map((request) => request.op), [], 'every bus request names its timeout');
		} finally {
			r.dispose();
		}
	});

	it('the frame waits longer than the controller can take for every op, and never relies on the 120 s default', async () => {
		// A clock that stands still: the frame sends what is left of a call's
		// timeout after the readiness wait, which a running clock can shave by 1 ms.
		const clock = manualNow(Date.now());
		const r = await rig({ now: clock.now });
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			await session.dialect();
			await session.getSchema();
			await session.refreshSchema();
			await session.execute('SELECT 1');
			await session.applyBatch([{ sql: 'DELETE FROM "orders" WHERE "id" = $1', params: [1] }], { atomic: true });
			await session.applyBatch([{ sql: 'DELETE FROM "orders" WHERE "id" = $1', params: [1] }], { atomic: false });
			// An apply's frame waits for its own statements (one wait each, by
			// whether they ride a transaction); the named entry is the longest one.
			assert.deepEqual(r.frameCalls.filter((call) => call.op === 'sql.applyBatch').map((call) => call.timeoutMs), [applyBatchTimeoutMs(1, true), applyBatchTimeoutMs(1, false)]);
			for (const call of r.frameCalls.filter((c) => c.op !== 'sql.applyBatch')) {
				assert.equal(call.timeoutMs, SQL_OP_TIMEOUT_MS[call.op as keyof typeof SQL_OP_TIMEOUT_MS], `${call.op} frame timeout`);
			}
			const at = (op: keyof typeof SQL_OP_TIMEOUT_MS): number => SQL_OP_TIMEOUT_MS[op];
			const busOf = (wait: number): number => wait + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS;
			assert.equal(at('sql.dialect'), RESOLVE_BUDGET_MS + busOf(DIALECT_WAIT_MS) + FRAME_OP_MARGIN_MS);
			assert.equal(at('sql.getSchema'), RESOLVE_BUDGET_MS + busOf(GET_SCHEMA_WAIT_MS) + FRAME_OP_MARGIN_MS);
			assert.equal(at('sql.refreshSchema'), RESOLVE_BUDGET_MS + busOf(REFRESH_SCHEMA_WAIT_MS) + busOf(GET_SCHEMA_WAIT_MS) + FRAME_OP_MARGIN_MS);
			// The controller's longest path for a statement, from its parts: resolve;
			// the gate's one dialect call; the statement's first send (refused
			// TASK_STOPPED at the latest when its bus wait ends); the session's
			// rebind (its retry window plus one discovery request in flight); the
			// second, unbounded send. The frame waits longer (R5), as a real timer.
			const controllerLongest = RESOLVE_BUDGET_MS + busOf(DIALECT_WAIT_MS)
				+ UNBOUNDED_TOOL_TIMEOUT_MS
				+ DEFAULT_RETRY_WINDOW_MS + GET_TASKS_TIMEOUT_MS
				+ UNBOUNDED_TOOL_TIMEOUT_MS;
			assert.ok(at('sql.execute') > controllerLongest, `frame ${at('sql.execute')} > controller ${controllerLongest}`);
			assert.equal(at('sql.execute'), controllerLongest + FRAME_OP_MARGIN_MS);
			assert.ok(at('sql.execute') <= MAX_TIMER_MS);
			// An apply: resolve; the gate's dialect call; begin; one wait per
			// statement, each at most the node's 300 s idle-transaction time (never
			// the 24 h cap); commit; and a rollback after a failure. The frame
			// passes the timeout for its own count; the named entry is the longest.
			const applyOf = (n: number): number => RESOLVE_BUDGET_MS + busOf(DIALECT_WAIT_MS) + busOf(BEGIN_WAIT_MS) + n * busOf(APPLY_STATEMENT_WAIT_MS) + 2 * busOf(END_TX_WAIT_MS) + FRAME_OP_MARGIN_MS;
			assert.equal(applyBatchTimeoutMs(3, true), applyOf(3));
			assert.equal(APPLY_STATEMENT_WAIT_MS, NODE_TX_IDLE_MS);
			assert.ok(applyBatchTimeoutMs(1, true) < 15 * 60_000, `${applyBatchTimeoutMs(1, true)} ms for one statement`);
			// Statement by statement there is no transaction to outlast: each
			// statement waits as any statement does (the 24 h cap on the bus),
			// and no begin, commit or rollback is sent (DA-R2 I2). A long list is
			// held to the longest real timer.
			const eachOf = (n: number): number => Math.min(RESOLVE_BUDGET_MS + busOf(DIALECT_WAIT_MS) + n * UNBOUNDED_TOOL_TIMEOUT_MS, MAX_TIMER_MS - FRAME_OP_MARGIN_MS) + FRAME_OP_MARGIN_MS;
			assert.equal(applyBatchTimeoutMs(1, false), eachOf(1));
			assert.ok(applyBatchTimeoutMs(1, false) > UNBOUNDED_TOOL_TIMEOUT_MS);
			assert.equal(applyBatchTimeoutMs(MAX_APPLY_STATEMENTS, false), MAX_TIMER_MS);
			assert.equal(at('sql.applyBatch'), Math.max(applyOf(MAX_APPLY_STATEMENTS), eachOf(MAX_APPLY_STATEMENTS)));
			assert.ok(at('sql.applyBatch') <= MAX_TIMER_MS);
			for (const op of Object.keys(SQL_OP_TIMEOUT_MS) as Array<keyof typeof SQL_OP_TIMEOUT_MS>) assert.notEqual(at(op), 120_000, op);
		} finally {
			r.dispose();
		}
	});

	it('saved-query ops wait for the saved list and the account\'s whole file read, and every request for that file names its timeout', async () => {
		const clock = manualNow(Date.now());
		const r = await rig({ now: clock.now });
		try {
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			await r.env.savedQueries.save(endpoint, { id: 'sq1', name: 'Orders', sql: 'SELECT 1', at: 1 });
			await r.frame.caller.callReply('sql.savedQueries', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueries'] });
			const saved = r.frameCalls.filter((call) => call.op === 'sql.savedQueries' || call.op === 'sql.savedQueryEdit');
			assert.deepEqual([...new Set(saved.map((call) => call.op))].sort(), ['sql.savedQueries', 'sql.savedQueryEdit']);
			for (const call of saved) assert.equal(call.timeoutMs, SQL_OP_TIMEOUT_MS[call.op as keyof typeof SQL_OP_TIMEOUT_MS], `${call.op} frame timeout`);
			assert.equal(SQL_OP_TIMEOUT_MS['sql.savedQueries'], LIST_WAIT_MS + SAVED_QUERIES_LOAD_WAIT_MS + FRAME_OP_MARGIN_MS);
			assert.equal(SQL_OP_TIMEOUT_MS['sql.savedQueryEdit'], LIST_WAIT_MS + SAVED_QUERIES_LOAD_WAIT_MS + FRAME_OP_MARGIN_MS);
			const fileRequests = r.engine.requests.filter((q) => (q.params as { path?: string } | null)?.path === SAVED_QUERIES_PATH);
			// No file yet: the stat says so and nothing is read.
			assert.equal(fileRequests[0]?.op, 'client.fsStat');
			for (const q of fileRequests) assert.equal(q.timeoutMs, PREFS_FS_TIMEOUT_MS, q.op);
		} finally {
			r.dispose();
		}
	});

	it('Ask\'s get_sql waits 120 s (+ SDK slack + bus margin) on the bus, and the frame waits for a resolve and that one call', async () => {
		const clock = manualNow(Date.now());
		const r = await rig({ now: clock.now });
		try {
			await r.env.getSession(await r.env.resolveEndpoint(PIPELINE)).getSql('orders this week');
			assert.equal(GET_SQL_WAIT_MS, 120_000);
			assert.equal(toolRequests(r.engine, 'get_sql').at(-1)?.timeoutMs, GET_SQL_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			const call = r.frameCalls.find((c) => c.op === 'sql.getSql');
			assert.equal(call?.timeoutMs, SQL_OP_TIMEOUT_MS['sql.getSql']);
			assert.equal(SQL_OP_TIMEOUT_MS['sql.getSql'], RESOLVE_BUDGET_MS + GET_SQL_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS + FRAME_OP_MARGIN_MS);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T5 — LIFECYCLE
// =============================================================================

describe('T5 — mount -> dispose -> mount leaves one live op server; ops answered, events delivered, replays execute nothing', () => {
	it('StrictMode\'s double mount leaves exactly one op server and two sidebar subscribers, and the remounted controller still answers', async () => {
		const r = await rig();
		try {
			assertSidebarSubscribers(r.spy, 'sql controller');
			// StrictMode: cleanup, then setup again.
			r.mount.dispose();
			r.remount();
			assert.equal(r.servers.created - r.servers.disposed, 1, 'exactly one live op server');
			assertSidebarSubscribers(r.spy, 'sql controller after remount');
			r.engine.realm.login(USER);
			await settle();

			const actives: Array<string | null> = [];
			r.mount.bridge.subscribeActive((key) => actives.push(key));
			await r.env.resolveEndpoint(PIPELINE);
			const executes = (): number => toolRequests(r.engine, 'execute').length;
			await r.env.getSession(await r.env.resolveEndpoint(PIPELINE)).execute('SELECT 1');
			assert.equal(executes(), 1);

			// A frame event reaches the controller once (live subscriber + retained slot do not double it).
			sqlChannel(r.frame.channel).sendEvent('active', 'p1:s1:db_1');
			await settle();
			assert.deepEqual(actives.filter((key) => key === 'p1:s1:db_1'), ['p1:s1:db_1']);

			// Remount: the retained last frame payload replays into the new controller and runs nothing.
			r.mount.dispose();
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			assert.equal(r.servers.created - r.servers.disposed, 1);
			assert.equal(executes(), 1, 'no statement re-executed by a replay');
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('event names and op names are disjoint (busPeer quirk 7), and saveConnection is an op, never an event', () => {
		const ops = source('ops.ts');
		const opNames = [...ops.matchAll(/'(sql\.[a-zA-Z]+)': ToolOpSpec/g)].map((m) => m[1]);
		const eventBlock = ops.slice(ops.indexOf('export interface SqlEventMap'));
		const events = [...eventBlock.matchAll(/^\t([a-zA-Z]+): /gm)].map((m) => m[1]);
		assert.deepEqual(events.sort(), ['active', 'openError']);
		for (const event of events) assert.equal(opNames.includes(event), false);
		assert.ok(opNames.includes('sql.saveConnection') && opNames.includes('sql.deleteConnection'));
		assert.doesNotMatch(source('sqlFrame.ts') + source('sqlController.ts') + source('SqlDevTool.tsx'), /sendEvent\('saveConnection'/);
	});
});

// =============================================================================
// T6 — QUIET SIDEBAR
// =============================================================================

describe('T6 — the sidebar mount posts nothing but retained state and opens no document; the mount is the activation', () => {
	it('zero events or calls and zero documents.open at mount; the mount itself activates it (#2625 9bd5d931f), so the saved list, the history file and the first discovery follow with no activation event', async () => {
		const r = await rig({ docKey: '', activate: false });
		try {
			await until(() => r.engine.ops().includes('client.getTasks') && r.engine.ops().includes('client.fsReadJson') && r.engine.ops().includes('client.fsStat'), 'the saved list, the history file and the first discovery');
			const posted = r.spy.posts.map((post) => (post as { __rrtool?: string }).__rrtool);
			assert.ok(posted.length > 0, 'retained state was published');
			assert.deepEqual(posted.filter((kind) => kind !== 'state'), [], 'only state publishes at mount');
			assert.deepEqual(r.docs.opened, []);
			assert.equal(r.mount.core.activation.reason(), 'lazyMount');
		} finally {
			r.dispose();
		}
	});

	it('a boot with the account already known reads and discovers exactly once at mount, and a later activation adds nothing (DA CE-6 now holds through the host: it mounts only a selected or summoned sidebar)', async () => {
		resetSavedConnections({ force: true });
		const h = createDevToolHarness(SQL_APP_ID, { json: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], postgres, {}));
		engine.realm.login(USER);
		h.setHostConnection(true);
		const spy = spyPeer(h.sidebarPeer);
		const mount = attachSqlController({ peer: spy.peer, channel: shellProtocol.createToolChannel(spy.peer), cm: engine.cm, protocol: shellProtocol, focusTarget: null });
		try {
			await until(() => getSavedConnectionsStatus() === 'ready', 'the saved list at mount');
			await until(() => engine.ops().includes('client.fsStat') && engine.ops().includes('client.getTasks'), 'the history file and the first discovery');
			const discoveries = engine.ops().filter((op) => op === 'client.getTasks').length;
			engine.realm.activate(SQL_APP_ID);
			await settle();
			await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
			assert.equal(engine.ops().filter((op) => op === 'client.getTasks').length, discoveries, 'a later selection starts nothing more');
		} finally {
			mount.dispose();
		}
	});

	it('where the realm cannot be classified the gate waits, and the wiring opens it on the first frame op or a user action', async () => {
		const byOp = await rig({ docKey: '', activate: false, bareGate: true });
		try {
			assert.equal(byOp.mount.core.activation.reason(), null, 'the premise: the gate is closed at mount');
			await byOp.env.discoverEndpoints().catch(() => undefined);
			assert.equal(byOp.mount.core.activation.reason(), 'op');
		} finally {
			byOp.dispose();
		}
		const byUser = await rig({ docKey: '', activate: false, bareGate: true });
		try {
			assert.equal(byUser.mount.core.activation.reason(), null, 'the premise: the gate is closed at mount');
			byUser.mount.bridge.openConnection(PIPELINE);
			assert.equal(byUser.mount.core.activation.reason(), 'user');
		} finally {
			byUser.dispose();
		}
	});

	it('documents open on user actions only, and a click keeps the gate the mount opened', async () => {
		const r = await rig({ docKey: '', activate: false });
		try {
			assert.deepEqual(r.docs.opened, [], 'none at mount');
			r.mount.bridge.openConnection(PIPELINE);
			assert.deepEqual(r.docs.opened, [['c-pipe', 'Orders']]);
			assert.equal(r.mount.core.activation.reason(), 'lazyMount');
			r.mount.bridge.openConnectionEditor(null);
			assert.deepEqual(r.docs.opened[1], ['edit:*new*', 'New Connection']);
		} finally {
			r.dispose();
		}
	});

	it('the rows\' status words are read in the sidebar\'s own realm: following them posts nothing, and no topic carries them', async () => {
		const r = await rig({ docKey: '', activate: false });
		try {
			const before = r.spy.posts.length;
			const sources: unknown[] = [];
			const off = r.mount.bridge.subscribeStatus((source) => { sources.push(source); });
			await until(() => r.engine.ops().includes('client.getTasks'), 'the first discovery');
			await until(() => (sources.at(-1) as { discovered: unknown[] | null }).discovered !== null, 'status from that discovery');
			off();
			const after = r.spy.posts.slice(before) as Array<{ __rrtool?: string; topic?: string }>;
			assert.deepEqual(after.filter((post) => post.__rrtool !== 'state'), [], 'no event, call or reply');
			const topics = new Set(r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state').map((post) => (post as { topic: string }).topic));
			assert.deepEqual([...topics].sort(), ['connections', CONTROLLER_STATE_TOPIC, 'history', 'identity', 'savedQueries'].sort());
			assert.deepEqual(r.docs.opened, []);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// #2625 9bd5d931f — busPeer summons a controller that is not mounted
// =============================================================================

describe('a frame whose controller is not mounted summons it (busPeer host.mountToolSidebar, #2625 9bd5d931f)', () => {
	it('a SQL frame with no controller summons it once, on purpose; it announces `active` only to a controller that is ready (once per readiness), never unconditionally at attach', async () => {
		resetSavedConnections({ force: true });
		const h = createDevToolHarness(SQL_APP_ID, { json: true });
		const timers = manualTimers();
		const frame = attachSqlFrame({ peer: h.newFramePeer(), docKey: 'c-pipe', protocol: shellProtocol, summonSchedule: timers.schedule });
		const actives = (): number => h.wire.filter((entry) => entry.transient && (entry.value as { name?: unknown } | null)?.name === 'active').length;
		try {
			await settle();
			assert.equal(actives(), 0, 'nothing is announced at attach');
			assert.equal(h.emitted.length, 0, 'and nothing is summoned before the settle');
			timers.advance(SUMMON_SETTLE_MS);
			await settle();
			assert.deepEqual(h.emitted.filter((e) => e.op === 'host.mountToolSidebar'), [{ op: 'host.mountToolSidebar', params: { appId: SQL_APP_ID } }]);
		} finally {
			frame.dispose();
		}
	});

	it('a frame attached while its controller is up announces `active` exactly once (CE-5), and a landing realm never re-announces a null key on a new readiness (CE-4)', async () => {
		resetSavedConnections({ force: true });
		setActiveConnection('p1:s1:db_1');
		const r = await rig({ docKey: 'c-pipe' });
		const announced = (from: number, key: string | null): number => r.h.wire.slice(from).filter((entry) => {
			const value = entry.value as { name?: unknown; payload?: unknown } | null;
			return entry.transient && value?.name === 'active' && value.payload === key;
		}).length;
		try {
			await settle();
			assert.equal(announced(0, 'p1:s1:db_1'), 1, 'the realm wiring, made while the controller is up, announces once');
			setActiveConnection(null);
			await settle();
			const before = r.h.wire.length;
			r.mount.dispose();
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			assert.equal(announced(before, null), 0, 'a realm with no active connection says nothing to a new controller');
		} finally {
			r.dispose();
			setActiveConnection(null);
		}
	});

	it('F11: the frame summons on purpose (devtool:summon), and re-announces `active` to the controller that the summon mounted', async () => {
		resetSavedConnections({ force: true });
		setActiveConnection('p1:s1:db_1');
		const h = createDevToolHarness(SQL_APP_ID, { json: true });
		h.setHostConnection(true);
		const timers = manualTimers();
		const frame = attachSqlFrame({ peer: h.newFramePeer(), docKey: 'c-pipe', protocol: shellProtocol, summonSchedule: timers.schedule });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], postgres, {}));
		engine.realm.login(USER);
		let mount: ReturnType<typeof attachSqlController> | null = null;
		try {
			await settle();
			assert.equal(frame.summon.state(), 'summoning');
			timers.advance(SUMMON_SETTLE_MS);
			await settle();
			assert.equal(frame.summon.sent(), 1);
			assert.ok(h.wire.some((entry) => entry.transient && (entry.value as { name?: unknown } | null)?.name === SUMMON_EVENT), 'the summon event went out');

			// The host mounts the controller as on a summon-driven first mount: a NEW channel, then the controller.
			// That channel takes the held burst (the frame's first `active` among it), so only a re-announce reaches the controller.
			mount = attachSqlController({ peer: h.sidebarPeer, channel: shellProtocol.createToolChannel(h.sidebarPeer), cm: engine.cm, protocol: shellProtocol, focusTarget: null });
			const actives: Array<string | null> = [];
			mount.bridge.subscribeActive((key) => actives.push(key));
			await until(() => frame.summon.state() === 'ready', 'the controller to be ready');
			await until(() => actives.includes('p1:s1:db_1'), 'the frame to re-announce its active connection');
			timers.advance(60_000);
			await settle();
			assert.equal(frame.summon.sent(), 1, 'no retry once the controller answered');
		} finally {
			mount?.dispose();
			frame.dispose();
			setActiveConnection(null);
		}
	});

	it('F12 and F13: the state order of a connection document, and the frame wires the summon and the sign-in states', () => {
		const base = { ready: false, failed: false, opened: false, found: true, listStatus: 'ready' as const };
		assert.equal(connectionDocState({ ...base, hostKnown: false, summoning: true, signedOut: true }), 'waiting', 'an unknown host comes first');
		assert.equal(connectionDocState({ ...base, summoning: true, signedOut: true }), 'starting', 'then a controller being summoned');
		assert.equal(connectionDocState({ ...base, summoning: true, opened: true }), 'open', 'an open document stays open while its controller comes back');
		assert.equal(connectionDocState({ ...base, sidebarClosed: true }), 'no-sidebar', 'then one that never answered');
		assert.equal(connectionDocState({ ...base, signedOut: true }), 'signed-out', 'then nobody signed in');
		assert.equal(connectionDocState(base), 'not-connected');
		// CE-3: nobody signed in wins over keeping an open document through a summon gap.
		assert.equal(connectionDocState({ ...base, opened: true, summoning: true, signedOut: true }), 'signed-out');
		assert.equal(connectionDocState({ ...base, opened: true, sidebarClosed: true, signedOut: true }), 'signed-out');
		assert.equal(connectionDocState({ ...base, opened: true, summoning: true }), 'open', 'signed in, it stays open');
		assert.equal(frameGates({ host: true, controllerReady: false, summon: 'summoning', signIn: 'nobody' }).signedOut, true, 'from the retained identity alone');
		const devTool = source('SqlDevTool.tsx');
		assert.match(devTool, /const gates = frameGates\(\{ host: hostConnection, controllerReady, summon, signIn \}\);/);
		const up = { host: true, controllerReady: true, summon: 'ready' } as const;
		assert.equal(frameGates({ ...up, signIn: 'nobody' }).signedOut, true);
		assert.equal(frameGates({ ...up, signIn: 'pending' }).starting, true, 'a controller that has not said who is signed in yet is still starting, never "not connected"');
		assert.equal(frameGates({ ...up, signIn: 'pending' }).signedOut, false);
		assert.equal(frameGates({ host: true, controllerReady: false, summon: 'summoning', signIn: 'pending' }).starting, true);
		assert.equal(frameGates({ host: true, controllerReady: false, summon: 'unanswered', signIn: 'pending' }).starting, false);
		assert.equal(frameGates({ host: false, controllerReady: true, summon: 'ready', signIn: 'pending' }).starting, false);
		// Every input a frame can be in maps to a state that never says "Not connected" while the host is connected.
		for (const controllerReady of [true, false]) {
			for (const summon of ['ready', 'summoning', 'unanswered'] as const) {
				for (const signIn of ['pending', 'nobody', 'signed-in'] as const) {
					const gates = frameGates({ host: true, controllerReady, summon, signIn });
					const state = connectionDocState({ ready: gates.ready, sidebarClosed: gates.sidebarClosed, hostKnown: gates.hostKnown, summoning: gates.starting, signedOut: gates.signedOut, listStatus: 'ready', found: true, failed: false, opened: false });
					assert.notEqual(state, 'not-connected', JSON.stringify({ controllerReady, summon, signIn }));
				}
			}
		}
		assert.match(devTool, /case 'starting':/);
		assert.match(devTool, /case 'signed-out':\s*body = <div style=\{styles\.welcome\}><EmptyState icon=\{<DatabaseIcon \/>\} title="Waiting for sign-in"/);
		assert.doesNotMatch(devTool, /followVouched/, 'the frame follows the base\'s followSignIn');
	});
});

// =============================================================================
// CONNECTION NAMES — #2625's readable name (listTasks), names only
// =============================================================================

describe('connection names: #2625\'s readable name from one listTasks, names only', () => {
	// A pipeline started with use(name='Shop Postgres') and no pipeline name:
	// getTasks names it by its source id; listTasks by its status name.
	const started = taskRow('p1', { name: 's1', pipeline: { project_id: 'p1', name: '', components: [{ id: 's1', provider: 'tools', name: 'Tools' }, { id: 'db_1', provider: 'db_postgres', name: 'Orders DB' }] } });
	// listTasks's row for that run, with the run's display id built the way the server builds it.
	const status = { id: `${started.token.replace(/^tk_/, '').slice(0, 8)}.${started.source}`, name: 'Shop Postgres.Tools', projectId: 'p1', source: 's1', runKind: 'dev', completed: false, state: 3 };

	it('the controller\'s discovery names the endpoint "Shop Postgres.Tools", asking listTasks once over the bus with a named timeout', async () => {
		const r = await rig({ rows: [started], listed: [status] });
		try {
			const [endpoint] = await r.env.discoverEndpoints();
			assert.equal(endpoint?.pipelineName, 'Shop Postgres.Tools');
			assert.equal(endpoint?.key, 'p1:s1:db_1', 'the key is getTasks\'s');
			const asked = r.engine.requests.filter((q) => q.op === 'client.listTasks');
			assert.ok(asked.length >= 1);
			for (const q of asked) {
				assert.deepEqual(q.params, TASK_NAMES_REQUEST);
				assert.equal(q.timeoutMs, LIST_TASKS_TIMEOUT_MS);
			}
			assert.equal(asked.length, r.engine.requests.filter((q) => q.op === 'client.getTasks').length, 'one listTasks per discovery');
		} finally {
			r.dispose();
		}
	});

	it('a saved connection is shown by the running pipeline\'s current name, not the one frozen into it when it was saved; its key stays the record\'s', async () => {
		const r = await rig({ rows: [started], listed: [status] });
		try {
			assert.equal(PIPELINE.pipelineName, 'Pipeline A', 'the record was saved under another name');
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			assert.equal(endpoint.pipelineName, 'Shop Postgres.Tools');
			assert.equal(endpoint.key, 'p1:s1:db_1');
			assert.equal(endpoint.nodeName, PIPELINE.name, 'everything else is the record\'s');
		} finally {
			r.dispose();
		}
	});

	it('without listTasks\'s name the endpoint falls back to the source component\'s name, with the same key', async () => {
		const r = await rig({ rows: [started] });
		try {
			const [endpoint] = await r.env.discoverEndpoints();
			assert.equal(endpoint?.pipelineName, 'Tools');
			assert.equal(endpoint?.key, 'p1:s1:db_1');
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// GRID LAYOUTS — never into the host's prefs (the Rocket Builder freeze)
// =============================================================================

describe('grid layouts are copies everywhere: a frame keeps them in the session, the full app in its own prefs', () => {
	/** The test runner's 'shell' module (stub-shell.cjs's one object). */
	const shell = (): Record<string, unknown> => createRequire(__filename)('shell') as Record<string, unknown>;

	it('a frame env hands every grid the realm\'s session persistence, which copies in and out and never writes the host\'s prefs', async () => {
		const r = await rig({ docKey: 'c-pipe' });
		// Installed once the rig is mounted, so only the persistence calls see the stand-in document.
		const host = installHostGridBridge(shell());
		try {
			const grids = r.env.gridPersistence;
			const again = createRemoteSqlEnv(r.frame.caller, true, r.frame.owner, r.history);
			assert.equal(again.gridPersistence, grids, 'one store per realm: in Rocket Builder every document of the page shares it');
			grids.write('sql-frame-probe', 'sort', [{ column: 'name', dir: 'asc' }]);
			tabulatorSetSort(grids.read('sql-frame-probe', 'sort'));
			assert.deepEqual(grids.read('sql-frame-probe', 'sort'), [{ column: 'name', dir: 'asc' }], 'Tabulator rewriting what it read never reaches the stored layout');
			assert.deepEqual(host.prefs.tableLayouts, {}, 'the host\'s prefs are never written');
		} finally {
			r.env.gridPersistence.clear('sql-frame-probe');
			r.dispose();
			host.uninstall();
		}
	});

	it('every grid with a tableId, in any source file, takes the env\'s persistence', () => {
		const files = (fs.readdirSync(SRC, { recursive: true }) as string[]).filter((rel) => /\.tsx?$/.test(rel));
		const persisted = files.filter((rel) => /tableId=/.test(source(rel)));
		assert.ok(persisted.length >= 4, persisted.join(', '));
		for (const rel of persisted) {
			const text = source(rel);
			// Through the layout guard (sql/gridLayout.ts), over the env's persistence.
			assert.equal((text.match(/persistence=\{gridLayouts\}/g) ?? []).length, (text.match(/tableId=/g) ?? []).length, `${rel}: every persisted grid`);
			assert.match(text, /guardLayouts\(env\.gridPersistence, layoutRulesFor\(columns\)\)/, rel);
		}
		assert.match(source('sqlEnv.ts'), /gridPersistence: SESSION_GRIDS,/);
	});

	it('the full app keeps layouts in its own prefs through the shell\'s channel, but hands Tabulator copies (the full-app freeze)', () => {
		const host = installHostGridBridge(shell());
		try {
			// #2625's channel alone hands a grid the host's own stored object.
			// This is what put a Tabulator column into the prefs and froze the save.
			host.prefs.tableLayouts['probe'] = { sort: [{ column: 'name', dir: 'asc' }] };
			tabulatorSetSort(host.bareChannel().read('probe', 'sort'));
			assert.throws(() => JSON.stringify(host.prefs), /circular/i, '#2625\'s channel hands out the host\'s object');
			delete host.prefs.tableLayouts['probe'];

			// The layouts ride the page's workspace pin (history/workspacePin.ts):
			// read and written for the account the preferences were read for.
			let fingerprint = 'u1|org-1|team-1';
			const core = { identity: { get: () => ({ known: true, fingerprint }) } } as unknown as SqlCore;
			const env = createLocalSqlEnv(core, true, () => undefined, { getPref: () => undefined, setPref: () => undefined });
			const grids = env.gridPersistence;
			assert.notEqual(grids, SESSION_GRIDS, 'the full app\'s layouts are not a frame\'s session ones');
			host.prefs.tableLayouts['sql-overview-tables'] = { sort: [{ column: 'name', dir: 'asc' }] };
			const handed = grids.read('sql-overview-tables', 'sort');
			assert.deepEqual(handed, [{ column: 'name', dir: 'asc' }], 'the stored layout is read from the app\'s prefs');
			tabulatorSetSort(handed);
			assert.doesNotThrow(() => JSON.stringify(host.prefs), 'so the next workspace save can serialize them');
			assert.deepEqual(host.prefs.tableLayouts['sql-overview-tables'], { sort: [{ column: 'name', dir: 'asc' }] });

			const blob = [{ column: 'name', dir: 'desc' }];
			grids.write('sql-overview-tables', 'sort', blob);
			tabulatorSetSort(blob);
			assert.deepEqual(host.prefs.tableLayouts['sql-overview-tables'], { sort: [{ column: 'name', dir: 'desc' }] }, 'a write reaches the prefs as a plain copy');

			// Another account without a reload: the shell still holds the first one's layouts.
			fingerprint = 'u2|org-1|team-1';
			assert.equal(grids.read('sql-overview-tables', 'sort'), false, 'another account reads none of them');
			grids.write('sql-overview-tables', 'sort', [{ column: 'name', dir: 'asc' }]);
			assert.deepEqual(host.prefs.tableLayouts['sql-overview-tables'], { sort: [{ column: 'name', dir: 'desc' }] }, 'and writes none');
		} finally {
			host.uninstall();
		}
	});
});

// =============================================================================
// T9 — DOCKEYS
// =============================================================================

describe('T9 — docKey routing for every family', () => {
	it('undefined and \'\' are the landing; edit:<id|*new*> the editor; anything else a saved connection id', () => {
		assert.deepEqual(routeDocKey(undefined), { kind: 'landing' });
		assert.deepEqual(routeDocKey(''), { kind: 'landing' });
		assert.deepEqual(routeDocKey(null), { kind: 'landing' });
		assert.deepEqual(routeDocKey('edit:*new*'), { kind: 'editor', connId: null });
		assert.deepEqual(routeDocKey('edit:c-pipe'), { kind: 'editor', connId: 'c-pipe' });
		assert.deepEqual(routeDocKey('c-pipe'), { kind: 'connection', connId: 'c-pipe' });
	});

	it('an unknown id is "not found" once the list is read, "loading" before', () => {
		const base = { ready: true, failed: false, opened: false, found: false };
		assert.equal(connectionDocState({ ...base, listStatus: 'ready' }), 'not-found');
		assert.equal(connectionDocState({ ...base, listStatus: 'loading' }), 'loading');
		assert.equal(connectionDocState({ ...base, listStatus: 'idle' }), 'loading');
		assert.equal(connectionDocState({ ...base, ready: false, listStatus: 'ready' }), 'not-connected');
		assert.equal(connectionDocState({ ...base, found: true, listStatus: 'ready' }), 'opening');
		assert.equal(connectionDocState({ ...base, found: true, opened: true, listStatus: 'ready' }), 'open');
		assert.equal(connectionDocState({ ...base, found: true, failed: true, listStatus: 'ready' }), 'failed');
	});

	it('before the host publishes host:connection a document waits; it says "not connected" only once the host said so', () => {
		const base = { ready: false, failed: false, opened: false, found: true, listStatus: 'ready' as const };
		assert.equal(connectionDocState({ ...base, hostKnown: false }), 'waiting');
		assert.equal(connectionDocState({ ...base, hostKnown: true }), 'not-connected');
		assert.equal(connectionDocState(base), 'not-connected', 'callers that do not say (the full app) keep the old states');
		assert.equal(connectionDocState({ ...base, ready: true, hostKnown: true }), 'opening');
		const devTool = fs.readFileSync(path.join(SRC, 'SqlDevTool.tsx'), 'utf8');
		assert.match(devTool, /const hostConnection = useConnectionReady\(toolChannel\);/);
		assert.equal(frameGates({ host: undefined, controllerReady: true, summon: 'ready', signIn: 'signed-in' }).hostKnown, false);
		assert.equal(frameGates({ host: undefined, controllerReady: true, summon: 'ready', signIn: 'signed-in' }).ready, false, 'no snapshot yet gates like false');
		assert.equal(frameGates({ host: false, controllerReady: true, summon: 'ready', signIn: 'signed-in' }).hostKnown, true);
		assert.match(devTool, /hostKnown=\{gates\.hostKnown\}/);
		assert.match(devTool, /case 'waiting':\s*body = <div style=\{styles\.welcome\}><EmptyState icon=\{<DatabaseIcon \/>\} title="Waiting for the server connection…"/);
	});

	it('a realm without a controller takes the snapshot as a read-only replica; a realm that owns the list never takes one', () => {
		resetSavedConnections({ force: true });
		applyReplicaConnections({ status: 'ready', list: [PIPELINE] });
		assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe']);
		// A replica holds no writer: a mutation attempted in a frame realm is refused.
		deleteSavedConnection('c-pipe');
		assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe']);
		// A list the controller has not read shows as loading.
		applyReplicaConnections({ status: 'loading', list: [] });
		assert.deepEqual(getSavedConnections(), []);
		assert.equal(getSavedConnectionsStatus(), 'idle');
		// In a realm that hosts the controller too, the owner's list stands.
		const release = ownSavedConnections();
		try {
			applyReplicaConnections({ status: 'ready', list: [DIRECT] });
			assert.deepEqual(getSavedConnections(), []);
		} finally {
			release();
		}
	});

	it('the frame replicates the controller\'s list, so a connection document finds its record by id', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnections().length === 2, 'the replica');
			assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe', 'c-direct']);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T10 — THE CONTROLLER'S OWN WRITE CHECKS
// =============================================================================

describe('T10 — write gates hold in the controller even when a frame calls the op directly', () => {
	it('a write sent as `idempotent` is still sent at most once; transaction control is refused before anything is sent', async () => {
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [], affected_rows: 1 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const call = (sql: string) => r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql, idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] });
			await assert.rejects(call("INSERT INTO orders (id) VALUES ('x')"), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 1, 'the INSERT was not re-sent');
			attempt = 0;
			await assert.rejects(call('SELECT 1; DELETE FROM orders'), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 2, 'a text holding a write is not re-sent');
			for (const tx of ['BEGIN', 'COMMIT', 'SELECT 1; ROLLBACK']) {
				await assert.rejects(call(tx), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			}
			assert.equal(toolRequests(r.engine, 'execute').length, 2, 'no transaction statement reached the node');
		} finally {
			r.dispose();
		}
	});

	it('an apply\'s list is checked in the controller: transaction text in it is refused before anything is sent, and nothing in an apply is ever repeated', async () => {
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'execute') {
				attempt += 1;
				// The one code a marked read is retried on: an apply's statement never is.
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [], affected_rows: 1 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const apply = (sqls: string[], atomic = true) => r.frame.caller.callReply('sql.applyBatch', { connId: 'c-pipe', owner: r.frame.owner(), statements: sqls.map((sql) => ({ sql, expect: 1 })), atomic }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.applyBatch'] });
			const EDIT = 'UPDATE "orders" SET "name" = \'x\' WHERE "id" = 1';
			for (const list of [[EDIT, 'COMMIT'], ['BEGIN', EDIT], [EDIT, 'SAVEPOINT s1'], [`${EDIT}; ROLLBACK`]]) {
				for (const atomic of [true, false]) {
					await assert.rejects(apply(list, atomic), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && /nothing was applied/.test(error.message), JSON.stringify(list));
				}
			}
			assert.deepEqual(['begin', 'execute', 'commit', 'rollback'].map((tool) => toolRequests(r.engine, tool).length), [0, 0, 0, 0], 'nothing reached the node');
			// Users' typed transaction text stays refused by `sql.execute` too.
			await assert.rejects(r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql: 'BEGIN' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			// A statement refused TASK_STOPPED inside the transaction is sent once, then rolled back.
			const result = await apply([EDIT, EDIT]);
			assert.equal(toolRequests(r.engine, 'execute').length, 1, 'never sent again');
			assert.equal(toolRequests(r.engine, 'rollback').length, 1);
			assert.equal(toolRequests(r.engine, 'commit').length, 0);
			assert.deepEqual(result, { transactional: true, results: [], failure: { index: 0, stage: 'statement', message: 'Task was stopped', code: 'TASK_STOPPED', committed: 0, unknown: false, rollbackConfirmed: true } });
		} finally {
			r.dispose();
		}
	});

	it('the gate asks the node for its dialect when no probe has it: a MySQL-only batch the first probe missed is sent once', async () => {
		// DA CE-2: the first probe fails (the node is restarting), so the store
		// has no dialect; the text is two statements on MySQL (`--1` is
		// arithmetic there), the second a DELETE.
		let probes = 0;
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'dialect') {
				probes += 1;
				if (probes === 1) throw new Error('connection refused');
				return { dialect: 'mysql' };
			}
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [{ ok: 1 }], affected_rows: 0 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const probe = Object.values(r.mount.core.endpoints.getState().probes)[0];
			assert.equal(probe?.ok, false, 'the store has no dialect');
			await assert.rejects(r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql: 'SELECT 1--1; DELETE FROM orders', idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] }), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 1, 'a text that holds a write on MySQL is sent at most once');
			assert.ok(probes >= 2, 'the node was asked for its dialect before the statement');
		} finally {
			r.dispose();
		}
	});

	it('with no dialect at all the gate fails closed: a marked read is sent once, and valid PL/pgSQL is not refused', async () => {
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'dialect') throw new Error('connection refused');
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [], affected_rows: 0 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const call = (sql: string) => r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql, idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] });
			await assert.rejects(call('SELECT 1'), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 1, 'never repeated without a dialect');
			const fn = 'CREATE FUNCTION bump() RETURNS void AS $$\nDECLARE x int;\nBEGIN\n  PERFORM 1;\nEND;\n$$ LANGUAGE plpgsql';
			assert.deepEqual(await call(fn), { rows: [], affected_rows: 0 }, 'sent, and the node decides');
			assert.equal(toolRequests(r.engine, 'execute').length, 2);
		} finally {
			r.dispose();
		}
	});

	it('malformed input is `invalid` Reply data, before anything is resolved, gated or sent (R3)', async () => {
		const r = await rig();
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const before = r.engine.requests.length;
			type Checked = 'sql.execute' | 'sql.getSchema' | 'sql.getService' | 'sql.validate' | 'sql.releaseEndpoint' | 'sql.applyBatch';
			const call = (op: Checked, params: Record<string, unknown>) => r.frame.caller.callReply(op, { connId: 'c-pipe', ...(op === 'sql.applyBatch' ? { owner: r.frame.owner() } : {}), ...params } as never, { timeoutMs: SQL_OP_TIMEOUT_MS[op] });
			const bad: Array<[Checked, Record<string, unknown>]> = [
				['sql.releaseEndpoint', { key: 42 }],
				['sql.getService', { provider: 42 }],
				['sql.getService', { provider: '' }],
				['sql.validate', { pipeline: 'x' }],
				['sql.validate', { pipeline: [1] }],
				['sql.validate', { pipeline: null }],
				['sql.execute', { sql: 42 }],
				['sql.execute', { sql: null }],
				['sql.execute', { sql: ['SELECT 1'] }],
				['sql.execute', { sql: 'SELECT ?', params: 'x' }],
				['sql.execute', { sql: 'SELECT ?', params: { 0: 1 } }],
				['sql.execute', { sql: 'SELECT 1', idempotent: 'yes' }],
				['sql.getSchema', { table: 7 }],
				['sql.applyBatch', { statements: [{ sql: 'SELECT 1' }] }],
				['sql.applyBatch', { statements: [{ sql: 'SELECT 1' }], atomic: 'yes' }],
				['sql.applyBatch', { statements: [], atomic: true }],
				['sql.applyBatch', { statements: 'SELECT 1', atomic: true }],
				['sql.applyBatch', { statements: [null], atomic: true }],
				['sql.applyBatch', { statements: [{ sql: 42 }], atomic: true }],
				['sql.applyBatch', { statements: [{ sql: 'SELECT ?', params: 'x' }], atomic: true }],
				['sql.applyBatch', { statements: [{ sql: 'DELETE FROM t', expect: 1.5 }], atomic: true }],
				['sql.applyBatch', { statements: [{ sql: 'DELETE FROM t', expect: -1 }], atomic: true }],
				['sql.applyBatch', { statements: Array.from({ length: MAX_APPLY_STATEMENTS + 1 }, () => ({ sql: 'SELECT 1' })), atomic: false }],
			];
			for (const [op, params] of bad) {
				await assert.rejects(call(op, params), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid', JSON.stringify(params));
			}
			assert.deepEqual(r.engine.requests.slice(before).map((q) => q.op), [], 'nothing reached the engine');
			assert.deepEqual(await call('sql.execute', { sql: 'SELECT ?', params: [null, 1, 'a', true, { k: [1] }] }), { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 }, 'control');
			// What only a same-realm frame (no JSON wire) could send.
			for (const params of [[Number.NaN], [() => 1], [new Date(0)], [Infinity]]) {
				assert.throws(() => checkExecuteInput({ sql: 'SELECT ?', params }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			}
			assert.throws(() => checkSchemaInput({ table: ['t'] }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			for (const params of [[Number.NaN], [() => 1], [new Date(0)]]) {
				assert.throws(() => checkApplyInput({ statements: [{ sql: 'SELECT $1', params }], atomic: true }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			}
		} finally {
			r.dispose();
		}
	});

	it('deleting an id the list does not hold changes nothing and writes nothing', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnectionsStatus() === 'ready', 'the list');
			await r.frame.caller.callReply('sql.deleteConnection', { connId: 'c-none', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.deleteConnection'] });
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(r.engine.requests.some((q) => q.op === 'client.fsWriteJson' && (q.params as { path: string }).path === SAVED_PATH), false);
			assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe', 'c-direct']);
		} finally {
			r.dispose();
		}
	});

	it('a read the frame did not mark idempotent is not repeated either; a marked read is, once', async () => {
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [{ ok: 1 }], affected_rows: 0 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const result = await r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql: 'SELECT 1', idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] });
			assert.deepEqual(result, { rows: [{ ok: 1 }], affected_rows: 0 });
			assert.equal(toolRequests(r.engine, 'execute').length, 2);
		} finally {
			r.dispose();
		}
	});

	it('a saved-connection record from a frame must be usable and name a database node; a frame of another identity cannot write', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			const save = (connection: unknown, owner: string | null) => r.frame.caller.callReply('sql.saveConnection', { connection: connection as SavedSqlConnection, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] });
			const owner = r.frame.owner();
			assert.ok(owner !== null);
			await assert.rejects(save({ ...DIRECT, id: 'x', provider: 'llm_openai' }, owner), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(save({ id: 'x', mode: 'direct', name: 'n', provider: 'db_mysql' }, owner), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(save({ ...PIPELINE, id: 'y' }, 'someone-else'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			await assert.rejects(r.frame.caller.callReply('sql.deleteConnection', { connId: 'c-pipe', owner: 'someone-else' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.deleteConnection'] }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe', 'c-direct'], 'nothing was written');
			assert.equal(r.engine.ops().includes('client.fsWriteJson'), false);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T11 — RETAINED STATE STAYS SMALL
// =============================================================================

describe('T11 — no bulk result is retained state; each topic stays within 64 KiB and all within 128 KiB, honestly', () => {
	it('the controller retains its fixed topics (and the library\'s readiness), never one under the reserved prefix; statement rows travel as op results', async () => {
		const r = await rig();
		try {
			await r.env.getSession(await r.env.resolveEndpoint(PIPELINE)).execute('SELECT * FROM orders');
			const states = r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state').map((post) => (post as { topic: string }).topic);
			assert.deepEqual([...new Set(states)].sort(), ['connections', CONTROLLER_STATE_TOPIC, 'history', 'identity', 'savedQueries'].sort());
			assert.deepEqual([...new Set(states)].filter((topic) => topic.startsWith(RESERVED_STATE_PREFIX) && topic !== CONTROLLER_STATE_TOPIC), []);
			assert.equal(JSON.stringify(r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state')).includes('"rows"'), false);
			assert.doesNotMatch(source('sqlController.ts'), /publishState\(\s*['`"]devtool:/);
		} finally {
			r.dispose();
		}
	});

	it('at scale (400 saved connections, 200 histories read) every topic stays within 64 KiB and the map within 128 KiB; nothing is withheld or marked truncated', async () => {
		const saved = many(400);
		assert.ok(jsonByteLength({ status: 'ready', list: saved, partial: null }) > MAX_RETAINED_STATE_BYTES, 'the whole list does not fit');
		const r = await rig({ saved });
		try {
			await until(() => getSavedConnections().length === 400, 'the list');
			for (const conn of saved.slice(0, 200)) await r.frame.caller.callReply('sql.history', { connId: conn.id, owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			await settle();
			const last = retained(r.spy.posts);
			let total = 0;
			for (const [topic, snapshot] of last) {
				const bytes = jsonByteLength(snapshot);
				assert.ok(bytes <= MAX_RETAINED_STATE_BYTES, `${topic}: ${bytes} bytes`);
				assert.equal(JSON.stringify(snapshot).includes('"truncated"'), false, `${topic} carries no generic truncated marker`);
				total += bytes;
			}
			assert.ok(total <= MAX_RETAINED_TOTAL_BYTES, `the whole map: ${total} bytes`);
			// The list is published in part, and says so.
			const connections = last.get('connections') as ConnectionsState;
			assert.equal(connections.status, 'ready');
			assert.ok(connections.partial !== null && connections.partial.total === 400 && connections.partial.kept === connections.list.length && connections.list.length > 0 && connections.list.length < 400);
			assert.deepEqual(connections.list, saved.slice(0, connections.list.length));
			// History follows the connections read most recently.
			const history = last.get('history') as HistoryState;
			assert.deepEqual(Object.keys(history.keys), saved.slice(200 - MAX_WATCHED_HISTORY_KEYS, 200).map((conn) => endpointKeyForConnection(conn)));
		} finally {
			r.dispose();
		}
	});

	it('a record the partial list left out is asked for, never reported gone; a whole list that lacks it means it is gone', async () => {
		const saved = many(400);
		const r = await rig({ saved });
		try {
			await until(() => getSavedConnections().length === 400, 'the list');
			assert.deepEqual(await r.env.getConnection('c-399'), saved[399]);
			assert.equal(await r.env.getConnection('c-none'), null);
		} finally {
			r.dispose();
		}
		// A realm that does not own the list (a VS Code frame) holds the replica.
		resetSavedConnections({ force: true });
		try {
			applyReplicaConnections({ status: 'ready', list: saved.slice(0, 10), partial: { kept: 10, total: 400 } });
			assert.deepEqual(getSavedConnectionsPartial(), { kept: 10, total: 400 });
			const view = { list: getSavedConnections(), status: getSavedConnectionsStatus(), partial: getSavedConnectionsPartial() };
			assert.deepEqual(lookupConnection('c-5', view), { kind: 'found', record: saved[5] });
			assert.deepEqual(lookupConnection('c-399', view), { kind: 'ask' });
			assert.deepEqual(lookupConnection('c-399', { ...view, partial: null }), { kind: 'missing' });
			assert.deepEqual(lookupConnection('c-399', { ...view, status: 'loading' }), { kind: 'loading' });
			// A whole list replaces the note.
			applyReplicaConnections({ status: 'ready', list: saved.slice(0, 10), partial: null });
			assert.equal(getSavedConnectionsPartial(), null);
		} finally {
			resetSavedConnections({ force: true });
		}
	});

	it('a frame whose history the controller stopped following reads it again, which follows it again', async () => {
		const saved = many(MAX_WATCHED_HISTORY_KEYS + 2);
		const r = await rig({ saved });
		const snapshots: HistoryState[] = [];
		const off = r.frame.channel.onState('history', (snapshot) => { snapshots.push(snapshot as HistoryState); });
		try {
			await until(() => getSavedConnections().length === saved.length, 'the list');
			const mine = endpointForConnection(saved[0]!);
			r.history.watch(mine);
			await until(() => snapshots.at(-1)?.keys[mine.key] !== undefined, 'the frame\'s key to be followed');
			// Other documents read as many other connections as the controller follows.
			for (const conn of saved.slice(1, MAX_WATCHED_HISTORY_KEYS + 1)) await r.frame.caller.callReply('sql.history', { connId: conn.id, owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			assert.ok(snapshots.some((snapshot) => snapshot.keys[mine.key] === undefined), 'it was dropped');
			await until(() => snapshots.at(-1)?.keys[mine.key] !== undefined, 'the frame to read it again');
			assert.ok(Object.keys(snapshots.at(-1)!.keys).length <= MAX_WATCHED_HISTORY_KEYS);
		} finally {
			off();
			r.dispose();
		}
	});

	it('more history views than the controller follows settle: each re-reads at most once, and reads again only when opened again (DA CE-5)', async () => {
		const saved = many(MAX_WATCHED_HISTORY_KEYS + 2);
		const r = await rig({ saved });
		try {
			await until(() => getSavedConnections().length === saved.length, 'the list');
			for (const conn of saved) r.history.watch(endpointForConnection(conn));
			const count = (): number => r.frameCalls.filter((call) => call.op === 'sql.history').length;
			await new Promise((resolve) => setTimeout(resolve, 300));
			const a = count();
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(count(), a, 'the reads settled');
			// Per view at most: the first read, one re-read, and one more when the
			// re-followed key's revision appears (the re-read began before it did).
			assert.ok(a <= 3 * saved.length, `${a} reads for ${saved.length} views`);
			// A dropped view opened again reads (and is followed) again.
			const snapshots: HistoryState[] = [];
			const off = r.frame.channel.onState('history', (snapshot) => { snapshots.push(snapshot as HistoryState); });
			try {
				await settle();
				const dropped = saved.map((conn) => endpointForConnection(conn)).find((endpoint) => snapshots.at(-1)?.keys[endpoint.key] === undefined);
				assert.ok(dropped, 'some view is not followed');
				const before = count();
				r.history.watch(dropped);
				await until(() => snapshots.at(-1)?.keys[dropped.key] !== undefined, 'the reopened view to be followed');
				assert.ok(count() > before);
			} finally {
				off();
			}
		} finally {
			r.dispose();
		}
	});

	it('the shrink is the lane\'s (a partial list, the newest keys), and every op has a handler', () => {
		const controller = source('sqlController.ts');
		assert.match(controller, /shrink: shrinkSqlState,/);
		assert.match(controller, /const handlers: RequiredControllerHandlers<SqlOps> = \{/);
		assert.match(controller, /publishIdentityState\(guarded, core\.identity\)/, 'identity counts toward the total budget');
	});

	it('the saved-queries topic is a revision and a word, never the queries: a full bag leaves it a few bytes and the map within budget', async () => {
		const r = await rig();
		try {
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			for (let i = 0; i < 50; i += 1) await r.env.savedQueries.save(endpoint, { id: `sq${i}`, name: `Query ${i}`, sql: `SELECT ${i} AS marker_${i}, '${'x'.repeat(4_000)}'`, at: i });
			await settle();
			const last = retained(r.spy.posts);
			const topic = last.get('savedQueries') as SavedQueriesState;
			assert.equal(topic.storage, 'file');
			assert.ok(topic.rev >= 50, 'the revision moved with every save');
			assert.ok(jsonByteLength(topic) < 64, `${jsonByteLength(topic)} bytes`);
			assert.equal(JSON.stringify(r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state')).includes('marker_'), false, 'no query text is retained state');
			let total = 0;
			for (const snapshot of last.values()) total += jsonByteLength(snapshot);
			assert.ok(total <= MAX_RETAINED_TOTAL_BYTES, `the whole map: ${total} bytes`);
		} finally {
			r.dispose();
		}
	});
});

describe('a direct connection\'s temp pipeline is released when its document goes away, and only then (reviewer F2)', () => {
	it('the release is keyed on the endpoint key: a re-resolve (a list republish, a controller remount) keeps it', async () => {
		const first = endpointForConnection(DIRECT);
		const again = endpointForConnection({ ...DIRECT });
		assert.notEqual(first, again, 'a re-resolve makes a new endpoint object');
		assert.equal(directReleaseKey(first), directReleaseKey(again));
		assert.equal(directReleaseKey(first), 'sqlconn-c-direct:tools_1:db_mysql_1');
		assert.equal(directReleaseKey(endpointForConnection(PIPELINE)), null, 'a pipeline connection releases nothing');
		assert.equal(directReleaseKey(null), null);
	});

	it('the document\'s release effect depends on that key and the connection id only, never on env or the endpoint object', () => {
		const devTool = source('SqlDevTool.tsx');
		const doc = devTool.slice(devTool.indexOf('const SqlConnectionDocument'), devTool.indexOf('/** A document that cannot open yet'));
		assert.match(doc, /const releaseKey = directReleaseKey\(endpoint\);\s*useEffect\(\(\) => \{\s*if \(releaseKey === null\) return undefined;\s*return \(\) => \{ envRef\.current\.releaseEndpoint\(connId, releaseKey\); \};\s*\}, \[releaseKey, connId\]\);/);
		assert.equal((doc.match(/releaseEndpoint\(/g) ?? []).length, 1, 'one release site');
		assert.doesNotMatch(doc, /\}, \[endpoint, env, connId\]\);/);
	});

	it('a controller remount and a list republish send no release and no terminate of their own', async () => {
		const r = await rig();
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const owner = r.frame.owner();
			await r.frame.caller.callReply('sql.saveConnection', { connection: { ...PIPELINE, id: 'c-other', name: 'Other' }, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] });
			r.mount.dispose();
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			await r.env.resolveEndpoint(PIPELINE);
			assert.equal(r.frameCalls.some((call) => call.op === 'sql.releaseEndpoint'), false);
			assert.equal(r.engine.ops().some((op) => op === 'client.terminate' || op === 'client.getTaskToken'), false);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T13 — DEADLINES
// =============================================================================

describe('T13 — deadlines: an expired call never runs, on every path a call can wait', () => {
	it('a call made while no controller is ready waits in the FRAME and is rejected unsent; a remounted controller never runs it (control: an on-time call waits and runs)', async () => {
		const clock = manualNow(Date.now());
		const r = await rig({ now: clock.now });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			// The controller unmounts (a VS Code disconnect); the frame calls into the void.
			r.mount.dispose();
			await settle();
			const late = r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql: 'DELETE FROM orders' }, { timeoutMs: 40 });
			await assert.rejects(late, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
			clock.advance(5 * 60_000);
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			assert.equal(toolRequests(r.engine, 'execute').length, 0, 'the expired DELETE never ran');

			// Control: a held call still inside its deadline runs on remount.
			r.mount.dispose();
			await settle();
			const onTime = r.frame.caller.callReply('sql.dialect', { connId: 'c-pipe' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.dialect'] });
			await settle();
			r.remount();
			r.engine.realm.login(USER);
			assert.equal(await onTime, 'postgres');
		} finally {
			r.dispose();
		}
	});

	it('a call the PEER holds (sent while ready, the controller gone before delivery) reaches a remount that keeps its host channel (rocket-ui caches one per tool), whose deadline guard refuses it once expired (control: on time, it runs)', async () => {
		const clock = manualNow(Date.now());
		const refused: unknown[] = [];
		const r = await rig({ now: clock.now, onRefused: (error) => refused.push(error) });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const keysAsked = (): number => r.engine.ops().filter((op) => op === 'client.getEnvironmentKeys').length;
			const before = keysAsked();
			const late = r.frame.caller.callReply('sql.envKeys', {}, { timeoutMs: 40 });
			r.mount.dispose();
			await assert.rejects(late, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
			clock.advance(5 * 60_000);
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			assert.equal(keysAsked(), before, 'the expired call never ran');
			assert.equal(refused.length, 1, 'it reached the controller, which refused it');

			const onTime = r.frame.caller.callReply('sql.dialect', { connId: 'c-pipe' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.dialect'] });
			r.mount.dispose();
			r.remount();
			r.engine.realm.login(USER);
			assert.equal(await onTime, 'postgres', 'an on-time held call ran on the remount');
			assert.equal(refused.length, 1);
		} finally {
			r.dispose();
		}
	});

	it('a call the PEER holds before a mount with a FRESH host channel (a first or summon-driven mount; VS Code builds one per mount) goes to that channel and is dropped: it never runs and never reaches the controller; our frames, which wait for readiness, never put a call in the hold', async () => {
		resetSavedConnections({ force: true });
		const h = createDevToolHarness(SQL_APP_ID, { json: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], postgres, {}));
		engine.realm.login(USER);
		h.setHostConnection(true);
		const isCall = (value: unknown): boolean => (value as { __rrtool?: unknown } | null)?.__rrtool === 'call';
		const heldCalls = (): number => h.wire.filter((entry) => entry.topic === `tool:${SQL_APP_ID}:toSidebar` && isCall(entry.value)).length;

		// Our frames (the base caller's default) wait for readiness: nothing reaches the peer.
		const waiting = createFrameCaller<SqlOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel });
		await assert.rejects(waiting.callReply('sql.envKeys', {}, { timeoutMs: 60 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /was not sent/.test(error.message));
		assert.equal(heldCalls(), 0, 'a waiting frame posts no call');

		// A caller that does not wait (no lane does) puts its call in the hold, which summons the controller.
		const eager = createFrameCaller<SqlOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel, waitForController: false });
		const held = eager.callReply('sql.envKeys', {}, { timeoutMs: 300 });
		await settle();
		assert.equal(heldCalls(), 1);
		assert.ok(h.emitted.some((entry) => entry.op === 'host.mountToolSidebar'), 'the held call summoned the controller');

		// The host mounts it as on a first mount: a NEW channel on the sidebar peer, then the controller.
		const refused: unknown[] = [];
		const mount = attachSqlController({ peer: h.sidebarPeer, channel: shellProtocol.createToolChannel(h.sidebarPeer), cm: engine.cm, protocol: shellProtocol, focusTarget: null, onRefused: (error) => refused.push(error) });
		try {
			await assert.rejects(held, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
			assert.equal(engine.ops().includes('client.getEnvironmentKeys'), false, 'the held call never ran');
			assert.deepEqual(refused, [], 'and never reached the controller: the host channel took it');
		} finally {
			mount.dispose();
			waiting.dispose();
			eager.dispose();
		}
	});
});
