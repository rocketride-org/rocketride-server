// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Self-test for browser/lane_a11y.cjs's verdicts, without a browser or an engine:
 * the stand-in Playwright (stand_in.cjs) models an empty page, where no text,
 * no relationship stroke, no inspector dialog and no canvas can be measured.
 * Every contrast, stroke and reduced-motion row must then be a FAIL.
 * Run: node --test scripts/acceptance/graph-explorer/selftest/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runWithStandIn } = require('./stand_in.cjs');

let run;
const rows = () => (run ||= runWithStandIn('lane_a11y.cjs', ['chrome'], 'lane_a11y.json')).data.results;
const named = (re) => rows().filter((r) => re.test(r.name));
const passed = (list) => list.filter((r) => r.status === 'PASS').map((r) => `${r.run}: ${r.name}`);

test('lane_a11y: a contrast row with nothing measured fails', () => {
	const contrast = named(/^contrast /);
	assert.strictEqual(contrast.length, 8, `expected 4 contrast rows per run:\n${run.stdout}`);
	assert.deepStrictEqual(passed(contrast), [], 'contrast rows passed with no text element measured');
});

test('lane_a11y: the drawn graph needs relationship strokes', () => {
	const strokes = named(/^relationship strokes .*graph result/);
	assert.strictEqual(strokes.length, 2, `no stroke row for the drawn graph (expected one per run):\n${run.stdout}`);
	assert.deepStrictEqual(passed(strokes), [], 'stroke rows passed with no stroke measured');
});

test('lane_a11y: reduced-motion rows need a sampled viewport and a canvas', () => {
	const motion = named(/^reduced motion/);
	assert.strictEqual(motion.length, 2, `expected two reduced-motion rows:\n${run.stdout}`);
	assert.deepStrictEqual(passed(motion), [], 'reduced-motion rows passed without observing the canvas');
});

test('lane_a11y: exits non-zero when a row failed', () => {
	rows();
	assert.notStrictEqual(run.status, 0, 'lane exited 0 with failed rows');
});
