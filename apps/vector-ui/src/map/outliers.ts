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
// MAP - THE OUTLIER REVIEW (pure)
// =============================================================================
//
// A point's density is its mean similarity to its kNN neighbours in the
// sample (the node's `sample.density`); the node lists the lowest 1 % as
// `sample.outliers` (lowest first, ties by index, at least one point, none
// for fewer than ten points or a flat sample). The review lets a person look
// at the lowest 1 %, 2 % or 5 % without a new sample: the percentile is
// applied here, over the density the browser already holds, keeping the
// node's own list first so 1 % is exactly what the node said and a larger
// percentile only adds the next sparsest points.
//
// Each outlier says why it is one: its density against the sample's median
// and its nearest neighbour in the sample (the most similar of its kNN row).
// A reviewed outlier is one chunk: it is kept in the registry's reviewed
// cache under the connection's own outliers scope (outliersScope), apart from
// the documents the duplicates queue marks, so marking a duplicates group
// reviewed marks none of its outliers and marking one outlier marks only it.
// The registry clears both on a change of identity.
// =============================================================================

import type { ISampleResult } from '../contract/types';

/** The percentiles the review offers. */
export const OUTLIER_PERCENTILES = [1, 2, 5] as const;

/** A percentile the review offers. */
export type OutlierPercentile = (typeof OUTLIER_PERCENTILES)[number];

/**
 * How many points a percentile picks: n × pct / 100 rounded half up, at
 * least one (the node's rule, vx_math.outliers).
 *
 * @param n - Points in the sample.
 * @param pct - The percentile.
 * @returns The count.
 */
export function outlierCount(n: number, pct: number): number {
	if (n <= 0) return 0;
	return Math.min(n, Math.max(1, Math.floor((n * pct) / 100 + 0.5)));
}

/**
 * The lowest-density points at a percentile: the node's list first (it is
 * the lowest 1 %), then the sparsest of the rest by density, ties by index.
 * None where the node found none, and none of a removed document.
 *
 * @param sample - The `sample` answer.
 * @param pct - The percentile.
 * @param removed - objectIds removed since the sample was drawn.
 * @returns Point indices, sparsest first.
 */
export function outliersAt(sample: ISampleResult, pct: number, removed: readonly string[] = []): number[] {
	if (sample.outliers.length === 0) return [];
	const count = outlierCount(sample.n, pct);
	const picked: number[] = [];
	const seen = new Set<number>();
	for (const i of sample.outliers) {
		if (picked.length >= count) break;
		if (i >= 0 && i < sample.n && !seen.has(i)) {
			seen.add(i);
			picked.push(i);
		}
	}
	if (picked.length < count) {
		const rest: number[] = [];
		for (let i = 0; i < sample.n; i += 1) if (!seen.has(i)) rest.push(i);
		rest.sort((a, b) => (sample.density[a] ?? 0) - (sample.density[b] ?? 0) || a - b);
		for (const i of rest) {
			if (picked.length >= count) break;
			picked.push(i);
		}
	}
	if (removed.length === 0) return picked;
	const gone = new Set(removed);
	return picked.filter((i) => !gone.has(sample.docs[sample.points.doc[i] as number]?.objectId ?? ''));
}

/**
 * The median of some numbers.
 *
 * @param values - The numbers.
 * @returns The median (0 for none).
 */
export function medianOf(values: ArrayLike<number>): number {
	const sorted = Array.from(values).sort((a, b) => a - b);
	if (sorted.length === 0) return 0;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Why a point is an outlier. */
export interface IOutlierWhy {
	density: number;
	median: number;
	/** Its nearest neighbour in the sample, or null. */
	nearest: { sim: number; path: string; chunk: number } | null;
}

/**
 * The "why" line of an outlier.
 *
 * @param why - Its density, the sample median and its nearest neighbour.
 * @returns E.g. "density 0.12 vs sample median 0.61; nearest neighbour 0.31 in C:/demo/a.md #3".
 */
export function whyText(why: IOutlierWhy): string {
	const head = `density ${why.density.toFixed(2)} vs sample median ${why.median.toFixed(2)}`;
	if (why.nearest === null) return `${head}; no neighbour in this sample`;
	return `${head}; nearest neighbour ${why.nearest.sim.toFixed(2)} in ${why.nearest.path} #${why.nearest.chunk}`;
}

/** One row of the review. */
export interface IOutlierRow {
	/** Point index. */
	index: number;
	objectId: string;
	path: string;
	chunk: number;
	density: number;
	why: string;
	/** This chunk was marked reviewed as an outlier. */
	reviewed: boolean;
}

/**
 * The reviewed cache's entry for a connection's outliers (apart from its reviewed documents).
 *
 * @param connectionKey - The connection.
 * @returns The scope.
 */
export function outliersScope(connectionKey: string): string {
	return `${connectionKey}\u0000outliers`;
}

/**
 * An outlier's id in that entry: its chunk.
 *
 * @param row - The outlier (its document and chunk).
 * @returns The id.
 */
export function outlierKey(row: Pick<IOutlierRow, 'objectId' | 'chunk'>): string {
	return `${row.objectId}\u0000${row.chunk}`;
}

/**
 * The review's rows at a percentile.
 *
 * @param sample - The `sample` answer.
 * @param pct - The percentile.
 * @param removed - objectIds removed since the sample was drawn.
 * @param reviewed - The connection's reviewed outliers (outlierKey ids under outliersScope).
 * @returns The rows, sparsest first.
 */
export function outlierRows(sample: ISampleResult, pct: number, removed: readonly string[] = [], reviewed: ReadonlySet<string> = new Set()): IOutlierRow[] {
	const picked = outliersAt(sample, pct, removed);
	if (picked.length === 0) return [];
	const median = medianOf(sample.density);
	const docOf = (i: number) => sample.docs[sample.points.doc[i] as number];
	return picked.map((index) => {
		const doc = docOf(index);
		const start = sample.knn.offsets_row[index] ?? 0;
		const end = sample.knn.offsets_row[index + 1] ?? start;
		let nearest: IOutlierWhy['nearest'] = null;
		let best = start;
		for (let e = start + 1; e < end; e += 1) if ((sample.knn.sims[e] as number) > (sample.knn.sims[best] as number)) best = e;
		if (end > start) {
			const j = sample.knn.cols[best] as number;
			nearest = { sim: sample.knn.sims[best] as number, path: docOf(j)?.path ?? '?', chunk: sample.points.chunk[j] as number };
		}
		const density = sample.density[index] ?? 0;
		const objectId = doc?.objectId ?? '';
		const chunk = sample.points.chunk[index] as number;
		return { index, objectId, path: doc?.path ?? '?', chunk, density, why: whyText({ density, median, nearest }), reviewed: reviewed.has(outlierKey({ objectId, chunk })) };
	});
}
