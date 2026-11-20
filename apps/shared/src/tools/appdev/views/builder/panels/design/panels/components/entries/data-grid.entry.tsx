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
		{ name: 'fetchPage', type: '(req: IDataGridPageRequest) => Promise<IDataGridPage<Row>>', dir: 'in', note: 'Server mode - called with page/size/sort/filters (plus the search term) on every change; returns { rows, total }.' },
		{ name: 'tableId', type: 'string', dir: 'in', note: 'Stable id keying layout persistence (required with persistence).' },
		{ name: 'title', type: 'string', dir: 'in', note: 'Heading text in the built-in title bar. Required on CardDataGrid (two-row card header).' },
		{ name: 'noSearch', type: 'boolean', dir: 'in', note: 'Hide the title-bar search entirely (exceptional - the field is collapsed behind the magnifier by default).' },
		{ name: 'noExport', type: 'boolean', dir: 'in', note: 'Hide the gear menu EXPORT section (CSV / JSON over every row matching the current filters and search).' },
		{ name: 'actions', type: 'ReactNode', dir: 'in', note: 'Card-specific action buttons; actions or title switches the bar to its card-header form.' },
		{ name: 'remoteSort', type: 'boolean', dir: 'in', note: 'Send sorters to fetchPage instead of sorting locally.' },
		{ name: 'pageSizes', type: 'number[]', dir: 'in', note: 'Page-size options; the first entry is the default size.' },
		{ name: 'paginate', type: 'boolean', dir: 'in', note: 'Pass false to disable pagination entirely (every row renders; no footer).' },
		{ name: 'height', type: 'string | number', dir: 'in', note: 'Definite height for an internally-scrolling grid (pair with a fill Card).' },
		{ name: 'emptyTitle', type: 'string', dir: 'in', note: 'Empty-set placeholder title.' },
		{ name: 'emptyDescription', type: 'string', dir: 'in', note: 'Empty-set placeholder description line.' },
		{ name: 'persistence', type: 'IDataGridPersistence', dir: 'in', note: 'Persistence adapter override; normally omitted - a grid with a tableId persists over the grid config channel by default.' },
		{ name: 'autoColumns', type: 'boolean', dir: 'in', note: 'Derive hidden, toggleable columns from undeclared row keys (no rrType, so they fall back to the text filter).' },
		{ name: 'filters', type: 'IGridFilterDef[]', dir: 'in', note: 'Filter strip above the table; values auto-apply after a 300ms debounce (remote refetch / grid-internal local predicate).' },
		{ name: 'fetchDistinct', type: '(field: string) => Promise<(string | number | boolean)[]>', dir: 'in', note: "Distinct-value lookup for enum checklists (wire to list_distinct); absent = local grids derive from data, remote fall back to text." },
		{ name: 'options', type: 'Options', dir: 'in', note: 'Native Tabulator options escape hatch - merged over the defaults.' },
		{ name: 'onRowClick', type: '(row: Row) => void', dir: 'out', note: 'Row activation - typically opens the record DetailPanel.' },
		{ name: 'onLoadError', type: '(error: Error) => void', dir: 'out', note: 'Remote load failure (prior rows are kept; an overlay shows briefly).' },
		{ name: 'onFiltersChange', type: '(values: Record<string, string | string[]>) => void', dir: 'out', note: 'Debounced committed filter values - optional observation hook (URL sync, analytics, host-filtered strip-only keys).' },
	],
	sections: [
		{
			label: 'Ref (IDataGridHandle)',
			rows: [
				{ name: 'table', type: 'Tabulator | null', dir: 'out', note: 'The live Tabulator instance (null before mount / after unmount).' },
				{ name: 'refetch', type: '(opts?: { resetPage?: boolean }) => void', dir: 'in', note: 'Re-run the remote query; resetPage returns to page 1 (filter/search changes), otherwise the current page is re-requested (mutations).' },
				{ name: 'resetLayout', type: '() => void', dir: 'in', note: 'Reset the grid COMPLETELY - persisted layout, sort, all filters, and the grid-local search - then rebuild and re-query page 1.' },
			],
		},
	],
};
