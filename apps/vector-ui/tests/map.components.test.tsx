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
import { LEGEND_CLUSTERS, Legend, keepTabStop, markRows, rememberLegendOpen, scrollsInside } from '../src/components/Legend';
import { MOVABLE_ITEMS, MapToolbar, STATUS_HEIGHT, TOOLBAR_GAP, TREE_HINT } from '../src/components/MapToolbar';
import { NeighbourList } from '../src/components/NeighbourList';
import { OutliersBody, OutliersPanel } from '../src/components/OutliersPanel';
import { PointCanvas } from '../src/components/PointCanvas';
import { PointInspector } from '../src/components/PointInspector';
import { PointsTable } from '../src/components/PointsTable';
import { createSelectionStore } from '../src/contract/bridge';
import type { INeighborsResult, ISampleResult, IVectorLimits, VectorKey } from '../src/contract/types';
import { clusterLabel, clusterRows, clusterSentence, clusterView } from '../src/map/clusters';
import { COLOUR_MODES, clusterColours, colourPoints } from '../src/map/colours';
import { dimMask, isolateMask } from '../src/map/isolate';
import { removeTargetsOf } from '../src/map/model';
import { outlierRows } from '../src/map/outliers';
import { POPOVER_GAP, POPOVER_MARGIN, afterCancelFocus, clipArea, firstEnabled, focusAfterMove, focusHold, placePopover, popoverKey, toolbarOverflow } from '../src/map/popover';
import { STAGE_REMOVAL, pairLabel, removeAllLabel, removeOthersLabel } from '../src/map/reviewWording';
import { LEGEND_COLLAPSED_HEIGHT, LEGEND_HEAD_HEIGHT, LEGEND_HEIGHT } from '../src/map/styles';
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

test('MapToolbar: sizes capped by the node\'s limits, t-SNE disabled above 1,000 with its reason, query disabled with its reason, toggles pressed (in Advanced)', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: true, table: false, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const out = html(<MapToolbar {...base} initialAdvanced query={{ enabled: false, reason: 'Text queries need the embedding node reachable from the Tools source' }} tsneReason="t-SNE is limited to 1,000 points." />);
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
	assert.match(busy, /role="status"[^>]*>Laying out…</);
	// The busy words (a live region) and Cancel are in the status line: a line of its own under the controls, at a
	// fixed height, always there.
	const line = (markup: string): string => /<div style="([^"]*)" data-map-status="">/.exec(markup)?.[1] ?? '';
	assert.match(busy, /<div style="[^"]*" data-map-status=""><span role="status"[^>]*>Laying out…<\/span><button[^>]*>Cancel<\/button><\/div>/);
	const idle = html(<MapToolbar {...base} query={{ enabled: true, reason: null }} />);
	assert.match(idle, /<div style="[^"]*" data-map-status=""><span role="status"[^>]*><\/span><\/div>/, 'idle: the line is there, empty');
	for (const out2 of [busy, idle]) {
		assert.match(line(out2), new RegExp(`;height:${STATUS_HEIGHT}px;[^"]*flex:none`), 'its own line under the row, at a fixed height');
		assert.doesNotMatch(out2, /position:absolute;top|position:fixed/, 'nothing floats over the map or the rows under the toolbar');
	}
	// Busy or idle, the markup differs only in the words, Cancel and what busy disables: nothing moves.
	const flow = (markup: string): string => markup.replace(/(<span role="status"[^>]*>)[^<]*(<\/span>)/, '$1$2').replace(/<button[^>]*>Cancel<\/button>/, '').replace(/ disabled=""/g, '').replace(/ title="[^"]*"/g, '');
	assert.equal(flow(busy), flow(idle));
	assert.equal(line(busy), line(idle), 'the same line style');
	// Cancel leaving with the focus hands it to Layout, else the toolbar.
	assert.equal(afterCancelFocus({ present: true, disabled: false }), 'layout');
	assert.equal(afterCancelFocus({ present: true, disabled: true }), 'toolbar');
	assert.equal(afterCancelFocus({ present: false, disabled: false }), 'toolbar');
});

test('MapToolbar is one row of controls: Points, Layout, Colour by, Query, Table, Advanced, the view\'s menus, then its status line; the rest is in Advanced, closed at first', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop, onExpandSelected: noop, onToggle3D: noop, extras: <span data-extras="">Export Views</span> };
	const closed = html(<MapToolbar {...base} />);
	const order = ['aria-label="Points"', 'aria-label="Layout"', 'aria-label="Colour by"', 'aria-label="Query"', '>Table</button>', 'data-component="AdvancedPopover"', 'data-extras=""', 'data-map-status=""'].map((needle) => closed.indexOf(needle));
	assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
	assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
	assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*>Advanced ▾<\/button>/);
	for (const moved of ['aria-label="Edges"', '>Lasso<', '>Fit<', '>3D<', '>Expand selected<', 'New sample']) assert.ok(!closed.includes(moved), `${moved} is in Advanced, not on the row`);
	// The Table is the map's non-visual alternative and the keyboard route to a point: never behind the popover.
	assert.match(closed, /<button[^>]*aria-pressed="false"[^>]*>Table<\/button>/);
	const open = html(<MapToolbar {...base} initialAdvanced />);
	assert.match(open, /<button[^>]*aria-expanded="true" aria-controls="(advanced-[^"]+)"[^>]*>Advanced ▾<\/button><div id="\1" role="group" aria-label="Advanced map controls"/);
	const groups = [...open.matchAll(/<legend[^>]*>([^<]+)<\/legend>/g)].map((m) => m[1]);
	assert.deepEqual(groups, ['Graph', 'Select and view', 'Sample']);
	for (const control of ['aria-label="Edges"', '>Expand selected<', '>Lasso<', '>Fit<', '>3D<', '>New sample (seed 8)<']) assert.ok(open.includes(control), control);
	const panel = open.slice(open.indexOf('data-advanced-panel'));
	assert.doesNotMatch(panel, />Table</, 'the Table is not in the panel');
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

test('the legend\'s first line states what the sample is drawn from, its documents and its seed; Advanced says which seed New sample draws', () => {
	const legend = (sample: typeof demo): string => html(<Legend sample={sample} colourBy="document" pointCap={2000} backend="pgvector" />);
	assert.match(legend(demo), /data-legend-toggle="">▾ Legend<\/button><span style="[^"]*" title="[^"]*">Showing 1,000 of 1,318 chunks \(random sample\) · 42 docs · seed 7<\/span>/, 'the header row, beside the disclosure');
	assert.match(legend(modelOf(demo.result, { seed: 8 })), /· seed 8</);
	const unknown = modelOf({ ...demo.result, of: { chunks: null, documents: null } } as unknown as ISampleResult);
	assert.match(legend(unknown), /the store did not say how many it holds\) · — docs · seed 7/);
	const base = { limits, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop, initialAdvanced: true };
	const asked: Array<{ n: number; mode: string; seed: number }> = [];
	const out = html(<MapToolbar {...base} sample={demo} onSample={(o) => asked.push(o)} />);
	assert.match(out, />This sample: seed 7<\/span>/);
	assert.match(out, />New sample \(seed 8\)<\/button>/);
	assert.doesNotMatch(out, /chunks ·/, 'the toolbar no longer carries the sample line');
	assert.doesNotMatch(html(<MapToolbar {...base} sample={null} onSample={noop} />), /This sample/);
});

test('a pressed toggle restyles its border with the same shorthand as an unpressed one (React warns when a toggle mixes border and borderColor)', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const lassoTag = (lasso: boolean): string => /<button[^>]*aria-pressed="(?:true|false)"[^>]*>Lasso/.exec(html(<MapToolbar {...base} initialAdvanced lasso={lasso} />))?.[0] ?? '';
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

test('MapToolbar edges (in Advanced): None, Neighbours (3, 5 or 10 per point; capped on light samples) and Tree; Expand selected with its reason; the Tree hint off the neighbour layout', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop, onExpandSelected: noop, initialAdvanced: true };
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

// -----------------------------------------------------------------------------
// Popovers: placed inside the viewport before paint; Escape closes and refocuses
// -----------------------------------------------------------------------------

test('placePopover: below the button when it fits, from its left edge, clamped inside the viewport, never wider than it', () => {
	const vp = { width: 1440, height: 900 };
	const below = placePopover({ left: 600, top: 40, right: 690, bottom: 68 }, { width: 340, height: 300 }, vp);
	assert.deepEqual(below, { left: 600, top: 68 + POPOVER_GAP, maxHeight: 900 - POPOVER_MARGIN - 68 - POPOVER_GAP, maxWidth: 1440 - 2 * POPOVER_MARGIN, side: 'below' });
	// Near the right edge: it ends at the button's right edge instead.
	assert.equal(placePopover({ left: 1300, top: 40, right: 1380, bottom: 68 }, { width: 340, height: 300 }, vp).left, 1380 - 340);
	// A button wider than nothing at the far right of a narrow window: clamped to the margin.
	assert.equal(placePopover({ left: 380, top: 40, right: 395, bottom: 68 }, { width: 360, height: 100 }, { width: 400, height: 900 }).left, 400 - POPOVER_MARGIN - 360);
	assert.equal(placePopover({ left: 2, top: 40, right: 30, bottom: 68 }, { width: 340, height: 100 }, vp).left, POPOVER_MARGIN);
	// Wider than the viewport: capped, from the margin.
	const wide = placePopover({ left: 10, top: 10, right: 40, bottom: 30 }, { width: 500, height: 100 }, { width: 320, height: 900 });
	assert.equal(wide.maxWidth, 320 - 2 * POPOVER_MARGIN);
	assert.equal(wide.left, POPOVER_MARGIN);
});

test('placePopover: above the button when only that fits; on the roomier side with its height capped when neither does', () => {
	const vp = { width: 1440, height: 900 };
	const above = placePopover({ left: 100, top: 800, right: 180, bottom: 828 }, { width: 300, height: 400 }, vp);
	assert.equal(above.side, 'above');
	assert.equal(above.top, 800 - POPOVER_GAP - 400);
	assert.ok(above.top >= POPOVER_MARGIN);
	const tall = placePopover({ left: 100, top: 300, right: 180, bottom: 328 }, { width: 300, height: 2000 }, vp);
	assert.equal(tall.side, 'below', 'more room below');
	assert.equal(tall.maxHeight, 900 - POPOVER_MARGIN - 328 - POPOVER_GAP);
	assert.ok(tall.top + tall.maxHeight <= 900 - POPOVER_MARGIN, 'inside the viewport');
	const low = placePopover({ left: 100, top: 700, right: 180, bottom: 728 }, { width: 300, height: 2000 }, vp);
	assert.equal(low.side, 'above');
	assert.equal(low.top, POPOVER_MARGIN, 'capped to the room above');
});

test('popoverKey: Escape closes the popover, puts the focus back on its button and is marked handled; an Escape an inner control handled is left alone; other keys do nothing', () => {
	assert.deepEqual(popoverKey('Escape', false), { close: true, refocus: true, prevent: true });
	assert.deepEqual(popoverKey('Escape', true), { close: false, refocus: false, prevent: false });
	assert.deepEqual(popoverKey('Tab', false), { close: false, refocus: false, prevent: false });
	assert.deepEqual(popoverKey('ArrowDown', false), { close: false, refocus: false, prevent: false });
});

test('dimMask: a selection lights itself and its neighbours; else a highlighted set; else the query\'s top-k; nothing to light dims nothing', () => {
	const lit = (mask: Uint8Array | null): number[] => (mask ? Array.from(mask).flatMap((v, i) => (v ? [] : [i])) : []);
	assert.deepEqual(lit(dimMask(6, { selected: 2, neighbours: [4, 5], highlight: [0], queryTop: [1] })), [2, 4, 5]);
	assert.deepEqual(lit(dimMask(6, { selected: null, neighbours: [], highlight: [0, 3], queryTop: [1] })), [0, 3]);
	assert.deepEqual(lit(dimMask(6, { selected: null, neighbours: [], highlight: [], queryTop: [1] })), [1], 'an empty highlight falls through');
	assert.equal(dimMask(6, { selected: null, neighbours: [], highlight: null, queryTop: [] }), null);
	assert.equal(dimMask(6, { selected: null, neighbours: [], highlight: [9], queryTop: [] }), null, 'only out-of-range points: nothing faded');
});

test('the legend\'s glyph row lists only the marks drawn now, each with words, in the canvas\'s colours', () => {
	assert.deepEqual(markRows(null), []);
	assert.deepEqual(markRows({ edges: null, links: false, outliers: 0, query: null, duplicates: 0 }), []);
	const all = markRows({ edges: { weakest: 'rgb(99, 99, 99)', strongest: 'rgb(206, 206, 206)' }, links: true, outliers: 3, query: { top: 10, drawn: 10 }, duplicates: 1200 });
	assert.deepEqual(all.map((m) => m.words), ['similarity edge (fainter: less similar)', "selected point's nearest chunks", 'outlier (3)', 'query, rays to its true top 10', 'near-duplicate pair (1,200)']);
	// Rays only to the results placed on the map: the words say how many of the top-k.
	assert.equal(markRows({ query: { top: 10, drawn: 7 } })[0]?.words, 'query, rays to 7 of its true top 10');
	assert.equal(markRows({ rings: { scale: 'cosine' } })[0]?.words, "shown duplicate group: each pair's similarity (cosine)");
	// The glyphs' lines are as wide as the map draws them: at least two device pixels (2 / 3 / 2 px at 1 dppx; the
	// map's own widths at 2 dppx).
	const widths = (dpr: number): string[] => markRows({ edges: { weakest: 'rgb(99, 99, 99)', strongest: 'rgb(206, 206, 206)' }, links: true, outliers: 3, query: { top: 10, drawn: 10 }, duplicates: 2, rings: { scale: 'cosine' } }, dpr).map((m) => html(m.picture).match(/stroke-width:[0-9.]+/g)?.join(' ') ?? '');
	assert.deepEqual(widths(1), ['stroke-width:2 stroke-width:2', 'stroke-width:3 stroke-width:2', 'stroke-width:3 stroke-width:2', 'stroke-width:2 stroke-width:1', 'stroke-width:2', 'stroke-width:3 stroke-width:2']);
	assert.deepEqual(widths(2), ['stroke-width:1 stroke-width:1', 'stroke-width:1.5 stroke-width:1.5', 'stroke-width:3 stroke-width:1.5', 'stroke-width:1.25 stroke-width:1', 'stroke-width:1.5', 'stroke-width:3 stroke-width:1.5']);
	// At 0.5 dppx the rings are 4 px: their halos are a device pixel wider (6).
	assert.deepEqual(widths(0.5)[2], 'stroke-width:6 stroke-width:4');
	const out = html(<Legend sample={demo} colourBy="document" pointCap={2000} backend="pgvector" marks={{ edges: { weakest: 'rgb(99, 99, 99)', strongest: 'rgb(206, 206, 206)' }, outliers: 3 }} />);
	assert.match(out, /data-legend-marks="edges outliers"/);
	assert.match(out, /<ul aria-label="Marks"/);
	assert.match(out, /stroke:rgb\(99, 99, 99\);stroke-width:2/, 'the weakest edge colour as painted, as wide as the canvas draws it at 1 dppx');
	assert.match(out, /stroke:var\(--rr-text-primary\)/, 'the outlier ring in the outline colour');
	assert.match(out, /<svg aria-hidden="true"/, 'the words carry it');
	// Nothing marked: the row keeps its line (selecting a point does not resize the map) and lists nothing.
	const none = html(<Legend sample={demo} colourBy="document" pointCap={2000} backend="pgvector" />);
	assert.match(none, /<div style="min-height:36px[^"]*" data-legend-marks=""><\/div>/, 'two lines kept');
});

// -----------------------------------------------------------------------------
// Staging: the map's removal buttons say what they do
// -----------------------------------------------------------------------------

test('where the console stages removals, the map\'s buttons say Stage removal (inspector, outliers, duplicates, selection); else Move to trash as before', () => {
	const writes = { enabled: true, reason: null };
	const staged = html(<PointInspector sample={demo} index={5} neighbours={neighbours} querySim={null} writes={writes} onOpenDocument={noop} onFindSimilar={noop} onRemoveDocument={noop} staging />);
	assert.match(staged, /<button[^>]*>Stage removal<\/button>/);
	assert.doesNotMatch(staged, />Move to trash</);
	assert.match(html(<PointInspector sample={demo} index={5} neighbours={neighbours} querySim={null} writes={writes} onOpenDocument={noop} onFindSimilar={noop} onRemoveDocument={noop} />), /<button[^>]*>Move to trash<\/button>/);
	const removed: string[] = [];
	const rows = outlierRows(demo.result, 1);
	const body = OutliersBody({ rows, percentile: 1, writes, canRemove: true, staging: true, canShowNeighbours: false, onPercentile: noop, onSelect: noop, onReview: noop, onRemove: (id) => removed.push(id), onShowNeighbours: noop });
	button(body, STAGE_REMOVAL).props.onClick();
	assert.deepEqual(removed, [rows[0]!.objectId]);
	assert.equal(removeOthersLabel(1, true), 'Stage removal');
	assert.equal(removeOthersLabel(3, true), 'Stage 3 removals');
	assert.equal(removeAllLabel(1, true), 'Stage 1 removal');
	assert.equal(removeAllLabel(1200, true), 'Stage all 1,200 removals');
	assert.equal(removeOthersLabel(3), 'Move the others to the trash (3)', 'unchanged without staging');
	assert.equal(removeAllLabel(2), 'Move all queued to the trash (2 documents)');
	const keys: VectorKey[] = [['doc-1', 0], ['doc-2', 1]];
	const tab = SelectionTab({ keys, chat: { enabled: true, reason: null }, writes, onAskAbout: noop, onRemove: noop, onCopy: noop, staging: true });
	assert.ok(button(tab, 'Stage these documents for the trash'));
	// Writes off: staging is closed the same way, with the reason as text.
	const off = { enabled: false, reason: 'Removing documents is turned off on this store node (allow_writes).' };
	assert.match(html(<PointInspector sample={demo} index={5} neighbours={neighbours} querySim={null} writes={off} onOpenDocument={noop} onFindSimilar={noop} onRemoveDocument={noop} staging />), /<button[^>]*disabled=""[^>]*>Stage removal<\/button>/);
});

test('a duplicate pair\'s similarity is printed with its scale, never a bare number (the number depends on the store\'s metric)', () => {
	assert.equal(pairLabel(0.9874, 'cosine'), 'cosine 0.99');
	assert.equal(pairLabel(12.5, 'ip'), 'inner product 12.50');
	assert.equal(pairLabel(0.5, 'l2'), 'L2 similarity 0.50');
	assert.equal(pairLabel(0.5, null), 'similarity 0.50');
});

test('a popover inside a clipping ancestor (a scrolled or clipped card) is placed inside that ancestor, not only inside the window', () => {
	const vp = { width: 1440, height: 900 };
	assert.deepEqual(clipArea(vp, []), { left: 0, top: 0, width: 1440, height: 900 });
	const card = { left: 300, top: 100, right: 900, bottom: 600 };
	const area = clipArea(vp, [card, { left: 0, top: 0, right: 1440, bottom: 700 }]);
	assert.deepEqual(area, { left: 300, top: 100, width: 600, height: 500 });
	// A button near the card's right edge: the panel ends inside the card.
	const at = placePopover({ left: 820, top: 120, right: 880, bottom: 148 }, { width: 340, height: 200 }, area);
	assert.ok(at.left >= 300 + POPOVER_MARGIN && at.left + 340 <= 900 - POPOVER_MARGIN, JSON.stringify(at));
	assert.equal(at.maxHeight, 600 - POPOVER_MARGIN - 148 - POPOVER_GAP, 'its height is capped to the card');
	// Near the card's bottom: above, inside the card.
	const up = placePopover({ left: 320, top: 560, right: 380, bottom: 588 }, { width: 300, height: 200 }, area);
	assert.equal(up.side, 'above');
	assert.ok(up.top >= 100 + POPOVER_MARGIN);
	assert.deepEqual(clipArea(vp, [{ left: 2000, top: 0, right: 2100, bottom: 10 }]).width, 0, 'scrolled out of view: no room, never negative');
});

test('focusHold: a focused toolbar control that is disabled or removed hands the focus to the toolbar (never the page), and a disabled one gets it back once enabled', () => {
	const on = { inside: true, disabled: false };
	const off = { inside: true, disabled: true };
	const gone = { inside: false, disabled: false };
	// Drawing a sample disables the focused Points select (the browser may still report it, or the page).
	assert.equal(focusHold({ last: off, held: null, active: 'last' }), 'hold');
	assert.equal(focusHold({ last: off, held: null, active: 'page' }), 'hold');
	// Cancel unmounted when the layout ended: the focus fell to the page.
	assert.equal(focusHold({ last: gone, held: null, active: 'page' }), 'take');
	// Enabled again while the toolbar still has the focus: give it back; disabled still: wait.
	assert.equal(focusHold({ last: null, held: on, active: 'toolbar' }), 'give-back');
	assert.equal(focusHold({ last: null, held: off, active: 'toolbar' }), 'none');
	// The user moved on (or the held control went away): forget it, never pull the focus back.
	assert.equal(focusHold({ last: null, held: off, active: 'other' }), 'release');
	assert.equal(focusHold({ last: null, held: gone, active: 'toolbar' }), 'release');
	// Nothing to do: an enabled control, the focus elsewhere, nothing known.
	assert.equal(focusHold({ last: on, held: null, active: 'last' }), 'none');
	assert.equal(focusHold({ last: off, held: null, active: 'other' }), 'none');
	assert.equal(focusHold({ last: gone, held: null, active: 'other' }), 'none');
	assert.equal(focusHold({ last: null, held: null, active: 'page' }), 'none');
});

test('removeTargetsOf names the documents the map stages by the sample\'s paths and chunk counts, once each, in order; the rest is left to the console', () => {
	const docs = demo.result.docs;
	const a = docs[0]!;
	const b = docs[1]!;
	const targets = removeTargetsOf(demo.result, [b.objectId, a.objectId, b.objectId, 'not-in-sample']);
	assert.deepEqual(targets, [
		{ objectId: b.objectId, path: b.path, chunks: typeof b.chunks === 'number' ? b.chunks : null },
		{ objectId: a.objectId, path: a.path, chunks: typeof a.chunks === 'number' ? a.chunks : null },
		{ objectId: 'not-in-sample', path: null, chunks: null },
	]);
	// What the sample does not know is left null: the console takes it from its loaded rows (IStageTarget).
	assert.ok(targets.slice(0, 2).every((t) => t.path !== t.objectId), 'file names, not ids');
});

test('an opened panel focuses its first control that is neither disabled nor hidden (Edges is off with no sample: Expand selected or Lasso then)', () => {
	assert.equal(firstEnabled([{ disabled: false, hidden: false }]), 0);
	assert.equal(firstEnabled([{ disabled: true, hidden: false }, { disabled: false, hidden: true }, { disabled: false, hidden: false }]), 2);
	assert.equal(firstEnabled([{ disabled: true, hidden: false }]), -1, 'none: the panel itself takes the focus');
	assert.equal(firstEnabled([]), -1);
});

test('a disabled Query and t-SNE carry their reasons as the controls\' descriptions; the status line holds only the busy words and Cancel', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const why = 'Text queries need the embedding node reachable from the Tools source';
	const out = html(<MapToolbar {...base} query={{ enabled: false, reason: why }} tsneReason="t-SNE is limited to 1,000 points; this sample has 5,000." />);
	const queryId = /<input aria-label="Query" aria-describedby="([^"]+)"/.exec(out)?.[1];
	assert.ok(queryId, 'the Query box is described');
	assert.match(out, new RegExp(`<button type="submit"[^>]*aria-describedby="${queryId}"[^>]*>Run</button>`), 'and so is Run');
	assert.match(out, new RegExp(`<span id="${queryId}"[^>]*>${why}</span>`));
	const tsneId = /<select aria-label="Layout" aria-describedby="([^"]+)"/.exec(out)?.[1];
	assert.ok(tsneId);
	assert.match(out, new RegExp(`<span id="${tsneId}"[^>]*>t-SNE is limited to 1,000 points; this sample has 5,000\\.</span>`));
	const busy = html(<MapToolbar {...base} busy="Laying out…" canCancel query={{ enabled: false, reason: why }} tsneReason="t-SNE is limited to 1,000 points; this sample has 5,000." />);
	const status = /<div[^>]*data-map-status="">([\s\S]*?)<\/div>/.exec(busy)?.[1] ?? '';
	assert.match(status, /Laying out…/);
	assert.doesNotMatch(status, /Text queries|t-SNE/, 'no reason in the status line');
	// Nothing to explain: no description on Query, Run or Layout.
	const fine = html(<MapToolbar {...base} query={{ enabled: true, reason: null }} />);
	assert.doesNotMatch(fine, /<input aria-label="Query" aria-describedby|<select aria-label="Layout" aria-describedby|type="submit"[^>]*aria-describedby/);
});

test('the toolbar is compact enough for a dev-tool frame: short Points options (the light one titled and described), a 120 px query box, 6 px gaps', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const out = html(<MapToolbar {...base} />);
	assert.match(out, /<option value="detailed:1000" selected="">1,000 \(detailed\)<\/option>/);
	assert.match(out, /<option value="light:5000" title="5,000 \(light: no text\)">5,000 \(light\)<\/option>/);
	const lightId = /<select aria-label="Points" aria-describedby="([^"]+)"/.exec(out)?.[1];
	assert.ok(lightId, 'the Points select is described');
	assert.match(out, new RegExp(`<span id="${lightId}"[^>]*>A light sample has no text\\.</span>`));
	assert.match(out, /<div role="toolbar" aria-label="Map controls" tabindex="-1" style="[^"]*gap:6px/);
	assert.match(out, /<input aria-label="Query" style="[^"]*min-width:120px;[^"]*width:120px"/);
	// A node without light samples: nothing to describe.
	assert.doesNotMatch(html(<MapToolbar {...base} limits={{ ...limits, sample_max_light: limits.sample_max }} />), /A light sample/);
});

test('the legend\'s cap line says a light sample has no text (the Points option says only "light")', () => {
	const light = modelOf(loadSample('sample_light_5000.json'));
	assert.match(html(<Legend sample={light} colourBy="document" pointCap={5000} backend="pgvector" />), /Light mode draws up to 5,000 points, without their text/);
	assert.match(html(<Legend sample={demo} colourBy="document" pointCap={2000} backend="pgvector" />), /Detailed mode draws up to 2,000 points ·/);
});

test('the status line offers Clear (what Escape on the map clears next) while something is lit, at its fixed height', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const lit = html(<MapToolbar {...base} clear={{ label: 'Clear highlight', onClear: noop }} />);
	assert.match(lit, /<div style="[^"]*" data-map-status=""><span role="status"[^>]*><\/span><button[^>]*data-map-clear="">Clear highlight<\/button><\/div>/);
	const none = html(<MapToolbar {...base} clear={null} />);
	assert.doesNotMatch(none, /data-map-clear/);
	const line = (markup: string): string => /<div style="([^"]*)" data-map-status="">/.exec(markup)?.[1] ?? '';
	assert.equal(line(lit), line(none), 'the same line, the same height');
});

test('the status line holds the view\'s notice in its live region while nothing runs, with its button, at the same fixed height', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const line = (markup: string): string => /<div style="([^"]*)" data-map-status="">/.exec(markup)?.[1] ?? '';
	const idle = html(<MapToolbar {...base} notice={null} />);
	const cancelled = html(<MapToolbar {...base} notice={{ text: 'Layout cancelled. The map shows PCA.' }} />);
	assert.match(cancelled, /data-map-status=""><span role="status" style="[^"]*text-overflow:ellipsis[^"]*" title="Layout cancelled\. The map shows PCA\." data-map-notice="">Layout cancelled\. The map shows PCA\.<\/span><\/div>/);
	assert.equal(line(cancelled), line(idle), 'the same line, the same height');
	// A saved view's query, with its button (disabled with the reason when the query cannot run).
	const saved = html(<MapToolbar {...base} notice={{ text: 'This view had the query "water".', action: { label: 'Run saved query', onAction: noop, reason: null } }} />);
	assert.match(saved, /data-map-notice="">This view had the query &quot;water&quot;\.<\/span><button type="button" style="[^"]*" data-map-notice-action="">Run saved query<\/button>/);
	const blocked = html(<MapToolbar {...base} notice={{ text: 'This view had the query "water".', action: { label: 'Run saved query', onAction: noop, reason: 'Text queries need the embedding node' } }} />);
	assert.match(blocked, /<button type="button" style="[^"]*" disabled="" title="Text queries need the embedding node" data-map-notice-action="">/);
	// While something runs, the line has the busy words (and Cancel), never the notice.
	const running = html(<MapToolbar {...base} busy="Laying out… 40%" canCancel notice={{ text: 'Layout cancelled. The map shows PCA.', action: { label: 'Run saved query', onAction: noop } }} />);
	assert.match(running, /<span role="status"[^>]*>Laying out… 40%<\/span><button[^>]*>Cancel<\/button><\/div>/);
	assert.doesNotMatch(running, /data-map-notice/);
	assert.equal(line(running), line(idle));
});

test('the toolbar is one row at any width: what has no room moves into More by measured width (Export and Views first, then the selects), never wrapped', () => {
	// Measured in Chrome (RocketRide dark, system-ui) from the browser-rendered toolbar.
	const widths = [['points', 158.7], ['layout', 167.9], ['colour', 191.2], ['query', 212.9], ['table', 53.7], ['advanced', 93.2], ['extras', 147.7]] as const;
	const fit = (row: number): number => toolbarOverflow({ available: row, widths, movable: MOVABLE_ITEMS, more: 63.3, gap: TOOLBAR_GAP });
	assert.equal(fit(1340), 0, '1440, the full app: everything on the row');
	assert.equal(fit(1088), 0, '1440, the dev tool');
	assert.equal(fit(1062), 0, 'room for the items (1,061.3 px)');
	assert.equal(fit(1061), 1, 'a third of a pixel short: Export and Views go, never a squeezed item (measured: that wrapped Colour by)');
	// The full app with Add documents open: Views alone went to a second row (75 to 109 px), so the row there was at
	// least 986.6 px (everything up to Export) and under 1,061.3. Across that whole range Export and Views go to More.
	for (let row = 987; row <= 1061; row += 1) assert.equal(fit(row), 1, `Add documents open, a ${row} px row: Export and Views in More`);
	assert.equal(fit(981), 1);
	assert.equal(fit(940), 2, 'then Colour by');
	assert.equal(fit(680), 3, 'then Layout');
	assert.equal(fit(580), 4, 'then Points: the query, Table, Advanced and More stay');
	assert.equal(fit(300), 4, 'nothing more can move');
	// Without the view's menus there is nothing to move first.
	assert.equal(toolbarOverflow({ available: 1000, widths: widths.slice(0, 6), movable: MOVABLE_ITEMS.filter((k) => k !== 'extras'), more: 63.3, gap: TOOLBAR_GAP }), 0);
	assert.deepEqual([...MOVABLE_ITEMS], ['extras', 'colour', 'layout', 'points']);
	// Rendered with Export and Views in More (the aside-open width), More open.
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const extras = (
		<>
			<button type="button" data-test-extra="export">Export ▾</button>
			<button type="button" data-test-extra="views">Views ▾</button>
		</>
	);
	const all = html(<MapToolbar {...base} extras={extras} />);
	const rowOf = (markup: string): string => /<div style="([^"]*)" data-map-controls="">/.exec(markup)?.[1] ?? '';
	assert.match(rowOf(all), /display:flex;flex-wrap:nowrap;align-items:center;gap:6px;min-width:0/, 'one row, never wrapped');
	assert.doesNotMatch(all, /MoreControls/, 'no More while everything fits');
	const aside = html(<MapToolbar {...base} extras={extras} initialMoved={1} initialMore />);
	const row = /data-map-controls="">([\s\S]*?)<div style="[^"]*" data-map-status="">/.exec(aside)?.[1] ?? '';
	assert.deepEqual([...row.matchAll(/data-toolbar-item="([a-z]+)"/g)].map((m) => m[1]), ['points', 'layout', 'colour', 'query', 'table', 'advanced', 'more']);
	assert.match(aside, /data-component="MoreControls" data-toolbar-item="more"><button type="button" style="[^"]*" aria-expanded="true" aria-controls="[^"]*">More ▾<\/button><div[^>]*role="group" aria-label="More map controls"[^>]*style="[^"]*max-height:none;overflow-y:visible"[^>]*data-advanced-panel="">/, 'its panel never clips the menus it holds');
	const more = /aria-label="More map controls"([\s\S]*)$/.exec(aside)?.[1] ?? '';
	assert.ok(more.includes('data-test-extra="export"') && more.includes('data-test-extra="views"'), 'Export and Views in More');
	assert.equal((aside.match(/data-test-extra="export"/g) ?? []).length, 1, 'once, not on the row too');
	// Narrow: the selects go too; the query, Table and Advanced stay on the row.
	const narrow = html(<MapToolbar {...base} extras={extras} initialMoved={4} initialMore />);
	const narrowRow = /data-map-controls="">([\s\S]*?)<div style="[^"]*" data-map-status="">/.exec(narrow)?.[1] ?? '';
	assert.deepEqual([...narrowRow.matchAll(/data-toolbar-item="([a-z]+)"/g)].map((m) => m[1]).filter((k) => k !== 'points' && k !== 'layout' && k !== 'colour').slice(0, 4), ['query', 'table', 'advanced', 'more']);
	assert.match(/aria-label="More map controls"([\s\S]*)$/.exec(narrow)?.[1] ?? '', /aria-label="Points"[\s\S]*aria-label="Layout"[\s\S]*aria-label="Colour by"/);
	// The measure: after every render and on every change of the row's width, before paint.
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'MapToolbar.tsx'), 'utf8');
	assert.match(source, /useBrowserLayoutEffect\(\(\) => \{[\s\S]*?fitRef\.current\(\);\s*\}\);/);
	assert.match(source, /new ResizeObserver\(\(\) => fitRef\.current\(\)\)/);
	assert.match(source, /toolbarOverflow\(\{ available: el\.clientWidth,/);
});

test('a move never loses the focus or a menu\'s state: into a closed More the focus goes to More\'s button, back from More to the item; nothing moves while a panel is open or an export runs', () => {
	const movable = MOVABLE_ITEMS;
	// m1: the focused item moves into a closed More: More's button takes the focus.
	assert.equal(focusAfterMove({ from: 0, to: 1, movable, focused: 'extras', onMore: false, lastInMore: null }), 'more');
	assert.equal(focusAfterMove({ from: 1, to: 3, movable, focused: 'layout', onMore: false, lastInMore: null }), 'more');
	assert.equal(focusAfterMove({ from: 0, to: 1, movable, focused: 'query', onMore: false, lastInMore: null }), 'none', 'the focus is on an item that stays');
	assert.equal(focusAfterMove({ from: 1, to: 2, movable, focused: 'layout', onMore: false, lastInMore: null }), 'none', 'Layout stays on the row');
	// m3: back to the row from More (More closed first; its button holds the focus meanwhile): the item takes it again.
	assert.equal(focusAfterMove({ from: 2, to: 1, movable, focused: 'more', onMore: true, lastInMore: 'colour' }), 'item');
	assert.equal(focusAfterMove({ from: 1, to: 0, movable, focused: 'more', onMore: true, lastInMore: 'extras' }), 'item');
	assert.equal(focusAfterMove({ from: 2, to: 1, movable, focused: 'more', onMore: true, lastInMore: 'extras' }), 'none', 'Export and Views stay in More');
	assert.equal(focusAfterMove({ from: 2, to: 1, movable, focused: 'table', onMore: false, lastInMore: 'colour' }), 'none', 'the focus moved on');
	assert.equal(focusAfterMove({ from: 1, to: 1, movable, focused: 'extras', onMore: false, lastInMore: null }), 'none');
	// More closed keeps its items mounted, hidden (a running export, a typed view name survive it closing).
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const closed = html(<MapToolbar {...base} extras={<button type="button" data-test-extra="export">Export ▾</button>} initialMoved={1} />);
	assert.match(closed, /aria-expanded="false">More ▾<\/button><div id="[^"]*" role="group" aria-label="More map controls" tabindex="-1" hidden="" style="[^"]*;display:none;[^"]*"[^>]*data-advanced-panel=""><span style="[^"]*" data-more-extras=""><button type="button" data-test-extra="export">/);
	const toolbar = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'MapToolbar.tsx'), 'utf8');
	// m2: frozen while a toolbar panel is open (an expanded button: More, Export, Views, Advanced) or an export runs;
	// fitted again when they close.
	assert.match(toolbar, /if \(el\.querySelector\('\[aria-expanded="true"\], \[data-export-busy\]'\) !== null\) return;/);
	assert.match(toolbar, /new MutationObserver\(\(\) => fitRef\.current\(\)\)[\s\S]*?attributeFilter: \['aria-expanded', 'data-export-busy'\]/);
	assert.match(toolbar, /component="MoreControls" item="more" menus keepMounted/);
	// The status line's Cancel hands the focus to Layout only on the row (a Layout in a closed More is hidden).
	assert.match(toolbar, /querySelector<HTMLSelectElement>\('\[data-map-controls\] > \[data-toolbar-item="layout"\] select'\)/);
	const exportMenu = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'ExportMenu.tsx'), 'utf8');
	assert.match(exportMenu, /data-export-busy=\{busy \? '' : undefined\}/);
	// A typed view name is kept per connection in memory, so a menu mounted again (a move) still has it.
	const views = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'SavedViewsMenu.tsx'), 'utf8');
	assert.match(views, /const \[name, setNameState\] = useState\(\(\) => draftNames\.get\(connectionKey\) \?\? ''\);/);
	assert.match(views, /if \(next === ''\) draftNames\.delete\(connectionKey\);\s*else draftNames\.set\(connectionKey, next\);/);
	assert.doesNotMatch(views, /localStorage|sessionStorage/);
});

test('a failure on the status line says "Failed:" in words and is the toolbar\'s alert (always there, visually hidden), read once', () => {
	const base = { limits, sample: demo, busy: null, layout: 'pca' as const, colourBy: 'document' as const, lasso: false, table: false, query: { enabled: true, reason: null }, onSample: noop, onLayout: noop, onCancel: noop, onColourBy: noop, onQuery: noop, onToggleLasso: noop, onFit: noop, onToggleTable: noop };
	const line = (markup: string): string => /<div style="([^"]*)" data-map-status="">/.exec(markup)?.[1] ?? '';
	const alert = (markup: string): string | null => /<span role="alert" style="([^"]*)" data-map-alert="">([^<]*)<\/span>/.exec(markup)?.[2] ?? null;
	const failed = html(<MapToolbar {...base} notice={{ text: 'Failed: The store did not finish within its time budget.', failure: true }} />);
	assert.equal(alert(failed), 'Failed: The store did not finish within its time budget.');
	assert.match(failed, /<span role="alert" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect\(0 0 0 0\);white-space:nowrap" data-map-alert="">/, 'visually hidden');
	// On the line, in words; hidden from assistive tech there, since the alert says it.
	assert.match(failed, /<span role="status"[^>]*data-map-notice=""><span aria-hidden="true">Failed: The store did not finish within its time budget\.<\/span><\/span>/);
	// Always there: empty with a plain notice, and with nothing.
	assert.equal(alert(html(<MapToolbar {...base} notice={{ text: 'Layout cancelled. The map shows PCA.' }} />)), '');
	assert.equal(alert(html(<MapToolbar {...base} notice={null} />)), '');
	assert.doesNotMatch(html(<MapToolbar {...base} notice={{ text: 'Layout cancelled. The map shows PCA.' }} />), /aria-hidden="true">Layout/, 'a notice is the status line\'s own');
	assert.equal(line(failed), line(html(<MapToolbar {...base} notice={null} />)), 'the same line');
});

test('the legend collapses to its header row by its own disclosure, open at first; open or collapsed is kept for the session, in memory', () => {
	const legend = (marks: Parameters<typeof markRows>[0] = null): string => html(<Legend sample={demo} colourBy="document" pointCap={2000} backend="pgvector" marks={marks} />);
	const section = (markup: string): string => /<section aria-label="Map legend" style="([^"]*)"/.exec(markup)?.[1] ?? '';
	const open = legend();
	assert.match(open, /<button id="([^"]*)-toggle" type="button" style="[^"]*" aria-expanded="true" aria-controls="\1-body" data-legend-toggle="">▾ Legend<\/button>/);
	assert.match(open, /data-legend-open="1"/);
	assert.ok(section(open).includes(`height:${LEGEND_HEIGHT}px`));
	try {
		rememberLegendOpen(false);
		const shut = legend();
		assert.match(shut, /aria-expanded="false" aria-controls="[^"]*-body" data-legend-toggle="">▴ Legend<\/button>/);
		assert.match(shut, /<div id="[^"]*-body" role="group" aria-labelledby="[^"]*-toggle" hidden=""/, 'the body is hidden, not gone (the disclosure controls it)');
		assert.ok(section(shut).includes(`height:${LEGEND_COLLAPSED_HEIGHT}px`));
		// One fixed row whatever is drawn, the sample line still on it.
		assert.equal(section(legend({ outliers: 3, duplicates: 40, query: { top: 10, drawn: 10 } })), section(shut));
		assert.match(shut, /Showing 1,000 of 1,318 chunks \(random sample\) · 42 docs · seed 7<\/span>/);
	} finally {
		rememberLegendOpen(true);
	}
	// The header row is the box's last child, at its bottom, with the body above it (and before it in the DOM, so Tab
	// goes top to bottom): collapsing removes the body over the button, and the box stays on the panel's bottom, so the
	// button does not move. Measured in Chrome (a client render of the canvas column, 434 px of canvas over the open
	// legend, 1,020 and 767 px wide, four states each): the button moved 0 px across collapse and reopen while the
	// canvas went 434 to 553 and back.
	assert.match(open, /<section aria-label="Map legend"[^>]*><div id="[^"]*-body" role="group"[\s\S]*<\/div><div style="[^"]*"><button id="[^"]*-toggle"[^>]*>▾ Legend<\/button><span[^>]*>[^<]*<\/span><\/div><\/section>$/);
	// The map gains the rest in one step: no transition, one header row of 24 px (and the border).
	assert.equal(LEGEND_HEAD_HEIGHT, 24);
	assert.equal(LEGEND_COLLAPSED_HEIGHT, 25);
	assert.equal(LEGEND_HEIGHT - LEGEND_COLLAPSED_HEIGHT, 119);
	assert.doesNotMatch(section(open), /transition/);
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'Legend.tsx'), 'utf8');
	assert.match(source, /const \[open, setOpen\] = useState\(\(\) => openForSession\);/, 'a new legend starts as the last one was');
	assert.match(source, /rememberLegendOpen\(!open\);\s*setOpen\(!open\);/);
	assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/, 'kept in memory only');
});

test('the legend has one fixed height in every state and scrolls inside itself, a tab stop only while it scrolls, so the map never moves under it', () => {
	const out = html(<Legend sample={demo} colourBy="document" pointCap={2000} backend="pgvector" notes={Array.from({ length: 12 }, (_, i) => `note ${i}`)} />);
	assert.match(out, new RegExp(`<section aria-label="Map legend" style="[^"]*;height:${LEGEND_HEIGHT}px;box-sizing:border-box;flex:none;display:flex;flex-direction:column"`));
	// Its body scrolls under the header row; not measured yet (a server render): no tab stop.
	assert.match(out, /<div id="[^"]*-body" role="group" aria-labelledby="[^"]*-toggle" style="flex:1;min-height:0;overflow-y:auto;padding:8px 10px 0">/);
	assert.doesNotMatch(out, /max-height/, 'a fixed height, not a cap');
	assert.equal(LEGEND_HEIGHT, 144);
	// The same style whatever the legend lists: no marks, a query's marks, every mark.
	const style = (marks: Parameters<typeof markRows>[0]): string => /<section aria-label="Map legend" style="([^"]*)"/.exec(html(<Legend sample={demo} colourBy="document" pointCap={2000} backend="pgvector" marks={marks} />))?.[1] ?? '';
	const none = style(null);
	assert.ok(none.includes(`height:${LEGEND_HEIGHT}px`));
	assert.equal(style({ outliers: 3, duplicates: 40, query: { top: 10, drawn: 10 } }), none);
	assert.equal(style({ edges: { weakest: 'rgb(99, 99, 99)', strongest: 'rgb(206, 206, 206)' }, links: true, outliers: 3, query: { top: 10, drawn: 7 }, duplicates: 40, rings: { scale: 'cosine' } }), none);
	assert.equal(scrollsInside(300, 132), true);
	assert.equal(scrollsInside(132, 132), false);
	assert.equal(scrollsInside(133, 132), false, 'a pixel of rounding is not scrolling');
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'Legend.tsx'), 'utf8');
	assert.match(source, /tabIndex=\{open && scrolls \? 0 : undefined\}/);
	assert.match(source, /new ResizeObserver\(\(\) => measureRef\.current\(\)\)/, 'measured again when its box changes');
	// The stop stays while the legend holds the focus (taking it away would drop the focus to the page), and goes
	// once the focus leaves a legend that no longer scrolls.
	assert.equal(keepTabStop(true, false), true);
	assert.equal(keepTabStop(false, true), true, 'focused: kept, though it stopped scrolling');
	assert.equal(keepTabStop(false, false), false);
	assert.match(source, /setScrolls\(keepTabStop\(scrollsInside\(el\.scrollHeight, el\.clientHeight\), typeof document !== 'undefined' && el\.contains\(document\.activeElement\)\)\)/);
	assert.match(source, /onBlur=\{\(event\) => \{[\s\S]*?setScrolls\(keepTabStop\(scrollsInside\(el\.scrollHeight, el\.clientHeight\), false\)\);/);
});
