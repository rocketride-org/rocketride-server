// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CANVAS MENU: the items for each target, the menu keys (WAI-ARIA menu pattern),
// the types offered by "Expand by type", and where the menu is placed
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampMenuPosition, fitInViewport, menuItemsFor, menuKey, relationshipTypesFor } from '../src/graph/canvasMenu';
import type { IMenuContext, IMenuItem } from '../src/graph/canvasMenu';
import type { ISchemaView } from '../src/graph/schema';
import { NO_SCHEMA } from '../src/graph/schema';

const ctx: IMenuContext = { busy: false, stale: false, selectedCount: 0, nodeCount: 5, canQuery: true, relationshipTypes: ['MAKES', 'WORKS_AT'] };
const ids = (items: readonly IMenuItem[]): string[] => items.map((i) => i.id);

test('a node menu offers expand, expand by type, collapse, dismiss, inspect, find path, connect, two copies and a new query', () => {
	assert.deepEqual(ids(menuItemsFor({ kind: 'node', id: 'a' }, ctx)), ['expand', 'expand-type', 'collapse', 'dismiss', 'inspect', 'find-path', 'connect', 'copy-caption', 'copy-json', 'new-query']);
});

test('"Expand by type" holds one item per relationship type, and is off (with the reason) when there is none', () => {
	const typed = menuItemsFor({ kind: 'node', id: 'a' }, ctx).find((i) => i.id === 'expand-type') as IMenuItem;
	assert.deepEqual(ids(typed.submenu ?? []), ['type:MAKES', 'type:WORKS_AT']);
	const none = menuItemsFor({ kind: 'node', id: 'a' }, { ...ctx, relationshipTypes: [] }).find((i) => i.id === 'expand-type') as IMenuItem;
	assert.equal(none.disabled, true);
	assert.match(none.reason ?? '', /relationship type/i);
	assert.match(typed.label, /sampled/);
});

test('what asks the database is off while busy or out of date, and says why; what only changes the drawing stays on', () => {
	for (const off of [{ busy: true }, { stale: true }]) {
		const items = menuItemsFor({ kind: 'node', id: 'a' }, { ...ctx, ...off });
		for (const id of ['expand', 'expand-type', 'find-path', 'connect']) {
			const item = items.find((i) => i.id === id) as IMenuItem;
			assert.equal(item.disabled, true, `${id} with ${JSON.stringify(off)}`);
			assert.ok(item.reason && item.reason.length > 0, `${id} says why`);
		}
		for (const id of ['collapse', 'dismiss', 'inspect', 'copy-caption', 'copy-json']) assert.ok(!(items.find((i) => i.id === id) as IMenuItem).disabled, id);
	}
});

test('connecting needs two drawn nodes, and "New query from here" is left out when no query can be made', () => {
	assert.equal(menuItemsFor({ kind: 'node', id: 'a' }, { ...ctx, nodeCount: 1 }).find((i) => i.id === 'connect')?.disabled, true);
	assert.ok(!ids(menuItemsFor({ kind: 'node', id: 'a' }, { ...ctx, canQuery: false })).includes('new-query'));
});

test('a relationship menu inspects it, selects either end that is drawn, and offers a new query', () => {
	const items = menuItemsFor({ kind: 'relationship', id: 'r' }, { ...ctx, startDrawn: true, endDrawn: false });
	assert.deepEqual(ids(items), ['inspect', 'select-start', 'select-end', 'new-query']);
	assert.ok(!items[1].disabled);
	assert.equal(items[2].disabled, true);
});

test('a pane menu fits, re-runs the layout and clears the selection (off when nothing is selected)', () => {
	const items = menuItemsFor({ kind: 'pane' }, ctx);
	assert.deepEqual(ids(items), ['fit', 'relayout', 'clear-selection']);
	assert.equal(items[2].disabled, true);
	assert.ok(!menuItemsFor({ kind: 'pane' }, { ...ctx, selectedCount: 2 })[2].disabled);
});

const sample: IMenuItem[] = [
	{ id: 'a', label: 'Alpha' },
	{ id: 'b', label: 'Beta', submenu: [{ id: 'b1', label: 'One' }] },
	{ id: 'c', label: 'Gamma', disabled: true },
	{ id: 'd', label: 'Delta' },
];

test('Down and Up move through the items and wrap; Home and End jump', () => {
	assert.deepEqual(menuKey(sample, 0, 'ArrowDown'), { type: 'move', index: 1, handled: true });
	assert.deepEqual(menuKey(sample, 3, 'ArrowDown'), { type: 'move', index: 0, handled: true });
	assert.deepEqual(menuKey(sample, 0, 'ArrowUp'), { type: 'move', index: 3, handled: true });
	assert.deepEqual(menuKey(sample, 2, 'Home'), { type: 'move', index: 0, handled: true });
	assert.deepEqual(menuKey(sample, 0, 'End'), { type: 'move', index: 3, handled: true });
});

test('Enter and Space activate an item; on one with a submenu (and on Right) they open it; a disabled item does nothing', () => {
	assert.deepEqual(menuKey(sample, 0, 'Enter'), { type: 'activate', index: 0, handled: true });
	assert.deepEqual(menuKey(sample, 0, ' '), { type: 'activate', index: 0, handled: true });
	assert.deepEqual(menuKey(sample, 1, 'Enter'), { type: 'open-submenu', index: 1, handled: true });
	assert.deepEqual(menuKey(sample, 1, 'ArrowRight'), { type: 'open-submenu', index: 1, handled: true });
	assert.deepEqual(menuKey(sample, 0, 'ArrowRight'), { type: 'none', handled: false });
	assert.deepEqual(menuKey(sample, 2, 'Enter'), { type: 'none', handled: true });
});

test('Escape closes and returns focus; Left goes back; Tab closes and lets the key through', () => {
	assert.deepEqual(menuKey(sample, 0, 'Escape'), { type: 'close', handled: true });
	assert.deepEqual(menuKey(sample, 0, 'ArrowLeft'), { type: 'back', handled: true });
	assert.deepEqual(menuKey(sample, 0, 'Tab'), { type: 'close', handled: false });
});

test('a letter jumps to the next item starting with it, wrapping; other keys are not the menu\'s', () => {
	assert.deepEqual(menuKey(sample, 0, 'd'), { type: 'move', index: 3, handled: true });
	assert.deepEqual(menuKey(sample, 3, 'a'), { type: 'move', index: 0, handled: true });
	assert.deepEqual(menuKey(sample, 0, 'z'), { type: 'none', handled: false });
	assert.deepEqual(menuKey(sample, 0, 'F5'), { type: 'none', handled: false });
	assert.deepEqual(menuKey([], 0, 'ArrowDown'), { type: 'none', handled: true });
});

test('the menu stays inside its container: shifted left or up when it would overflow, never past the top-left', () => {
	assert.deepEqual(clampMenuPosition({ x: 100, y: 50 }, { width: 800, height: 600 }, { width: 200, height: 300 }), { x: 100, y: 50 });
	assert.deepEqual(clampMenuPosition({ x: 700, y: 500 }, { width: 800, height: 600 }, { width: 200, height: 300 }), { x: 596, y: 296 });
	assert.deepEqual(clampMenuPosition({ x: 5, y: 5 }, { width: 100, height: 100 }, { width: 300, height: 300 }), { x: 4, y: 4 });
});

test('"Expand by type" offers the types whose schema endpoints include one of the node\'s labels, sorted, none for an unknown label', () => {
	const view: ISchemaView = {
		...NO_SCHEMA,
		relationshipTypes: [
			{ type: 'WORKS_AT', endpoints: [{ start: 'Person', end: 'Company', observed: true }], properties: [], count: null, countEstimated: false },
			{ type: 'MAKES', endpoints: [{ start: 'Company', end: 'Product', observed: true }], properties: [], count: null, countEstimated: false },
			{ type: 'KNOWS', endpoints: [{ start: 'Person', end: 'Person', observed: false }], properties: [], count: null, countEstimated: false },
		],
	};
	assert.deepEqual(relationshipTypesFor(view, ['Person']), ['KNOWS', 'WORKS_AT']);
	assert.deepEqual(relationshipTypesFor(view, ['Company']), ['MAKES', 'WORKS_AT']);
	assert.deepEqual(relationshipTypesFor(view, ['Topic']), []);
	assert.deepEqual(relationshipTypesFor(null, ['Person']), []);
});

test('a menu that runs past the right or bottom edge of the viewport is moved back inside, and one that fits is left alone', () => {
	const view = { width: 1440, height: 900 };
	assert.deepEqual(fitInViewport({ left: 1280, top: 40, width: 260, height: 200 }, view), { dx: -104, dy: 0 });
	assert.deepEqual(fitInViewport({ left: 100, top: 800, width: 200, height: 300 }, view), { dx: 0, dy: -204 });
	assert.deepEqual(fitInViewport({ left: 100, top: 100, width: 200, height: 300 }, view), { dx: 0, dy: 0 });
});

test('a menu wider than the viewport is pinned to the left margin, never pushed off the left edge', () => {
	assert.deepEqual(fitInViewport({ left: 50, top: 10, width: 700, height: 100 }, { width: 400, height: 500 }), { dx: -46, dy: 0 });
	assert.deepEqual(fitInViewport({ left: -30, top: -20, width: 100, height: 100 }, { width: 400, height: 500 }), { dx: 34, dy: 24 });
});
