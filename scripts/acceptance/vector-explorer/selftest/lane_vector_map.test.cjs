// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Self-test for browser/lane_vector_map.cjs (the map lane, gate G4), without
 * a browser or an engine: the lane's own computations (keyboard sectors, the
 * layout decision, the planted corpus facts) and its verdicts on both stand-in
 * pages, where every step must FAIL.
 * Run: node --test scripts/acceptance/vector-explorer/selftest/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runWithStandIn } = require('./stand_in.cjs');
const lane = require('../browser/lane_vector_map.cjs');

// G4's map steps, each of which the lane must run (the frame-time gate is lane_vector_perf.cjs).
const G4 = [
	/detailed/i,
	/light/i,
	/hover/i,
	/12 nearest/i,
	/lasso/i,
	/star and rays/i,
	/table/i,
	/chunk path/i,
	/duplicates/i,
	/outliers/i,
	/keyboard/i,
	/t-SNE/i,
	/Cancel/,
	/kNN overlap/i,
	/Qdrant/,
	/privacy/i,
];

const runs = {};
const standIn = (variant) =>
	(runs[variant] ||= runWithStandIn('lane_vector_map.cjs', ['qdrant'], 'lane_vector_map.json', variant));

for (const variant of ['empty', 'visible']) {
	test(`lane_vector_map: every G4 step runs and fails on the ${variant} stand-in page`, () => {
		const { data, stdout } = standIn(variant);
		for (const name of G4)
			assert.ok(
				data.some((r) => name.test(r.name)),
				`no step for ${name}:\n${stdout}`
			);
		const passed = data.filter((r) => r.status === 'PASS');
		assert.deepStrictEqual(passed, [], `steps passed without observing anything: ${JSON.stringify(passed)}`);
	});
}

test('lane_vector_map: exits non-zero when a step failed', () => {
	assert.notStrictEqual(standIn('empty').status, 0);
});

// Six points around the origin (world coordinates; y up).
const xs = [0, 2, 1, 5, -3, 0.5];
const ys = [0, 0.5, 3, -1, 0, -4];

test('sectorTarget: the nearest point inside the 90° sector of the arrow', () => {
	assert.strictEqual(lane.sectorTarget(xs, ys, 0, 'right'), 1); // (2, .5) beats (5, -1)
	assert.strictEqual(lane.sectorTarget(xs, ys, 0, 'left'), 4);
	assert.strictEqual(lane.sectorTarget(xs, ys, 0, 'up'), 2); // world y up is screen up
	assert.strictEqual(lane.sectorTarget(xs, ys, 0, 'down'), 5);
	// (1, 3) from (2, .5): dx -1, dy 2.5: in the up sector, not the left one.
	assert.strictEqual(lane.sectorTarget(xs, ys, 1, 'left'), 0);
	assert.strictEqual(lane.sectorTarget(xs, ys, 3, 'right'), null);
});

test("layoutVerdict: the refined layout stays only when its overlap is at least PCA's", () => {
	assert.strictEqual(
		lane.layoutVerdict({ pca: 0.31, refined: 0.45, shown: 'neighbour-graph', notBetter: false }),
		true
	);
	assert.strictEqual(
		lane.layoutVerdict({ pca: 0.45, refined: 0.45, shown: 'neighbour-graph', notBetter: false }),
		true
	);
	assert.strictEqual(lane.layoutVerdict({ pca: 0.45, refined: 0.31, shown: 'pca', notBetter: true }), true);
	assert.match(lane.layoutVerdict({ pca: 0.45, refined: 0.31, shown: 'neighbour-graph', notBetter: false }), /kept/);
	assert.match(lane.layoutVerdict({ pca: 0.31, refined: 0.45, shown: 'pca', notBetter: true }), /dropped/);
	assert.match(lane.layoutVerdict({ pca: 0.45, refined: 0.31, shown: 'pca', notBetter: false }), /did not say/);
	assert.match(lane.layoutVerdict({ pca: null, refined: 0.31, shown: 'pca', notBetter: true }), /overlap/);
});

test(
	'legendVerdict: Qdrant names its own graph; every other store names the store node, ' +
		'and no store claims a graph it did not compute',
	() => {
		const native = 'Map legend · neighbour graph computed by Qdrant · 2D distance is approximate';
		const node = 'Map legend · neighbour graph computed by the store node · 2D distance is approximate';
		assert.strictEqual(lane.legendVerdict({ fixtureKey: 'qdrant', knnSource: 'native', text: native }), true);
		assert.match(lane.legendVerdict({ fixtureKey: 'qdrant', knnSource: 'node', text: node }), /not Qdrant's own/);
		assert.match(
			lane.legendVerdict({ fixtureKey: 'qdrant', knnSource: 'native', text: node }),
			/does not say "neighbour graph computed by Qdrant"/
		);
		for (const fixtureKey of ['postgres', 'rocketride_vector', 'chroma']) {
			assert.strictEqual(lane.legendVerdict({ fixtureKey, knnSource: 'node', text: node }), true, fixtureKey);
			assert.match(
				lane.legendVerdict({ fixtureKey, knnSource: 'node', text: 'Map legend · 2D distance is approximate' }),
				/store node/,
				fixtureKey
			);
		}
		assert.match(
			lane.legendVerdict({
				fixtureKey: 'chroma',
				knnSource: 'node',
				text: `${node} · neighbour graph computed by Chroma`,
			}),
			/claims/
		);
		assert.strictEqual(
			lane.legendVerdict({
				fixtureKey: 'chroma',
				knnSource: 'native',
				text: 'neighbour graph computed by Chroma',
			}),
			true
		);
		assert.match(lane.legendVerdict({ fixtureKey: 'chroma', knnSource: undefined, text: node }), /knn_source/);
	}
);

const SAMPLE = {
	n: 5,
	docs: [
		{ i: 0, objectId: 'o-a', path: 'C:/demo/handbooks/falcon_handbook.md' },
		{ i: 1, objectId: 'o-b', path: 'C:/demo/handbooks/falcon_handbook_rev2.md' },
		{ i: 2, objectId: 'o-c', path: 'C:/demo/scans/ocr_scan_0417.txt' },
	],
	points: { doc: [0, 1, 2, 2, 0], chunk: [0, 0, 1, 0, 3], x: [], y: [] },
	duplicates: [{ a: 0, b: 1, sim: 0.993 }],
	outliers: [2, 3],
};

test('the sample helpers read documents and keys the way the app does', () => {
	assert.strictEqual(lane.pathOf(SAMPLE, 3), 'C:/demo/scans/ocr_scan_0417.txt');
	assert.deepStrictEqual(lane.keyOf(SAMPLE, 4), ['o-a', 3]);
	assert.deepStrictEqual(lane.pointsOf(SAMPLE, 'scans/ocr_scan_0417.txt'), [2, 3]);
	assert.strictEqual(lane.pathOf(SAMPLE, 9), null);
});

test('missingPairs: each planted near-duplicate pair must be on one row', () => {
	const planted = [
		['handbooks/falcon_handbook.md', 'handbooks/falcon_handbook_rev2.md'],
		['field/kestrel_field_guide.md', 'archive/kestrel_field_guide_copy.md'],
	];
	const rows = [
		'C:/demo/handbooks/falcon_handbook.md #0 ↔ C:/demo/handbooks/falcon_handbook_rev2.md #0 · similarity 0.9930',
	];
	assert.deepStrictEqual(lane.missingPairs(rows, planted), [planted[1]]);
	// 'falcon_handbook.md' must not match inside 'falcon_handbook_rev2.md' alone.
	assert.deepStrictEqual(
		lane.missingPairs(['C:/demo/handbooks/falcon_handbook_rev2.md #1 ↔ C:/demo/x.md #0'], [planted[0]]),
		[planted[0]]
	);
});
