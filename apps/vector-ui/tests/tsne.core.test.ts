// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// t-SNE CORE: exact t-SNE from the sparse kNN affinities (at most 1,000 points)
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runJob } from '../src/map/layout.core';
import type { ILayoutClock } from '../src/map/layout.core';
import { knnOverlap } from '../src/map/quality';
import { TSNE_ITERATIONS, TSNE_MAX_POINTS, TsneTooLargeError, conditionalRow, createTsneJob, klDivergence, tsneAffinities, tsnePerplexity } from '../src/map/tsne.core';
import { knnFromRows, loadSample, pcaXY } from './support/map.samples';

const native = loadSample('sample_native_knn.json');
const forever = 3_600_000;

test('each conditional row is calibrated to the target perplexity and sums to 1', () => {
	const distances = [0, 0.1, 0.15, 0.3, 0.32, 0.5, 0.7, 0.71, 0.9, 1.2, 1.3, 1.5];
	for (const perplexity of [2, 3, 5, 8]) {
		const { p } = conditionalRow(distances, perplexity);
		const sum = p.reduce((a, b) => a + b, 0);
		assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
		const entropy = -p.reduce((h, v) => (v > 0 ? h + v * Math.log(v) : h), 0);
		assert.ok(Math.abs(entropy - Math.log(perplexity)) < 1e-4, `perplexity ${perplexity}: entropy ${entropy} vs ${Math.log(perplexity)}`);
		// Nearer neighbours never get less weight.
		for (let i = 1; i < p.length; i += 1) assert.ok((p[i] as number) <= (p[i - 1] as number) + 1e-15);
	}
});

test('the perplexity follows k (k/3, between 2 and 30)', () => {
	assert.equal(tsnePerplexity(15), 5);
	assert.equal(tsnePerplexity(4), 2);
	assert.equal(tsnePerplexity(300), 30);
});

test('the joint affinities are symmetric pairs summing to 1, with hidden points left out', () => {
	const knn = knnFromRows([[1, 2], [0, 2], [1, 3], [2, 0]]);
	const p = tsneAffinities(knn, 4, 2, new Uint8Array([0, 0, 0, 1]));
	let total = 0;
	for (let e = 0; e < p.vals.length; e += 1) {
		assert.ok((p.rows[e] as number) < (p.cols[e] as number), 'each unordered pair once, i < j');
		assert.notEqual(p.rows[e], 3);
		assert.notEqual(p.cols[e], 3);
		assert.ok((p.vals[e] as number) > 0);
		total += 2 * (p.vals[e] as number);
	}
	assert.ok(Math.abs(total - 1) < 1e-12, `P sums to ${total}`);
	assert.equal(p.vals.length, 3);
});

test('more than 1,000 points are refused with a sentence, before any work', () => {
	assert.equal(TSNE_MAX_POINTS, 1000);
	const n = 1001;
	const err = (() => {
		try {
			createTsneJob({ n, init: new Float32Array(n * 2), knn: { offsets_row: new Array(n + 1).fill(0), cols: [], sims: [] }, seed: 1 });
		} catch (e) {
			return e;
		}
		return null;
	})();
	assert.ok(err instanceof TsneTooLargeError);
	assert.equal((err as Error).message, 't-SNE is limited to 1,000 points; this sample has 1,001. Draw a smaller sample or use the neighbour graph layout.');
});

test('same input gives identical positions, every one finite', () => {
	const input = { n: native.n, init: pcaXY(native), knn: native.knn, seed: 31, iterations: 300 };
	const a = runJob(createTsneJob(input), forever);
	const b = runJob(createTsneJob(input), forever);
	assert.deepEqual(Array.from(a.positions), Array.from(b.positions));
	assert.ok(a.positions.every((v) => Number.isFinite(v)));
	assert.equal(a.ticks, 300);
	assert.equal(createTsneJob({ ...input, iterations: undefined }).total, TSNE_ITERATIONS);
});

test('the optimisation lowers the KL divergence between the affinities and the layout', () => {
	const p = tsneAffinities(native.knn, native.n, tsnePerplexity(native.knn.k));
	const job = createTsneJob({ n: native.n, init: pcaXY(native), knn: native.knn, seed: 31 });
	const before = klDivergence(p, job.positions(), native.n);
	job.step(TSNE_ITERATIONS);
	const after = klDivergence(p, job.positions(), native.n);
	assert.ok(after < before * 0.5, `KL ${before.toFixed(3)} -> ${after.toFixed(3)}`);
});

test('t-SNE keeps neighbourhoods far better than PCA on the seeded samples (k = 15)', (t) => {
	for (const name of ['sample_native_knn.json', 'sample_demo_1000.json'] as const) {
		const sample = loadSample(name);
		const pca = knnOverlap(pcaXY(sample), sample.knn, 15);
		const run = runJob(createTsneJob({ n: sample.n, init: pcaXY(sample), knn: sample.knn, seed: 7 }), forever);
		const tsne = knnOverlap(run.positions, sample.knn, 15);
		t.diagnostic(`${name}: pca=${pca.toFixed(3)} tsne=${tsne.toFixed(3)} ms=${Math.round(run.elapsedMs)}`);
		assert.ok(tsne >= pca + 0.1, `${name}: t-SNE ${tsne.toFixed(3)} vs PCA ${pca.toFixed(3)}`);
	}
});

test('the budget and Cancel stop it between iterations with usable positions', () => {
	let t = 0;
	const clock: ILayoutClock = { now: () => (t += 1_000) };
	const timed = runJob(createTsneJob({ n: native.n, init: pcaXY(native), knn: native.knn, seed: 1 }), 2_500, clock, 10);
	assert.equal(timed.timedOut, true);
	assert.equal(timed.ticks, 20);
	assert.ok(timed.positions.every((v) => Number.isFinite(v)));
	let asked = 0;
	const cancelled = runJob(createTsneJob({ n: native.n, init: pcaXY(native), knn: native.knn, seed: 1 }), forever, undefined, 5, () => (asked += 1) > 1);
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.ticks, 5);
});

test('a degenerate start (all points equal) is spread by the seed, and tiny samples work', () => {
	const flat = createTsneJob({ n: 4, init: new Float32Array(8), knn: knnFromRows([[1], [0], [3], [2]]), seed: 5 });
	assert.ok(new Set(Array.from(flat.positions()).map((v) => v.toExponential(6))).size > 1);
	for (const n of [0, 1, 2]) {
		const rows = n === 2 ? [[1], [0]] : Array.from({ length: n }, () => [] as number[]);
		const run = runJob(createTsneJob({ n, init: new Float32Array(n * 2).fill(0.5), knn: knnFromRows(rows), seed: 1 }), forever);
		assert.equal(run.positions.length, n * 2);
		assert.ok(run.positions.every((v) => Number.isFinite(v)));
	}
});
