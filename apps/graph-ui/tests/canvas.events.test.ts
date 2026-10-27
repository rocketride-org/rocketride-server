// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CANVAS EVENTS: clickable relationships, click modes, menus, styles, layouts
// =============================================================================
//
// No React harness runs under node:test. The relationship component uses no hooks, so it is
// rendered by calling it, and its hit path's handlers are fired directly. What only a
// browser shows (React Flow's own events, the layout hook) is pinned by reading the source,
// as the other canvas suites do.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type React from 'react';
import { EdgeShapeImpl } from '../src/canvas/EdgeLayer';
import { CANVAS_RULES } from '../src/canvas/environment';
import { clickMode } from '../src/graph/keynav';

type Element = React.ReactElement<Record<string, unknown> & { children?: unknown }>;

/** Every element in a rendered tree, depth first. */
function walk(node: unknown, out: Element[] = []): Element[] {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, out);
	} else if (node && typeof node === 'object' && 'props' in node) {
		out.push(node as Element);
		walk((node as Element).props.children, out);
	}
	return out;
}

const SHAPE = { id: 'r7', ax: 0, ay: 0, bx: 200, by: 0, ar: 28, br: 38, slot: { index: 0, count: 1, reversed: false, loop: false }, type: 'KNOWS', ariaLabel: 'KNOWS from A to B', highlighted: false, selected: false, stale: false, dim: false, color: null };
const source = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('a relationship has an invisible, wide hit path: a click on it selects that relationship, a right-click asks for its menu', () => {
	const clicks: string[] = [];
	const menus: string[] = [];
	const event = { preventDefault: () => undefined } as unknown as React.MouseEvent<SVGPathElement>;
	const tree = walk(EdgeShapeImpl({ ...SHAPE, onClick: (id) => clicks.push(id), onContextMenu: (id) => menus.push(id) }));
	const hits = tree.filter((el) => el.props.className === 'graph-ui-edge-hit');
	assert.equal(hits.length, 1);
	const hit = hits[0].props as { d: string; stroke: string; strokeWidth: number; onClick(e: unknown): void; onContextMenu(e: unknown): void };
	assert.equal(hit.stroke, 'transparent');
	assert.equal(hit.strokeWidth, 12);
	const line = tree.find((el) => el.type === 'path' && el.props.className === undefined)?.props as { d: string };
	assert.equal(hit.d, line.d, 'the hit path follows the drawn curve');
	hit.onClick(event);
	hit.onContextMenu(event);
	assert.deepEqual(clicks, ['r7']);
	assert.deepEqual(menus, ['r7']);
});

test('without a click or menu handler there is no hit path: relationships stay out of hit-testing entirely', () => {
	const tree = walk(EdgeShapeImpl(SHAPE));
	assert.equal(tree.filter((el) => el.props.className === 'graph-ui-edge-hit').length, 0);
	assert.match(CANVAS_RULES, /\.graph-ui-canvas \.graph-ui-edge-layer, \.graph-ui-canvas \.graph-ui-edge-layer \* \{ pointer-events: none; \}/, 'the drawn parts take no pointer events');
	assert.match(CANVAS_RULES, /\.graph-ui-canvas \.graph-ui-edge-layer \.graph-ui-edge-hit \{ pointer-events: stroke; cursor: pointer;/, 'only the hit path does');
});

test('the selected relationship is drawn selected (a halo and data-selected), a dimmed one faint, a typed one in its colour, ends at each circle\'s own radius', () => {
	const selected = walk(EdgeShapeImpl({ ...SHAPE, selected: true }));
	assert.equal(selected[0].props['data-selected'], 'true');
	assert.equal(selected.filter((el) => el.type === 'path').length, 2, 'the halo and the line');
	assert.equal(walk(EdgeShapeImpl({ ...SHAPE, dim: true }))[0].props.opacity, 0.2);
	const typed = walk(EdgeShapeImpl({ ...SHAPE, color: '#336699' }));
	assert.equal(typed.find((el) => el.type === 'polygon')?.props.fill, '#336699');
	// The arrow tip sits on the END circle's boundary: at x = 200 - 38 for an L node.
	const arrow = String(typed.find((el) => el.type === 'polygon')?.props.points);
	assert.match(arrow, /^162,0 /);
});

test('a plain click selects only that node; Shift, Ctrl or Cmd adds or removes it', () => {
	assert.equal(clickMode({ shiftKey: false, ctrlKey: false, metaKey: false }), 'only');
	for (const key of ['shiftKey', 'ctrlKey', 'metaKey']) assert.equal(clickMode({ shiftKey: false, ctrlKey: false, metaKey: false, [key]: true }), 'toggle', key);
});

test('wiring: node clicks go through clickMode (a toggle when the view has no handler), and menus on nodes, the pane and relationships are the view\'s', () => {
	const canvas = source('canvas', 'GraphCanvas.tsx');
	const click = canvas.slice(canvas.indexOf('const onNodeClick = useCallback'), canvas.indexOf('const onNodeDoubleClick'));
	assert.match(click, /p\.onFocus\(node\.id\);/);
	assert.match(click, /if \(p\.onNodeClick\) p\.onNodeClick\(node\.id, clickMode\(event\)\);\s*else p\.onToggleSelect\(node\.id\);/);
	assert.match(canvas, /onNodeContextMenu=\{onNodeContextMenu\}/);
	assert.match(canvas, /onPaneContextMenu=\{onPaneContextMenu\}/);
	for (const handler of ['onNodeContextMenu', 'onPaneContextMenu', 'onEdgeContextMenu']) {
		const body = canvas.slice(canvas.indexOf(`const ${handler} = useCallback`), canvas.indexOf('}, [', canvas.indexOf(`const ${handler} = useCallback`)));
		assert.match(body, /if \(!p\.onContextMenu\) return;\s*event\.preventDefault\(\);/, `${handler}: the browser menu is kept unless the view draws its own`);
	}
	assert.match(canvas, /case 'context-menu':\s*openNodeMenu\(action\.id\);/, 'the Menu key and Shift+F10 open it at the node');
	assert.match(canvas, /case 'next-relationship': \{[\s\S]*?nextRelationship\(p\.model, action\.id, p\.selectedRelationshipId \?\? null\)/, 'R walks the node\'s relationships');
});

test('wiring: the handle centres, fits, re-lays out and exports; the layout follows the mode, the pin setting, the path and each node\'s size', () => {
	const canvas = source('canvas', 'GraphCanvas.tsx');
	assert.match(canvas, /useImperativeHandle\(\s*props\.handleRef,/);
	for (const member of ['centerOn(id: GraphId)', 'fit: refit', 'relayout: () => setRelayoutNonce((n) => n + 1)', 'exportImage: exportDrawing']) assert.ok(canvas.includes(member), member);
	assert.match(canvas, /useGraphLayout\(model, props\.seedKey, props\.expandHint, \{ mode: props\.layoutMode \?\? 'force', nonce: relayoutNonce, keepPinned: props\.keepPinned \?\? true, root, path: path\?\.nodes \?\? null, pathTypes, diameter: largest \}\)/);
	assert.match(canvas, /sourceRadius: \(diameters\.get\(r\.start\) \?\? NODE_DIAMETER\) \/ 2/);
	// A selected node (or relationship) is never dimmed by a path or a search: its ring shows at full strength.
	assert.match(canvas, /const dim = !selected\.has\(id\) && \(/);
	assert.match(canvas, /dim: !chosen && \(/);
	const hook = source('canvas', 'useGraphLayout.ts');
	assert.match(hook, /if \(mode !== 'force'\) \{[\s\S]*?layeredLayout\(/, 'tree and left to right run on the main thread');
	assert.doesNotMatch(hook, /from 'd3-force'/, 'the force simulation never runs here');
	assert.match(hook, /row\.current = ids\.length < 2 \? null : pathRow\(/, 'the path row is placed over the layout');
});

test('wiring: Escape is the canvas\'s only while something can be cleared, and the handle can give focus back to a node', () => {
	const canvas = source('canvas', 'GraphCanvas.tsx');
	assert.match(canvas, /const clearable = p\.selected\.size > 0 \|\| \(p\.selectedRelationshipId \?\? null\) !== null \? 'selection' : p\.path && p\.path\.nodes\.length > 0 && p\.onClearPath \? 'path' : null;/);
	assert.match(canvas, /keyAction\(\{ model: p\.model, positions: layoutPositions\.current, focusedId: p\.focusedId, clearable \}/);
	assert.match(canvas, /if \(!handled\(action\)\) return;\s*event\.preventDefault\(\);/, 'preventDefault only for a key the canvas uses');
	assert.match(canvas, /case 'clear-path':\s*p\.onClearPath\?\.\(\);/);
	assert.doesNotMatch(canvas, /stopPropagation/, 'nothing stops an event: outer handlers read defaultPrevented');
	const focusNode = canvas.slice(canvas.indexOf('focusNode(id: GraphId): boolean'), canvas.indexOf('fit: refit'));
	assert.match(focusNode, /return focusElement\(id\);/, 'through the one focusing step (scoped to nodes, no scroll; pinned below)');
});

test('wiring: the canvas says once when it is ready (mounted, first layout placed), and its export reports why there is no image', () => {
	const canvas = source('canvas', 'GraphCanvas.tsx');
	assert.match(canvas, /exportImage\(format: 'svg' \| 'png'\): Promise<ExportResult>;/);
	assert.match(canvas, /onReady\?\(\): void;/);
	const ready = canvas.slice(canvas.indexOf('const readyTold = useRef(false);'), canvas.indexOf('}, [layout.version]);', canvas.indexOf('const readyTold = useRef(false);')));
	assert.match(ready, /if \(layout\.version === 0 \|\| readyTold\.current\) return;\s*readyTold\.current = true;\s*latest\.current\.onReady\?\.\(\);/);
	const drawing = canvas.slice(canvas.indexOf('const exportDrawing = useCallback'), canvas.indexOf('useImperativeHandle('));
	assert.match(drawing, /if \(!el\) return \{ blob: null, reason: 'not-ready' \};/);
	assert.match(drawing, /return exportResult\(format, built, rasterise\);/);
});

// Only the roving node is focusable, so a press on any other node gave DOM focus to the element around the canvas, and
// E, C, the arrows, Delete, R and Space stopped reaching it (found live: after a second click, the focus was a DIV).
test('wiring: a click puts keyboard focus on the clicked node, without panning, so the canvas keys keep working', () => {
	const canvas = source('canvas', 'GraphCanvas.tsx');
	const click = canvas.slice(canvas.indexOf('const onNodeClick = useCallback'), canvas.indexOf('const onNodeDoubleClick'));
	assert.match(click, /focusElement\(node\.id\);/, 'the clicked node takes DOM focus');
	assert.ok(click.indexOf('focusElement(node.id)') < click.indexOf('p.onNodeClick'), 'before the selection changes (the inspector may open)');
	assert.match(click, /p\.onFocus\(node\.id\);/, 'and becomes the roving node');
	assert.doesNotMatch(click, /focusFromKeyboard|setCenter|setViewport/, 'a click never pans');
	const helper = canvas.slice(canvas.indexOf('const focusElement = useCallback'), canvas.indexOf('}, []);', canvas.indexOf('const focusElement = useCallback')));
	assert.match(helper, /\.react-flow__node\[data-id=/, 'scoped to node elements (relationship ids overlap node ids)');
	assert.match(helper, /if \(!el\.hasAttribute\('tabindex'\)\) el\.tabIndex = -1;/, 'a node outside the tab order can still take focus');
	assert.match(helper, /el\.focus\(\{ preventScroll: true \}\);/);
	const handle = canvas.slice(canvas.indexOf('focusNode(id: GraphId): boolean {'), canvas.indexOf('fit: refit'));
	assert.match(handle, /return focusElement\(id\);/, 'the handle\'s focusNode is the same step');
});

test('wiring: the hit band follows the zoom through one stylesheet variable, set from the store without re-rendering any relationship', () => {
	assert.match(CANVAS_RULES, /\.graph-ui-edge-hit \{ pointer-events: stroke; cursor: pointer; stroke-width: var\(--graph-ui-edge-hit, 12px\); \}/, 'the hit path takes its width from the variable');
	const canvas = source('canvas', 'GraphCanvas.tsx');
	const effect = canvas.slice(canvas.indexOf('const flowStore = useStoreApi();'), canvas.indexOf('}, [flowStore]);'));
	assert.match(effect, /flowStore\.subscribe\(/, 'a store subscription, not a hook: no re-render on a zoom step');
	assert.match(effect, /edgeHitWidth\(state\.transform\[2\]\)/, 'the zoom only, never the pan offset');
	assert.match(effect, /if \(width === shown\) return;/, 'the stylesheet is touched only when the width steps');
	assert.match(effect, /el\.style\.setProperty\('--graph-ui-edge-hit', `\$\{width\}px`\);/);
	const tree = walk(EdgeShapeImpl({ ...SHAPE, onClick: () => undefined }));
	assert.equal(tree.find((el) => el.props.className === 'graph-ui-edge-hit')?.props.strokeWidth, 12, '12 units where the stylesheet has not loaded');
});
