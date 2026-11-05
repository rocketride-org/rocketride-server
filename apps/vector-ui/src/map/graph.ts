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
// MAP - SIMILARITY GRAPH (pure: edges over the node's kNN graph, no call)
// =============================================================================
//
// Every `sample` answer carries the node's kNN graph (`knn`, Qdrant's offsets
// layout: row i's neighbours and their similarities). The map's edge views are
// computed from it in the browser, so switching them never calls the store:
//
//   - Neighbours: each point's `m` strongest edges (3, 5 or 10), undirected and
//     kept once, so a sample of n points draws at most m*n of them;
//   - Tree: the maximum spanning tree (a forest when the graph is in pieces) by
//     Kruskal over the undirected kNN edges, strongest first, ties broken by the
//     lower endpoints so the same sample always gives the same tree;
//   - Expand selected: one point's own kNN edges, merged into what is drawn.
//
// Hidden points (a removed document, or outside an isolated selection) take no
// part: their edges are dropped and the tree spans the visible points only.
// Edges are stored with a < b in typed arrays (a few hundred KB at most).
// =============================================================================

import type { IKnnBlock, ITreeNeighbour } from '../contract/types';

/** Undirected edges between sample points (a < b), with the node's similarity. */
export interface IEdgeSet {
	a: Uint32Array;
	b: Uint32Array;
	sim: Float32Array;
	count: number;
}

/** A spanning forest and how many pieces the visible points form (isolated points count as one each). */
export interface ISpanningTree {
	edges: IEdgeSet;
	components: number;
}

/** Count and similarity range of an edge set (null bounds with no edges). */
export interface IEdgeStats {
	count: number;
	min: number | null;
	max: number | null;
}

/** No edges. */
export const NO_EDGES: IEdgeSet = { a: new Uint32Array(0), b: new Uint32Array(0), sim: new Float32Array(0), count: 0 };

/** Whether point i takes part (in range and not hidden). */
function usable(i: number, n: number, hidden: ArrayLike<number> | null | undefined): boolean {
	return Number.isInteger(i) && i >= 0 && i < n && !(hidden != null && (hidden[i] as number) !== 0);
}

/**
 * Collect undirected edges, each pair once with its largest similarity.
 *
 * @param n - Points.
 * @param visit - Calls `add(i, j, sim)` for every candidate.
 * @returns The edges sorted by (a, b).
 */
function collect(n: number, visit: (add: (i: number, j: number, sim: number) => void) => void): IEdgeSet {
	const best = new Map<number, number>();
	visit((i, j, sim) => {
		if (i === j || !Number.isFinite(sim)) return;
		const a = i < j ? i : j;
		const b = i < j ? j : i;
		const key = a * n + b;
		const seen = best.get(key);
		if (seen === undefined || sim > seen) best.set(key, sim);
	});
	const keys = Array.from(best.keys()).sort((x, y) => x - y);
	const out: IEdgeSet = { a: new Uint32Array(keys.length), b: new Uint32Array(keys.length), sim: new Float32Array(keys.length), count: keys.length };
	keys.forEach((key, e) => {
		out.a[e] = Math.floor(key / n);
		out.b[e] = key % n;
		out.sim[e] = best.get(key) as number;
	});
	return out;
}

/**
 * Row i of the kNN block as [neighbour, similarity], strongest first (ties: lower index).
 *
 * @param knn - The block.
 * @param i - Point.
 * @returns The row.
 */
function rowOf(knn: IKnnBlock, i: number): Array<[number, number]> {
	const start = knn.offsets_row[i] ?? 0;
	const end = knn.offsets_row[i + 1] ?? start;
	const row: Array<[number, number]> = [];
	for (let e = start; e < end; e += 1) row.push([knn.cols[e] as number, knn.sims[e] as number]);
	return row.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
}

/**
 * Each point's `m` strongest kNN edges, undirected and once each (at most m*n).
 *
 * @param knn - The sample's kNN graph.
 * @param n - Points in the sample.
 * @param m - Edges per point.
 * @param hidden - Points left out.
 * @returns The edges.
 */
export function topEdges(knn: IKnnBlock, n: number, m: number, hidden?: ArrayLike<number> | null): IEdgeSet {
	return collect(n, (add) => {
		for (let i = 0; i < n; i += 1) {
			if (!usable(i, n, hidden)) continue;
			let taken = 0;
			for (const [j, sim] of rowOf(knn, i)) {
				if (taken >= m) break;
				if (j === i || !usable(j, n, hidden)) continue;
				add(i, j, sim);
				taken += 1;
			}
		}
	});
}

/**
 * One point's own kNN edges ("Expand selected").
 *
 * @param knn - The sample's kNN graph.
 * @param n - Points in the sample.
 * @param i - The point.
 * @param hidden - Points left out.
 * @returns Its edges.
 */
export function edgesOf(knn: IKnnBlock, n: number, i: number, hidden?: ArrayLike<number> | null): IEdgeSet {
	if (!usable(i, n, hidden)) return NO_EDGES;
	return collect(n, (add) => {
		for (const [j, sim] of rowOf(knn, i)) if (usable(j, n, hidden)) add(i, j, sim);
	});
}

/**
 * The union of edge sets, each pair once (largest similarity).
 *
 * @param sets - Edge sets.
 * @returns The union, sorted by (a, b).
 */
export function mergeEdges(...sets: IEdgeSet[]): IEdgeSet {
	const nonEmpty = sets.filter((s) => s.count > 0);
	if (nonEmpty.length === 0) return NO_EDGES;
	if (nonEmpty.length === 1) return nonEmpty[0] as IEdgeSet;
	let n = 1;
	for (const s of nonEmpty) for (let e = 0; e < s.count; e += 1) n = Math.max(n, (s.b[e] as number) + 1);
	return collect(n, (add) => {
		for (const s of nonEmpty) for (let e = 0; e < s.count; e += 1) add(s.a[e] as number, s.b[e] as number, s.sim[e] as number);
	});
}

/**
 * The maximum spanning tree (forest) of the visible points: Kruskal over the
 * undirected kNN edges, strongest first, ties by the lower endpoints, with a
 * path-halving union-find.
 *
 * @param knn - The sample's kNN graph.
 * @param n - Points in the sample.
 * @param hidden - Points left out.
 * @returns The tree's edges (visible points minus components of them) and the component count.
 */
export function spanningTree(knn: IKnnBlock, n: number, hidden?: ArrayLike<number> | null): ISpanningTree {
	const all = collect(n, (add) => {
		for (let i = 0; i < n; i += 1) {
			if (!usable(i, n, hidden)) continue;
			const start = knn.offsets_row[i] ?? 0;
			const end = knn.offsets_row[i + 1] ?? start;
			for (let e = start; e < end; e += 1) {
				const j = knn.cols[e] as number;
				if (usable(j, n, hidden)) add(i, j, knn.sims[e] as number);
			}
		}
	});
	// `collect` sorted by (a, b); a stable sort by similarity keeps that as the tie-break.
	const order = Array.from({ length: all.count }, (_, e) => e).sort((x, y) => (all.sim[y] as number) - (all.sim[x] as number) || x - y);
	const parent = new Int32Array(n);
	const size = new Int32Array(n).fill(1);
	for (let i = 0; i < n; i += 1) parent[i] = i;
	const find = (x: number): number => {
		let r = x;
		while (parent[r] !== r) {
			parent[r] = parent[parent[r] as number] as number;
			r = parent[r] as number;
		}
		return r;
	};
	let visible = 0;
	for (let i = 0; i < n; i += 1) if (usable(i, n, hidden)) visible += 1;
	const cap = Math.max(0, visible - 1);
	const tree: IEdgeSet = { a: new Uint32Array(cap), b: new Uint32Array(cap), sim: new Float32Array(cap), count: 0 };
	for (const e of order) {
		if (tree.count >= cap) break;
		const ra = find(all.a[e] as number);
		const rb = find(all.b[e] as number);
		if (ra === rb) continue;
		if ((size[ra] as number) < (size[rb] as number)) {
			parent[ra] = rb;
			size[rb] = (size[rb] as number) + (size[ra] as number);
		} else {
			parent[rb] = ra;
			size[ra] = (size[ra] as number) + (size[rb] as number);
		}
		tree.a[tree.count] = all.a[e] as number;
		tree.b[tree.count] = all.b[e] as number;
		tree.sim[tree.count] = all.sim[e] as number;
		tree.count += 1;
	}
	return { edges: tree, components: visible - tree.count };
}

/**
 * Count and similarity range of an edge set.
 *
 * @param edges - The edges.
 * @returns Count, min and max (rounded to 4 decimals; null with none).
 */
export function edgeStats(edges: IEdgeSet): IEdgeStats {
	if (edges.count === 0) return { count: 0, min: null, max: null };
	let min = Infinity;
	let max = -Infinity;
	for (let e = 0; e < edges.count; e += 1) {
		const s = edges.sim[e] as number;
		if (s < min) min = s;
		if (s > max) max = s;
	}
	const round = (v: number): number => Math.round(v * 1e4) / 1e4;
	return { count: edges.count, min: round(min), max: round(max) };
}

/**
 * The edges at a point (hover thickens them).
 *
 * @param edges - The edges drawn.
 * @param i - The point.
 * @returns Edge indices, in edge order.
 */
export function incidentEdges(edges: IEdgeSet, i: number): number[] {
	const out: number[] = [];
	for (let e = 0; e < edges.count; e += 1) if (edges.a[e] === i || edges.b[e] === i) out.push(e);
	return out;
}

/**
 * A point's neighbours in the spanning tree, strongest first (the inspector's "Tree neighbours").
 *
 * @param tree - The tree's edges.
 * @param i - The point.
 * @returns Neighbour indices and the edges' similarities.
 */
export function treeNeighbours(tree: IEdgeSet, i: number): ITreeNeighbour[] {
	return incidentEdges(tree, i)
		.map((e) => ({ i: (tree.a[e] === i ? tree.b[e] : tree.a[e]) as number, sim: tree.sim[e] as number }))
		.sort((x, y) => y.sim - x.sim || x.i - y.i);
}
