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
// FILTER STRIP — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the DataGrid's FilterStrip filter row. */

import React, { useState } from 'react';
import { FilterStrip } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';

/** The demo's filter definitions: one text control, one select. */
const DEMO_DEFS = [
	{ key: 'name', label: 'Name', type: 'text' as const, placeholder: 'Search name' },
	{
		key: 'status',
		label: 'Status',
		type: 'select' as const,
		options: [
			{ value: '', label: 'All statuses' },
			{ value: 'running', label: 'Running' },
			{ value: 'stopped', label: 'Stopped' },
		],
	},
];

/** Live demo: a controlled FilterStrip holding its values locally. */
const FilterStripDemo: React.FC<IGalleryDemoProps> = () => {
	// Controlled state, exactly as DataGrid holds it internally
	const [values, setValues] = useState<Record<string, string | string[]>>({ name: '', status: '' });
	const [labels, setLabels] = useState<Record<string, string>>({});
	return (
		<FilterStrip
			defs={DEMO_DEFS}
			values={values}
			labels={labels}
			onChange={(key, value, label) => {
				setValues((prev) => ({ ...prev, [key]: value }));
				if (label !== undefined) setLabels((prev) => ({ ...prev, [key]: label }));
			}}
		/>
	);
};

/** The FilterStrip gallery entry. */
export const filterStripEntry: IGalleryEntry = {
	id: 'filter-strip',
	name: 'FilterStrip',
	group: 'content',
	blurb: "The DataGrid's built-in filter row: one labelled control per definition - text, select, date, or async typeahead - in the platform filter-bar style.",
	doc: `Normally you never mount it: pass \`filters\` to \`DataGrid\` and the grid renders the strip above the table, debounces edits, and feeds the values into \`fetchPage\`. Mount \`FilterStrip\` directly only for filter bars over non-grid content, holding the values yourself (there is no Apply button — every edit fires \`onChange\`).`,
	demo: FilterStripDemo,
	code: `import { DataGrid } from 'shell';
import type { IGridFilterDef } from 'shell';

// The normal path: DataGrid renders the strip itself.
const filters: IGridFilterDef[] = [
	{ key: 'name', label: 'Name', type: 'text', placeholder: 'Search name' },
	{ key: 'status', label: 'Status', type: 'select', options: [
		{ value: '', label: 'All statuses' },
		{ value: 'running', label: 'Running' },
	] },
	{ key: 'owner', label: 'Owner', type: 'typeahead', search: lookupUsers },
];

<DataGrid title="Pipelines" columns={columns} filters={filters}
	fetchPage={({ page, size, sort, filters }) => client.listPipelines({ page, size, sort, filters })} />`,
	props: [
		{ name: 'defs', type: 'IGridFilterDef[]', dir: 'in', required: true, note: 'The filter controls to render, in order.' },
		{ name: 'values', type: 'Record<string, string | string[]>', dir: 'in', required: true, note: 'Current committed values keyed by def key.' },
		{ name: 'labels', type: 'Record<string, string>', dir: 'in', required: true, note: 'Display labels for typeahead selections keyed by def key.' },
		{ name: 'onChange', type: '(key, value, label?) => void', dir: 'out', required: true, note: "Fired on every user edit ('' clears the filter; label accompanies typeahead picks)." },
	],
	sections: [
		{
			label: 'IGridFilterDef',
			rows: [
				{ name: 'key / label', type: 'string', dir: 'in', required: true, note: 'Value key in the filters record / uppercase label above the control.' },
				{ name: 'type', type: "'text' | 'select' | 'date' | 'typeahead'", dir: 'in', required: true, note: 'Control type.' },
				{ name: 'placeholder', type: 'string', dir: 'in', note: 'Placeholder for text / typeahead inputs.' },
				{ name: 'options', type: 'IGridFilterOption[]', dir: 'in', note: 'Select options ({ value, label }); include an empty-value "All ..." entry.' },
				{ name: 'search', type: '(query) => Promise<IGridFilterOption[]>', dir: 'in', note: 'Async suggestion lookup for a typeahead.' },
				{ name: 'width', type: 'number', dir: 'in', note: 'Control width in px; sensible per-type defaults.' },
			],
		},
	],
};
