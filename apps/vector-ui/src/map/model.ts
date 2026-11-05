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
// MAP - SAMPLE MODEL HELPERS (pure; no vectors anywhere)
// =============================================================================
//
// The `sample` answer is columnar: point i is (docs[doc[i]], chunk[i]) at
// (x[i], y[i], z[i]). These helpers give the map keys, the hidden mask of
// removed documents (indices never shift: a removed document's points are only
// hidden), PCA positions, a document's chunk path and a point's neighbours from
// the node's kNN graph; and the rows of the map's exports (points, clusters,
// duplicate pairs), built only when an export is chosen. An export row holds
// words and numbers only: paths, chunk numbers, scores, layout coordinates and
// the short snippet the node already sent; never a vector. The scope rule says
// whether the console's scope is the one the points on screen were drawn with.
// =============================================================================

import { EXPORT_COLUMNS } from '../contract/types';
import type { ExportCell, IExportRows, ISampleDoc, ISampleModel, ISampleResult, VectorKey } from '../contract/types';

/**
 * The string form of a key.
 *
 * @param objectId - Document.
 * @param chunkId - Chunk.
 * @returns `objectId#chunkId`.
 */
export function keyString(objectId: string, chunkId: number): string {
	return `${objectId}#${chunkId}`;
}

/**
 * The key of a point.
 *
 * @param sample - The answer.
 * @param i - Point index.
 * @returns (objectId, chunkId).
 */
export function pointKey(sample: ISampleResult, i: number): VectorKey {
	return [sample.docs[sample.points.doc[i] as number]?.objectId ?? '', sample.points.chunk[i] as number];
}

/**
 * The document of a point.
 *
 * @param sample - The answer.
 * @param i - Point index.
 * @returns Its docs row.
 */
export function documentOf(sample: ISampleResult, i: number): ISampleDoc | null {
	return sample.docs[sample.points.doc[i] as number] ?? null;
}

/**
 * Point index by key string.
 *
 * @param sample - The answer.
 * @returns `objectId#chunkId` to index.
 */
export function keyIndex(sample: ISampleResult): Map<string, number> {
	const out = new Map<string, number>();
	for (let i = 0; i < sample.n; i += 1) {
		const [objectId, chunk] = pointKey(sample, i);
		const key = keyString(objectId, chunk);
		if (!out.has(key)) out.set(key, i);
	}
	return out;
}

/**
 * The mask of points whose document was removed since the sample was drawn.
 *
 * @param model - The sample model.
 * @returns 1 per hidden point, or null when nothing is hidden.
 */
export function hiddenMask(model: ISampleModel): Uint8Array | null {
	if (model.removed.length === 0) return null;
	const removed = new Set(model.removed);
	const docs = model.result.docs.map((d) => removed.has(d.objectId));
	if (!docs.some(Boolean)) return null;
	const mask = new Uint8Array(model.result.n);
	for (let i = 0; i < model.result.n; i += 1) mask[i] = docs[model.result.points.doc[i] as number] ? 1 : 0;
	return mask;
}

/**
 * Points still drawn.
 *
 * @param model - The sample model.
 * @returns The count.
 */
export function visibleCount(model: ISampleModel): number {
	const mask = hiddenMask(model);
	if (mask === null) return model.result.n;
	let hidden = 0;
	for (const v of mask) hidden += v;
	return model.result.n - hidden;
}

/**
 * The node's PCA coordinates.
 *
 * @param sample - The answer.
 * @param dims - 2 or 3 (z is 0 when the answer has none).
 * @returns Coordinates, `dims` per point.
 */
export function pcaPositions(sample: ISampleResult, dims: 2 | 3): Float32Array {
	const out = new Float32Array(sample.n * dims);
	const z = sample.points.z;
	for (let i = 0; i < sample.n; i += 1) {
		out[i * dims] = sample.points.x[i] ?? 0;
		out[i * dims + 1] = sample.points.y[i] ?? 0;
		if (dims === 3) out[i * dims + 2] = z ? (z[i] ?? 0) : 0;
	}
	return out;
}

/**
 * A document's sampled points in chunk order (the "chunk path").
 *
 * @param sample - The answer.
 * @param objectId - The document.
 * @returns Point indices.
 */
export function chunkPath(sample: ISampleResult, objectId: string): number[] {
	const doc = sample.docs.findIndex((d) => d.objectId === objectId);
	if (doc < 0) return [];
	const out: number[] = [];
	for (let i = 0; i < sample.n; i += 1) if (sample.points.doc[i] === doc) out.push(i);
	return out.sort((a, b) => (sample.points.chunk[a] as number) - (sample.points.chunk[b] as number) || a - b);
}

/**
 * A point's neighbours in the node's kNN graph (sample points only).
 *
 * @param sample - The answer.
 * @param i - Point index.
 * @param limit - Most to return.
 * @returns Neighbours, nearest first, with the node's similarity.
 */
export function neighboursOf(sample: ISampleResult, i: number, limit = Infinity): Array<{ i: number; sim: number }> {
	const start = sample.knn.offsets_row[i] ?? 0;
	const end = sample.knn.offsets_row[i + 1] ?? start;
	const out: Array<{ i: number; sim: number }> = [];
	for (let e = start; e < end && out.length < limit; e += 1) out.push({ i: sample.knn.cols[e] as number, sim: sample.knn.sims[e] as number });
	return out;
}

/** The shift and scale that bring a layout into the display frame. */
export interface ILayoutTransform {
	cx: number;
	cy: number;
	cz: number;
	/** Multiplier applied after centring. */
	s: number;
}

/**
 * Bring a layout into one display frame: its visible points centred on the
 * origin with an RMS radius of 1. PCA coordinates and force-layout units differ
 * by orders of magnitude; in one frame the camera stays put and a layout change
 * can tween.
 *
 * @param raw - Layout coordinates, `dims` per point.
 * @param dims - 2 or 3.
 * @param hidden - Points left out of the frame (still transformed).
 * @returns The transformed coordinates and the transform (for the star and pinned points).
 */
export function normaliseLayout(raw: Float32Array, dims: 2 | 3, hidden: ArrayLike<number> | null): { positions: Float32Array; transform: ILayoutTransform } {
	const n = Math.floor(raw.length / dims);
	let count = 0;
	let cx = 0;
	let cy = 0;
	let cz = 0;
	for (let i = 0; i < n; i += 1) {
		if (hidden && hidden[i]) continue;
		cx += raw[i * dims] as number;
		cy += raw[i * dims + 1] as number;
		if (dims === 3) cz += raw[i * dims + 2] as number;
		count += 1;
	}
	if (count > 0) {
		cx /= count;
		cy /= count;
		cz /= count;
	}
	let r2 = 0;
	for (let i = 0; i < n; i += 1) {
		if (hidden && hidden[i]) continue;
		const dx = (raw[i * dims] as number) - cx;
		const dy = (raw[i * dims + 1] as number) - cy;
		const dz = dims === 3 ? (raw[i * dims + 2] as number) - cz : 0;
		r2 += dx * dx + dy * dy + dz * dz;
	}
	const rms = count > 0 ? Math.sqrt(r2 / count) : 0;
	const transform: ILayoutTransform = { cx, cy, cz, s: rms > 0 && Number.isFinite(rms) ? 1 / rms : 1 };
	const positions = new Float32Array(raw.length);
	for (let i = 0; i < n; i += 1) {
		positions[i * dims] = ((raw[i * dims] as number) - cx) * transform.s;
		positions[i * dims + 1] = ((raw[i * dims + 1] as number) - cy) * transform.s;
		if (dims === 3) positions[i * dims + 2] = ((raw[i * dims + 2] as number) - cz) * transform.s;
	}
	return { positions, transform };
}

/**
 * Put a place (in raw layout units) into the display frame.
 *
 * @param place - x, y (and z).
 * @param t - From {@link normaliseLayout}.
 * @returns The place in the display frame.
 */
export function applyTransform(place: { x: number; y: number; z?: number }, t: ILayoutTransform): { x: number; y: number; z?: number } {
	const out: { x: number; y: number; z?: number } = { x: (place.x - t.cx) * t.s, y: (place.y - t.cy) * t.s };
	if (place.z !== undefined) out.z = (place.z - t.cz) * t.s;
	return out;
}

/**
 * Spread coordinates that were rounded to `step` (light samples carry 2-decimal
 * floats) uniformly within their rounding interval, seeded. Rounding already
 * moved every point by up to step/2; drawing the rounded values as they are
 * shows a lattice that is not in the data. The spread adds up to another
 * step/2, so a drawn point sits within ONE step of its true PCA position (the
 * legend says so: wording.LIGHT_POSITIONS). The refined layouts start from the
 * undithered values.
 *
 * @param positions - Rounded coordinates.
 * @param step - The rounding step (0.01 for 2 decimals); 0 returns a copy.
 * @param seed - The sample's seed (same sample, same picture).
 * @returns Dithered coordinates (a new array).
 */
export function ditherRounded(positions: Float32Array, step: number, seed: number): Float32Array {
	const out = Float32Array.from(positions);
	if (!(step > 0)) return out;
	let state = (seed ^ 0x9e3779b9) | 0;
	for (let i = 0; i < out.length; i += 1) {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		out[i] = (out[i] as number) + (u - 0.5) * step * 0.999;
	}
	return out;
}

// =============================================================================
// EXPORT ROWS
// =============================================================================

/** What a points export reads besides the sample. */
export interface IPointRowContext {
	/** The layout shown, `dims` per point (raw layout units), or null. */
	positions: ArrayLike<number> | null;
	dims: 2 | 3;
	/** Similarity of each point to the active query, or null. */
	querySims: ArrayLike<number> | null;
	/** Each point's cluster (-1: none) and a cluster's words, or null without clusters. */
	clusters: { labels: ArrayLike<number>; label(cluster: number): string } | null;
}

/** Four decimals (coordinates, similarities). */
const dp4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * Export rows of some points (EXPORT_COLUMNS.points). `chunk_index` is the
 * chunk's position in its document, which is its chunk id in this store layout.
 *
 * @param sample - The `sample` answer.
 * @param indices - The points, in order.
 * @param ctx - Layout, query similarities, clusters.
 * @returns Columns and rows.
 */
export function pointExportRows(sample: ISampleResult, indices: readonly number[], ctx: IPointRowContext): IExportRows {
	const duplicate = new Set<number>();
	for (const d of sample.duplicates) {
		duplicate.add(d.a);
		duplicate.add(d.b);
	}
	const outliers = new Set(sample.outliers);
	const rows = indices.map((i): Record<string, ExportCell> => {
		const doc = documentOf(sample, i);
		const chunk = sample.points.chunk[i] as number;
		const g = ctx.clusters ? ((ctx.clusters.labels[i] as number | undefined) ?? -1) : -1;
		const at = (d: number): number | null => (ctx.positions && i * ctx.dims + d < ctx.positions.length ? dp4(ctx.positions[i * ctx.dims + d] as number) : null);
		return {
			objectId: doc?.objectId ?? '',
			chunkId: chunk,
			path: doc?.path ?? '',
			chunk_index: chunk,
			length: sample.points.len[i] ?? null,
			density: typeof sample.density[i] === 'number' ? dp4(sample.density[i] as number) : null,
			cluster: g >= 0 ? g + 1 : null,
			cluster_label: g >= 0 && ctx.clusters ? ctx.clusters.label(g) : null,
			query_similarity: ctx.querySims && typeof ctx.querySims[i] === 'number' ? dp4(ctx.querySims[i] as number) : null,
			is_duplicate: duplicate.has(i),
			is_outlier: outliers.has(i),
			x: at(0),
			y: at(1),
			z: ctx.dims === 3 ? at(2) : null,
			snippet: sample.points.snip?.[i] ?? null,
		};
	});
	return { columns: EXPORT_COLUMNS.points, rows };
}

/**
 * Export rows of the clusters: one per cluster with its words, size and documents.
 *
 * @param rows - The Clusters tab's rows (map/clusters.ts clusterRows).
 * @returns Columns and rows.
 */
export function clusterExportRows(rows: ReadonlyArray<{ cluster: number; label: string; keywords: readonly string[]; size: number; documents: readonly string[] }>): IExportRows {
	return {
		columns: ['cluster', 'label', 'keywords', 'points', 'documents'],
		rows: rows.map((row) => ({ cluster: row.cluster + 1, label: row.label, keywords: row.keywords.join(' '), points: row.size, documents: row.documents.length })),
	};
}

/**
 * Export rows of the node's near-duplicate pairs whose points are both shown.
 *
 * @param sample - The `sample` answer.
 * @param hidden - Points not shown.
 * @returns Columns and rows.
 */
export function duplicateExportRows(sample: ISampleResult, hidden: ArrayLike<number> | null): IExportRows {
	const shown = (i: number): boolean => !(hidden && (hidden[i] as number) !== 0);
	return {
		columns: ['objectId_a', 'chunkId_a', 'path_a', 'objectId_b', 'chunkId_b', 'path_b', 'similarity'],
		rows: sample.duplicates
			.filter((d) => shown(d.a) && shown(d.b))
			.map((d) => ({
				objectId_a: documentOf(sample, d.a)?.objectId ?? '',
				chunkId_a: sample.points.chunk[d.a] ?? null,
				path_a: documentOf(sample, d.a)?.path ?? '',
				objectId_b: documentOf(sample, d.b)?.objectId ?? '',
				chunkId_b: sample.points.chunk[d.b] ?? null,
				path_b: documentOf(sample, d.b)?.path ?? '',
				similarity: dp4(d.sim),
			})),
	};
}

// -----------------------------------------------------------------------------
// The scope a sample was drawn with
// -----------------------------------------------------------------------------

/** The documents a sample is drawn from: one key for them, how many, and the console's words for them. */
export interface IDrawnScope {
	/** `count:id|id|...`, or '' for the whole collection. */
	key: string;
	/** Documents in the scope (0 for the whole collection). */
	documents: number;
	/** The console's words for the scope ('' for the whole collection). */
	label: string;
}

/** The whole collection: no scope. */
export const UNSCOPED: IDrawnScope = Object.freeze({ key: '', documents: 0, label: '' });

/**
 * The scope a draw sends, from the documents the console scoped the map to.
 *
 * @param objectIds - The documents, or null when the map is not scoped.
 * @param label - The console's words for the scope.
 * @returns The scope, or UNSCOPED for none.
 */
export function drawnScope(objectIds: readonly string[] | null, label: string): IDrawnScope {
	return objectIds && objectIds.length > 0 ? { key: `${objectIds.length}:${objectIds.join('|')}`, documents: objectIds.length, label } : UNSCOPED;
}

/** A draw started over the sample on screen for a scope (by key), and whether the store refused it. */
export interface IScopeAttempt {
	key: string;
	failed: boolean;
}

/** What the map knows of the sample on screen: the scope it was drawn with, and the last draw tried over it. */
export interface ISampleScope {
	drawn: IDrawnScope;
	attempt: IScopeAttempt | null;
}

/**
 * How the console's scope stands on the map: `none` (no scope, and the points
 * shown are from the whole collection), `applied` (the points shown were drawn
 * with it), `pending` (a draw with it is due or in flight) or `failed` (the
 * store refused the draw; the points shown were drawn without it).
 */
export type MapScopeState = 'none' | 'applied' | 'pending' | 'failed';

/**
 * The state of the console's scope over the sample on screen.
 *
 * @param target - The key of the scope the console holds ('' for none).
 * @param shown - What the map knows of the sample on screen.
 * @returns The state.
 */
export function mapScopeState(target: string, shown: ISampleScope): MapScopeState {
	if (shown.drawn.key === target) return target === '' ? 'none' : 'applied';
	return shown.attempt !== null && shown.attempt.key === target && shown.attempt.failed ? 'failed' : 'pending';
}

/**
 * Whether the map should draw the sample again for the console's scope: the
 * points shown were drawn with another scope and no draw for this one was
 * tried over them. A refused draw is not tried again by itself (a busy store
 * would be asked in a loop); the legend offers it.
 *
 * @param target - The key of the scope the console holds ('' for none).
 * @param shown - What the map knows of the sample on screen.
 * @returns True when a draw is due.
 */
export function scopeDrawDue(target: string, shown: ISampleScope): boolean {
	return shown.drawn.key !== target && (shown.attempt === null || shown.attempt.key !== target);
}
