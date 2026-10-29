// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for StatCard and DeltaPill. */

import React from 'react';
import { DashboardGrid, StatCard } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';
import { LATENCY, RUNS_BY_PIPELINE } from './dashboard-demo-data';

/** Daily totals across the demo pipelines. */
const RUN_TOTALS = RUNS_BY_PIPELINE.categories.map((_, index) => RUNS_BY_PIPELINE.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0));

/** Live demo: a KPI row - runs (up is good), latency (down is good), cost. */
const StatCardDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const isLoading = Boolean(knobs.loading);
	let trend: number[] | undefined = RUN_TOTALS;
	let latencyTrend: number[] | undefined = LATENCY;
	if (!knobs.trend) {
		trend = undefined;
		latencyTrend = undefined;
	}
	return (
		<DashboardGrid minItemWidth={200}>
			<StatCard label="Pipeline runs" value={RUN_TOTALS[RUN_TOTALS.length - 1] * 7} delta={12.4} deltaLabel="vs last week" trend={trend} isLoading={isLoading} hero={Boolean(knobs.hero)} />
			<StatCard label="p95 latency" value={504} unit="ms" delta={-8.2} deltaLabel="vs last week" isIncreaseGood={false} trend={latencyTrend} isLoading={isLoading} />
			<StatCard label="Spend this month" value="$4,210" delta={0.02} deltaLabel="vs last month" isLoading={isLoading} />
		</DashboardGrid>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let extra = '';
	if (knobs.trend) extra += '\n\ttrend={dailyRuns}';
	if (knobs.hero) extra += '\n\thero';
	if (knobs.loading) extra += '\n\tisLoading={isLoading}';
	return `import { computeDelta, StatCard } from 'shell';

<StatCard
	label="Pipeline runs"
	value={runsThisWeek}
	delta={computeDelta(runsThisWeek, runsLastWeek)}
	deltaLabel="vs last week"${extra}
/>

// Latency, cost, error rate: a rise is bad news.
<StatCard label="p95 latency" value={504} unit="ms" delta={-8.2} isIncreaseGood={false} />`;
}

/** The StatCard gallery entry. */
export const statCardEntry: IGalleryEntry = {
	id: 'stat-card',
	name: 'StatCard',
	group: 'dashboards',
	blurb: 'One KPI tile: label, value, change against a named period, and an optional sparkline. Numbers are formatted compactly (1,284 / 12.9K / 4.2M).',
	doc: 'Set `isIncreaseGood={false}` for latency, cost and error rate so the delta pill reads as good news when they fall. The number stays in the primary text color on every theme; the tint and arrow carry the tone, and the direction is spoken ("down 8.2%"). Use `hero` for the one headline metric on a view. `DeltaPill` is exported for deltas elsewhere (a table cell, a ChartCard headline).',
	knobs: [
		{ id: 'trend', label: 'Trend', kind: 'boolean', defaultValue: true },
		{ id: 'hero', label: 'Hero', kind: 'boolean', defaultValue: false },
		{ id: 'loading', label: 'Loading', kind: 'boolean', defaultValue: false },
	],
	demo: StatCardDemo,
	code: buildCode,
	props: [
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Sentence case, no colon.' },
		{ name: 'value', type: 'number | string', dir: 'in', required: true, note: 'Numbers go through formatValue.' },
		{ name: 'formatValue', type: '(value: number) => string', dir: 'in', note: 'Default formatCompact.' },
		{ name: 'unit', type: 'string', dir: 'in', note: 'After the value ("ms").' },
		{ name: 'delta', type: 'number | null', dir: 'in', note: 'Percent change; see computeDelta.' },
		{ name: 'deltaLabel', type: 'string', dir: 'in', note: 'The comparison period.' },
		{ name: 'isIncreaseGood', type: 'boolean', dir: 'in', note: 'Default true.' },
		{ name: 'trend', type: 'number[]', dir: 'in', note: 'Recent values, oldest first.' },
		{ name: 'icon / footer', type: 'ReactNode', dir: 'in', note: 'Beside the label / under the tile.' },
		{ name: 'isLoading', type: 'boolean', dir: 'in', note: 'Skeletons in place of the value.' },
		{ name: 'hero', type: 'boolean', dir: 'in', note: '48px value; one per view.' },
	],
};
