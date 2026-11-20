// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP INTERACTION: pointer gestures, wheel zoom, keys, layout tweening, frame stats
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLICK_SLOP_PX, createFrameStats, createGesture, easeInOut, keyAction, tweenPositions, wheelZoomFactor } from '../src/map/interaction';

test('a press that barely moves is a click; one that moves further pans by the pointer movement', () => {
	const g = createGesture();
	g.down(100, 100, false);
	assert.deepEqual(g.move(101, 101), []);
	assert.deepEqual(g.up(101, 101), [{ type: 'click', x: 101, y: 101 }]);
	g.down(100, 100, false);
	const moved = g.move(100 + CLICK_SLOP_PX + 2, 100);
	assert.deepEqual(moved, [{ type: 'pan', dx: CLICK_SLOP_PX + 2, dy: 0 }]);
	assert.deepEqual(g.move(120, 110), [{ type: 'pan', dx: 120 - (100 + CLICK_SLOP_PX + 2), dy: 10 }]);
	assert.deepEqual(g.up(120, 110), [{ type: 'pan-end' }]);
	assert.deepEqual(g.move(130, 130), [], 'no button down, nothing happens');
});

test('in lasso mode the press draws a path and the release closes it', () => {
	const g = createGesture();
	g.down(0, 0, true);
	g.move(10, 0);
	g.move(10, 10);
	const done = g.up(0, 10);
	assert.equal(done.length, 1);
	const last = done[0] as { type: string; path: number[] };
	assert.equal(last.type, 'lasso');
	assert.deepEqual(last.path, [0, 0, 10, 0, 10, 10, 0, 10]);
	assert.deepEqual(g.path(), [], 'the path is cleared after release');
	g.down(5, 5, true);
	assert.deepEqual(g.up(5, 5), [{ type: 'click', x: 5, y: 5 }], 'a lasso click with no drag is still a click');
	g.down(5, 5, true);
	g.move(40, 40);
	g.cancel();
	assert.deepEqual(g.path(), []);
});

test('the wheel zooms in on scroll up, out on scroll down, scaled for line and page modes', () => {
	assert.ok(wheelZoomFactor(-100, 0) > 1);
	assert.ok(wheelZoomFactor(100, 0) < 1);
	assert.ok(Math.abs(wheelZoomFactor(100, 0) * wheelZoomFactor(-100, 0) - 1) < 1e-12);
	assert.ok(wheelZoomFactor(3, 1) < wheelZoomFactor(3, 0), 'lines move further than pixels');
	assert.ok(wheelZoomFactor(1e6, 0) >= 0.25 && wheelZoomFactor(-1e6, 0) <= 4, 'one event never zooms wildly');
});

test('keys map to map actions; with Ctrl, Cmd or Alt held they are left to the shell', () => {
	const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
	assert.equal(keyAction('ArrowLeft', plain), 'left');
	assert.equal(keyAction('ArrowRight', plain), 'right');
	assert.equal(keyAction('ArrowUp', plain), 'up');
	assert.equal(keyAction('ArrowDown', plain), 'down');
	assert.equal(keyAction('Enter', plain), 'inspect');
	assert.equal(keyAction('Escape', plain), 'clear');
	assert.equal(keyAction('l', plain), 'lasso');
	assert.equal(keyAction('L', { ...plain, shiftKey: true }), 'lasso');
	assert.equal(keyAction('+', plain), 'zoom-in');
	assert.equal(keyAction('=', plain), 'zoom-in');
	assert.equal(keyAction('-', plain), 'zoom-out');
	assert.equal(keyAction('0', plain), 'fit');
	assert.equal(keyAction('x', plain), null);
	assert.equal(keyAction('ArrowLeft', { ...plain, ctrlKey: true }), null);
	assert.equal(keyAction('l', { ...plain, metaKey: true }), null);
	assert.equal(keyAction('Enter', { ...plain, altKey: true }), null);
});

test('layout changes tween from the old positions to the new ones (eased); a mismatch jumps', () => {
	const from = new Float32Array([0, 0, 10, 10]);
	const to = new Float32Array([10, 0, 0, 10]);
	assert.deepEqual(Array.from(tweenPositions(from, to, 0)), [0, 0, 10, 10]);
	assert.deepEqual(Array.from(tweenPositions(from, to, 1)), [10, 0, 0, 10]);
	const mid = tweenPositions(from, to, 0.5);
	assert.deepEqual(Array.from(mid), [5, 0, 5, 10]);
	assert.equal(easeInOut(0), 0);
	assert.equal(easeInOut(1), 1);
	assert.ok(easeInOut(0.25) < 0.25 && easeInOut(0.75) > 0.75);
	assert.deepEqual(Array.from(tweenPositions(new Float32Array(2), to, 0.5)), Array.from(to));
});

test('frame stats keep the last frames and report the 95th percentile', () => {
	const stats = createFrameStats(100);
	assert.equal(stats.p95(), null);
	for (let i = 1; i <= 200; i += 1) stats.record(i);
	assert.equal(stats.count(), 100);
	assert.equal(stats.p95(), 196);
	stats.reset();
	assert.equal(stats.count(), 0);
});
