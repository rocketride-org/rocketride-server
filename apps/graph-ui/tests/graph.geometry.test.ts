// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EDGE GEOMETRY (boundary anchors, parallel curves, self-loops, arrows)
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARROW_LENGTH, LOOP_REACH, NODE_RADIUS, PARALLEL_SPACING, anchorOnCircle, edgeShape, edgeSlots, layoutEdges } from '../src/graph/geometry';
import type { IEdgeShape, IEdgeSpec, Point } from '../src/graph/geometry';
import { prng } from './support/builders';

const R = NODE_RADIUS;
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const near = (actual: number, expected: number, eps = 1e-6, message?: string): void => assert.ok(Math.abs(actual - expected) <= eps, message ?? `${actual} is not within ${eps} of ${expected}`);
const numbers = (text: string): number[] => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const polygon = (text: string): Point[] => text.split(' ').map((pair) => ({ x: Number(pair.split(',')[0]), y: Number(pair.split(',')[1]) }));

/** The last point of the line (the arrow's base). */
function lineEnd(shape: IEdgeShape): Point {
	const n = numbers(shape.path);
	return { x: n[n.length - 2], y: n[n.length - 1] };
}

const A: Point = { x: 0, y: 0 };
const B: Point = { x: 200, y: 0 };

test('an anchor sits exactly on the circle in the direction of the target', () => {
	const p = anchorOnCircle({ x: 10, y: 20 }, R, { x: 10, y: 120 });
	near(p.x, 10);
	near(p.y, 20 + R);
	for (const target of [{ x: 100, y: 50 }, { x: -3, y: -77 }, { x: 10.0000001, y: 20 }]) {
		const q = anchorOnCircle(A, R, target);
		near(dist(A, q), R);
		// Collinear with the centre and the target.
		near(q.x * target.y - q.y * target.x, 0, 1e-6);
	}
});

test('an anchor aimed at the centre itself is still finite and on the circle', () => {
	const p = anchorOnCircle(A, R, A);
	assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
	near(dist(A, p), R);
});

test('a single relationship is a straight line from boundary to boundary with the arrow on the end circle', () => {
	const [slot] = [...edgeSlots([{ id: 'r', source: 'a', target: 'b' }]).values()];
	const shape = edgeShape(A, B, slot);
	assert.deepEqual(shape.from, { x: R, y: 0 });
	assert.deepEqual(shape.tip, { x: 200 - R, y: 0 });
	assert.equal(shape.path, `M${R} 0L${200 - R - ARROW_LENGTH} 0`);
	near(lineEnd(shape).x, 200 - R - ARROW_LENGTH);
	assert.deepEqual(shape.label, { x: 100, y: 0 });
	assert.equal(shape.labelAngle, 0);
	assert.equal(shape.loop, false);
});

test('the arrow is a triangle whose tip is the contact point and whose axis is the travel direction', () => {
	const [slot] = [...edgeSlots([{ id: 'r', source: 'a', target: 'b' }]).values()];
	const shape = edgeShape(A, B, slot);
	const [tip, left, right] = polygon(shape.arrow);
	assert.deepEqual(tip, shape.tip);
	near(dist(left, right), 10, 1e-6, 'base width is 2 x the half width');
	const baseMid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
	near(dist(baseMid, tip), ARROW_LENGTH);
	near(baseMid.y, 0);
	assert.ok(baseMid.x < tip.x, 'the head points forward, at the end node');
	// The line stops where the arrow's base starts, so the stroke never pokes through the head.
	near(dist(lineEnd(shape), baseMid), 0);
});

test('direction is the stored one: reversing start and end moves the arrow to the other circle', () => {
	const slot = edgeSlots([{ id: 'r', source: 'b', target: 'a' }]).get('r');
	assert.ok(slot);
	const shape = edgeShape(B, A, slot);
	assert.deepEqual(shape.tip, { x: R, y: 0 }, 'the arrow touches node a, the stored end');
	assert.deepEqual(shape.from, { x: 200 - R, y: 0 });
	assert.equal(shape.labelAngle, 0, 'a label on a right-to-left edge is rotated back upright');
});

test('slots are independent of input order and group relationships of one node pair in either direction', () => {
	const edges: IEdgeSpec[] = [
		{ id: 'p3', source: 'a', target: 'b' },
		{ id: 'p1', source: 'a', target: 'b' },
		{ id: 'rev', source: 'b', target: 'a' },
		{ id: 'p2', source: 'a', target: 'b' },
		{ id: 'other', source: 'a', target: 'c' },
		{ id: 'l1', source: 'a', target: 'a' },
		{ id: 'l2', source: 'a', target: 'a' },
	];
	const slots = edgeSlots(edges);
	const shuffled = edgeSlots([...edges].reverse());
	for (const edge of edges) assert.deepEqual(shuffled.get(edge.id), slots.get(edge.id), edge.id);
	assert.deepEqual(['p1', 'p2', 'p3', 'rev'].map((id) => slots.get(id)?.index), [0, 1, 2, 3]);
	assert.ok(['p1', 'p2', 'p3', 'rev'].every((id) => slots.get(id)?.count === 4));
	assert.equal(slots.get('rev')?.reversed, true);
	assert.equal(slots.get('p1')?.reversed, false);
	assert.deepEqual(slots.get('other'), { index: 0, count: 1, reversed: false, loop: false });
	assert.deepEqual(['l1', 'l2'].map((id) => slots.get(id)), [{ index: 0, count: 2, reversed: false, loop: true }, { index: 1, count: 2, reversed: false, loop: true }]);
});

test('three parallel relationships fan out symmetrically around the straight line', () => {
	const edges: IEdgeSpec[] = [1, 2, 3].map((n) => ({ id: `p${n}`, source: 'a', target: 'b' }));
	const shapes = layoutEdges(edges, new Map([['a', A], ['b', B]]));
	const labels = ['p1', 'p2', 'p3'].map((id) => (shapes.get(id) as IEdgeShape).label);
	near(labels[1].y, 0, 1e-9, 'the middle one is straight');
	near(labels[0].y, -labels[2].y, 1e-6, 'symmetric');
	assert.ok(Math.abs(labels[0].y) > PARALLEL_SPACING * 0.5, 'visibly apart');
	assert.ok(labels.every((l) => Math.abs(l.x - 100) < 1e-6), 'centred between the nodes');
	assert.equal(new Set(labels.map((l) => l.y.toFixed(3))).size, 3, 'no two share a label point');
	// The straight one has no curve command; the other two do.
	assert.ok(!(shapes.get('p2') as IEdgeShape).path.includes('Q'));
	assert.ok((shapes.get('p1') as IEdgeShape).path.includes('Q'));
});

test('a relationship and its reverse land on opposite sides of the line', () => {
	const edges: IEdgeSpec[] = [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }];
	const shapes = layoutEdges(edges, new Map([['a', A], ['b', B]]));
	const one = shapes.get('e1') as IEdgeShape;
	const two = shapes.get('e2') as IEdgeShape;
	assert.ok(one.label.y * two.label.y < 0, 'opposite sides');
	// e1 ends on b, e2 ends on a.
	near(dist(one.tip, B), R);
	near(dist(two.tip, A), R);
	assert.ok(dist(one.label, two.label) > PARALLEL_SPACING * 0.9, 'the two labels do not collide');
});

test('every anchor and every arrow tip is on its circle, for any slot and any positions', () => {
	const random = prng(42);
	for (let trial = 0; trial < 300; trial++) {
		const a = { x: random() * 800 - 400, y: random() * 800 - 400 };
		const b = { x: random() * 800 - 400, y: random() * 800 - 400 };
		const count = 1 + Math.floor(random() * 5);
		const edges: IEdgeSpec[] = Array.from({ length: count }, (_, i) => (random() < 0.5 ? { id: `e${i}`, source: 'a', target: 'b' } : { id: `e${i}`, source: 'b', target: 'a' }));
		const slots = edgeSlots(edges);
		for (const edge of edges) {
			const slot = slots.get(edge.id);
			assert.ok(slot);
			const src = edge.source === 'a' ? a : b;
			const tgt = edge.target === 'a' ? a : b;
			const shape = edgeShape(src, tgt, slot);
			near(dist(shape.from, src), R, 1e-6, `trial ${trial}: line leaves the start circle`);
			near(dist(shape.tip, tgt), R, 1e-6, `trial ${trial}: arrow lands on the end circle`);
			near(dist(lineEnd(shape), shape.tip), ARROW_LENGTH, 1e-1, `trial ${trial}: the line stops one arrow length short`);
		}
	}
});

test('node radii are honoured per end', () => {
	const slot = [...edgeSlots([{ id: 'r', source: 'a', target: 'b' }]).values()][0];
	const shape = edgeShape(A, B, slot, 10, 40);
	near(dist(shape.from, A), 10);
	near(dist(shape.tip, B), 40);
});

test('self-relationships are loops on the circle, each in its own place and reaching further out', () => {
	const edges: IEdgeSpec[] = ['l1', 'l2', 'l3', 'l4'].map((id) => ({ id, source: 'a', target: 'a' }));
	const slots = edgeSlots(edges);
	const center = { x: 50, y: -20 };
	const shapes = edges.map((edge) => edgeShape(center, center, slots.get(edge.id) as never));
	for (const shape of shapes) {
		assert.equal(shape.loop, true);
		near(dist(shape.from, center), R);
		near(dist(shape.tip, center), R);
		assert.ok(dist(shape.label, center) > R + LOOP_REACH * 0.5, 'the label sits outside the node');
		assert.ok(dist(shape.from, shape.tip) > 5, 'the loop leaves and re-enters at different points');
		assert.match(shape.path, /^M[^C]+C/);
	}
	assert.equal(new Set(shapes.map((s) => `${s.label.x.toFixed(1)},${s.label.y.toFixed(1)}`)).size, 4, 'no two loops share an apex');
	for (let i = 1; i < shapes.length; i++) assert.ok(dist(shapes[i].label, center) > dist(shapes[i - 1].label, center), `loop ${i} reaches further out than loop ${i - 1}`);
	// The first loop leaves from the top of the node.
	assert.ok(shapes[0].label.y < center.y - R);
});

test('overlapping or coincident nodes never produce a non-finite coordinate', () => {
	const slot = [...edgeSlots([{ id: 'r', source: 'a', target: 'b' }]).values()][0];
	for (const [src, tgt] of [[A, A], [A, { x: 1e-12, y: 0 }], [A, { x: 5, y: 5 }], [{ x: 1e9, y: -1e9 }, { x: 1e9 + 1, y: -1e9 }]] as Array<[Point, Point]>) {
		const shape = edgeShape(src, tgt, slot);
		for (const text of [shape.path, shape.arrow]) assert.ok(!/NaN|Infinity/.test(text), text);
		for (const v of [shape.tip.x, shape.tip.y, shape.from.x, shape.from.y, shape.label.x, shape.label.y, shape.labelAngle]) assert.ok(Number.isFinite(v));
	}
});

test('labels are always kept upright', () => {
	const random = prng(9);
	for (let i = 0; i < 200; i++) {
		const slot = [...edgeSlots([{ id: 'r', source: 'a', target: 'b' }]).values()][0];
		const shape = edgeShape({ x: random() * 100, y: random() * 100 }, { x: random() * 100 - 50, y: random() * 100 - 50 }, slot);
		assert.ok(shape.labelAngle >= -90 - 1e-9 && shape.labelAngle <= 90 + 1e-9, String(shape.labelAngle));
	}
});

test('layoutEdges skips relationships whose end has no position and returns the rest', () => {
	const shapes = layoutEdges([{ id: 'ok', source: 'a', target: 'b' }, { id: 'missing', source: 'a', target: 'zzz' }], new Map([['a', A], ['b', B]]));
	assert.deepEqual([...shapes.keys()], ['ok']);
	const perNode = layoutEdges([{ id: 'ok', source: 'a', target: 'b' }], new Map([['a', A], ['b', B]]), (id) => (id === 'a' ? 10 : 40));
	near(dist((perNode.get('ok') as IEdgeShape).tip, B), 40);
});

test('a dense random graph with parallel and self relationships yields finite shapes for every relationship', () => {
	const random = prng(5);
	const positions = new Map<string, Point>();
	for (let i = 0; i < 100; i++) positions.set(`n${i}`, { x: random() * 2000, y: random() * 2000 });
	const edges: IEdgeSpec[] = [];
	for (let i = 0; i < 400; i++) {
		const roll = random();
		const source = `n${Math.floor(random() * 100)}`;
		const target = roll < 0.05 ? source : roll < 0.3 && edges.length > 0 ? edges[Math.floor(random() * edges.length)].target : `n${Math.floor(random() * 100)}`;
		edges.push({ id: `e${i}`, source, target });
	}
	const shapes = layoutEdges(edges, positions);
	assert.equal(shapes.size, edges.length);
	for (const shape of shapes.values()) assert.ok(!/NaN|Infinity/.test(shape.path + shape.arrow));
});
