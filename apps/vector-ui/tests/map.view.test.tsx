// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP VIEW: the Map tab itself, statically rendered (react-dom/server)
// =============================================================================
//
// Effects do not run in a static render, so nothing is sampled, laid out or
// drawn: these pin what the view shows for each state of a connection, from
// the props and the shared selection alone. A drawn sample is put in the
// selection store as the console's map tab would hold it, so the view renders
// its canvas, toolbar, legend and side panel over sample_demo_1000.json and the
// light 5,000-point fixture (the G1 check: data-points equals the points).
//
// The shell's building blocks (EmptyState, Button, Banner) exist only inside a
// running shell; scripts/stub-shell.cjs leaves them out, so this file gives the
// stub plain stand-ins that render their text.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRoleChannel } from 'shared/explorer';
import { recommendExamples } from '../src/adapters/connections';
import { createSelectionStore } from '../src/contract/bridge';
import { EXPORT_COLUMNS } from '../src/contract/types';
import type { ConsoleActions, ConsoleModel, IDialectResult, IExportItem, IRecommendExamples, IRecommendRequest, IRecommendResult, ISampleModel, ISampleResult, ISavedView, ISavedViewRestore, ISavedViewState, IScopeState, ToolOutcome, VectorChannels, VectorKey } from '../src/contract/types';
import { PointCanvas } from '../src/components/PointCanvas';
import { clusterLabel, clusterRows, clusterView } from '../src/map/clusters';
import { spanningTree } from '../src/map/graph';
import { UNSCOPED, clusterExportRows, drawnScope, duplicateExportRows, mapScopeState, pointExportRows, scopeDrawDue } from '../src/map/model';
import { comparePlan } from '../src/map/queryProjection';
import type { ILayoutClient, ILayoutSpec, LayoutOutcome } from '../src/map/workerClient';
import { EDGES_LIGHT_NOTE, MAP_UNAVAILABLE, SCOPE_RETRY, edgeLegend, listingNote, scopeFailedNote, scopeLeftNote, scopeNote, scopePendingNote } from '../src/map/wording';
import type { SideTab } from '../src/views/MapView';
import { deepFreeze, loadSample, modelOf, pcaXY } from './support/map.samples';

// -----------------------------------------------------------------------------
// The props MapView hands its children, captured as it renders them: a static
// render runs no effect and no event, but a captured handler can be called, and
// any tool call it makes reaches the channel synchronously (callTool invokes
// before its first await). That is how "this control calls nothing" is tested.
// -----------------------------------------------------------------------------

const CAPTURED = new Set(['ClustersPanel', 'MapToolbar', 'RecommendPanel', 'SavedViewsMenu', 'ExportMenu', 'SimilarityMatrix', 'PointInspector', 'PointCanvas', 'PointsTable', 'DuplicatesPanel', 'OutliersPanel', 'Legend']);
const captured = new Map<string, Array<Record<string, unknown>>>();
const spies = new Map<string, unknown>();

// The view's layout client, faked: a static render has no worker, and a test
// reads which sample, seed and algorithm each layout run was given.
const layoutRuns: ILayoutSpec[] = [];
let layoutAnswer: (spec: ILayoutSpec) => LayoutOutcome = () => ({ kind: 'unavailable', message: 'No layout worker in a static render.' });
const fakeLayoutClient = (): ILayoutClient => ({
	run: (spec) => {
		layoutRuns.push(spec);
		return Promise.resolve(layoutAnswer(spec));
	},
	cancel: () => undefined,
	dispose: () => undefined,
	busy: false,
});

const loader = Module as unknown as { _load: (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: { filename?: string } | null, isMain: boolean): unknown {
	const loaded = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
	const name = request.split('/').pop() as string;
	if (name === 'workerClient' && parent?.filename && /views[\\/]MapView\.tsx$/.test(parent.filename)) return { ...loaded, createLayoutClient: fakeLayoutClient };
	if (!CAPTURED.has(name) || !parent?.filename || !/views[\\/]MapView\.tsx$/.test(parent.filename)) return loaded;
	let spy = spies.get(name);
	if (!spy) {
		const Real = loaded[name] as React.ComponentType<Record<string, unknown>>;
		const Spy = (props: Record<string, unknown>): React.ReactElement => {
			captured.set(name, [...(captured.get(name) ?? []), props]);
			return React.createElement(Real, props);
		};
		spy = { ...loaded, [name]: Spy, default: Spy };
		spies.set(name, spy);
	}
	return spy;
};
const { MapView } = require('../src/views/MapView') as typeof import('../src/views/MapView');

/** The props of the last render of a child. */
function last<T = Record<string, unknown>>(name: string): T {
	const list = captured.get(name) ?? [];
	assert.ok(list.length > 0, `${name} was rendered`);
	return list[list.length - 1] as T;
}

const shell = require('shell') as Record<string, unknown>;
shell.EmptyState ??= (p: { title: string; description?: string; action?: React.ReactNode }) => (
	<div data-empty-state="">
		<h3>{p.title}</h3>
		<p>{p.description}</p>
		{p.action}
	</div>
);
shell.Button ??= (p: { children?: React.ReactNode }) => <button type="button">{p.children}</button>;
shell.Banner ??= (p: { children?: React.ReactNode }) => <div role="alert">{p.children}</div>;

const FIX = path.resolve(__dirname, 'fixtures', 'provisional');
const dialect = JSON.parse(fs.readFileSync(path.join(FIX, 'dialect_pgvector.json'), 'utf8')) as IDialectResult;
const noop = (): void => undefined;
const KEY = 'conn-1';

/** A connection's console model over the pgvector dialect fixture. */
function modelWith(extra: Partial<ConsoleModel> = {}): ConsoleModel {
	const on = { enabled: true, reason: null };
	return {
		connectionKey: KEY,
		connection: { endpoint: {} as ConsoleModel['connection']['endpoint'], dialect },
		nodes: { store: 'store_1', embed: 'embed_1', llm: null, llmName: null },
		collection: dialect.collection,
		stats: null,
		limits: dialect.limits,
		capabilities: dialect.capabilities,
		writes: on,
		ingest: on,
		chat: on,
		embed: on,
		readOnly: false,
		...extra,
	};
}

/** A Tools channel that answers nothing (no effect runs in a static render). */
const tools = { invoke: () => new Promise<never>(() => undefined) } as unknown as IRoleChannel;
const channels: VectorChannels = { tools, chat: null, ingest: null };
const actions: ConsoleActions = { openDocument: noop, showOnMap: noop, requestRemove: noop, askAbout: noop, documentsChanged: noop, announce: noop };

/** The Map tab, statically rendered. */
function render(opts: { model?: ConsoleModel; channels?: VectorChannels; sample?: ISampleModel | null; selectionKey?: string; initialTable?: boolean; initialTab?: SideTab; extra?: Partial<React.ComponentProps<typeof MapView>>; selection?: ReturnType<typeof createSelectionStore>; actions?: ConsoleActions } = {}): string {
	const selection = opts.selection ?? createSelectionStore(opts.selectionKey ?? KEY);
	if (opts.sample) selection.setSampleModel(opts.sample);
	captured.clear();
	return renderToStaticMarkup(<MapView model={opts.model ?? modelWith()} channels={opts.channels ?? channels} selection={selection} actions={opts.actions ?? actions} visible initialTable={opts.initialTable} initialTab={opts.initialTab} {...(opts.extra ?? {})} />);
}

/** The value of `attr` on the first element with class `cls`. */
function attrOf(out: string, cls: string, attr: string): string | null {
	const tag = new RegExp(`<[a-z]+[^>]*class="${cls}"[^>]*>`).exec(out);
	const m = tag ? new RegExp(`${attr}="([^"]*)"`).exec(tag[0]) : null;
	return m ? (m[1] as string) : null;
}

test('a store that cannot sample has no map, and says so (the console is unaffected)', () => {
	const out = render({ model: modelWith({ capabilities: { ...dialect.capabilities, sample: false } }) });
	assert.equal(attrOf(out, 'vector-map', 'data-map-state'), 'unavailable');
	assert.ok(out.includes(MAP_UNAVAILABLE));
	assert.doesNotMatch(out, /data-points=/);
});

test('no running source reaches the store: the map says which source to start', () => {
	const out = render({ channels: { tools: null, chat: null, ingest: null } });
	assert.equal(attrOf(out, 'vector-map', 'data-map-state'), 'unreachable');
	assert.match(out, /Start the pipeline&#x27;s Tools source \(or its Chat source\)/);
});

test('before the first sample: an empty state with "Draw sample" (the first open samples by itself once it is visible)', () => {
	const out = render();
	assert.equal(attrOf(out, 'vector-map', 'data-map-state'), 'empty');
	assert.match(out, /No sample drawn yet/);
	assert.match(out, /<button[^>]*>Draw sample<\/button>/);
	// A sample of another connection is not this map's.
	const other = render({ sample: modelOf(loadSample('sample_demo_1000.json')), selectionKey: 'conn-2' });
	assert.equal(attrOf(other, 'vector-map', 'data-map-state'), 'empty');
});

test('with sample_demo_1000.json drawn: the canvas has data-points 1000 on PCA, the toolbar, legend and Point tab around it', () => {
	const out = render({ sample: modelOf(loadSample('sample_demo_1000.json')) });
	assert.equal(attrOf(out, 'vector-map', 'data-map-state'), 'ready');
	assert.equal(attrOf(out, 'vector-map', 'data-sample-mode'), 'detailed');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-points'), '1000');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-mode'), 'detailed');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-layout'), 'pca');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-selection'), '');
	assert.match(out, /role="toolbar" aria-label="Map controls"/);
	assert.match(out, /of 1,318 chunks · 42 docs · seed 7/);
	assert.match(out, /aria-label="Map legend"/);
	assert.match(out, /Showing 1,000 of 1,318 chunks/);
	assert.match(out, /role="tab" aria-selected="true"[^>]*>Point</);
	assert.match(out, /Click a point or use the arrow keys/);
});

test('with the light 5,000-point fixture drawn: data-points 5000 in light mode, t-SNE refused with its reason, the placement note shown', () => {
	const out = render({ sample: modelOf(loadSample('sample_light_5000.json')) });
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-points'), '5000');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-mode'), 'light');
	assert.match(out, /<option value="tsne" disabled=""/);
	assert.match(out, /t-SNE is limited to 1,000 points; this sample has 5,000\./);
	assert.match(out, /Light sample: positions are rounded to 0\.01/);
});

test('with the Table on, the canvas stays mounted but hidden: data-points and data-selected sit beside the table, and nothing is drawn', () => {
	const sample = modelOf(loadSample('sample_demo_1000.json'));
	const out = render({ sample, initialTable: true });
	assert.match(out, /<caption[^>]*>Points of the sample \(the map as a table\)<\/caption>/);
	assert.match(out, /aria-pressed="true"[^>]*>Table<\/button>/);
	// The lanes read the canvas root while the table shows (lane_vector_map.cjs polls data-selected after "Inspect point 1").
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-points'), '1000');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-selected'), '');
	// Hidden under the table: display none, and no drawing context is created for it.
	assert.match(out, /<div style="display:none;[^"]*"><div[^>]*class="vector-map-canvas"/);
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-renderer'), 'pending');
	// Table off: the same canvas is shown and the table is gone.
	const off = render({ sample });
	assert.match(off, /<div style="display:flex;[^"]*"><div[^>]*class="vector-map-canvas"/);
	assert.doesNotMatch(off, /Points of the sample/);
});

test('a hidden canvas still carries the inspected point: data-selected is rendered from the overlay, not by a frame', () => {
	const sample = modelOf(loadSample('sample_demo_1000.json'));
	const out = renderToStaticMarkup(
		<div style={{ display: 'none' }}>
			<PointCanvas sample={sample} positions={new Float32Array(2 * sample.result.n)} dimensions={2} colours={[]} overlay={{ selected: 0, focused: 0 }} visible={false} selection={createSelectionStore(KEY)} lasso={false} onHover={noop} onPick={noop} onLasso={noop} />
		</div>
	);
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-selected'), '0');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-focused'), '0');
	assert.equal(attrOf(out, 'vector-map-canvas', 'data-renderer'), 'pending');
});

test('the Clusters tab holds the ClustersPanel, and the toolbar offers Edges: None (the default), Neighbours and Tree', () => {
	const out = render({ sample: modelOf(loadSample('sample_demo_1000.json')), initialTab: 'clusters' });
	assert.match(out, /role="tab" aria-selected="true"[^>]*>Clusters</);
	const at = out.search(/<[a-z]+[^>]*data-component="ClustersPanel"/);
	assert.ok(at >= 0, 'the panel is mounted in its tab');
	assert.doesNotMatch(out.slice(at, out.indexOf('>', at)), /data-placeholder/, 'the panel is built');
	assert.match(out, /<select aria-label="Edges"[^>]*>/);
	assert.match(out, /<option value="none" selected="">None<\/option><option value="neighbours">Neighbours<\/option><option value="tree">Tree<\/option>/);
});

// -----------------------------------------------------------------------------
// Clusters, edges, colouring and isolation: computed here, never a call
// -----------------------------------------------------------------------------

const clustered = deepFreeze(JSON.parse(fs.readFileSync(path.join(FIX, 'sample_demo_1000_clusters.json'), 'utf8')) as ISampleResult);
const enriched = JSON.parse(fs.readFileSync(path.join(FIX, 'dialect_enriched.json'), 'utf8')) as IDialectResult;

/** A Tools channel that records every call and answers from `answers` (by tool), or never. */
function counting(answers: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
	const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
	const channel = {
		invoke: (tool: string, input: Record<string, unknown>) => {
			calls.push({ tool, input });
			const answer = answers[tool];
			return answer ? Promise.resolve(answer(input)) : new Promise<never>(() => undefined);
		},
	} as unknown as IRoleChannel;
	return { calls, channels: { tools: channel, chat: null, ingest: null } as VectorChannels };
}

/** Actions that record what was announced and asked. */
function recording() {
	const announced: string[] = [];
	const askedAbout: Array<readonly string[]> = [];
	const removed: Array<readonly string[]> = [];
	const recorded: ConsoleActions = { ...actions, announce: (text) => announced.push(text), askAbout: (ids) => askedAbout.push(ids), requestRemove: (ids) => removed.push(ids) };
	return { announced, askedAbout, removed, actions: recorded };
}

/** A model over the enriched dialect (clusters offered), optionally scoped. */
function enrichedModel(extra: Partial<ConsoleModel> = {}): ConsoleModel {
	return modelWith({ capabilities: { ...enriched.capabilities }, limits: { ...dialect.limits, ...enriched.limits }, ...extra });
}

test('changing the Minimum size refolds the clusters in the browser: more rows at 2 than at 5, and no call on the channel', () => {
	const { calls, channels: counted } = counting();
	const sample = modelOf(clustered);
	const groupsAt = (min: 2 | 5 | 10): number => {
		const out = render({ model: enrichedModel(), channels: counted, sample, initialTab: 'clusters', extra: { initialMinClusterSize: min } });
		return Number(/data-component="ClustersPanel" data-clusters="(\d+)"/.exec(out)?.[1]);
	};
	const at5 = groupsAt(5);
	const at2 = groupsAt(2);
	const at10 = groupsAt(10);
	assert.ok(at2 > at5 && at5 > at10, `${at2} > ${at5} > ${at10}`);
	assert.equal(at2, clustered.clusters?.count);
	// The panel's own control, as the view wired it: a fold, an announcement, nothing sent.
	const rec = recording();
	render({ model: enrichedModel(), channels: counted, sample, initialTab: 'clusters', actions: rec.actions });
	const panel = last<{ onMinSize(size: 2 | 5 | 10): void; minSize: number }>('ClustersPanel');
	assert.equal(panel.minSize, 5, 'the default minimum size is 5');
	panel.onMinSize(2);
	panel.onMinSize(10);
	assert.deepEqual(calls, [], 'no tool was called');
	assert.match(rec.announced.join(' '), new RegExp(`Clusters of at least 2 points: ${at2} clusters`));
});

test('Document is the default colouring; Cluster is offered with clusters and disabled with its sentence on an older node', () => {
	const withClusters = render({ model: enrichedModel(), sample: modelOf(clustered) });
	assert.match(withClusters, /data-colour-by="document"/);
	assert.match(withClusters, /<optgroup label="Content">[\s\S]*<optgroup label="Document">[\s\S]*<optgroup label="Analysis">/);
	assert.match(withClusters, /<option value="cluster">Cluster<\/option>/);
	const old = render({ sample: modelOf(loadSample('sample_demo_1000.json')) });
	assert.match(old, /<option value="cluster" disabled="" title="This store node does not compute clusters; update the node.">Cluster<\/option>/);
	// Coloured by cluster: the legend says what a cluster is, the tab's rows carry the node's terms.
	const rec = recording();
	const coloured = render({ model: enrichedModel(), sample: modelOf(clustered), actions: rec.actions, extra: { initialColourBy: 'cluster' } });
	assert.match(coloured, /Clusters: connected groups of the sample&#x27;s neighbour graph above similarity 0\.70 \(the 60th percentile of its edges, computed by the store node\), groups of at least 5 points/);
	// Choosing Cluster announces the groups (no call).
	last<{ onColourBy(by: string): void }>('MapToolbar').onColourBy('cluster');
	assert.match(rec.announced.join(' '), /^Coloured by cluster: \d+ clusters, \d+ unassigned points\.$/);
});

test('edges: Tree draws the spanning tree (n-1 edges on a connected graph), Neighbours at most m*n, light samples above 3,000 points 3 per point; the controls call nothing', () => {
	const { calls, channels: counted } = counting();
	const demo = modelOf(loadSample('sample_demo_1000.json'));
	const attr = (out: string, name: string): string => new RegExp(`class="vector-map"[^>]*${name}="([^"]*)"`).exec(out)?.[1] ?? '';
	const treeOut = render({ channels: counted, sample: demo, extra: { edges: 'tree' } });
	const tree = spanningTree(demo.result.knn, demo.result.n);
	assert.equal(Number(attr(treeOut, 'data-edge-count')), demo.result.n - tree.components);
	assert.match(treeOut, /Spanning tree: the strongest path/);
	const five = render({ channels: counted, sample: demo, extra: { edges: 'neighbours', edgesM: 5 } });
	assert.ok(Number(attr(five, 'data-edge-count')) <= 5 * demo.result.n);
	assert.equal(attr(five, 'data-edges-per-point'), '5');
	assert.match(five, /Neighbour edges: each point&#x27;s 5 strongest/);
	const light = render({ channels: counted, sample: modelOf(loadSample('sample_light_5000.json')), extra: { edges: 'neighbours', edgesM: 10 } });
	assert.equal(attr(light, 'data-edges-per-point'), '3');
	assert.ok(light.includes(EDGES_LIGHT_NOTE));
	assert.match(light, /<option value="10" disabled="" title="Light samples above 3,000 points draw at most 3 edges per point">10<\/option>/);
	// The toolbar's edge controls, as the view wired them: nothing is sent.
	render({ channels: counted, sample: demo });
	const toolbar = last<{ onEdges(m: string): void; onEdgesM(m: number): void; onExpandSelected(): void; expandReason: string | null }>('MapToolbar');
	toolbar.onEdges('tree');
	toolbar.onEdges('neighbours');
	toolbar.onEdgesM(10);
	toolbar.onExpandSelected();
	assert.equal(toolbar.expandReason, 'Select a point first');
	assert.deepEqual(calls, []);
	// The canvas gets the edge set and the perf lane's switch (default on).
	assert.equal((last<{ edges: { count: number } | null }>('PointCanvas').edges), null, 'no edges by default');
	const off = render({ sample: demo, extra: { edges: 'tree', edgesAutoDegrade: false } });
	assert.equal(last<{ edges: { count: number } }>('PointCanvas').edges.count, demo.result.n - tree.components);
	// The perf lane reads whether the switch was off and whether the map degraded while it measured.
	assert.equal(attr(off, 'data-edges-auto-degrade'), 'off');
	assert.equal(attr(off, 'data-edges-degraded'), '0');
	assert.equal(attr(treeOut, 'data-edges-auto-degrade'), 'on');
});

// -----------------------------------------------------------------------------
// The console's scope on the map: the legend and data-scoped state the scope
// the points on screen were drawn with, never only the one the console holds.
// -----------------------------------------------------------------------------

/** Let the calls a captured handler started settle (the counting channel answers on the microtask queue). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** An attribute of the map's root. */
const rootAttr = (out: string, name: string): string | null => attrOf(out, 'vector-map', name);

/** A scope over the first `count` documents of the clusters fixture, applied to the map. */
function scopeOver(count: number, folder = 'C:/demo/field/'): IScopeState {
	const ids = clustered.docs.slice(0, count).map((d) => d.objectId);
	return { filter: { path_prefix: folder }, label: `folder is under ${folder}`, objectIds: ids, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } };
}

/** A fresh answer object (the view keeps what it drew each answer with beside the answer itself). */
const answerOf = (sampleId: string): ISampleResult => ({ ...clustered, sample_id: sampleId }) as ISampleResult;

type ToolbarSample = { onSample(o: { n: number; mode: 'detailed'; seed: number }): void };

test('a scope applied to the map is sent with the sample, the neighbours and recommend; the legend states it only once a sample drawn with it is shown', async () => {
	const scope = scopeOver(5);
	const ids = scope.objectIds!;
	const { calls, channels: counted } = counting({ sample: () => answerOf('s-8-scoped'), recommend: () => JSON.parse(fs.readFileSync(path.join(FIX, 'recommend_ok.json'), 'utf8')) });
	const selection = createSelectionStore(KEY);
	// The sample on screen was drawn before the console scoped the map: the legend says it is being drawn again.
	const before = render({ model: enrichedModel({ scope }), channels: counted, sample: modelOf(answerOf('s-7-unscoped')), selection, initialTable: true, initialTab: 'recommend' });
	assert.doesNotMatch(before, /the sample is drawn from these only/, 'no sample was drawn with this scope');
	assert.ok(before.includes(scopePendingNote(scope.label, 5)));
	assert.equal(rootAttr(before, 'data-scoped'), '', 'the points shown were drawn from the whole collection');
	assert.equal(rootAttr(before, 'data-scope-state'), 'pending');
	assert.equal(last<{ scopeRetry?: unknown }>('Legend').scopeRetry ?? null, null, 'nothing to retry while the draw is due');
	last<ToolbarSample>('MapToolbar').onSample({ n: 1000, mode: 'detailed', seed: 8 });
	const sampled = calls.find((c) => c.tool === 'sample');
	assert.deepEqual(sampled?.input.filter, { object_ids: ids });
	assert.deepEqual(sampled?.input.cluster, { method: 'knn-components', labels: true }, 'clusters are asked of a node that offers them');
	await settle();
	assert.equal(selection.getState().sampleModel?.sampleId, 's-8-scoped', 'the scoped answer is the sample shown');
	const out = render({ model: enrichedModel({ scope }), channels: counted, selection, initialTable: true, initialTab: 'recommend' });
	assert.match(out, /Scope: folder is under C:\/demo\/field\/ \(5 documents\); the sample is drawn from these only/);
	assert.equal(rootAttr(out, 'data-scoped'), '5');
	assert.equal(rootAttr(out, 'data-scope-state'), 'applied');
	last<{ onSelect(i: number): void }>('PointsTable').onSelect(3);
	const neighbours = calls.find((c) => c.tool === 'neighbors');
	assert.deepEqual(neighbours?.input.filter, { object_ids: ids });
	const request: IRecommendRequest = { positive: [[clustered.docs[0]!.objectId, 0]], negative: [[clustered.docs[1]!.objectId, 2]], withQuery: true, k: 12, strategy: 'average_vector' };
	const outcome = await last<{ onRun(r: IRecommendRequest): Promise<ToolOutcome<IRecommendResult>> }>('RecommendPanel').onRun(request);
	assert.equal(outcome.ok, true);
	const recommend = calls.find((c) => c.tool === 'recommend');
	assert.deepEqual(recommend?.input, { positive: request.positive, negative: request.negative, vector: null, k: 12, strategy: 'average_vector', exclude_examples: true, filter: { object_ids: ids } }, 'keys only: no query was run, so no vector');
	// Unscoped (or a scope too large for the map): no filter, and an older node is not asked for clusters.
	const plain = counting();
	render({ channels: plain.channels, sample: modelOf(clustered), model: modelWith({ scope: { ...scope, overflow: 2340, objectIds: null } }) });
	last<{ onSample(o: { n: number; mode: 'detailed'; seed: number }): void }>('MapToolbar').onSample({ n: 1000, mode: 'detailed', seed: 8 });
	assert.equal(plain.calls[0]?.input.filter, undefined);
	assert.equal(plain.calls[0]?.input.cluster, undefined);
});

test('a refused scoped draw is never captioned as scoped: the legend says the scope is not applied and offers the draw again, which sends the scope again', async () => {
	const scope = scopeOver(2, 'C:/demo/x/');
	let refuse = true;
	const { calls, channels: counted } = counting({ sample: () => (refuse ? { success: false, code: 'BUSY', error: 'Another sample is being drawn.' } : answerOf('s-9-retried')) });
	const selection = createSelectionStore(KEY);
	render({ model: enrichedModel({ scope }), channels: counted, sample: modelOf(answerOf('s-7-unscoped')), selection });
	last<ToolbarSample>('MapToolbar').onSample({ n: 1000, mode: 'detailed', seed: 7 });
	await settle();
	assert.equal(selection.getState().sampleModel?.sampleId, 's-7-unscoped', 'the store refused: the unscoped sample stays on screen');
	const failed = render({ model: enrichedModel({ scope }), channels: counted, selection });
	assert.doesNotMatch(failed, /the sample is drawn from these only/);
	assert.ok(failed.includes(scopeFailedNote(scope.label, 2)), 'the legend says the scope is not applied');
	assert.equal(rootAttr(failed, 'data-scoped'), '');
	assert.equal(rootAttr(failed, 'data-scope-state'), 'failed');
	assert.match(failed, new RegExp(`<button[^>]*data-scope-retry=""[^>]*>${SCOPE_RETRY}</button>`));
	const legend = last<{ scopeRetry?: { label: string; onClick(): void } | null }>('Legend');
	assert.equal(legend.scopeRetry?.label, SCOPE_RETRY);
	// The store is free again: the legend's action draws the sample with the scope.
	refuse = false;
	legend.scopeRetry!.onClick();
	await settle();
	const draws = calls.filter((c) => c.tool === 'sample');
	assert.equal(draws.length, 2);
	assert.deepEqual(draws[1]?.input.filter, { object_ids: scope.objectIds });
	assert.equal(selection.getState().sampleModel?.sampleId, 's-9-retried');
	const applied = render({ model: enrichedModel({ scope }), channels: counted, selection });
	assert.ok(applied.includes(scopeNote(scope.label, 2)));
	assert.equal(rootAttr(applied, 'data-scoped'), '2');
	assert.equal(rootAttr(applied, 'data-scope-state'), 'applied');
	assert.doesNotMatch(applied, /data-scope-retry/);
});

test('an older draw refused after a newer one started does not mark the scope failed: the legend follows the newest draw', async () => {
	const scope = scopeOver(4);
	const answers: Array<(value: unknown) => void> = [];
	const tools = { invoke: (tool: string) => (tool === 'sample' ? new Promise((resolve) => answers.push(resolve)) : new Promise<never>(() => undefined)) } as unknown as IRoleChannel;
	const ordered: VectorChannels = { tools, chat: null, ingest: null };
	const selection = createSelectionStore(KEY);
	render({ model: enrichedModel({ scope }), channels: ordered, sample: modelOf(answerOf('s-7-shown')), selection });
	const toolbar = last<ToolbarSample>('MapToolbar');
	toolbar.onSample({ n: 1000, mode: 'detailed', seed: 8 });
	toolbar.onSample({ n: 1000, mode: 'detailed', seed: 9 });
	assert.equal(answers.length, 2, 'two draws in flight');
	answers[0]!({ success: false, code: 'BUSY', error: 'Another sample is being drawn.' });
	await settle();
	const meanwhile = render({ model: enrichedModel({ scope }), channels: ordered, selection });
	assert.equal(rootAttr(meanwhile, 'data-scope-state'), 'pending', 'the newer draw is still in flight');
	assert.doesNotMatch(meanwhile, /data-scope-retry/);
	answers[1]!(answerOf('s-9-newest'));
	await settle();
	const done = render({ model: enrichedModel({ scope }), channels: ordered, selection });
	assert.equal(selection.getState().sampleModel?.sampleId, 's-9-newest');
	assert.equal(rootAttr(done, 'data-scope-state'), 'applied');
	assert.equal(rootAttr(done, 'data-scoped'), '4');
});

test('a sample drawn with a scope the console then cleared says its points are from that scope only until the whole collection is drawn', async () => {
	const scope = scopeOver(3);
	const selection = createSelectionStore(KEY);
	const { channels: counted } = counting({ sample: () => answerOf('s-8-three') });
	render({ model: enrichedModel({ scope }), channels: counted, sample: modelOf(answerOf('s-7-before')), selection });
	last<ToolbarSample>('MapToolbar').onSample({ n: 1000, mode: 'detailed', seed: 8 });
	await settle();
	const cleared = render({ model: enrichedModel(), channels: counted, selection });
	assert.equal(rootAttr(cleared, 'data-scoped'), '3', 'the points shown are still the scoped sample');
	assert.equal(rootAttr(cleared, 'data-scope-state'), 'pending');
	assert.ok(cleared.includes(scopeLeftNote(scope.label, 3, false)));
	assert.doesNotMatch(cleared, /the sample is drawn from these only/);
	// Back to the same scope: the sample on screen was drawn with it.
	const again = render({ model: enrichedModel({ scope }), channels: counted, selection });
	assert.equal(rootAttr(again, 'data-scope-state'), 'applied');
});

test('the scope rule: the map draws once per scope (never again while that draw is pending or after the store refused it) and captions only the scope it drew with', () => {
	const a = '2:doc-a|doc-b';
	const b = '1:doc-c';
	const drawnA = { drawn: drawnScope(['doc-a', 'doc-b'], 'folder a'), attempt: null };
	assert.equal(drawnA.drawn.key, a);
	assert.deepEqual(drawnScope(null, 'x'), UNSCOPED);
	assert.deepEqual(drawnScope([], 'x'), UNSCOPED);
	const unscoped = { drawn: UNSCOPED, attempt: null };
	// Nothing to do: drawn with the scope the console holds.
	assert.equal(scopeDrawDue('', unscoped), false);
	assert.equal(scopeDrawDue(a, drawnA), false);
	assert.equal(mapScopeState('', unscoped), 'none');
	assert.equal(mapScopeState(a, drawnA), 'applied');
	// A new scope: a draw is due and the caption says it is pending until it lands.
	assert.equal(scopeDrawDue(a, unscoped), true);
	assert.equal(mapScopeState(a, unscoped), 'pending');
	assert.equal(scopeDrawDue('', drawnA), true, 'a cleared scope draws the whole collection again');
	// In flight: not again (the effect runs again on every busy change).
	const inFlight = { drawn: UNSCOPED, attempt: { key: a, failed: false } };
	assert.equal(scopeDrawDue(a, inFlight), false);
	assert.equal(mapScopeState(a, inFlight), 'pending');
	// Refused: not again by itself (a busy store would be asked in a loop); the legend offers the draw.
	const refused = { drawn: UNSCOPED, attempt: { key: a, failed: true } };
	assert.equal(scopeDrawDue(a, refused), false);
	assert.equal(mapScopeState(a, refused), 'failed');
	// Another scope meanwhile: due again, whatever happened to the last one.
	assert.equal(scopeDrawDue(b, refused), true);
	assert.equal(mapScopeState(b, refused), 'pending');
	assert.equal(mapScopeState(b, inFlight), 'pending');
});

test('the toolbar\'s Export items: the sample, the selection, the points shown, the clusters, duplicates, outliers and the PNG; rows carry words and numbers, never a vector', () => {
	const selection = createSelectionStore(KEY);
	const keys = [0, 1, 2].map((i) => [clustered.docs[clustered.points.doc[i] as number]!.objectId, clustered.points.chunk[i] as number] as VectorKey);
	selection.setHighlight({ source: 'lasso', keys });
	render({ model: enrichedModel(), sample: modelOf(clustered), selection });
	const items = last<{ items: IExportItem[] }>('ExportMenu').items;
	assert.deepEqual(items.map((i) => i.id), ['map-points', 'map-selection', 'map-visible', 'map-clusters', 'map-duplicates', 'map-outliers', 'map-png']);
	const byId = new Map(items.map((i) => [i.id, i]));
	assert.equal(byId.get('map-selection')?.label, 'Lasso selection (3 points)');
	const rows = byId.get('map-selection')!.rows!();
	assert.deepEqual(rows.columns, EXPORT_COLUMNS.points);
	assert.deepEqual(rows.rows.map((r) => [r.objectId, r.chunkId]), keys);
	const folded = clusterView(clustered.clusters!, 5);
	rows.rows.forEach((row, r) => {
		const g = folded.labels[r] as number;
		assert.equal(row.cluster, g >= 0 ? g + 1 : null, 'the cluster as the map shows it (folded by the minimum size)');
	});
	const all = byId.get('map-points')!.rows!();
	assert.equal(all.rows.length, clustered.n);
	const json = JSON.stringify(all.rows);
	assert.doesNotMatch(json, /\[(-?\d+\.\d+,){7,}/, 'no numeric array of 8 or more floats');
	assert.equal(byId.get('map-clusters')?.disabled, null);
	assert.ok((byId.get('map-clusters')!.rows!().rows.length) > 0);
	assert.equal(byId.get('map-png')?.disabled, 'The map is not drawn right now.', 'no renderer in a static render');
	assert.equal(typeof byId.get('map-png')?.png, 'function');
	// Nothing selected: the item says so.
	render({ model: enrichedModel(), sample: modelOf(clustered) });
	assert.equal(new Map(last<{ items: IExportItem[] }>('ExportMenu').items.map((i) => [i.id, i])).get('map-selection')?.disabled, 'Nothing selected');
});

test('saved views: captured without a vector; applied by drawing the seed again with at most 200 pinned keys, restoring the selection by key and pinning at most 200 absent keys hollow', async () => {
	const selection = createSelectionStore(KEY);
	const present = Array.from({ length: 150 }, (_, i) => [clustered.docs[clustered.points.doc[i] as number]!.objectId, clustered.points.chunk[i] as number] as VectorKey);
	const absent = Array.from({ length: 1850 }, (_, i) => [`not-in-sample-${i}`, 0] as VectorKey);
	selection.setHighlight({ source: 'lasso', keys: [...present, ...absent] });
	const { calls, channels: counted } = counting({
		sample: () => clustered,
		project: (input) => ({ success: true, items: (input.keys as VectorKey[]).map((key) => ({ key, pca: [0, 0, 0], neighbors: [], in_sample: null })) }),
	});
	render({ model: enrichedModel(), channels: counted, sample: modelOf(clustered), selection, extra: { initialColourBy: 'cluster', edges: 'tree' } });
	const menu = last<{ current(): ISavedViewState | null; onApply(v: ISavedView): Promise<ISavedViewRestore | null> }>('SavedViewsMenu');
	const view = menu.current();
	assert.ok(view);
	assert.equal(view.seed, 7);
	assert.equal(view.colourBy, 'cluster');
	assert.equal(view.edges, 'tree');
	assert.equal(view.minClusterSize, 5);
	assert.equal(view.selection.length, 2000, 'at most scope_keys_max keys');
	assert.doesNotMatch(JSON.stringify(view), /\[(-?\d+\.\d+,){7,}/, 'no vector in a saved view');
	const restore = await menu.onApply({ ...view, id: 'v1', name: 'dupes', savedAt: 0 });
	const sampleCall = calls.find((c) => c.tool === 'sample');
	assert.equal((sampleCall?.input.include_keys as VectorKey[]).length, 200, 'include_keys never exceeds project_keys_max');
	assert.equal(sampleCall?.input.seed, 7);
	const projectCall = calls.find((c) => c.tool === 'project');
	assert.equal((projectCall?.input.keys as VectorKey[]).length, 200, 'at most 200 absent keys are pinned');
	assert.deepEqual(restore, { selected: 2000, restored: 150, hollow: 200, dropped: 1650 });
	assert.equal(selection.getState().keys.length, 150, 'the selection is restored by key lookup');
	assert.equal(selection.getState().sampleModel?.pinned.length, 200);
});

// -----------------------------------------------------------------------------
// Saved views with a refined layout: the run lays out the sample drawn for the
// view. A static render never re-renders, so the handler captured here holds
// the render before Apply, as a real map's does until the drawn sample lands.
// -----------------------------------------------------------------------------

type SavedViews = { current(): ISavedViewState | null; onApply(v: ISavedView): Promise<ISavedViewRestore | null> };

/** The sample a saved view draws (another id than the fixtures' s-7-c6774b86). */
const drawnForView = { ...clustered, sample_id: 's-9-fresh' } as ISampleResult;

/** A saved view over `layout` with seed 9 and no selection. */
function savedView(layout: ISavedView['layout'], selection: readonly VectorKey[] = []): ISavedView {
	return { n: 1000, mode: 'detailed', seed: 9, layout, colourBy: 'document', edges: 'none', edgesM: 5, minClusterSize: 5, query: null, scopeFilterId: null, selection, camera: null, id: `v-${layout}`, name: layout, savedAt: 0 };
}

/** Run `body` with layout runs answered as finished (kNN overlap above PCA's), then put the fake back. */
async function withLayoutsDone(body: () => Promise<void>): Promise<void> {
	layoutRuns.length = 0;
	layoutAnswer = (spec) => ({ kind: 'done', result: { type: 'result', requestId: 1, algorithm: spec.algorithm, positions: new Float32Array(spec.sample.n * 2), ticks: 1, total: 1, elapsedMs: 1, timedOut: false, overlap: 0.8, pcaOverlap: 0.5 } });
	try {
		await body();
	} finally {
		layoutAnswer = () => ({ kind: 'unavailable', message: 'No layout worker in a static render.' });
		layoutRuns.length = 0;
	}
}

test('a saved view with the neighbour graph layout lays out the sample drawn for the view, not the one shown before Apply', () =>
	withLayoutsDone(async () => {
		const before = modelOf(loadSample('sample_demo_1000.json'));
		assert.notEqual(before.sampleId, drawnForView.sample_id, 'the view draws another sample than the one shown');
		const rec = recording();
		const selection = createSelectionStore(KEY);
		const { calls, channels: counted } = counting({ sample: () => drawnForView });
		render({ model: enrichedModel(), channels: counted, sample: before, selection, actions: rec.actions });
		const restore = await last<SavedViews>('SavedViewsMenu').onApply(savedView('neighbour-graph'));
		assert.ok(restore, 'the view was applied');
		assert.equal(calls.filter((c) => c.tool === 'sample').length, 1);
		assert.equal(selection.getState().sampleModel?.sampleId, drawnForView.sample_id, 'the drawn sample is the one shown');
		assert.equal(layoutRuns.length, 1, 'the saved layout runs once');
		assert.equal(layoutRuns[0]?.sample.sample_id, drawnForView.sample_id, 'over the sample drawn for the view (its id is what the refined positions are kept under)');
		assert.equal(layoutRuns[0]?.sample.n, drawnForView.n);
		assert.equal(layoutRuns[0]?.algorithm, 'force');
		assert.equal(layoutRuns[0]?.seed, 9, "with the view's seed");
		assert.equal(layoutRuns[0]?.hidden, null, 'a new sample hides nothing');
		assert.match(rec.announced.join(' '), /Neighbour graph layout ready/);
	}));

test('a saved view applied on an empty map (no sample yet) still restores its layout, here t-SNE, over the drawn sample', () =>
	withLayoutsDone(async () => {
		const selection = createSelectionStore(KEY);
		render({ model: enrichedModel(), channels: counting({ sample: () => drawnForView }).channels, selection });
		const menu = last<SavedViews>('SavedViewsMenu');
		assert.equal(menu.current(), null, 'nothing to save without a sample, but the Views menu is offered');
		await menu.onApply(savedView('tsne'));
		assert.equal(layoutRuns.length, 1, 'the saved layout is restored on an empty map too');
		assert.equal(layoutRuns[0]?.sample.sample_id, drawnForView.sample_id);
		assert.equal(layoutRuns[0]?.algorithm, 'tsne');
	}));

test('a saved view lays out nothing when another sample replaced its own while the absent keys were pinned, or when it was saved on PCA', () =>
	withLayoutsDone(async () => {
		const before = modelOf(loadSample('sample_demo_1000.json'));
		const selection = createSelectionStore(KEY);
		const { calls, channels: counted } = counting({
			sample: () => drawnForView,
			project: () => {
				selection.setSampleModel(before);
				return { success: true, items: [] };
			},
		});
		render({ model: enrichedModel(), channels: counted, sample: before, selection });
		await last<SavedViews>('SavedViewsMenu').onApply(savedView('neighbour-graph', [['not-in-sample', 0]]));
		assert.equal(calls.filter((c) => c.tool === 'project').length, 1, 'the absent key was projected');
		assert.equal(selection.getState().sampleModel?.sampleId, before.sampleId, 'another sample is shown now');
		assert.equal(layoutRuns.length, 0, 'no layout runs over a sample that is no longer shown');
		// Saved on PCA: the drawn sample starts on PCA, so no layout runs.
		render({ model: enrichedModel(), channels: counting({ sample: () => drawnForView }).channels, sample: before, selection: createSelectionStore(KEY) });
		await last<SavedViews>('SavedViewsMenu').onApply(savedView('pca'));
		assert.equal(layoutRuns.length, 0);
	}));

test('the inspector and the panels get their values: examples kept per connection, the matrix\'s pair and export, the outliers\' neighbours', () => {
	recommendExamples.clear();
	const rec = recording();
	const selection = createSelectionStore(KEY);
	const keys = [0, 1].map((i) => [clustered.docs[clustered.points.doc[i] as number]!.objectId, clustered.points.chunk[i] as number] as VectorKey);
	selection.setKeys(keys);
	render({ model: enrichedModel(), sample: modelOf(clustered), selection, actions: rec.actions, initialTab: 'point' });
	const inspector = last<{ onAddExample(k: VectorKey, p: 'positive' | 'negative'): void; onShowText(k: VectorKey): void; treeNeighbours: unknown }>('PointInspector');
	assert.equal(inspector.treeNeighbours, null);
	inspector.onAddExample(keys[0]!, 'positive');
	assert.deepEqual(recommendExamples.get(KEY), { positive: [keys[0]], negative: [], withQuery: false } as IRecommendExamples);
	render({ model: enrichedModel(), sample: modelOf(clustered), selection, actions: rec.actions, initialTab: 'selection' });
	const matrix = last<{ keys: readonly VectorKey[]; onShowPair(a: VectorKey, b: VectorKey): void; onExport(item: IExportItem): void }>('SimilarityMatrix');
	assert.deepEqual(matrix.keys, keys, 'the selection\'s keys, never sample indices');
	matrix.onShowPair(keys[0]!, keys[1]!);
	assert.deepEqual(selection.getState().highlight, { source: 'neighbors', keys });
	matrix.onExport({ id: 'matrix', label: 'Similarity matrix', kind: 'matrix', disabled: null });
	assert.match(rec.announced.join(' '), /similarity matrix is in the map's Export menu/);
	render({ model: enrichedModel(), sample: modelOf(clustered), actions: rec.actions, initialTab: 'duplicates' });
	const dup = last<{ connectionKey: string; onRemoveDocuments(ids: readonly string[]): void }>('DuplicatesPanel');
	assert.equal(dup.connectionKey, KEY);
	dup.onRemoveDocuments(['a', 'b']);
	assert.deepEqual(rec.removed.at(-1), ['a', 'b'], 'removals go to the console, which confirms them');
	render({ model: enrichedModel(), sample: modelOf(clustered), actions: rec.actions, initialTab: 'outliers' });
	const outliers = last<{ connectionKey: string; onShowNeighbours?: unknown; onRemoveDocument?: unknown }>('OutliersPanel');
	assert.equal(typeof outliers.onShowNeighbours, 'function');
	assert.equal(typeof outliers.onRemoveDocument, 'function');
});

test('isolating a lasso selection: the table lists only those points, Expand by neighbours and Show all are offered (no call)', () => {
	const { calls, channels: counted } = counting();
	const selection = createSelectionStore(KEY);
	const keys = Array.from({ length: 40 }, (_, i) => [clustered.docs[clustered.points.doc[i * 7] as number]!.objectId, clustered.points.chunk[i * 7] as number] as VectorKey);
	selection.setHighlight({ source: 'lasso', keys });
	const out = render({ model: enrichedModel(), channels: counted, sample: modelOf(clustered), selection, initialTab: 'selection' });
	assert.match(out, /<button[^>]*>Isolate<\/button>/);
	assert.match(out, /data-isolated="0"/);
	assert.match(out, /data-shown="1000"/);
	const tab = (captured.get('PointsTable') ?? []).length;
	assert.equal(tab, 0, 'the table is off');
	assert.deepEqual(calls, []);
});

// -----------------------------------------------------------------------------
// Pure parts the view relies on: the compare plan, the export rows, the legend's lines
// -----------------------------------------------------------------------------

test('the compare plan: both questions placed once each, nothing without an embedding node or a second question', () => {
	assert.deepEqual(comparePlan({ told: 'water', toldB: 'orchids', mapQuery: null, mapQueryB: null, embedReady: true }), { runA: true, runB: true });
	assert.deepEqual(comparePlan({ told: 'water', toldB: 'orchids', mapQuery: 'water', mapQueryB: null, embedReady: true }), { runA: false, runB: true }, 'A already placed: only B');
	assert.deepEqual(comparePlan({ told: 'water', toldB: 'orchids', mapQuery: 'water', mapQueryB: 'orchids', embedReady: true }), { runA: false, runB: false });
	assert.deepEqual(comparePlan({ told: 'water', toldB: 'orchids', mapQuery: null, mapQueryB: null, embedReady: false }), { runA: false, runB: false });
	assert.deepEqual(comparePlan({ told: 'water', toldB: null, mapQuery: null, mapQueryB: null, embedReady: true }), { runA: false, runB: false }, 'a single search is the map\'s own query path');
});

test('export rows: the frozen point columns, clusters with their words, duplicate pairs whose points are shown', () => {
	const view = clusterView(clustered.clusters!, 2);
	const points = pointExportRows(clustered, [0, 5], { positions: pcaXY(clustered), dims: 2, querySims: null, clusters: { labels: view.labels, label: (g) => clusterLabel(view, g) } });
	assert.deepEqual(points.columns, EXPORT_COLUMNS.points);
	assert.equal(points.rows[0]?.objectId, clustered.docs[clustered.points.doc[0] as number]?.objectId);
	assert.equal(points.rows[0]?.z, null, '2D: no z');
	assert.equal(points.rows[0]?.query_similarity, null);
	assert.equal(points.rows[0]?.snippet, clustered.points.snip?.[0]);
	assert.equal(points.rows[0]?.cluster, (view.labels[0] as number) + 1);
	const clusterRowsOut = clusterExportRows(clusterRows(clustered, view).rows);
	assert.equal(clusterRowsOut.rows.length, view.count);
	assert.equal(clusterRowsOut.rows[0]?.label, clusterLabel(view, 0));
	const dups = duplicateExportRows(clustered, null);
	assert.equal(dups.rows.length, clustered.duplicates.length);
	assert.ok(clustered.duplicates.length > 0, 'the fixture has duplicate pairs');
	const hidden = new Uint8Array(clustered.n);
	hidden[clustered.duplicates[0]!.a] = 1;
	const expected = clustered.duplicates.filter((d) => !hidden[d.a] && !hidden[d.b]).length;
	assert.equal(duplicateExportRows(clustered, hidden).rows.length, expected);
	assert.ok(expected < clustered.duplicates.length, 'a pair with a hidden point is left out');
});

test('the legend\'s lines: edges drawn, a truncated listing, a scope, an isolation', () => {
	assert.equal(edgeLegend({ mode: 'tree', m: 5, count: 999, min: 0.41, max: 0.99, points: 1000, components: 1, expanded: 0 }), 'Spanning tree: the strongest path connecting every point (1,000 points, 999 edges, similarity 0.41–0.99)');
	assert.equal(edgeLegend({ mode: 'tree', m: 5, count: 997, min: 0.4, max: 0.9, points: 1000, components: 3, expanded: 0 }), 'Spanning tree: the strongest paths connecting the points (1,000 points in 3 groups, 997 edges, similarity 0.40–0.90)');
	assert.equal(edgeLegend({ mode: 'neighbours', m: 5, count: 4812, min: 0.41, max: 0.99, points: 1000, components: 0, expanded: 2 }), 'Neighbour edges: each point\'s 5 strongest (4,812 edges, similarity 0.41–0.99); plus the neighbour edges of 2 expanded points');
	assert.equal(edgeLegend({ mode: 'none', m: 5, count: 0, min: null, max: null, points: 1000, components: 0, expanded: 0 }), null);
	const truncated = JSON.parse(fs.readFileSync(path.join(FIX, 'sample_listing_truncated.json'), 'utf8')) as ISampleResult;
	assert.equal(listingNote(truncated), 'Sampled from the first 500 documents by path; the collection has more');
	assert.equal(listingNote({ ...truncated, listing: { documents: 120, truncated: true, reason: 'stale' } }), "Sampled from part of the collection: the store's listing stopped early");
	assert.equal(listingNote(clustered), null, 'a complete listing says nothing');
	assert.equal(listingNote(loadSample('sample_demo_1000.json')), null, 'an older node says nothing');
	assert.equal(scopeNote('folder is under C:/demo/handbooks/', 12), 'Scope: folder is under C:/demo/handbooks/ (12 documents); the sample is drawn from these only');
	// The scope's other states: the draw is due or in flight, the store refused it, the console cleared it.
	assert.equal(scopePendingNote('folder is under C:/demo/handbooks/', 12), 'Scope: folder is under C:/demo/handbooks/ (12 documents); the sample is being drawn again from these only (the points shown were drawn without this scope)');
	assert.equal(scopeFailedNote('folder is under C:/demo/handbooks/', 1), 'Scope not applied (folder is under C:/demo/handbooks/, 1 document): the sample could not be drawn again from these; the points shown were drawn without this scope');
	assert.equal(scopeLeftNote('folder is under C:/demo/handbooks/', 12, false), 'No scope on the map now: the sample is being drawn again from the whole collection (the points shown are still from the earlier scope: folder is under C:/demo/handbooks/, 12 documents)');
	assert.equal(scopeLeftNote('folder is under C:/demo/handbooks/', 12, true), 'No scope on the map now, but the sample could not be drawn again: the points shown are still from the earlier scope (folder is under C:/demo/handbooks/, 12 documents)');
	assert.equal(SCOPE_RETRY, 'Draw the sample again');
	const out = render({ sample: modelOf(truncated) });
	assert.match(out, /Sampled from the first 500 documents by path; the collection has more/);
});
