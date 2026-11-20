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
// MAP - QUERY PROJECTION (placing a query, answer sources and outside chunks)
// =============================================================================
//
// The view runs Run → `embed` → `project({sample_id, vector})` → `search({vector})`
// and hands this module only the answers, never the vector:
//
//   - the star: on the PCA layout exactly at the projected PCA coordinates; on a
//     refined layout (neighbour graph, t-SNE) there is no exact projection, so it
//     is placed at the similarity-weighted centre of its nearest sample points
//     and marked approximate;
//   - rays: to the TRUE top-k of the whole collection (the `search` answer), each
//     drawn to its sample point, to a pinned point once projected, or listed as
//     outside the sample so the view can `project({keys})` it;
//   - colours by similarity from `project`'s per-point similarities;
//   - a chat answer's star: its question embedded and placed like a query
//     (chatQueryPlan); without `embed`, the score-weighted centre of the sources.
//
// SAMPLE_EXPIRED: the node dropped the sample (600 s, 2 entries); the view draws
// it again with the same seed and pinned keys and retries the call once.
// =============================================================================

import type { IProjectItem, IProjectResult, ISearchResult, MapLayout, VectorKey } from '../contract/types';
import { isExpired } from './calls';
import type { ToolAnswer } from './calls';
import { keyString } from './model';
import { QUERY_NEEDS_EMBED, QUERY_NEEDS_SAMPLE } from './wording';

/** Where the query (or an answer's centre) is drawn. */
export interface IStar {
	x: number;
	y: number;
	z?: number;
	/** False when the position is an estimate on this layout. */
	exact: boolean;
}

/** A placed point (a projected key outside the sample). */
export interface IPlacement {
	x: number;
	y: number;
	z?: number;
	exact: boolean;
}

/** Where one ray ends. */
export type RayTarget =
	| { kind: 'point'; index: number; rank: number; score: number }
	| { kind: 'pinned'; pinned: number; rank: number; score: number }
	| { kind: 'outside'; key: VectorKey; rank: number; score: number };

/**
 * The similarity-weighted centre of some sample points on a layout.
 *
 * @param neighbors - Points and similarities.
 * @param positions - Layout coordinates.
 * @param dims - 2 or 3.
 * @returns The centre, or null without neighbours.
 */
function weightedCentre(neighbors: ReadonlyArray<{ i: number; sim: number }>, positions: ArrayLike<number>, dims: 2 | 3): { x: number; y: number; z?: number } | null {
	const usable = neighbors.filter((nb) => Number.isInteger(nb.i) && nb.i >= 0 && nb.i * dims + 1 < positions.length);
	if (usable.length === 0) return null;
	let weights = usable.map((nb) => Math.max(0, nb.sim));
	const total = weights.reduce((a, b) => a + b, 0);
	if (!(total > 0)) weights = usable.map(() => 1);
	const sum = weights.reduce((a, b) => a + b, 0);
	let x = 0;
	let y = 0;
	let z = 0;
	usable.forEach((nb, t) => {
		const w = (weights[t] as number) / sum;
		x += w * (positions[nb.i * dims] as number);
		y += w * (positions[nb.i * dims + 1] as number);
		if (dims === 3) z += w * (positions[nb.i * dims + 2] as number);
	});
	return dims === 3 ? { x, y, z } : { x, y };
}

/**
 * Where the query star goes.
 *
 * @param item - The `project({vector})` item.
 * @param layout - The layout shown.
 * @param positions - Its coordinates.
 * @param dims - 2 or 3.
 * @returns The star, or null when it cannot be placed.
 */
export function starFromProject(item: IProjectItem, layout: MapLayout, positions: ArrayLike<number>, dims: 2 | 3): IStar | null {
	if (layout === 'pca') {
		const [x, y, z] = item.pca;
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		return dims === 3 ? { x: x as number, y: y as number, z: z ?? 0, exact: true } : { x: x as number, y: y as number, exact: true };
	}
	const centre = weightedCentre(item.neighbors, positions, dims);
	return centre === null ? null : { ...centre, exact: false };
}

/**
 * Where a projected key outside the sample is drawn (a hollow point).
 *
 * @param item - The `project({keys})` item.
 * @param layout - The layout shown.
 * @param positions - Its coordinates.
 * @param dims - 2 or 3.
 * @returns The placement, or null for a key that is in the sample (it is its own point).
 */
export function placeProjected(item: IProjectItem, layout: MapLayout, positions: ArrayLike<number>, dims: 2 | 3): IPlacement | null {
	if (item.in_sample !== null && item.in_sample !== undefined) return null;
	return starFromProject(item, layout, positions, dims);
}

/**
 * Where the rays go: the search answer's ranked results mapped onto the map.
 *
 * @param search - The `search({vector, top_k, include_below_floor})` answer.
 * @param keyIdx - Sample key index (model.keyIndex).
 * @param pinned - Points already projected into the map.
 * @returns One target per result in rank order, and the keys still to project.
 */
export function raysFromSearch(search: ISearchResult, keyIdx: ReadonlyMap<string, number>, pinned: readonly IProjectItem[]): { targets: RayTarget[]; outside: VectorKey[] } {
	const pinnedIdx = new Map<string, number>();
	pinned.forEach((item, p) => {
		if (item.key) pinnedIdx.set(keyString(item.key[0], item.key[1]), p);
	});
	const targets: RayTarget[] = [];
	const outside: VectorKey[] = [];
	search.results.forEach((result, position) => {
		const objectId = result.metadata?.objectId;
		const chunkId = result.metadata?.chunkId;
		if (typeof objectId !== 'string' || typeof chunkId !== 'number') return;
		const rank = typeof result.rank === 'number' ? result.rank : position + 1;
		const score = result.score;
		const key = keyString(objectId, chunkId);
		const index = keyIdx.get(key);
		if (index !== undefined) targets.push({ kind: 'point', index, rank, score });
		else if (pinnedIdx.has(key)) targets.push({ kind: 'pinned', pinned: pinnedIdx.get(key) as number, rank, score });
		else {
			targets.push({ kind: 'outside', key: [objectId, chunkId], rank, score });
			outside.push([objectId, chunkId]);
		}
	});
	return { targets, outside };
}

/**
 * The query's similarity to every sample point.
 *
 * @param project - The `project({vector, with_similarities: true})` answer.
 * @param n - Points in the sample.
 * @returns One value per point, or null when the answer has none.
 */
export function querySims(project: IProjectResult, n: number): Float32Array | null {
	const sims = project.similarities;
	if (!Array.isArray(sims) || sims.length !== n) return null;
	return Float32Array.from(sims);
}

/**
 * Highlighted keys sorted into sample points, pinned points and keys to project.
 *
 * @param keys - The highlight.
 * @param keyIdx - Sample key index.
 * @param pinned - Points already projected.
 * @returns Point indices, pinned indices, and the rest.
 */
export function resolveKeys(keys: readonly VectorKey[], keyIdx: ReadonlyMap<string, number>, pinned: readonly IProjectItem[]): { points: number[]; pinned: number[]; outside: VectorKey[] } {
	const pinnedIdx = new Map<string, number>();
	pinned.forEach((item, p) => {
		if (item.key) pinnedIdx.set(keyString(item.key[0], item.key[1]), p);
	});
	const out = { points: [] as number[], pinned: [] as number[], outside: [] as VectorKey[] };
	for (const key of keys) {
		const s = keyString(key[0], key[1]);
		const index = keyIdx.get(s);
		if (index !== undefined) out.points.push(index);
		else if (pinnedIdx.has(s)) out.pinned.push(pinnedIdx.get(s) as number);
		else out.outside.push([key[0], key[1]]);
	}
	return out;
}

/**
 * The chat star when there is no query vector: the score-weighted centre of the answer's sources.
 *
 * @param indices - Sample points of the sources.
 * @param positions - Layout coordinates.
 * @param dims - 2 or 3.
 * @param weights - Scores per source (equal when absent).
 * @returns The star (approximate), or null without sources.
 */
export function centroidStar(indices: readonly number[], positions: ArrayLike<number>, dims: 2 | 3, weights?: readonly number[]): IStar | null {
	const centre = weightedCentre(indices.map((i, t) => ({ i, sim: weights ? (weights[t] ?? 0) : 1 })), positions, dims);
	return centre === null ? null : { ...centre, exact: false };
}

/**
 * Call with a sample id; on SAMPLE_EXPIRED draw the sample again (same seed and pinned keys) and retry once.
 *
 * @param sampleId - The current sample id.
 * @param call - The call (project, …) for a sample id.
 * @param resample - Draws the sample again; resolves the new id, or null when it failed.
 * @returns The call's answer.
 */
export async function withSampleRetry<T>(sampleId: string, call: (id: string) => Promise<ToolAnswer<T>>, resample: () => Promise<string | null>): Promise<ToolAnswer<T>> {
	const first = await call(sampleId);
	if (!isExpired(first)) return first;
	const next = await resample();
	if (next === null) return first;
	return call(next);
}

/**
 * Why a text query cannot run on the map, or null when it can.
 *
 * @param state - Whether the embedding node is reachable and a sample is drawn.
 * @returns The sentence to show, or null.
 */
export function queryBlocker(state: { embedReady: boolean; hasSample: boolean }): string | null {
	if (!state.embedReady) return QUERY_NEEDS_EMBED;
	if (!state.hasSample) return QUERY_NEEDS_SAMPLE;
	return null;
}

/**
 * Which star a chat answer's highlight gets. The chat tells the map the
 * answer's question before it highlights the sources (`showAnswerOnMap` in
 * src/adapters/consoleActions.ts sets `selection.setQuery(question)` first), so
 * the selection's query is that question when the highlight lands:
 *
 *   - 'run': the embedding node is reachable and the map has not placed this
 *     question: embed it and place the star exactly, with rays to its top-k;
 *   - 'keep': the map already placed this very question (the same answer's
 *     "map" again, or the same text run on the map): its star stays;
 *   - 'centroid': no question, or no embedding node: the score-weighted centre
 *     of the sources, marked approximate (the labelled fallback).
 *
 * @param state - The question the chat told the map, the map's last placed query text, embed reachability.
 * @returns 'run', 'keep' or 'centroid'.
 */
export function chatQueryPlan(state: { told: string | null; mapQuery: string | null; embedReady: boolean }): 'run' | 'keep' | 'centroid' {
	if (!state.embedReady || state.told === null || state.told === '') return 'centroid';
	return state.told === state.mapQuery ? 'keep' : 'run';
}

/**
 * Which questions a Search Compare highlight places. Search tells the map both
 * questions before it highlights both result lists (`showCompareOnMap` in
 * src/adapters/consoleActions.ts sets the selection's `query` and `queryB`
 * first), so they are there when the highlight lands: A becomes the map's query
 * (★) and B a second, hollow star (☆). A question already placed is not
 * embedded again; without an embedding node nothing is placed.
 *
 * @param state - The questions Search told the map, the ones the map placed, embed reachability.
 * @returns Whether to place A and B.
 */
export function comparePlan(state: { told: string | null; toldB: string | null; mapQuery: string | null; mapQueryB: string | null; embedReady: boolean }): { runA: boolean; runB: boolean } {
	if (!state.embedReady || state.told === null || state.told === '' || state.toldB === null || state.toldB === '') return { runA: false, runB: false };
	return { runA: state.told !== state.mapQuery, runB: state.toldB !== state.mapQueryB };
}
