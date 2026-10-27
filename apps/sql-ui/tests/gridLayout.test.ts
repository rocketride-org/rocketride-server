// MIT License
//
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
// GRID LAYOUTS — WHAT A SAVED LAYOUT MAY RESTORE (live L4, N1, bug 4)
// =============================================================================
//
// Every grid lays out with fitColumns, and the shell saves each column's
// CURRENT width, flexible columns included. A grid built inside a hidden
// panel (or mid-transition) measures a 0-wide container, crushes its
// flexible columns to Tabulator's 40 px minimum, and saves that; every
// later open restores 40 px as a FIXED width, which no resize or redraw can
// undo. Live, the Overview's Table column stayed 40 px (names cut to four
// characters) and every Data column of orders was 40 px with its header
// cut. The layouts below are the ones the live user's workspace held.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DataGridLayout, IDataGridPersistence } from 'shell';
import { MIN_SAVED_WIDTH, guardLayouts, layoutRulesFor, sanitizeColumnLayout } from '../src/sql/gridLayout';

/** The Overview grid's columns, as OverviewPanel declares them (widths and markers only). */
const OVERVIEW = [
	{ field: 'name' },
	{ field: 'columns', width: 110 },
	{ field: 'primaryKey', width: 220 },
	{ field: 'foreignKeys', width: 130 },
	{ field: '__rrActions', width: 110, rrNoPopup: true },
];

/** What the live user's workspace held for the Overview grid. */
const STORED_OVERVIEW = [
	{ field: 'name', width: 40, visible: true },
	{ field: 'columns', width: 110, visible: true },
	{ field: 'primaryKey', width: 220, visible: true },
	{ field: 'foreignKeys', width: 130, visible: true },
	{ field: '__rrActions', width: 110, visible: false },
];

/**
 * A persistence over a map, recording writes.
 *
 * @param seed - Stored blobs by `tableId/type`.
 * @returns The persistence, its store and its writes.
 */
function memory(seed: Record<string, unknown> = {}): { grids: IDataGridPersistence; store: Map<string, unknown>; cleared: string[] } {
	const store = new Map(Object.entries(seed));
	const cleared: string[] = [];
	return {
		store,
		cleared,
		grids: {
			read: (tableId, type) => store.get(`${tableId}/${type}`) ?? false,
			write: (tableId, type, data) => { store.set(`${tableId}/${type}`, data); },
			clear: (tableId) => { cleared.push(tableId); },
		},
	};
}

describe('layoutRulesFor: which widths a grid may keep', () => {
	it('keeps the widths the code fixes, and the columns a user cannot hide', () => {
		assert.deepEqual(layoutRulesFor(OVERVIEW), { fixedWidths: ['columns', 'primaryKey', 'foreignKeys', '__rrActions'], alwaysVisible: ['__rrActions'] });
		assert.deepEqual(layoutRulesFor([{ field: 'id' }, { field: 'note' }]), { fixedWidths: [], alwaysVisible: [] });
	});
});

describe('sanitizeColumnLayout', () => {
	const rules = layoutRulesFor(OVERVIEW);

	it('heals the live Overview layout: the Table column flexes again and Actions shows', () => {
		assert.deepEqual(sanitizeColumnLayout(STORED_OVERVIEW, rules), [
			{ field: 'name', visible: true },
			{ field: 'columns', width: 110, visible: true },
			{ field: 'primaryKey', width: 220, visible: true },
			{ field: 'foreignKeys', width: 130, visible: true },
			{ field: '__rrActions', width: 110, visible: true },
		]);
	});

	it('keeps no width for a grid whose columns all flex (Data, Query results)', () => {
		const stored = [{ field: 'id', width: 40, visible: true }, { field: 'note', width: 282, visible: false }];
		assert.deepEqual(sanitizeColumnLayout(stored, layoutRulesFor([{ field: 'id' }, { field: 'note' }])), [{ field: 'id', visible: true }, { field: 'note', visible: false }]);
	});

	it('drops a fixed column\'s width below the minimum (a crushed build), and keeps a user\'s wider one', () => {
		assert.equal(MIN_SAVED_WIDTH, 60);
		assert.deepEqual(sanitizeColumnLayout([{ field: 'columns', width: 12, visible: true }, { field: 'primaryKey', width: 300, visible: true }], rules), [{ field: 'columns', visible: true }, { field: 'primaryKey', width: 300, visible: true }]);
	});

	it('leaves anything that is not a column list alone', () => {
		assert.equal(sanitizeColumnLayout(false, rules), false);
		assert.deepEqual(sanitizeColumnLayout({ x: 1 }, rules), { x: 1 });
	});
});

describe('guardLayouts: the persistence every sql-ui grid gets', () => {
	const rules = layoutRulesFor(OVERVIEW);

	it('reads a healed column layout, and passes sort, page, display and format through', () => {
		const { grids } = memory({ 'sql-overview-tables/columns': STORED_OVERVIEW, 'sql-overview-tables/sort': [{ column: 'name', dir: 'asc' }] });
		const guarded = guardLayouts(grids, rules);
		const columns = guarded.read('sql-overview-tables', 'columns') as Array<{ field: string; width?: number; visible: boolean }>;
		assert.equal(columns[0]!.width, undefined);
		assert.equal(columns[4]!.visible, true);
		assert.deepEqual(guarded.read('sql-overview-tables', 'sort'), [{ column: 'name', dir: 'asc' }]);
		assert.equal(guarded.read('sql-overview-tables', 'page'), false);
	});

	it('never stores a flexible column\'s width, so a crushed build cannot freeze it', () => {
		const { grids, store, cleared } = memory();
		const guarded = guardLayouts(grids, rules);
		guarded.write('sql-overview-tables', 'columns', STORED_OVERVIEW);
		assert.deepEqual((store.get('sql-overview-tables/columns') as DataGridLayout[string] as Array<{ field: string; width?: number }>).map((c) => [c.field, c.width ?? null]), [['name', null], ['columns', 110], ['primaryKey', 220], ['foreignKeys', 130], ['__rrActions', 110]]);
		guarded.write('sql-overview-tables', 'sort', []);
		assert.deepEqual(store.get('sql-overview-tables/sort'), []);
		guarded.clear('sql-overview-tables');
		assert.deepEqual(cleared, ['sql-overview-tables']);
	});
});

describe('every sql-ui grid that keeps a layout goes through the guard', () => {
	const SRC = path.resolve(__dirname, '..', 'src');
	const source = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

	it('the Overview, Insights, Data and Query grids', () => {
		for (const rel of ['panels/OverviewPanel.tsx', 'views/InsightsPanel.tsx', 'views/TableDataView.tsx', 'views/QueryView.tsx']) {
			const text = source(rel);
			assert.match(text, /const gridLayouts = useMemo\(\(\) => guardLayouts\(env\.gridPersistence, layoutRulesFor\(columns\)\), \[env\.gridPersistence, columns\]\);/, rel);
			assert.equal((text.match(/persistence=\{gridLayouts\}/g) ?? []).length, (text.match(/tableId=/g) ?? []).length, rel);
		}
	});

	it('the Overview\'s Actions column is part of the default view, and its Table column never shrinks unreadably', () => {
		const overview = source('panels/OverviewPanel.tsx');
		assert.match(overview, /\.\.\.createActionsColumn<TableRow>\(\{[\s\S]*?\}\),\s*rrDefault: true,/);
		assert.match(overview, /field: 'name',[\s\S]*?minWidth: 160,/);
	});
});
