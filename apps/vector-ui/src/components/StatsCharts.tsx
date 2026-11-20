// =============================================================================
// MIT License
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
// VECTOR-UI — StatsCharts (the stats strip's Charts disclosure)
// =============================================================================
//
// Four small charts over what the console already holds: chunks per document
// (log bins), chunk length (from the map's sample), documents by file type and
// ingested over time, each with its source and coverage in the caption, a
// text alternative, and bars that scope the directory when clicked. No calls.
//
// Each chart is an inline SVG picture (role="img", its summary as the label
// and the <title>) under a row of real buttons, one per bar the store can be
// asked for (a chunk range, a file type, a period), and a visually hidden
// table with every bin. Colours come from vector/chartTokens.ts, measured in
// the six shipped themes; the bar the scope selected is outlined as well as
// coloured. Under 140 px each.
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { IDocumentsFilter, StatsChartsProps as ContractStatsChartsProps } from '../contract/types';
import { collectionCharts } from '../vector/charts';
import type { IBin, IChart } from '../vector/charts';
import { CHART_ACTIVE_TOKEN, CHART_AXIS_TOKEN, CHART_BAR_TOKEN, CHART_SKELETON_TOKEN, CHART_TEXT_TOKEN } from '../vector/chartTokens';
import { sameFilter } from '../vector/filters';
import { FOCUS_RING } from '../styles';

/** The frozen props plus the strip's own (optional, so the frozen mount still renders). */
export interface StatsChartsProps extends ContractStatsChartsProps {
	/** The directory is still loading pages (skeleton bars until it has rows). */
	loading?: boolean;
	/** The scope's conditions, to mark the bar they select. */
	scope?: IDocumentsFilter | null;
}

export type { ContractStatsChartsProps };

/** The picture's height in px (each chart stays under 140 px with its caption and labels). */
const PLOT_HEIGHT = 72;

/** Visually hidden, still read by assistive technology. */
const HIDDEN: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

/** What a bin's bar is called in words ('4–7 chunks', 'pdf', 'week of 2026-08-03'). */
function binWords(chart: IChart, bin: IBin): string {
	if (chart.id === 'chunks') return `${bin.label} ${bin.hi === 1 ? 'chunk' : 'chunks'}`;
	if (chart.id === 'length') return `${bin.label} characters`;
	return bin.label;
}

/** A count with the chart's unit. */
function countWords(chart: IChart, n: number): string {
	const one = chart.unit.replace(/s$/, '');
	return `${n.toLocaleString('en-US')} ${n === 1 ? one : chart.unit}`;
}

/**
 * Whether a bin's scope is the one the console has (every key of the bin's scope equal in the scope).
 *
 * @param bin - The bin.
 * @param scope - The scope's conditions.
 * @returns True when the bar is the selected one.
 */
export function binSelected(bin: IBin, scope: IDocumentsFilter | null | undefined): boolean {
	if (!bin.scope || !scope) return false;
	const picked: IDocumentsFilter = {};
	for (const key of Object.keys(bin.scope) as Array<keyof IDocumentsFilter>) (picked as Record<string, unknown>)[key] = scope[key];
	return sameFilter(picked, bin.scope);
}

/**
 * One chart.
 *
 * @param props - The chart, the scope and the click handler.
 * @returns The figure.
 */
function Chart({ chart, scope, onScope }: { chart: IChart; scope: IDocumentsFilter | null; onScope?: (filter: IDocumentsFilter) => void }): React.ReactElement {
	const text: CSSProperties = { color: `var(${CHART_TEXT_TOKEN})`, fontSize: 11.5, lineHeight: 1.4 };
	const head = (
		<figcaption style={{ ...text, display: 'flex', flexDirection: 'column' }}>
			<strong style={{ fontSize: 12 }}>{chart.title}</strong>
			{chart.caption !== '' && chart.disabled === null && <span>{chart.caption}</span>}
		</figcaption>
	);
	if (chart.disabled !== null) {
		return (
			<figure style={{ margin: 0, minWidth: 0 }} data-chart={chart.id}>
				{head}
				<p role="note" style={{ ...text, margin: '6px 0 0' }}>
					{chart.disabled}
				</p>
			</figure>
		);
	}
	if (chart.loading && chart.bins.length === 0) {
		return (
			<figure style={{ margin: 0, minWidth: 0 }} data-chart={chart.id}>
				{head}
				<svg aria-hidden="true" width="100%" height={PLOT_HEIGHT} viewBox="0 0 80 100" preserveAspectRatio="none" style={{ display: 'block' }}>
					{[30, 55, 80, 45, 25, 15, 10, 5].map((h, i) => (
						<rect key={i} x={i * 10 + 1} y={100 - h} width={8} height={h} fill={`var(${CHART_SKELETON_TOKEN})`} />
					))}
				</svg>
				<p role="status" style={{ ...text, margin: '2px 0 0' }}>
					Loading documents…
				</p>
			</figure>
		);
	}
	const n = Math.max(1, chart.bins.length);
	const max = Math.max(1, ...chart.bins.map((b) => b.count));
	const clickable = onScope !== undefined && chart.bins.some((b) => b.scope !== null && b.count > 0);
	const first = chart.bins[0];
	const last = chart.bins[chart.bins.length - 1];
	return (
		<figure style={{ margin: 0, minWidth: 0 }} data-chart={chart.id}>
			{head}
			<div style={{ position: 'relative', height: PLOT_HEIGHT, marginTop: 4 }}>
				<svg role="img" aria-label={chart.summary} width="100%" height={PLOT_HEIGHT} viewBox={`0 0 ${n * 10} 100`} preserveAspectRatio="none" style={{ display: 'block' }}>
					<title>{chart.summary}</title>
					{chart.bins.map((bin, i) => {
						const selected = binSelected(bin, scope);
						const h = bin.count === 0 ? 0 : Math.max(3, (bin.count / max) * 98);
						return <rect key={bin.key} x={i * 10 + 1} y={100 - h} width={8} height={h} fill={selected ? `var(${CHART_ACTIVE_TOKEN})` : `var(${CHART_BAR_TOKEN})`} stroke={selected ? `var(${CHART_TEXT_TOKEN})` : 'none'} strokeWidth={selected ? 1.5 : 0} vectorEffect="non-scaling-stroke" data-selected={selected ? '' : undefined} />;
					})}
					<line x1={0} y1={99.5} x2={n * 10} y2={99.5} stroke={`var(${CHART_AXIS_TOKEN})`} strokeWidth={1} vectorEffect="non-scaling-stroke" />
				</svg>
				{clickable && (
					<div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
						{chart.bins.map((bin) => {
							if (bin.scope === null || bin.count === 0) return <span key={bin.key} style={{ flex: 1 }} aria-hidden="true" />;
							const words = `${binWords(chart, bin)}: ${countWords(chart, bin.count)}. Scope the documents to these`;
							return <button key={bin.key} type="button" aria-label={words} aria-pressed={binSelected(bin, scope)} title={words} style={{ flex: 1, minWidth: 0, padding: 0, background: 'transparent', border: 'none', cursor: 'pointer' }} onClick={() => bin.scope && onScope?.(bin.scope)} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')} />;
						})}
					</div>
				)}
			</div>
			{first && last && (
				<div aria-hidden="true" style={{ ...text, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
					<span>{first.label}</span>
					{last !== first && <span>{last.label}</span>}
				</div>
			)}
			<table style={HIDDEN}>
				<caption>{`${chart.title}: ${chart.caption}`}</caption>
				<thead>
					<tr>
						<th scope="col">{chart.id === 'chunks' ? 'Chunks' : chart.id === 'length' ? 'Characters' : chart.id === 'types' ? 'File type' : 'Period'}</th>
						<th scope="col">{chart.unit === 'chunks' ? 'Chunks' : 'Documents'}</th>
					</tr>
				</thead>
				<tbody>
					{chart.bins.map((bin) => (
						<tr key={bin.key}>
							<td>{bin.label}</td>
							<td>{bin.count.toLocaleString('en-US')}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}

/**
 * The collection's charts.
 *
 * @param props - {@link StatsChartsProps}.
 * @returns The section.
 */
function StatsChartsView({ rows, total = null, sample = null, dialect = null, onScope, loading = false, scope = null }: StatsChartsProps): React.ReactElement {
	// Re-binned only when what the charts read changes (a page, the sample), not on the strip's clock.
	const charts = useMemo(() => collectionCharts({ rows, total, sample, dialect, loading }), [rows, total, sample, dialect, loading]);
	if (rows.length === 0 && !loading && sample === null) {
		return (
			<section aria-label="Collection charts" data-component="StatsCharts">
				<p role="note" style={{ color: `var(${CHART_TEXT_TOKEN})`, fontSize: 12, margin: '6px 0' }}>
					No documents to chart yet.
				</p>
			</section>
		);
	}
	return (
		<section aria-label="Collection charts" data-component="StatsCharts" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px 18px', padding: '8px 0 4px' }}>
			{charts.map((chart) => (
				<Chart key={chart.id} chart={chart} scope={scope} onScope={chart.id === 'length' ? undefined : onScope} />
			))}
		</section>
	);
}

/** The charts, drawn again only when what they read changes (a page, the sample, the scope), never on the strip's clock. */
export const StatsCharts = React.memo(StatsChartsView);

export default StatsCharts;
