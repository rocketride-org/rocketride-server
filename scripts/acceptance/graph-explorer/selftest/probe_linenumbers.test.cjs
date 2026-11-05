// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Self-test for browser/probe_linenumbers.cjs, without a browser or an engine
 * (stand_in.cjs). Right after the editor opens, its line numbers can be read
 * before Monaco has painted the editor background, which then reads as
 * transparent (rgba(0, 0, 0, 0)). A contrast ratio against that is not a
 * measurement: the probe must wait for the painted background, and fail when
 * it never comes, instead of measuring against "black".
 * Run: node --test scripts/acceptance/graph-explorer/selftest/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runWithStandIn } = require('./stand_in.cjs');

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const numbers = (color) => [
	{ text: '1', color, active: false },
	{ text: '2', color, active: true },
];
// Graph Explorer, light theme, Chrome only: one run of the probe.
const probe = (sequence) =>
	runWithStandIn(
		'probe_linenumbers.cjs',
		['chrome'],
		'probe_linenumbers.json',
		{ visible: true, sequence: { '.line-numbers': sequence } },
		{ THEMES: 'light', APPS: 'graph' }
	);

test('probe_linenumbers: never measures against a background that is still transparent', () => {
	// Light grey would read 12:1 against "black", the transparent background taken as rgb(0, 0, 0).
	const run = probe([{ bg: TRANSPARENT, numbers: numbers('rgb(200, 200, 200)') }]);
	const passed = run.data.filter((r) => r.status === 'PASS').map((r) => r.name);
	assert.deepStrictEqual(passed, [], `rows passed against a transparent background:\n${run.stdout}`);
	assert.ok(
		run.data.some((r) => /background/.test(r.name)),
		`no row says the background never painted:\n${run.stdout}`
	);
	assert.notStrictEqual(run.status, 0, 'probe exited 0');
});

test('probe_linenumbers: waits for the painted background and measures against it', () => {
	// The first read is before the paint (mid grey against "black" is 4.1:1, a false FAIL);
	// the second is painted white (5.3:1).
	const painted = { bg: 'rgb(255, 255, 255)', numbers: numbers('rgb(110, 110, 110)') };
	const run = probe([{ bg: TRANSPARENT, numbers: numbers('rgb(110, 110, 110)') }, painted]);
	const rows = run.data.filter((r) => r.name.includes('line '));
	assert.strictEqual(rows.length, 2, `expected one row per line number:\n${run.stdout}`);
	for (const r of rows) {
		assert.strictEqual(r.status, 'PASS', `measured before the background painted: ${JSON.stringify(r)}`);
		assert.strictEqual(r.detail.bg, 'rgb(255, 255, 255)', JSON.stringify(r));
	}
	assert.strictEqual(run.status, 0, run.stdout);
});
