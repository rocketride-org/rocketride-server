// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// THE GRID: its rules (sort, keys, window, where the focus goes) and its markup
// =============================================================================
//
// The rules are pure (vector/grid.ts) and tested here directly. The grid
// itself is rendered statically (no effects, no focus): its roles, its
// aria-rowcount / aria-rowindex / aria-sort, the one row in the tab order and
// the rows it renders. Focus moves and Escape are checked live (PLAN-MAP M9,
// M11, M33).
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VectorGrid } from '../src/components/VectorGrid';
import type { IGridColumn } from '../src/components/VectorGrid';
import { afterDrawerClosed, afterNeighbourChosen, afterToolGone, gridKey, gridTemplate, gridWindow, nextFocusAfterRemoval, nextRowAfter, nextSort, scrollToShow, sortRows } from '../src/vector/grid';

interface IRow {
	id: string;
	name: string;
	size: number | null;
}

const ROWS: IRow[] = [
	{ id: 'a', name: 'beta.md', size: 30 },
	{ id: 'b', name: 'Alpha.md', size: null },
	{ id: 'c', name: 'alpha.md', size: 10 },
	{ id: 'd', name: 'gamma.md', size: 30 },
];
const COLUMNS: Array<IGridColumn<IRow>> = [
	{ id: 'name', label: 'Name', width: 'flex', minWidth: 160, sortValue: (r) => r.name, cell: (r) => r.name },
	{ id: 'size', label: 'Size', width: 80, align: 'right', sortValue: (r) => r.size, cell: (r) => (r.size === null ? '—' : String(r.size)) },
	{ id: 'note', label: 'Note', width: 60, cell: () => '' },
];
const ids = (rows: readonly IRow[]): string[] => rows.map((r) => r.id);
const rowId = (r: IRow): string => r.id;
const noop = (): void => undefined;

test('a header cycles ascending, descending, then the rows’ own order; another column starts ascending', () => {
	assert.deepEqual(nextSort(null, 'name'), { column: 'name', dir: 'asc' });
	assert.deepEqual(nextSort({ column: 'name', dir: 'asc' }, 'name'), { column: 'name', dir: 'desc' });
	assert.equal(nextSort({ column: 'name', dir: 'desc' }, 'name'), null);
	assert.deepEqual(nextSort({ column: 'name', dir: 'desc' }, 'size'), { column: 'size', dir: 'asc' });
});

test('sorting is stable, keeps unreported values last both ways, compares text the same in every locale, and never writes to the rows', () => {
	const frozen = Object.freeze(ROWS.map((r) => Object.freeze({ ...r })));
	assert.equal(sortRows(frozen, COLUMNS, null), frozen, 'no sort: the rows themselves');
	assert.equal(sortRows(frozen, COLUMNS, { column: 'note', dir: 'asc' }), frozen, 'a column without a sort value does not sort');
	assert.deepEqual(ids(sortRows(frozen, COLUMNS, { column: 'name', dir: 'asc' })), ['b', 'c', 'a', 'd'], 'case-insensitive first, then by code point (Alpha before alpha)');
	assert.deepEqual(ids(sortRows(frozen, COLUMNS, { column: 'size', dir: 'asc' })), ['c', 'a', 'd', 'b'], 'ties keep their order; null last');
	assert.deepEqual(ids(sortRows(frozen, COLUMNS, { column: 'size', dir: 'desc' })), ['a', 'd', 'c', 'b'], 'null last when descending too');
	assert.deepEqual(ids(frozen), ['a', 'b', 'c', 'd'], 'the rows are untouched');
});

test('the keys: Up, Down, Page Up, Page Down, Home and End move within the rows; Enter activates; Space toggles', () => {
	const at = { index: 3, count: 10, page: 4 };
	assert.deepEqual(gridKey('ArrowDown', at), { kind: 'move', index: 4 });
	assert.deepEqual(gridKey('ArrowUp', at), { kind: 'move', index: 2 });
	assert.deepEqual(gridKey('PageDown', at), { kind: 'move', index: 7 });
	assert.deepEqual(gridKey('PageUp', at), { kind: 'move', index: 0 });
	assert.deepEqual(gridKey('Home', at), { kind: 'move', index: 0 });
	assert.deepEqual(gridKey('End', at), { kind: 'move', index: 9 });
	assert.deepEqual(gridKey('ArrowDown', { ...at, index: 9 }), { kind: 'move', index: 9 }, 'the last row stays');
	assert.deepEqual(gridKey('PageDown', { ...at, index: 8 }), { kind: 'move', index: 9 });
	assert.deepEqual(gridKey('Enter', at), { kind: 'activate' });
	assert.deepEqual(gridKey(' ', at), { kind: 'toggle' });
	assert.equal(gridKey('a', at), null);
	assert.equal(gridKey('ArrowDown', { ...at, count: 0 }), null, 'no rows: nothing to move to');
	assert.deepEqual(gridKey('ArrowDown', { ...at, index: -1 }), { kind: 'move', index: 0 }, 'no row yet: the first');
	assert.equal(gridKey('Enter', { ...at, index: -1 }), null);
});

test('the window: the rows in view plus the overscan, and the focused row wherever the list is scrolled', () => {
	const view = { scrollTop: 300, height: 300, rowHeight: 30, count: 1000, overscan: 2, focused: 12 };
	assert.deepEqual(gridWindow(view), { first: 8, last: 22, extra: null });
	assert.deepEqual(gridWindow({ ...view, focused: 500 }), { first: 8, last: 22, extra: 500 }, 'the focused row is rendered too');
	assert.deepEqual(gridWindow({ ...view, scrollTop: 0, count: 5 }), { first: 0, last: 5, extra: null });
	assert.deepEqual(gridWindow({ ...view, count: 0, focused: -1 }), { first: 8, last: 8, extra: null });
	assert.equal(scrollToShow(5, { scrollTop: 0, height: 300, rowHeight: 30 }), null, 'in view');
	assert.equal(scrollToShow(20, { scrollTop: 0, height: 300, rowHeight: 30 }), 330, 'below: scrolled just enough');
	assert.equal(scrollToShow(2, { scrollTop: 300, height: 300, rowHeight: 30 }), 60, 'above: to its top');
});

test('where the focus goes when its row leaves: the next row still listed, else the one before, else nobody', () => {
	const before = ['a', 'b', 'c', 'd', 'e'];
	assert.equal(nextFocusAfterRemoval(before, new Set(before), 'c'), 'c', 'still listed');
	assert.equal(nextFocusAfterRemoval(before, new Set(['a', 'b', 'e']), 'c'), 'e');
	assert.equal(nextFocusAfterRemoval(before, new Set(['a', 'b']), 'c'), 'b');
	assert.equal(nextFocusAfterRemoval(before, new Set(), 'c'), null);
	assert.equal(nextFocusAfterRemoval(before, new Set(['z']), 'q'), 'z', 'an unknown row: the first one listed');
});

test('after a write the focus goes to the row after the first target that stays, else the one before, chosen while they are listed', () => {
	const shown = ['a', 'b', 'c', 'd', 'e'];
	assert.equal(nextRowAfter(shown, new Set(['b', 'c'])), 'd');
	assert.equal(nextRowAfter(shown, new Set(['d', 'e'])), 'c');
	assert.equal(nextRowAfter(shown, new Set(['b', 'e'])), 'c', 'the first target decides');
	assert.equal(nextRowAfter(shown, new Set(shown)), null, 'no row left');
	assert.equal(nextRowAfter(shown, new Set(['x'])), null, 'no target shown');
});

test('the columns share one template: fixed widths in px, a flexible column with its minimum', () => {
	assert.equal(gridTemplate(COLUMNS), 'minmax(160px, 1fr) 80px 60px');
});

test('the grid renders a WAI-ARIA grid: a header row with aria-sort on the sorted column, rows numbered out of the count, one row in the tab order', () => {
	const html = renderToStaticMarkup(<VectorGrid label="Stored documents" rows={ROWS} rowId={rowId} columns={COLUMNS} sort={{ column: 'size', dir: 'desc' }} onSort={noop} selectedId="d" />);
	assert.match(html, /role="grid" aria-label="Stored documents" aria-rowcount="5" aria-colcount="3" tabindex="-1"/);
	assert.match(html, /role="row" aria-rowindex="1"/);
	assert.match(html, /role="columnheader" aria-sort="descending"[^>]*><button type="button"[^>]*title="Sort by Size"><span>Size<\/span><span aria-hidden="true">▼<\/span><\/button>/);
	assert.doesNotMatch(html, /aria-sort="(none|ascending)"/, 'only the sorted column says how');
	assert.match(html, /role="columnheader"[^>]*><span>Note<\/span><\/div>/, 'a column without a sort value has no button');
	const rows = [...html.matchAll(/data-row-id="(\w)" aria-rowindex="(\d)" aria-selected="(true|false)" tabindex="(-?\d)"/g)].map((m) => `${m[1]}${m[2]}${m[3] === 'true' ? '*' : ''}${m[4] === '0' ? '^' : ''}`);
	assert.deepEqual(rows, ['a2^', 'd3*', 'c4', 'b5'], 'sorted, numbered from 2 (the header is 1), the first row in the tab order, the drawer row selected');
	assert.equal(html.match(/role="gridcell"/g)?.length, 12);
});

test('the grid never lists a row twice and renders nothing it is not given; an empty grid says so under its header', () => {
	const empty = renderToStaticMarkup(<VectorGrid label="Stored documents" rows={[]} rowId={rowId} columns={COLUMNS} sort={null} onSort={noop} empty="No documents yet." />);
	assert.match(empty, /aria-rowcount="1"/);
	assert.match(empty, /<\/div><div style="[^"]*">No documents yet\.<\/div><\/div>$/);
	const many = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, name: `n${i}`, size: i }));
	const html = renderToStaticMarkup(<VectorGrid label="Many" rows={many} rowId={rowId} columns={COLUMNS} sort={null} onSort={noop} />);
	const rendered = html.match(/role="row" data-grid-row=""/g)?.length ?? 0;
	assert.ok(rendered > 0 && rendered < 60, `windowed: ${rendered} of 500 rendered`);
	assert.match(html, /aria-rowcount="501"/);
});

test("the grid's source: keys on its own element, no listener above it, nothing stopped, the rows never written", () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'VectorGrid.tsx'), 'utf8');
	assert.doesNotMatch(source, /stopPropagation|addEventListener/);
	assert.match(source, /onKeyDown=\{onKeyDown\}/);
	assert.match(source, /if \(event\.defaultPrevented \|\| event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey\) return;/, 'an outer handler that already acted wins');
	assert.match(source, /if \(action\.kind !== 'move' && event\.target !== row\) return;/, "Enter and Space on a control inside a row are the control's");
	assert.doesNotMatch(source, /rows\[[^\]]+\]\s*=|\.sort\(\)|\.reverse\(\)|\.splice\(/, 'the rows are read, never written');
});

test('rows a write is about to take away: the row after them is rendered and marked for the focus, wherever the list is scrolled', () => {
	const many = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, name: `n${i}`, size: i }));
	const html = renderToStaticMarkup(<VectorGrid label="Many" rows={many} rowId={rowId} columns={COLUMNS} sort={null} onSort={noop} leaving={new Set(['r300', 'r301'])} />);
	assert.match(html, /data-row-id="r302" aria-rowindex="304" data-return-focus=""/, 'the row after them, rendered though far out of view');
	assert.equal(html.match(/data-return-focus/g)?.length, 1);
	const last = renderToStaticMarkup(<VectorGrid label="Rows" rows={ROWS} rowId={rowId} columns={COLUMNS} sort={null} onSort={noop} leaving={new Set(['d'])} />);
	assert.match(last, /data-row-id="c" aria-rowindex="4" data-return-focus=""/, 'the last rows: the one before them');
	assert.doesNotMatch(renderToStaticMarkup(<VectorGrid label="Rows" rows={ROWS} rowId={rowId} columns={COLUMNS} sort={null} onSort={noop} leaving={new Set(ids(ROWS))} />), /data-return-focus/, 'no row left: the grid itself takes the focus');
});

/** A focus target as vector/focus.ts reads it. */
function target(name: string, state: 'shown' | 'hidden' | 'gone' = 'shown'): { name: string; isConnected: boolean; offsetParent: unknown; focus(): void } {
	return { name, isConnected: state !== 'gone', offsetParent: state === 'shown' ? {} : null, focus: () => undefined };
}

test('where the focus goes when a control goes away, the drawer closes or a neighbour is chosen: the first target on the page and shown', () => {
	const chain = { stopRow: target('row'), grid: target('grid'), tab: target('tab') };
	assert.equal(afterToolGone(chain)?.name, 'row', "the grid's row in the tab order");
	assert.equal(afterToolGone({ ...chain, stopRow: null })?.name, 'grid', 'no row: the grid');
	assert.equal(afterToolGone({ stopRow: null, grid: target('grid', 'hidden'), tab: chain.tab })?.name, 'tab', 'a hidden grid: the tab');
	assert.equal(afterToolGone({ stopRow: target('row', 'gone'), grid: null, tab: null }), null);
	assert.equal(afterDrawerClosed(target('its row'), chain)?.name, 'its row', "the drawer's document's row");
	assert.equal(afterDrawerClosed(null, chain)?.name, 'row', 'not listed: the row in the tab order');
	assert.equal(afterDrawerClosed(target('its row', 'gone'), { ...chain, stopRow: null })?.name, 'grid');
	assert.equal(afterNeighbourChosen(target('its row'), target('heading'))?.name, 'its row', 'a listed neighbour: its row');
	assert.equal(afterNeighbourChosen(null, target('heading'))?.name, 'heading', "not listed: the drawer's heading, which names it now");
});

test("the selected row (the drawer's) is rendered wherever the list is scrolled, so closing the drawer can focus it", () => {
	const many = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, name: `n${i}`, size: i }));
	const html = renderToStaticMarkup(<VectorGrid label="Many" rows={many} rowId={rowId} columns={COLUMNS} sort={null} onSort={noop} selectedId="r420" />);
	assert.match(html, /data-row-id="r420" aria-rowindex="422" aria-selected="true"/);
});
