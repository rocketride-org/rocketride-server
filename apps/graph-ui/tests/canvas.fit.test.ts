// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// FIT BOUNDS: the fit shows everything that is drawn
// =============================================================================
//
// React Flow's own fit uses node boxes only, so a self-loop on the topmost node (which reaches
// 36 units and more beyond its circle) would be clipped at the canvas edge on first fit. The
// bounds come from the same geometry the edge layer draws from.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CAPTION_BELOW, contentBounds, nodeBoxBounds, pairsIn } from '../src/canvas/fitBounds';
import type { IBoundsEdge, IRect } from '../src/canvas/fitBounds';
import { LOOP_REACH, NODE_RADIUS, edgeShape, edgeSlots } from '../src/graph/geometry';
import type { Point } from '../src/graph/geometry';

const centers = (entries: Record<string, [number, number]>): Map<string, Point> => new Map(Object.entries(entries).map(([id, [x, y]]) => [id, { x, y }]));

/** Edges with slots, the way the canvas builds them. */
function edgesOf(specs: Array<{ id: string; source: string; target: string; type?: string }>): IBoundsEdge[] {
	const slots = edgeSlots(specs);
	return specs.map((s) => ({ source: s.source, target: s.target, slot: slots.get(s.id)!, type: s.type ?? 'KNOWS' }));
}

const within = (rect: IRect, p: Point, slack = 1e-6): boolean => p.x >= rect.x - slack && p.x <= rect.x + rect.width + slack && p.y >= rect.y - slack && p.y <= rect.y + rect.height + slack;

test('a self-loop on the topmost node is inside the bounds; node-box bounds alone cut it off', () => {
	const c = centers({ top: [200, 100], below: [200, 300] });
	const edges = edgesOf([{ id: 'loop', source: 'top', target: 'top', type: 'SELF' }, { id: 'e', source: 'top', target: 'below' }]);
	const old = nodeBoxBounds(c)!;
	const now = contentBounds(c, edges)!;
	const loop = edgeShape(c.get('top')!, c.get('top')!, edges[0].slot);
	// The loop leaves the top of its node: its apex is far above the node's own circle.
	assert.ok(loop.label.y < old.y - 20, `the loop apex (${loop.label.y.toFixed(1)}) is above the node-box top (${old.y})`);
	assert.ok(old.y > loop.label.y, 'the node-box bounds do not contain the apex (this is the clipping)');
	assert.ok(now.y <= loop.label.y, `the content bounds start at ${now.y.toFixed(1)}, at or above the apex ${loop.label.y.toFixed(1)}`);
	assert.ok(old.y - now.y >= LOOP_REACH, 'the bounds grew upward by at least the first loop\'s reach');
});

test('every point of every drawn curve, arrow and label anchor lies inside the content bounds (sampled along the real curves)', () => {
	const c = centers({ a: [0, 0], b: [260, 40], c: [120, -190], d: [-140, 150] });
	const edges = edgesOf([
		{ id: 'l0', source: 'c', target: 'c' }, { id: 'l1', source: 'c', target: 'c' }, { id: 'l2', source: 'c', target: 'c' }, { id: 'l3', source: 'a', target: 'a' },
		{ id: 'p0', source: 'a', target: 'b' }, { id: 'p1', source: 'a', target: 'b' }, { id: 'p2', source: 'b', target: 'a' }, { id: 'p3', source: 'a', target: 'b' },
		{ id: 'x', source: 'a', target: 'c' }, { id: 'y', source: 'd', target: 'a' }, { id: 'z', source: 'd', target: 'd' },
	]);
	const bounds = contentBounds(c, edges)!;
	for (const e of edges) {
		const shape = edgeShape(c.get(e.source)!, c.get(e.target)!, e.slot);
		const pts = pairsIn(shape.path);
		// Sample the Bezier the path describes: M p0, then Q p1 p2 (quadratic) or C p1 p2 p3 (cubic), or a straight line.
		const curve = (t: number): Point => {
			const u = 1 - t;
			if (pts.length === 3) return { x: u * u * pts[0].x + 2 * u * t * pts[1].x + t * t * pts[2].x, y: u * u * pts[0].y + 2 * u * t * pts[1].y + t * t * pts[2].y };
			if (pts.length === 4) return { x: u ** 3 * pts[0].x + 3 * u * u * t * pts[1].x + 3 * u * t * t * pts[2].x + t ** 3 * pts[3].x, y: u ** 3 * pts[0].y + 3 * u * u * t * pts[1].y + 3 * u * t * t * pts[2].y + t ** 3 * pts[3].y };
			return { x: pts[0].x + (pts[1].x - pts[0].x) * t, y: pts[0].y + (pts[1].y - pts[0].y) * t };
		};
		for (let i = 0; i <= 40; i++) assert.ok(within(bounds, curve(i / 40)), `${e.slot.loop ? 'loop' : 'edge'} ${e.source}>${e.target} slot ${e.slot.index}: point ${i}/40 is outside the bounds`);
		for (const p of [...pairsIn(shape.arrow), shape.tip, shape.from, shape.label]) assert.ok(within(bounds, p), `anchor of ${e.source}>${e.target} is outside the bounds`);
	}
});

test('a label sits inside the bounds with its text\'s width: a long type on a long horizontal edge near the edge of the graph', () => {
	const c = centers({ a: [0, 0], b: [60, 0] });
	const short = contentBounds(c, edgesOf([{ id: 'e', source: 'a', target: 'b', type: 'R' }]))!;
	const long = contentBounds(c, edgesOf([{ id: 'e', source: 'a', target: 'b', type: 'IS_A_VERY_LONG_RELATIONSHIP_TYPE_NAME' }]))!;
	assert.ok(long.width > short.width, 'a longer label needs more room');
	const shape = edgeShape(c.get('a')!, c.get('b')!, edgesOf([{ id: 'e', source: 'a', target: 'b' }])[0].slot);
	assert.ok(shape.label.x - long.x >= (38 * 5.6) / 2 - 1, 'the label\'s left edge fits inside');
});

test('nodes get room under them for their captions, and nothing else about a graph without relationships changes', () => {
	const c = centers({ a: [0, 0], b: [100, 80] });
	const content = contentBounds(c, [])!;
	const boxes = nodeBoxBounds(c)!;
	assert.equal(content.x, boxes.x);
	assert.equal(content.y, boxes.y);
	assert.equal(content.width, boxes.width);
	assert.equal(content.height, boxes.height + CAPTION_BELOW);
	assert.deepEqual(boxes, { x: -NODE_RADIUS, y: -NODE_RADIUS, width: 100 + 2 * NODE_RADIUS, height: 80 + 2 * NODE_RADIUS });
});

test('no nodes: no bounds; a relationship with an end that is not placed is skipped, as the edge layer skips it', () => {
	assert.equal(contentBounds(new Map(), []), null);
	assert.equal(nodeBoxBounds(new Map()), null);
	const c = centers({ a: [0, 0] });
	const edges = edgesOf([{ id: 'e', source: 'a', target: 'ghost' }]);
	assert.deepEqual(contentBounds(c, edges), contentBounds(c, []));
});

test('a single node with several loops: the bounds grow with each loop\'s reach and stay finite', () => {
	const c = centers({ a: [0, 0] });
	const reach = (n: number): number => {
		const edges = edgesOf(Array.from({ length: n }, (_, i) => ({ id: `l${i}`, source: 'a', target: 'a' })));
		const b = contentBounds(c, edges)!;
		assert.ok(Number.isFinite(b.x) && Number.isFinite(b.width) && b.width > 0 && b.height > 0);
		return Math.max(-b.x, -b.y, b.x + b.width, b.y + b.height);
	};
	assert.ok(reach(1) > NODE_RADIUS + LOOP_REACH);
	assert.ok(reach(3) > reach(1));
	assert.ok(reach(5) >= reach(3));
});

test('pairsIn reads path data and polygon points', () => {
	assert.deepEqual(pairsIn('M1.5 2Q-3 4.25 5e1 6'), [{ x: 1.5, y: 2 }, { x: -3, y: 4.25 }, { x: 50, y: 6 }]);
	assert.deepEqual(pairsIn('1,2 3,4 5,6'), [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
	assert.deepEqual(pairsIn(''), []);
});

test('wiring: the automatic fit, the ResizeObserver refit and the fit button all go through contentBounds, with the same zoom cap, padding and motion rules', () => {
	const canvas = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'canvas', 'GraphCanvas.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	assert.match(canvas, /contentBounds\(layoutPositions\.current, edgesRef\.current\)/);
	assert.match(canvas, /getViewportForBounds\(bounds, el\.clientWidth, el\.clientHeight, FLOW_MIN_ZOOM, FIT_MAX_ZOOM, FIT_PADDING\)/);
	assert.doesNotMatch(canvas, /\.fitView\(/, 'React Flow\'s node-box fit is no longer used');
	assert.match(canvas, /const duration = reducedRef\.current \|\| document\.hidden \? 0 : 300/, 'reduced motion and hidden tabs still skip the animation');
	assert.match(canvas, /if \(!userMoved\.current\) pendingFit\.current = true;\s*tryFit\(\);/, 'the ResizeObserver still refits until the user takes the view over');
	assert.match(canvas, /showFitView=\{false\}/);
	assert.match(canvas, /onClick=\{refit\}/);
});
