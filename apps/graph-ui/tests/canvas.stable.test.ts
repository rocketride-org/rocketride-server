// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CANVAS PERFORMANCE RULES: stable identities, label levels, cheap drops
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CANVAS_RULES } from '../src/canvas/environment';
import { LABELS_ALWAYS_FROM_ZOOM, LABELS_MAX_EDGES, LABELS_NEVER_BELOW_ZOOM, edgeLabelsVisible, labelsVisibleAt, sameShallow, stabilise, zoomLevel } from '../src/canvas/stable';

interface IItem {
	id: string;
	x: number;
	data: { selected: boolean; caption: string };
}
const same = (a: IItem, b: IItem): boolean => a.x === b.x && sameShallow(a.data, b.data);
const item = (id: string, x = 0, selected = false): IItem => ({ id, x, data: { selected, caption: id } });

test('stabilise hands back the previous object for everything that did not change, and a new one only for what did', () => {
	const cache = new Map<string, IItem>();
	const first = stabilise(cache, [item('a'), item('b'), item('c')], same);
	const second = stabilise(cache, [item('a'), item('b', 0, true), item('c')], same);
	assert.equal(second[0], first[0], 'a is the very same object');
	assert.notEqual(second[1], first[1], 'b changed (selected), so it is a new object');
	assert.equal(second[1].data.selected, true);
	assert.equal(second[2], first[2]);
	const third = stabilise(cache, [item('a'), item('b', 0, true), item('c')], same);
	assert.deepEqual(third.map((x, i) => x === second[i]), [true, true, true], 'a rebuild with nothing changed reuses everything');
});

test('a moved item is a new object; an item that left the list leaves the cache; a new item is added', () => {
	const cache = new Map<string, IItem>();
	const first = stabilise(cache, [item('a'), item('b')], same);
	const second = stabilise(cache, [item('a', 5), item('c')], same);
	assert.notEqual(second[0], first[0]);
	assert.equal(second[0].x, 5);
	assert.deepEqual([...cache.keys()].sort(), ['a', 'c']);
});

test('the order of the list is the order given, whatever was cached', () => {
	const cache = new Map<string, IItem>();
	stabilise(cache, [item('a'), item('b'), item('c')], same);
	assert.deepEqual(stabilise(cache, [item('c'), item('a')], same).map((x) => x.id), ['c', 'a']);
});

test('sameShallow compares values one level deep by identity of value', () => {
	assert.equal(sameShallow({ a: 1, b: 'x' }, { a: 1, b: 'x' }), true);
	assert.equal(sameShallow({ a: 1 }, { a: 2 }), false);
	assert.equal(sameShallow({ a: 1 }, { a: 1, b: 2 }), false);
	assert.equal(sameShallow({ a: NaN }, { a: NaN }), true, 'Object.is: NaN equals NaN');
});

test('relationship labels: drawn at normal size or larger; between the thresholds only for a small graph; never when zoomed far out', () => {
	assert.equal(edgeLabelsVisible(LABELS_ALWAYS_FROM_ZOOM, 5000), true, 'zoomed in to normal size, however many edges');
	assert.equal(edgeLabelsVisible(2.5, 5000), true);
	assert.equal(edgeLabelsVisible(0.8, LABELS_MAX_EDGES), true, 'a small graph, a readable zoom');
	assert.equal(edgeLabelsVisible(0.8, LABELS_MAX_EDGES + 1), false, 'a crowded graph, zoomed out');
	assert.equal(edgeLabelsVisible(LABELS_NEVER_BELOW_ZOOM - 0.01, 3), false, 'too small to read');
	assert.equal(edgeLabelsVisible(LABELS_NEVER_BELOW_ZOOM, 3), true);
});

test('the zoom is read as three levels, and the decision from a level matches the decision from the zoom', () => {
	assert.deepEqual([0.1, 0.59, 0.6, 0.99, 1, 2.5].map(zoomLevel), [0, 0, 1, 1, 2, 2]);
	for (const zoom of [0.1, 0.3, 0.59, 0.6, 0.75, 0.99, 1, 1.4, 2.5]) for (const edges of [0, 50, 200, 201, 2000]) assert.equal(labelsVisibleAt(zoomLevel(zoom), edges), edgeLabelsVisible(zoom, edges), `zoom ${zoom} edges ${edges}`);
});

test('the canvas stylesheet hides labels when the container says off, takes the edge layer out of hit-testing and puts it behind the nodes', () => {
	assert.match(CANVAS_RULES, /\.graph-ui-canvas\[data-edge-labels="off"\] \.graph-ui-edge-label \{ display: none; \}/);
	assert.match(CANVAS_RULES, /\.graph-ui-canvas \.graph-ui-edge-layer, \.graph-ui-canvas \.graph-ui-edge-layer \* \{ pointer-events: none; \}/);
	assert.match(CANVAS_RULES, /\.graph-ui-canvas \.react-flow__viewport-portal \{ z-index: -1; \}/);
});

test('wiring: React Flow draws no edges of its own (the single-svg layer does), and the layer reads only the node centres, never the viewport', () => {
	const canvas = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'canvas', 'GraphCanvas.tsx'), 'utf8');
	assert.match(canvas, /edges=\{NO_EDGES\}/);
	assert.match(canvas, /<EdgeLayer edges=\{edges\} centers=\{centers\} \/>/);
	const layer = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'canvas', 'EdgeLayer.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	assert.doesNotMatch(layer, /useStore|useViewport|useInternalNode|useReactFlow/, 'the layer subscribes to nothing in React Flow');
	assert.match(layer, /role="img" aria-label=\{ariaLabel\}/, 'each relationship keeps its accessible name');
	assert.match(layer, /<title>\{type\}<\/title>/, 'and its tooltip');
});

test('wiring: a drop updates the published positions in place instead of publishing a new map (which rebuilt every node and edge)', () => {
	const hook = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'canvas', 'useGraphLayout.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const pin = hook.slice(hook.indexOf('const pin = useCallback'), hook.indexOf('return useMemo'));
	assert.doesNotMatch(pin, /setPositions/, 'pin must not publish a new map');
	assert.match(pin, /published\.current as Map<GraphId, Point>\)\.set\(id, at\)/);
});

test('wiring: the canvas builds its node and edge lists through stabilise, and reads the zoom only as a level', () => {
	const canvas = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'canvas', 'GraphCanvas.tsx'), 'utf8');
	assert.match(canvas, /stabilise\(nodeCache\.current, list/);
	assert.match(canvas, /stabilise\(edgeCache\.current, list/);
	assert.match(canvas, /useStore\(\(state\) => zoomLevel\(state\.transform\[2\]\)\)/);
	assert.doesNotMatch(canvas, /useViewport|state\.transform\[(0|1)\]/, 'nothing subscribes to the pan offset');
});
