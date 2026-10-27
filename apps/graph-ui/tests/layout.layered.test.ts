// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LAYERED LAYOUTS (tree and left to right) AND THE PATH ROW
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layeredLayout, pathGap, pathRow } from '../src/layout/layered';
import type { ILayeredInput } from '../src/layout/layered';
import type { Point } from '../src/graph/geometry';
import { NODE_RADIUS } from '../src/graph/geometry';
import { deepFreeze, generateGraph } from './support/builders';

const DIAMETER = NODE_RADIUS * 2;
const links = (...pairs: Array<[string, string]>): ILayeredInput['links'] => pairs.map(([source, target]) => ({ source, target }));
const chain = ['a', 'b', 'c', 'd'];
const chainLinks = links(['a', 'b'], ['b', 'c'], ['c', 'd']);

/** The closest distance between two placed nodes. */
function closest(positions: ReadonlyMap<string, Point>): number {
	const all = [...positions.values()];
	let best = Infinity;
	for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) best = Math.min(best, Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y));
	return best;
}

test('a 4-node chain rooted at one end reads left to right in columns, and top down in levels', () => {
	const lr = layeredLayout({ ids: chain, links: chainLinks, orientation: 'left-right', root: 'a' });
	const tree = layeredLayout({ ids: chain, links: chainLinks, orientation: 'tree', root: 'a' });
	for (let i = 1; i < chain.length; i++) {
		assert.ok((lr.get(chain[i]) as Point).x > (lr.get(chain[i - 1]) as Point).x, `left to right: ${chain[i]} is right of ${chain[i - 1]}`);
		assert.ok((tree.get(chain[i]) as Point).y > (tree.get(chain[i - 1]) as Point).y, `tree: ${chain[i]} is below ${chain[i - 1]}`);
	}
	// One child per level: a straight line.
	assert.equal(new Set([...lr.values()].map((p) => p.y)).size, 1);
	assert.equal(new Set([...tree.values()].map((p) => p.x)).size, 1);
});

test('the same input gives the same output, whatever order the relationships come in', () => {
	const { nodes, relationships } = generateGraph({ nodes: 60, relationships: 90, seed: 7 });
	const ids = nodes.map((n) => n.id);
	const forward = relationships.map((r) => ({ source: r.start, target: r.end }));
	const input = deepFreeze({ ids, links: forward, orientation: 'tree' as const, root: null });
	const a = layeredLayout(input);
	const b = layeredLayout(input);
	assert.deepEqual([...a], [...b]);
	const c = layeredLayout({ ...input, links: [...forward].reverse() });
	assert.deepEqual(new Map(a), new Map(c), 'neighbours are visited in id order, not in the order given');
});

test('without a root the highest-degree node is the root; with one, the root is at the first level', () => {
	const ids = ['leaf1', 'hub', 'leaf2', 'leaf3', 'x'];
	const star = links(['hub', 'leaf1'], ['hub', 'leaf2'], ['hub', 'leaf3'], ['leaf3', 'x']);
	const auto = layeredLayout({ ids, links: star, orientation: 'tree' });
	assert.ok(['leaf1', 'leaf2', 'leaf3', 'x'].every((id) => (auto.get(id) as Point).y > (auto.get('hub') as Point).y), 'the hub is above everything');
	const rooted = layeredLayout({ ids, links: star, orientation: 'tree', root: 'x' });
	assert.ok(ids.filter((id) => id !== 'x').every((id) => (rooted.get(id) as Point).y > (rooted.get('x') as Point).y), 'the chosen root is above everything');
	const unknown = layeredLayout({ ids, links: star, orientation: 'tree', root: 'not-drawn' });
	assert.deepEqual(new Map(unknown), new Map(auto), 'a root that is not drawn is ignored');
});

test('a parent sits centred over its children, and siblings never overlap', () => {
	const ids = ['r', 'a', 'b', 'c', 'a1', 'a2', 'c1'];
	const tree = layeredLayout({ ids, links: links(['r', 'a'], ['r', 'b'], ['r', 'c'], ['a', 'a1'], ['a', 'a2'], ['c', 'c1']), orientation: 'tree', root: 'r' });
	const x = (id: string): number => (tree.get(id) as Point).x;
	assert.equal(x('a'), (x('a1') + x('a2')) / 2);
	assert.equal(x('r'), (x('a') + x('c')) / 2);
	assert.ok(x('a') < x('b') && x('b') < x('c'), 'children in id order');
	assert.ok(closest(tree) >= DIAMETER);
});

test('every component is laid out, side by side; lone nodes go on a compact grid beside the trees', () => {
	const ids = ['a', 'b', 'c', 'd', ...Array.from({ length: 16 }, (_, i) => `lone${String(i).padStart(2, '0')}`)];
	const out = layeredLayout({ ids, links: links(['a', 'b'], ['c', 'd']), orientation: 'tree' });
	assert.equal(out.size, ids.length);
	assert.ok(closest(out) >= DIAMETER);
	const lone = ids.filter((id) => id.startsWith('lone')).map((id) => out.get(id) as Point);
	assert.equal(new Set(lone.map((p) => p.x)).size, 4, '16 lone nodes make a 4 x 4 block, not a row of 16');
	const trees = ['a', 'b', 'c', 'd'].map((id) => out.get(id) as Point);
	assert.ok(Math.min(...lone.map((p) => p.x)) > Math.max(...trees.map((p) => p.x)), 'the block is beside the trees');
});

test('cycles, self relationships, parallel relationships and links to unknown ids are all fine', () => {
	const out = layeredLayout({ ids: ['a', 'b', 'c'], links: links(['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'a'], ['a', 'b'], ['a', 'ghost']), orientation: 'left-right' });
	assert.equal(out.size, 3);
	assert.ok(!out.has('ghost'));
	for (const p of out.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
	assert.ok(closest(out) >= DIAMETER);
	assert.equal(layeredLayout({ ids: [], links: [], orientation: 'tree' }).size, 0);
	assert.equal(layeredLayout({ ids: ['a', 'a'], links: [], orientation: 'tree' }).size, 1, 'a duplicate id is placed once');
});

test('bigger nodes get more room', () => {
	const small = layeredLayout({ ids: chain, links: chainLinks, orientation: 'tree', root: 'a' });
	const big = layeredLayout({ ids: chain, links: chainLinks, orientation: 'tree', root: 'a', diameter: 90 });
	assert.ok(closest(big) > closest(small));
	assert.ok(closest(big) >= 90);
});

test('a full-size graph (1,000 nodes, 2,000 relationships) is laid out in well under 50 ms, with no two nodes overlapping', () => {
	const { nodes, relationships } = generateGraph({ nodes: 1000, relationships: 2000, seed: 21, parallel: 0.1, selfLoops: 0.02 });
	const input: ILayeredInput = { ids: nodes.map((n) => n.id), links: relationships.map((r) => ({ source: r.start, target: r.end })), orientation: 'tree' };
	layeredLayout(input); // warm up the JIT
	const started = performance.now();
	const out = layeredLayout(input);
	const elapsed = performance.now() - started;
	assert.ok(elapsed < 50, `took ${elapsed.toFixed(1)} ms`);
	assert.equal(out.size, 1000);
	// Overlap check on a grid of cells, not all pairs: two nodes closer than a diameter share or touch a cell.
	const cells = new Map<string, Point[]>();
	for (const p of out.values()) {
		assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
		const key = `${Math.floor(p.x / DIAMETER)},${Math.floor(p.y / DIAMETER)}`;
		cells.set(key, [...(cells.get(key) ?? []), p]);
	}
	for (const [key, here] of cells) {
		const [cx, cy] = key.split(',').map(Number);
		for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of cells.get(`${cx + dx},${cy + dy}`) ?? []) for (const p of here) if (p !== q) assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= DIAMETER, 'two nodes overlap');
	}
});

// -----------------------------------------------------------------------------
// The path row
// -----------------------------------------------------------------------------

test('a path is placed in order, left to right on one row above everything else, which keeps its place', () => {
	const others = new Map<string, Point>([['x', { x: 0, y: 0 }], ['y', { x: 400, y: 300 }]]);
	const before = new Map<string, Point>([...others, ['a', { x: 50, y: 50 }], ['m', { x: 10, y: 200 }], ['b', { x: 300, y: 10 }]]);
	const row = pathRow(['a', 'm', 'b'], before, 200);
	assert.deepEqual([...row.keys()], ['a', 'm', 'b'], 'only the path is placed');
	const [a, m, b] = ['a', 'm', 'b'].map((id) => row.get(id) as Point);
	assert.ok(a.x < m.x && m.x < b.x);
	assert.equal(m.x - a.x, 200);
	assert.equal(a.y, m.y);
	assert.equal(a.y, b.y);
	assert.ok(a.y < 0 - DIAMETER, 'the row is above the highest other node, with room for it');
	assert.equal((a.x + b.x) / 2, 200, 'centred over the rest of the drawing');
});

test('a path with nothing else drawn sits at the origin; a node twice in the order is placed once', () => {
	const row = pathRow(['a', 'b', 'a'], new Map(), 180);
	assert.equal(row.size, 2);
	assert.deepEqual(row.get('a'), { x: -90, y: 0 });
	assert.deepEqual(row.get('b'), { x: 90, y: 0 });
});

test('the path gap leaves room for the longest relationship type between two captions', () => {
	assert.ok(pathGap(['KNOWS'], DIAMETER) >= 150 + 10, 'two captions (150 px wide at most) do not touch');
	assert.ok(pathGap(['A_VERY_LONG_RELATIONSHIP_TYPE_NAME_INDEED'], DIAMETER) > pathGap(['KNOWS'], DIAMETER));
	assert.ok(pathGap([], 90) > pathGap([], DIAMETER));
});
