// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Self-test for browser/lane_vector.cjs (the console lane), without a browser
 * or an engine: its verdicts on the stand-in pages, where every step must
 * FAIL, and the helpers it keeps for its own steps.
 * Run: node --test scripts/acceptance/vector-explorer/selftest/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runWithStandIn } = require('./stand_in.cjs');
const lane = require('../browser/lane_vector.cjs');

const runs = {};
const standIn = (variant) =>
	(runs[variant] ||= runWithStandIn('lane_vector.cjs', ['qdrant'], 'lane_vector.json', variant));

for (const variant of ['empty', 'visible']) {
	test(`lane_vector: every step fails on the ${variant} stand-in page`, () => {
		const { data, stdout } = standIn(variant);
		assert.ok(data.length >= 12, `only ${data.length} steps ran:\n${stdout}`);
		const passed = data.filter((r) => r.status === 'PASS');
		assert.deepStrictEqual(passed, [], `steps passed without observing anything: ${JSON.stringify(passed)}`);
	});
}

test('lane_vector: exits non-zero when a step failed', () => {
	assert.notStrictEqual(standIn('empty').status, 0);
});

test('lane_vector: the map steps live in the map lane', () => {
	const names = standIn('empty').data.map((r) => r.name);
	assert.ok(!names.some((n) => /map/i.test(n)), names.join(' | '));
});

test('a reshuffle is any change of the first row while documents load', () => {
	assert.strictEqual(lane.reshuffled(['a', 'a', 'a']), null);
	assert.match(lane.reshuffled(['a', 'a', 'b']), /a -> b/);
	assert.match(lane.reshuffled(['a', null, 'a']), /a -> null/);
	// Looks before the first row rendered do not count.
	assert.strictEqual(lane.reshuffled([null, 'a', 'a']), null);
	// Fewer than two looks at a row while loading cannot show anything.
	assert.match(lane.reshuffled(['a']), /fewer than 2/);
	assert.match(lane.reshuffled([null, 'a']), /fewer than 2/);
	assert.match(lane.reshuffled([null, null]), /no row/);
});

test('Cancel sent nothing: no write (trash, restore, delete, upsert), no upload in the frames after the click', () => {
	const tool = (t) => ({
		dir: 'sent',
		msg: { type: 'request', seq: 1, command: 'rrext_process', arguments: { subcommand: 'tool', tool: t } },
	});
	const upload = {
		dir: 'sent',
		msg: { type: 'request', seq: 2, command: 'rrext_process', arguments: { subcommand: 'open' } },
	};
	assert.deepStrictEqual(lane.sentWrites([tool('chunks'), tool('stats'), tool('list_documents')]), []);
	assert.deepStrictEqual(lane.sentWrites([tool('chunks'), tool('soft_delete')]), ['soft_delete']);
	assert.deepStrictEqual(lane.sentWrites([tool('restore'), tool('upsert')]), ['restore', 'upsert']);
	assert.deepStrictEqual(lane.sentWrites([tool('delete'), upload]), ['delete', 'upload']);
	// A received frame is not a write the page sent.
	assert.deepStrictEqual(lane.sentWrites([{ ...tool('delete'), dir: 'received' }]), []);
});

test('run directly the lane takes one fixture (default qdrant)', () => {
	const args = lane.laneArgs(['http://127.0.0.1:5590', '/tmp/out', 'chroma'], {});
	assert.deepStrictEqual(args, {
		base: 'http://127.0.0.1:5590',
		out: '/tmp/out',
		browser: null,
		fixtures: ['chroma'],
	});
	assert.deepStrictEqual(lane.laneArgs(['http://h', '/tmp/out'], {}).fixtures, ['qdrant']);
});

test('run by vector-ui:e2e-live (<url> <out-dir> <browser> [backends]) the lane covers each backend', () => {
	const named = lane.laneArgs(['http://h', '/tmp/e2e/chrome', 'chrome', 'qdrant, postgres'], {});
	assert.deepStrictEqual(named, {
		base: 'http://h',
		out: '/tmp/e2e/chrome',
		browser: 'chrome',
		fixtures: ['qdrant', 'postgres'],
	});
	assert.deepStrictEqual(
		lane.laneArgs(['http://h', '/tmp/e', 'chrome'], { VECTOR_UI_E2E_BACKENDS: 'chroma' }).fixtures,
		['chroma']
	);
	assert.deepStrictEqual(lane.laneArgs(['http://h', '/tmp/e', 'firefox'], {}).fixtures, [
		'postgres',
		'rocketride_vector',
		'qdrant',
		'chroma',
	]);
});

test(
	'a watched load passes only with the progress line, no reshuffle while it shows, ' +
		'and every document at the end',
	() => {
		// What the 1,500-document fixture shows (three pages of 500), recorded change by change.
		const seen = [
			{ loading: null, first: null },
			{ loading: 'Loading documents…', first: null },
			{ loading: 'Loading documents… 500 of 1,500', first: 'note-0073.txt' },
			{ loading: 'Loading documents… 1,000 of 1,500', first: 'note-0073.txt' },
			// Re-sorted once, when loading completes (APP_SPEC 3.2): not a reshuffle.
			{ loading: null, first: 'note-0001.txt' },
		];
		assert.strictEqual(lane.loadVerdict(seen, 1500, 1500), true);
		assert.match(lane.loadVerdict(seen, 1000, 1500), /shows 1000 documents/);
		assert.match(lane.loadVerdict([{ loading: null, first: 'note-0001.txt' }], 1500, 1500), /never showed/);
		assert.match(
			lane.loadVerdict(
				seen.filter((r) => !/ of /.test(r.loading || '')),
				1500,
				1500
			),
			/no "N of 1,500"/
		);
		const reshuffle = [
			seen[1],
			seen[2],
			{ loading: 'Loading documents… 1,000 of 1,500', first: 'note-0001.txt' },
			seen[4],
		];
		assert.match(lane.loadVerdict(reshuffle, 1500, 1500), /note-0073\.txt -> note-0001\.txt/);
		assert.match(lane.loadVerdict(seen.slice(0, 4), 1500, 1500), /still loading/);
	}
);

test("the per-backend children of an e2e-live run keep the runner's Node options (e.g. a -r preload)", () => {
	assert.deepStrictEqual(
		lane.childArgv(['-r', '/x/preload.cjs'], '/lane.cjs', ['http://h', '/out/qdrant', 'qdrant']),
		['-r', '/x/preload.cjs', '/lane.cjs', 'http://h', '/out/qdrant', 'qdrant']
	);
	assert.deepStrictEqual(lane.childArgv([], '/lane.cjs', ['a']), ['/lane.cjs', 'a']);
});
