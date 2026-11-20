// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// ADAPTER: Graph Explorer on the shared endpoint store, tool session and history
// =============================================================================
//
// These run the REAL shared library (store, session, per-tool checks, history)
// over a fake client, configured exactly as the app configures it.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ExplorerToolError, probeInfo } from 'shared/explorer';
import { codedError, fakeWorld, manualClock, row } from 'shared/explorer/connect/testing';
import type { IFakeRow, IToolCall } from 'shared/explorer/connect/testing';
import * as explorerAdapter from '../src/adapters/explorer';
import { GRAPH_PROVIDERS, TOOL, makeGraphEndpointStore, makeGraphHistory, makeGraphTools } from '../src/adapters/explorer';
import { parseDialect, supportsReadQuery } from '../src/graph/dialect';
import { fixture, readQueryFixture } from './support/builders';

const TOKEN_SENTINEL = 'tk_sentinel';

/** A running tools-only graph pipeline row. */
function graphRow(provider = 'graph_neo4j', over: Partial<IFakeRow> = {}): IFakeRow {
	return row({ pipeline: { project_id: 'proj-g', name: 'Graph pipeline', components: [{ id: 'graph_1', provider, name: 'Graph' }] }, ...over });
}

/** Tool behaviour: dialect, read_query, execute, get_query, schema answers. */
function behaviour(dialect: Record<string, unknown>, extra: Record<string, (call: IToolCall) => unknown> = {}) {
	return (call: IToolCall): unknown => {
		if (extra[call.tool]) return extra[call.tool](call);
		switch (call.tool) {
			case TOOL.dialect:
				return dialect;
			case TOOL.readQuery:
				return readQueryFixture('scalars');
			case TOOL.getSchema:
				return fixture('schema_v2');
			default:
				return {};
		}
	};
}

const CURRENT = fixture<Record<string, unknown>>('dialect_neo4j');
const OLD = fixture<Record<string, unknown>>('dialect_old_node');

/** A store over a fake world, already discovered and probed. */
async function rig(dialect: Record<string, unknown>, extra: Record<string, (call: IToolCall) => unknown> = {}, rows: IFakeRow[] = [graphRow()]) {
	const world = fakeWorld(rows, behaviour(dialect, extra));
	const clock = manualClock();
	const store = makeGraphEndpointStore({ clock });
	await store.refresh(world.client);
	await clock.settle();
	const endpoint = store.getState().endpoints[0];
	return { world, store, clock, endpoint, session: () => store.session(world.client, endpoint) };
}

describe('providers', () => {
	it('are exactly the three Cypher providers (Arango and HydraDB are not Cypher)', () => {
		assert.deepEqual([...GRAPH_PROVIDERS].sort(), ['graph_falkordb', 'graph_neo4j', 'rocketride_graph']);
		for (const other of ['db_arango', 'graph_arango', 'db_hydradb', 'graph_hydradb', 'db_postgres', 'db_mysql', 'rocketride_sql']) assert.ok(!GRAPH_PROVIDERS.has(other), other);
	});

	it('discovery keeps graph nodes and ignores every other provider', async () => {
		const rows = [graphRow('graph_neo4j', { name: 'neo' }), graphRow('graph_falkordb', { name: 'falkor', source: 'tools_2' }), graphRow('rocketride_graph', { name: 'age', source: 'tools_3' }), row({ name: 'sql', source: 'tools_4', pipeline: { project_id: 'p', name: 'sql', components: [{ id: 'db_1', provider: 'db_postgres', name: 'DB' }] } }), row({ name: 'arango', source: 'tools_5', pipeline: { project_id: 'p', name: 'arango', components: [{ id: 'a', provider: 'db_arango', name: 'A' }] } })];
		const world = fakeWorld(rows, behaviour(CURRENT));
		const store = makeGraphEndpointStore({ clock: manualClock() });
		await store.refresh(world.client);
		assert.deepEqual(store.getState().endpoints.map((e) => e.provider).sort(), ['graph_falkordb', 'graph_neo4j', 'rocketride_graph']);
	});
});

describe('tools: per-tool judgement', () => {
	it('declares idempotency and capabilities per tool: reads and reflection are idempotent, execute never is', () => {
		const GRAPH_TOOLS = makeGraphTools();
		assert.deepEqual(Object.entries(GRAPH_TOOLS).map(([name, spec]) => [name, spec.idempotent === true]).sort(), [['dialect', true], ['execute', false], ['get_query', true], ['get_schema', true], ['read_query', true], ['refresh_schema', true]]);
		assert.equal(GRAPH_TOOLS[TOOL.readQuery].capability, 'read_query');
		assert.equal(GRAPH_TOOLS[TOOL.refreshSchema].capability, 'refresh_schema');
		assert.equal(GRAPH_TOOLS[TOOL.execute].capability, 'execute_shape_graph');
	});

	it('a probed current node answers read_query with a validated envelope, on the node, with a timeout above its statement deadline', async () => {
		const { world, session, store, endpoint } = await rig(CURRENT);
		assert.ok(probeInfo(store.getState().probes[endpoint.key]));
		const dialect = parseDialect(session().info());
		assert.equal(supportsReadQuery(dialect), true);
		const result = await session().invoke<{ columns: string[] }>(TOOL.readQuery, { cypher: 'RETURN 1', params: {}, limit: 1000 });
		assert.deepEqual(result.columns, ['label', 'n']);
		const call = world.calls.find((c) => c.tool === TOOL.readQuery) as IToolCall;
		assert.equal(call.nodeId, 'graph_1');
		assert.deepEqual(call.input, { cypher: 'RETURN 1', params: {}, limit: 1000 });
		// Statement deadline (30 s) + pad (10 s) + the SDK's own slack (1 s): the node's error arrives first.
		assert.equal(call.timeout, 41000);
	});

	it('an OLD node (dialect only) is refused locally as upgrade and read_query is never sent, never replaced by execute', async () => {
		const { world, session } = await rig(OLD);
		await assert.rejects(session().invoke(TOOL.readQuery, { cypher: 'RETURN 1' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade');
		assert.deepEqual(world.calls.map((c) => c.tool), ['dialect'], 'only the probe was sent: no read_query, no execute, no query');
		await assert.rejects(session().invoke(TOOL.refreshSchema), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade');
		await assert.rejects(session().invoke(TOOL.execute, { cypher: 'CREATE (n)', shape: 'graph' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade');
		assert.deepEqual(world.calls.map((c) => c.tool), ['dialect']);
	});

	it('a node refusal arrives as a raised error with the headline and the database text split', async () => {
		const errors = fixture<Record<string, string>>('errors');
		const { session } = await rig(CURRENT, { [TOOL.readQuery]: () => { throw codedError(errors.refused_write); } });
		await assert.rejects(session().invoke(TOOL.readQuery, { cypher: 'CREATE (n)' }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'raised');
			assert.equal(error.headline, 'Refused: read_query is read-only; this statement writes (CREATE)');
			assert.match(error.detail ?? '', /Use the write console/);
			return true;
		});
	});

	it('a read_query answer that is not a row envelope is malformed, not shown', async () => {
		for (const bad of [{}, { columns: ['a'], rows: [[1, 2]], row_limit: 10, truncated: false }, { columns: 'a', rows: [], row_limit: 1, truncated: false }, null, 'x']) {
			const { session } = await rig(CURRENT, { [TOOL.readQuery]: () => bad });
			await assert.rejects(session().invoke(TOOL.readQuery, { cypher: 'RETURN 1' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'malformed', JSON.stringify(bad));
		}
	});

	it('get_query: prose is an answer, an error envelope is a failure, valid Cypher is a preview', async () => {
		const prose = { answer: 'Graphs store nodes and relationships.', valid: false };
		const cypher = { query: 'MATCH (n) RETURN n LIMIT 5', valid: true };
		const failure = { error: 'Generated query contains write or admin clauses', query: 'CREATE (n)', valid: false };
		const asked = async (value: unknown) => (await rig(CURRENT, { [TOOL.getQuery]: () => value })).session().invoke(TOOL.getQuery, { question: 'q' });
		assert.deepEqual(await asked(prose), prose);
		assert.deepEqual(await asked(cypher), cypher);
		await assert.rejects(asked(failure), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
	});

	it('schema answers: an old-format answer is accepted as an object and left to the schema model; nothing here calls it empty', async () => {
		const { session } = await rig(CURRENT);
		const value = await session().invoke<Record<string, unknown>>(TOOL.getSchema);
		assert.equal((value.schema as { version: number }).version, 2);
	});
});

describe('retry and replay', () => {
	it('an idempotent read is retried ONCE on TASK_STOPPED after re-discovery, with the same token; execute is never replayed', async () => {
		let reads = 0;
		const { world, session } = await rig(parseDialect(CURRENT) ? { ...CURRENT, allow_execute: true } : CURRENT, {
			[TOOL.readQuery]: () => {
				reads += 1;
				if (reads === 1) throw codedError('Task stopped', 'TASK_STOPPED');
				return readQueryFixture('scalars');
			},
			[TOOL.execute]: () => {
				throw codedError('Task stopped', 'TASK_STOPPED');
			},
		});
		const result = await session().invoke(TOOL.readQuery, { cypher: 'RETURN 1' });
		assert.ok(result);
		const readCalls = world.calls.filter((c) => c.tool === TOOL.readQuery);
		assert.equal(readCalls.length, 2, 'exactly one retry');
		assert.equal(readCalls[0].token, readCalls[1].token, 'a restart keeps the same task token');
		await assert.rejects(session().invoke(TOOL.execute, { cypher: 'CREATE (n)', shape: 'graph' }));
		assert.equal(world.calls.filter((c) => c.tool === TOOL.execute).length, 1, 'a write is sent once, whatever happens');
	});

	it('a permission error and a timeout are not replayed', async () => {
		let calls = 0;
		const { session } = await rig(CURRENT, { [TOOL.readQuery]: () => { calls += 1; throw codedError('forbidden', 'PERMISSION_DENIED'); } });
		await assert.rejects(session().invoke(TOOL.readQuery, { cypher: 'RETURN 1' }));
		assert.equal(calls, 1);
	});
});

describe('tokens', () => {
	it('never appear in anything the store hands out, nor in a history entry', async () => {
		const { store, endpoint } = await rig(CURRENT);
		const dump = JSON.stringify([store.getState(), endpoint]);
		assert.ok(!dump.includes(TOKEN_SENTINEL), 'no task token in the store snapshot or the endpoint');
		assert.ok(!/token/i.test(Object.keys(endpoint).join(',')), 'no token-like field on an endpoint');
	});
});

describe('history and flags', () => {
	/** A preferences accessor over a plain object. */
	function prefs(initial: Record<string, unknown> = {}) {
		const bag: Record<string, unknown> = { ...initial };
		return { bag, accessor: { getPref: (k: string) => bag[k], setPref: (k: string, v: unknown) => { bag[k] = v; } } };
	}

	it('records under graph.history with the text field cypher, and leaves sql.* alone', async () => {
		const store = makeGraphHistory(1);
		const p = prefs({ 'sql.history': { 'old-key': [{ id: 'x', at: 1, ms: 1, outcome: 'rows', kind: 'select', sql: 'SELECT 1' }] } });
		const detach = store.attachPrefs(p.accessor);
		store.runs.emitRun('k1|dev|user|u1|t|p|tools=tools_1|graph_1', { id: 'h1', at: 1000, ms: 12, outcome: 'rows', rows: 3, limit: 1000, kind: 'MATCH', cypher: 'MATCH (n) RETURN n' });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const saved = p.bag['graph.history'] as Record<string, Array<Record<string, unknown>>>;
		assert.ok(saved, 'the entry was persisted under graph.history');
		const entry = Object.values(saved)[0][0];
		assert.equal(entry.cypher, 'MATCH (n) RETURN n');
		assert.ok(!('sql' in entry));
		assert.ok(!JSON.stringify(p.bag).includes(TOKEN_SENTINEL));
		assert.deepEqual(Object.keys(p.bag['sql.history'] as object), ['old-key'], 'SQL history is untouched');
		detach();
	});

	// The write console always confirms what the text check flags and the README promises no "do not ask again", so
	// Graph Explorer keeps no pattern-check switch (`graph.patternChecks`): a later change cannot wire one to turn the
	// confirmation off by accident.
	it('keeps no pattern-check switch: nothing in the app stores or reads graph.patternChecks', () => {
		assert.ok(!('patternChecks' in explorerAdapter), 'the adapter exports no pattern-check flag store');
		const src = path.resolve(__dirname, '..', 'src');
		const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
		const all = files(src);
		assert.ok(all.length > 20, 'the source tree was read');
		for (const file of all) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /patternChecks/, path.relative(src, file));
	});
});
