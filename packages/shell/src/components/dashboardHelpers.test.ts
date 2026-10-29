// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Phase 5 pure helpers: chart ticks, scales, paths, label thinning, series
 * folding, number and delta formatting, meter levels and feed time math.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDelta, formatAxisTick, formatCompact, formatDelta, getDeltaTone } from './chart/chartFormat';
import { bandLayout, buildAreaPath, buildBarPath, buildLinePath, foldSeries, getValueExtent, groupedBarLayout, MAX_BAR_THICKNESS, nearestIndex, niceTicks, pickLabelIndexes, pointPositions, scaleLinear, seriesColor } from './chart/chartMath';
import { summarizeTrend } from './chart/Sparkline';
import { getMeterLevel } from './meter/Meter';
import { formatRelativeTime, getDayKey, groupByDay } from './activity-feed/activityTime';

test('niceTicks covers the data on round steps', () => {
	assert.deepEqual(niceTicks(0, 1284), [0, 500, 1000, 1500]);
	assert.deepEqual(niceTicks(0, 10), [0, 2.5, 5, 7.5, 10]);
	assert.deepEqual(niceTicks(-3, 7), [-5, -2.5, 0, 2.5, 5, 7.5]);
	assert.deepEqual(niceTicks(0.1, 0.3), [0.1, 0.15, 0.2, 0.25, 0.3]);
	assert.deepEqual(niceTicks(0, 0), [0, 0.25, 0.5, 0.75, 1], 'empty span still gets an axis');
	assert.deepEqual(niceTicks(42, 42), [0, 20, 40, 60], 'a flat positive series anchors at zero');
});

test('getValueExtent: grouped ignores gaps, stacked sums, includeZero anchors', () => {
	const series = [
		{ id: 'a', label: 'A', values: [3, null, 5] },
		{ id: 'b', label: 'B', values: [1, 2, 4] },
	];
	assert.deepEqual(getValueExtent(series), [1, 5]);
	assert.deepEqual(getValueExtent(series, { includeZero: true }), [0, 5]);
	assert.deepEqual(getValueExtent(series, { stacked: true }), [2, 9]);
	assert.deepEqual(getValueExtent([]), [0, 1]);
});

test('scales and positions', () => {
	const y = scaleLinear([0, 100], [200, 0]);
	assert.equal(y(0), 200);
	assert.equal(y(25), 150);
	assert.deepEqual(pointPositions(3, 0, 100), [0, 50, 100]);
	assert.deepEqual(pointPositions(1, 0, 100), [50]);
	const band = bandLayout(4, 0, 400, 0.5);
	assert.equal(band.step, 100);
	assert.equal(band.bandwidth, 50);
	assert.equal(band.start(1), 125);
	assert.equal(band.center(1), 150);
});

test('grouped bars cap at 24px with a 2px gap, centered in the band', () => {
	const wide = groupedBarLayout(0, 200, 2);
	assert.equal(wide.thickness, MAX_BAR_THICKNESS);
	assert.deepEqual(wide.offsets, [75, 101]);
	const narrow = groupedBarLayout(0, 20, 3);
	assert.equal(narrow.thickness, (20 - 4) / 3);
});

test('paths: gaps break lines, areas close to the baseline, bars round only the data end', () => {
	assert.equal(
		buildLinePath([
			[0, 10],
			[10, 20],
			[20, null],
			[30, 5],
			[40, 6],
		]),
		'M0,10L10,20M30,5L40,6'
	);
	assert.equal(buildLinePath([[0, null]]), '');
	assert.equal(
		buildAreaPath(
			[
				[0, 10],
				[10, 20],
			],
			50
		),
		'M0,50L0,10L10,20L10,50Z'
	);
	assert.equal(
		buildAreaPath(
			[
				[0, 10],
				[10, null],
				[20, 5],
			],
			50
		),
		'',
		'single-point runs have no area'
	);
	const up = buildBarPath(0, 20, 100, 40);
	assert.ok(up.startsWith('M0,100V44Q0,40 4,40H16Q20,40 20,44V100Z'), up);
	const down = buildBarPath(0, 20, 100, 160);
	assert.ok(down.includes('V156Q0,160'), 'negative bars round the lower end');
	assert.equal(buildBarPath(0, 20, 100, 100), '', 'zero-height bar draws nothing');
});

test('x labels thin out and always keep the latest category', () => {
	assert.deepEqual(pickLabelIndexes(5, 500, 50), [0, 1, 2, 3, 4]);
	assert.deepEqual(pickLabelIndexes(30, 300, 60), [5, 11, 17, 23, 29], 'five fit: every sixth, ending on the latest');
	assert.deepEqual(pickLabelIndexes(0, 300, 60), []);
});

test('nearestIndex snaps to the closest category', () => {
	assert.equal(nearestIndex([0, 50, 100], 70), 1);
	assert.equal(nearestIndex([0, 50, 100], 80), 2);
	assert.equal(nearestIndex([], 10), -1);
});

test('foldSeries keeps five slots and sums the rest into Other; colors never cycle', () => {
	const many = Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, label: `S${index}`, values: [index, null] }));
	const folded = foldSeries(many);
	assert.equal(folded.length, 6);
	assert.equal(folded[5].label, 'Other');
	assert.deepEqual(folded[5].values, [5 + 6 + 7, null]);
	assert.equal(foldSeries(many.slice(0, 6)).length, 6, 'six fit without folding');
	assert.equal(seriesColor(0), 'var(--rr-chart-series-1)');
	assert.equal(seriesColor(9), 'var(--rr-chart-series-6)');
});

test('number formatting: grouping below 10K, compact above, compact ticks from 1K', () => {
	assert.equal(formatCompact(1284), '1,284');
	assert.equal(formatCompact(12900), '12.9K');
	assert.equal(formatCompact(4_200_000), '4.2M');
	assert.equal(formatCompact(3.14159), '3.14');
	assert.equal(formatCompact(-12), '−12');
	assert.equal(formatAxisTick(1500), '1.5K');
	assert.equal(formatAxisTick(500), '500');
});

test('deltas: percent change, sign, and tone by whether up is good', () => {
	assert.equal(computeDelta(110, 100), 10);
	assert.equal(computeDelta(90, 0), null);
	assert.equal(formatDelta(12.44), '+12.4%');
	assert.equal(formatDelta(-3.06), '−3.1%');
	assert.equal(formatDelta(0.04), '0%');
	assert.equal(getDeltaTone(5), 'good');
	assert.equal(getDeltaTone(5, false), 'bad', 'latency going up is bad');
	assert.equal(getDeltaTone(-5, false), 'good');
	assert.equal(getDeltaTone(0.01), 'neutral');
});

test('summarizeTrend and meter levels', () => {
	assert.equal(summarizeTrend([1020, 980, 1310, 1284]), '1,020 to 1,284, low 980, high 1,310');
	assert.equal(summarizeTrend([]), 'no data');
	assert.equal(getMeterLevel(50, 100), 'normal');
	assert.equal(getMeterLevel(80, 100), 'warning');
	assert.equal(getMeterLevel(96, 100), 'danger');
	assert.equal(getMeterLevel(5, 0), 'normal');
});

test('activity time: relative times and day groups in local time', () => {
	const now = new Date(2026, 9, 29, 18, 0);
	assert.equal(formatRelativeTime(new Date(2026, 9, 29, 17, 59, 30), now), 'just now');
	assert.equal(formatRelativeTime(new Date(2026, 9, 29, 17, 55), now), '5 minutes ago');
	assert.equal(formatRelativeTime(new Date(2026, 9, 29, 15, 0), now), '3 hours ago');
	assert.equal(formatRelativeTime(new Date(2026, 9, 28, 20, 0), now), 'yesterday');
	assert.equal(formatRelativeTime(new Date(2026, 9, 25, 9, 0), now), '4 days ago');
	assert.equal(formatRelativeTime(new Date(2026, 8, 1, 9, 0), now), 'Sep 1');
	assert.equal(getDayKey(new Date(2026, 0, 5)), '2026-01-05');

	const items = [new Date(2026, 9, 29, 9), new Date(2026, 9, 29, 8), new Date(2026, 9, 28, 23), new Date(2026, 9, 26, 12), new Date(2025, 11, 31, 12)];
	const groups = groupByDay(items, (item) => item, now);
	assert.deepEqual(
		groups.map((group) => [group.label, group.items.length]),
		[
			['Today', 2],
			['Yesterday', 1],
			['Mon, Oct 26', 1],
			['Wed, Dec 31, 2025', 1],
		]
	);
});
