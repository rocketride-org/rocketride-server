// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP GRAPH: similarity edges over the node's kNN graph (no call)
// =============================================================================
//
// The node ships every sample's kNN graph (`sample.knn`), so the map's edge
// views are computed in the browser: each point's strongest `m` edges, the
// maximum spanning tree (Kruskal over the undirected kNN edges, strongest
// first, ties by the lower endpoints), one point's edges ("Expand selected")
// and a point's tree neighbours for the inspector.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IKnnBlock } from '../src/contract/types';
import { edgeStats, edgesOf, incidentEdges, mergeEdges, spanningTree, topEdges, treeNeighbours } from '../src/map/graph';
import type { IEdgeSet } from '../src/map/graph';
import { loadSample } from './support/map.samples';
import { bestOf } from './support/timing';

/** A kNN block from rows of [neighbour, similarity] pairs (nearest first). */
function knnOf(rows: Array<Array<[number, number]>>): IKnnBlock {
	const offsets = [0];
	const cols: number[] = [];
	const sims: number[] = [];
	for (const row of rows) {
		for (const [j, s] of row) {
			cols.push(j);
			sims.push(s);
		}
		offsets.push(cols.length);
	}
	return { k: Math.max(0, ...rows.map((r) => r.length)), offsets_row: offsets, cols, sims };
}

/** The edges as sorted "a-b" strings. */
const pairs = (edges: IEdgeSet): string[] => Array.from({ length: edges.count }, (_, e) => `${edges.a[e]}-${edges.b[e]}`).sort();

/** Total similarity of an edge set. */
const weight = (edges: IEdgeSet): number => Array.from(edges.sim.subarray(0, edges.count)).reduce((s, v) => s + v, 0);

// A golden graph: 5 points, two triangles' worth of candidate edges.
//   0-1 0.9, 0-2 0.5, 1-2 0.8, 2-3 0.7, 3-4 0.95, 1-3 0.4, 2-4 0.6
const golden = knnOf([
	[[1, 0.9], [2, 0.5]],
	[[0, 0.9], [2, 0.8], [3, 0.4]],
	[[1, 0.8], [3, 0.7], [4, 0.6], [0, 0.5]],
	[[4, 0.95], [2, 0.7], [1, 0.4]],
	[[3, 0.95], [2, 0.6]],
]);

test('the spanning tree of a connected kNN graph has n-1 edges and the maximum total similarity (golden)', () => {
	const tree = spanningTree(golden, 5);
	assert.equal(tree.components, 1);
	assert.equal(tree.edges.count, 4);
	// Kruskal, strongest first: 3-4 0.95, 0-1 0.9, 1-2 0.8, 2-3 0.7 (0-2, 2-4 and 1-3 close cycles).
	assert.deepEqual(pairs(tree.edges), ['0-1', '1-2', '2-3', '3-4']);
	assert.ok(Math.abs(weight(tree.edges) - (0.95 + 0.9 + 0.8 + 0.7)) < 1e-6);
	// Every pair is stored with a < b.
	for (let e = 0; e < tree.edges.count; e += 1) assert.ok((tree.edges.a[e] as number) < (tree.edges.b[e] as number));
});

test('a kNN graph in k pieces gives a spanning forest of n-k edges and reports k components (isolated points count)', () => {
	const knn = knnOf([[[1, 0.9]], [[0, 0.9]], [[3, 0.8]], [[2, 0.8]], []]);
	const tree = spanningTree(knn, 5);
	assert.equal(tree.components, 3);
	assert.equal(tree.edges.count, 2);
	assert.deepEqual(pairs(tree.edges), ['0-1', '2-3']);
});

test('hidden points are left out of the tree and of the neighbour edges', () => {
	const hidden = new Uint8Array([0, 0, 1, 0, 0]);
	const tree = spanningTree(golden, 5, hidden);
	// Without 2: 0-1 and 3-4 join, 1-3 (0.4) links the two pieces.
	assert.deepEqual(pairs(tree.edges), ['0-1', '1-3', '3-4']);
	assert.equal(tree.components, 1, 'components count visible points only');
	const top = topEdges(golden, 5, 3, hidden);
	for (const p of pairs(top)) assert.doesNotMatch(p, /(^|-)2($|-)/);
});

test('ties are broken by the lower endpoints, so the same graph always gives the same tree', () => {
	const ties = knnOf([
		[[1, 0.5], [2, 0.5], [3, 0.5]],
		[[0, 0.5], [2, 0.5], [3, 0.5]],
		[[0, 0.5], [1, 0.5], [3, 0.5]],
		[[0, 0.5], [1, 0.5], [2, 0.5]],
	]);
	const one = pairs(spanningTree(ties, 4).edges);
	assert.deepEqual(one, ['0-1', '0-2', '0-3']);
	assert.deepEqual(pairs(spanningTree(ties, 4).edges), one);
});

test('neighbour edges: each point\'s m strongest, undirected and once each, so never more than m*n', () => {
	const top1 = topEdges(golden, 5, 1);
	// 0->1, 1->0, 2->1, 3->4, 4->3: three distinct pairs.
	assert.deepEqual(pairs(top1), ['0-1', '1-2', '3-4']);
	const sample = loadSample('sample_demo_1000.json');
	for (const m of [3, 5, 10] as const) {
		const edges = topEdges(sample.knn, sample.n, m);
		assert.ok(edges.count <= m * sample.n, `m=${m}: ${edges.count} edges`);
		assert.ok(edges.count >= Math.ceil((m * sample.n) / 2), `m=${m}: at least half of m*n once deduplicated (${edges.count})`);
		const seen = new Set(pairs(edges));
		assert.equal(seen.size, edges.count, 'no pair twice');
	}
	// A row out of order is ranked by similarity, not by position.
	const unordered = knnOf([[[2, 0.1], [1, 0.9]], [[0, 0.9]], [[0, 0.1]]]);
	assert.deepEqual(pairs(topEdges(unordered, 3, 1)), ['0-1', '0-2']);
});

test('the demo sample: the tree spans every point it can, within the Kruskal budget', () => {
	const sample = loadSample('sample_demo_1000.json');
	const { ms: took, out: tree } = bestOf(() => spanningTree(sample.knn, sample.n));
	assert.equal(tree.edges.count, sample.n - tree.components);
	assert.ok(tree.components >= 1);
	// Budget: 20 ms on 30,000 edges in the browser; asserted with 3x slack here.
	assert.ok(took < 60, `spanning tree of ${sample.knn.cols.length} kNN entries took ${took.toFixed(1)} ms`);
	const light = loadSample('sample_light_5000.json');
	const { ms: lightTook, out: lightTree } = bestOf(() => spanningTree(light.knn, light.n));
	assert.equal(lightTree.edges.count, light.n - lightTree.components);
	assert.ok(lightTook < 120, `light tree of ${light.knn.cols.length} kNN entries took ${lightTook.toFixed(1)} ms`);
});

test('edge statistics: count and similarity range, null on no edges', () => {
	const stats = edgeStats(spanningTree(golden, 5).edges);
	assert.deepEqual(stats, { count: 4, min: 0.7, max: 0.95 });
	assert.deepEqual(edgeStats(topEdges(knnOf([[], []]), 2, 3)), { count: 0, min: null, max: null });
});

test('Expand selected: one point\'s kNN edges, merged into the drawn set without duplicates', () => {
	const own = edgesOf(golden, 5, 2);
	assert.deepEqual(pairs(own), ['0-2', '1-2', '2-3', '2-4']);
	const merged = mergeEdges(topEdges(golden, 5, 1), own);
	assert.deepEqual(pairs(merged), ['0-1', '0-2', '1-2', '2-3', '2-4', '3-4']);
	assert.equal(mergeEdges().count, 0);
});

test('tree neighbours of a point, strongest first, and the edges at a point (hover)', () => {
	const tree = spanningTree(golden, 5);
	assert.deepEqual(treeNeighbours(tree.edges, 2).map((t) => t.i), [1, 3]);
	assert.ok(Math.abs((treeNeighbours(tree.edges, 2)[0]?.sim ?? 0) - 0.8) < 1e-6);
	assert.deepEqual(treeNeighbours(tree.edges, 4).map((t) => t.i), [3]);
	assert.deepEqual(incidentEdges(tree.edges, 1).map((e) => `${tree.edges.a[e]}-${tree.edges.b[e]}`), ['0-1', '1-2']);
	assert.deepEqual(incidentEdges(tree.edges, 9), []);
});
