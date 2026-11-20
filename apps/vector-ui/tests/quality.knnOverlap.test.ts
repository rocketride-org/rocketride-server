// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// QUALITY: kNN overlap, the measure a layout must beat PCA on
// =============================================================================
//
// overlap = mean over points of |graph neighbours ∩ layout neighbours| / |graph
// neighbours|, using the first k graph neighbours and the k nearest points of
// the layout (ties by index, as tests/fixtures/gen_sample.ts computes it).
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createForceJob, runJob } from '../src/map/layout.core';
import { knnOverlap } from '../src/map/quality';
import { knnFromRows, loadSample, pcaXY } from './support/map.samples';

/** Points on a line at x = 0, 1, 2, ... (y = 0), interleaved. */
function line(n: number): Float32Array {
	const out = new Float32Array(n * 2);
	for (let i = 0; i < n; i += 1) out[2 * i] = i;
	return out;
}

test('a layout that keeps every graph neighbour nearest scores 1', () => {
	// On a line, the 2 nearest points of i are its two sides (ends: the next two).
	const rows = [[1, 2], [0, 2], [1, 3], [2, 4], [3, 2]];
	assert.equal(knnOverlap(line(5), knnFromRows(rows), 2), 1);
});

test('a layout that puts every graph neighbour farthest scores 0', () => {
	const rows = [[4], [4], [0], [0], [0]];
	assert.equal(knnOverlap(line(5), knnFromRows(rows), 1), 0);
});

test('a partial match scores the mean share per point (hand-computed)', () => {
	// k = 2. Layout neighbours on the line: 0:{1,2} 1:{0,2} 2:{1,3} 3:{2,4} 4:{3,2}.
	// Graph rows share 2, 1, 0, 1, 2 of 2 -> (1 + 0.5 + 0 + 0.5 + 1) / 5 = 0.6.
	const rows = [[1, 2], [0, 4], [0, 4], [2, 0], [3, 2]];
	assert.ok(Math.abs(knnOverlap(line(5), knnFromRows(rows), 2) - 0.6) < 1e-12);
});

test('only the first k graph neighbours count, and a short row is divided by its own length', () => {
	// Row 0 lists 1 (near) then 4 (far): with k = 1 only 1 counts. (Ties go to the lower index: 3's nearest is 2.)
	const rows = [[1, 4], [0], [1], [2], [3]];
	assert.equal(knnOverlap(line(5), knnFromRows(rows), 1), 1);
});

test('equal layout distances are broken by the lower point index (as the fixture generator does)', () => {
	// Point 1 sits between 0 and 2 at equal distance: with k = 1 its layout neighbour is 0.
	const positions = new Float32Array([0, 0, 1, 0, 2, 0]);
	assert.equal(knnOverlap(positions, knnFromRows([[1], [0], [1]]), 1), 1);
	assert.equal(knnOverlap(positions, knnFromRows([[1], [2], [1]]), 1), 2 / 3);
});

test('hidden points are left out of both the graph rows and the layout neighbours', () => {
	// Hide point 1: point 0's graph row [1, 2] counts only 2, and its layout neighbour is 2.
	const rows = [[1, 2], [0, 2], [1, 0], [2, 4], [3, 2]];
	const hidden = new Uint8Array([0, 1, 0, 0, 0]);
	const value = knnOverlap(line(5), knnFromRows(rows), 1, 2, hidden);
	// 0: graph [2] vs layout {2} -> 1; 2: graph [0] vs layout {3} (|2-3| = 1 < |2-0| = 2) -> 0;
	// 3: graph [2] vs layout {2} (tie with 4, lower index) -> 1; 4: graph [3] vs {3} -> 1.
	assert.equal(value, 3 / 4);
});

test('a stride of 3 measures distance over the first two coordinates only', () => {
	const positions = new Float32Array([0, 0, 100, 1, 0, -100, 5, 0, 0]);
	// In 2D, 0's nearest is 1 even though z puts them far apart.
	assert.equal(knnOverlap(positions, knnFromRows([[1], [0], [1]]), 1, 3), 1);
});

test('an empty sample scores 0 and too few coordinates is an error, not a guess', () => {
	assert.equal(knnOverlap(new Float32Array(0), knnFromRows([]), 15), 0);
	assert.throws(() => knnOverlap(new Float32Array(3), knnFromRows([[1], [0]]), 1), RangeError);
});

test('PCA baseline on sample_demo_1000.json is 0.167, the number the fixture generator prints', () => {
	const sample = loadSample('sample_demo_1000.json');
	const value = knnOverlap(pcaXY(sample), sample.knn, 15);
	assert.ok(Math.abs(value - 0.167) < 0.0005, `PCA overlap ${value}`);
});

// -----------------------------------------------------------------------------
// The gate: the neighbour-graph layout must beat PCA by a real margin
// -----------------------------------------------------------------------------

test('GATE on sample_demo_1000.json: overlap(neighbour-graph layout) >= overlap(PCA) + 0.10 and >= 0.35', (t) => {
	const sample = loadSample('sample_demo_1000.json');
	const pca = knnOverlap(pcaXY(sample), sample.knn, 15);
	const run = runJob(createForceJob({ n: sample.n, init: pcaXY(sample), knn: sample.knn, seed: 7 }), 3_600_000);
	const force = knnOverlap(run.positions, sample.knn, 15);
	const record = { fixture: 'sample_demo_1000.json', k: 15, pca: Number(pca.toFixed(4)), force: Number(force.toFixed(4)), margin: Number((force - pca).toFixed(4)), ticks: run.ticks, elapsedMs: Math.round(run.elapsedMs) };
	t.diagnostic(`knn-overlap ${JSON.stringify(record)}`);
	console.log(`knn-overlap ${JSON.stringify(record)}`);
	assert.ok(force >= pca + 0.1, `force ${force.toFixed(3)} is not PCA ${pca.toFixed(3)} + 0.10`);
	assert.ok(force >= 0.35, `force ${force.toFixed(3)} < 0.35`);
});

test('light mode (5,000 points, k = 10): the neighbour-graph layout also beats PCA by the same margin', (t) => {
	// Quality only: the run gets no wall-clock budget here (a loaded CI machine must not make it flaky);
	// the elapsed time is reported, and the browser lane measures the real budgeted run.
	const sample = loadSample('sample_light_5000.json');
	const pca = knnOverlap(pcaXY(sample), sample.knn, 10);
	const run = runJob(createForceJob({ n: sample.n, init: pcaXY(sample), knn: sample.knn, seed: 11 }), 3_600_000);
	assert.equal(run.ticks, 300);
	const force = knnOverlap(run.positions, sample.knn, 10);
	t.diagnostic(`light knn-overlap pca=${pca.toFixed(3)} force=${force.toFixed(3)} ticks=${run.ticks} ms=${Math.round(run.elapsedMs)}`);
	assert.ok(force >= pca + 0.1, `force ${force.toFixed(3)} vs PCA ${pca.toFixed(3)}`);
});
