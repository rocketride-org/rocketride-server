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
// VECTOR-UI — saved views of the map (pure)
// =============================================================================
//
// A view keeps how the map was drawn: the sample's size, mode and seed, the
// layout, the colouring, the edges, the minimum cluster size, the text query,
// the scope's saved filter, the selection (at most scope_keys_max keys) and
// the camera. Never a token, never a vector: a view is rebuilt field by field
// from the state handed to it, keys must be [objectId, integer chunk], and the
// camera keeps only short numeric fields (a 2D centre and scale, or a 3D orbit).
//
// Views live in memory, per connection, at most SAVED_VIEWS_MAX: the store is
// the 'saved views' cache of adapters/connections.ts, which the identity
// change empties through the cache registry (sign-out, another user). This
// module takes the store as an argument and imports no call module.
//
// Applying a view (the map does it, through planApply and restoreSelection):
//   1. sample again with the view's n, mode, seed and scope, with include_keys
//      = the first project_keys_max (200) saved keys: a sample pins at most
//      that many, so the rest of a large selection rests on the seed;
//   2. restore the selection by key lookup in the new sample;
//   3. draw at most project_keys_max saved keys that are missing from it as
//      hollow points through one `project {keys}` call; drop the rest;
//   4. say "1,340 of 1,900 selected points restored; 200 drawn hollow;
//      360 dropped". The text query is not run again on its own (it costs an
//      `embed` call): the map offers "Run saved query".
// =============================================================================

import type { ClusterMinSize, ColourBy, EdgeMode, EdgesPerPoint, ISavedFilter, ISavedView, ISavedViewRestore, ISavedViewState, IVectorLimits, MapLayout, SampleMode, VectorKey } from '../contract/types';

/** Views kept per connection. */
export const SAVED_VIEWS_MAX = 20;

/** Characters in a view's name. */
export const VIEW_NAME_MAX = 60;

/** Characters of a saved text query (an embed input is at most 8,000). */
export const VIEW_QUERY_MAX = 2_000;

/** Characters of a saved filter id. */
const FILTER_ID_MAX = 128;

/** The store: views by connection key (adapters/connections.ts `savedViews`). */
export interface IViewStore {
	get(key: string): readonly ISavedView[] | undefined;
	set(key: string, views: readonly ISavedView[]): unknown;
	delete(key: string): boolean;
}

const LAYOUTS: readonly MapLayout[] = ['pca', 'neighbour-graph', 'tsne'];
const COLOURS: readonly ColourBy[] = ['document', 'folder', 'type', 'chunk-position', 'query-similarity', 'density', 'cluster'];
const EDGES: readonly EdgeMode[] = ['none', 'neighbours', 'tree'];
const EDGES_M: readonly EdgesPerPoint[] = [3, 5, 10];
const MIN_SIZES: readonly ClusterMinSize[] = [2, 5, 10];
const MODES: readonly SampleMode[] = ['detailed', 'light'];

/** The cap sentence. */
export const VIEWS_FULL = `${SAVED_VIEWS_MAX} views are kept per connection; delete one to save another.`;

/** No sample to save. */
export const NO_SAMPLE_TO_SAVE = 'Draw a sample first.';

/**
 * en-US count.
 *
 * @param n - A count.
 * @returns E.g. '1,340'.
 */
function count(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * The views of a connection, newest first.
 *
 * @param store - The store.
 * @param key - The connection key.
 * @returns Its views.
 */
export function listViews(store: IViewStore, key: string): readonly ISavedView[] {
	return store.get(key) ?? [];
}

/**
 * A well-formed key, copied (never the caller's array).
 *
 * @param value - Anything.
 * @returns [objectId, chunk] or null.
 */
function cleanKey(value: unknown): VectorKey | null {
	if (!Array.isArray(value) || value.length !== 2) return null;
	const [objectId, chunk] = value as unknown[];
	if (typeof objectId !== 'string' || objectId === '' || objectId.length > 256) return null;
	if (typeof chunk !== 'number' || !Number.isInteger(chunk) || chunk < 0) return null;
	return [objectId, chunk];
}

/**
 * A finite number, or null.
 *
 * @param value - Anything.
 * @returns The number or null.
 */
function finite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The camera as a view keeps it: a 2D centre and scale, or a 3D orbit; anything else is dropped.
 *
 * @param value - The map's camera.
 * @returns A copy with only those fields, or null.
 */
function cleanCamera(value: unknown): unknown {
	if (!value || typeof value !== 'object') return null;
	const c = value as Record<string, unknown>;
	if (c.mode === '2d') {
		const [cx, cy, scale] = [finite(c.cx), finite(c.cy), finite(c.scale)];
		return cx === null || cy === null || scale === null ? null : { mode: '2d', cx, cy, scale };
	}
	if (c.mode === '3d') {
		const target = Array.isArray(c.target) && c.target.length === 3 ? c.target.map(finite) : null;
		const [yaw, pitch, distance, fov] = [finite(c.yaw), finite(c.pitch), finite(c.distance), finite(c.fov)];
		if (!target || target.some((v) => v === null) || yaw === null || pitch === null || distance === null || fov === null) return null;
		return { mode: '3d', target, yaw, pitch, distance, fov };
	}
	return null;
}

/** The outcome of checking a state. */
type Checked = { ok: true; state: ISavedViewState; dropped: number } | { ok: false; reason: string };

/**
 * Check a state and copy it field by field (nothing else survives).
 *
 * @param state - What the map handed over.
 * @param limits - The store's limits.
 * @returns The clean state and how many selected keys were over the cap, or why it cannot be saved.
 */
export function checkState(state: ISavedViewState | null, limits: IVectorLimits): Checked {
	if (!state || typeof state !== 'object') return { ok: false, reason: NO_SAMPLE_TO_SAVE };
	const s = state as unknown as Record<string, unknown>;
	const mode = MODES.includes(s.mode as SampleMode) ? (s.mode as SampleMode) : null;
	if (mode === null) return { ok: false, reason: 'The view has an unknown sample mode.' };
	const cap = mode === 'light' ? limits.sample_max_light : limits.sample_max;
	if (typeof s.n !== 'number' || !Number.isInteger(s.n) || s.n < 1 || s.n > cap) return { ok: false, reason: `A ${mode} sample holds 1 to ${count(cap)} points.` };
	if (typeof s.seed !== 'number' || !Number.isSafeInteger(s.seed) || s.seed < 0) return { ok: false, reason: 'The view has no valid seed.' };
	if (!LAYOUTS.includes(s.layout as MapLayout)) return { ok: false, reason: 'The view has an unknown layout.' };
	if (!COLOURS.includes(s.colourBy as ColourBy)) return { ok: false, reason: 'The view has an unknown colouring.' };
	const edges = EDGES.includes(s.edges as EdgeMode) ? (s.edges as EdgeMode) : 'none';
	const edgesM = EDGES_M.includes(s.edgesM as EdgesPerPoint) ? (s.edgesM as EdgesPerPoint) : 5;
	const minClusterSize = MIN_SIZES.includes(s.minClusterSize as ClusterMinSize) ? (s.minClusterSize as number) : 5;
	const query = typeof s.query === 'string' && s.query.trim() !== '' ? s.query.slice(0, VIEW_QUERY_MAX) : null;
	const scopeFilterId = typeof s.scopeFilterId === 'string' && s.scopeFilterId !== '' && s.scopeFilterId.length <= FILTER_ID_MAX ? s.scopeFilterId : null;
	const seen = new Set<string>();
	const keys: VectorKey[] = [];
	for (const raw of Array.isArray(s.selection) ? (s.selection as unknown[]) : []) {
		const key = cleanKey(raw);
		if (!key) continue;
		const id = `${key[0]}#${key[1]}`;
		if (seen.has(id)) continue;
		seen.add(id);
		keys.push(key);
	}
	const keep = Math.max(0, limits.scope_keys_max);
	return {
		ok: true,
		dropped: Math.max(0, keys.length - keep),
		state: { n: s.n, mode, seed: s.seed, layout: s.layout as MapLayout, colourBy: s.colourBy as ColourBy, edges, edgesM, minClusterSize, query, scopeFilterId, selection: keys.slice(0, keep), camera: cleanCamera(s.camera) },
	};
}

/** The outcome of a save. */
export type SaveResult = { ok: true; view: ISavedView; replaced: boolean; kept: number; dropped: number } | { ok: false; reason: string };

/**
 * Save a view under a name (a used name, any case, is replaced; the newest is listed first).
 *
 * @param store - The store.
 * @param key - The connection key.
 * @param name - The view's name.
 * @param state - The map's state now.
 * @param limits - The store's limits.
 * @param stamp - When, and the new view's id.
 * @returns The view, or why it was not saved.
 */
export function saveView(store: IViewStore, key: string, name: string, state: ISavedViewState | null, limits: IVectorLimits, stamp: { now: number; id: string }): SaveResult {
	const trimmed = typeof name === 'string' ? name.trim() : '';
	if (trimmed === '') return { ok: false, reason: 'Give the view a name.' };
	if (trimmed.length > VIEW_NAME_MAX) return { ok: false, reason: `A view name is at most ${VIEW_NAME_MAX} characters.` };
	const views = listViews(store, key);
	const same = views.find((v) => v.name.toLowerCase() === trimmed.toLowerCase()) ?? null;
	if (!same && views.length >= SAVED_VIEWS_MAX) return { ok: false, reason: VIEWS_FULL };
	const checked = checkState(state, limits);
	if (!checked.ok) return checked;
	const view: ISavedView = { ...checked.state, id: stamp.id, name: trimmed, savedAt: stamp.now };
	store.set(key, [view, ...views.filter((v) => v !== same)]);
	return { ok: true, view, replaced: same !== null, kept: view.selection.length, dropped: checked.dropped };
}

/**
 * Delete a view.
 *
 * @param store - The store.
 * @param key - The connection key.
 * @param id - The view.
 * @returns Whether a view was deleted.
 */
export function deleteView(store: IViewStore, key: string, id: string): boolean {
	const views = listViews(store, key);
	const next = views.filter((v) => v.id !== id);
	if (next.length === views.length) return false;
	if (next.length === 0) store.delete(key);
	else store.set(key, next);
	return true;
}

/** Whether Save can be offered now, and why not. */
export function saveBlocker(store: IViewStore, key: string): string | null {
	return listViews(store, key).length >= SAVED_VIEWS_MAX ? VIEWS_FULL : null;
}

/** What the map does to apply a view. */
export interface IApplyPlan {
	/** The sample call: the view's size (at most what the store allows now), mode and seed. */
	n: number;
	mode: SampleMode;
	seed: number;
	/** At most project_keys_max saved keys, in saved order (the sample's include_keys). */
	includeKeys: VectorKey[];
	scopeFilterId: string | null;
	layout: MapLayout;
	colourBy: ColourBy;
	edges: EdgeMode;
	edgesM: EdgesPerPoint;
	minClusterSize: number;
	camera: unknown;
	/** Offered as "Run saved query"; never run on its own. */
	query: string | null;
}

/**
 * The plan of applying a view.
 *
 * @param view - The view.
 * @param limits - The store's limits now.
 * @returns The sample call and the map's settings.
 */
export function planApply(view: ISavedView, limits: IVectorLimits): IApplyPlan {
	const cap = view.mode === 'light' ? limits.sample_max_light : limits.sample_max;
	return {
		n: Math.max(1, Math.min(view.n, cap)),
		mode: view.mode,
		seed: view.seed,
		includeKeys: view.selection.slice(0, Math.max(0, limits.project_keys_max)).map((k) => [k[0], k[1]] as VectorKey),
		scopeFilterId: view.scopeFilterId,
		layout: view.layout,
		colourBy: view.colourBy,
		edges: view.edges,
		edgesM: view.edgesM,
		minClusterSize: view.minClusterSize,
		camera: view.camera,
		query: view.query,
	};
}

/**
 * The saved filter a view's scope came from.
 *
 * @param view - The view.
 * @param filters - The connection's saved filters.
 * @returns The filter, or null; `missing` when the view named one that is gone (the map then samples unscoped and says so).
 */
export function resolveScope(view: Pick<ISavedView, 'scopeFilterId'>, filters: readonly ISavedFilter[]): { filter: ISavedFilter | null; missing: boolean } {
	if (view.scopeFilterId === null) return { filter: null, missing: false };
	const filter = filters.find((f) => f.id === view.scopeFilterId) ?? null;
	return { filter, missing: filter === null };
}

/** What restoring a selection found. */
export interface IRestoredSelection {
	/** Point indices of the saved keys found in the new sample, in saved order. */
	indices: number[];
	/** Their keys. */
	restoredKeys: VectorKey[];
	/** At most project_keys_max missing keys, in saved order: the map pins them hollow with one `project {keys}` call. */
	hollow: VectorKey[];
	/** The other missing keys. */
	dropped: VectorKey[];
	counts: ISavedViewRestore;
}

/**
 * Restore a saved selection by key lookup in the new sample.
 *
 * @param keys - The saved selection.
 * @param keyIndex - The new sample's `objectId#chunkId` to point index (map/model.ts keyIndex).
 * @param limits - The store's limits (project_keys_max).
 * @returns Found indices, keys to draw hollow, keys dropped, and the counts.
 */
export function restoreSelection(keys: readonly VectorKey[], keyIndex: ReadonlyMap<string, number>, limits: IVectorLimits): IRestoredSelection {
	const seen = new Set<string>();
	const indices: number[] = [];
	const restoredKeys: VectorKey[] = [];
	const missing: VectorKey[] = [];
	for (const key of keys) {
		const id = `${key[0]}#${key[1]}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const index = keyIndex.get(id);
		if (index === undefined) missing.push([key[0], key[1]]);
		else {
			indices.push(index);
			restoredKeys.push([key[0], key[1]]);
		}
	}
	const pin = Math.max(0, limits.project_keys_max);
	const hollow = missing.slice(0, pin);
	const dropped = missing.slice(pin);
	return { indices, restoredKeys, hollow, dropped, counts: { selected: seen.size, restored: indices.length, hollow: hollow.length, dropped: dropped.length } };
}

/**
 * The line after applying a view.
 *
 * @param counts - What was restored.
 * @returns E.g. "1,340 of 1,900 selected points restored; 200 drawn hollow; 360 dropped".
 */
export function restoreSentence(counts: ISavedViewRestore): string {
	if (counts.selected === 0) return 'The view had no selection';
	const parts = [`${count(counts.restored)} of ${count(counts.selected)} selected points restored`];
	if (counts.hollow > 0) parts.push(`${count(counts.hollow)} drawn hollow`);
	if (counts.dropped > 0) parts.push(`${count(counts.dropped)} dropped`);
	return parts.join('; ');
}

/**
 * The menu's footer: what a view keeps of a selection.
 *
 * @param limits - The store's limits.
 * @returns The sentence.
 */
export function keepSentence(limits: IVectorLimits): string {
	return `Selections of up to ${count(limits.scope_keys_max)} points are kept; up to ${count(limits.project_keys_max)} points not in the new sample are drawn hollow, the rest are dropped.`;
}

/** The layouts' words (as the toolbar names them). */
const LAYOUT_WORDS: Record<MapLayout, string> = { pca: 'PCA', 'neighbour-graph': 'Neighbour graph', tsne: 't-SNE' };

/**
 * One line about a view.
 *
 * @param view - The view.
 * @returns E.g. "1,000 points · detailed · seed 7 · t-SNE · Colour by cluster · 300 selected · query".
 */
export function viewSummary(view: ISavedView): string {
	const parts = [`${count(view.n)} points`, view.mode, `seed ${view.seed}`, LAYOUT_WORDS[view.layout] ?? view.layout, `Colour by ${view.colourBy.replace('-', ' ')}`];
	if (view.edges !== 'none') parts.push(view.edges === 'tree' ? 'spanning tree' : `${view.edgesM} neighbours`);
	if (view.selection.length > 0) parts.push(`${count(view.selection.length)} selected`);
	if (view.scopeFilterId) parts.push('scoped');
	if (view.query) parts.push('query');
	return parts.join(' · ');
}

/** A counter for view ids within this page. */
let nextId = 0;

/**
 * A new view id (unique in this page; no randomness needed, views never leave it).
 *
 * @param now - Epoch ms.
 * @returns E.g. 'view-lx3k2a-4'.
 */
export function newViewId(now: number): string {
	nextId += 1;
	return `view-${now.toString(36)}-${nextId}`;
}

/**
 * The name Save proposes.
 *
 * @param views - The connection's views.
 * @returns "View N" with N the first unused number.
 */
export function defaultViewName(views: readonly ISavedView[]): string {
	const used = new Set(views.map((v) => v.name.toLowerCase()));
	for (let i = views.length + 1; ; i += 1) if (!used.has(`view ${i}`)) return `View ${i}`;
}
