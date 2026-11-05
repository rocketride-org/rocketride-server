// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// ADAPTER ACTIONS: schema load / refresh and Ask, over the real shared library
// =============================================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codedError, fakeWorld, manualClock, row } from 'shared/explorer/connect/testing';
import type { IFakeRow, IToolCall } from 'shared/explorer/connect/testing';
import { TOOL, makeGraphEndpointStore } from '../src/adapters/explorer';
import { askConnection, loadConnectionSchema } from '../src/adapters/actions';
import { createSchemaStore } from '../src/graph/schemaStore';
import { ASK_UNAVAILABLE, UPGRADE_GET_QUERY } from '../src/graph/wording';
import { fixture } from './support/builders';

const CURRENT = fixture<Record<string, unknown>>('dialect_neo4j');
const OLD = fixture<Record<string, unknown>>('dialect_old_node');

function graphRow(over: Partial<IFakeRow> = {}): IFakeRow {
	return row({ pipeline: { project_id: 'proj-g', name: 'Graph pipeline', components: [{ id: 'graph_1', provider: 'graph_neo4j', name: 'Graph' }] }, ...over });
}

/** A store over a fake world, discovered and probed, and the stores the actions take. */
async function rig(dialect: Record<string, unknown>, extra: Record<string, (call: IToolCall) => unknown> = {}) {
	const world = fakeWorld([graphRow()], (call) => {
		if (extra[call.tool]) return extra[call.tool](call);
		if (call.tool === TOOL.dialect) return dialect;
		if (call.tool === TOOL.getSchema) return fixture('schema_old_node');
		return {};
	});
	const clock = manualClock();
	const endpoints = makeGraphEndpointStore({ clock });
	await endpoints.refresh(world.client);
	await clock.settle();
	const stores = { endpoints, schemas: createSchemaStore() };
	return { world, stores, endpoint: endpoints.getState().endpoints[0] };
}

describe('schema actions', () => {
	it('the first load reads get_schema, and an old node\'s snapshot is labelled as one it cannot refresh', async () => {
		const { world, stores, endpoint } = await rig(OLD);
		await loadConnectionSchema(world.client, endpoint, {}, stores);
		const entry = stores.schemas.get(endpoint.key);
		assert.equal(entry.status, 'ready');
		assert.deepEqual(entry.view.labels.map((l) => l.name), ['Company', 'Person']);
		assert.equal(entry.view.legacy, true);
		assert.deepEqual(world.calls.map((c) => c.tool), ['dialect', 'get_schema']);
	});

	it('Refresh asks refresh_schema only when the node can, and otherwise re-reads get_schema (never an error for a node that cannot)', async () => {
		const capable = await rig({ ...CURRENT, capabilities: { ...(CURRENT.capabilities as object), refresh_schema: true } }, { [TOOL.refreshSchema]: () => fixture('schema_v2') });
		await loadConnectionSchema(capable.world.client, capable.endpoint, { fresh: true }, capable.stores);
		assert.ok(capable.world.calls.some((c) => c.tool === TOOL.refreshSchema));
		assert.equal(capable.stores.schemas.get(capable.endpoint.key).view.source, 'refresh');

		const noRefresh = await rig({ ...CURRENT, capabilities: { ...(CURRENT.capabilities as object), refresh_schema: false } });
		await loadConnectionSchema(noRefresh.world.client, noRefresh.endpoint, { fresh: true }, noRefresh.stores);
		assert.ok(!noRefresh.world.calls.some((c) => c.tool === TOOL.refreshSchema), 'a node that says it cannot is not asked');
		assert.equal(noRefresh.stores.schemas.get(noRefresh.endpoint.key).status, 'ready');
	});

	it('a node that cannot refresh keeps its snapshot, and a failed refresh says so for refresh_schema (not read_query)', async () => {
		const { world, stores, endpoint } = await rig({ ...CURRENT, capabilities: { ...(CURRENT.capabilities as object), refresh_schema: true } }, { [TOOL.refreshSchema]: () => { throw codedError('Schema refresh failed\nconnection reset'); } });
		await loadConnectionSchema(world.client, endpoint, {}, stores);
		const before = stores.schemas.get(endpoint.key).view;
		await loadConnectionSchema(world.client, endpoint, { fresh: true }, stores);
		const entry = stores.schemas.get(endpoint.key);
		assert.equal(entry.status, 'error');
		assert.deepEqual(entry.view, before, 'the last good snapshot stays');
		assert.equal(entry.failure?.headline, 'Schema refresh failed');
	});

	it('a failed first load is an error entry that shows nothing, not an empty graph', async () => {
		const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getSchema]: () => { throw codedError('Schema unavailable\nconnection refused'); } });
		await loadConnectionSchema(world.client, endpoint, {}, stores);
		const entry = stores.schemas.get(endpoint.key);
		assert.equal(entry.status, 'error');
		assert.equal(entry.view.labels.length, 0);
		assert.equal(entry.failure?.headline, 'Schema unavailable');
		assert.equal(entry.failure?.detail, 'connection refused');
	});
});

// Refresh never falls back to get_schema (stored as if it were fresh) while the probe is missing, and a Refresh pressed
// during the first get_schema is not answered by that load: it reaches refresh_schema once the load ends.
describe('schema Refresh when the connection is busy', () => {
	const CAPABLE = { ...CURRENT, capabilities: { ...(CURRENT.capabilities as object), refresh_schema: true } };
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	};

	it('Refresh while the connection is being checked again sends nothing and records why, instead of quietly re-reading get_schema', async () => {
		let hold = false;
		const { world, stores, endpoint } = await rig(CAPABLE, { [TOOL.dialect]: () => (hold ? new Promise(() => undefined) : CAPABLE), [TOOL.refreshSchema]: () => fixture('schema_v2') });
		await loadConnectionSchema(world.client, endpoint, {}, stores);
		const before = stores.schemas.get(endpoint.key).view;
		hold = true;
		void stores.endpoints.refresh(world.client, { reprobe: true });
		await settle();
		assert.equal(stores.endpoints.getState().probes[endpoint.key], undefined, 'the probe is gone while the node is asked again');
		const sent = world.calls.length;
		await loadConnectionSchema(world.client, endpoint, { fresh: true }, stores);
		assert.deepEqual(world.calls.slice(sent).map((c) => c.tool).filter((t) => t !== TOOL.dialect), [], 'neither get_schema nor refresh_schema was sent');
		const entry = stores.schemas.get(endpoint.key);
		assert.equal(entry.status, 'error');
		assert.deepEqual(entry.view, before, 'the snapshot stays');
		assert.match(entry.failure?.headline ?? '', /not refreshed: this connection has not answered its check yet/);
	});

	it('Refresh pressed while the first schema load runs is sent once that load ends, and pressing it twice sends one refresh', async () => {
		let releaseGet: () => void = () => undefined;
		const { world, stores, endpoint } = await rig(CAPABLE, {
			[TOOL.getSchema]: () => new Promise((resolve) => { releaseGet = () => resolve(fixture('schema_old_node')); }),
			[TOOL.refreshSchema]: () => fixture('schema_v2'),
		});
		const first = loadConnectionSchema(world.client, endpoint, {}, stores);
		await settle();
		const refresh = loadConnectionSchema(world.client, endpoint, { fresh: true }, stores);
		const again = loadConnectionSchema(world.client, endpoint, { fresh: true }, stores);
		releaseGet();
		await Promise.all([first, refresh, again]);
		assert.deepEqual(world.calls.map((c) => c.tool), [TOOL.dialect, TOOL.getSchema, TOOL.refreshSchema]);
		assert.equal(stores.schemas.get(endpoint.key).view.source, 'refresh');
	});

	it('a second Refresh while a refresh runs joins it: one refresh_schema for a double click', async () => {
		let releaseRefresh: () => void = () => undefined;
		const { world, stores, endpoint } = await rig(CAPABLE, { [TOOL.refreshSchema]: () => new Promise((resolve) => { releaseRefresh = () => resolve(fixture('schema_v2')); }) });
		const one = loadConnectionSchema(world.client, endpoint, { fresh: true }, stores);
		await settle();
		const two = loadConnectionSchema(world.client, endpoint, { fresh: true }, stores);
		releaseRefresh();
		await Promise.all([one, two]);
		assert.equal(world.calls.filter((c) => c.tool === TOOL.refreshSchema).length, 1);
	});
});

describe('Ask over get_query', () => {
	it('sends the trimmed question and returns Cypher as a preview, never running it', async () => {
		const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getQuery]: () => ({ query: 'MATCH (n:Person) RETURN n LIMIT 25', valid: true }) });
		const outcome = await askConnection(world.client, endpoint, '  who are the people?  ', stores);
		assert.deepEqual(outcome, { kind: 'cypher', cypher: 'MATCH (n:Person) RETURN n LIMIT 25' });
		const call = world.calls.find((c) => c.tool === TOOL.getQuery) as IToolCall;
		assert.deepEqual(call.input, { question: 'who are the people?' });
		assert.ok(!world.calls.some((c) => c.tool === TOOL.readQuery || c.tool === TOOL.execute), 'asking runs nothing');
	});

	it('prose is an answer, not an error', async () => {
		const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getQuery]: () => ({ answer: 'I can only answer questions about the graph.', valid: false }) });
		assert.deepEqual(await askConnection(world.client, endpoint, 'hello', stores), { kind: 'prose', text: 'I can only answer questions about the graph.' });
	});

	it('a pipeline without a language model is "unavailable", with the reason, not an error banner', async () => {
		const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getQuery]: () => { throw codedError('No LLM connected to this node'); } });
		assert.deepEqual(await askConnection(world.client, endpoint, 'who?', stores), { kind: 'unavailable', text: ASK_UNAVAILABLE });
	});

	// NO_MODEL does not match a bare "llm" or "not connected": the node's own "LLM failed to return a Cypher query." (a
	// connected model that answered nothing) and the SDK's "Server is not connected" are failures, not "no model".
	it('the engine\'s no-listener text is "unavailable"; a model that answered nothing and a dropped connection are failures', async () => {
		const none = await rig(CURRENT, { [TOOL.getQuery]: () => { throw codedError('InvalidParam: No control listeners registered for llm at (filter.callbacks.target.cpp:96)'); } });
		assert.deepEqual(await askConnection(none.world.client, none.endpoint, 'who?', none.stores), { kind: 'unavailable', text: ASK_UNAVAILABLE });
		for (const message of ['LLM failed to return a Cypher query.', 'Server is not connected', 'WebSocket not connected: call connect() first']) {
			const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getQuery]: () => { throw codedError(message); } });
			const outcome = await askConnection(world.client, endpoint, 'who?', stores);
			assert.equal(outcome.kind, 'failed', message);
			assert.equal(outcome.kind === 'failed' ? outcome.headline : '', message);
		}
	});

	it('an engine that does not know get_query gets the upgrade wording, as every other tool does', async () => {
		const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getQuery]: () => { throw codedError('No handler found for tool get_query'); } });
		const outcome = await askConnection(world.client, endpoint, 'who?', stores);
		assert.equal(outcome.kind, 'failed');
		assert.equal(outcome.kind === 'failed' ? outcome.headline : '', UPGRADE_GET_QUERY);
		assert.equal(outcome.kind === 'failed' ? outcome.variant : '', 'warning');
	});

	it('a node refusal (the model wrote something unsafe) is a failure with the node\'s words', async () => {
		const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getQuery]: () => ({ error: 'Generated query contains write or admin clauses', query: 'CREATE (n)', valid: false }) });
		const outcome = await askConnection(world.client, endpoint, 'add a person', stores);
		assert.equal(outcome.kind, 'failed');
		assert.match(outcome.kind === 'failed' ? outcome.headline : '', /write or admin clauses/);
	});

	it('an empty or oversized question is refused locally and nothing is sent', async () => {
		const { world, stores, endpoint } = await rig(CURRENT);
		assert.equal((await askConnection(world.client, endpoint, '   ', stores)).kind, 'refused');
		assert.equal((await askConnection(world.client, endpoint, 'x'.repeat(2001), stores)).kind, 'refused');
		assert.ok(!world.calls.some((c) => c.tool === TOOL.getQuery));
	});

	it('a node that answers with neither a query nor text is a failure', async () => {
		const { world, stores, endpoint } = await rig(CURRENT, { [TOOL.getQuery]: () => ({ valid: true }) });
		assert.equal((await askConnection(world.client, endpoint, 'who?', stores)).kind, 'failed');
	});
});
