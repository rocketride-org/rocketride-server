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
// MAP - LAYOUT QUALITY (kNN overlap; pure, runs in the layout worker and in tests)
// =============================================================================
//
// How much of each point's neighbourhood a 2D layout keeps: for every point,
// the share of its first k graph neighbours (from the node's kNN graph) that are
// also among its k nearest points on the layout, averaged over the points.
// 1 means the layout keeps every neighbourhood, 0 that it keeps none.
//
// The map uses it to decide whether a refined layout is worth showing: the
// neighbour-graph layout replaces PCA only when its overlap is at least PCA's.
// Ties in layout distance go to the lower point index, exactly as the fixture
// generator (tests/fixtures/gen_sample.ts) computes it, so the numbers agree.
//
// Cost: one pass over every pair (n² distance evaluations, a bounded insertion
// per row); about 40 ms for 1,000 points and 0.25 s for 5,000 in Node.
// =============================================================================

/** The kNN graph in Qdrant's offsets layout (the slice of IKnnBlock this needs). */
export interface IKnnRows {
	/** Row i's neighbours are cols[offsets_row[i] .. offsets_row[i + 1]), nearest first. */
	offsets_row: ArrayLike<number>;
	cols: ArrayLike<number>;
}

/**
 * kNN overlap of a layout with a kNN graph.
 *
 * @param positions - Layout coordinates, `dimensions` floats per point (only the first two are measured).
 * @param knn - The graph.
 * @param k - Neighbours compared per point (the graph row is cut to its first k).
 * @param dimensions - Stride of `positions` (2 or 3).
 * @param hidden - Optional mask: a non-zero entry leaves that point out of every row and every neighbourhood.
 * @returns The overlap, 0 to 1 (0 when no point has a visible graph neighbour).
 */
export function knnOverlap(positions: ArrayLike<number>, knn: IKnnRows, k = 15, dimensions: 2 | 3 = 2, hidden?: ArrayLike<number> | null): number {
	const n = Math.max(0, knn.offsets_row.length - 1);
	if (positions.length < n * dimensions) {
		throw new RangeError(`knnOverlap: ${positions.length} coordinates for ${n} points of ${dimensions} dimensions`);
	}
	const kk = Math.max(1, Math.floor(k));
	const isHidden = (i: number): boolean => hidden != null && (hidden[i] as number) !== 0;
	// Bounded, sorted (distance, index) lists reused for every row.
	const bestD = new Float64Array(kk);
	const bestJ = new Int32Array(kk);
	let total = 0;
	let counted = 0;
	for (let i = 0; i < n; i += 1) {
		if (isHidden(i)) continue;
		// The row's first k visible graph neighbours.
		const graph: number[] = [];
		const start = knn.offsets_row[i] as number;
		const end = knn.offsets_row[i + 1] as number;
		for (let e = start; e < end && graph.length < kk; e += 1) {
			const j = knn.cols[e] as number;
			if (j !== i && j >= 0 && j < n && !isHidden(j)) graph.push(j);
		}
		if (graph.length === 0) continue;
		// The k nearest visible points on the layout (ties: lower index first).
		const xi = positions[i * dimensions] as number;
		const yi = positions[i * dimensions + 1] as number;
		let size = 0;
		for (let j = 0; j < n; j += 1) {
			if (j === i || isHidden(j)) continue;
			const dx = (positions[j * dimensions] as number) - xi;
			const dy = (positions[j * dimensions + 1] as number) - yi;
			const d = dx * dx + dy * dy;
			// j rises, so an equal distance never displaces an earlier (lower) index.
			if (size === kk && d >= (bestD[kk - 1] as number)) continue;
			let at = size < kk ? size : kk - 1;
			while (at > 0 && (bestD[at - 1] as number) > d) {
				bestD[at] = bestD[at - 1] as number;
				bestJ[at] = bestJ[at - 1] as number;
				at -= 1;
			}
			bestD[at] = d;
			bestJ[at] = j;
			if (size < kk) size += 1;
		}
		let hits = 0;
		for (const j of graph) {
			for (let t = 0; t < size; t += 1) {
				if (bestJ[t] === j) {
					hits += 1;
					break;
				}
			}
		}
		total += hits / graph.length;
		counted += 1;
	}
	return counted === 0 ? 0 : total / counted;
}
