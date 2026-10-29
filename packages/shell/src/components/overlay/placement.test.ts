// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp, computePosition, parsePlacement } from './placement';

const viewport = { width: 1000, height: 800 };
const menu = { width: 200, height: 150 };

test('parsePlacement splits side and alignment, defaulting to center', () => {
	assert.deepEqual(parsePlacement('bottom-start'), { side: 'bottom', align: 'start' });
	assert.deepEqual(parsePlacement('top'), { side: 'top', align: 'center' });
});

test('clamp keeps the start edge when the range is inverted', () => {
	assert.equal(clamp(5, 10, 20), 10);
	assert.equal(clamp(25, 10, 20), 20);
	assert.equal(clamp(15, 10, 20), 15);
	assert.equal(clamp(50, 10, 0), 10);
});

test('bottom-start sits under the anchor, left edges aligned, offset applied', () => {
	const anchor = { top: 100, left: 300, width: 120, height: 30 };
	const result = computePosition(anchor, menu, viewport, { placement: 'bottom-start', offset: 4 });
	assert.deepEqual(result, { side: 'bottom', top: 134, left: 300 });
});

test('bottom-end aligns right edges', () => {
	const anchor = { top: 100, left: 300, width: 120, height: 30 };
	const result = computePosition(anchor, menu, viewport, { placement: 'bottom-end' });
	assert.equal(result.left, 300 + 120 - 200);
});

test('flips to the top when there is no room below', () => {
	const anchor = { top: 700, left: 300, width: 120, height: 30 };
	const result = computePosition(anchor, menu, viewport, { placement: 'bottom-start', offset: 4 });
	assert.equal(result.side, 'top');
	assert.equal(result.top, 700 - 150 - 4);
});

test('keeps the requested side when neither fits but it has more room', () => {
	const tall = { width: 200, height: 700 };
	const anchor = { top: 60, left: 300, width: 120, height: 30 };
	const result = computePosition(anchor, tall, viewport, { placement: 'bottom-start' });
	assert.equal(result.side, 'bottom');
});

test('flips when neither fits and the other side has more room', () => {
	const tall = { width: 200, height: 700 };
	const anchor = { top: 600, left: 300, width: 120, height: 30 };
	const result = computePosition(anchor, tall, viewport, { placement: 'bottom-start', padding: 8 });
	assert.equal(result.side, 'top');
	// Clamped so the box still starts inside the viewport.
	assert.ok(result.top >= 8);
});

test('shifts along the cross axis to stay inside the right edge', () => {
	const anchor = { top: 100, left: 900, width: 80, height: 30 };
	const result = computePosition(anchor, menu, viewport, { placement: 'bottom-start', padding: 8 });
	assert.equal(result.left, 1000 - 200 - 8);
});

test('top-center tooltips center over the anchor', () => {
	const tip = { width: 100, height: 24 };
	const anchor = { top: 200, left: 400, width: 40, height: 40 };
	const result = computePosition(anchor, tip, viewport, { placement: 'top', offset: 6 });
	assert.deepEqual(result, { side: 'top', top: 200 - 24 - 6, left: 400 + 20 - 50 });
});

test('right placement flips to the left near the right edge', () => {
	const anchor = { top: 100, left: 880, width: 100, height: 30 };
	const result = computePosition(anchor, menu, viewport, { placement: 'right-start', offset: 4 });
	assert.equal(result.side, 'left');
	assert.equal(result.left, 880 - 200 - 4);
});
