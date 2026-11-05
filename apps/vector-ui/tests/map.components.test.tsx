// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP COMPONENTS: static render of every panel (no DOM; react-dom/server)
// =============================================================================
//
// The panels are plain JSX over shell tokens, so they render in Node. These
// pin what a person (and a screen reader) is told; the canvas behaviour is
// covered by the pure modules and the browser lanes.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClustersPanel } from '../src/components/ClustersPanel';
import { DuplicatesPanel } from '../src/components/DuplicatesPanel';
import { HeatStrip } from '../src/components/HeatStrip';
import { LEGEND_CLUSTERS, Legend } from '../src/components/Legend';
import { MapToolbar, TREE_HINT } from '../src/components/MapToolbar';
import { NeighbourList } from '../src/components/NeighbourList';
import { OutliersPanel } from '../src/components/OutliersPanel';
import { PointCanvas } from '../src/components/PointCanvas';
import { PointInspector } from '../src/components/PointInspector';
import { PointsTable } from '../src/components/PointsTable';
import { createSelectionStore } from '../src/contract/bridge';
import type { INeighborsResult, ISampleResult, IVectorLimits, VectorKey } from '../src/contract/types';
import { clusterLabel, clusterRows, clusterSentence, clusterView } from '../src/map/clusters';
import { COLOUR_MODES, clusterColours, colourPoints } from '../src/map/colours';
import { isolateMask } from '../src/map/isolate';
import { readPalette } from '../src/map/tokens';
import { SelectionTab } from '../src/views/MapView';
import { deepFreeze, loadSample, modelOf, pcaXY } from './support/map.samples';

const FIX = path.resolve(__dirname, 'fixtures', 'provisional');
const neighbours = JSON.parse(fs.readFileSync(path.join(FIX, 'neighbors_key.json'), 'utf8')) as INeighborsResult;
const limits = (JSON.parse(fs.readFileSync(path.join(FIX, 'dialect_pgvector.json'), 'utf8')) as { limits: IVectorLimits }).limits;
const demo = modelOf(loadSample('sample_demo_1000.json'));
const native = modelOf(loadSample('sample_native_knn.json'));
const palette = readPalette((t) => ({ '--rr-palette-mode': 'dark', '--rr-bg-default': '#161616', '--rr-bg-paper': '#242424' } as Record<string, string>)[t] ?? '');
const noop = (): void => undefined;
const html = (el: React.ReactElement): string => renderToStaticMarkup(el);

/** Elements of a rendered tree (function components are not called; plain JSX only). */
function elements(node: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
	if (Array.isArray(node)) node.forEach((child) => elements(child, out));
	else if (React.isValidElement(node)) {
		out.push(node);
		elements((node.props as { children?: unknown }).children, out);
	}
	return out;
}

/** The button whose text is `label`. */
function button(tree: React.ReactElement, label: string): React.ReactElement<{ onClick(): void; disabled?: boolean }> {
	const found = elements(tree).find((el) => el.type === 'button' && elements((el.props as { children?: unknown }).children).length === 0 && String((el.props as { children?: unknown }).children).trim() === label);
	assert.ok(found, `a "${label}" button`);
	return found as React.ReactElement<{ onClick(): void; disabled?: boolean }>;
}

test('Legend: sample line, one row per colour, the point cap, who computed the neighbour graph, and the distance caveat', () => {
	const colouring = colourPoints(demo.result, 'document', palette);
	const out = html(<Legend sample={demo} colourBy="document" pointCap={2000} backend="pgvector" colouring={colouring} />);
	assert.match(out, /Showing 1,000 of 1,318 chunks \(random sample\)/);
	assert.equal((out.match(/<li/g) ?? []).length, colouring.legend.length);
	assert.match(out, /Other \(32 documents\)/);
	assert.match(out, /Detailed mode draws up to 2,000 points/);
	assert.match(out, /2D distance is approximate; ranks and scores are exact/);
	const qdrant = html(<Legend sample={native} colourBy="document" pointCap={2000} backend="qdrant" />);
	assert.match(qdrant, /neighbour graph computed by Qdrant/);
	assert.match(qdrant, /data-knn-source="native"/);
});

test('NeighbourList: one button per neighbour with path, chunk and similarity; below-floor rows are tagged', () => {
	const items = neighbours.items.map((item, i) => (i === 11 ? { ...item, below_floor: true } : item));
	const out = html(<NeighbourList items={items} onSelect={noop} />);
	assert.equal((out.match(/<button/g) ?? []).length, 12);
	assert.match(out, /aria-label="Nearest chunks in the collection"/);
	assert.match(out, /ops_005\.pdf/);
	assert.match(out, /0\.930/);
	assert.equal((out.match(/below floor/g) ?? []).length, 1);
});

test('PointInspector: a hint with nothing selected; the chunk, its neighbours and gated actions with one selected', () => {
	const writesOff = { enabled: false, reason: 'Removing documents is turned off on this store node (allow_writes).' };
	assert.match(html(<PointInspector sample={demo} index={null} neighbours={null} querySim={null} writes={writesOff} onOpenDocument={noop} onFindSimilar={noop} onRemoveDocument={noop} />), /Click a point or use the arrow keys/);
	const out = html(<PointInspector sample={demo} index={5} neighbours={neighbours} querySim={0.41} score={0.39} writes={writesOff} onOpenDocument={noop} onFindSimilar={noop} onRemoveDocument={noop} />);
	const doc = demo.result.docs[demo.result.points.doc[5] as number]!;
	assert.ok(out.includes(doc.path));
	assert.match(out, new RegExp(`Chunk ${demo.result.points.chunk[5]} of ${doc.chunks}`));
	assert.match(out, /Similarity to the query 0\.410/);
	assert.match(out, /pipeline score 0\.390/);
	assert.match(out, /12 nearest in the collection/);
	assert.match(out, /Open document/);
	assert.match(out, /Find similar/);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Move to trash<\/button>/);
	assert.ok(out.includes(writesOff.reason), 'the reason is shown as text, not only as a tooltip');
});

test('DuplicatesPanel and OutliersPanel list the node\'s findings, or say there are none', () => {
	const writes = { enabled: true, reason: null };
	const dup = html(<DuplicatesPanel sample={demo} writes={writes} onSelect={noop} onRemoveDocument={noop} />);
	assert.equal((dup.match(/<li/g) ?? []).length, demo.result.duplicates.length);
	assert.match(dup, /0\.9998/);
	const none = modelOf({ ...demo.result, duplicates: [], outliers: [], knn: { k: 0, offsets_row: demo.result.knn.offsets_row.map(() => 0), cols: [], sims: [] } });
	assert.match(html(<DuplicatesPanel sample={none} writes={writes} onSelect={noop} onRemoveDocument={noop} />), /No near-duplicate pairs/);
	const out = html(<OutliersPanel sample={demo} onSelect={noop} />);
	assert.equal((out.match(/<li/g) ?? []).length, demo.result.outliers.length);
	assert.match(html(<OutliersPanel sample={none} onSelect={noop} />), /No outliers/);
});

test('PointsTable: the accessible alternative, one page of 100 rows with a caption and paging', () => {
	const out = html(<PointsTable sample={demo} querySims={null} selected={3} onSelect={noop} />);
	assert.match(out, /<caption[^>]*>Points of the sample/);
	assert.equal((out.match(/<tr/g) ?? []).length, 101, 'header plus 100 rows');
	assert.match(out, /Rows 1–100 of 1,000/);
	assert.match(out, /aria-selected="true"/);
	const sims = Array.from({ length: demo.result.n }, (_, i) => i / demo.result.n);
	assert.match(html(<PointsTable sample={demo} querySims={sims} selected={null} onSelect={noop} />), /Query similarity/);
});

test('HeatStrip: one cell per chunk with its similarity spoken, a single tab stop, and the focused chunk marked', () => {
	const out = html(<HeatStrip chunks={6} scores={[{ chunkId: 0, sim: 0.2 }, { chunkId: 3, sim: 0.8 }]} focused={3} onSelectChunk={noop} label="Similarity of each chunk to the query" />);
	assert.match(out, /aria-label="Similarity of each chunk to the query"/);
	assert.equal((out.match(/<button/g) ?? []).length, 6);
	assert.equal((out.match(/tabindex="0"/gi) ?? []).length, 1);
	assert.match(out, /aria-label="Chunk 3: similarity 0\.800"/);
	assert.match(out, /aria-label="Chunk 1: no similarity"/);
	assert.match(out, /aria-current="true"/);
});

test('MapToolbar: sizes capped by the node\'s limits, t-SNE disabled above 1,000 with its reason, query disabled with its reason, toggles pressed', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: true, table: false, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const out = html(<MapToolbar {...base} query={{ enabled: false, reason: 'Text queries need the embedding node reachable from the Tools source' }} tsneReason="t-SNE is limited to 1,000 points." />);
	assert.match(out, /<option value="detailed:2000"/);
	assert.doesNotMatch(out, /detailed:3000/);
	assert.match(out, /<option value="light:5000"/);
	assert.match(out, /<option value="tsne" disabled=""/);
	assert.match(out, /Text queries need the embedding node reachable from the Tools source/);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Run<\/button>/);
	// Each control is named explicitly: Chrome names a label-wrapped select by its selected option otherwise.
	for (const name of ['Points', 'Layout', 'Colour by', 'Query']) assert.match(out, new RegExp(`aria-label="${name}"`), `${name} is named`);
	assert.match(out, /aria-pressed="true"[^>]*>Lasso/);
	assert.match(out, /aria-pressed="false"[^>]*>Table/);
	const busy = html(<MapToolbar {...base} busy="Laying out…" canCancel query={{ enabled: true, reason: null }} />);
	assert.match(busy, /Laying out…/);
	assert.match(busy, />Cancel<\/button>/);
});

test('Selection tab: "Move these documents to the trash" hands the console EVERY selected document (it confirms and batches), never a silent first 100', () => {
	// 260 points over 250 documents: more than write_ids_max (100).
	const keys: VectorKey[] = Array.from({ length: 260 }, (_, i) => [`doc-${i % 250}`, Math.floor(i / 250)] as VectorKey);
	const asked: Array<readonly string[]> = [];
	const props = { keys, chat: { enabled: true, reason: null }, writes: { enabled: true, reason: null }, onAskAbout: (ids: readonly string[]) => asked.push(ids), onRemove: (ids: readonly string[]) => asked.push(ids), onCopy: noop };
	assert.equal(limits.write_ids_max, 100);
	const tree = SelectionTab(props);
	assert.match(html(tree), /260 points selected from 250 documents\./);
	button(tree, 'Move these documents to the trash').props.onClick();
	assert.equal(asked[0]?.length, 250, 'the console is asked about all 250 documents the tab names');
	assert.deepEqual([...(asked[0] ?? [])].sort(), Array.from({ length: 250 }, (_, i) => `doc-${i}`).sort());
	button(tree, 'Ask about these only').props.onClick();
	assert.equal(asked[1]?.length, 250);
	const off = SelectionTab({ ...props, writes: { enabled: false, reason: 'Removing documents is turned off on this store node (allow_writes).' } });
	assert.equal(button(off, 'Move these documents to the trash').props.disabled, true);
	assert.match(html(off), /turned off on this store node/);
	assert.match(html(SelectionTab({ ...props, keys: [] })), /Turn on the lasso \(L\)/);
});

/** The PointCanvas root's opening tag, statically rendered (effects do not run: no canvas is needed). */
function canvasRoot(result: ISampleResult, extra: Partial<React.ComponentProps<typeof PointCanvas>> = {}): string {
	const props: React.ComponentProps<typeof PointCanvas> = { sample: modelOf(result), positions: pcaXY(result), dimensions: 2, colours: Array.from({ length: result.n }, () => '#888888'), selection: createSelectionStore(), lasso: false, onHover: noop, onPick: noop, onLasso: noop, ...extra };
	const out = html(<PointCanvas {...props} />);
	const tag = /<div[^>]*class="vector-map-canvas"[^>]*>/.exec(out);
	assert.ok(tag, 'the canvas root renders');
	return tag[0];
}

test('PointCanvas draws sample_demo_1000.json and the light 5,000 fixture with data-points equal to the points drawn (hidden ones left out)', () => {
	assert.match(canvasRoot(loadSample('sample_demo_1000.json')), /data-points="1000"/);
	assert.match(canvasRoot(loadSample('sample_light_5000.json')), /data-points="5000"/);
	const hidden = new Uint8Array(1000);
	hidden[3] = hidden[10] = hidden[999] = 1;
	assert.match(canvasRoot(loadSample('sample_demo_1000.json'), { hidden }), /data-points="997"/);
});

test('PointCanvas root carries the browser lanes\' attribute table: mode, layout, selected / focused / lasso count (empty for none), both kNN overlaps', () => {
	const demo1000 = loadSample('sample_demo_1000.json');
	const idle = canvasRoot(demo1000);
	for (const [attr, value] of [['data-mode', 'detailed'], ['data-layout', 'pca'], ['data-selected', ''], ['data-focused', ''], ['data-selection', ''], ['data-overlap-pca', ''], ['data-overlap-layout', '']]) {
		assert.ok(idle.includes(`${attr}="${value}"`), `${attr}="${value}" in ${idle}`);
	}
	const busy = canvasRoot(demo1000, { layout: 'neighbour-graph', overlay: { selected: 5, focused: 0 }, selectionCount: 42, overlap: { layout: 0.50234, pca: 0.16719 } });
	for (const [attr, value] of [['data-layout', 'neighbour-graph'], ['data-selected', '5'], ['data-focused', '0'], ['data-selection', '42'], ['data-overlap-layout', '0.5023'], ['data-overlap-pca', '0.1672']]) {
		assert.ok(busy.includes(`${attr}="${value}"`), `${attr}="${value}" in ${busy}`);
	}
	assert.match(canvasRoot(loadSample('sample_light_5000.json')), /data-mode="light"/);
});

test('MapToolbar states what the sample is drawn from and its seed, so "New sample" visibly moves the seed', () => {
	const base = { limits, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	assert.match(html(<MapToolbar {...base} sample={demo} />), /of 1,318 chunks · 42 docs · seed 7/);
	assert.match(html(<MapToolbar {...base} sample={modelOf(demo.result, { seed: 8 })} />), /seed 8/);
	const unknown = modelOf({ ...demo.result, of: { chunks: null, documents: null } } as unknown as ISampleResult);
	assert.match(html(<MapToolbar {...base} sample={unknown} />), /of — chunks · — docs · seed 7/);
	assert.doesNotMatch(html(<MapToolbar {...base} sample={null} />), /chunks ·/);
});

test('a pressed toggle restyles its border with the same shorthand as an unpressed one (React warns when a toggle mixes border and borderColor)', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const lassoTag = (lasso: boolean): string => /<button[^>]*aria-pressed="(?:true|false)"[^>]*>Lasso/.exec(html(<MapToolbar {...base} lasso={lasso} />))?.[0] ?? '';
	for (const pressed of [true, false]) {
		const tag = lassoTag(pressed);
		assert.match(tag, /border:1px solid/, `the ${pressed ? 'pressed' : 'unpressed'} Lasso sets the border shorthand`);
		assert.doesNotMatch(tag, /border-color/, `the ${pressed ? 'pressed' : 'unpressed'} Lasso mixes in border-color`);
	}
});

// -----------------------------------------------------------------------------
// Clusters tab, the toolbar's edges and colour groups, the legend by cluster,
// the table's Cluster column and isolation, the edge layer's canvas
// -----------------------------------------------------------------------------

const clustered = deepFreeze(JSON.parse(fs.readFileSync(path.join(FIX, 'sample_demo_1000_clusters.json'), 'utf8')) as ISampleResult);
const clusteredModel = modelOf(clustered);
const view5 = clusterView(clustered.clusters!, 5);

/** The Clusters tab's props over the clusters fixture. */
function clustersProps(extra: Partial<React.ComponentProps<typeof ClustersPanel>> = {}): React.ComponentProps<typeof ClustersPanel> {
	return { sample: clusteredModel, minSize: 5, view: view5, colours: clusterColours(view5.count, palette).map((c) => c.colour), chat: { enabled: true, reason: null }, clustersOffered: true, maxDocuments: 2000, ...extra };
}

test('ClustersPanel renders the clusters fixture: one row per group of at least 5, largest first, labelled by its terms, with Show, Ask about these and Export, and a Noise row', () => {
	const out = html(<ClustersPanel {...clustersProps({ exportItemOf: (g) => ({ id: `c${g}`, label: `Cluster ${g + 1}`, kind: 'clusters', disabled: null }), collection: 'vx_demo_docs' })} />);
	assert.doesNotMatch(/<section[^>]*data-component="ClustersPanel"[^>]*>/.exec(out)?.[0] ?? '', /data-placeholder/, 'the panel is built');
	assert.equal((out.match(/data-cluster="\d+"/g) ?? []).length, view5.count);
	assert.match(out, /data-cluster="noise"/);
	assert.match(out, new RegExp(`${view5.count} clusters, ${view5.noise} unassigned points`));
	assert.ok(out.includes(clusterLabel(view5, 0)), 'the largest group\'s terms');
	assert.match(out, /aria-label="Minimum size"/);
	assert.match(out, /<option value="2">2<\/option><option value="5" selected="">5<\/option><option value="10">10<\/option>/);
	assert.match(out, /Clusters: connected groups of the sample&#x27;s neighbour graph above similarity 0\.70/);
	assert.equal((out.match(/>Show<\/button>/g) ?? []).length, view5.count);
	assert.equal((out.match(/>Ask about these<\/button>/g) ?? []).length, view5.count);
	assert.equal((out.match(/data-component="ExportMenu"/g) ?? []).length, view5.count, 'one export menu per cluster');
	// The greenhouse folder's group is labelled with its own words.
	assert.ok(view5.keywords.some((k) => k.includes('orchid')), 'a group labelled with "orchid"');
});

test('ClustersPanel actions: Minimum size, Show (isolate), Ask about these (its documents), highlight; Ask is off with a reason when the chat is off or a group spans too many documents', () => {
	const asked: Array<readonly string[]> = [];
	const sizes: number[] = [];
	const shown: number[] = [];
	const tree = ClustersPanel(clustersProps({ onMinSize: (s) => sizes.push(s), onShow: (g) => shown.push(g), onAskAbout: (ids) => asked.push(ids) }));
	const select = elements(tree).find((el) => el.type === 'select') as React.ReactElement<{ onChange(e: { target: { value: string } }): void }>;
	select.props.onChange({ target: { value: '2' } });
	assert.deepEqual(sizes, [2]);
	const buttons = elements(tree).filter((el) => el.type === 'button') as Array<React.ReactElement<{ onClick(): void; children?: unknown; disabled?: boolean }>>;
	buttons.find((b) => b.props.children === 'Show')!.props.onClick();
	assert.deepEqual(shown, [0]);
	buttons.find((b) => b.props.children === 'Ask about these')!.props.onClick();
	const first = clusterRows(clustered, view5).rows[0]!;
	assert.deepEqual(asked[0], first.documents);
	const off = ClustersPanel(clustersProps({ chat: { enabled: false, reason: 'The chat needs an LLM node.' } }));
	assert.ok((elements(off).filter((el) => el.type === 'button' && (el.props as { children?: unknown }).children === 'Ask about these') as Array<React.ReactElement<{ disabled?: boolean }>>).every((b) => b.props.disabled === true));
	const capped = html(<ClustersPanel {...clustersProps({ maxDocuments: 1 })} />);
	assert.match(capped, /Too many documents to ask about \(\d+; at most 1\)/);
});

test('ClustersPanel states: an older node, a node whose sample has none, no group of the minimum size, and an isolated map with Show all and Expand', () => {
	const old = modelOf(loadSample('sample_demo_1000.json'));
	assert.match(html(<ClustersPanel sample={old} view={null} clustersOffered={false} />), /This store node does not compute clusters; update the node\./);
	assert.match(html(<ClustersPanel sample={old} view={null} clustersOffered />), /drawn without clusters; draw a new sample/);
	const tiny = clusterView({ ...clustered.clusters!, sizes: clustered.clusters!.sizes.map(() => 2) }, 10);
	assert.match(html(<ClustersPanel {...clustersProps({ minSize: 10, view: tiny })} />), /No groups of 10 or more at this similarity; the sample is evenly spread\./);
	const isolated = html(<ClustersPanel {...clustersProps({ isolated: { shown: 212, n: 1000 } })} />);
	assert.match(isolated, /Showing 212 of 1,000/);
	assert.match(isolated, />Expand by neighbours<\/button>/);
	assert.match(isolated, />Show all<\/button>/);
});

test('MapToolbar edges: None, Neighbours (3, 5 or 10 per point; capped on light samples) and Tree; Expand selected with its reason; the Tree hint off the neighbour layout', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop, onExpandSelected: noop };
	const none = html(<MapToolbar {...base} edges="none" expandReason="Select a point first" />);
	assert.match(none, /<option value="none" selected="">None<\/option><option value="neighbours">Neighbours<\/option><option value="tree">Tree<\/option>/);
	assert.doesNotMatch(none, /Edges per point/);
	assert.match(none, /<button[^>]*disabled=""[^>]*title="Select a point first"[^>]*>Expand selected<\/button>/);
	const neighbours = html(<MapToolbar {...base} edges="neighbours" edgesM={10} expandReason={null} />);
	assert.match(neighbours, /aria-label="Edges per point"/);
	assert.match(neighbours, /<option value="10" selected="">10<\/option>/);
	const capped = html(<MapToolbar {...base} edges="neighbours" edgesM={3} edgesMCap={3} />);
	assert.match(capped, /<option value="5" disabled="" title="Light samples above 3,000 points draw at most 3 edges per point">5<\/option>/);
	assert.match(html(<MapToolbar {...base} edges="tree" />), new RegExp(TREE_HINT));
	assert.doesNotMatch(html(<MapToolbar {...base} edges="tree" layout="neighbour-graph" />), new RegExp(TREE_HINT));
});

test('MapToolbar Colour by: Content, Document and Analysis groups, every mode, a mode without its data disabled with the reason (the one shown stays selectable)', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const out = html(<MapToolbar {...base} colourBy="document" colourReasons={{ cluster: 'This store node does not compute clusters; update the node.', 'ingest-date': 'This store does not keep ingest times.' }} />);
	assert.deepEqual([...out.matchAll(/<optgroup label="([^"]+)">/g)].map((m) => m[1]), ['Content', 'Document', 'Analysis']);
	assert.equal((out.match(/<option value="[a-z-]+"/g) ?? []).filter((o) => COLOUR_MODES.some((m) => o.includes(`"${m.id}"`))).length, COLOUR_MODES.length);
	assert.match(out, /<option value="cluster" disabled="" title="This store node does not compute clusters; update the node.">Cluster<\/option>/);
	assert.match(out, /<option value="ingest-date" disabled="" title="This store does not keep ingest times.">Ingest date<\/option>/);
	assert.match(out, /<option value="table">Table chunks<\/option>/);
	assert.match(html(<MapToolbar {...base} colourBy="cluster" colourReasons={{ cluster: 'x' }} />), /<option value="cluster" title="x" selected="">Cluster<\/option>/);
});

test('Legend coloured by cluster: the 12 largest groups by name, the noise row, and how many more the Clusters tab lists', () => {
	const colouring = colourPoints(clustered, 'cluster', palette, { clusters: view5 });
	const out = html(<Legend sample={clusteredModel} colourBy="cluster" pointCap={2000} backend="pgvector" colouring={colouring} notes={[clusterSentence(clustered.clusters!, 5)]} />);
	assert.equal((out.match(/<li/g) ?? []).length, LEGEND_CLUSTERS + 1);
	assert.match(out, /Unassigned \(in no group\)/);
	assert.match(out, new RegExp(`and ${view5.count - LEGEND_CLUSTERS} more groups, each with its own colour \\(the Clusters tab lists them all\\)`));
	assert.match(out, /Clusters: connected groups/);
});

test('PointsTable: a Cluster column with the group\'s words, duplicate groups in Notes, and only the points the map shows (an isolation of 40 lists 40)', () => {
	const groupsOf = new Int32Array(clustered.n).fill(-1);
	groupsOf[0] = 2;
	const out = html(<PointsTable sample={clusteredModel} querySims={null} selected={null} onSelect={noop} clusters={view5} duplicateGroups={groupsOf} />);
	assert.match(out, /<th scope="col"[^>]*>Cluster<\/th>/);
	const g = view5.labels[0] as number;
	assert.ok(out.includes(g >= 0 ? `${g + 1}: ${clusterLabel(view5, g)}` : '>none<'), 'point 1\'s cluster');
	assert.match(out, /duplicate group 3/);
	const keep = Array.from({ length: 40 }, (_, i) => i * 7);
	const isolated = html(<PointsTable sample={clusteredModel} querySims={null} selected={null} onSelect={noop} hidden={isolateMask(clustered.n, keep)} />);
	assert.match(isolated, /Rows 1–40 of 40/);
	assert.match(html(<PointsTable sample={clusteredModel} querySims={null} selected={null} onSelect={noop} hidden={null} />), /Rows 1–100 of 1,000/);
});

test('PointCanvas: the edge layer is its own canvas under the points and the overlay', () => {
	const out = html(<PointCanvas sample={demo} positions={pcaXY(demo.result)} dimensions={2} colours={[]} selection={createSelectionStore()} lasso={false} onHover={noop} onPick={noop} onLasso={noop} />);
	const canvases = [...out.matchAll(/<canvas[^>]*>/g)].map((m) => m[0]);
	assert.equal(canvases.length, 3);
	assert.match(canvases[0] as string, /data-layer="edges"/);
	assert.match(canvases[0] as string, /pointer-events:none/);
	assert.match(canvases[0] as string, /transition:opacity 250ms/);
	const reduced = html(<PointCanvas sample={demo} positions={pcaXY(demo.result)} dimensions={2} colours={[]} selection={createSelectionStore()} lasso={false} onHover={noop} onPick={noop} onLasso={noop} reducedMotion />);
	assert.match(reduced, /<canvas[^>]*transition:none[^>]*data-layer="edges"/, 'no fade-in under reduced motion');
});
