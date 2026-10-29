// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for ChartCard and ChartTable. */

import React, { useState } from 'react';
import { ChartCard, DeltaPill, LineChart, ToggleGroup } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';
import { RUNS_BY_PIPELINE } from './dashboard-demo-data';

type Range = '7d' | '14d';

/** Live demo: a runs panel with a range picker and every state on a knob. */
const ChartCardDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [range, setRange] = useState<Range>('14d');
	let days = 14;
	if (range === '7d') days = 7;
	const data = {
		categories: RUNS_BY_PIPELINE.categories.slice(-days),
		series: RUNS_BY_PIPELINE.series.map((series) => ({ ...series, values: series.values.slice(-days) })),
	};
	const state = String(knobs.state);
	let error: string | undefined;
	if (state === 'error') error = 'Could not load runs. The metrics service did not respond.';
	return (
		<div style={{ maxWidth: 640 }}>
			<ChartCard
				title="Pipeline runs"
				subtitle={`Last ${days} days`}
				headline={
					<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
						2,214 <DeltaPill delta={9.6} />
					</span>
				}
				actions={
					<ToggleGroup
						options={[
							{ id: '7d', label: '7d' },
							{ id: '14d', label: '14d' },
						]}
						value={range}
						onChange={setRange}
					/>
				}
				data={data}
				isLoading={state === 'loading'}
				error={error}
				onRetry={() => undefined}
				isEmpty={state === 'empty'}
				footer={<span>Counts every run, including retries.</span>}
			>
				<LineChart data={data} label="Pipeline runs per day" />
			</ChartCard>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(): string {
	return `import { ChartCard, LineChart, ToggleGroup } from 'shell';

<ChartCard
	title="Pipeline runs"
	subtitle="Last 14 days"
	actions={<ToggleGroup options={RANGES} value={range} onChange={setRange} />}
	data={data}                 // adds the Chart / Table switch
	isLoading={isLoading}
	error={error}
	onRetry={refetch}
	isEmpty={data.categories.length === 0}
>
	<LineChart data={data} label="Pipeline runs per day" />
</ChartCard>`;
}

/** The ChartCard gallery entry. */
export const chartCardEntry: IGalleryEntry = {
	id: 'chart-card',
	name: 'ChartCard',
	group: 'dashboards',
	blurb: 'The panel around a chart: title, subtitle, headline, header actions and footer, plus the loading, error and empty states and a Chart / Table switch.',
	doc: "Pass the chart's `data` and the card offers a table view of every value: the accessible, copyable form of the chart, and the relief for series colors that sit below 3:1 on a surface. States take over in a fixed order: loading, then error (with Retry when `onRetry` is set), then empty. `ChartTable` renders the same table on its own.",
	knobs: [{ id: 'state', label: 'State', kind: 'select', options: ['ready', 'loading', 'error', 'empty'], defaultValue: 'ready' }],
	demo: ChartCardDemo,
	code: buildCode,
	props: [
		{ name: 'title', type: 'ReactNode', dir: 'in', required: true, note: 'Card heading.' },
		{ name: 'subtitle / headline', type: 'ReactNode', dir: 'in', note: 'Under the title / the period figure.' },
		{ name: 'actions', type: 'ReactNode', dir: 'in', note: 'A range ToggleGroup, a Menu.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'The chart.' },
		{ name: 'data', type: 'IChartData', dir: 'in', note: 'Enables the table view.' },
		{ name: 'formatValue / categoryHeader', type: 'fn / string', dir: 'in', note: 'Table values / first column header.' },
		{ name: 'isLoading / error / onRetry / isEmpty / emptyText', type: 'state', dir: 'in', note: 'Replace the chart.' },
		{ name: 'height', type: 'number', dir: 'in', note: 'State placeholder height. Default 220.' },
		{ name: 'footer', type: 'ReactNode', dir: 'in', note: 'Under the chart.' },
		{ name: 'headingLevel', type: '2 | 3 | 4', dir: 'in', note: 'Default 2.' },
	],
};
