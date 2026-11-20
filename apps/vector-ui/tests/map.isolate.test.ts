// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP ISOLATE: show only a selection or a cluster, grow it by neighbours, show all
// =============================================================================
//
// Isolating hides every other point the way a removed document's points are
// hidden (indices never shift), so the layouts, the keyboard path, picking,
// the lasso and the counts all skip them. "Expand by neighbours" adds one ring
// from the node's kNN graph (no call); a removed document's points stay hidden.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenMask, normaliseLayout, pcaPositions } from '../src/map/model';
import { combineMasks, expandByNeighbours, isolateMask, isolationLine, shownCount } from '../src/map/isolate';
import { lassoSelect } from '../src/map/lasso';
import { buildScreenIndex, nearestInSector, pickNearest } from '../src/map/picking';
import { knnFromRows, loadSample, modelOf } from './support/map.samples';

const demo = loadSample('sample_demo_1000.json');

test('isolating 40 points hides the other 960; Show all (no isolation) restores every point', () => {
	const keep = Array.from({ length: 40 }, (_, i) => i * 7);
	const mask = isolateMask(demo.n, keep);
	assert.equal(shownCount(demo.n, mask), 40);
	for (const i of keep) assert.equal(mask[i], 0);
	assert.equal(mask[1], 1);
	assert.equal(isolationLine(40, demo.n), 'Showing 40 of 1,000');
	assert.equal(combineMasks(null, null), null, 'nothing hidden: no mask at all');
	assert.equal(shownCount(demo.n, combineMasks(null, null)), demo.n);
	// Indices out of range are ignored.
	assert.equal(shownCount(5, isolateMask(5, [0, 9, -1])), 1);
});

test('the hidden mask is the union of removed documents and the isolation', () => {
	const doc = demo.points.doc[0] as number;
	const removed = hiddenMask(modelOf(demo, { removed: [demo.docs[doc]!.objectId] }));
	assert.ok(removed);
	const members = Array.from({ length: demo.n }, (_, i) => i).filter((i) => demo.points.doc[i] === doc);
	const keep = [...members.slice(0, 2), 500, 501];
	const mask = combineMasks(removed, isolateMask(demo.n, keep));
	assert.ok(mask);
	assert.equal(shownCount(demo.n, mask), 2, 'only the isolated points of documents still in the store');
	assert.equal(mask[500], 0);
	assert.equal(mask[members[0] as number], 1);
});

test('expand by neighbours adds one ring from the kNN graph, never a removed point, and is stable', () => {
	const knn = knnFromRows([[1, 2], [0, 3], [0], [1, 4], [3], []]);
	assert.deepEqual(expandByNeighbours(knn, 6, [0]), [0, 1, 2]);
	assert.deepEqual(expandByNeighbours(knn, 6, expandByNeighbours(knn, 6, [0])), [0, 1, 2, 3]);
	const removed = new Uint8Array([0, 0, 1, 0, 0, 0]);
	assert.deepEqual(expandByNeighbours(knn, 6, [0], removed), [0, 1]);
	assert.deepEqual(expandByNeighbours(knn, 6, [5]), [5], 'a point without neighbours stays alone');
	// On the demo sample one ring of 40 points adds their neighbours (k = 15).
	const keep = Array.from({ length: 40 }, (_, i) => i * 7);
	const ring = expandByNeighbours(demo.knn, demo.n, keep);
	assert.ok(ring.length > 40 && ring.length <= 40 * 16, `${ring.length}`);
	for (const i of keep) assert.ok(ring.includes(i));
});

test('picking, the keyboard path and the lasso skip the points an isolation hides', () => {
	const xy = new Float32Array([10, 10, 20, 10, 30, 10, 40, 10]);
	const vp = { width: 100, height: 100 };
	const mask = isolateMask(4, [0, 3]);
	// The arrow moves from point 0 to point 3, past the hidden 1 and 2.
	assert.equal(nearestInSector(xy, 0, 'right', vp, mask), 3);
	assert.equal(nearestInSector(xy, 0, 'right', vp, null), 1);
	assert.equal(pickNearest(buildScreenIndex(xy, vp, mask), 20, 10, 6), null);
	assert.equal(pickNearest(buildScreenIndex(xy, vp, null), 20, 10, 6), 1);
	assert.deepEqual(lassoSelect(xy, [0, 0, 50, 0, 50, 20, 0, 20], mask), [0, 3]);
});

test('the layouts frame only the isolated points: normaliseLayout centres and scales the shown ones', () => {
	const keep = Array.from({ length: 50 }, (_, i) => i);
	const mask = isolateMask(demo.n, keep);
	const raw = pcaPositions(demo, 2);
	const all = normaliseLayout(raw, 2, null);
	const isolated = normaliseLayout(raw, 2, mask);
	assert.notDeepEqual(isolated.transform, all.transform);
	let cx = 0;
	let cy = 0;
	for (const i of keep) {
		cx += isolated.positions[2 * i] as number;
		cy += isolated.positions[2 * i + 1] as number;
	}
	assert.ok(Math.abs(cx / keep.length) < 1e-4 && Math.abs(cy / keep.length) < 1e-4, 'the isolated points are centred');
});
