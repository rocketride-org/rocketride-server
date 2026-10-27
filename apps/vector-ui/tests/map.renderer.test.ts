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
import { alphaOf, contrastRatio, parseColor } from '../src/map/contrast';
import type { Rgb } from '../src/map/contrast';
import { NO_EDGES, edgeStats, spanningTree, topEdges } from '../src/map/graph';
import { EDGE_BUCKETS, buildEdgePaths, drawExtras, drawOverlay, edgeBuckets, edgeColours, edgeTransform2d, extrasDataset, fadeColour, fadedEdgeColours, overlayDataset, strokeEdgePaths } from '../src/map/overlay';
import type { IOverlayExtras, IOverlayModel } from '../src/map/overlay';
import { createCanvas2dRenderer } from '../src/map/renderer.canvas2d';
import { DIM, FLAG, FRAGMENT_SHADER, PASS, VERTEX_SHADER, createWebglRenderer, dimFlags, packPoints, sizeCanvas } from '../src/map/renderer.webgl';
import { FALLBACK_PALETTE, readPalette } from '../src/map/tokens';
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

test('edges are bucketed by similarity into 8 steps, weakest faintest (its colour the closest to the surface)', () => {
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
	const surface = parseColor(FALLBACK_PALETTE.surfaces.default) as Rgb;
	const colours = edgeColours(FALLBACK_PALETTE);
	for (let b = 1; b < EDGE_BUCKETS; b += 1) assert.ok(contrastRatio(parseColor(colours[b] as string) as Rgb, surface) > contrastRatio(parseColor(colours[b - 1] as string) as Rgb, surface), `bucket ${b} stands out more than ${b - 1}`);
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
	const strokes = strokeEdgePaths(fake.ctx, fivePaths.paths as unknown as Array<Path2D | null>, edgeColours(FALLBACK_PALETTE), 1);
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

// -----------------------------------------------------------------------------
// The edge colours: opaque, one per bucket, never an alpha over a token
// -----------------------------------------------------------------------------

test('each bucket is stroked opaque in its own colour, and nothing writes globalAlpha (the colour painted is the colour measured)', () => {
	const colours = edgeColours(FALLBACK_PALETTE);
	assert.equal(colours.length, EDGE_BUCKETS);
	assert.equal(new Set(colours).size, EDGE_BUCKETS, 'eight distinct steps');
	for (const c of colours) assert.equal(alphaOf(c), 1, `${c} is opaque`);
	const fake = fake2d();
	const paths = Array.from({ length: EDGE_BUCKETS }, (_, b) => (b === 3 ? null : ({} as Path2D)));
	assert.equal(strokeEdgePaths(fake.ctx, paths, colours, 1.5), EDGE_BUCKETS - 1);
	const styles = fake.sets.filter(([k]) => k === 'strokeStyle').map(([, v]) => v);
	assert.deepEqual(styles, colours.filter((_, b) => b !== 3), 'bucket b in colours[b]');
	assert.ok(!fake.sets.some(([k]) => k === 'globalAlpha'), 'no alpha ramp');
	// A dark theme: the weakest is the surface mixed toward the text just far enough (RocketRide dark: rgb(99, 99, 99)).
	const rocketride = readPalette((t) => ({ '--rr-palette-mode': 'dark', '--rr-bg-default': '#080808', '--rr-bg-paper': '#161616', '--rr-text-primary': '#ffffff' } as Record<string, string>)[t] ?? '');
	const dark = edgeColours(rocketride);
	assert.equal(dark[0], 'rgb(99, 99, 99)');
	assert.ok(contrastRatio(parseColor(dark[0] as string) as Rgb, { r: 8, g: 8, b: 8 }) >= 3);
	assert.ok(contrastRatio(parseColor(dark[0] as string) as Rgb, { r: 22, g: 22, b: 22 }) >= 3);
	assert.equal(dark[EDGE_BUCKETS - 1], 'rgb(206, 206, 206)', 'the strongest is 80 % of the way to the text');
});

// -----------------------------------------------------------------------------
// Dimming: a flag bit, two passes, opaque, and back after a lost context
// -----------------------------------------------------------------------------

/** Calls of uniform1f/uniform3f on a named uniform, in order. */
function uniformCalls(fake: ReturnType<typeof fakeGl>, name: string): unknown[][] {
	return fake.calls.filter((c) => (c.name === 'uniform1f' || c.name === 'uniform3f') && (c.args[0] as { uniform?: string } | null)?.uniform === name).map((c) => c.args.slice(1));
}

test('dimFlags sets the dimmed bit on masked points, never counts a hidden one, and ignores a mask of another length', () => {
	const base = three().flags;
	const out = dimFlags(base, new Uint8Array([1, 0, 1]));
	assert.deepEqual(Array.from(out.flags), [FLAG.dimmed, FLAG.outlined, FLAG.hidden], 'the hidden point stays hidden, undimmed');
	assert.equal(out.dimmed, 1);
	assert.equal(dimFlags(base, null).dimmed, 0);
	assert.equal(dimFlags(base, new Uint8Array(5).fill(1)).dimmed, 0, 'a stale mask (another sample) dims nothing');
	assert.deepEqual(Array.from(dimFlags(dimFlags(base, new Uint8Array([1, 1, 0])).flags, new Uint8Array([0, 0, 0])).flags), Array.from(base), 'undimming clears the bit');
});

test('the shaders dim by mixing toward u_surface (opaque), and u_pass culls the other set in the vertex stage', () => {
	assert.match(VERTEX_SHADER, /uniform float u_pass;/);
	assert.match(VERTEX_SHADER, /bit\(a_flags, 16\.0\)/);
	assert.match(VERTEX_SHADER, /if \(bit\(a_flags, 2\.0\) > 0\.5 \|\| culled\)/, 'a point outside the pass is dropped like a hidden one');
	assert.match(FRAGMENT_SHADER, /uniform vec3 u_surface;/);
	assert.match(FRAGMENT_SHADER, /rgb = mix\(u_surface, rgb, u_dim\)/);
	assert.match(FRAGMENT_SHADER, /gl_FragColor = vec4\(rgb, 1\.0\);/);
	assert.doesNotMatch(FRAGMENT_SHADER, /gl_FragColor = vec4\([^)]*, (?!1\.0)[0-9.]+\)/, 'no translucent fragment');
	assert.equal(FLAG.dimmed, 16);
	assert.equal(DIM, 0.25);
});

test('WebGL dimming: setDimmed uploads the flags only; a frame with none dimmed is one draw, with some it is two (faded first, then the lit ones over them)', () => {
	const fake = fakeGl();
	const canvas = new FakeCanvas({ webgl: fake.gl });
	const renderer = createWebglRenderer(canvas as unknown as HTMLCanvasElement, () => undefined);
	assert.ok(renderer);
	renderer.resize(400, 300, 1);
	renderer.setPoints(three(), [1, 1, 1]);
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	assert.equal(fake.count('drawArrays'), 1);
	assert.deepEqual(uniformCalls(fake, 'u_pass').at(-1), [PASS.all]);
	const uploads = fake.count('bufferData');
	assert.equal(renderer.setDimmed(new Uint8Array([1, 0, 0]), [0.03, 0.03, 0.03]), 1);
	assert.equal(fake.count('bufferData'), uploads + 1, 'only the flags');
	assert.equal(((fake.last('bufferData')?.args[1] as Uint8Array)[0] as number) & FLAG.dimmed, FLAG.dimmed);
	const before = fake.calls.length;
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	const frame = fake.calls.slice(before);
	assert.equal(frame.filter((c) => c.name === 'drawArrays').length, 2);
	const passes = frame.filter((c) => c.name === 'uniform1f' && (c.args[0] as { uniform: string }).uniform === 'u_pass').map((c) => c.args[1]);
	assert.deepEqual(passes, [PASS.dimmed, PASS.lit], 'the faded set first');
	assert.ok(frame.some((c) => c.name === 'uniform3f' && (c.args[0] as { uniform: string }).uniform === 'u_surface' && c.args[1] === 0.03));
	assert.ok(frame.some((c) => c.name === 'uniform1f' && (c.args[0] as { uniform: string }).uniform === 'u_dim' && c.args[1] === DIM));
	assert.ok(!frame.some((c) => c.name === 'enable' || c.name === 'blendFunc'), 'no blending');
	// New points of the same count keep the mask; the snapshot (the PNG) draws the same two passes.
	renderer.setPoints(three(), [1, 1, 1]);
	assert.equal(((fake.last('bufferData')?.args[1] as Uint8Array)[0] as number) & FLAG.dimmed, FLAG.dimmed);
	const draws = fake.count('drawArrays');
	assert.equal(renderer.snapshot({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D), true);
	assert.equal(fake.count('drawArrays'), draws + 2, 'the PNG shows the dimming as drawn');
	assert.equal(renderer.setDimmed(null, [0.03, 0.03, 0.03]), 0);
	const one = fake.count('drawArrays');
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	assert.equal(fake.count('drawArrays'), one + 1, 'nothing dimmed: one draw again');
});

test('a lost context keeps the dimming: a mask set while lost is uploaded on restore, and the new program\'s u_surface, u_dim and u_pass are read and set', () => {
	const fake = fakeGl();
	const canvas = new FakeCanvas({ webgl: fake.gl });
	const renderer = createWebglRenderer(canvas as unknown as HTMLCanvasElement, () => undefined);
	assert.ok(renderer);
	renderer.resize(400, 300, 1);
	renderer.setPoints(three(), [1, 1, 1]);
	canvas.dispatch('webglcontextlost');
	const uploads = fake.count('bufferData');
	assert.equal(renderer.setDimmed(new Uint8Array([0, 1, 0]), [0.1, 0.1, 0.1]), 1);
	assert.equal(fake.count('bufferData'), uploads, 'nothing is uploaded to a lost context');
	const before = fake.calls.length;
	canvas.dispatch('webglcontextrestored');
	const restore = fake.calls.slice(before);
	assert.equal(restore.filter((c) => c.name === 'createProgram').length, 1);
	for (const name of ['u_surface', 'u_dim', 'u_pass']) assert.ok(restore.some((c) => c.name === 'getUniformLocation' && c.args[1] === name), `${name} read from the new program`);
	const flags = restore.filter((c) => c.name === 'bufferData').at(-1)?.args[1] as Uint8Array;
	assert.equal((flags[1] as number) & FLAG.dimmed, FLAG.dimmed, 'the merged flags are uploaded');
	const frameAt = fake.calls.length;
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	const frame = fake.calls.slice(frameAt);
	assert.equal(frame.filter((c) => c.name === 'drawArrays').length, 2);
	assert.ok(frame.some((c) => c.name === 'uniform3f' && (c.args[0] as { uniform: string }).uniform === 'u_surface' && c.args[1] === 0.1));
});

test('Canvas2D dimming: the faded points are drawn first, in the colour mixed toward the surface (opaque), then the lit ones', () => {
	const fake = fake2d();
	const canvas = new FakeCanvas({ '2d': fake.ctx });
	const renderer = createCanvas2dRenderer(canvas as unknown as HTMLCanvasElement);
	assert.ok(renderer);
	renderer.resize(400, 300, 1);
	renderer.setPoints(three(), [0, 0, 0]);
	assert.equal(renderer.setDimmed(new Uint8Array([1, 0, 0]), [1, 1, 1]), 1);
	renderer.render({ matrix, pointSizePx: 6, dpr: 1 });
	const fills = fake.sets.filter(([k]) => k === 'fillStyle').map(([, v]) => v);
	// Red at 25 % over white: 255 * 0.75 + 255 * 0.25, 255 * 0.75 + 0, 255 * 0.75 + 0.
	assert.deepEqual(fills, ['rgb(255, 191, 191)', 'rgb(0, 255, 0)'], 'the faded red first, then the lit green');
	assert.ok(!fake.sets.some(([k]) => k === 'globalAlpha'), 'opaque: no alpha');
	assert.equal(fake.count('arc'), 2 + 1, 'every shown point once, plus the lit outline');
});

// -----------------------------------------------------------------------------
// The marks that cross points: halos, the star's edge, the links, duplicate rings
// -----------------------------------------------------------------------------

test('an outlier ring is stroked over a 4 px halo of the surface first, then 1.5 px in the outline colour', () => {
	const fake = fake2d();
	drawOverlay(fake.ctx, { ...empty(), outliers: [1, 2] }, screen, place, colours, 1);
	const strokes = fake.calls.filter((c) => c.name === 'stroke').length;
	assert.equal(strokes, 2);
	const pairs = fake.sets.filter(([k]) => k === 'strokeStyle' || k === 'lineWidth').map(([k, v]) => `${k}=${String(v)}`);
	assert.deepEqual(pairs, [`strokeStyle=${colours.surface}`, 'lineWidth=4', `strokeStyle=${colours.outline}`, 'lineWidth=1.5'], 'the halo, then the ring');
});

test('the star is filled with the accent and edged with the surface (as its comment says); the selected point\'s links are 1.5 px', () => {
	const fake = fake2d();
	drawOverlay(fake.ctx, { ...empty(), star: { x: 100, y: 100, exact: true } }, screen, place, colours, 1);
	const at = fake.sets.findIndex(([k, v]) => k === 'fillStyle' && v === colours.accent);
	assert.ok(at >= 0);
	assert.deepEqual(fake.sets.slice(at + 1, at + 3), [['strokeStyle', colours.surface], ['lineWidth', 1]]);
	const links = fake2d();
	drawOverlay(links.ctx, { ...empty(), selected: 2, neighbours: [{ index: 1 }, { index: 3 }] }, screen, place, colours, 1);
	const width = links.sets.findIndex(([k, v]) => k === 'strokeStyle' && v === colours.accent);
	assert.deepEqual(links.sets[width + 1], ['lineWidth', 1.5]);
});

test('a shown duplicate group: a dashed outline ring at each end over a surface halo, and each pair\'s similarity (with its scale) at its midpoint with a halo', () => {
	const fake = fake2d();
	drawOverlay(fake.ctx, { ...empty(), duplicateRings: [{ a: 1, b: 2, label: 'cosine 0.99' }, { a: 2, b: 9, label: 'cosine 0.99' }] }, screen, place, colours, 1);
	// Ends 1 and 2 are on screen, 9 is not: two rings (r 8), one label.
	assert.equal(fake.calls.filter((c) => c.name === 'arc' && c.args[2] === 8).length, 2);
	assert.ok(fake.calls.some((c) => c.name === 'setLineDash' && (c.args[0] as number[]).length > 0));
	const texts = fake.calls.filter((c) => c.name === 'fillText');
	assert.deepEqual(texts.map((c) => c.args.slice(0, 3)), [['cosine 0.99', 15, 7.5]], 'the midpoint of points 1 and 2');
	assert.equal(fake.calls.filter((c) => c.name === 'strokeText').length, 1, 'the label\'s halo');
	const order = fake.sets.filter(([k]) => k === 'strokeStyle').map(([, v]) => v);
	assert.deepEqual(order.slice(0, 2), [colours.surface, colours.outline], 'the halo before the ring');
});

test('a cluster label whose medoid is dimmed is not drawn (text over a faded group would not read)', () => {
	const labels = [{ cluster: 0, at: 1, text: 'falcon' }, { cluster: 1, at: 3, text: 'orchid' }];
	const spread = (i: number): [number, number] => [i * 200, i * 60];
	const fake = fake2d();
	const drawn = drawExtras(fake.ctx, { ...noExtras(), labels, dimmed: new Uint8Array([0, 1, 0, 0]) }, spread, place, colours);
	assert.equal(drawn.labels, 1);
	assert.deepEqual(fake.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]), ['orchid']);
});

test('while the map dims, an edge with both ends faded goes to the faded paths (drawn first, mixed toward the surface); an edge touching the lit set keeps its colour', () => {
	const sample = loadSample('sample_demo_1000.json');
	const at = (i: number): [number, number] => [sample.points.x[i] as number, sample.points.y[i] as number];
	const edges = topEdges(sample.knn, sample.n, 5);
	const all = buildEdgePaths(edges, edgeBuckets(edges), at, () => new FakePath());
	assert.equal(all.fadedSegments, 0);
	assert.ok(all.fadedPaths.every((p) => p === null), 'no mask: nothing faded');
	// Light points 0-9; fade the rest.
	const mask = new Uint8Array(sample.n).fill(1);
	for (let i = 0; i < 10; i += 1) mask[i] = 0;
	const split = buildEdgePaths(edges, edgeBuckets(edges), at, () => new FakePath(), mask);
	assert.equal(split.segments, all.segments, 'every edge is still drawn');
	let touching = 0;
	for (let e = 0; e < edges.count; e += 1) if (!mask[edges.a[e] as number] || !mask[edges.b[e] as number]) touching += 1;
	assert.equal(split.segments - split.fadedSegments, touching, 'only the edges touching the lit points stay lit');
	assert.equal(split.paths.reduce((n, p) => n + (p ? p.lines : 0), 0), touching);
	// Faded colours: each bucket mixed toward the surface at DIM, opaque, and fainter than its lit colour.
	const colours = edgeColours(FALLBACK_PALETTE);
	const faded = fadedEdgeColours(colours, FALLBACK_PALETTE.surfaces.default);
	const surface = parseColor(FALLBACK_PALETTE.surfaces.default) as Rgb;
	faded.forEach((c, b) => {
		assert.equal(alphaOf(c), 1);
		assert.ok(contrastRatio(parseColor(c) as Rgb, surface) < contrastRatio(parseColor(colours[b] as string) as Rgb, surface), `bucket ${b} faded`);
	});
	assert.equal(fadedEdgeColours(['rgb(0, 0, 0)'], 'rgb(255, 255, 255)')[0], 'rgb(191, 191, 191)', '25 % of black over white');
});

test('while the map dims, an outlier ring or a duplicate line on faded points only is faded too (no halo), drawn before the lit ones', () => {
	const fake = fake2d();
	// Points 1 and 2 faded, 3 and 4 lit.
	const faded = new Uint8Array([0, 1, 1, 0, 0]);
	drawOverlay(fake.ctx, { ...empty(), outliers: [1, 3], duplicates: [[1, 2], [2, 3]], faded }, screen, place, colours, 1);
	const dim = fadeColour(colours.outline, colours.surface);
	const styles = fake.sets.filter(([k]) => k === 'strokeStyle').map(([, v]) => v);
	// Duplicates: the faded pair (1-2) first, then the pair touching a lit point (2-3); outliers: faded ring 1, then the lit ring 3 over its halo.
	assert.deepEqual(styles, [dim, colours.outline, dim, colours.surface, colours.outline]);
	assert.equal(fadeColour('#000000', '#ffffff'), 'rgb(191, 191, 191)');
	// No mask: as before, one stroke per mark kind.
	const plain = fake2d();
	drawOverlay(plain.ctx, { ...empty(), outliers: [1, 3], duplicates: [[1, 2]] }, screen, place, colours, 1);
	assert.deepEqual(plain.sets.filter(([k]) => k === 'strokeStyle').map(([, v]) => v), [colours.outline, colours.surface, colours.outline]);
});

test('splitting the edges by a new dimming is cheap: 30,000 edges (3,000 points x 10) re-split in well under a frame budget of path building', () => {
	const n = 3000;
	const count = n * 10;
	const a = new Uint32Array(count);
	const b = new Uint32Array(count);
	const sim = new Float32Array(count);
	for (let e = 0; e < count; e += 1) {
		a[e] = Math.floor(e / 10);
		b[e] = (Math.floor(e / 10) + 1 + (e % 10) * 7) % n;
		sim[e] = 0.5 + (e % 97) / 200;
	}
	const edges = { count, a, b, sim } as unknown as Parameters<typeof edgeBuckets>[0];
	const buckets = edgeBuckets(edges);
	const at = (i: number): [number, number] => [i % 100, Math.floor(i / 100)];
	const mask = new Uint8Array(n);
	for (let i = 0; i < n; i += 1) mask[i] = i % 4 === 0 ? 0 : 1;
	buildEdgePaths(edges, buckets, at, () => new FakePath(), mask);
	const started = performance.now();
	for (let r = 0; r < 5; r += 1) buildEdgePaths(edges, buckets, at, () => new FakePath(), mask);
	const ms = (performance.now() - started) / 5;
	console.log(`edge split at 30,000 edges: ${ms.toFixed(2)} ms (the browser's Path2D adds its own cost; such a frame never counts toward dropping edges)`);
	assert.ok(ms < 33, `${ms.toFixed(1)} ms`);
});
