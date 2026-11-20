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
// MAP - ISOLATE (pure: show only some points, grow them by neighbours, show all)
// =============================================================================
//
// "Isolate" (Selection and Clusters tabs) shows only the chosen points; it is
// one more hidden mask, the same kind a removed document's points get, so
// indices never shift and everything that already skips hidden points skips
// these too: the layouts, picking, the keyboard path, the lasso, the counts.
// "Expand by neighbours" adds one ring from the node's kNN graph (no call) and
// never brings back a removed document's point. "Show all" drops the isolation.
// =============================================================================

import type { IKnnBlock } from '../contract/types';
import { num } from './wording';

/**
 * The mask that hides every point but `keep`.
 *
 * @param n - Points in the sample.
 * @param keep - Points to show (out-of-range indices are ignored).
 * @returns 1 per hidden point.
 */
export function isolateMask(n: number, keep: Iterable<number>): Uint8Array {
	const mask = new Uint8Array(n).fill(1);
	for (const i of keep) if (Number.isInteger(i) && i >= 0 && i < n) mask[i] = 0;
	return mask;
}

/**
 * The union of hidden masks.
 *
 * @param masks - Masks (null: nothing hidden by it).
 * @returns The union, or null when nothing is hidden.
 */
export function combineMasks(...masks: Array<ArrayLike<number> | null | undefined>): Uint8Array | null {
	const given = masks.filter((m): m is ArrayLike<number> => m != null);
	if (given.length === 0) return null;
	const n = Math.max(...given.map((m) => m.length));
	const out = new Uint8Array(n);
	let any = false;
	for (const m of given) {
		for (let i = 0; i < m.length; i += 1) {
			if ((m[i] as number) !== 0) {
				out[i] = 1;
				any = true;
			}
		}
	}
	return any ? out : null;
}

/**
 * Points shown under a mask.
 *
 * @param n - Points in the sample.
 * @param mask - Hidden mask, or null.
 * @returns The count.
 */
export function shownCount(n: number, mask: ArrayLike<number> | null): number {
	if (mask === null) return n;
	let hidden = 0;
	for (let i = 0; i < n; i += 1) hidden += (mask[i] as number) !== 0 ? 1 : 0;
	return n - hidden;
}

/**
 * Grow a set of points by one ring of kNN neighbours.
 *
 * @param knn - The sample's kNN graph.
 * @param n - Points in the sample.
 * @param keep - The points shown now.
 * @param removed - Points that must stay hidden (removed documents).
 * @returns The grown set, ascending.
 */
export function expandByNeighbours(knn: IKnnBlock, n: number, keep: Iterable<number>, removed?: ArrayLike<number> | null): number[] {
	const allowed = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n && !(removed != null && (removed[i] as number) !== 0);
	const out = new Set<number>();
	for (const i of keep) {
		if (!allowed(i)) continue;
		out.add(i);
		const start = knn.offsets_row[i] ?? 0;
		const end = knn.offsets_row[i + 1] ?? start;
		for (let e = start; e < end; e += 1) {
			const j = knn.cols[e] as number;
			if (allowed(j)) out.add(j);
		}
	}
	return Array.from(out).sort((a, b) => a - b);
}

/**
 * The footer under an isolated map.
 *
 * @param shown - Points shown.
 * @param n - Points in the sample.
 * @returns E.g. "Showing 212 of 1,000".
 */
export function isolationLine(shown: number, n: number): string {
	return `Showing ${num(shown)} of ${num(n)}`;
}
