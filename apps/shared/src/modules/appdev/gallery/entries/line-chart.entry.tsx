// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for LineChart. */

import React from 'react';
import { LineChart } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';
import { RUNS_BY_PIPELINE } from './dashboard-demo-data';

/** Live demo: runs per day, one to three pipelines. */
const LineChartDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const data = { categories: RUNS_BY_PIPELINE.categories, series: RUNS_BY_PIPELINE.series.slice(0, Number(knobs.series)) };
	return (
		<div style={{ maxWidth: 640 }}>
			<LineChart data={data} label="Runs per day" area={Boolean(knobs.area)} includeZero={Boolean(knobs.includeZero)} />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let extra = '';
	if (knobs.area) extra += ' area';
	if (!knobs.includeZero) extra += ' includeZero={false}';
	return `import { LineChart } from 'shell';
import type { IChartData } from 'shell';

const data: IChartData = {
	categories: ['Oct 16', 'Oct 17', /* ... */ 'Oct 29'],
	series: [
		{ id: 'rag', label: 'rag-pipeline', values: [820, 860, /* ... */ 1284] },
		{ id: 'ingest', label: 'doc-ingest', values: [410, null, /* gap */ 640] },
	],
};

<LineChart data={data} label="Runs per day"${extra} />`;
}

/** The LineChart gallery entry. */
export const lineChartEntry: IGalleryEntry = {
	id: 'line-chart',
	name: 'LineChart',
	group: 'dashboards',
	blurb: 'Change over time for one to six series, as lines or areas. Token-colored SVG with no chart library: it re-themes with the shell, sizes to its container, and is readable by keyboard.',
	doc: 'Colors come from the ordered `--rr-chart-series-1..6` palette and follow each series\' position, so keep series order stable when filtering; a seventh series folds into "Other". `null` is a gap, not zero. Hover (or focus the plot and use the arrow keys) to read every series at a category; the reading is announced. One y axis only: plot measures of different scale as separate charts. Wrap it in a ChartCard with `data` for the title, states and a table view.',
	knobs: [
		{ id: 'series', label: 'Series', kind: 'select', options: ['1', '2', '3'], defaultValue: '3' },
		{ id: 'area', label: 'Area', kind: 'boolean', defaultValue: false },
		{ id: 'includeZero', label: 'Include zero', kind: 'boolean', defaultValue: true },
	],
	demo: LineChartDemo,
	code: buildCode,
	props: [
		{ name: 'data', type: 'IChartData', dir: 'in', required: true, note: '{ categories, series: [{ id, label, values }] }.' },
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Accessible name.' },
		{ name: 'height', type: 'number', dir: 'in', note: 'Default 220.' },
		{ name: 'area', type: 'boolean', dir: 'in', note: '10% wash under each line.' },
		{ name: 'includeZero', type: 'boolean', dir: 'in', note: 'Default true.' },
		{ name: 'showLegend', type: 'boolean', dir: 'in', note: 'Default: two or more series.' },
		{ name: 'formatValue / formatTick', type: '(value: number) => string', dir: 'in', note: 'Tooltip values / y-axis ticks.' },
	],
};
