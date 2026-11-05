// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP MODEL: keys, hidden points, PCA positions, neighbours and the sample label
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTransform, chunkPath, ditherRounded, hiddenMask, keyIndex, keyString, neighboursOf, normaliseLayout, pcaPositions, pointKey, visibleCount } from '../src/map/model';
import { LIGHT_POSITIONS, biasedNote, sampleLabel } from '../src/map/wording';
import { loadSample, modelOf } from './support/map.samples';

const demo = loadSample('sample_demo_1000.json');

test('every point has a key (objectId, chunkId), and the key index maps it back', () => {
	const index = keyIndex(demo);
	assert.equal(index.size, demo.n, 'keys are unique within a sample');
	for (const i of [0, 1, 499, 999]) {
		const key = pointKey(demo, i);
		assert.equal(key[0], demo.docs[demo.points.doc[i] as number]?.objectId);
		assert.equal(key[1], demo.points.chunk[i]);
		assert.equal(index.get(keyString(key[0], key[1])), i);
	}
});

test('points of removed documents are hidden; indices stay put', () => {
	assert.equal(hiddenMask(modelOf(demo)), null);
	const gone = demo.docs[0]?.objectId as string;
	const mask = hiddenMask(modelOf(demo, { removed: [gone] })) as Uint8Array;
	let hidden = 0;
	for (let i = 0; i < demo.n; i += 1) {
		assert.equal(mask[i], demo.points.doc[i] === 0 ? 1 : 0);
		hidden += mask[i] as number;
	}
	assert.equal(hidden, demo.docs[0]?.in_sample);
	assert.equal(visibleCount(modelOf(demo, { removed: [gone] })), demo.n - hidden);
	assert.equal(visibleCount(modelOf(demo)), demo.n);
});

test('PCA positions come from the answer\'s x, y (and z) columns', () => {
	const two = pcaPositions(demo, 2);
	const three = pcaPositions(demo, 3);
	assert.equal(two.length, demo.n * 2);
	assert.equal(three.length, demo.n * 3);
	assert.equal(two[2], Math.fround(demo.points.x[1] as number));
	assert.equal(three[5], Math.fround((demo.points.z as number[])[1] as number));
});

test('a document\'s chunk path lists its sampled points in chunk order', () => {
	const objectId = demo.docs[1]?.objectId as string;
	const path = chunkPath(demo, objectId);
	assert.equal(path.length, demo.docs[1]?.in_sample);
	const chunks = path.map((i) => demo.points.chunk[i] as number);
	assert.deepEqual(chunks, [...chunks].sort((a, b) => a - b));
	assert.deepEqual(chunkPath(demo, 'not-there'), []);
});

test('a point\'s neighbours come from the kNN block, nearest first, with their similarities', () => {
	const row = neighboursOf(demo, 5);
	assert.equal(row.length, demo.knn.k);
	assert.equal(row[0]?.i, demo.knn.cols[demo.knn.offsets_row[5] as number]);
	for (let r = 1; r < row.length; r += 1) assert.ok((row[r - 1]?.sim as number) >= (row[r]?.sim as number));
	assert.equal(neighboursOf(demo, 5, 3).length, 3);
});

test('the sample label says how many of how many, and whether the sample is uniform', () => {
	assert.equal(sampleLabel(demo), 'Showing 1,000 of 1,318 chunks (random sample)');
	const biased = loadSample('sample_biased_refilled.json');
	assert.equal(sampleLabel(biased), 'Showing 180 of 180 chunks (not a uniform sample); fewer points than requested: the store returned 180');
	assert.equal(biasedNote(biased), 'Some documents could not be sampled evenly, so the store filled the sample with other chunks.');
	assert.equal(biasedNote(demo), null);
	assert.equal(sampleLabel({ ...demo, strategy_used: 'first', biased: false }), 'Showing 1,000 of 1,318 chunks (not a uniform sample)');
	assert.equal(sampleLabel({ ...demo, of: { chunks: null, documents: null } }), 'Showing 1,000 chunks (random sample; the store did not say how many it holds)');
});

test('every layout is shown in one frame: visible points centred on the origin with an RMS radius of 1', () => {
	const raw = new Float32Array([10, 10, 14, 10, 10, 14, 14, 14, 500, 500]);
	const hidden = new Uint8Array([0, 0, 0, 0, 1]);
	const { positions, transform } = normaliseLayout(raw, 2, hidden);
	let sx = 0;
	let sy = 0;
	let r2 = 0;
	for (let i = 0; i < 4; i += 1) {
		sx += positions[2 * i] as number;
		sy += positions[2 * i + 1] as number;
		r2 += (positions[2 * i] as number) ** 2 + (positions[2 * i + 1] as number) ** 2;
	}
	assert.ok(Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6, 'centred');
	assert.ok(Math.abs(r2 / 4 - 1) < 1e-6, 'RMS radius 1');
	// A place in layout units goes through the same transform (the query star, pinned points).
	const p = applyTransform({ x: 14, y: 14 }, transform);
	assert.ok(Math.abs(p.x - (positions[6] as number)) < 1e-6 && Math.abs(p.y - (positions[7] as number)) < 1e-6);
	// The hidden point is transformed too (indices stay put) but did not set the frame.
	assert.ok(Number.isFinite(positions[8] as number));
	const flat = normaliseLayout(new Float32Array([3, 3, 3, 3]), 2, null);
	assert.deepEqual(Array.from(flat.positions), [0, 0, 0, 0]);
	const three = normaliseLayout(new Float32Array([0, 0, 1, 0, 0, -1]), 3, null);
	assert.equal(three.positions.length, 6);
	assert.ok(applyTransform({ x: 0, y: 0, z: 1 }, three.transform).z !== undefined);
});

test('light samples (2-decimal coordinates) are dithered within their rounding step, the same way every time', () => {
	const light = loadSample('sample_light_5000.json');
	const raw = pcaPositions(light, 2);
	const a = ditherRounded(raw, 0.01, 11);
	const b = ditherRounded(raw, 0.01, 11);
	assert.deepEqual(Array.from(a), Array.from(b), 'deterministic for a seed');
	let moved = 0;
	for (let i = 0; i < raw.length; i += 1) {
		const d = Math.abs((a[i] as number) - (raw[i] as number));
		assert.ok(d <= 0.005 + 1e-6, `coordinate ${i} moved ${d}`);
		if (d > 1e-6) moved += 1;
	}
	assert.ok(moved > raw.length * 0.9, 'nearly every coordinate leaves the lattice');
	assert.notDeepEqual(Array.from(ditherRounded(raw, 0.01, 12)), Array.from(a));
	assert.deepEqual(Array.from(ditherRounded(raw, 0, 11)), Array.from(raw), 'no step, no dither');
});

test('the light-sample note tells the reader how far a drawn point may sit from its place: within one 0.01 step', () => {
	assert.match(LIGHT_POSITIONS, /0\.01/);
	assert.match(LIGHT_POSITIONS, /within/);
	// What the note claims: rounding (up to half a step) plus the spread (up to half a step) is at most one step.
	const truth = new Float32Array([0.123456, -0.987654, 0.5, 0.004999]);
	const rounded = truth.map((v) => Math.round(v * 100) / 100);
	const drawn = ditherRounded(rounded, 0.01, 7);
	truth.forEach((v, i) => assert.ok(Math.abs((drawn[i] as number) - v) <= 0.01 + 1e-6, `${drawn[i]} vs ${v}`));
});
