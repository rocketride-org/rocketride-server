// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL PROTOCOL: every op, its timeouts, the write gate, sizes, deadlines
// (T3, T4, T10, T11, T13) over the REAL shell modules, JSON wire on
// =============================================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolOpMap } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerEndpoint } from 'shared/explorer';
import { codedError } from 'shared/explorer/connect/testing';
import type { IToolCall } from 'shared/explorer/connect/testing';
import { MAX_RETAINED_STATE_BYTES, MAX_RETAINED_TOTAL_BYTES, jsonByteLength } from 'shared/explorer/devtool/state';
import type { IDevToolHarness } from 'shared/explorer/devtool/testing';
import { BUS_TOOL_MARGIN_MS, FRAME_OP_MARGIN_MS, SDK_TIMEOUT_SLACK_MS } from 'shared/explorer/devtool/timeouts';
import { assertJsonSafe, manualNow } from 'shared/explorer/devtool/testing';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { createFrameCaller } from 'shared/explorer/devtool/frame';
import { createDevToolHarness } from 'shared/explorer/devtool/testing';
import { WRITE_REFUSED_TEXT } from '../src/devtool/controller';
import type { IGraphFrame } from '../src/devtool/frame';
import { CONTROLLER_LOCAL_OP_MS, ENDPOINTS_STATE_BYTES, EVENT, GRAPH_APP_ID, OP, SCHEMAS_STATE_BYTES, STATE, VERSIONS_STATE_BYTES, endpointsSnapshot, frameTimeoutFor, schemasSnapshot, versionsSnapshot } from '../src/devtool/protocol';
import type { GraphOps } from '../src/devtool/protocol';
import { createDataVersions } from '../src/graph/dataVersion';
import { createSchemaStore } from '../src/graph/schemaStore';
import { NEO4J_DIALECT, NEO4J_GRAPH, NEO4J_WRITABLE, graphRow, mountController, mountFrame, readOnlyNode, settle, shellProtocol, signInVsCode, until, vscodeRealm } from './support/devtool';

/** A signed-in VS Code realm, its controller and one frame, with the first discovery done. */
async function connected(docKey: string | undefined, behave: (call: IToolCall) => unknown = readOnlyNode, over: Parameters<typeof mountController>[1] = {}) {
	const engine = vscodeRealm(undefined, behave);
	signInVsCode(engine.realm);
	const mounted = mountController(engine.cm, over);
	mounted.h.setHostConnection(true);
	const { frame, docs, errors } = mountFrame(mounted.h, docKey);
	await until(() => frame.env(true).endpoints.get().endpoints.length === 1 && Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'discovery and the probe');
	const endpoint = frame.env(true).endpoints.get().endpoints[0];
	return { engine, ...mounted, frame, frameDocs: docs, frameErrors: errors, endpoint, key: endpoint.key };
}

/**
 * A remote session for a frame's connection.
 *
 * @param frame - The frame.
 * @param endpoint - The connection.
 * @returns The session.
 */
function sessionOf(frame: IGraphFrame, endpoint: IExplorerEndpoint) {
	const session = frame.env(true).session(endpoint);
	assert.ok(session, 'a ready frame has a session');
	return session;
}

describe('T3 - every Graph op round-trips JSON-safe, and failures come back as equal ExplorerToolErrors', () => {
	it('refreshEndpoints, probe, loadSchema, readQuery, execute, ask, historyList, historyEdit and writeAbandoned all answer through the real lanes', async () => {
		const run = await connected(undefined, (call) => (call.tool === 'dialect' ? NEO4J_WRITABLE : readOnlyNode(call)));
		const env = run.frame.env(true);
		const session = sessionOf(run.frame, run.endpoint);

		await env.refresh();
		const probe = await env.probe(run.key);
		assert.equal(probe?.ok, true);
		assert.deepEqual(probe?.info, NEO4J_WRITABLE);

		await env.loadSchema(run.key);
		await until(() => env.schemaLabels.get(run.key).length > 0, 'the schema labels');

		assert.deepEqual(await session.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 }), NEO4J_GRAPH);
		assert.deepEqual(await session.invoke('execute', { query: 'CREATE (n:X)', shape: 'graph' }), NEO4J_GRAPH);
		assert.deepEqual(await session.invoke('get_query', { question: 'who?' }), { query: 'MATCH (n:Person) RETURN n LIMIT 5', valid: true });
		await until(() => env.dataVersions.get(run.key) === 1, 'the write to be counted');

		env.history.record(run.key, { id: 'e1', at: 1_700_000_000_000, kind: 'read', cypher: 'MATCH (n) RETURN n', ms: 12, outcome: 'rows', rows: 4 } as never);
		const view = env.history.view(run.key);
		const off = view.subscribe(() => undefined);
		await until(() => view.get().entries.length === 1, 'the recorded run in history');
		env.history.setNote(run.key, 'e1', 'kept');
		await until(() => view.get().entries[0]?.note === 'kept', 'the note');
		off();

		env.markAbandonedWrite(run.key);
		await until(() => env.dataVersions.get(run.key) === 2, 'the abandoned write mark');

		const ops = new Set(run.engine.world.calls.map((c) => c.tool));
		for (const tool of ['dialect', 'get_schema', 'read_query', 'execute', 'get_query']) assert.ok(ops.has(tool), `${tool} reached the engine`);
		for (const [i, entry] of run.h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
		assert.deepEqual(run.h.violations, [], 'nothing JSON would change crossed the wire');
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a node failure comes back to the frame as an ExplorerToolError with its kind, code and tool intact', async () => {
		const run = await connected(undefined, (call) => (call.tool === 'read_query' ? Promise.reject(codedError('Invalid input near RETURN', 'CYPHER_SYNTAX')) : readOnlyNode(call)));
		await assert.rejects(sessionOf(run.frame, run.endpoint).invoke('read_query', { cypher: 'MATCH RETURN', params: {}, limit: 25 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'raised');
			assert.equal(error.code, 'CYPHER_SYNTAX');
			assert.equal(error.tool, 'read_query');
			assert.equal(error.message, 'Invalid input near RETURN');
			return true;
		});
		assert.deepEqual(run.h.violations, []);
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a generation ticket that expired while the op ran drops the answer as stale, in the frame', async () => {
		const run = await connected(undefined);
		let current = true;
		const ticket = { isCurrent: () => current };
		const pending = sessionOf(run.frame, run.endpoint).invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 }, { generation: ticket as never });
		current = false;
		await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		run.frame.dispose();
		run.controller.dispose();
	});

	it('op and event names are disjoint (the op server would run an event named like an op)', () => {
		for (const name of Object.values(EVENT)) assert.ok(!(Object.values(OP) as string[]).includes(name), name);
		for (const op of Object.values(OP)) assert.match(op, /^graph\./);
	});
});

describe('T4 - timeouts: the frame always waits longer than the controller\'s own bus request', () => {
	it('each op passes the frame timeout the protocol names, and the controller\'s client.tool names its own bus timeout', async () => {
		// A FIXED clock for the frame and the controller: since base round 3 the frame sends what is left of its budget
		// after the readiness check (deadlineAt - now), so a wall clock that moves between stamping and sending made this
		// exact test flaky (14999 !== 15000).
		const clock = manualNow(1_700_000_000_000);
		const sent: Array<{ op: string; timeoutMs: number | undefined; deadlineAt: number | undefined }> = [];
		const engine = vscodeRealm(undefined, (call) => (call.tool === 'dialect' ? NEO4J_WRITABLE : readOnlyNode(call)));
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm, { now: clock.now });
		mounted.h.setHostConnection(true);
		const spyController = <O extends ToolOpMap>(peer: DevToolPeer) => {
			const fn = shellProtocol.createToolController<O>(peer);
			return ((op: string, params: unknown, options?: { timeoutMs?: number }) => {
				sent.push({ op, timeoutMs: options?.timeoutMs, deadlineAt: (params as { deadlineAt?: number })?.deadlineAt });
				return (fn as unknown as (o: string, p: unknown, opts?: unknown) => Promise<unknown>)(op, params, options);
			}) as unknown as ReturnType<typeof shellProtocol.createToolController<O>>;
		};
		const { frame } = mountFrame(mounted.h, undefined, { createToolController: spyController, now: clock.now });
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const endpoint = frame.env(true).endpoints.get().endpoints[0];
		const session = sessionOf(frame, endpoint);
		const before = engine.requests.length;
		await session.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 });
		await session.invoke('execute', { query: 'CREATE (n:X)', shape: 'graph' });
		await session.invoke('get_query', { question: 'q' });
		await frame.env(true).probe(endpoint.key);
		await frame.env(true).refresh();
		await frame.caller.callReply(OP.historyList, { key: endpoint.key }, { timeoutMs: frameTimeoutFor(OP.historyList) });

		const tools = engine.requests.slice(before).filter((r) => r.op === 'client.tool');
		const busOf = (tool: string): number => tools.find((r) => (r.params as { tool: string }).tool === tool)?.timeoutMs as number;
		const frameOf = (op: string): number => {
			const call = sent.find((s) => s.op === op);
			assert.ok(call, `${op} was sent`);
			assert.equal((call.deadlineAt as number) - clock.now(), call.timeoutMs, `${op}: the stamped deadline is exactly its timeout from now`);
			return call.timeoutMs as number;
		};
		const statementWait = (NEO4J_DIALECT.limits as { statement_timeout_ms: number }).statement_timeout_ms + 10_000;
		assert.equal(busOf('read_query'), statementWait + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS, 'read_query: the node deadline + pad, + SDK slack, + bus margin');
		assert.equal(frameOf(OP.readQuery), busOf('read_query') + FRAME_OP_MARGIN_MS, 'and the frame waits the bus timeout + its margin');
		assert.equal(busOf('execute'), statementWait + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS, 'execute: the same statement wait');
		assert.equal(frameOf(OP.execute), busOf('execute') + FRAME_OP_MARGIN_MS);
		assert.equal(busOf('get_query'), 120_000 + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
		assert.equal(frameOf(OP.ask), busOf('get_query') + FRAME_OP_MARGIN_MS);
		assert.equal(busOf('dialect'), 15_000 + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
		assert.equal(frameOf(OP.probe), busOf('dialect') + FRAME_OP_MARGIN_MS);
		assert.equal(frameOf(OP.refreshEndpoints), CONTROLLER_LOCAL_OP_MS + FRAME_OP_MARGIN_MS, 'refresh STARTS discovery; its results arrive as state');
		assert.equal(frameOf(OP.historyList), CONTROLLER_LOCAL_OP_MS + FRAME_OP_MARGIN_MS, 'an op answered from memory: 15 s');
		for (const request of engine.requests) assert.ok(typeof request.timeoutMs === 'number' && request.timeoutMs > 0 && request.timeoutMs !== 120_000, `${request.op} names its own bus timeout, never the 120 s default`);
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T10 - the write gate is the controller\'s, even when a frame calls graph.execute directly', () => {
	it('a read-only node: the op is refused before anything is sent, and nothing is counted', async () => {
		const run = await connected(undefined);
		await assert.rejects(run.frame.caller.callReply(OP.execute, { key: run.key, query: 'CREATE (n:X)' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'unavailable', 'never "may have applied"');
			assert.equal(error.message, WRITE_REFUSED_TEXT);
			return true;
		});
		assert.ok(!run.engine.world.calls.some((c) => c.tool === 'execute'), 'execute never reached the node');
		await settle();
		assert.equal(run.frame.env(true).dataVersions.get(run.key), 0);
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a node with execution on: the write runs with shape graph and is counted once, by the controller', async () => {
		const run = await connected(undefined, (call) => (call.tool === 'dialect' ? NEO4J_WRITABLE : readOnlyNode(call)));
		// As the run surface sends it: through the env's countWrite, over the frame's remote session.
		const env = run.frame.env(true);
		const session = sessionOf(run.frame, run.endpoint);
		await env.countWrite(run.key, () => session.invoke('execute', { query: 'CREATE (n:X)', shape: 'graph' }));
		const sent = run.engine.world.calls.filter((c) => c.tool === 'execute');
		assert.deepEqual(sent.map((c) => c.input), [{ query: 'CREATE (n:X)', shape: 'graph' }]);
		await until(() => env.dataVersions.get(run.key) === 1, 'one count');
		await settle();
		assert.equal(env.dataVersions.get(run.key), 1, 'counted once: the frame never counts it as well');
		run.frame.dispose();
		run.controller.dispose();
	});

	it('an unknown key, a missing key or a malformed call is refused as data, and nothing is sent', async () => {
		const run = await connected(undefined, (call) => (call.tool === 'dialect' ? NEO4J_WRITABLE : readOnlyNode(call)));
		const calls = run.engine.world.calls.length;
		await assert.rejects(run.frame.caller.callReply(OP.execute, { key: 'k1|nope', query: 'CREATE (n)' }, { timeoutMs: 5_000 }), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'unavailable');
		await assert.rejects(run.frame.caller.callReply(OP.execute, { key: '', query: 'CREATE (n)' } as never, { timeoutMs: 5_000 }), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(run.frame.caller.callReply(OP.readQuery, { key: run.key, cypher: 'MATCH (n) RETURN n' } as never, { timeoutMs: 5_000 }), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		assert.equal(run.engine.world.calls.length, calls);
		run.frame.dispose();
		run.controller.dispose();
	});
});

/**
 * The whole retained state map as the sidebar peer last republished it (busPeer republishes ALL topics on every
 * publish, which is why the total is capped).
 *
 * @param h - The harness.
 * @returns The map: topic -> state message.
 */
function latestStateMap(h: IDevToolHarness): Record<string, { __rrtool?: string; topic?: string; snapshot?: unknown }> {
	for (let i = h.wire.length - 1; i >= 0; i -= 1) {
		const entry = h.wire[i];
		if (entry.transient || entry.value === null || typeof entry.value !== 'object') continue;
		const values = Object.values(entry.value as Record<string, { __rrtool?: string }>);
		if (values.length > 0 && values.every((m) => m?.__rrtool === 'state')) return entry.value as Record<string, { snapshot?: unknown }>;
	}
	throw new Error('no retained state map was published');
}

/**
 * A ~1 MB, 1,000-row graph result built from the live fixture's rows.
 *
 * @returns The result.
 */
function bigResult(): Record<string, unknown> {
	const rows = NEO4J_GRAPH.rows as unknown[][];
	const many = Array.from({ length: 1_000 }, (_, i) => JSON.parse(JSON.stringify(rows[i % rows.length]).replace(/"id":"([^"]+)"/g, `"id":"$1-${i}"`)) as unknown[]);
	return { ...NEO4J_GRAPH, rows: many, row_limit: 1_000 };
}

describe('T11 - no bulk result is retained state, and sizes are guarded', () => {
	it('after reads, a write, an Ask and history, every retained snapshot is under 64 KiB and holds no rows', async () => {
		const big = bigResult();
		const run = await connected(undefined, (call) => (call.tool === 'dialect' ? NEO4J_WRITABLE : call.tool === 'read_query' && call.input?.limit === 1_000 ? big : readOnlyNode(call)));
		const session = sessionOf(run.frame, run.endpoint);
		// A small result first: the state cap alone would not stop rows this small from being retained.
		await session.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 });
		await session.invoke('get_query', { question: 'q' });
		const result = await session.invoke<Record<string, unknown>>('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 1_000 });
		assert.equal((result.rows as unknown[]).length, 1_000, 'the frame got every row, as an op result');
		const bytes = jsonByteLength(result);
		assert.ok(bytes > 300_000 && bytes < 4_000_000, `a 1,000-row graph result is ${bytes} bytes`);
		await session.invoke('execute', { query: 'CREATE (n)', shape: 'graph' });
		await run.frame.env(true).loadSchema(run.key);
		run.frame.env(true).history.record(run.key, { id: 'e2', at: 1, kind: 'read', cypher: 'MATCH (n) RETURN n', ms: 1, outcome: 'rows', rows: 1_000 } as never);
		await settle();

		let snapshots = 0;
		for (const entry of run.h.wire) {
			if (entry.transient || entry.value === null || typeof entry.value !== 'object') continue;
			for (const message of Object.values(entry.value as Record<string, unknown>)) {
				const m = message as { __rrtool?: string; topic?: string; snapshot?: unknown };
				if (m?.__rrtool !== 'state') continue;
				snapshots += 1;
				assert.ok(jsonByteLength(m.snapshot) <= MAX_RETAINED_STATE_BYTES, `${m.topic} is under the cap`);
				assert.doesNotMatch(JSON.stringify(m.snapshot), /"rows"|"columns"|"cypher"/, `${m.topic} carries no rows and no statement text`);
			}
		}
		assert.ok(snapshots > 0, 'the premise: state was published');
		const map = latestStateMap(run.h);
		assert.ok(jsonByteLength(map) <= MAX_RETAINED_TOTAL_BYTES, `the whole republished map is ${jsonByteLength(map)} bytes, under the 128 KiB total`);
		assert.deepEqual(run.errors.filter((e) => e.where === 'state'), [], 'the guard never had to degrade or withhold anything');
		assert.deepEqual(run.h.violations, []);
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a result over the controller\'s cap is refused with a reason, not sent (and a write is still counted)', async () => {
		const big = bigResult();
		const run = await connected(undefined, (call) => (call.tool === 'dialect' ? NEO4J_WRITABLE : call.tool === 'read_query' || call.tool === 'execute' ? big : readOnlyNode(call)), { maxResultBytes: 256 * 1024 });
		const session = sessionOf(run.frame, run.endpoint);
		await assert.rejects(session.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 1_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'malformed' && /too large to send to this window/.test(error.message));
		await assert.rejects(session.invoke('execute', { query: 'CREATE (n)', shape: 'graph' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'malformed');
		await until(() => run.frame.env(true).dataVersions.get(run.key) === 1, 'the write that ran to be counted');
		run.frame.dispose();
		run.controller.dispose();
	});

	it('the endpoints and schemas snapshots stay under their budgets however many connections there are', () => {
		const endpoint = (i: number): IExplorerEndpoint => ({ key: `k1|dev|user|u1|team-1|proj-${i}|tools=tools_1|graph_1`, legacyKey: null, projectId: `proj-${i}`, pipelineName: `Pipeline ${i}`, runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 'team-1', roles: { tools: { source: 'tools_1', nodeId: 'graph_1' } as never }, missingRoles: [], source: 'tools_1', nodeId: 'graph_1', nodeName: `Graph ${i}`, provider: 'graph_neo4j', state: 'ready', running: true });
		const endpoints = Array.from({ length: 400 }, (_, i) => endpoint(i));
		const probes = Object.fromEntries(endpoints.map((e) => [e.key, { ok: true, info: NEO4J_DIALECT, dialect: 'neo4j' }]));
		const snap = endpointsSnapshot({ status: 'ready', endpoints, probes, error: null, refreshedAt: 1 });
		assert.ok(jsonByteLength(snap) <= ENDPOINTS_STATE_BYTES);
		assert.ok(snap.omitted > 0 && snap.omitted + snap.endpoints.length === 400, `${snap.omitted} left out and counted`);
		for (const e of snap.endpoints) assert.ok(snap.probes[e.key], 'every kept endpoint keeps its probe');

		const store = createSchemaStore();
		const names = Array.from({ length: 200 }, (_, i) => `Label${i}WithAReasonablyLongName`);
		const answer = { database: 'neo4j', labels: names, nodes: Object.fromEntries(names.map((n) => [n, [{ property: 'p', type: 'string' }]])), relationships: {} };
		const keys = Array.from({ length: 40 }, (_, i) => `key-${i}`);
		for (const key of keys) void store.load(key, async () => answer, () => ({}) as never);
		return settle().then(() => {
			const schemas = schemasSnapshot(store.keys().map((k) => [k, store.get(k)] as const));
			assert.ok(jsonByteLength(schemas) <= SCHEMAS_STATE_BYTES);
			assert.ok(Object.keys(schemas).length > 0 && Object.keys(schemas).length < 40, 'cut to the budget, newest first');
		});
	});

	it('400 connections, 40 loaded schemas and 2,000 data versions: the protocol\'s cuts and the base guard agree, and the whole map stays under 128 KiB', async () => {
		assert.ok(ENDPOINTS_STATE_BYTES + SCHEMAS_STATE_BYTES + VERSIONS_STATE_BYTES + 2 * 1024 <= MAX_RETAINED_TOTAL_BYTES, 'the fixed budgets leave room for the small topics');
		const names = Array.from({ length: 200 }, (_, i) => `Label${i}WithAReasonablyLongName`);
		const schemaAnswer = { database: 'neo4j', labels: names, nodes: Object.fromEntries(names.map((n) => [n, [{ property: 'p', type: 'string' }]])), relationships: {} };
		const rows = Array.from({ length: 400 }, (_, i) => graphRow({ token: `tk_${i}`, pipeline: { project_id: `p${i}`, name: `People ${i}`, components: [{ id: 'graph_1', provider: 'graph_neo4j', name: `People graph ${i}` }] } }));
		const engine = vscodeRealm(rows, (call) => (call.tool === 'get_schema' ? schemaAnswer : readOnlyNode(call)));
		signInVsCode(engine.realm);
		// 2,000 connections that once had a write: far over one snapshot, so the guard must DEGRADE it through shrink.
		const versions = createDataVersions();
		for (let i = 0; i < 2_000; i += 1) versions.bump(`k1|dev|user|u1|team-1|gone-${i}|tools=tools_1|graph_1`);
		const mounted = mountController(engine.cm, { stores: { dataVersions: versions } });
		await until(() => Object.keys(mounted.controller.stores.endpoints.getState().probes).length === 400, '400 probes', 400);
		const env = mounted.controller.env(true);
		const keys = mounted.controller.stores.endpoints.getState().endpoints.slice(0, 40).map((e) => e.key);
		for (const key of keys) await env.loadSchema(key);
		mounted.controller.stores.dataVersions.bump(keys[0]);
		await settle();

		const map = latestStateMap(mounted.h);
		assert.ok(jsonByteLength(map) <= MAX_RETAINED_TOTAL_BYTES, `the whole map is ${jsonByteLength(map)} bytes`);
		for (const message of Object.values(map)) assert.ok(jsonByteLength(message.snapshot) <= MAX_RETAINED_STATE_BYTES, `${message.topic} is under 64 KiB`);
		const endpoints = map[STATE.endpoints]?.snapshot as { endpoints: unknown[]; omitted: number; truncated?: unknown };
		assert.ok(endpoints.omitted > 0 && endpoints.omitted + endpoints.endpoints.length === 400, 'the endpoints are cut by the protocol, and counted');
		assert.equal(endpoints.truncated, undefined, 'never the generic truncated marker: the frames read omitted');
		const schemas = map[STATE.schemas]?.snapshot as Record<string, unknown>;
		assert.ok(Object.keys(schemas).length > 0 && Object.keys(schemas).length < 40, 'schemas cut newest first');
		const published = map[STATE.dataVersions]?.snapshot as Record<string, number>;
		assert.equal(published[keys[0]], 1, 'the listed connection that had a write keeps its version first');
		assert.ok(jsonByteLength(published) <= VERSIONS_STATE_BYTES && Object.keys(published).length < 2_001, 'the versions are cut to their own budget');
		assert.ok(Object.keys(published).includes(keys[0]) && Object.keys(published).length > 1, 'then the most recently written fill the rest');
		const reports = mounted.errors.filter((e) => e.where === 'state').map((e) => `${(e.error as { topic?: string }).topic}:${(e.error as { outcome?: string }).outcome}`);
		assert.deepEqual(reports, [], 'the fixed topics fit together: the guard never degrades or withholds one');
		assert.deepEqual(mounted.h.violations, []);
		mounted.controller.dispose();
	});

	it('440 connections, 40 schemas and a write on EVERY listed connection: data versions are cut to their budget, the published connections first, never withheld', async () => {
		const names = Array.from({ length: 200 }, (_, i) => `Label${i}WithAReasonablyLongName`);
		const schemaAnswer = { database: 'neo4j', labels: names, nodes: Object.fromEntries(names.map((n) => [n, [{ property: 'p', type: 'string' }]])), relationships: {} };
		const rows = Array.from({ length: 440 }, (_, i) => graphRow({ token: `tk_${i}`, pipeline: { project_id: `p${i}`, name: `People ${i}`, components: [{ id: 'graph_1', provider: 'graph_neo4j', name: `People graph ${i}` }] } }));
		const engine = vscodeRealm(rows, (call) => (call.tool === 'get_schema' ? schemaAnswer : readOnlyNode(call)));
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.stores.endpoints.getState().probes).length === 440, '440 probes', 500);
		const env = mounted.controller.env(true);
		const keys = mounted.controller.stores.endpoints.getState().endpoints.map((e) => e.key);
		for (const key of keys.slice(0, 40)) await env.loadSchema(key);
		const { frame } = mountFrame(mounted.h, undefined);
		await settle();
		for (const key of keys) mounted.controller.stores.dataVersions.bump(key);
		await settle();

		const outcomes = mounted.errors.filter((e) => e.where === 'state').map((e) => `${(e.error as { topic?: string }).topic}:${(e.error as { outcome?: string }).outcome}`);
		assert.ok(!outcomes.some((o) => o.endsWith(':withheld')), `nothing withheld: ${[...new Set(outcomes)].join(', ')}`);
		const map = latestStateMap(mounted.h);
		assert.ok(jsonByteLength(map) <= MAX_RETAINED_TOTAL_BYTES, `the whole map is ${jsonByteLength(map)} bytes`);
		const published = (map[STATE.endpoints]?.snapshot as { endpoints: Array<{ key: string }> }).endpoints.map((e) => e.key);
		const versions = map[STATE.dataVersions]?.snapshot as Record<string, number>;
		assert.ok(published.length > 0 && published.length < 440, 'the premise: the endpoints snapshot is cut');
		for (const key of published) assert.equal(versions[key], 1, 'every connection a frame can show has its version');
		await until(() => frame.env(true).dataVersions.get(published[published.length - 1]) === 1, 'a frame sees the write on a published connection');
		assert.deepEqual(mounted.h.violations, []);
		frame.dispose();
		mounted.controller.dispose();
	});

	it('versionsSnapshot keeps the shown connections first, then the newest, within the budget', () => {
		const all: Record<string, number> = {};
		for (let i = 0; i < 300; i += 1) all[`k1|unlisted|${String(i).padStart(4, '0')}`] = 1;
		all['k1|shown|old'] = 3;
		for (let i = 300; i < 600; i += 1) all[`k1|unlisted|${String(i).padStart(4, '0')}`] = 1;
		const cut = versionsSnapshot(all, new Set(['k1|shown|old']), 2_048);
		assert.ok(jsonByteLength(cut) <= 2_048);
		assert.equal(cut['k1|shown|old'], 3, 'a shown connection first, however old its write');
		assert.ok('k1|unlisted|0599' in cut && !('k1|unlisted|0000' in cut), 'then the most recently written');
		assert.deepEqual(versionsSnapshot({ a: 1 }, new Set(), 2_048), { a: 1 }, 'a small map is kept whole');
	});

	it('a history list is an op result: the history state is a revision number only', async () => {
		const run = await connected(undefined);
		const env = run.frame.env(true);
		for (let i = 0; i < 30; i += 1) env.history.record(run.key, { id: `h${i}`, at: i + 1, kind: 'read', cypher: `MATCH (n) WHERE n.x = '${i}-${'v'.repeat(2_000)}' RETURN n`, ms: 1, outcome: 'rows', rows: 1 } as never);
		const view = env.history.view(run.key);
		const off = view.subscribe(() => undefined);
		await until(() => view.get().entries.length === 30, 'all 30 entries');
		assert.ok(jsonByteLength(view.get()) > 60_000, 'the list itself is large');
		const history = run.h.wire.flatMap((entry) => Object.values((entry.value ?? {}) as Record<string, { __rrtool?: string; topic?: string; snapshot?: unknown }>)).filter((m) => m?.__rrtool === 'state' && m.topic === STATE.history);
		for (const m of history) assert.deepEqual(Object.keys(m.snapshot as object), ['rev']);
		off();
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('T13 - deadlines: an expired call never runs, on every path a call can wait', () => {
	it('a write the PEER holds reaches a remount that keeps its host channel (rocket-ui caches one per tool); the frame has already given up and the controller refuses it (control: an on-time held read runs)', async () => {
		const clock = manualNow(1_000_000);
		const engine = vscodeRealm(undefined, (call) => (call.tool === 'dialect' ? NEO4J_WRITABLE : readOnlyNode(call)));
		signInVsCode(engine.realm);
		const first = mountController(engine.cm, { now: clock.now });
		first.h.setHostConnection(true);
		const { frame } = mountFrame(first.h, undefined, { now: clock.now });
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const key = frame.env(true).endpoints.get().endpoints[0].key;

		// The frame calls while the controller is READY (a frame waits for readiness: a call made with no controller up
		// is never sent), and the controller unmounts (a VS Code disconnect) while the call is still on the bus: the
		// real busPeer HOLDS it, and the frame gives up.
		const late = frame.caller.callReply(OP.execute, { key, query: 'CREATE (n:Late)' }, { timeoutMs: 40 });
		first.controller.dispose();
		await assert.rejects(late, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
		assert.equal(frame.caller.pending(), 0, 'the frame gave up');

		// Minutes pass, then the controller remounts (the host's channel and peer live on) and receives the held call.
		clock.advance(5 * 60_000);
		const errors: string[] = [];
		const again = mountController(engine.cm, { now: clock.now, onError: (error, where) => errors.push(`${where}:${(error as { reason?: string }).reason ?? ''}`) }, first.h, first);
		await settle();
		assert.ok(!engine.world.calls.some((c) => c.tool === 'execute'), 'the expired write never reached the node');
		assert.ok(errors.includes('refused:expired'), 'it DID reach the controller, which refused it');

		// Control: the same race, with the remount inside the deadline: the held call runs.
		await settle();
		const onTime = frame.caller.callReply(OP.historyList, { key }, { timeoutMs: 60_000 });
		again.controller.dispose();
		await settle();
		const third = mountController(engine.cm, { now: clock.now }, first.h, first);
		assert.deepEqual(await onTime, { entries: [], recording: true }, 'the on-time held call ran on the remounted controller');
		frame.dispose();
		third.controller.dispose();
	});

	it('a call the PEER holds before a mount with a FRESH host channel (a first or summon-driven mount; VS Code builds one per mount) goes to that channel and is dropped: never answered, never refused; our frames, which wait for readiness, never put a call in the hold', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const h = createDevToolHarness(GRAPH_APP_ID, { json: true });
		h.setHostConnection(true);
		const isCall = (value: unknown): boolean => (value as { __rrtool?: unknown } | null)?.__rrtool === 'call';
		const heldCalls = (): number => h.wire.filter((entry) => entry.topic === `tool:${GRAPH_APP_ID}:toSidebar` && isCall(entry.value)).length;

		// Our frames (the base caller's default) wait for readiness: nothing reaches the peer.
		const waiting = createFrameCaller<GraphOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel });
		await assert.rejects(waiting.callReply(OP.historyList, { key: 'k1|any' }, { timeoutMs: 60 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /was not sent/.test(error.message));
		assert.equal(heldCalls(), 0, 'a waiting frame posts no call');

		// A caller that does not wait (no lane does) puts its call in the hold, which summons the controller.
		const eager = createFrameCaller<GraphOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel, waitForController: false });
		const held = eager.callReply(OP.historyList, { key: 'k1|any' }, { timeoutMs: 300 });
		await settle();
		assert.equal(heldCalls(), 1);
		assert.ok(h.emitted.some((entry) => entry.op === 'host.mountToolSidebar'), 'the held call summoned the controller');

		// The host mounts it as on a first mount: a NEW channel on the sidebar peer (mountController's default), then the controller.
		const errors: string[] = [];
		const mounted = mountController(engine.cm, { onError: (error, where) => errors.push(`${where}:${(error as { reason?: string }).reason ?? ''}`) }, h);
		await assert.rejects(held, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout', 'a served call would have been answered at once');
		assert.ok(!errors.some((entry) => entry.startsWith('refused')), 'and it never reached the controller: the host channel took it');
		waiting.dispose();
		eager.dispose();
		mounted.controller.dispose();
	});
});
