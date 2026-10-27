// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP PICKING: camera maths, hover/click picking, keyboard sectors, lasso
// =============================================================================
//
// Everything the pointer and the keyboard do on the map is computed on screen
// coordinates obtained through the SAME matrix the WebGL renderer draws with, so
// what is picked is what is drawn.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundsOf, cameraSignature, fitCamera, fitCamera3D, orbitCamera, panBy, projectToScreen, resizeCamera, screenToWorld, viewMatrix, worldToScreen, zoomAt } from '../src/map/camera';
import type { ICamera2D, ICamera3D, IViewport } from '../src/map/camera';
import { lassoSelect, pointInPolygon, simplifyPath } from '../src/map/lasso';
import { buildScreenIndex, nearestInSector, pickNearest } from '../src/map/picking';

const vp: IViewport = { width: 800, height: 600 };
const cam: ICamera2D = { mode: '2d', cx: 10, cy: -5, scale: 4 };

/** Seeded uniform numbers. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// -----------------------------------------------------------------------------
// Camera
// -----------------------------------------------------------------------------

test('world and screen coordinates round-trip; the camera centre is the viewport centre and world y points up', () => {
	assert.deepEqual(worldToScreen(cam, vp, 10, -5), [400, 300]);
	const [sx, sy] = worldToScreen(cam, vp, 12, -4);
	assert.deepEqual([sx, sy], [408, 296]);
	const [wx, wy] = screenToWorld(cam, vp, sx, sy);
	assert.ok(Math.abs(wx - 12) < 1e-9 && Math.abs(wy + 4) < 1e-9);
});

test('fit puts every visible point inside the viewport with the padding, centred', () => {
	const positions = new Float32Array([-10, -10, 30, 10, 0, 0, 1000, 1000]);
	const bounds = boundsOf(positions, 2, new Uint8Array([0, 0, 0, 1]));
	assert.deepEqual(bounds, { minX: -10, maxX: 30, minY: -10, maxY: 10 });
	const fitted = fitCamera(bounds, vp, 20);
	for (const [x, y] of [[-10, -10], [30, 10]] as const) {
		const [sx, sy] = worldToScreen(fitted, vp, x, y);
		assert.ok(sx >= 20 - 1e-9 && sx <= 780 + 1e-9 && sy >= 20 - 1e-9 && sy <= 580 + 1e-9, `${sx},${sy}`);
	}
	assert.deepEqual(worldToScreen(fitted, vp, 10, 0), [400, 300]);
	// A single point (no extent) still gets a finite camera.
	const one = fitCamera({ minX: 3, maxX: 3, minY: 3, maxY: 3 }, vp, 20);
	assert.ok(Number.isFinite(one.scale) && one.scale > 0);
	assert.equal(boundsOf(new Float32Array(0), 2), null);
});

test('a resize keeps the zoom relative to the fit: shrinking and growing back twice returns the scale, and a camera at fit stays at fit', () => {
	// The live map: 1,020 x 477 at 1440, 880 x 477 at 1300 (the side panel keeps its width).
	const wide: IViewport = { width: 1020, height: 477 };
	const narrow: IViewport = { width: 880, height: 477 };
	const bounds = { minX: -6, maxX: 7, minY: -2.5, maxY: 3 };
	const fitted = fitCamera(bounds, wide, 28);
	const zoomed = zoomAt(fitted, wide, 300, 200, 2.5);
	for (const start of [fitted, zoomed]) {
		let c = start;
		const scales = [c.scale];
		for (const next of [[wide, narrow], [narrow, wide], [wide, narrow], [narrow, wide]] as const) {
			c = resizeCamera(c, bounds, next[0], next[1], 28);
			scales.push(c.scale);
		}
		assert.ok(Math.abs(c.scale - start.scale) < 1e-9 * start.scale, `back to ${start.scale}: ${scales.join(' → ')}`);
		assert.ok(Math.abs((scales[1] as number) - (scales[3] as number)) < 1e-9 * start.scale, 'the same scale at the same size, every time');
		assert.ok((scales[1] as number) < start.scale, 'narrower: zoomed out, so what was in view stays in view');
		assert.deepEqual([c.cx, c.cy], [start.cx, start.cy], 'the same centre');
	}
	// At fit it stays at fit, at any size (the whole layout in view, centred).
	for (const size of [narrow, { width: 600, height: 700 }, { width: 1400, height: 300 }]) {
		const resized = resizeCamera(fitted, bounds, wide, size, 28);
		assert.ok(Math.abs(resized.scale - fitCamera(bounds, size, 28).scale) < 1e-9 * resized.scale, `${size.width}x${size.height}`);
	}
	// The old rule (scale by the smaller of the two ratios) ratcheted: 1440 → 1300 → 1440 never came back.
	const ratchet = (c: ICamera2D, a: IViewport, b: IViewport): number => c.scale * Math.min(b.width / a.width, b.height / a.height);
	assert.ok(ratchet({ ...fitted, scale: ratchet(fitted, wide, narrow) }, narrow, wide) < fitted.scale);
	// Nothing visible: the camera is left as it was.
	assert.deepEqual(resizeCamera(zoomed, null, wide, narrow, 28), zoomed);
});

test('zooming keeps the point under the cursor still, and the zoom stays within its range', () => {
	const zoomed = zoomAt(cam, vp, 600, 150, 2.5);
	const before = screenToWorld(cam, vp, 600, 150);
	const after = screenToWorld(zoomed, vp, 600, 150);
	assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9);
	assert.equal(zoomed.scale, 10);
	assert.equal(zoomAt(cam, vp, 0, 0, 1e9, { min: 1, max: 50 }).scale, 50);
	assert.equal(zoomAt(cam, vp, 0, 0, 1e-9, { min: 1, max: 50 }).scale, 1);
});

test('panning moves the scene with the pointer', () => {
	const moved = panBy(cam, 40, -20);
	const [sx, sy] = worldToScreen(moved, vp, 10, -5);
	assert.deepEqual([sx, sy], [440, 280]);
});

test('the 2D view matrix projects exactly where worldToScreen says (renderer and picking agree)', () => {
	const positions = new Float32Array([10, -5, 12, -4, -30, 40, 0, 0]);
	const xy = projectToScreen(positions, 2, viewMatrix(cam, vp), vp);
	for (let i = 0; i < 4; i += 1) {
		const [sx, sy] = worldToScreen(cam, vp, positions[2 * i] as number, positions[2 * i + 1] as number);
		assert.ok(Math.abs((xy[2 * i] as number) - sx) < 1e-3 && Math.abs((xy[2 * i + 1] as number) - sy) < 1e-3, `point ${i}`);
	}
});

test('3D: the orbit target projects to the centre, orbiting moves other points, points behind the eye are not on screen', () => {
	const cam3: ICamera3D = { mode: '3d', target: [0, 0, 0], yaw: 0, pitch: 0, distance: 10, fov: Math.PI / 4 };
	const pts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 20]);
	const a = projectToScreen(pts, 3, viewMatrix(cam3, vp), vp);
	assert.ok(Math.abs((a[0] as number) - 400) < 1e-3 && Math.abs((a[1] as number) - 300) < 1e-3);
	assert.ok((a[2] as number) > 400, 'x to the right');
	assert.ok(Number.isNaN(a[4] as number), 'z = 20 is behind an eye at z = 10');
	const turned = orbitCamera(cam3, Math.PI / 2, 0);
	const b = projectToScreen(pts, 3, viewMatrix(turned, vp), vp);
	assert.ok(Math.abs((b[2] as number) - 400) < 1e-3, 'after a quarter turn the x axis points at the eye');
	assert.ok(Math.abs(orbitCamera(cam3, 0, 10).pitch) < Math.PI / 2, 'pitch is clamped short of the poles');
});

// -----------------------------------------------------------------------------
// Picking
// -----------------------------------------------------------------------------

test('hover picks the nearest point within the radius, skips hidden points, and finds nothing outside the radius', () => {
	const xy = new Float32Array([100, 100, 104, 100, 300, 300, 103, 101]);
	const index = buildScreenIndex(xy, vp, new Uint8Array([0, 0, 0, 1]));
	assert.equal(pickNearest(index, 103.2, 100.9, 8), 1);
	assert.equal(pickNearest(index, 101, 100, 8), 0);
	assert.equal(pickNearest(index, 200, 200, 8), null);
	assert.equal(pickNearest(index, 300, 309, 8), null);
	assert.equal(pickNearest(index, 300, 307, 8), 2);
});

test('equal screen distances go to the nearer depth, then the lower index', () => {
	const xy = new Float32Array([10, 10, 10, 10, 10, 10]);
	assert.equal(pickNearest(buildScreenIndex(xy, vp), 10, 10, 5), 0);
	const depth = new Float32Array([0.9, 0.2, 0.5]);
	assert.equal(pickNearest(buildScreenIndex(xy, vp, null, depth), 10, 10, 5), 1);
});

test('the grid index agrees with brute force on 2,000 random points (off-screen and NaN points ignored)', () => {
	const rand = rng(5);
	const n = 2000;
	const xy = new Float32Array(n * 2);
	for (let i = 0; i < n; i += 1) {
		xy[2 * i] = rand() * 900 - 50;
		xy[2 * i + 1] = i % 97 === 0 ? Number.NaN : rand() * 700 - 50;
	}
	const index = buildScreenIndex(xy, vp);
	for (let q = 0; q < 300; q += 1) {
		const sx = rand() * 800;
		const sy = rand() * 600;
		let best: number | null = null;
		let bestD = 12 * 12;
		for (let i = 0; i < n; i += 1) {
			const dx = (xy[2 * i] as number) - sx;
			const dy = (xy[2 * i + 1] as number) - sy;
			const d = dx * dx + dy * dy;
			if (d <= bestD && (best === null || d < bestD)) {
				best = i;
				bestD = d;
			}
		}
		assert.equal(pickNearest(index, sx, sy, 12), best, `query ${q}`);
	}
});

test('arrow keys move to the nearest point inside the 90° sector of their direction (screen y points down)', () => {
	// A plus around point 0 at (100, 100), plus a far point straight right.
	const xy = new Float32Array([100, 100, 150, 100, 100, 40, 40, 100, 100, 170, 300, 105, 160, 165]);
	assert.equal(nearestInSector(xy, 0, 'right', vp), 1);
	assert.equal(nearestInSector(xy, 0, 'up', vp), 2);
	assert.equal(nearestInSector(xy, 0, 'left', vp), 3);
	assert.equal(nearestInSector(xy, 0, 'down', vp), 4);
	assert.equal(nearestInSector(xy, 1, 'right', vp), 5);
	assert.equal(nearestInSector(xy, 5, 'right', vp), null);
	// Hidden points are skipped.
	assert.equal(nearestInSector(xy, 0, 'right', vp, new Uint8Array([0, 1, 0, 0, 0, 0, 0])), 5);
	// With nothing focused, the first move lands on the point nearest the viewport centre.
	assert.equal(nearestInSector(new Float32Array([0, 0, 390, 310, 700, 500]), null, 'right', vp), 1);
});

// -----------------------------------------------------------------------------
// Lasso
// -----------------------------------------------------------------------------

test('point-in-polygon follows the even-odd rule on a concave outline', () => {
	// An L shape: the notch (15, 15) is outside.
	const l = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
	assert.equal(pointInPolygon(5, 5, l), true);
	assert.equal(pointInPolygon(15, 5, l), true);
	assert.equal(pointInPolygon(5, 15, l), true);
	assert.equal(pointInPolygon(15, 15, l), false);
	assert.equal(pointInPolygon(-1, 5, l), false);
});

test('the lasso selects the visible points inside its outline, in ascending order', () => {
	const xy = new Float32Array([5, 5, 15, 15, 15, 5, 5, 15, 50, 50, 6, 6]);
	const l = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
	assert.deepEqual(lassoSelect(xy, l), [0, 2, 3, 5]);
	assert.deepEqual(lassoSelect(xy, l, new Uint8Array([0, 0, 1, 0, 0, 0])), [0, 3, 5]);
	assert.deepEqual(lassoSelect(xy, [0, 0, 10, 10]), [], 'fewer than three vertices selects nothing');
});

test('the drawn path is thinned to points at least 3 px apart, keeping its ends', () => {
	const path = [0, 0, 1, 0, 2, 0, 3.5, 0, 4, 0, 10, 0];
	assert.deepEqual(simplifyPath(path, 3), [0, 0, 3.5, 0, 10, 0]);
});

test('a lasso over 20,000 points answers well within a frame budget', () => {
	const rand = rng(9);
	const n = 20000;
	const xy = new Float32Array(n * 2);
	for (let i = 0; i < n * 2; i += 1) xy[i] = rand() * 800;
	const ring: number[] = [];
	for (let a = 0; a < 64; a += 1) ring.push(400 + 200 * Math.cos((a / 64) * 2 * Math.PI), 400 + 200 * Math.sin((a / 64) * 2 * Math.PI));
	const t0 = performance.now();
	const inside = lassoSelect(xy, ring);
	const ms = performance.now() - t0;
	assert.ok(inside.length > 0.15 * n && inside.length < 0.25 * n, `${inside.length}`);
	assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
});

test('the camera signature (data-camera) changes with any pan, zoom or orbit and is stable otherwise', () => {
	const cam = { mode: '2d' as const, cx: 0.125, cy: -2, scale: 37.5 };
	assert.equal(cameraSignature(cam), cameraSignature({ ...cam }));
	assert.notEqual(cameraSignature(panBy(cam, 3, 0)), cameraSignature(cam));
	assert.notEqual(cameraSignature(panBy(cam, 0, 1)), cameraSignature(cam));
	assert.notEqual(cameraSignature(zoomAt(cam, { width: 400, height: 300 }, 200, 150, 1.25)), cameraSignature(cam));
	const c3 = fitCamera3D(new Float32Array([0, 0, 0, 1, 1, 1, -1, 2, 0]));
	assert.notEqual(cameraSignature(orbitCamera(c3, 0.1, 0)), cameraSignature(c3));
	assert.equal(cameraSignature(null), '');
	assert.match(cameraSignature(cam), /^2d:/);
});
