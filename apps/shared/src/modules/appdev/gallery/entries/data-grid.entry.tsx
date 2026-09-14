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
// DATA GRID — GALLERY ENTRY (LAZY)
// =============================================================================

/** Gallery entry for the DataGrid - Tabulator loads on first view via lazyDemo. */

import type { IGalleryEntry } from '../galleryTypes';

/** The DataGrid / CardDataGrid gallery entry. */
export const dataGridEntry: IGalleryEntry = {
	id: 'data-grid',
	name: 'DataGrid / CardDataGrid',
	group: 'content',
	blurb: 'Tabulator-based table: tri-state sorting, pagination, server-side search, Excel-style per-column filter/format popups, and per-user persisted layouts. Static data mode shown here; real views feed fetchPage from the list_* APIs. CardDataGrid is the same grid as a Card with a required title.',
	lazyDemo: () => import('./demos/DataGridDemo'),
	code: `import { DataGrid } from 'shell';
import type { GridColumnDefinition } from 'shell';

const columns: GridColumnDefinition[] = [
	{ title: 'Name', field: 'name', rrType: 'string', rrDefault: true, rrDescription: 'Pipeline file name.' },
	{ title: 'Documents', field: 'documents', rrType: 'number', rrDefault: true, rrDescription: 'Documents processed by the last run.' },
	{ title: 'Updated', field: 'updated', rrType: 'date', rrDefault: true, rrDefaultSort: 'desc', rrDescription: 'Date of the last run.' },
];

// Static mode - the grid pages/sorts/filters the rows itself
<DataGrid title="Pipelines" columns={columns} data={rows} />

// Server mode - the grid calls fetchPage on every page/sort/filter change
<DataGrid title="Pipelines" columns={columns} remoteSort
	fetchPage={({ page, size, sort, filters }) => client.listPipelines({ page, size, sort, filters })} />`,
	props: [
		{ name: 'columns', type: 'GridColumnDefinition[]', dir: 'in', required: true, note: "Tabulator column definitions plus rr extensions: rrDescription (required - header/toggle tooltip), rrType (filter control), rrDefault (default view), rrDefaultSort, rrGroup, rrNoPopup, rrOptions." },
		{ name: 'data', type: 'Row[]', dir: 'in', note: 'Static mode - the full row set; the grid pages and sorts locally.' },
		{ name: 'fetchPage', type: '(req: IDataGridPageRequest) => Promise<IDataGridPage<Row>>', dir: 'in', note: 'Server mode - called with page/size/sort/filters on every change; returns { rows, total }.' },
		{ name: 'tableId', type: 'string', dir: 'in', note: 'Stable id keying layout persistence (required with persistence).' },
		{ name: 'title', type: 'string', dir: 'in', note: 'Heading text in the built-in title bar. Required on CardDataGrid (two-row card header).' },
		{ name: 'remoteSort', type: 'boolean', dir: 'in', note: 'Send sorters to fetchPage instead of sorting locally.' },
		{ name: 'height', type: 'string | number', dir: 'in', note: 'Definite height for an internally-scrolling grid (pair with a fill Card).' },
		{ name: 'onRowClick', type: '(row: Row) => void', dir: 'out', note: 'Row activation - typically opens the record DetailPanel.' },
	],
};
