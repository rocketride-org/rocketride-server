// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP RENDERERS: WebGL1 points, the Canvas2D fallback, and the overlay
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectToScreen, viewMatrix } from '../src/map/camera';
import { NO_EDGES, edgeStats, spanningTree, topEdges } from '../src/map/graph';
import { EDGE_BUCKETS, buildEdgePaths, drawExtras, drawOverlay, edgeAlpha, edgeBuckets, edgeTransform2d, extrasDataset, overlayDataset, strokeEdgePaths } from '../src/map/overlay';
import type { IOverlayExtras, IOverlayModel } from '../src/map/overlay';
import { createCanvas2dRenderer } from '../src/map/renderer.canvas2d';
import { FLAG, FRAGMENT_SHADER, VERTEX_SHADER, createWebglRenderer, packPoints, sizeCanvas } from '../src/map/renderer.webgl';
import { FakeCanvas, fake2d, fakeGl } from './support/map.fakes';
import { loadSample } from './support/map.samples';

const vp = { width: 400, height: 300 };
const matrix = viewMatrix({ mode: '2d', cx: 0, cy: 0, scale: 10 }, vp);

/** Three points: one plain, one outlined, one hidden. */
function three() {
	return packPoints({
		positions: new Float32Array([0, 0, 1, 1, -2, 3]),
		dims: 2,
		rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
		outlined: new Uint8Array([0, 1, 0]),
		hidden: new Uint8Array([0, 0, 1]),
		emphasised: null,
		hollow: null,
	});
}

test('points are packed as x,y,z per point with flag bits for outline, hidden, hollow and emphasis', () => {
	const data = three();
	assert.equal(data.count, 3);
	assert.deepEqual(Array.from(data.positions), [0, 0, 0, 1, 1, 0, -2, 3, 0]);
	assert.deepEqual(Array.from(data.flags), [0, FLAG.outlined, FLAG.hidden]);
	const more = packPoints({ positions: new Float32Array([0, 0, 1]), dims: 3, rgba: new Uint8Array(4), outlined: null, hidden: null, emphasised: new Uint8Array([1]), hollow: new Uint8Array([1]) });
	assert.equal(more.flags[0], FLAG.emphasised | FLAG.hollow);
	assert.deepEqual(Array.from(more.positions), [0, 0, 1]);
});

test('the shaders are WebGL1 (Safari 13): round sprites through gl_PointCoord, sizes clamped to the device range', () => {
	assert.doesNotMatch(VERTEX_SHADER + FRAGMENT_SHADER, /#version 300|\bin vec|\bout vec|texture\(/);
	assert.match(FRAGMENT_SHADER, /gl_PointCoord/);
	assert.match(FRAGMENT_SHADER, /discard/);
	assert.match(VERTEX_SHADER, /clamp\([^;]*u_minSize, u_maxSize\)/);
});

test('no WebGL: the factory answers null so the Canvas2D renderer takes over', () => {
	const canvas = new FakeCanvas({ webgl: null });
	assert.equal(createWebglRenderer(canvas as unknown as HTMLCanvasElement, () => undefined), null);
});

test('WebGL: reads the point-size range, uploads on setPoints only, draws every point in one POINTS call', () => {
	const fake = fakeGl([1, 32]);
	const canvas = new FakeCanvas({ webgl: fake.gl });
	const renderer = createWebglRenderer(canvas as unknown as HTMLCanvasElement, () => undefined);
	assert.ok(renderer);
	assert.equal(renderer.kind, 'webgl');
	assert.equal(renderer.pointSizeRange[1], 32);
	renderer.resize(400, 300, 2);
	renderer.setPoints(three(), [1, 1, 1]);
	const uploads = fake.count('bufferData');
	assert.equal(uploads, 3, 'positions, colours, flags');
	renderer.render({ matrix, pointSizePx: 6, dpr: 2 });
	renderer.render({ matrix, pointSizePx: 6, dpr: 2 });
	assert.equal(fake.count('bufferData'), uploads, 'drawing again uploads nothing');
	const draw = fake.last('drawArrays');
	assert.ok(draw);
	assert.equal(draw.args[0], (fake.gl as unknown as Record<string, number>).POINTS);
	assert.equal(draw.args[2], 3);
	assert.equal(canvas.width, 800);
	assert.equal(canvas.height, 600);
});

test('a lost WebGL context stops drawing (and is not let go); a restored one is rebuilt and redrawn', () => {
	const fake = fakeGl();
	const canvas = new FakeCanvas({ webgl: fake.gl });
	let redraws = 0;
	const renderer = createWebglRenderer(canvas as unknown as HTMLCanvasElement, () => (redraws += 1));
	assert.ok(renderer);
	renderer.setPoints(three(), [1, 1, 1]);
	const lost = canvas.dispatch('webglcontextlost');
	assert.equal(lost.prevented, true, 'preventDefault lets the browser restore it');
	assert.equal(renderer.lost, true);
	const before = fake.count('drawArrays');
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	assert.equal(fake.count('drawArrays'), before);
	const programs = fake.count('createProgram');
	canvas.dispatch('webglcontextrestored');
	assert.equal(renderer.lost, false);
	assert.equal(fake.count('createProgram'), programs + 1);
	assert.equal(redraws, 1);
	renderer.destroy();
	assert.equal(canvas.listeners.get('webglcontextlost')?.length, 0);
});

test('the canvas is never sized 0x0 (a hidden tab measures 0), and follows devicePixelRatio', () => {
	const canvas = new FakeCanvas({});
	sizeCanvas(canvas as unknown as HTMLCanvasElement, 0, 0, 2);
	assert.equal(canvas.width, 1);
	assert.equal(canvas.height, 1);
	sizeCanvas(canvas as unknown as HTMLCanvasElement, 320.4, 200, 1.5);
	assert.deepEqual([canvas.width, canvas.height], [481, 300]);
	assert.deepEqual([canvas.style.width, canvas.style.height], ['320.4px', '200px']);
});

test('Canvas2D fallback: one circle per visible point, outlines stroked, hidden points skipped', () => {
	const fake = fake2d();
	const canvas = new FakeCanvas({ '2d': fake.ctx });
	const renderer = createCanvas2dRenderer(canvas as unknown as HTMLCanvasElement);
	assert.ok(renderer);
	assert.equal(renderer.kind, 'canvas2d');
	renderer.resize(400, 300, 1);
	renderer.setPoints(three(), [0, 0, 0]);
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	assert.equal(fake.count('arc'), 2 + 1, 'two filled points, plus the outline of the outlined one');
	assert.ok(fake.count('fill') >= 2);
	assert.equal(fake.count('stroke'), 1);
});

// -----------------------------------------------------------------------------
// Overlay
// -----------------------------------------------------------------------------

const screen = (i: number): [number, number] | null => (i === 9 ? null : [i * 10, i * 5]);
const place = (p: { x: number; y: number }): [number, number] => [p.x, p.y];
const colours = { accent: '#0078d4', outline: '#1a1a1a', other: '#666666', text: '#1a1a1a', surface: '#ffffff' };

/** An overlay with nothing to draw. */
function empty(): IOverlayModel {
	return { hovered: null, selected: null, focused: null, highlight: [], neighbours: [], hollow: [], star: null, rays: [], chunkPath: [], duplicates: [], outliers: [], lasso: [], pulse: 0 };
}

test('an empty overlay draws nothing', () => {
	const fake = fake2d();
	drawOverlay(fake.ctx, empty(), screen, place, colours, 1);
	assert.equal(fake.count('stroke') + fake.count('fill'), 0);
});

test('the star, one ray per true top-k result, and the selection ring are drawn in the accent', () => {
	const fake = fake2d();
	drawOverlay(fake.ctx, { ...empty(), selected: 2, star: { x: 100, y: 100, exact: true }, rays: [{ index: 1 }, { index: 3 }, { at: { x: 5, y: 5 } }] }, screen, place, colours, 1);
	assert.equal(fake.count('lineTo') >= 3 + 9, true, 'three rays plus the star outline');
	assert.ok(fake.sets.some(([k, v]) => k === 'strokeStyle' && v === colours.accent));
	assert.ok(fake.count('arc') >= 1, 'selection ring');
});

test('duplicates are dashed, the chunk path is a polyline in chunk order, the lasso is closed, and points off screen are skipped', () => {
	const fake = fake2d();
	drawOverlay(fake.ctx, { ...empty(), duplicates: [[1, 2], [3, 9]], chunkPath: [1, 2, 3, 9, 4], lasso: [0, 0, 50, 0, 50, 50] }, screen, place, colours, 1);
	const dashes = fake.calls.filter((c) => c.name === 'setLineDash');
	assert.ok(dashes.some((c) => (c.args[0] as number[]).length > 0), 'a dashed line');
	assert.ok(fake.count('closePath') >= 1, 'the lasso is closed');
	// The duplicate pair with an off-screen end is not drawn: only one moveTo for duplicates.
	assert.ok(fake.count('moveTo') >= 3);
});

test('the overlay reports what it drew, not what it was asked for: the star, rays and links whose ends are on screen, chunk-path points on a drawn segment', () => {
	assert.deepEqual(drawOverlay(fake2d().ctx, empty(), screen, place, colours, 1), { star: false, rays: 0, links: 0, chunkPath: 0 });
	const asked: IOverlayModel = {
		...empty(),
		selected: 2,
		// 9 is off screen; an end with neither index nor place resolves to nothing.
		neighbours: [{ index: 1 }, { index: 9 }, { at: { x: 5, y: 5 } }, {}],
		star: { x: 100, y: 100, exact: true },
		rays: [{ index: 1 }, { index: 9 }, { index: 3 }],
		// Segments 1-2 and 5-6 are drawn; 4 sits between two off-screen points and joins nothing.
		chunkPath: [1, 2, 9, 4, 9, 5, 6],
	};
	assert.deepEqual(drawOverlay(fake2d().ctx, asked, screen, place, colours, 1), { star: true, rays: 2, links: 2, chunkPath: 4 });
	// The selected point itself off screen: no link is drawn, whatever was asked.
	assert.equal(drawOverlay(fake2d().ctx, { ...empty(), selected: 9, neighbours: [{ index: 1 }] }, screen, place, colours, 1).links, 0);
	// A star that cannot be placed draws neither itself nor its rays.
	const nowhere = (p: { x: number; y: number }): [number, number] | null => (Number.isFinite(p.x) ? [p.x, p.y] : null);
	assert.deepEqual(drawOverlay(fake2d().ctx, { ...empty(), star: { x: NaN, y: 0, exact: true }, rays: [{ index: 1 }] }, screen, nowhere, colours, 1), { star: false, rays: 0, links: 0, chunkPath: 0 });
	// A one-point path is not a path.
	assert.equal(drawOverlay(fake2d().ctx, { ...empty(), chunkPath: [3] }, screen, place, colours, 1).chunkPath, 0);
});

test('what the overlay drew becomes the canvas root\'s data attributes (data-star, data-rays, data-links, data-chunk-path)', () => {
	assert.deepEqual(overlayDataset({ star: true, rays: 10, links: 12, chunkPath: 7 }), { star: '1', rays: '10', links: '12', chunkPath: '7' });
	assert.deepEqual(overlayDataset({ star: false, rays: 0, links: 0, chunkPath: 0 }), { star: '0', rays: '0', links: '0', chunkPath: '0' });
});

// -----------------------------------------------------------------------------
// Snapshot: the points for a PNG, drawn again and copied in the same task
// -----------------------------------------------------------------------------

/** A 2D target that records when it copied an image, against the GL draws so far. */
function target(drawsSoFar: () => number) {
	const images: Array<{ source: unknown; drawsBefore: number }> = [];
	const ctx = { drawImage: (source: unknown) => images.push({ source, drawsBefore: drawsSoFar() }) } as unknown as CanvasRenderingContext2D;
	return { ctx, images };
}

test('WebGL snapshot: with preserveDrawingBuffer off it draws the last frame again and copies the canvas in the same call', () => {
	const fake = fakeGl();
	const canvas = new FakeCanvas({ webgl: fake.gl });
	const renderer = createWebglRenderer(canvas as unknown as HTMLCanvasElement, () => undefined);
	assert.ok(renderer);
	const t = target(() => fake.count('drawArrays'));
	assert.equal(renderer.snapshot(t.ctx), false, 'nothing drawn yet: nothing to copy');
	assert.equal(t.images.length, 0);
	renderer.resize(400, 300, 1);
	renderer.setPoints(three(), [1, 1, 1]);
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	const before = fake.count('drawArrays');
	assert.equal(renderer.snapshot(t.ctx), true);
	assert.equal(fake.count('drawArrays'), before + 1, 'the last frame is drawn again');
	assert.equal(t.images.length, 1);
	assert.equal(t.images[0]?.source, canvas, 'the WebGL canvas is copied');
	assert.equal(t.images[0]?.drawsBefore, before + 1, 'after it was drawn again, before the browser could clear it');
	canvas.dispatch('webglcontextlost');
	assert.equal(renderer.snapshot(t.ctx), false, 'a lost context has nothing to copy');
	assert.equal(t.images.length, 1);
});

test('Canvas2D snapshot: draws the last frame again and copies it', () => {
	const fake = fake2d();
	const canvas = new FakeCanvas({ '2d': fake.ctx });
	const renderer = createCanvas2dRenderer(canvas as unknown as HTMLCanvasElement);
	assert.ok(renderer);
	const t = target(() => fake.count('arc'));
	assert.equal(renderer.snapshot(t.ctx), false);
	renderer.resize(400, 300, 1);
	renderer.setPoints(three(), [0, 0, 0]);
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	const arcs = fake.count('arc');
	assert.equal(renderer.snapshot(t.ctx), true);
	assert.equal(fake.count('arc'), arcs * 2);
	assert.equal(t.images[0]?.source, canvas);
});

// -----------------------------------------------------------------------------
// The edge layer: one path per alpha bucket, at most 8 strokes a frame
// -----------------------------------------------------------------------------

/** A Path2D stand-in that counts its segments. */
class FakePath {
	moves = 0;
	lines = 0;
	moveTo(): void {
		this.moves += 1;
	}
	lineTo(): void {
		this.lines += 1;
	}
}

test('edges are bucketed by similarity into 8 alpha steps, weakest faintest', () => {
	const sample = loadSample('sample_demo_1000.json');
	const edges = topEdges(sample.knn, sample.n, 5);
	const buckets = edgeBuckets(edges);
	assert.equal(buckets.length, edges.count);
	const stats = edgeStats(edges);
	let weakest = 0;
	let strongest = 0;
	for (let e = 0; e < edges.count; e += 1) {
		if (Math.abs((edges.sim[e] as number) - (stats.min as number)) < 1e-4) weakest = e;
		if (Math.abs((edges.sim[e] as number) - (stats.max as number)) < 1e-4) strongest = e;
		assert.ok((buckets[e] as number) >= 0 && (buckets[e] as number) < EDGE_BUCKETS);
	}
	assert.equal(buckets[weakest], 0);
	assert.equal(buckets[strongest], EDGE_BUCKETS - 1);
	for (let b = 1; b < EDGE_BUCKETS; b += 1) assert.ok(edgeAlpha(b) > edgeAlpha(b - 1));
	// All edges equally similar: one bucket.
	assert.equal(new Set(edgeBuckets({ ...edges, sim: new Float32Array(edges.count).fill(0.5) })).size, 1);
});

test('the tree draws n-1 segments, Neighbours m=5 at most 5n, each frame in at most 8 strokes', () => {
	const sample = loadSample('sample_demo_1000.json');
	const at = (i: number): [number, number] => [sample.points.x[i] as number, sample.points.y[i] as number];
	const tree = spanningTree(sample.knn, sample.n);
	const treePaths = buildEdgePaths(tree.edges, edgeBuckets(tree.edges), at, () => new FakePath());
	assert.equal(treePaths.segments, sample.n - tree.components);
	assert.equal(treePaths.paths.reduce((s, p) => s + (p ? p.lines : 0), 0), treePaths.segments);
	const five = topEdges(sample.knn, sample.n, 5);
	const fivePaths = buildEdgePaths(five, edgeBuckets(five), at, () => new FakePath());
	assert.ok(fivePaths.segments <= 5 * sample.n);
	assert.equal(fivePaths.segments, five.count);
	const fake = fake2d();
	const strokes = strokeEdgePaths(fake.ctx, fivePaths.paths as unknown as Array<Path2D | null>, '#666666', 1);
	assert.ok(strokes >= 1 && strokes <= EDGE_BUCKETS, `${strokes} strokes`);
	assert.equal(fake.count('stroke'), strokes);
	assert.equal(fake.count('lineTo'), 0, 'the frame strokes the cached paths; it builds none');
	// Ends off screen (behind the 3D eye) are skipped, never guessed.
	const offscreen = buildEdgePaths(tree.edges, edgeBuckets(tree.edges), (i) => (i % 2 === 0 ? null : at(i)), () => new FakePath());
	assert.ok(offscreen.segments < treePaths.segments);
	assert.equal(buildEdgePaths(NO_EDGES, new Uint8Array(0), at, () => new FakePath()).segments, 0);
});

test('in 2D the cached paths are in layout units: the edge transform maps them exactly where the points are drawn', () => {
	const camera = { mode: '2d' as const, cx: 1.5, cy: -2, scale: 37 };
	const view = { width: 640, height: 360 };
	const dpr = 2;
	const t = edgeTransform2d(camera, view, dpr);
	const m = viewMatrix(camera, view);
	for (const [x, y] of [[0, 0], [1.5, -2], [-3, 4.25]] as Array<[number, number]>) {
		const [sx, sy] = projectToScreen(new Float32Array([x, y]), 2, m, view) as unknown as [number, number];
		// The view matrix is float32: agree within a thousandth of a device pixel.
		assert.ok(Math.abs(t.a * x + t.c * y + t.e - sx * dpr) < 1e-3);
		assert.ok(Math.abs(t.b * x + t.d * y + t.f - sy * dpr) < 1e-3);
	}
	assert.ok(Math.abs(t.lineWidth * t.a - dpr) < 1e-9, 'a 1 CSS-pixel line');
});

// -----------------------------------------------------------------------------
// Extras: the second star, hover edges, cluster labels
// -----------------------------------------------------------------------------

/** No extras. */
function noExtras(): IOverlayExtras {
	return { starB: null, raysB: [], hoverEdges: [], labels: [], showLabels: true, clusterHighlight: [] };
}

test('star B is drawn hollow with its own rays; what was drawn becomes data-star-b and data-rays-b', () => {
	const fake = fake2d();
	const drawn = drawExtras(fake.ctx, { ...noExtras(), starB: { x: 50, y: 50, exact: true }, raysB: [{ index: 1 }, { index: 9 }, { index: 2 }] }, screen, place, colours);
	assert.equal(drawn.starB, true);
	assert.equal(drawn.raysB, 2, 'the ray to an off-screen point is not drawn');
	assert.deepEqual(extrasDataset(drawn), { starB: '1', raysB: '2', labels: '0' });
	assert.equal(fake.count('fill'), 1, 'hollow: filled with the surface, outlined in the accent');
	assert.ok(fake.sets.some(([k, v]) => k === 'fillStyle' && v === colours.surface));
	assert.deepEqual(extrasDataset(drawExtras(fake2d().ctx, noExtras(), screen, place, colours)), { starB: '0', raysB: '0', labels: '0' });
});

test('cluster labels: drawn once at their medoid in 11 px text with a halo, never overlapping, hidden when zoomed out, at most 50', () => {
	const fake = fake2d();
	const labels = [
		{ cluster: 0, at: 1, text: 'falcon · station · water · spring' },
		{ cluster: 1, at: 2, text: 'orchid · greenhouse' },
		// Same place as the first: skipped rather than drawn over it.
		{ cluster: 2, at: 1, text: 'manual' },
		{ cluster: 3, at: 9, text: 'off screen' },
	];
	const spread = (i: number): [number, number] | null => (i === 9 ? null : [i * 200, i * 60]);
	const drawn = drawExtras(fake.ctx, { ...noExtras(), labels }, spread, place, colours);
	assert.equal(drawn.labels, 2);
	assert.equal(drawn.boxes.length, 2);
	assert.deepEqual(drawn.boxes.map((b) => b.cluster), [0, 1]);
	assert.equal(fake.count('fillText'), 2);
	assert.equal(fake.count('strokeText'), 2, 'the halo');
	assert.ok(fake.sets.some(([k, v]) => k === 'font' && String(v).startsWith('11px')));
	assert.ok(fake.sets.some(([k, v]) => k === 'fillStyle' && v === colours.text));
	assert.equal(drawExtras(fake2d().ctx, { ...noExtras(), labels, showLabels: false }, spread, place, colours).labels, 0);
	const many = Array.from({ length: 80 }, (_, g) => ({ cluster: g, at: g === 9 ? 0 : g, text: `g${g}` }));
	const far = (i: number): [number, number] => [i * 100, i * 40];
	assert.ok(drawExtras(fake2d().ctx, { ...noExtras(), labels: many }, far, place, colours).labels <= 50);
	// Only the first three terms go on the canvas (the Clusters tab shows them all).
	const one = fake2d();
	drawExtras(one.ctx, { ...noExtras(), labels: [labels[0]!] }, screen, place, colours);
	assert.equal(one.calls.find((c) => c.name === 'fillText')?.args[0], 'falcon · station · water');
});

test('hovering a point thickens its edges; hovering a label rings its cluster', () => {
	const fake = fake2d();
	const drawn = drawExtras(fake.ctx, { ...noExtras(), hoverEdges: [[1, 2], [2, 9]], clusterHighlight: [1, 2, 3] }, screen, place, colours);
	assert.equal(drawn.hoverEdges, 1, 'an edge to an off-screen point is not drawn');
	assert.ok(fake.sets.some(([k, v]) => k === 'lineWidth' && (v as number) >= 2));
	assert.ok(fake.count('arc') >= 3);
});
