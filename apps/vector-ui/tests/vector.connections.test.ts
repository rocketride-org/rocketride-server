// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONNECTIONS: the cards, their drawer, the landing's empty states, and the console's model
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { CONFIG_SENTINEL, fakeWorld, manualClock, projectRows, ragComponents, row, vectorComponents } from 'shared/explorer/connect/testing';
import type { IFakeWorld } from 'shared/explorer/connect/testing';
import { makeVectorEndpointStore } from '../src/adapters/explorer';
import { NOT_GROUPED_NOTE, drawerKeyAfter, drawerView, landingView, roleLine, testResultText, vectorCardView } from '../src/vector/connections';
import { buildConsoleModel, consoleNodes, writesDuringRemoval } from '../src/vector/consoleModel';
import { providerTitle } from '../src/vector/support';
import { readStats } from '../src/vector/results';
import { BUSY, CODE_SENTENCES, EMPTY } from '../src/vector/wording';
import { fixture } from './support/fixtures';

/** Discover over a fake world and return the endpoints with their probes. */
async function discover(w: IFakeWorld): Promise<Array<{ endpoint: IExplorerEndpoint; probe: IProbeResult | undefined }>> {
	const clock = manualClock();
	const store = makeVectorEndpointStore({ clock, debounceMs: 0 });
	const refreshing = store.refresh(w.client);
	await clock.advance(0);
	await refreshing;
	await clock.settle();
	const { endpoints, probes } = store.getState();
	return endpoints.map((endpoint) => ({ endpoint, probe: probes[endpoint.key] }));
}

/** A world whose stores answer `dialect` with this fixture. */
function world(rows: ReturnType<typeof projectRows>, dialect: unknown = fixture('dialect_qdrant')): IFakeWorld {
	return fakeWorld(rows, (call) => {
		if (call.tool === 'dialect') {
			const value = dialect as { rejected?: { message: string } };
			if (value.rejected) throw new Error(value.rejected.message);
			return dialect;
		}
		return {};
	});
}

const VX = () => projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('qdrant'));

test('the VX template is one card: store_1, with the store, collection and pipeline, and every role running', async () => {
	const found = await discover(world(VX()));
	assert.deepEqual(
		found.map((f) => f.endpoint.nodeId),
		['store_1'],
		'store_2 (the chat path) is never a card'
	);
	const card = vectorCardView(found[0].endpoint, found[0].probe);
	assert.equal(card.title, 'Store');
	assert.equal(card.address, 'Qdrant · vx_demo_docs · Vector docs');
	assert.equal(card.roleLine, 'ingest ✓ · chat ✓ · tools ✓');
	assert.deepEqual(card.badge, { variant: 'success', label: 'Running' });
	assert.deepEqual(card.flags, []);
	assert.equal(card.openable, true);
});

test('a missing role shows "–" and says it is not running', async () => {
	const [only] = await discover(world(projectRows(['chat_1', 'tools_1'], vectorComponents('qdrant'))));
	assert.equal(roleLine(only.endpoint), 'ingest – · chat ✓ · tools ✓');
	assert.ok(drawerView(only.endpoint, only.probe).rows.some((r) => r.label === 'Ingest' && r.value === 'not running'));
});

test('a stock RAG pipeline is a Read-only card anchored on its chat source; its trash and drop are disabled with the reason', async () => {
	const [rag] = await discover(world(projectRows(['webhook_1', 'chat_1'], ragComponents('qdrant'))));
	const card = vectorCardView(rag.endpoint, rag.probe);
	assert.ok(card.flags.some((f) => f.label === 'Read-only'));
	assert.equal(card.line, 'No Tools source: documents cannot be added or removed from here');
	assert.equal(card.openable, true, 'chat and the map stay available');
	const model = buildConsoleModel(rag.endpoint, rag.probe, null);
	assert.equal(model.readOnly, true);
	assert.deepEqual(model.writes, { enabled: false, reason: EMPTY.readOnly });
	assert.deepEqual(model.ingest, { enabled: false, reason: EMPTY.readOnly });
	assert.equal(model.chat.enabled, true);
});

test('SQL and graph nodes are never cards, nor Elasticsearch', async () => {
	const components = [...vectorComponents('qdrant'), { id: 'db_1', provider: 'db_postgres', control: [{ classType: 'tool', from: 'tools_1' }] }, { id: 'graph_1', provider: 'rocketride_graph', control: [{ classType: 'tool', from: 'tools_1' }] }, { id: 'es_1', provider: 'elasticsearch', control: [{ classType: 'tool', from: 'tools_1' }] }];
	const found = await discover(world(projectRows(['ingest_1', 'chat_1', 'tools_1'], components)));
	assert.deepEqual(
		found.map((f) => f.endpoint.nodeId),
		['store_1']
	);
});

test('an older node that does not answer the Vector Explorer tools says it needs an update', async () => {
	const [old] = await discover(world(VX(), fixture('dialect_old_node')));
	const card = vectorCardView(old.endpoint, old.probe);
	assert.deepEqual(card.badge, { variant: 'warning', label: 'Needs upgrade' });
	assert.equal(card.openable, false);
	assert.match(card.blocked ?? '', /does not answer the Vector Explorer tools/);
});

test('flags: Experimental, Empty collection, Repair needed, Metadata column pending', async () => {
	const flags = async (dialect: unknown) => {
		const [f] = await discover(world(VX(), dialect));
		return vectorCardView(f.endpoint, f.probe).flags.map((x) => x.label);
	};
	assert.deepEqual(await flags(fixture('dialect_experimental_milvus')), ['Experimental']);
	assert.deepEqual(await flags(fixture('dialect_collection_missing')), ['Empty collection']);
	assert.deepEqual(await flags(fixture('dialect_repair_needed')), ['Repair needed']);
	assert.deepEqual(await flags(fixture('dialect_meta_pending')), ['Metadata column pending']);
});

test('the drawer: roles, backend, collection, metric, model, index, nodes, writes and support; never the config', async () => {
	const [f] = await discover(world(projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('postgres')), fixture('dialect_pgvector')));
	const drawer = drawerView(f.endpoint, f.probe);
	const value = (label: string) => drawer.rows.find((r) => r.label === label)?.value;
	assert.equal(value('Tools'), 'tools_1');
	assert.equal(value('Backend'), 'pgvector 0.8.0');
	assert.equal(value('Collection'), 'vx_demo_docs');
	assert.equal(value('Metric'), 'cosine');
	assert.equal(value('Model'), 'sentence-transformers/all-MiniLM-L6-v2');
	assert.equal(value('Dimension'), '384');
	assert.equal(value('Index'), 'hnsw (m 16, ef_construction 64)');
	assert.equal(value('Embedding node'), 'Embedding');
	assert.equal(value('LLM node'), 'LLM');
	assert.equal(value('Removing documents'), 'On (allow_writes)');
	assert.equal(value('Support'), 'Supported');
	assert.ok(drawer.notes.includes('Anyone with the data permission on the ingest task can add documents.'));
	assert.ok(!JSON.stringify(drawer).includes(CONFIG_SENTINEL), 'no node configuration reaches the drawer');
	assert.ok(!JSON.stringify(vectorCardView(f.endpoint, f.probe)).includes(CONFIG_SENTINEL));
});

test('rocketride_vector: the drawer says the table is shared by the organization', async () => {
	const dialect = { ...fixture('dialect_pgvector'), provider: 'rocketride_vector', collection: 'vector_explorer_docs' };
	const [f] = await discover(world(projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('rocketride_vector')), dialect));
	assert.ok(drawerView(f.endpoint, f.probe).notes.includes("Shared table: every pipeline in this organization that names table 'vector_explorer_docs' reads and writes these rows."));
	assert.equal(providerTitle('rocketride_vector'), 'RocketRide Vector');
	assert.equal(providerTitle('mongodb+srv'), 'MongoDB Atlas');
	assert.equal(providerTitle('something_new'), 'something_new');
});

test('a pipeline saved without a project id is a single-role card whose drawer says how to group its sources', async () => {
	const rows = projectRows(['tools_1'], vectorComponents('qdrant'), { projectId: null });
	const [f] = await discover(world(rows));
	assert.equal(f.endpoint.projectId, '');
	assert.ok(drawerView(f.endpoint, f.probe).notes.includes(NOT_GROUPED_NOTE));
	assert.equal(NOT_GROUPED_NOTE, 'Other sources not found: save the pipeline with a project id so its sources are grouped.');
});

test('the card key stays the same while the ingest source restarts', async () => {
	const w = world(VX());
	const clock = manualClock();
	const store = makeVectorEndpointStore({ clock, debounceMs: 0 });
	const refresh = async () => {
		const p = store.refresh(w.client);
		await clock.advance(0);
		await p;
		await clock.settle();
	};
	await refresh();
	const key = store.getState().endpoints[0].key;
	w.rows = w.rows.filter((r) => r.source !== 'ingest_1');
	await refresh();
	assert.equal(store.getState().endpoints[0].key, key);
	assert.equal(roleLine(store.getState().endpoints[0]), 'ingest – · chat ✓ · tools ✓');
	w.rows = VX();
	await refresh();
	assert.equal(store.getState().endpoints[0].key, key);
});

test('the landing: discovering, nothing running (with how to start), nothing usable, or the cards', () => {
	assert.equal(landingView('loading', [], null).message?.kind, 'loading');
	const none = landingView('ready', [], null).message!;
	assert.equal(none.kind, 'none-running');
	assert.equal(none.description, 'No running pipeline has a vector store. Start one of the Vector Explorer templates (templates/<store>.pipe) and save it as a project, then refresh.');
	assert.match(none.unknown ?? '', /Elasticsearch and OpenSearch/);
	assert.equal(landingView('error', [], 'socket closed').message?.kind, 'error');
	const stopped = { state: 'stopped' } as IExplorerEndpoint;
	assert.equal(landingView('ready', [stopped], null).message?.kind, 'unreachable');
	assert.equal(landingView('ready', [{ state: 'probing' } as IExplorerEndpoint], null).message, null);
	assert.equal(landingView('ready', [stopped], null).cards, true);
});

test('Test connection, and the drawer closing with a reset', () => {
	assert.match(testResultText(null).text, /^Not tested/);
	assert.equal(testResultText({ ok: true, info: {}, dialect: 'vector' }).text, 'The store node answered.');
	assert.equal(testResultText({ ok: false, info: null, dialect: null, error: { kind: 'raised', message: 'x' } }).variant, 'error');
	assert.equal(drawerKeyAfter('a', [{ key: 'a' } as IExplorerEndpoint]), 'a');
	assert.equal(drawerKeyAfter('a', []), null);
});

test('the console model: nodes, limits, capabilities and why each action is or is not available', async () => {
	const [f] = await discover(world(projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('postgres')), fixture('dialect_pgvector')));
	const model = buildConsoleModel(f.endpoint, f.probe, readStats(fixture('stats_pgvector')));
	assert.equal(model.connectionKey, f.endpoint.key);
	assert.deepEqual(model.nodes, { store: 'store_1', embed: 'embed_1', llm: 'llm_1', llmName: 'LLM' });
	assert.deepEqual(consoleNodes(f.endpoint), model.nodes);
	assert.equal(model.collection, 'vx_demo_docs');
	assert.equal(model.limits.documents_page, 500);
	assert.equal(model.capabilities.remove, true);
	assert.deepEqual(model.writes, { enabled: true, reason: null });
	assert.deepEqual(model.ingest, { enabled: true, reason: null });
	assert.deepEqual(model.chat, { enabled: true, reason: null });
	assert.deepEqual(model.embed, { enabled: true, reason: null });
	assert.equal(model.stats?.documents, 42);
	const off = buildConsoleModel(f.endpoint, { ...f.probe!, info: { ...fixture('dialect_pgvector'), allow_writes: false } }, null);
	assert.deepEqual(off.writes, { enabled: false, reason: CODE_SENTENCES.WRITES_DISABLED });
	const noRemove = buildConsoleModel(f.endpoint, { ...f.probe!, info: { ...fixture('dialect_pgvector'), capabilities: { ...fixture('dialect_pgvector').capabilities, remove: false } } }, null);
	assert.equal(noRemove.writes.enabled, false);
	assert.match(noRemove.writes.reason ?? '', /cannot remove documents/);
	// The trash needs the driver to mark chunks deleted (dialect.capabilities.soft_delete): without it nothing can move there.
	const noTrash = buildConsoleModel(f.endpoint, { ...f.probe!, info: { ...fixture('dialect_pgvector'), capabilities: { ...fixture('dialect_pgvector').capabilities, soft_delete: false } } }, null);
	assert.deepEqual(noTrash.writes, { enabled: false, reason: "This store node cannot move documents to the trash. Update the pipeline's store node to a version that supports Vector Explorer." });
	const unprobed = buildConsoleModel(f.endpoint, undefined, null);
	assert.equal(unprobed.writes.enabled, false, 'nothing is enabled before the node answered');
	// The tools role filled by a source that is not a Tools source (a webhook named tools_1): the node would refuse.
	const webhook = { ...f.endpoint, components: (f.endpoint.components ?? []).map((c) => (c.id === f.endpoint.roles.tools?.source ? { ...c, provider: 'webhook' } : c)) };
	assert.equal(f.endpoint.roles.tools?.source, 'tools_1', 'the premise: the tools role is bound to tools_1');
	assert.deepEqual(buildConsoleModel(webhook, f.probe, null).writes, { enabled: false, reason: CODE_SENTENCES.WRITES_SOURCE });
	const unlisted = { ...f.endpoint, components: (f.endpoint.components ?? []).filter((c) => c.id !== 'tools_1') };
	assert.deepEqual(buildConsoleModel(unlisted, f.probe, null).writes, { enabled: false, reason: CODE_SENTENCES.WRITES_SOURCE }, 'a source the component list does not show is not taken for a Tools source');
	// While a removal runs the trash buttons are disabled and say so; otherwise they follow the model.
	assert.deepEqual(writesDuringRemoval(model.writes, 'running'), { enabled: false, reason: BUSY.removing });
	assert.deepEqual(writesDuringRemoval(model.writes, 'done'), model.writes);
	assert.deepEqual(writesDuringRemoval(off.writes, 'running'), off.writes, 'a reason that already holds is kept');
	assert.equal(unprobed.limits.documents_page, 500, 'documented limits until it does');
});

test('the console model without an ingest or chat source, or without an embedding node the Tools source reaches', async () => {
	const [toolsOnly] = await discover(world(projectRows(['tools_1'], vectorComponents('qdrant'))));
	const model = buildConsoleModel(toolsOnly.endpoint, toolsOnly.probe, null);
	assert.deepEqual(model.ingest, { enabled: false, reason: EMPTY.noIngest });
	assert.deepEqual(model.chat, { enabled: false, reason: EMPTY.noChat });
	const noEmbed = vectorComponents('qdrant').filter((c) => c.id !== 'embed_1');
	const [bare] = await discover(world(projectRows(['ingest_1', 'chat_1', 'tools_1'], noEmbed)));
	assert.deepEqual(buildConsoleModel(bare.endpoint, bare.probe, null).embed, { enabled: false, reason: EMPTY.noEmbed });
	assert.equal(row().pipeline?.components?.[0].provider, 'db_postgres', 'the premise: the default fake row is a SQL node');
});

test('the drawer of a store found empty reads model, dimension and index from fresh stats; a dialect that has them wins', async () => {
	const [f] = await discover(world(projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('postgres')), fixture('dialect_collection_missing')));
	const value = (drawer: ReturnType<typeof drawerView>, label: string) => drawer.rows.find((r) => r.label === label)?.value;
	const before = drawerView(f.endpoint, f.probe);
	assert.deepEqual(['Model', 'Dimension', 'Index'].map((label) => value(before, label)), ['—', '—', '—'], 'nothing known yet');
	const fresh = readStats({ ...fixture('stats_pgvector'), index: { type: 'hnsw', params: { m: 16 } } });
	const after = drawerView(f.endpoint, f.probe, fresh);
	assert.equal(value(after, 'Model'), 'sentence-transformers/all-MiniLM-L6-v2');
	assert.equal(value(after, 'Dimension'), '384');
	assert.equal(value(after, 'Index'), 'hnsw (m 16)');
	const [g] = await discover(world(projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('postgres')), fixture('dialect_pgvector')));
	const probed = drawerView(g.endpoint, g.probe, readStats({ ...fixture('stats_pgvector'), model: 'other/model', dimension: 768 }));
	assert.equal(value(probed, 'Model'), 'sentence-transformers/all-MiniLM-L6-v2');
	assert.equal(value(probed, 'Dimension'), '384');
	assert.equal(value(probed, 'Index'), 'hnsw (m 16, ef_construction 64)');
});
