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
// DATA GRID HELPERS — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the DataGrid cell factories, actions column, and persistence. */

import React, { useEffect, useRef } from 'react';
import { avatarEl, badgeEl, buttonEl, monoEl, mutedEl } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';

/** Live demo: the DOM cell factories rendered side by side. */
const GridHelpersDemo: React.FC<IGalleryDemoProps> = () => {
	const hostRef = useRef<HTMLDivElement>(null);

	// The factories build raw DOM (Tabulator formatters run outside React),
	// so the demo appends their output into a host node imperatively.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		host.replaceChildren(badgeEl('success', 'Running'), badgeEl('error', 'Failed'), buttonEl('secondary', 'Open', 'open'), buttonEl('danger', 'Delete', 'delete'), avatarEl('RC', 'var(--rr-color-brand)'), monoEl('rod.demo.chat'), mutedEl('Jun 12, 4:02 PM'));
	}, []);

	return <div ref={hostRef} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }} />;
};

/** The DataGrid helpers gallery entry. */
export const gridHelpersEntry: IGalleryEntry = {
	id: 'grid-helpers',
	name: 'DataGrid helpers',
	group: 'content',
	blurb: 'The DataGrid toolkit around the grid itself: DOM cell factories for custom formatters, the actions-column builder, the local-search predicate, and layout persistence.',
	doc: `Tabulator formatters build DOM **outside React**, so custom cells are assembled from these factories instead of JSX — each returns a token-styled \`HTMLElement\` ready to return from a \`formatter\`. \`autoFormatter\` is the default when a column declares none: it renders by value type (booleans as yes/no badges, ISO dates as muted local datetimes, arrays as badge lists, objects as truncated JSON).

Layout persistence is host-agnostic: \`createMessageGridPersistence()\` speaks the \`rr:grid-config:*\` CustomEvent channel and whatever host is present (web shell, VS Code webview, or none) answers it. Wire it to \`DataGrid\` via \`tableId\` + the persistence adapter and per-user layouts come for free.`,
	demo: GridHelpersDemo,
	code: `import { createActionsColumn, badgeEl, matchesSearch, createMessageGridPersistence } from 'shell';
import type { GridColumnDefinition } from 'shell';

const columns: GridColumnDefinition[] = [
	{ title: 'Status', field: 'status', rrType: 'enum', rrDescription: 'Run state.',
		formatter: (cell) => badgeEl(cell.getValue() === 'running' ? 'success' : 'muted', cell.getValue()) },
	// Trailing Actions column - exempt from sort/move/popup, excluded from row-click
	createActionsColumn({
		actions: [
			{ key: 'open', label: 'Open' },
			{ key: 'delete', label: 'Delete', kind: 'danger' },
		],
		onAction: (key, row) => handleAction(key, row),
	}),
];`,
	propsLabel: 'Cell factories',
	props: [
		{ name: 'badgeEl', type: '(variant: CellBadgeVariant, label: string) => HTMLElement', dir: 'in', note: 'Status pill (StatusBadge clone); variants success / info / warning / error / muted.' },
		{ name: 'buttonEl', type: '(kind: CellButtonKind, label: string, action: string) => HTMLElement', dir: 'in', note: 'Small action button; the data-action attribute routes clicks. Kinds ghost / secondary / danger.' },
		{ name: 'avatarEl', type: '(initials: string, background: string) => HTMLElement', dir: 'in', note: '32px round avatar with initials.' },
		{ name: 'monoEl / mutedEl', type: '(text: string) => HTMLElement', dir: 'in', note: 'Monospace span (ids, code-ish) / muted secondary span (dates, de-emphasised).' },
		{ name: 'autoFormatter', type: '(cell) => HTMLElement | string', dir: 'in', note: 'Type-heuristic default formatter keyed off the cell value.' },
		{ name: 'matchesSearch', type: '(row, term) => boolean', dir: 'in', note: 'Case-insensitive substring match over every string/number value of a row; empty term matches all.' },
	],
	sections: [
		{
			label: 'Actions column',
			rows: [
				{ name: 'createActionsColumn', type: '(config: IActionsColumnConfig) => GridColumnDefinition', dir: 'in', note: 'Builds the trailing right-aligned Actions column - exempt from sort/move/popup and excluded from row-click.' },
				{ name: 'IGridAction', type: '{ key, label, kind? }', dir: 'in', note: 'One action per row; label and kind may be functions of the row.' },
				{ name: 'IActionsColumnConfig', type: '{ actions, onAction, width? }', dir: 'in', note: 'The actions in order plus the (key, row) handler; width defaults to 120.' },
			],
		},
		{
			label: 'Persistence',
			rows: [
				{ name: 'createMessageGridPersistence', type: '() => IDataGridPersistence', dir: 'in', note: 'Adapter over the rr:grid-config:* CustomEvent channel; sync reads seed a per-instance cache, writes are fire-and-forget. No bridge = reads return false, writes drop.' },
				{ name: 'IDataGridPersistence', type: '{ read, write, clear }', dir: 'in', note: 'The storage contract: read must be synchronous (Tabulator reads persistence synchronously).' },
				{ name: 'DataGridLayout', type: 'Record<string, unknown>', dir: 'in', note: 'Persisted layout blobs for one table, keyed by Tabulator persistence type.' },
				{ name: 'GRID_CONFIG_GET / SET / CLEAR', type: 'string', dir: 'in', note: 'The channel event names a host bridge listens for (IGridConfigGetDetail / SetDetail / ClearDetail payloads).' },
			],
		},
	],
};
