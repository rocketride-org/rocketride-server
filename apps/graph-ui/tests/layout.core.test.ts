// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LAYOUT CORE (the force simulation the worker runs) AND GRID FALLBACK
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayoutJob, runLayout, seededRandom } from '../src/layout/layout.core';
import { GRID_SPACING, gridLayout, ringAround } from '../src/layout/gridFallback';
import type { ILayoutRequest } from '../src/layout/protocol';
import { deepFreeze, generateGraph } from './support/builders';
import { TIMING_SAMPLES, bestOfMs } from './support/timing';

const base = (nodes: ILayoutRequest['nodes'], links: ILayoutRequest['links'], extra: Partial<ILayoutRequest> = {}): ILayoutRequest => ({
	type: 'layout',
	requestId: 1,
	nodes,
	links,
	seed: 1,
	ticks: 300,
	deadlineMs: 60_000,
	radius: 28,
	...extra,
});
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `n${i}`);
const ring = (n: number): ILayoutRequest => base(ids(n).map((id) => ({ id })), ids(n).map((id, i) => ({ source: id, target: `n${(i + 1) % n}` })));
const byId = (positions: Array<{ id: string; x: number; y: number }>): Map<string, { x: number; y: number }> => new Map(positions.map((p) => [p.id, p]));

test('the same request and seed give exactly the same layout', () => {
	const a = runLayout(ring(40));
	const b = runLayout(ring(40));
	assert.deepEqual(a.positions, b.positions);
	assert.equal(a.ticks, 300);
	assert.equal(a.timedOut, false);
	const c = runLayout({ ...ring(40), seed: 99 });
	assert.equal(c.positions.length, 40);
});

test('the request is never mutated: d3 works on copies', () => {
	const request = deepFreeze(ring(30));
	const result = runLayout(request); // d3 would throw in strict mode if it wrote x/y/vx/vy onto the frozen request
	assert.equal(result.positions.length, 30);
	assert.ok(!('x' in request.nodes[0]), 'the request objects gained no coordinates');
});

test('every position is finite and nodes keep their ids in the order given', () => {
	const request = base(ids(80).map((id) => ({ id })), []);
	const result = runLayout(request);
	assert.deepEqual(result.positions.map((p) => p.id), ids(80));
	for (const p of result.positions) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('pinned nodes stay exactly where they were put; unpinned nodes with a start position move', () => {
	const request = base(
		[
			{ id: 'a', x: 500, y: -300, pinned: true },
			{ id: 'b', x: 520, y: -300 },
			{ id: 'c' },
		],
		[{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]
	);
	const positions = byId(runLayout(request).positions);
	assert.deepEqual(positions.get('a'), { id: 'a', x: 500, y: -300 });
	assert.notDeepEqual(positions.get('b'), { id: 'b', x: 520, y: -300 });
});

test('new nodes placed near an expanded node end up near it, and old ones are unchanged', () => {
	const old = Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, x: (i % 5) * 120, y: Math.floor(i / 5) * 120, pinned: true }));
	const fresh = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, x: 60 + i, y: 60 + i }));
	const request = base([...old, ...fresh], fresh.map((f) => ({ source: 'o6', target: f.id })));
	const out = byId(runLayout(request).positions);
	for (const o of old) assert.deepEqual(out.get(o.id), { id: o.id, x: o.x, y: o.y }, 'pinned nodes did not move');
	const center = out.get('o6') as { x: number; y: number };
	for (const f of fresh) {
		const p = out.get(f.id) as { x: number; y: number };
		assert.ok(Math.hypot(p.x - center.x, p.y - center.y) < 600, `${f.id} stayed in the neighbourhood of o6`);
	}
});

test('nodes do not overlap on a sparse graph', () => {
	const result = runLayout(ring(60));
	let min = Infinity;
	for (let i = 0; i < result.positions.length; i++) {
		for (let j = i + 1; j < result.positions.length; j++) min = Math.min(min, Math.hypot(result.positions[i].x - result.positions[j].x, result.positions[i].y - result.positions[j].y));
	}
	assert.ok(min >= 28, `closest pair is ${min.toFixed(1)} apart (a node radius is 28)`);
});

test('links to unknown ids are dropped, duplicate ids keep the first, parallel and self links are fine', () => {
	const request = base([{ id: 'a' }, { id: 'b' }, { id: 'a', x: 99, y: 99, pinned: true }], [
		{ source: 'a', target: 'ghost' },
		{ source: 'ghost', target: 'b' },
		{ source: 'a', target: 'b' },
		{ source: 'a', target: 'b' },
		{ source: 'b', target: 'a' },
		{ source: 'a', target: 'a' },
	]);
	const result = runLayout(request);
	assert.deepEqual(result.positions.map((p) => p.id), ['a', 'b']);
	for (const p of result.positions) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('an empty request and a zero-tick request answer immediately', () => {
	assert.deepEqual(runLayout(base([], [])).positions, []);
	const zero = runLayout(base([{ id: 'a' }], [], { ticks: 0 }));
	assert.equal(zero.ticks, 0);
	assert.equal(zero.positions.length, 1);
	assert.ok(Number.isFinite(zero.positions[0].x));
});

test('the deadline stops the simulation early and the positions so far are still usable', () => {
	let now = 0;
	const clock = { now: () => (now += 10) }; // every check costs 10 ms
	const result = runLayout({ ...ring(50), deadlineMs: 35 }, clock);
	assert.equal(result.timedOut, true);
	assert.ok(result.ticks < 300, `ran ${result.ticks} ticks`);
	assert.equal(result.positions.length, 50);
	for (const p of result.positions) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('a job is driven in steps and never runs past the requested ticks', () => {
	const job = createLayoutJob({ ...ring(10), ticks: 60 });
	assert.equal(job.done, false);
	job.step(25);
	assert.equal(job.ticks, 25);
	job.step(25);
	job.step(25);
	assert.equal(job.ticks, 60);
	assert.equal(job.done, true);
	job.step(25);
	assert.equal(job.ticks, 60);
	job.step(-5);
	job.step(NaN as unknown as number);
	assert.equal(job.ticks, 60);
});

test('a full-size graph (1,000 nodes, 2,000 relationships) completes and stays finite', () => {
	const { nodes, relationships } = generateGraph({ nodes: 1000, relationships: 2000, seed: 21, parallel: 0.1, selfLoops: 0.02 });
	const request = base(nodes.map((n) => ({ id: n.id })), relationships.map((r) => ({ source: r.start, target: r.end })));
	// The bound is on the best of three timed runs after a warm-up (tests/support/timing.ts).
	const { ms: elapsed, result } = bestOfMs(() => runLayout(request));
	assert.equal(result.positions.length, 1000);
	assert.equal(result.timedOut, false);
	for (const p of result.positions) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
	assert.ok(elapsed < 20_000, `best of ${TIMING_SAMPLES} took ${elapsed.toFixed(1)} ms`);
});

test('the seeded random source is deterministic and uniform enough to use', () => {
	const a = seededRandom(5);
	const b = seededRandom(5);
	const seq = Array.from({ length: 50 }, () => a());
	assert.deepEqual(seq, Array.from({ length: 50 }, () => b()));
	assert.ok(seq.every((v) => v >= 0 && v < 1));
	assert.notDeepEqual(seq, Array.from({ length: 50 }, ((c) => () => c())(seededRandom(6))));
});

test('grid fallback: deterministic, keeps given positions, never reuses a taken cell', () => {
	const grid = gridLayout(['a', 'b', 'c', 'd', 'e']);
	assert.equal(grid.size, 5);
	assert.deepEqual(gridLayout(['a', 'b', 'c', 'd', 'e']), grid);
	const cells = new Set([...grid.values()].map((p) => `${p.x},${p.y}`));
	assert.equal(cells.size, 5);
	const kept = gridLayout(['a', 'b', 'c'], new Map([['b', { x: 0, y: 0 }]]));
	assert.deepEqual(kept.get('b'), { x: 0, y: 0 });
	assert.notDeepEqual(kept.get('a'), kept.get('b'));
	assert.notDeepEqual(kept.get('c'), kept.get('b'));
	assert.ok(new Set([...kept.values()].map((p) => `${Math.round(p.x / GRID_SPACING)},${Math.round(p.y / GRID_SPACING)}`)).size === 3);
	// A non-finite kept position is ignored rather than trusted.
	assert.ok(Number.isFinite(gridLayout(['a'], new Map([['a', { x: NaN, y: 1 }]])).get('a')?.x));
	assert.equal(gridLayout([]).size, 0);
});

test('ring placement puts new nodes around the centre, spread, deterministically', () => {
	const placed = ringAround({ x: 1000, y: 1000 }, ids(20));
	assert.equal(placed.size, 20);
	assert.deepEqual(ringAround({ x: 1000, y: 1000 }, ids(20)), placed);
	for (const p of placed.values()) assert.ok(Math.hypot(p.x - 1000, p.y - 1000) >= 109);
	assert.equal(new Set([...placed.values()].map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)).size, 20, 'no two share a spot');
	assert.equal(ringAround({ x: 0, y: 0 }, []).size, 0);
});
