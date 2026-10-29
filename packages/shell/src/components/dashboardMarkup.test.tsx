// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Phase 5 dashboard widgets: server-rendered structure and ARIA wiring.
 * Geometry is covered by dashboardHelpers.test.ts; the charts' measured
 * SVG and hover layer are covered by the browser harness.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFeed } from './activity-feed/ActivityFeed';
import { BarChart } from './chart/BarChart';
import { ChartCard, ChartTable } from './chart/ChartCard';
import { LineChart } from './chart/LineChart';
import { Sparkline } from './chart/Sparkline';
import { DashboardGrid, DashboardGridItem } from './dashboard-grid/DashboardGrid';
import { Meter } from './meter/Meter';
import { DeltaPill, StatCard } from './stat-card/StatCard';

const DATA = {
	categories: ['Mon', 'Tue', 'Wed'],
	series: [
		{ id: 'runs', label: 'Runs', values: [1200, 1350, null] },
		{ id: 'errors', label: 'Errors', values: [12, 9, 30] },
	],
};

test('StatCard: labelled group, formatted value, spoken delta, sparkline image', () => {
	const html = renderToStaticMarkup(<StatCard label="Pipeline runs" value={12900} delta={-3.06} deltaLabel="vs last week" trend={[10, 12, 11, 14]} />);
	const labelledBy = /role="group" aria-labelledby="([^"]+)"/.exec(html)?.[1];
	assert.ok(labelledBy && html.includes(`<span id="${labelledBy}">Pipeline runs</span>`));
	assert.ok(html.includes('12.9K'));
	assert.ok(html.includes('rr-delta--bad') && html.includes('down 3.1%') && html.includes('vs last week'));
	assert.ok(html.includes('role="img" aria-label="Pipeline runs trend: 10 to 14, low 10, high 14"'));

	const latency = renderToStaticMarkup(<DeltaPill delta={-8} isIncreaseGood={false} />);
	assert.ok(latency.includes('rr-delta--good'), 'latency going down is good');

	const loading = renderToStaticMarkup(<StatCard label="Cost" value={0} isLoading hero />);
	assert.ok(loading.includes('aria-busy="true"') && loading.includes('rr-skeleton') && !loading.includes('rr-stat__value'));
});

test('Sparkline: one image, line plus accented end dot', () => {
	const html = renderToStaticMarkup(<Sparkline values={[3, 5, 4]} label="Tokens" area />);
	assert.ok(html.startsWith('<span class="rr-sparkline" role="img" aria-label="Tokens: 3 to 4, low 3, high 5"'));
	assert.ok(html.includes('aria-hidden="true"') && html.includes('rr-sparkline__area') && html.includes('rr-sparkline__dot'));
});

test('Meter: role meter with value text; status line from the warning threshold', () => {
	const normal = renderToStaticMarkup(<Meter label="Tokens this month" value={400000} max={1000000} />);
	assert.ok(normal.includes('role="meter"') && normal.includes('aria-valuenow="400000"') && normal.includes('aria-valuetext="400K of 1M"'));
	assert.ok(!normal.includes('rr-meter__status'));
	const danger = renderToStaticMarkup(<Meter label="Seats" value={20} max={20} hint="Upgrade for more" />);
	assert.ok(danger.includes('rr-meter--danger') && danger.includes('At limit') && danger.includes('aria-valuetext="20 of 20, at limit"') && danger.includes('Upgrade for more'));
});

test('LineChart and BarChart: focusable labelled chart group, legend for two series, no SVG before measuring', () => {
	const line = renderToStaticMarkup(<LineChart data={DATA} label="Runs per day" area />);
	assert.ok(line.includes('tabindex="0" role="group" aria-roledescription="chart" aria-label="Runs per day"'));
	assert.ok(line.includes('aria-label="Runs per day legend"') && line.includes('rr-chart__key--line'));
	assert.ok(line.includes('var(--rr-chart-series-2)'), 'second series takes slot 2');
	assert.ok(line.includes('aria-live="polite"'));
	assert.ok(!line.includes('<svg'), 'the plot draws after it is measured');

	const single = renderToStaticMarkup(<BarChart data={{ categories: ['a'], series: [DATA.series[0]] }} label="Runs" />);
	assert.ok(!single.includes('rr-chart__legend'), 'one series needs no legend');
	const forced = renderToStaticMarkup(<BarChart data={DATA} label="Runs" stacked showLegend={false} />);
	assert.ok(!forced.includes('rr-chart__legend'));
});

test('ChartCard: labelled section, Chart/Table switch with data, states replace the chart', () => {
	const html = renderToStaticMarkup(
		<ChartCard title="Runs" subtitle="Last 7 days" headline="3,901" data={DATA}>
			<span id="chart">chart</span>
		</ChartCard>
	);
	const labelledBy = /<section class="rr-paper rr-chart-card" aria-labelledby="([^"]+)"/.exec(html)?.[1];
	assert.ok(labelledBy && html.includes(`<h2 id="${labelledBy}" class="rr-chart-card__title">Runs</h2>`));
	assert.ok(html.includes('id="chart"') && html.includes('>Chart<') && html.includes('>Table<'));

	const loading = renderToStaticMarkup(
		<ChartCard title="Runs" data={DATA} isLoading>
			<span id="chart" />
		</ChartCard>
	);
	assert.ok(loading.includes('aria-busy="true"') && !loading.includes('id="chart"') && !loading.includes('>Table<'));

	const failed = renderToStaticMarkup(
		<ChartCard title="Runs" error="Could not load runs" onRetry={() => undefined}>
			<span />
		</ChartCard>
	);
	assert.ok(failed.includes('role="alert"') && failed.includes('Could not load runs') && failed.includes('Retry'));

	const empty = renderToStaticMarkup(
		<ChartCard title="Runs" isEmpty>
			<span id="chart" />
		</ChartCard>
	);
	assert.ok(empty.includes('No data for this period') && !empty.includes('id="chart"'));
});

test('ChartTable: one row per category, one column per series, gaps as a dash', () => {
	const html = renderToStaticMarkup(<ChartTable data={DATA} caption="Runs per day" />);
	assert.ok(html.includes('Runs per day') && html.includes('>Period<') && html.includes('>Errors<'));
	assert.equal(html.split('<tr').length - 1, 4, 'header plus three rows');
	assert.ok(html.includes('1,350') && html.includes('–'));
});

test('ActivityFeed: day headings, ordered lists, time elements, load more', () => {
	const now = new Date(2026, 9, 29, 18, 0);
	const items = [
		{ id: '1', actor: 'Dana Reyes', title: 'deployed rag-pipeline', timestamp: new Date(2026, 9, 29, 17, 55) },
		{ id: '2', title: 'Run failed on ingest', tone: 'error' as const, description: 'Timeout after 30s', timestamp: new Date(2026, 9, 28, 9, 0) },
	];
	const html = renderToStaticMarkup(<ActivityFeed items={items} now={now} hasMore onLoadMore={() => undefined} />);
	assert.ok(html.includes('<section class="rr-activity" aria-label="Activity">'));
	assert.ok(html.includes('<h3 class="rr-activity__day">Today</h3>') && html.includes('>Yesterday</h3>'));
	assert.equal(html.split('<ol').length - 1, 2);
	assert.ok(html.includes('5 minutes ago') && /<time datetime="[^"]+" title="[^"]+">/i.test(html));
	assert.ok(html.includes('rr-activity__marker--error') && html.includes('Timeout after 30s'));
	assert.ok(html.includes('Load more'));

	const flat = renderToStaticMarkup(<ActivityFeed items={items} now={now} groupByDay={false} />);
	assert.ok(!flat.includes('rr-activity__day') && !flat.includes('Load more'));
	assert.ok(renderToStaticMarkup(<ActivityFeed items={[]} />).includes('No activity yet'));
});

test('DashboardGrid: span classes, auto-fit mode, optional region label', () => {
	const html = renderToStaticMarkup(
		<DashboardGrid label="Overview">
			<DashboardGridItem span={8}>a</DashboardGridItem>
			<DashboardGridItem span={4} rowSpan={2}>
				b
			</DashboardGridItem>
		</DashboardGrid>
	);
	assert.ok(html.includes('role="region" aria-label="Overview"'));
	assert.ok(html.includes('rr-dashboard-grid__item--span-8') && html.includes('grid-row:span 2'));
	const auto = renderToStaticMarkup(<DashboardGrid minItemWidth={200}>x</DashboardGrid>);
	assert.ok(auto.includes('rr-dashboard-grid--auto') && auto.includes('--rr-dashboard-min:200px') && !auto.includes('role='));
});
