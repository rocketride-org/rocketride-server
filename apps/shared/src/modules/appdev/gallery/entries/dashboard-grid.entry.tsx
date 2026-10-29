// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for DashboardGrid: a whole dashboard from the phase 5 widgets. */

import React from 'react';
import { ActivityFeed, BarChart, ChartCard, DashboardGrid, DashboardGridItem, LineChart, Meter, StatCard } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';
import { ACTIVITY, DEMO_NOW, LATENCY, RUNS_BY_PIPELINE, TOKENS_BY_MODEL } from './dashboard-demo-data';

/** Live demo: KPI row, two charts, a usage panel and the feed, in a resizable frame. */
const DashboardGridDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ width: `${Number(knobs.width)}px`, maxWidth: '100%', resize: 'horizontal', overflow: 'auto', padding: 4 }}>
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
			<DashboardGrid minItemWidth={180} label="Key metrics">
				<StatCard label="Pipeline runs" value={15498} delta={12.4} deltaLabel="vs last week" trend={[9, 10, 11, 10, 12, 13, 14]} />
				<StatCard label="p95 latency" value={504} unit="ms" delta={-8.2} deltaLabel="vs last week" isIncreaseGood={false} trend={LATENCY} />
				<StatCard label="Error rate" value="0.42%" delta={18} deltaLabel="vs last week" isIncreaseGood={false} />
				<StatCard label="Spend this month" value="$4,210" delta={0.02} deltaLabel="vs last month" />
			</DashboardGrid>
			<DashboardGrid label="Details">
				<DashboardGridItem span={8}>
					<ChartCard title="Runs per day" subtitle="Last 14 days" data={RUNS_BY_PIPELINE}>
						<LineChart data={RUNS_BY_PIPELINE} label="Runs per day" />
					</ChartCard>
				</DashboardGridItem>
				<DashboardGridItem span={4} rowSpan={2}>
					<div className="rr-paper rr-paper--padded">
						<h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Recent activity</h3>
						<ActivityFeed items={ACTIVITY} now={DEMO_NOW} headingLevel={4} />
					</div>
				</DashboardGridItem>
				<DashboardGridItem span={4}>
					<ChartCard title="Tokens by model" subtitle="This week (millions)" data={TOKENS_BY_MODEL}>
						<BarChart data={TOKENS_BY_MODEL} label="Tokens by model" stacked height={180} />
					</ChartCard>
				</DashboardGridItem>
				<DashboardGridItem span={4}>
					<div className="rr-paper rr-paper--padded" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
						<h3 style={{ margin: 0, fontSize: 14 }}>Plan usage</h3>
						<Meter label="Tokens this month" value={8200000} max={10000000} hint="Resets Nov 1" />
						<Meter label="Concurrent runs" value={3} max={10} />
					</div>
				</DashboardGridItem>
			</DashboardGrid>
		</div>
	</div>
);

/** Snippet builder. */
function buildCode(_knobs: KnobValues): string {
	return `import { DashboardGrid, DashboardGridItem, StatCard, ChartCard, LineChart } from 'shell';

// A row of KPIs: as many columns as fit, each at least 180px.
<DashboardGrid minItemWidth={180}>
	<StatCard label="Pipeline runs" value={runs} delta={12.4} deltaLabel="vs last week" />
	<StatCard label="p95 latency" value={504} unit="ms" delta={-8.2} isIncreaseGood={false} />
</DashboardGrid>

// The 12-column grid: spans widen as the GRID narrows (container queries).
<DashboardGrid>
	<DashboardGridItem span={8}>
		<ChartCard title="Runs per day" data={data}><LineChart data={data} label="Runs per day" /></ChartCard>
	</DashboardGridItem>
	<DashboardGridItem span={4} rowSpan={2}>{feed}</DashboardGridItem>
</DashboardGrid>`;
}

/** The DashboardGrid gallery entry. */
export const dashboardGridEntry: IGalleryEntry = {
	id: 'dashboard-grid',
	name: 'DashboardGrid',
	group: 'dashboards',
	blurb: "The layout of a dashboard: a 12-column grid of DashboardGridItems, or auto-fit columns for a row of StatCards. Breakpoints follow the grid's own width.",
	doc: "Spans of 3 and 4 widen to 6 (and 8 to 12) when the grid is narrower than 960px; under 600px every item takes the full row. These are container queries on the grid, so it behaves the same in a page, a side panel or a webview and never disagrees with the shell's viewport breakpoint. Drag the frame's corner, or set the width knob, to watch it reflow. Wrap it in a PageLayout for the page header.",
	knobs: [{ id: 'width', label: 'Frame width', kind: 'number', defaultValue: 1100 }],
	demo: DashboardGridDemo,
	code: buildCode,
	props: [
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'DashboardGridItems, or widgets in auto-fit mode.' },
		{ name: 'minItemWidth', type: 'number', dir: 'in', note: 'Auto-fit mode: narrowest column (px).' },
		{ name: 'label', type: 'string', dir: 'in', note: 'Makes the grid a labelled region.' },
	],
	sections: [
		{
			label: 'DashboardGridItem',
			rows: [
				{ name: 'span', type: '3 | 4 | 6 | 8 | 12', dir: 'in', note: 'Columns out of 12. Default 12.' },
				{ name: 'rowSpan', type: 'number', dir: 'in', note: 'Rows to span. Default 1.' },
				{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'The widget; it stretches to the row height.' },
			],
		},
	],
};
