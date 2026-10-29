// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Table. */

import React from 'react';
import { StatusBadge, Table } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** A demo row. */
interface IStageRow {
	id: string;
	stage: string;
	status: 'success' | 'error';
	tokens: number;
	duration: number | null;
}

/** The demo's rows. */
const ROWS: IStageRow[] = [
	{ id: '1', stage: 'Ingest', status: 'success', tokens: 0, duration: 1.8 },
	{ id: '2', stage: 'Embed', status: 'success', tokens: 48210, duration: 6.2 },
	{ id: '3', stage: 'Retrieve', status: 'success', tokens: 1204, duration: 0.4 },
	{ id: '4', stage: 'Generate', status: 'error', tokens: 3310, duration: null },
];

/** Status cell: ok or failed. */
function renderStatus(row: IStageRow): React.ReactNode {
	let text = 'ok';
	if (row.status === 'error') text = 'failed';
	return <StatusBadge variant={row.status}>{text}</StatusBadge>;
}

/** Live demo: a run's stages, sortable. */
const TableDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	let onRowClick: ((row: IStageRow) => void) | undefined;
	if (knobs.clickable) onRowClick = () => undefined;
	return (
		<div className="rr-paper" style={{ maxWidth: 520 }}>
			<Table<IStageRow>
				caption="Run stages"
				rows={ROWS}
				getRowId={(row) => row.id}
				dense={Boolean(knobs.dense)}
				defaultSort={{ columnId: 'tokens', direction: 'desc' }}
				onRowClick={onRowClick}
				columns={[
					{ id: 'stage', header: 'Stage', value: (row) => row.stage, sortable: true },
					{ id: 'status', header: 'Status', render: renderStatus },
					{ id: 'tokens', header: 'Tokens', value: (row) => row.tokens, sortable: true, align: 'right', mono: true },
					{ id: 'duration', header: 'Time (s)', value: (row) => row.duration, sortable: true, align: 'right', mono: true },
				]}
			/>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.dense) attrs += '\n\tdense';
	if (knobs.clickable) attrs += '\n\tonRowClick={openStage}';
	return `import { Table } from 'shell';

<Table
	caption="Run stages"
	rows={stages}
	getRowId={(row) => row.id}
	defaultSort={{ columnId: 'tokens', direction: 'desc' }}${attrs}
	columns={[
		{ id: 'stage', header: 'Stage', value: (row) => row.stage, sortable: true },
		{ id: 'tokens', header: 'Tokens', value: (row) => row.tokens, sortable: true, align: 'right', mono: true },
	]}
/>`;
}

/** The Table gallery entry. */
export const tableEntry: IGalleryEntry = {
	id: 'table',
	name: 'Table',
	group: 'content',
	blurb: 'Small, static table with sortable columns and optional clickable rows. Empty values sort last; strings sort naturally.',
	docNote: 'For large, remote, paged, filterable or user-configurable data use DataGrid - Table renders every row it is given.',
	knobs: [
		{ id: 'dense', label: 'Dense', kind: 'boolean', defaultValue: false },
		{ id: 'clickable', label: 'Clickable rows', kind: 'boolean', defaultValue: false },
	],
	demo: TableDemo,
	code: buildCode,
	props: [
		{ name: 'columns', type: 'ITableColumn<T>[]', dir: 'in', required: true, note: '{ id, header, value?, render?, sortable?, align?, mono?, width? }.' },
		{ name: 'rows / getRowId', type: 'T[] / (row) => string', dir: 'in', required: true, note: 'Data and stable keys.' },
		{ name: 'sort / defaultSort', type: 'ITableSort | null', dir: 'in', note: 'Active sort, controlled / uncontrolled.' },
		{ name: 'caption', type: 'string', dir: 'in', note: 'Accessible name (visually hidden caption).' },
		{ name: 'emptyText / dense', type: 'ReactNode / boolean', dir: 'in', note: 'Empty state; tighter cells.' },
		{ name: 'onSortChange', type: '(sort: ITableSort) => void', dir: 'out', note: 'Fired with the new sort.' },
		{ name: 'onRowClick', type: '(row: T) => void', dir: 'out', note: 'Makes rows clickable and Enter-activatable.' },
	],
};
