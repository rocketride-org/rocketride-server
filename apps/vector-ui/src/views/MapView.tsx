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
// VECTOR-UI — MapView (the Map tab of a connection)
// =============================================================================
//
// The visual half of the explorer: a sample of the collection drawn as points,
// with the node's PCA as the first frame and two refined layouts computed in a
// worker (the seeded neighbour-graph layout, kept only when it keeps at least
// as much of each kNN neighbourhood as PCA; exact t-SNE up to 1,000 points).
// On top of it: hover, click with the 12 nearest chunks of the WHOLE
// collection, a text query placed as a star with rays to the TRUE top-k,
// answer sources and document chunk paths from the console, duplicates and
// outliers, the lasso, a keyboard path and the Table alternative.
//
// What it calls, always on the store node through the connection's Tools
// source (the Chat source on a read-only connection): `sample`, `project`,
// `neighbors`, `search`, `chunks`; and `embed` on the embedding node. The ONE
// raw vector the map handles is the query vector `embed` returns: it stays in
// this view (queryVector) and is sent unchanged to `project`, `search` and
// `neighbors` (scope scores). It passes through map/calls.ts, which forwards a
// call's input untouched; no module under src/map reads or keeps it. The map never
// writes: removals are handed to the console, staged for its pending changes
// where it offers that (actions.stageRemove), else asked of it
// (actions.requestRemove), which confirms them.
//
// Every action lands back in the console: Open document, Ask about these only,
// Remove, and the shared selection (focused chunk, highlights, lasso keys).
//
// Over the sample, computed here with no call (a control over data the
// browser already holds never re-samples):
//   - Clusters: the node's groups (`sample.clusters`, asked for when the node
//     offers them) folded by the Minimum size, coloured, labelled at their
//     medoids and listed in the Clusters tab;
//   - Edges: each point's strongest neighbours or the spanning tree of the
//     sample's kNN graph, plus "Expand selected"; dropped to 3 per point after
//     slow frames unless `edgesAutoDegrade` is off (the perf lane);
//   - Colour by document details from the console's directory rows;
//   - Isolate / Show all / Expand by neighbours.
// A scope the console applies to the map is sent as `filter.object_ids` to
// `sample`, `neighbors` and `recommend` (re-sampling when it changes). Search's
// Compare puts a second question on the map (star B, hollow, with its own
// rays). The view hands the mounted panels their values: the export items
// (points, selection, clusters, duplicates, outliers, the PNG through the
// renderer's snapshot), the saved views' capture and apply, Recommend's call
// (examples as keys; the only vector is the query vector held here), the
// similarity matrix's pair and export, and the inspector's tree neighbours,
// examples and full text.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Banner, Button, EmptyState } from 'shell';
import { ClustersPanel } from '../components/ClustersPanel';
import { DuplicatesPanel } from '../components/DuplicatesPanel';
import { ExportMenu } from '../components/ExportMenu';
import { HeatStrip } from '../components/HeatStrip';
import { Legend } from '../components/Legend';
import { MapToolbar } from '../components/MapToolbar';
import { OutliersPanel } from '../components/OutliersPanel';
import { PointCanvas } from '../components/PointCanvas';
import { PointInspector } from '../components/PointInspector';
import { PointsTable } from '../components/PointsTable';
import { RecommendPanel } from '../components/RecommendPanel';
import { SavedViewsMenu } from '../components/SavedViewsMenu';
import { SimilarityMatrix } from '../components/SimilarityMatrix';
import { recommendExamples } from '../adapters/connections';
import type { Availability, ClusterMinSize, ColourBy, EdgeMode, EdgesPerPoint, ExamplePolarity, IChunksResult, IDocumentItem, IDocumentRowsSource, IEmbedResult, IExportItem, INeighborsResult, INeighborsScopeResult, IProjectItem, IProjectResult, IRecommendExamples, IRecommendRequest, IRecommendResult, ISampleInput, ISampleResult, ISavedView, ISavedViewRestore, ISavedViewState, ISearchResult, MapLayout, MapViewProps as ContractMapViewProps, SampleMode, SelectionState, ToolOutcome, VectorKey } from '../contract/types';
import { TSNE_MAX_POINTS } from '../map/budgets';
import { callRecommend, callTool, isExpired } from '../map/calls';
import type { ToolAnswer } from '../map/calls';
import type { MapCamera } from '../map/camera';
import { forgetCameras, recallCamera } from '../map/cameraMemory';
import { DEFAULT_MIN_CLUSTER_SIZE, clusterLabel, clusterRows, clusterSentence, clusterView, medoids } from '../map/clusters';
import { COLOUR_MODES, clusterColours, colourAfterQuery, colourForQuery, colourModeReason, colourPoints } from '../map/colours';
import type { MapColourBy } from '../map/colours';
import { groupOf, groups, pairsAt } from '../map/dedupe';
import { NO_EDGES, edgeStats, edgesOf, mergeEdges, spanningTree, topEdges, treeNeighbours } from '../map/graph';
import { tweenPositions } from '../map/interaction';
import type { KeyAction } from '../map/interaction';
import { CLEAR_LABELS, clearStep, combineMasks, dimMask, expandByNeighbours, isolateMask, isolationLine, shownCount } from '../map/isolate';
import { UNSCOPED, applyTransform, chunkPath, clusterExportRows, ditherRounded, documentOf, drawnScope, duplicateExportRows, hiddenMask, keyIndex, keyString, mapScopeState, neighboursOf, normaliseLayout, pcaPositions, pointExportRows, pointKey, removeTargetsOf, scopeDrawDue } from '../map/model';
import type { ISampleScope, IScopeAttempt } from '../map/model';
import { createLatestQueue } from '../map/neighbours';
import { EDGE_BUCKETS, edgeColours } from '../map/overlay';
import type { IClusterLabel, IDuplicateRing, IOverlayEnd, IPlace } from '../map/overlay';
import { centroidStar, chatQueryPlan, comparePlan, onSample, placeCompared, placeProjected, projectOn, queryBlocker, querySims, raysFromSearch, resolveKeys, starFromProject } from '../map/queryProjection';
import type { IStar } from '../map/queryProjection';
import { polarityOf } from '../map/recommend';
import { pairLabel, pairScale, stagedAnnouncement } from '../map/reviewWording';
import { spawnLayoutWorker } from '../map/spawnWorker';
import { MAP_STYLES } from '../map/styles';
import { FALLBACK_PALETTE, readPalette } from '../map/tokens';
import type { IMapPalette } from '../map/tokens';
import { createLayoutClient } from '../map/workerClient';
import type { ILayoutClient } from '../map/workerClient';
import { BUSY, CENTROID_APPROX, CLUSTERS_UNSUPPORTED, EDGES_DEGRADED, EDGES_LIGHT_LIMIT, EDGES_LIGHT_NOTE, LAYOUT_CANCELLED, LAYOUT_NOT_BETTER, LIGHT_POSITIONS, MAP_UNAVAILABLE, QUERY_NEEDS_EMBED, QUERY_PLACED_APPROX, QUERY_SAMPLE_CHANGED, STAR_B_NEEDS_PROJECT, STAR_B_SAMPLE_CHANGED, clusterAnnouncement, edgeLegend, failedLine, listingNote, mapFailure, num, pointAnnouncement, sampleLabel, SCOPE_RETRY, scopeLine, starBNotPlaced, statusNotice } from '../map/wording';
import { heatScores } from '../vector/heat';

/** How many writes the console ran on the store (the connection's write count). */
export interface IWriteCountSource {
	get(): number;
	subscribe(listener: () => void): () => void;
}

/** Props: the frozen ones plus where the Table toggle and the side panel start, and the console's write count. */
export interface MapViewProps extends ContractMapViewProps {
	/** A change means a write (to the trash, out of it, deleted) changed what a sample holds: the shown sample is drawn again. */
	writes?: IWriteCountSource | null;
	/** Open with the Table alternative shown (only the toggle's starting state; off when not given). */
	initialTable?: boolean;
	/** The side panel's first tab (only its starting state; 'point' when not given). */
	initialTab?: SideTab;
	/** The Clusters tab's first minimum size (only its starting state; 5 when not given). */
	initialMinClusterSize?: ClusterMinSize;
	/** The first colouring (only its starting state; Document when not given). */
	initialColourBy?: MapColourBy;
}

// =============================================================================
// CONSTANTS AND HOOKS
// =============================================================================

/** The first sample's seed (the toolbar's "New sample" moves it on). */
const DEFAULT_SEED = 7;

/** Neighbours listed for a clicked point. */
const NEIGHBOURS_K = 12;

/** Nearest sample points `project` returns per item. */
const PROJECT_M = 10;

/** Results of the true top-k search behind the rays. */
const RAYS_TOP_K = 10;

/** Duplicate pairs drawn at most (the panel lists them all). */
const MAX_DRAWN_DUPLICATES = 200;

/** The similarity the Points table's duplicate groups use (the queue's default threshold). */
const TABLE_DUPLICATE_THRESHOLD = 0.97;

/** A chunk's full text is shown up to this many characters. */
const FULL_TEXT_MAX = 20_000;

/** Recommend examples per side when the node does not say (contract section 4.4-D). */
const RECOMMEND_EXAMPLES_DEFAULT = 10;

/** No directory rows (a map mounted without the console's source). */
const NO_ROWS: readonly IDocumentItem[] = [];

/**
 * What the map knows of each sample answer: the scope it was drawn with, and
 * the last draw tried over it while it was on screen. Kept beside the answer
 * object, which the selection store holds across tab switches and remounts (the
 * frozen sample model has no field for it), so the legend and data-scoped state
 * only the scope the points on screen were drawn with. An answer the map did not
 * draw itself counts as drawn from the whole collection.
 */
const SAMPLE_SCOPES = new WeakMap<ISampleResult, ISampleScope>();

/** An answer the map has no record of. */
const NOT_RECORDED: ISampleScope = Object.freeze({ drawn: UNSCOPED, attempt: null });

/**
 * What the map knows of a sample answer's scope.
 *
 * @param result - The answer on screen, if any.
 * @returns Its drawn scope and the last draw tried over it.
 */
function scopeOfSample(result: ISampleResult | null | undefined): ISampleScope {
	return (result ? SAMPLE_SCOPES.get(result) : undefined) ?? NOT_RECORDED;
}
const NO_ROWS_SOURCE: IDocumentRowsSource = { getRows: () => NO_ROWS, subscribe: () => () => undefined };

/**
 * The highlights the Duplicates tab's "Show group" set: their pairs are ringed with their similarity while one of
 * them is the highlight shown. Kept beside the highlight object, which the selection store holds across tab switches
 * and remounts (its frozen shape has no field for it), the way SAMPLE_SCOPES is.
 */
const DUPLICATE_GROUPS = new WeakSet<NonNullable<SelectionState['highlight']>>();

/** No console around the map: no write ever happens. */
const NO_WRITES: IWriteCountSource = { get: () => 0, subscribe: () => () => undefined };

/**
 * A colouring as a saved view keeps it. The saved view's field is the
 * contract's ColourBy; the document-detail modes (ingest date, file size,
 * health, ingest node, table chunks) are kept under their own names, which the
 * view reads back as they were saved.
 *
 * @param by - The colouring.
 * @returns The value saved.
 */
function savedColour(by: MapColourBy): ColourBy {
	return by as ColourBy;
}

/**
 * A saved colouring read back: one of the map's modes, else Document.
 *
 * @param by - The saved value.
 * @returns The colouring.
 */
function restoredColour(by: string): MapColourBy {
	return COLOUR_MODES.some((m) => m.id === by) ? (by as MapColourBy) : 'document';
}

/** Side panel tabs. */
export type SideTab = 'point' | 'neighbours' | 'duplicates' | 'outliers' | 'clusters' | 'recommend' | 'selection' | 'heat';

const TABS: Array<{ id: SideTab; label: string }> = [
	{ id: 'point', label: 'Point' },
	{ id: 'neighbours', label: 'Neighbours' },
	{ id: 'duplicates', label: 'Duplicates' },
	{ id: 'outliers', label: 'Outliers' },
	{ id: 'clusters', label: 'Clusters' },
	{ id: 'recommend', label: 'Recommend' },
	{ id: 'selection', label: 'Selection' },
	{ id: 'heat', label: 'Heat strip' },
];

/** No Recommend examples yet. */
const NO_EXAMPLES: IRecommendExamples = { positive: [], negative: [], withQuery: false };

/**
 * The map palette, re-read when the shell switches theme (it writes tokens onto the root element).
 *
 * @returns The palette, or null outside a browser.
 */
function useMapPalette(): IMapPalette | null {
	const read = (): IMapPalette | null => {
		if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
		const style = getComputedStyle(document.documentElement);
		return readPalette((token) => style.getPropertyValue(token));
	};
	const [palette, setPalette] = useState<IMapPalette | null>(read);
	useEffect(() => {
		if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
		const observer = new MutationObserver(() => setPalette(read()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
		setPalette(read());
		return () => observer.disconnect();
	}, []);
	return palette;
}

/**
 * Whether the system asks for reduced motion (tracks changes; Safari 13 has only addListener).
 *
 * @returns True under `prefers-reduced-motion: reduce`.
 */
function useReducedMotion(): boolean {
	const query = '(prefers-reduced-motion: reduce)';
	const [reduced, setReduced] = useState<boolean>(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
	useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
		const media = window.matchMedia(query);
		const onChange = (): void => setReduced(media.matches);
		onChange();
		if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
		else media.addListener(onChange);
		return () => {
			if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange);
			else media.removeListener(onChange);
		};
	}, []);
	return reduced;
}

/** The query placed on the map (never the vector itself). */
interface IQueryView {
	text: string;
	/** The `project({vector})` item (PCA coordinates and nearest sample points). */
	item: IProjectItem | null;
	/** Similarity of the query to every sample point. */
	sims: Float32Array | null;
	/** The true top-k of the whole collection. */
	search: ISearchResult | null;
	/** Lines for the legend (model mismatch, keyword fallback). */
	notes: string[];
}

/** A refined layout's raw positions. */
interface IRefined {
	layout: MapLayout;
	sampleId: string;
	positions: Float32Array;
}

/** What a layout run lays out: a sample, its seed and its points not shown. */
interface ILayoutTarget {
	sample: ISampleResult;
	seed: number;
	/** 1 for a point not shown (a removed document, the isolation), or null. */
	hidden: Uint8Array | null;
}

/** The layout's state, for the toolbar and the lanes. */
type LayoutState = 'idle' | 'running' | 'done' | 'kept-pca' | 'cancelled' | 'refused' | 'failed' | 'unavailable';

/** Props of the Selection tab. */
export interface SelectionTabProps {
	/** The lasso selection (one key per point). */
	keys: readonly VectorKey[];
	chat: Availability;
	writes: Availability;
	/** "Ask about these only": the documents of the selection. */
	onAskAbout(objectIds: readonly string[]): void;
	/** "Move these documents to the trash": EVERY document of the selection; the console confirms and batches the writes (APP_SPEC §6). */
	onRemove(objectIds: readonly string[]): void;
	/** The console stages removals (its pending changes apply them): the button says so. */
	staging?: boolean;
	onCopy(keys: readonly VectorKey[]): void;
	/** Show only the selected points on the map; absent: no such button. */
	onIsolate?(keys: readonly VectorKey[]): void;
	/** The map is isolated: points shown of the sample. */
	isolated?: { shown: number; n: number } | null;
	onShowAll?(): void;
	onExpand?(): void;
	/** What the tab shows under its actions (the similarity matrix of the selection). */
	children?: React.ReactNode;
}

/**
 * The Selection tab: what the lasso selected and what can be done with it.
 *
 * @param props - The selection and the actions.
 * @returns The tab body.
 */
export function SelectionTab(props: SelectionTabProps): React.ReactElement {
	const { keys, chat, writes } = props;
	if (keys.length === 0) return <p style={MAP_STYLES.note}>Turn on the lasso (L) and draw around points to select them.</p>;
	const docs = Array.from(new Set(keys.map((k) => k[0])));
	return (
		<section aria-label="Selected points">
			<p style={MAP_STYLES.text}>
				{num(keys.length)} points selected from {num(docs.length)} documents.
			</p>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
				<button type="button" style={MAP_STYLES.button} disabled={!chat.enabled} onClick={() => props.onAskAbout(docs)}>
					Ask about these only
				</button>
				<button type="button" style={MAP_STYLES.button} disabled={!writes.enabled} onClick={() => props.onRemove(docs)}>
					{props.staging ? 'Stage these documents for the trash' : 'Move these documents to the trash'}
				</button>
				<button type="button" style={MAP_STYLES.button} onClick={() => props.onCopy(keys)}>
					Copy keys
				</button>
				{props.onIsolate ? (
					<button type="button" style={MAP_STYLES.button} onClick={() => props.onIsolate?.(keys)}>
						Isolate
					</button>
				) : null}
			</div>
			{props.isolated ? (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '0 0 8px' }}>
					<span role="status" style={MAP_STYLES.small}>
						{isolationLine(props.isolated.shown, props.isolated.n)}
					</span>
					<button type="button" style={MAP_STYLES.button} onClick={props.onExpand}>
						Expand by neighbours
					</button>
					<button type="button" style={MAP_STYLES.button} onClick={props.onShowAll}>
						Show all
					</button>
				</div>
			) : null}
			{!writes.enabled && writes.reason ? <p style={MAP_STYLES.note}>{writes.reason}</p> : null}
			{!chat.enabled && chat.reason ? <p style={MAP_STYLES.note}>{chat.reason}</p> : null}
			{props.children ?? null}
		</section>
	);
}

/** Said when the window does not allow the clipboard (a VS Code webview may not). */
export const COPY_KEYS_BLOCKED = 'Copying is not allowed in this window, so the keys were not copied.';

// =============================================================================
// VIEW
// =============================================================================

/**
 * The Map tab.
 *
 * @param props - The connection model, its channels, the shared selection, console actions, visibility.
 * @returns The map.
 */
export function MapView(props: MapViewProps): React.ReactElement {
	const { model, channels, selection, actions, visible, initialTable, initialTab } = props;
	const edgesAutoDegrade = props.edgesAutoDegrade !== false;
	const state = useSyncExternalStore(selection.subscribe, selection.getState, selection.getState);
	const palette = useMapPalette();
	const reducedMotion = useReducedMotion();
	const limits = model.limits;
	const channel = channels.tools ?? channels.chat ?? channels.ingest;
	const embedChannel = channels.tools ?? channels.chat;
	const embedReady = embedChannel !== null && !!model.nodes.embed && model.embed.enabled;
	const storeNode = model.nodes.store;
	const canSample = model.capabilities.sample !== false;
	const sampleModel = state.sampleModel !== null && state.connectionKey === model.connectionKey ? state.sampleModel : null;
	const sample = sampleModel?.result ?? null;
	const backend = model.connection.dialect?.backend ?? null;

	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [layout, setLayout] = useState<MapLayout>('pca');
	const [refined, setRefined] = useState<IRefined | null>(null);
	const [layoutState, setLayoutState] = useState<LayoutState>('idle');
	const [layoutProgress, setLayoutProgress] = useState<number | null>(null);
	const [quality, setQuality] = useState<{ overlap: number; pcaOverlap: number } | null>(null);
	const [colourBy, setColourBy] = useState<MapColourBy>(props.initialColourBy ?? 'document');
	// The colouring a text query replaced, restored when the query clears (Document stays the default).
	const colourBefore = useRef<MapColourBy | null>(null);
	const [minClusterSize, setMinClusterSize] = useState<ClusterMinSize>(props.initialMinClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);
	const [edges, setEdges] = useState<EdgeMode>(props.edges ?? 'none');
	const [edgesM, setEdgesM] = useState<EdgesPerPoint>(props.edgesM ?? 5);
	const [edgesDegraded, setEdgesDegraded] = useState(false);
	/** Points whose own kNN edges are added ("Expand selected"). */
	const [expanded, setExpanded] = useState<number[]>([]);
	/** The isolated points, or null when every point is shown. */
	const [isolated, setIsolated] = useState<number[] | null>(null);
	/** Search's compared question (star B), placed like the query. */
	const [queryB, setQueryBView] = useState<IQueryView | null>(null);
	const [fullText, setFullText] = useState<{ key: string; text: string } | null>(null);
	const [matrixItem, setMatrixItem] = useState<IExportItem | null>(null);
	const [cameraOverride, setCameraOverride] = useState<{ camera: MapCamera; seq: number } | null>(null);
	const [savedQuery, setSavedQuery] = useState<string | null>(null);
	const [canSnapshot, setCanSnapshot] = useState(false);
	const [lasso, setLasso] = useState(false);
	const [table, setTable] = useState(initialTable === true);
	const [threeD, setThreeD] = useState(false);
	const [tab, setTab] = useState<SideTab>(initialTab ?? 'point');
	const [examples, setExamplesState] = useState<IRecommendExamples>(() => recommendExamples.get(model.connectionKey) ?? NO_EXAMPLES);
	const [selected, setSelected] = useState<number | null>(null);
	const [focused, setFocused] = useState<number | null>(null);
	const [neighbours, setNeighbours] = useState<{ index: number; result: INeighborsResult } | null>(null);
	const [neighbourPins, setNeighbourPins] = useState<IProjectItem[]>([]);
	const [neighbourBusy, setNeighbourBusy] = useState(false);
	const [neighbourError, setNeighbourError] = useState<string | null>(null);
	const [chunkText, setChunkText] = useState<{ key: string; text: string } | null>(null);
	const [query, setQueryView] = useState<IQueryView | null>(null);
	/** Whether a placed query fades the points outside its top-k (a Clear turns it off until the next query). */
	const [queryDims, setQueryDims] = useState(true);
	/** True while a chat answer's question is being embedded and placed (no star until it lands, or fails). */
	const [placingAnswer, setPlacingAnswer] = useState(false);
	const [heat, setHeat] = useState<{ objectId: string; chunks: number; scores: Array<{ chunkId: number; sim: number }> } | null>(null);
	const [fitToken, setFitToken] = useState(0);
	const [centreOn, setCentreOn] = useState<{ index: number; seq: number } | null>(null);
	const [pulse, setPulse] = useState(0);
	const [rendererKind, setRendererKind] = useState<'webgl' | 'canvas2d' | 'none'>('none');

	// The one query vector (from `embed`), kept here and sent only to project / search / neighbors / recommend.
	const queryVector = useRef<number[] | null>(null);
	// The compared question's vector (Search's Compare), sent only to project and search.
	const queryVectorB = useRef<number[] | null>(null);
	// The PNG's copy of the edge layer, the points and the overlay (PointCanvas reports it).
	const snapshotter = useRef<(() => HTMLCanvasElement | null) | null>(null);
	const onSnapshotter = useCallback((snap: (() => HTMLCanvasElement | null) | null): void => {
		snapshotter.current = snap;
		setCanSnapshot(snap !== null);
	}, []);
	// The console's scope as the map applies it: its documents, when it applies to the map and fits the limit.
	const scope = model.scope ?? null;
	const scopeIds = scope && scope.applyTo.map && scope.overflow === null && scope.objectIds !== null && scope.objectIds.length > 0 && scope.objectIds.length <= limits.scope_keys_max ? scope.objectIds : null;
	const scopeTarget = drawnScope(scopeIds, scope?.label ?? '');
	const scopeRef = useRef<readonly string[] | null>(scopeIds);
	scopeRef.current = scopeIds;
	const scopeTargetRef = useRef(scopeTarget);
	scopeTargetRef.current = scopeTarget;
	// The scope the points on screen were drawn with, and how the console's scope stands over them.
	const shownScope = scopeOfSample(sampleModel?.result);
	const scopeState = mapScopeState(scopeTarget.key, shownScope);
	const docRows = useSyncExternalStore((props.documents ?? NO_ROWS_SOURCE).subscribe, (props.documents ?? NO_ROWS_SOURCE).getRows, (props.documents ?? NO_ROWS_SOURCE).getRows);
	// The console's write count, and the count the sample on screen was drawn at (each draw notes it).
	const writes = useSyncExternalStore((props.writes ?? NO_WRITES).subscribe, (props.writes ?? NO_WRITES).get, (props.writes ?? NO_WRITES).get);
	const writesRef = useRef(writes);
	writesRef.current = writes;
	const drawnWrites = useRef(writes);
	const docRowMap = useMemo(() => new Map(docRows.map((row) => [row.objectId, row])), [docRows]);
	const connectionRef = useRef(model.connectionKey);
	connectionRef.current = model.connectionKey;
	const autoSampled = useRef<string | null>(null);
	// A point to inspect again once a re-drawn sample arrives (its neighbour ends met SAMPLE_EXPIRED).
	const repick = useRef<{ key: string; drawnAt: number } | null>(null);
	const seq = useRef(0);
	const clientRef = useRef<ILayoutClient | null>(null);
	if (clientRef.current === null) clientRef.current = createLayoutClient({ createWorker: spawnLayoutWorker });
	const client = clientRef.current;
	useEffect(() => () => client.dispose(), [client]);

	const neighbourQueue = useMemo(
		() =>
			channel === null
				? null
				: createLatestQueue<VectorKey, ToolAnswer<INeighborsResult>>((key) => {
						const scoped = scopeRef.current;
						return callTool<INeighborsResult>(channel, 'neighbors', { key, k: Math.min(NEIGHBOURS_K, limits.neighbors_k_max), exclude_self: true, ...(scoped ? { filter: { object_ids: [...scoped] } } : {}) }, { nodeId: storeNode });
					}),
		[channel, storeNode, limits.neighbors_k_max],
	);
	useEffect(() => () => neighbourQueue?.dispose(), [neighbourQueue]);

	// -------------------------------------------------------------------------
	// Derived data
	// -------------------------------------------------------------------------

	/** Removed documents' points (never shown again in this sample). */
	const removedMask = useMemo(() => (sampleModel ? hiddenMask(sampleModel) : null), [sampleModel]);
	/** Every point not shown: removed documents and the isolation. */
	const hidden = useMemo(() => combineMasks(removedMask, isolated !== null && sample ? isolateMask(sample.n, isolated) : null), [removedMask, isolated, sample]);
	const shownPoints = sample ? shownCount(sample.n, hidden) : 0;
	const clusters = useMemo(() => (sample?.clusters ? clusterView(sample.clusters, minClusterSize) : null), [sample, minClusterSize]);
	// Edges: computed from the sample's kNN graph (no call).
	const lightCap = sample !== null && sample.mode === 'light' && sample.n > EDGES_LIGHT_LIMIT;
	const edgesPerPoint: EdgesPerPoint = lightCap || edgesDegraded ? 3 : edgesM;
	const tree = useMemo(() => (sample && edges === 'tree' ? spanningTree(sample.knn, sample.n, hidden) : null), [sample, edges, hidden]);
	const edgeSet = useMemo(() => {
		if (!sample) return null;
		const base = edges === 'neighbours' ? topEdges(sample.knn, sample.n, edgesPerPoint, hidden) : tree ? tree.edges : NO_EDGES;
		const merged = mergeEdges(base, ...expanded.map((i) => edgesOf(sample.knn, sample.n, i, hidden)));
		return merged.count === 0 ? null : merged;
	}, [sample, edges, edgesPerPoint, hidden, tree, expanded]);
	const keyIdx = useMemo(() => (sample ? keyIndex(sample) : new Map<string, number>()), [sample]);
	const dims: 2 | 3 = threeD && layout === 'pca' ? 3 : 2;
	const raw = useMemo(() => {
		if (!sample) return new Float32Array(0);
		if (layout !== 'pca' && refined !== null && refined.sampleId === sample.sample_id && refined.layout === layout) return refined.positions;
		const pca = pcaPositions(sample, dims);
		// Light samples carry 2-decimal coordinates: spread them within their rounding step.
		return sample.mode === 'light' ? ditherRounded(pca, 0.01, sampleModel?.seed ?? DEFAULT_SEED) : pca;
	}, [sample, sampleModel, layout, refined, dims]);
	const frame = useMemo(() => normaliseLayout(raw, dims, hidden), [raw, dims, hidden]);

	// Layout changes tween (never under reduced motion).
	const [shown, setShown] = useState<Float32Array>(frame.positions);
	const shownRef = useRef(shown);
	shownRef.current = shown;
	useEffect(() => {
		const from = shownRef.current;
		const to = frame.positions;
		if (reducedMotion || from.length !== to.length || from.length === 0 || typeof requestAnimationFrame !== 'function') {
			setShown(to);
			return undefined;
		}
		let raf = 0;
		const started = performance.now();
		const step = (): void => {
			const t = Math.min(1, (performance.now() - started) / 450);
			setShown(t >= 1 ? to : tweenPositions(from, to, t));
			if (t < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [frame, reducedMotion]);

	const colouring = useMemo(() => (sample && palette ? colourPoints(sample, colourBy, palette, { querySims: query?.sims ?? null, hidden, clusters, docRows: docRowMap }) : null), [sample, palette, colourBy, query, hidden, clusters, docRowMap]);
	const colourReasons = useMemo(() => {
		const out: Partial<Record<MapColourBy, string | null>> = {};
		if (sample) for (const mode of COLOUR_MODES) out[mode.id] = colourModeReason(mode.id, { sample, clustersOffered: model.capabilities.clusters === true, docRows: docRowMap });
		return out;
	}, [sample, model.capabilities.clusters, docRowMap]);
	const clusterPalette = useMemo(() => (clusters && palette ? clusterColours(clusters.count, palette).map((c) => c.colour) : []), [clusters, palette]);
	const highlight = state.connectionKey === model.connectionKey ? state.highlight : null;
	const place = useCallback((p: { x: number; y: number; z?: number } | null): IPlace | null => (p === null ? null : applyTransform(p, frame.transform)), [frame]);

	// Query star and rays (positions in raw layout units, then into the display frame).
	const star: IStar | null = useMemo(() => {
		if (!sample) return null;
		if (query?.item) {
			const s = starFromProject(query.item, layout, raw, dims);
			return s ? { ...applyTransform(s, frame.transform), exact: s.exact } : null;
		}
		if (highlight?.source === 'chat') {
			if (placingAnswer) return null;
			// The labelled fallback: the answer's question could not be placed (no embedding node, or it failed).
			const res = resolveKeys(highlight.keys, keyIdx, sampleModel?.pinned ?? []);
			const s = centroidStar(res.points, raw, dims);
			return s ? { ...applyTransform(s, frame.transform), exact: false } : null;
		}
		return null;
	}, [sample, query, layout, raw, dims, frame, highlight, keyIdx, sampleModel, placingAnswer]);

	const pinnedPlaces = useMemo(() => (sampleModel?.pinned ?? []).map((item) => place(placeProjected(item, layout, raw, dims))), [sampleModel, layout, raw, dims, place]);
	const rays: IOverlayEnd[] = useMemo(() => {
		if (!query?.search || !sampleModel) return [];
		return raysFromSearch(query.search, keyIdx, sampleModel.pinned).targets.flatMap((t): IOverlayEnd[] => {
			if (t.kind === 'point') return [{ index: t.index }];
			if (t.kind === 'pinned') {
				const at = pinnedPlaces[t.pinned];
				return at ? [{ at }] : [];
			}
			return [];
		});
	}, [query, sampleModel, keyIdx, pinnedPlaces]);

	// Search's compared question: star B (hollow) and its rays to its own top results.
	const starB: IStar | null = useMemo(() => {
		if (!sample || !queryB?.item) return null;
		const s = starFromProject(queryB.item, layout, raw, dims);
		return s ? { ...applyTransform(s, frame.transform), exact: s.exact } : null;
	}, [sample, queryB, layout, raw, dims, frame]);
	const raysB: IOverlayEnd[] = useMemo(() => {
		if (!queryB?.search || !sampleModel) return [];
		return raysFromSearch(queryB.search, keyIdx, sampleModel.pinned).targets.flatMap((t): IOverlayEnd[] => {
			if (t.kind === 'point') return [{ index: t.index }];
			if (t.kind === 'pinned') {
				const at = pinnedPlaces[t.pinned];
				return at ? [{ at }] : [];
			}
			return [];
		});
	}, [queryB, sampleModel, keyIdx, pinnedPlaces]);

	// Cluster labels at their medoids (on the layout shown), largest groups first, labelled groups only.
	const clusterLabels: IClusterLabel[] = useMemo(() => {
		if (!clusters || !sample || (colourBy !== 'cluster' && tab !== 'clusters')) return [];
		const at = medoids(frame.positions, dims, clusters, hidden);
		const out: IClusterLabel[] = [];
		for (let g = 0; g < clusters.count; g += 1) {
			if ((clusters.keywords[g] ?? []).length === 0 || (at[g] as number) < 0) continue;
			out.push({ cluster: g, at: at[g] as number, text: clusterLabel(clusters, g) });
		}
		return out;
	}, [clusters, sample, colourBy, tab, frame, dims, hidden]);

	const ringPoints = useMemo(() => {
		if (!highlight || highlight.source === 'lasso' || highlight.source === 'document') return [];
		return resolveKeys(highlight.keys, keyIdx, sampleModel?.pinned ?? []).points;
	}, [highlight, keyIdx, sampleModel]);
	const emphasised = useMemo(() => {
		if (!sample || !highlight || (highlight.source !== 'lasso' && highlight.source !== 'document')) return null;
		const mask = new Uint8Array(sample.n);
		for (const i of resolveKeys(highlight.keys, keyIdx, []).points) mask[i] = 1;
		return mask;
	}, [sample, highlight, keyIdx]);
	const documentPath = useMemo(() => {
		if (!sample || highlight?.source !== 'document' || highlight.keys.length === 0) return [];
		return chunkPath(sample, highlight.keys[0]?.[0] as string);
	}, [sample, highlight]);

	const neighbourEnds: IOverlayEnd[] = useMemo(() => {
		if (!neighbours || neighbours.index !== selected || !sampleModel) return [];
		const pins = new Map(neighbourPins.filter((p) => p.key).map((p) => [keyString(p.key![0], p.key![1]), p]));
		return neighbours.result.items.flatMap((item): IOverlayEnd[] => {
			const i = keyIdx.get(keyString(item.key[0], item.key[1]));
			if (i !== undefined) return [{ index: i }];
			const pin = pins.get(keyString(item.key[0], item.key[1]));
			const at = pin ? place(placeProjected(pin, layout, raw, dims)) : null;
			return at ? [{ at }] : [];
		});
	}, [neighbours, selected, sampleModel, neighbourPins, keyIdx, place, layout, raw, dims]);

	// The shown duplicate group: its pairs (both ends shown) get rings and their similarity, while the Duplicates tab
	// shows it and its highlight is still the one on the map.
	const duplicateRings: IDuplicateRing[] = useMemo(() => {
		if (!sample || tab !== 'duplicates' || highlight === null || !DUPLICATE_GROUPS.has(highlight)) return [];
		const group = new Set(resolveKeys(highlight.keys, keyIdx, []).points);
		return sample.duplicates.filter((d) => group.has(d.a) && group.has(d.b) && !(hidden && (hidden[d.a] || hidden[d.b]))).slice(0, MAX_DRAWN_DUPLICATES).map((d) => ({ a: d.a, b: d.b, label: pairLabel(d.sim, sample.metric) }));
	}, [sample, tab, highlight, keyIdx, hidden]);

	// Everything outside the set the map is showing is drawn faded: a selection with its neighbours, else a
	// highlighted set, else a placed query's top-k.
	const queryTop = useMemo(() => (queryDims ? rays.flatMap((e) => (e.index !== undefined ? [e.index] : [])) : []), [queryDims, rays]);
	const dimmed = useMemo(() => {
		if (!sample) return null;
		return dimMask(sample.n, {
			selected,
			neighbours: neighbourEnds.flatMap((e) => (e.index !== undefined ? [e.index] : [])),
			highlight: highlight ? resolveKeys(highlight.keys, keyIdx, []).points : null,
			queryTop,
		});
	}, [sample, selected, neighbourEnds, highlight, keyIdx, queryTop]);
	// A new question fades the rest again (its text: the search landing on the same query does not undo a Clear).
	useEffect(() => setQueryDims(true), [query?.text]);

	// What the legend's glyph row lists: only the marks drawn now.
	const edgePalette = useMemo(() => edgeColours(palette ?? FALLBACK_PALETTE), [palette]);
	const legendMarks = useMemo(() => {
		if (!sample) return null;
		const shownPair = (d: { a: number; b: number }): boolean => !(hidden && (hidden[d.a] || hidden[d.b]));
		return {
			edges: edgeSet ? { weakest: edgePalette[0] as string, strongest: edgePalette[EDGE_BUCKETS - 1] as string } : null,
			links: selected !== null && neighbourEnds.length > 0,
			outliers: sample.outliers.filter((i) => !(hidden && hidden[i])).length,
			query: star && query?.search ? { top: query.search.results.length, drawn: rays.length } : null,
			duplicates: sample.duplicates.slice(0, MAX_DRAWN_DUPLICATES).filter(shownPair).length,
			rings: duplicateRings.length > 0 ? { scale: pairScale(sample.metric) } : null,
		};
	}, [sample, hidden, edgeSet, edgePalette, selected, neighbourEnds, star, query, rays, duplicateRings]);

	const overlay = useMemo(
		() => ({
			selected,
			focused,
			highlight: ringPoints,
			neighbours: neighbourEnds,
			hollow: [...pinnedPlaces, ...neighbourEnds.flatMap((e) => (e.at ? [e.at] : []))].filter((p): p is IPlace => p !== null),
			star,
			rays,
			chunkPath: documentPath,
			duplicates: (sample?.duplicates ?? []).slice(0, MAX_DRAWN_DUPLICATES).map((d): [number, number] => [d.a, d.b]),
			duplicateRings,
			outliers: sample?.outliers ?? [],
			pulse,
		}),
		[selected, focused, ringPoints, neighbourEnds, pinnedPlaces, star, rays, documentPath, sample, duplicateRings, pulse],
	);

	// -------------------------------------------------------------------------
	// Sampling
	// -------------------------------------------------------------------------

	/** Forget everything drawn on top of a sample. */
	const resetView = useCallback((keepQuery: boolean): void => {
		setLayout('pca');
		setRefined(null);
		setLayoutState('idle');
		setLayoutProgress(null);
		setQuality(null);
		setSelected(null);
		setFocused(null);
		setNeighbours(null);
		setNeighbourPins([]);
		setChunkText(null);
		setFullText(null);
		setHeat(null);
		setExpanded([]);
		setIsolated(null);
		setEdgesDegraded(false);
		setMatrixItem(null);
		// Star B goes with every new sample, even one drawn again for the query (its place is in the old basis);
		// the next showing places it on this one.
		setQueryBView(null);
		queryVectorB.current = null;
		if (!keepQuery) {
			setQueryView(null);
			queryVector.current = null;
			setColourBy((by) => colourAfterQuery(by, colourBefore.current));
		}
	}, []);

	/** Draw a sample; resolves its id, or null on failure. */
	const drawSample = useCallback(
		async (opts: { n: number; mode: SampleMode; seed: number; includeKeys?: VectorKey[]; keepQuery?: boolean }): Promise<string | null> => {
			if (channel === null) return null;
			const key = model.connectionKey;
			const light = opts.mode === 'light';
			const input: ISampleInput = {
				n: opts.n,
				seed: opts.seed,
				strategy: 'stratified',
				mode: opts.mode,
				knn_k: Math.min(light ? 10 : 15, limits.knn_k_max),
				components: 3,
				duplicate_threshold: 0.97,
				include_text: !light,
				...(opts.includeKeys && opts.includeKeys.length > 0 ? { include_keys: opts.includeKeys } : {}),
				// Clusters are asked only of a node that offers them (an older one would refuse the key).
				...(model.capabilities.clusters === true ? { cluster: { method: 'knn-components' as const, labels: true } } : {}),
				...(scopeRef.current ? { filter: { object_ids: [...scopeRef.current] } } : {}),
			};
			// The scope this draw sends, noted over the sample on screen until the answer lands.
			const target = scopeTargetRef.current;
			const shown = selection.getState().sampleModel?.result ?? null;
			const attempt: IScopeAttempt = { key: target.key, failed: false };
			if (shown) SAMPLE_SCOPES.set(shown, { drawn: scopeOfSample(shown).drawn, attempt });
			/** End this draw's note over the sample it started on, unless a newer draw has replaced it. */
			const endAttempt = (next: IScopeAttempt | null): void => {
				const now = scopeOfSample(shown);
				if (shown && now.attempt === attempt) SAMPLE_SCOPES.set(shown, { drawn: now.drawn, attempt: next });
			};
			client.cancel();
			drawnWrites.current = writesRef.current;
			setBusy(BUSY.sampling);
			setError(null);
			const answer = await callTool<ISampleResult>(channel, 'sample', input as Record<string, unknown>, { nodeId: storeNode, timeoutMs: limits.sample_budget_ms + 30_000 });
			if (connectionRef.current !== key) {
				endAttempt(null);
				return null;
			}
			if (!answer.ok) {
				// Noted before the render this answer causes: the legend says the scope was not applied.
				endAttempt({ key: target.key, failed: true });
				setBusy(null);
				if (!answer.stale) setError(mapFailure(answer.code, answer.message));
				return null;
			}
			setBusy(null);
			const result = answer.value;
			SAMPLE_SCOPES.set(result, { drawn: target, attempt: null });
			resetView(opts.keepQuery === true);
			selection.setSampleModel({ sampleId: result.sample_id, seed: opts.seed, mode: result.mode, receivedAt: Date.now(), result, pinned: [], removed: [] });
			setFitToken((t) => t + 1);
			actions.announce(sampleLabel(result));
			return result.sample_id;
		},
		[channel, model.connectionKey, model.capabilities.clusters, limits, storeNode, client, resetView, selection, actions],
	);

	// First open: sample once per connection with the node's default size.
	useEffect(() => {
		if (!visible || !canSample || channel === null || sampleModel !== null || busy !== null) return;
		if (autoSampled.current === model.connectionKey) return;
		autoSampled.current = model.connectionKey;
		void drawSample({ n: Math.min(limits.sample_default, limits.sample_max), mode: 'detailed', seed: DEFAULT_SEED });
	}, [visible, canSample, channel, sampleModel, busy, model.connectionKey, limits, drawSample]);

	// The console scoped the map to other documents: draw the sample again from those (a scope is a reason to
	// sample). Once per scope over the sample on screen: drawSample notes the draw before its first await, so
	// the run a busy change causes does not start a second one, and a refused draw waits for the legend's action.
	useEffect(() => {
		if (!visible || !sampleModel || busy !== null || channel === null) return;
		if (!scopeDrawDue(scopeTarget.key, scopeOfSample(sampleModel.result))) return;
		void drawSample({ n: sampleModel.result.n_requested, mode: sampleModel.mode, seed: sampleModel.seed });
		// Runs again when a busy map frees up, so a scope changed meanwhile is not missed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scopeTarget.key, visible, busy, sampleModel]);

	// A write on the store since the sample on screen was drawn (a move to the trash, a restore, a delete): draw it
	// again with its size, mode and seed, once the map is shown, so trashed points leave it and restored ones return.
	useEffect(() => {
		if (drawnWrites.current !== writes && visible && sampleModel && busy === null && channel !== null) {
			void drawSample({ n: sampleModel.result.n_requested, mode: sampleModel.mode, seed: sampleModel.seed });
		}
		// drawSample notes the count before its first await, so the run its busy change causes does not draw again.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [writes, visible, busy, sampleModel]);

	/** The legend's action after a refused draw: the sample on screen drawn again, with the console's scope. */
	const retryScope = useCallback((): void => {
		const shown = selection.getState().sampleModel;
		if (shown) void drawSample({ n: shown.result.n_requested, mode: shown.mode, seed: shown.seed });
	}, [selection, drawSample]);

	/** Draw the current sample again (same seed, pinned and highlighted keys kept): SAMPLE_EXPIRED. */
	const resample = useCallback(async (extra: readonly VectorKey[] = []): Promise<string | null> => {
		if (!sampleModel) return null;
		const keep = [...extra, ...sampleModel.pinned.flatMap((p) => (p.key ? [p.key] : [])), ...(highlight?.keys ?? [])].slice(0, limits.project_keys_max);
		return drawSample({ n: sampleModel.result.n_requested, mode: sampleModel.mode, seed: sampleModel.seed, includeKeys: keep.map((k) => [k[0], k[1]] as VectorKey), keepQuery: true });
	}, [sampleModel, highlight, limits.project_keys_max, drawSample]);

	/** Project keys outside the sample and pin them (hollow points). */
	const pinKeys = useCallback(
		async (keys: VectorKey[]): Promise<IProjectItem[]> => {
			if (channel === null || !sampleModel || keys.length === 0) return [];
			const placed = await projectOn(sampleModel.sampleId, (id) => callTool<IProjectResult>(channel, 'project', { sample_id: id, keys: keys.slice(0, limits.project_keys_max), m: PROJECT_M }, { nodeId: storeNode }), resample);
			// Projected on a sample replaced meanwhile: its places are in that sample's basis, so nothing is pinned.
			if (!onSample(placed.sampleId, selection.getState().sampleModel?.sampleId)) return [];
			const answer = placed.answer;
			if (!answer.ok) {
				if (!answer.stale) setNotice(mapFailure(answer.code, answer.message));
				return [];
			}
			const items = answer.value.items.filter((item) => item.in_sample === null || item.in_sample === undefined);
			selection.addPinned(items);
			return items;
		},
		[channel, sampleModel, limits.project_keys_max, storeNode, resample, selection],
	);

	// -------------------------------------------------------------------------
	// Layouts
	// -------------------------------------------------------------------------

	/**
	 * Lay out `target` (the sample it is given, never one read from this
	 * render): a saved view's layout runs over the sample drawn for the view,
	 * before the view has re-rendered with it.
	 */
	const runLayout = useCallback(
		async (next: MapLayout, target: ILayoutTarget): Promise<void> => {
			const { sample, seed, hidden } = target;
			setNotice(null);
			if (next === 'pca') {
				client.cancel();
				setLayout('pca');
				setLayoutState('idle');
				setLayoutProgress(null);
				setFitToken((t) => t + 1);
				return;
			}
			if (next === 'tsne' && sample.n > TSNE_MAX_POINTS) {
				setNotice(`t-SNE is limited to ${num(TSNE_MAX_POINTS)} points; this sample has ${num(sample.n)}. Draw a smaller sample or use the neighbour graph layout.`);
				return;
			}
			setThreeD(false);
			setLayoutState('running');
			setLayoutProgress(0);
			// The overlaps on the map are this run's, once it ends (never the last run's while this one runs).
			setQuality(null);
			const sampleId = sample.sample_id;
			const outcome = await client.run({ sample, algorithm: next === 'tsne' ? 'tsne' : 'force', seed, hidden }, (ticks, total) => setLayoutProgress(total > 0 ? ticks / total : null));
			setLayoutProgress(null);
			if (outcome.kind === 'superseded') return;
			if (outcome.kind === 'done') {
				const r = outcome.result;
				setQuality({ overlap: r.overlap, pcaOverlap: r.pcaOverlap });
				if (next === 'neighbour-graph' && r.overlap < r.pcaOverlap) {
					setLayout('pca');
					setLayoutState('kept-pca');
					setNotice(LAYOUT_NOT_BETTER);
					return;
				}
				setRefined({ layout: next, sampleId, positions: r.positions });
				setLayout(next);
				setLayoutState('done');
				setFitToken((t) => t + 1);
				actions.announce(`${next === 'tsne' ? 't-SNE' : 'Neighbour graph'} layout ready: it keeps ${Math.round(r.overlap * 100)}% of each point's neighbours, PCA ${Math.round(r.pcaOverlap * 100)}%.`);
				if (r.timedOut) setNotice('The layout stopped at its time budget and shows the positions it reached.');
				return;
			}
			setLayout('pca');
			setLayoutState(outcome.kind);
			setNotice(outcome.kind === 'cancelled' ? LAYOUT_CANCELLED : outcome.message);
		},
		[client, actions],
	);

	/** The toolbar's layout: the sample shown, with its seed and the points not shown. */
	const onLayout = useCallback(
		(next: MapLayout): Promise<void> => (sample && sampleModel ? runLayout(next, { sample, seed: sampleModel.seed, hidden }) : Promise.resolve()),
		[sample, sampleModel, hidden, runLayout],
	);

	const onCancel = useCallback((): void => {
		client.cancel();
	}, [client]);

	// -------------------------------------------------------------------------
	// Selection, neighbours, text
	// -------------------------------------------------------------------------

	const onPick = useCallback(
		async (index: number | null, retried = false): Promise<void> => {
			setSelected(index);
			setFocused(index);
			setNeighbourError(null);
			if (index === null || !sample || neighbourQueue === null || channel === null) {
				setNeighbours(null);
				return;
			}
			const key = pointKey(sample, index);
			selection.focusChunk(key);
			setTab('point');
			// Light samples carry no text: fetch this chunk's.
			if (!sample.points.snip) {
				void callTool<IChunksResult>(channel, 'chunks', { object_id: key[0], after_chunk: key[1] - 1, limit: 1 }, { nodeId: storeNode }).then((answer) => {
					const item = answer.ok ? answer.value.items.find((c) => c.chunkId === key[1]) : undefined;
					if (item) setChunkText({ key: keyString(key[0], key[1]), text: item.content.length > 2000 ? `${item.content.slice(0, 2000)}…` : item.content });
				});
			}
			if (model.capabilities.neighbors === false) {
				setNeighbourError('This store cannot list the nearest chunks of the collection.');
				return;
			}
			setNeighbourBusy(true);
			const outcome = await neighbourQueue.request(key);
			if (outcome.status === 'superseded') return;
			setNeighbourBusy(false);
			if (outcome.status === 'failed' || !outcome.value.ok) {
				const answer = outcome.status === 'done' ? outcome.value : null;
				setNeighbourError(answer && !answer.ok ? mapFailure(answer.code, answer.message) : 'The neighbour search failed.');
				return;
			}
			const result = outcome.value.value;
			setNeighbours({ index, result });
			const outside = result.items.filter((item) => !keyIdx.has(keyString(item.key[0], item.key[1]))).map((item) => [item.key[0], item.key[1]] as VectorKey);
			setNeighbourPins(outside.length > 0 && model.capabilities.project !== false ? await pinKeysQuiet(outside, key, retried) : []);
		},
		// pinKeysQuiet is defined below and stable for a sample.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[sample, neighbourQueue, channel, selection, storeNode, model.capabilities, keyIdx],
	);

	/**
	 * Project keys without pinning them in the shared model (neighbour ends of
	 * `key`). When the node dropped the sample (SAMPLE_EXPIRED) the sample is
	 * drawn again keeping `key`, and the point is inspected again on it (once:
	 * `retried` stops a second re-sample).
	 */
	const pinKeysQuiet = async (keys: VectorKey[], key: VectorKey, retried: boolean): Promise<IProjectItem[]> => {
		if (channel === null || !sampleModel) return [];
		const asked = sampleModel.sampleId;
		const answer = await callTool<IProjectResult>(channel, 'project', { sample_id: asked, keys: keys.slice(0, limits.project_keys_max), m: PROJECT_M }, { nodeId: storeNode });
		// Projected on a sample replaced meanwhile: its places are in that sample's basis, so no hollow end is drawn.
		if (!onSample(asked, selection.getState().sampleModel?.sampleId)) return [];
		if (isExpired(answer) && !retried) {
			repick.current = { key: keyString(key[0], key[1]), drawnAt: sampleModel.receivedAt };
			void resample([key]).then((id) => {
				if (id === null) repick.current = null;
			});
			return [];
		}
		return answer.ok ? answer.value.items : [];
	};

	// A re-drawn sample arrived for a point whose neighbour ends expired: inspect it again there.
	useEffect(() => {
		const pending = repick.current;
		if (pending === null || !sampleModel || sampleModel.receivedAt === pending.drawnAt) return;
		repick.current = null;
		const index = keyIdx.get(pending.key);
		if (index !== undefined) void onPick(index, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sampleModel]);

	const selectKey = useCallback(
		(key: VectorKey): void => {
			const index = keyIdx.get(keyString(key[0], key[1]));
			if (index !== undefined) {
				void onPick(index);
				setCentreOn({ index, seq: ++seq.current });
			} else void pinKeys([[key[0], key[1]]]);
		},
		[keyIdx, onPick, pinKeys],
	);

	// The console focused a chunk (a "map" button): select it here too.
	useEffect(() => {
		if (!sample || state.chunk === null || state.connectionKey !== model.connectionKey) return;
		const index = keyIdx.get(keyString(state.chunk[0], state.chunk[1]));
		if (index === undefined || index === selected) return;
		void onPick(index);
		setCentreOn({ index, seq: ++seq.current });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.chunk]);

	// Highlights from the console: pin what is outside the sample; chat sources pulse once.
	const lastHighlight = useRef<unknown>(null);
	useEffect(() => {
		if (!sample || !highlight || highlight === lastHighlight.current) return;
		lastHighlight.current = highlight;
		if (highlight.source === 'lasso') return;
		if (highlight.source === 'search') {
			// Search's Compare told the map both questions before it highlighted both result lists: a star for each,
			// A then B (never two `project` calls at once). A B with no star is placed again on the next showing.
			const compare = comparePlan({ told: state.query, toldB: state.queryB, mapQuery: query?.text ?? null, mapQueryB: queryB?.item ? queryB.text : null, embedReady });
			void placeCompared(compare, () => runQuery(state.query as string, false, false), () => runQueryB(state.queryB as string));
			return;
		}
		const res = resolveKeys(highlight.keys, keyIdx, sampleModel?.pinned ?? []);
		if (res.outside.length > 0 && model.capabilities.project !== false) void pinKeys(res.outside);
		const first = res.points[0];
		if (first !== undefined) setCentreOn({ index: first, seq: ++seq.current });
		if (highlight.source === 'chat') {
			/** Forget the placed query (its star, rays, vector and colouring) and a compared one (star B). */
			const clearQuery = (): void => {
				setQueryView(null);
				queryVector.current = null;
				setColourBy((by) => colourAfterQuery(by, colourBefore.current));
				clearCompare();
			};
			// The chat told the map the answer's question (showAnswerOnMap) before it highlighted the sources.
			const plan = chatQueryPlan({ told: state.query, mapQuery: query?.text ?? null, embedReady });
			if (plan === 'run') {
				// Another question's star must not stand in while this one is embedded, or if embedding fails.
				clearQuery();
				setPlacingAnswer(true);
				void runQuery(state.query as string, false).finally(() => setPlacingAnswer(false));
			} else if (plan === 'centroid' && (query !== null || state.query !== null)) {
				// No embedding node (or no question): the star is the sources' centre, marked approximate.
				clearQuery();
				selection.setQuery(null);
			}
			if (!reducedMotion && typeof requestAnimationFrame === 'function') {
				const started = performance.now();
				const step = (): void => {
					const t = (performance.now() - started) / 900;
					setPulse(t >= 1 ? 0 : Math.sin(Math.PI * t));
					if (t < 1) requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [highlight, sample]);

	// -------------------------------------------------------------------------
	// Text query: embed -> project -> search
	// -------------------------------------------------------------------------

	/**
	 * Embed one question on the embedding node: the map's only `embed` call
	 * (the query, and Search's compared question). The answer is used as it came.
	 */
	const embedQuestion = (text: string): Promise<ToolAnswer<IEmbedResult>> => {
		if (embedChannel === null || !model.nodes.embed) return Promise.resolve({ ok: false, code: 'NO_EMBEDDER', message: QUERY_NEEDS_EMBED, stale: false });
		return callTool<IEmbedResult>(embedChannel, 'embed', { texts: [text], kind: 'query' }, { nodeId: model.nodes.embed, timeoutMs: 60_000 });
	};

	const runQuery = async (text: string, setHighlightToTopK = true, ownQuery = setHighlightToTopK): Promise<void> => {
		// A question typed on the map replaces a compared pair: star B goes.
		if (ownQuery) clearCompare();
		const blocked = queryBlocker({ embedReady, hasSample: sampleModel !== null && channel !== null });
		if (blocked !== null || !sampleModel || channel === null || embedChannel === null || !model.nodes.embed) {
			setError(blocked ?? QUERY_NEEDS_EMBED);
			return;
		}
		const key = model.connectionKey;
		setError(null);
		setNotice(null);
		setBusy(BUSY.embedding);
		const embedded = await embedQuestion(text);
		if (connectionRef.current !== key) return;
		if (!embedded.ok) {
			setBusy(null);
			if (!embedded.stale) setError(mapFailure(embedded.code, embedded.message));
			return;
		}
		const vector = embedded.value.vectors[0];
		if (!Array.isArray(vector) || vector.length === 0) {
			setBusy(null);
			setError('The embedding node answered without a vector.');
			return;
		}
		setBusy(BUSY.projecting);
		const placed = model.capabilities.project === false ? null : await projectOn(sampleModel.sampleId, (id) => callTool<IProjectResult>(channel, 'project', { sample_id: id, vector, m: PROJECT_M, with_similarities: true }, { nodeId: storeNode }), resample);
		const projected = placed?.answer ?? null;
		const searched = await callTool<ISearchResult>(channel, 'search', { vector, top_k: Math.min(RAYS_TOP_K, limits.top_k_max), include_below_floor: true }, { nodeId: storeNode });
		if (connectionRef.current !== key) return;
		setBusy(null);
		// Projected on a sample replaced meanwhile (another basis): not drawn, and said.
		if (!onSample(placed?.sampleId ?? null, selection.getState().sampleModel?.sampleId)) {
			setNotice(QUERY_SAMPLE_CHANGED);
			return;
		}
		// Only now the map's question: the Heat strip and Recommend's "with query" never use one that was not drawn.
		queryVector.current = vector;
		const notes: string[] = [];
		if (projected && !projected.ok) notes.push(mapFailure(projected.code, projected.message));
		if (!searched.ok) notes.push(mapFailure(searched.code, searched.message));
		const search = searched.ok ? searched.value : null;
		if (search?.warnings?.includes('model_mismatch')) notes.push('The chat embedding model differs from the one this collection was built with; results may be meaningless.');
		if (search?.warnings?.includes('keyword_fallback')) notes.push('The store answered by keyword because the vector search failed.');
		const item = projected && projected.ok ? (projected.value.items[0] ?? null) : null;
		const current = selection.getState().sampleModel;
		const n = current?.result.n ?? sampleModel.result.n;
		const sims = projected && projected.ok ? querySims(projected.value, n) : null;
		if (layout !== 'pca' && item) notes.push(QUERY_PLACED_APPROX);
		setQueryView({ text, item, sims, search, notes });
		selection.setQuery(text);
		if (sims) {
			const next = colourForQuery(colourBy, colourBefore.current);
			colourBefore.current = next.before;
			setColourBy(next.colourBy);
		}
		if (search) {
			const top = search.results.flatMap((r) => (typeof r.metadata?.objectId === 'string' && typeof r.metadata?.chunkId === 'number' ? [[r.metadata.objectId, r.metadata.chunkId] as VectorKey] : []));
			if (setHighlightToTopK) selection.setHighlight({ source: 'search', keys: top });
			const outside = raysFromSearch(search, current ? keyIndex(current.result) : keyIdx, current?.pinned ?? []).outside;
			if (outside.length > 0) await pinKeys(outside);
			actions.announce(`Query placed on the map with rays to its ${num(top.length)} nearest chunks in the collection.`);
		}
	};

	/** Forget the compared question (star B, its rays and vector). */
	const clearCompare = (): void => {
		setQueryBView(null);
		queryVectorB.current = null;
		if (selection.getState().queryB !== null) selection.clearQueryB();
	};

	/**
	 * Place Search's compared question (B): embed it, project it among the
	 * sample, and search its true top-k for its rays. Its vector stays here and
	 * goes only to `project` and `search`, like the query's.
	 */
	const runQueryB = async (text: string): Promise<void> => {
		if (!sampleModel || channel === null || embedChannel === null || !model.nodes.embed) return;
		const key = model.connectionKey;
		const embedded = await embedQuestion(text);
		if (connectionRef.current !== key) return;
		const vector = embedded.ok ? embedded.value.vectors[0] : undefined;
		if (!Array.isArray(vector) || vector.length === 0) {
			if (!embedded.ok && !embedded.stale) setNotice(starBNotPlaced(mapFailure(embedded.code, embedded.message)));
			return;
		}
		const placed = model.capabilities.project === false ? null : await projectOn(sampleModel.sampleId, (id) => callTool<IProjectResult>(channel, 'project', { sample_id: id, vector, m: PROJECT_M }, { nodeId: storeNode }), resample);
		const projected = placed?.answer ?? null;
		const searched = await callTool<ISearchResult>(channel, 'search', { vector, top_k: Math.min(RAYS_TOP_K, limits.top_k_max), include_below_floor: true }, { nodeId: storeNode });
		if (connectionRef.current !== key || selection.getState().queryB !== text) return;
		// Projected on a sample replaced meanwhile (another basis): no star, and said; the next showing places it again.
		if (!onSample(placed?.sampleId ?? null, selection.getState().sampleModel?.sampleId)) {
			setNotice(starBNotPlaced(STAR_B_SAMPLE_CHANGED));
			return;
		}
		queryVectorB.current = vector;
		const item = projected && projected.ok ? (projected.value.items[0] ?? null) : null;
		const search = searched.ok ? searched.value : null;
		setQueryBView({ text, item, sims: null, search, notes: [] });
		if (item === null) {
			// No star, so no rays from it: the status line says why.
			setNotice(starBNotPlaced(projected === null ? STAR_B_NEEDS_PROJECT : !projected.ok ? mapFailure(projected.code, projected.message) : null));
			return;
		}
		if (search) {
			const current = selection.getState().sampleModel;
			const outside = raysFromSearch(search, current ? keyIndex(current.result) : keyIdx, current?.pinned ?? []).outside;
			if (outside.length > 0) await pinKeys(outside);
			actions.announce(`Second question placed on the map (hollow star) with rays to its ${num(search.results.length)} nearest chunks.`);
		}
	};

	// Search cleared its compared question: star B goes.
	useEffect(() => {
		if (state.queryB === null && queryB !== null) {
			setQueryBView(null);
			queryVectorB.current = null;
		}
	}, [state.queryB, queryB]);

	// Heat strip: the selected point's document, every chunk scored against the query.
	useEffect(() => {
		if (tab !== 'heat' || !sample || selected === null || channel === null) return;
		const doc = documentOf(sample, selected);
		const vector = queryVector.current;
		if (!doc || vector === null) {
			setHeat(null);
			return;
		}
		const chunks = Math.min(doc.chunks ?? 0, limits.scope_keys_max);
		const ids = chunks > 0 ? Array.from({ length: chunks }, (_, c) => c) : chunkPath(sample, doc.objectId).map((i) => sample.points.chunk[i] as number);
		const keys = ids.map((c) => [doc.objectId, c] as VectorKey);
		let live = true;
		void callTool<INeighborsScopeResult>(channel, 'neighbors', { vector: queryVector.current, scope_keys: keys }, { nodeId: storeNode }).then((answer) => {
			if (!live) return;
			if (!answer.ok || !Array.isArray(answer.value.scores)) {
				setHeat(null);
				if (!answer.ok && !answer.stale) setNotice(mapFailure(answer.code, answer.message));
				return;
			}
			setHeat({ objectId: doc.objectId, chunks: Math.max(ids.length, (doc.chunks ?? 0)), scores: heatScores(ids, answer.value.scores) });
		});
		return () => {
			live = false;
		};
	}, [tab, sample, selected, channel, storeNode, limits.scope_keys_max, query]);

	// -------------------------------------------------------------------------
	// Lasso and keys
	// -------------------------------------------------------------------------

	/**
	 * Removals: staged for the console's pending changes where it offers that (named by the sample's paths and
	 * chunk counts, so the pending bar and the confirmation show files, not ids), else confirmed by it at once.
	 */
	const staging = actions.stageRemove !== undefined;
	const removeDocuments = useCallback(
		(objectIds: readonly string[]): void => {
			// Staged: the console's pending bar shows the count, and every press is announced (a repeat too). Nothing
			// is inserted in the panel, so no row moves under the pointer between two presses.
			if (actions.stageRemove && sample) {
				const targets = removeTargetsOf(sample, objectIds);
				actions.stageRemove(targets);
				actions.announce(stagedAnnouncement(targets.length));
			} else actions.requestRemove(objectIds);
		},
		[actions, sample],
	);

	const onLasso = useCallback(
		(indices: readonly number[]): void => {
			if (!sample) return;
			const keys = indices.map((i) => pointKey(sample, i));
			selection.setKeys(keys);
			selection.setHighlight({ source: 'lasso', keys });
			// The toggle stays pressed: the next outline selects again (Lasso, L or Escape turn it off).
			setTab('selection');
			const docs = new Set(keys.map((k) => k[0])).size;
			actions.announce(`Selected ${num(keys.length)} points from ${num(docs)} documents.`);
		},
		[sample, selection, actions],
	);

	const onFocusMove = useCallback(
		(index: number): void => {
			if (!sample) return;
			setFocused(index);
			const doc = documentOf(sample, index);
			let shownCount = sample.n;
			if (hidden) for (const v of hidden) shownCount -= v;
			actions.announce(pointAnnouncement(index, shownCount, doc?.path ?? '?', sample.points.chunk[index] as number));
		},
		[sample, hidden, actions],
	);

	// What Escape and the toolbar's Clear clear next, in order: the lasso, then a highlight (or a query's fading),
	// then the selected point; one step each (map/isolate.ts clearStep).
	// This connection's selection only (the store holds another connection's until it is reset).
	const ownKeys = state.connectionKey === model.connectionKey ? state.keys : [];
	const lassoActive = lasso || (highlight?.source === 'lasso' ? highlight.keys.length > 0 : ownKeys.length > 0);
	const highlightActive = (highlight !== null && highlight.source !== 'lasso') || queryTop.length > 0;
	const nextClear = clearStep({ lasso: lassoActive, highlight: highlightActive, selection: selected !== null || focused !== null });
	const clearOnce = useCallback((): void => {
		if (nextClear === 'lasso') {
			setLasso(false);
			selection.setKeys([]);
			if (highlight?.source === 'lasso') selection.setHighlight(null);
			actions.announce('Lasso selection cleared.');
		} else if (nextClear === 'highlight') {
			if (highlight !== null && highlight.source !== 'lasso') selection.setHighlight(null);
			setQueryDims(false);
			actions.announce('Highlight cleared.');
		} else if (nextClear === 'selection') {
			setSelected(null);
			setFocused(null);
			setNeighbours(null);
			actions.announce('Selection cleared.');
		}
	}, [nextClear, selection, highlight, actions]);

	const onKeyAction = useCallback(
		(action: KeyAction): void => {
			if (action === 'inspect' && focused !== null) void onPick(focused);
			else if (action === 'clear') clearOnce();
			else if (action === 'lasso') setLasso((on) => !on);
		},
		[focused, onPick, clearOnce],
	);

	// -------------------------------------------------------------------------
	// Clusters, edges, colouring, isolation (all over data the browser holds: no call)
	// -------------------------------------------------------------------------

	/** The Clusters tab's Minimum size: folded here, so nothing is asked of the store. */
	const onMinSize = useCallback(
		(size: ClusterMinSize): void => {
			setMinClusterSize(size);
			if (sample?.clusters) {
				const view = clusterView(sample.clusters, size);
				actions.announce(`Clusters of at least ${num(size)} points: ${num(view.count)} ${view.count === 1 ? 'cluster' : 'clusters'}, ${num(view.noise)} unassigned ${view.noise === 1 ? 'point' : 'points'}.`);
			}
		},
		[sample, actions],
	);

	const onColourBy = useCallback(
		(by: MapColourBy): void => {
			setColourBy(by);
			if (by === 'cluster' && clusters && sample) {
				const { rows, noise } = clusterRows(sample, clusters, hidden);
				actions.announce(clusterAnnouncement(rows.length, noise.size));
			}
		},
		[clusters, sample, hidden, actions],
	);

	const onEdges = useCallback((mode: EdgeMode): void => {
		setEdges(mode);
		setEdgesDegraded(false);
	}, []);

	const onEdgesM = useCallback((m: EdgesPerPoint): void => {
		setEdgesM(m);
		setEdgesDegraded(false);
	}, []);

	const onExpandSelected = useCallback((): void => {
		if (selected === null) return;
		setExpanded((list) => (list.includes(selected) ? list : [...list, selected]));
		if (sample) actions.announce(`Added the neighbour edges of point ${num(selected + 1)}.`);
	}, [selected, sample, actions]);

	/** Frames that drew edges ran slow: draw 3 per point (never while the perf lane measures with the switch off). */
	const onSlowEdges = useCallback((): void => {
		if (!edgesAutoDegrade || edges !== 'neighbours' || edgesPerPoint <= 3) return;
		setEdgesDegraded(true);
		setNotice(EDGES_DEGRADED);
	}, [edgesAutoDegrade, edges, edgesPerPoint]);

	/** Show only these points (indices into the sample). */
	const isolate = useCallback(
		(indices: readonly number[]): void => {
			if (!sample) return;
			const keep = Array.from(new Set(indices.filter((i) => i >= 0 && i < sample.n && !(removedMask && removedMask[i])))).sort((a, b) => a - b);
			if (keep.length === 0) return;
			setIsolated(keep);
			setFitToken((t) => t + 1);
			actions.announce(`${isolationLine(keep.length, sample.n)} points.`);
		},
		[sample, removedMask, actions],
	);

	const onShowAll = useCallback((): void => {
		setIsolated(null);
		setFitToken((t) => t + 1);
		if (sample) actions.announce(`Showing all ${num(shownCount(sample.n, removedMask))} points.`);
	}, [sample, removedMask, actions]);

	const onExpandIsolation = useCallback((): void => {
		if (!sample || isolated === null) return;
		const grown = expandByNeighbours(sample.knn, sample.n, isolated, removedMask);
		setIsolated(grown);
		setFitToken((t) => t + 1);
		actions.announce(`${isolationLine(grown.length, sample.n)} points.`);
	}, [sample, isolated, removedMask, actions]);

	const isolation = sample && isolated !== null ? { shown: shownPoints, n: sample.n } : null;

	// -------------------------------------------------------------------------
	// Values for the mounted panels: Recommend, the inspector, exports, saved views
	// -------------------------------------------------------------------------

	/** Recommend's examples, kept per connection in memory (the 'recommend examples' cache). */
	const setExamples = useCallback(
		(next: IRecommendExamples): void => {
			setExamplesState(next);
			recommendExamples.set(model.connectionKey, next);
		},
		[model.connectionKey],
	);

	/** The inspector's "Add as example (+/-)". */
	const onAddExample = useCallback(
		(key: VectorKey, polarity: ExamplePolarity): void => {
			const max = limits.recommend_examples_max ?? RECOMMEND_EXAMPLES_DEFAULT;
			const same = (k: VectorKey): boolean => k[0] === key[0] && k[1] === key[1];
			const positive = examples.positive.filter((k) => !same(k));
			const negative = examples.negative.filter((k) => !same(k));
			const side = polarity === 'positive' ? positive : negative;
			if (side.length >= max) {
				actions.announce(`At most ${num(max)} ${polarity} examples.`);
				return;
			}
			side.push([key[0], key[1]]);
			setExamples({ positive, negative, withQuery: examples.withQuery });
			actions.announce(`Added as a ${polarity} example.`);
		},
		[examples, limits.recommend_examples_max, setExamples, actions],
	);

	/** Recommend: examples as keys, the query vector held here when asked, the scope; one call to the store node. */
	const onRecommend = useCallback(
		async (request: IRecommendRequest): Promise<ToolOutcome<IRecommendResult>> => {
			if (channel === null) return { ok: false, code: undefined, message: 'No running source reaches this store.' };
			const max = limits.recommend_examples_max ?? RECOMMEND_EXAMPLES_DEFAULT;
			const scoped = scopeRef.current;
			const answer = await callRecommend(
				channel,
				{
					positive: request.positive.slice(0, max).map((k) => [k[0], k[1]] as VectorKey),
					negative: request.negative.slice(0, max).map((k) => [k[0], k[1]] as VectorKey),
					vector: request.withQuery ? queryVector.current : null,
					k: request.k,
					strategy: request.strategy,
					exclude_examples: true,
					...(scoped ? { filter: { object_ids: [...scoped] } } : {}),
				},
				{ nodeId: storeNode },
			);
			return answer.ok ? { ok: true, value: answer.value } : { ok: false, code: answer.code, message: mapFailure(answer.code, answer.message) };
		},
		[channel, limits.recommend_examples_max, storeNode],
	);

	/** The inspector's "Show full text": one `chunks` call per key (kept until another point is shown). */
	const onShowText = useCallback(
		(key: VectorKey): void => {
			const id = keyString(key[0], key[1]);
			if (channel === null || fullText?.key === id) return;
			void callTool<IChunksResult>(channel, 'chunks', { object_id: key[0], after_chunk: key[1] - 1, limit: 1 }, { nodeId: storeNode }).then((answer) => {
				const item = answer.ok ? answer.value.items.find((c) => c.chunkId === key[1]) : undefined;
				if (item) setFullText({ key: id, text: item.content.length > FULL_TEXT_MAX ? `${item.content.slice(0, FULL_TEXT_MAX)}…` : item.content });
				else if (!answer.ok && !answer.stale) setNotice(mapFailure(answer.code, answer.message));
			});
		},
		[channel, storeNode, fullText],
	);

	/** Duplicate groups for the Points table (the queue's default threshold; computed from the sample). */
	const duplicateGroups = useMemo(() => (sample ? groupOf(groups(pairsAt(sample, TABLE_DUPLICATE_THRESHOLD)), sample.n) : null), [sample]);

	/** The points of the sample shown now (not hidden), in index order. */
	const shownIndices = useCallback((): number[] => (sample ? Array.from({ length: sample.n }, (_, i) => i).filter((i) => !(hidden && hidden[i])) : []), [sample, hidden]);

	/** Export rows of some points over the layout shown. */
	const rowsOf = useCallback(
		(indices: readonly number[]) =>
			sample
				? pointExportRows(sample, indices, { positions: raw, dims, querySims: query?.sims ?? null, clusters: clusters ? { labels: clusters.labels, label: (g) => clusterLabel(clusters, g) } : null })
				: { columns: [], rows: [] },
		[sample, raw, dims, query, clusters],
	);

	/** One cluster's export item (its shown points). */
	const clusterExportItem = useCallback(
		(cluster: number): IExportItem => {
			const label = clusters ? clusterLabel(clusters, cluster) : `group ${cluster + 1}`;
			return { id: `map-cluster-${cluster + 1}`, label: `Cluster ${cluster + 1}: ${label}`, kind: 'clusters', disabled: null, rows: () => rowsOf(shownIndices().filter((i) => (clusters?.labels[i] ?? -1) === cluster)) };
		},
		[clusters, rowsOf, shownIndices],
	);

	const lassoKeysNow = state.highlight?.source === 'lasso' ? state.highlight.keys : state.keys;

	/** The map's PNG: the edge layer, the points and the overlay as drawn, at most 2x, with the legend's words and a footer. */
	const mapPng = useCallback(async (): Promise<Blob | null> => {
		const snap = snapshotter.current;
		if (snap === null || typeof document === 'undefined' || !sample) return null;
		// The renderer's snapshot draws the points again and copies them in this same call (preserveDrawingBuffer is off).
		const source = snap();
		if (source === null) return null;
		const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
		const scale = Math.min(2, dpr) / dpr;
		// The legend's colours (swatch and words), then the footer.
		const legendRows = (colouring?.legend ?? []).slice(0, 12);
		const lines: Array<{ text: string; colour: string | null }> = [
			...legendRows.map((e) => ({ text: `${e.label} (${num(e.count)})`, colour: e.colour })),
			{ text: `${model.collection ?? 'collection'} · ${num(shownPoints)} of ${sample.of.chunks === null ? '?' : num(sample.of.chunks)} chunks · ${layout} · colour by ${COLOUR_MODES.find((m) => m.id === colourBy)?.label ?? colourBy} · ${new Date().toISOString().slice(0, 10)}`, colour: null },
		];
		const ratio = Math.min(2, dpr);
		const lineH = 16 * ratio;
		const out = document.createElement('canvas');
		out.width = Math.max(1, Math.round(source.width * scale));
		out.height = Math.max(1, Math.round(source.height * scale)) + Math.round(lineH * (lines.length + 1));
		const octx = out.getContext('2d');
		if (!octx) return null;
		// The theme the map is drawn in (its own fallbacks, by mode, in an unthemed host).
		const theme = palette ?? FALLBACK_PALETTE;
		octx.fillStyle = theme.surfaces.default;
		octx.fillRect(0, 0, out.width, out.height);
		octx.drawImage(source, 0, 0, out.width, Math.round(source.height * scale));
		octx.fillStyle = theme.text;
		octx.font = `${12 * ratio}px system-ui, sans-serif`;
		const top = Math.round(source.height * scale);
		lines.forEach((line, n) => {
			const y = top + lineH * (n + 1);
			if (line.colour) {
				octx.fillStyle = line.colour;
				octx.fillRect(8 * ratio, y - 9 * ratio, 9 * ratio, 9 * ratio);
			}
			octx.fillStyle = theme.text;
			octx.fillText(line.text, (line.colour ? 22 : 8) * ratio, y);
		});
		return new Promise<Blob | null>((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'));
	}, [sample, colouring, model.collection, shownPoints, layout, colourBy, palette]);

	/** The toolbar's export items: the sample, the selection, the points shown, the clusters, the duplicates, the outliers, the PNG. */
	const exportItems: IExportItem[] = useMemo(() => {
		if (!sample) return [];
		const selectionIdx = resolveKeys(lassoKeysNow, keyIdx, []).points;
		const visibleOutliers = sample.outliers.filter((i) => !(hidden && hidden[i]));
		const items: IExportItem[] = [
			{ id: 'map-points', label: `Sample points (${num(shownCount(sample.n, removedMask))})`, kind: 'points', disabled: null, rows: () => rowsOf(Array.from({ length: sample.n }, (_, i) => i).filter((i) => !(removedMask && removedMask[i]))) },
			{ id: 'map-selection', label: `Lasso selection (${num(selectionIdx.length)} points)`, kind: 'selection', disabled: selectionIdx.length === 0 ? 'Nothing selected' : null, rows: () => rowsOf(selectionIdx) },
			{ id: 'map-visible', label: `Points shown (${num(shownPoints)})`, kind: 'points', disabled: null, rows: () => rowsOf(shownIndices()) },
			{ id: 'map-clusters', label: `Clusters (${num(clusters?.count ?? 0)})`, kind: 'clusters', disabled: clusters ? (clusters.count === 0 ? 'No clusters at this minimum size' : null) : CLUSTERS_UNSUPPORTED, rows: () => clusterExportRows(clusters ? clusterRows(sample, clusters, hidden).rows : []) },
			{ id: 'map-duplicates', label: `Duplicate pairs (${num(sample.duplicates.length)})`, kind: 'duplicates', disabled: sample.duplicates.length === 0 ? 'No near-duplicate pairs in this sample' : null, rows: () => duplicateExportRows(sample, hidden) },
			{ id: 'map-outliers', label: `Outliers (${num(visibleOutliers.length)})`, kind: 'outliers', disabled: visibleOutliers.length === 0 ? 'No outliers in this sample' : null, rows: () => rowsOf(visibleOutliers) },
			{ id: 'map-png', label: 'Map as PNG', kind: 'map', disabled: canSnapshot ? null : 'The map is not drawn right now.', png: mapPng },
		];
		if (matrixItem) items.push(matrixItem);
		return items;
	}, [sample, lassoKeysNow, keyIdx, hidden, removedMask, rowsOf, shownPoints, shownIndices, clusters, canSnapshot, mapPng, matrixItem]);

	/** A saved view of the map now (never a vector, never a token). */
	const currentView = useCallback((): ISavedViewState | null => {
		if (!sampleModel) return null;
		return {
			n: sampleModel.result.n_requested,
			mode: sampleModel.mode,
			seed: sampleModel.seed,
			layout,
			colourBy: savedColour(colourBy),
			edges,
			edgesM,
			minClusterSize,
			query: query?.text ?? null,
			scopeFilterId: null,
			selection: lassoKeysNow.slice(0, limits.scope_keys_max).map((k) => [k[0], k[1]] as VectorKey),
			camera: recallCamera(model.connectionKey),
		};
	}, [sampleModel, layout, colourBy, edges, edgesM, minClusterSize, query, lassoKeysNow, limits.scope_keys_max, model.connectionKey]);

	/**
	 * Apply a saved view: draw the sample again with its seed (and the current
	 * scope), pinning the first project_keys_max saved keys; restore the
	 * selection by key lookup; pin the first project_keys_max keys still absent
	 * as hollow points; restore the colouring, edges, minimum size, layout and
	 * camera. The saved query is offered, not run (it costs an embed).
	 */
	const applyView = useCallback(
		async (view: ISavedView): Promise<ISavedViewRestore | null> => {
			if (channel === null) return null;
			const saved = view.selection.map((k) => [k[0], k[1]] as VectorKey);
			const id = await drawSample({ n: view.n, mode: view.mode, seed: view.seed, includeKeys: saved.slice(0, limits.project_keys_max) });
			const current = selection.getState().sampleModel;
			if (id === null || current === null) return null;
			const idx = keyIndex(current.result);
			const restored = saved.filter((k) => idx.has(keyString(k[0], k[1])));
			const absent = saved.filter((k) => !idx.has(keyString(k[0], k[1]))).slice(0, limits.project_keys_max);
			let hollow = 0;
			if (absent.length > 0 && model.capabilities.project !== false) {
				const answer = await callTool<IProjectResult>(channel, 'project', { sample_id: id, keys: absent, m: PROJECT_M }, { nodeId: storeNode });
				if (answer.ok) {
					const items = answer.value.items.filter((item) => item.in_sample === null || item.in_sample === undefined);
					selection.addPinned(items);
					hollow = items.length;
				}
			}
			selection.setKeys(restored);
			selection.setHighlight(restored.length > 0 ? { source: 'lasso', keys: restored } : null);
			setColourBy(restoredColour(view.colourBy));
			setEdges(view.edges);
			setEdgesM(view.edgesM);
			if (view.minClusterSize === 2 || view.minClusterSize === 5 || view.minClusterSize === 10) setMinClusterSize(view.minClusterSize);
			if (view.camera && typeof view.camera === 'object' && 'mode' in (view.camera as object)) setCameraOverride({ camera: view.camera as MapCamera, seq: Date.now() });
			// The saved layout runs over the sample drawn for the view (this render's is the one it replaced,
			// or none), and only while that sample is still the one shown.
			const drawn = selection.getState().sampleModel;
			if (view.layout !== 'pca' && drawn !== null && drawn.sampleId === id) void runLayout(view.layout, { sample: drawn.result, seed: drawn.seed, hidden: hiddenMask(drawn) });
			setSavedQuery(view.query);
			const result: ISavedViewRestore = { selected: saved.length, restored: restored.length, hollow, dropped: Math.max(0, saved.length - restored.length - hollow) };
			actions.announce(`${num(result.restored)} of ${num(result.selected)} selected points restored; ${num(result.hollow)} drawn hollow.`);
			return result;
		},
		[channel, drawSample, runLayout, selection, limits.project_keys_max, model.capabilities.project, storeNode, actions],
	);

	// -------------------------------------------------------------------------
	// Connection lifecycle
	// -------------------------------------------------------------------------

	useEffect(() => {
		// A new connection: nothing of the old one carries over (its Recommend examples come from its own cache).
		resetView(false);
		setError(null);
		setNotice(null);
		setBusy(null);
		setSavedQuery(null);
		setExamplesState(recommendExamples.get(model.connectionKey) ?? NO_EXAMPLES);
		client.cancel();
	}, [model.connectionKey, resetView, client]);

	useEffect(() => {
		// Sign-out or identity change: the console resets the selection to no connection.
		if (state.connectionKey === null) {
			forgetCameras();
			autoSampled.current = null;
			queryVector.current = null;
			client.cancel();
		}
	}, [state.connectionKey, client]);

	useEffect(() => {
		// A removed document's selected point goes.
		if (selected !== null && hidden && hidden[selected]) {
			setSelected(null);
			setNeighbours(null);
		}
	}, [hidden, selected]);

	// -------------------------------------------------------------------------
	// Render
	// -------------------------------------------------------------------------

	if (!canSample) {
		return (
			<div className="vector-map" style={{ ...MAP_STYLES.root, padding: 16 }} data-map-state="unavailable">
				<EmptyState title="No map for this store" description={MAP_UNAVAILABLE} />
			</div>
		);
	}
	if (channel === null) {
		return (
			<div className="vector-map" style={{ ...MAP_STYLES.root, padding: 16 }} data-map-state="unreachable">
				<EmptyState title="No running source reaches this store" description="Start the pipeline's Tools source (or its Chat source) and refresh to draw the map." />
			</div>
		);
	}

	const tsneReason = sample && sample.n > TSNE_MAX_POINTS ? `t-SNE is limited to ${num(TSNE_MAX_POINTS)} points; this sample has ${num(sample.n)}.` : null;
	const layoutBusy = layoutState === 'running' ? `${BUSY.layout}${layoutProgress !== null ? ` ${Math.round(layoutProgress * 100)}%` : ''}` : null;
	const pointCap = sample?.mode === 'light' ? limits.sample_max_light : limits.sample_max;
	const querySimsArray = query?.sims ? Array.from(query.sims) : null;
	const selectedKey = selected !== null && sample ? pointKey(sample, selected) : null;
	const selectedScore = selectedKey && query?.search ? (query.search.results.find((r) => r.metadata?.objectId === selectedKey[0] && r.metadata?.chunkId === selectedKey[1])?.score ?? null) : null;
	const lassoKeys = state.highlight?.source === 'lasso' ? state.highlight.keys : state.keys;
	const edgeStatsNow = edgeSet ? edgeStats(edgeSet) : null;
	const edgeLine = sample ? edgeLegend({ mode: edges, m: edgesPerPoint, count: edgeStatsNow?.count ?? 0, min: edgeStatsNow?.min ?? null, max: edgeStatsNow?.max ?? null, points: shownPoints, components: tree?.components ?? 0, expanded: expanded.length }) : null;
	const listingLine = sample ? listingNote(sample) : null;
	// Why the toolbar's Query and t-SNE are off, in full (the toolbar has them as the controls' descriptions only).
	const queryWhy = !model.embed.enabled && model.embed.reason ? model.embed.reason : null;
	const toolbarReasons = [queryWhy, tsneReason].filter((line): line is string => line !== null);
	const legendNotes = [
		// A failure while the map is shown, whole (the status line may cut it).
		...(sample && error ? [failedLine(error)] : []),
		...toolbarReasons,
		...(query?.notes ?? []),
		...(star && !star.exact && !query?.item ? [CENTROID_APPROX] : []),
		...(sample?.mode === 'light' && layout === 'pca' ? [LIGHT_POSITIONS] : []),
		...(colourBy === 'cluster' && sample?.clusters ? [clusterSentence(sample.clusters, minClusterSize)] : []),
		...(edgeLine ? [edgeLine] : []),
		...(edges === 'neighbours' && lightCap ? [EDGES_LIGHT_NOTE] : []),
		...(edges === 'neighbours' && edgesDegraded ? [EDGES_DEGRADED] : []),
		...(listingLine ? [listingLine] : []),
		...(sample ? [scopeLine(scopeState, scopeTarget.key ? scopeTarget : null, shownScope.drawn.key ? shownScope.drawn : null)].filter((line): line is string => line !== null) : []),
		...(isolation ? [isolationLine(isolation.shown, isolation.n)] : []),
		// Only while the hollow star is drawn.
		...(queryB && starB ? [`Hollow star: "${queryB.text}" (compared on the Query tab)`] : []),
	];
	// The status line's sentence (map/wording.ts statusNotice): nothing is put between the toolbar and the map.
	const said = statusNotice({ error, notice, savedQuery, hasSample: sample !== null });
	const runSavedQuery = (): void => {
		if (savedQuery === null) return;
		setSavedQuery(null);
		void runQuery(savedQuery);
	};
	const lineNotice = said && { text: said.text, failure: said.kind === 'error', action: said.kind === 'saved-query' ? { label: 'Run saved query', reason: embedReady ? null : QUERY_NEEDS_EMBED, onAction: runSavedQuery } : null };
	const describe = (index: number): string => {
		if (!sample) return '';
		const doc = documentOf(sample, index);
		const snip = sample.points.snip?.[index];
		const sim = query?.sims ? ` · similarity ${(query.sims[index] ?? 0).toFixed(3)}` : '';
		return `${doc?.path ?? '?'} #${sample.points.chunk[index]}${sim}${snip ? ` — ${snip}` : ''}`;
	};

	return (
		<div
			className="vector-map"
			style={MAP_STYLES.root}
			data-map-state={sample ? 'ready' : busy ? 'sampling' : error ? 'error' : 'empty'}
			data-sample-mode={sample?.mode ?? ''}
			data-layout={layout}
			data-layout-state={layoutState}
			data-knn-overlap={quality ? quality.overlap.toFixed(4) : ''}
			data-pca-overlap={quality ? quality.pcaOverlap.toFixed(4) : ''}
			data-renderer={rendererKind}
			data-query-state={query === null ? 'none' : query.item || query.search ? 'placed' : 'failed'}
			data-rays={rays.length}
			data-query-b-state={queryB === null ? 'none' : starB ? 'placed' : 'failed'}
			data-colour-by={colourBy}
			data-edge-mode={edges}
			data-edges-per-point={edgesPerPoint}
			data-edges-auto-degrade={edgesAutoDegrade ? 'on' : 'off'}
			data-edges-degraded={edgesDegraded ? '1' : '0'}
			data-edge-count={edgeSet?.count ?? 0}
			data-clusters={clusters ? clusters.count : ''}
			data-min-cluster-size={minClusterSize}
			data-shown={sample ? shownPoints : ''}
			data-isolated={isolation ? '1' : '0'}
			data-scoped={sample && shownScope.drawn.documents > 0 ? shownScope.drawn.documents : ''}
			data-scope-state={sample ? scopeState : ''}
		>
			<MapToolbar
				clear={nextClear !== null ? { label: CLEAR_LABELS[nextClear], onClear: clearOnce } : null}
				notice={lineNotice}
				limits={model.capabilities.sample_light === false ? { ...limits, sample_max_light: limits.sample_max } : limits}
				sample={sampleModel}
				busy={busy ?? layoutBusy}
				layout={layout}
				colourBy={colourBy}
				lasso={lasso}
				table={table}
				query={channel === null ? { enabled: false, reason: QUERY_NEEDS_EMBED } : model.embed}
				tsneReason={tsneReason}
				canCancel={layoutState === 'running'}
				threeD={threeD}
				onToggle3D={() => {
					setThreeD((on) => !on);
					setFitToken((t) => t + 1);
				}}
				onSample={(opts) => void drawSample(opts)}
				onLayout={(next) => void onLayout(next)}
				onCancel={onCancel}
				onColourBy={onColourBy}
				colourReasons={colourReasons}
				edges={edges}
				onEdges={onEdges}
				edgesM={edgesPerPoint}
				onEdgesM={onEdgesM}
				edgesMCap={lightCap ? 3 : null}
				onExpandSelected={onExpandSelected}
				expandReason={selected === null ? 'Select a point first' : null}
				onQuery={(text) => void runQuery(text)}
				onToggleLasso={() => setLasso((on) => !on)}
				onFit={() => setFitToken((t) => t + 1)}
				onToggleTable={() => setTable((on) => !on)}
				extras={
					<>
						<ExportMenu items={exportItems} collection={model.collection} onExported={(name) => actions.announce(`Exported ${name}.`)} />
						<SavedViewsMenu connectionKey={model.connectionKey} limits={limits} current={currentView} onApply={applyView} />
					</>
				}
			/>
			{!sample ? (
				<div style={{ padding: 16 }}>
					{error ? (
						<div style={{ marginBottom: 8 }}>
							<Banner variant="error">{error}</Banner>
						</div>
					) : null}
					{toolbarReasons.map((line) => (
						<p key={line} style={MAP_STYLES.note}>
							{line}
						</p>
					))}
					<EmptyState
						title={busy ? BUSY.sampling : 'No sample drawn yet'}
						description={busy ? `Drawing up to ${num(Math.min(limits.sample_default, limits.sample_max))} points from the store.` : 'Draw a sample of the collection to see its points.'}
						action={busy ? undefined : <Button onClick={() => void drawSample({ n: Math.min(limits.sample_default, limits.sample_max), mode: 'detailed', seed: DEFAULT_SEED })}>Draw sample</Button>}
					/>
				</div>
			) : (
				<div style={MAP_STYLES.body}>
					<div style={MAP_STYLES.canvasColumn}>
						{table ? (
							<div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
								<PointsTable sample={sampleModel!} querySims={querySimsArray} selected={selected} onSelect={(i) => void onPick(i)} hidden={hidden} clusters={clusters} duplicateGroups={duplicateGroups} />
							</div>
						) : null}
						{/* Hidden, not unmounted, under the table: it keeps its renderer and camera, and its root keeps
						    data-points / data-selected for the browser lanes while the table shows. */}
						<div style={{ display: table ? 'none' : 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>
							<PointCanvas
								sample={sampleModel!}
								positions={shown}
								dimensions={dims}
								colours={colouring?.colours ?? []}
								rgba={colouring?.rgba ?? null}
								outlined={colouring?.outlined ?? null}
								hidden={hidden}
								emphasised={emphasised}
								dimmed={dimmed}
								dimOnHover={clusters !== null && (colourBy === 'cluster' || tab === 'clusters')}
								overlay={overlay}
								palette={palette}
								pointSizePx={sample.mode === 'light' ? 3.5 : 5.5}
								cameraKey={model.connectionKey}
								fitToken={fitToken}
								centreOn={centreOn}
								visible={visible && !table}
								selection={selection}
								lasso={lasso}
								describe={describe}
								onHover={() => undefined}
								onPick={(i) => void onPick(i)}
								onLasso={onLasso}
								onFocusMove={onFocusMove}
								onKeyAction={onKeyAction}
								canClear={nextClear !== null}
								onRendererInfo={setRendererKind}
								layout={layout}
								selectionCount={lassoKeys.length > 0 ? lassoKeys.length : null}
								overlap={quality ? { layout: quality.overlap, pca: quality.pcaOverlap } : null}
								edges={edgeSet}
								starB={starB}
								raysB={raysB}
								clusterLabels={clusterLabels}
								clusterOf={clusters?.labels ?? null}
								reducedMotion={reducedMotion}
								onSlowEdges={onSlowEdges}
								onSnapshotter={onSnapshotter}
								cameraOverride={cameraOverride}
							/>
						</div>
						<Legend sample={sampleModel!} colourBy={colourBy} pointCap={pointCap} backend={backend} colouring={colouring} notes={legendNotes} marks={legendMarks} scopeRetry={scopeState === 'failed' && busy === null ? { label: SCOPE_RETRY, onClick: retryScope } : null} />
					</div>
					<aside style={MAP_STYLES.side} aria-label="Map details">
						<div role="tablist" aria-label="Map details" style={MAP_STYLES.tabs}>
							{TABS.map((t) => (
								<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} style={{ ...MAP_STYLES.tab, ...(tab === t.id ? MAP_STYLES.tabActive : {}) }} onClick={() => setTab(t.id)}>
									{t.label}
								</button>
							))}
						</div>
						<div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} style={MAP_STYLES.sideBody}>
							{tab === 'point' ? (
								<PointInspector
									sample={sampleModel!}
									index={selected}
									neighbours={neighbours && neighbours.index === selected ? neighbours.result : null}
									querySim={selected !== null && query?.sims ? (query.sims[selected] ?? null) : null}
									score={selectedScore}
									text={selectedKey && fullText?.key === keyString(selectedKey[0], selectedKey[1]) ? fullText.text : selectedKey && chunkText?.key === keyString(selectedKey[0], selectedKey[1]) ? chunkText.text : null}
									busy={neighbourBusy ? BUSY.neighbours : null}
									error={neighbourError}
									writes={model.writes}
									onOpenDocument={(objectId, chunkId) => actions.openDocument(objectId, chunkId)}
									onFindSimilar={(key) => {
										selection.setHighlight({ source: 'neighbors', keys: neighbours?.result.items.map((item) => item.key) ?? [key] });
										selectKey(key);
									}}
									onSelectNeighbour={selectKey}
									onRemoveDocument={(objectId) => removeDocuments([objectId])}
									staging={staging}
									treeNeighbours={edges === 'tree' && tree && selected !== null ? treeNeighbours(tree.edges, selected) : null}
									onAddExample={onAddExample}
									examplePolarity={selectedKey ? polarityOf(examples, selectedKey) : null}
									onShowText={onShowText}
									connectionKey={model.connectionKey}
									query={query?.text ?? null}
								/>
							) : null}
							{tab === 'neighbours' ? (
								selected === null ? (
									<p style={MAP_STYLES.note}>Select a point to list its neighbours in this sample (the node&apos;s kNN graph).</p>
								) : (
									<ol aria-label="Neighbours in this sample" style={MAP_STYLES.list}>
										{neighboursOf(sample, selected).map((nb) => (
											<li key={nb.i} style={MAP_STYLES.row}>
												<button type="button" style={MAP_STYLES.linkButton} onClick={() => void onPick(nb.i)}>
													{documentOf(sample, nb.i)?.path ?? '?'} #{sample.points.chunk[nb.i]}
												</button>
												<span style={MAP_STYLES.small}> similarity {nb.sim.toFixed(3)}</span>
											</li>
										))}
									</ol>
								)
							) : null}
							{tab === 'duplicates' ? (
								<DuplicatesPanel
									sample={sampleModel!}
									writes={model.writes}
									onSelect={(indices) => {
										selection.setHighlight({ source: 'neighbors', keys: indices.map((i) => pointKey(sample, i)) });
										const shown = selection.getState().highlight;
										if (shown) DUPLICATE_GROUPS.add(shown);
									}}
									onRemoveDocument={(objectId) => removeDocuments([objectId])}
									connectionKey={model.connectionKey}
									documents={props.documents ?? null}
									onRemoveDocuments={(objectIds) => removeDocuments(objectIds)}
									staging={staging}
									onOpenDocument={(objectId, chunkId) => actions.openDocument(objectId, chunkId)}
								/>
							) : null}
							{tab === 'outliers' ? (
								<OutliersPanel
									sample={sampleModel!}
									onSelect={(i) => {
										void onPick(i);
										setCentreOn({ index: i, seq: ++seq.current });
									}}
									connectionKey={model.connectionKey}
									writes={model.writes}
									onRemoveDocument={(objectId) => removeDocuments([objectId])}
									staging={staging}
									onShowNeighbours={(i) => {
										void onPick(i);
										setTab('neighbours');
									}}
								/>
							) : null}
							{tab === 'clusters' ? (
								<ClustersPanel
									sample={sampleModel!}
									minSize={minClusterSize}
									onMinSize={onMinSize}
									chat={model.chat}
									onShow={(cluster) => isolate(clusters ? Array.from({ length: sample.n }, (_, i) => i).filter((i) => clusters.labels[i] === cluster) : [])}
									onAskAbout={(objectIds) => actions.askAbout(objectIds)}
									onSelect={(indices) => selection.setHighlight({ source: 'neighbors', keys: indices.map((i) => pointKey(sample, i)) })}
									view={clusters}
									colours={clusterPalette}
									noiseColour={palette?.other}
									hidden={hidden}
									clustersOffered={model.capabilities.clusters === true}
									maxDocuments={limits.scope_keys_max}
									isolated={isolation}
									onShowAll={onShowAll}
									onExpand={onExpandIsolation}
									exportItemOf={clusterExportItem}
									collection={model.collection}
								/>
							) : null}
							{tab === 'recommend' ? (
								<RecommendPanel
									sample={sampleModel}
									limits={limits}
									capabilities={model.capabilities}
									examples={examples}
									onExamplesChange={setExamples}
									queryText={query?.text ?? null}
									onRun={onRecommend}
									onSelect={selectKey}
									onPin={(keys) => void pinKeys(keys.map((key) => [key[0], key[1]] as VectorKey))}
								/>
							) : null}
							{tab === 'selection' ? (
								<SelectionTab
									keys={lassoKeys}
									chat={model.chat}
									writes={model.writes}
									onAskAbout={(ids) => actions.askAbout(ids)}
									onRemove={(ids) => removeDocuments(ids)}
									staging={staging}
									onCopy={(keys) => {
										const text = JSON.stringify(keys);
										if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(text).then(() => actions.announce(`Copied ${num(keys.length)} keys.`), () => actions.announce(COPY_KEYS_BLOCKED));
										else actions.announce(COPY_KEYS_BLOCKED);
									}}
									onIsolate={(keys) => isolate(resolveKeys(keys, keyIdx, []).points)}
									isolated={isolation}
									onShowAll={onShowAll}
									onExpand={onExpandIsolation}
								>
									<SimilarityMatrix
										keys={lassoKeys}
										limits={limits}
										channel={channel}
										storeNode={storeNode}
										labelOf={(key) => {
											const index = keyIdx.get(keyString(key[0], key[1]));
											return index === undefined ? `${key[0]} #${key[1]}` : `${documentOf(sample, index)?.path ?? key[0]} #${key[1]}`;
										}}
										onShowPair={(a, b) => {
											selection.setHighlight({ source: 'neighbors', keys: [a, b] });
											selectKey(a);
										}}
										onExport={(item) => {
											setMatrixItem(item);
											actions.announce("The similarity matrix is in the map's Export menu.");
										}}
									/>
								</SelectionTab>
							) : null}
							{tab === 'heat' ? (
								selected === null || query === null ? (
									<p style={MAP_STYLES.note}>Run a text query and select a point to see how similar every chunk of its document is to the query.</p>
								) : heat && heat.objectId === selectedKey?.[0] ? (
									<HeatStrip chunks={heat.chunks} scores={heat.scores} focused={selectedKey?.[1] ?? null} onSelectChunk={(chunkId) => actions.openDocument(heat.objectId, chunkId)} label="Similarity of each chunk to the query" />
								) : (
									<p style={MAP_STYLES.note} role="status">
										{BUSY.neighbours}
									</p>
								)
							) : null}
						</div>
					</aside>
				</div>
			)}
		</div>
	);
}

export default MapView;
