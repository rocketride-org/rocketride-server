// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * LineChart — change over time for one to six series (runs per day, tokens
 * per hour, p95 latency). `area` adds a 10% wash under each line for a
 * single series or a few that rarely cross.
 *
 * Marks follow the dashboard spec: 2px lines with round joins, an end dot
 * with a surface ring on the latest point, gaps for `null` values. Colors
 * come from the ordered chart series palette (SERIES_TOKENS) and follow each series'
 * position; more than six series fold into "Other". One y axis only: plot
 * measures of different scale as separate charts.
 *
 * Hover or focus the plot to read every series at a category; the reading
 * is announced for screen readers. Inside a ChartCard with `data`, the same
 * values are one click away as a table.
 *
 * Built on `.rr-chart` from components.css.
 */

import React from 'react';
import { formatAxisTick, formatCompact } from './chartFormat';
import { ChartFrame, IChartGeometry } from './ChartFrame';
import { buildAreaPath, buildLinePath, ChartPoint, foldSeries, getValueExtent, IChartData, seriesColor } from './chartMath';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link LineChart} component. */
export interface ILineChartProps {
	/** Categories and series. */
	data: IChartData;
	/** Accessible name ("Runs per day"). */
	label: string;
	/** Height in px. Defaults to 220. */
	height?: number;
	/** Wash the area under each line. */
	area?: boolean;
	/** Start the y axis at zero. Defaults to true; turn off for values far from zero. */
	includeZero?: boolean;
	/** Show the legend. Defaults to true for two or more series. */
	showLegend?: boolean;
	/** Formats tooltip values. Defaults to {@link formatCompact}. */
	formatValue?: (value: number) => string;
	/** Formats y-axis ticks. Defaults to {@link formatAxisTick}. */
	formatTick?: (value: number) => string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a responsive line or area chart.
 *
 * @param props - {@link ILineChartProps}.
 * @returns The chart.
 */
export function LineChart({ data, label, height = 220, area = false, includeZero = true, showLegend, formatValue = formatCompact, formatTick = formatAxisTick }: ILineChartProps): React.ReactElement {
	const folded: IChartData = { categories: data.categories, series: foldSeries(data.series) };
	const extent = getValueExtent(folded.series, { includeZero: includeZero || area });

	let isLegendShown = folded.series.length > 1;
	if (showLegend !== undefined) isLegendShown = showLegend;

	/** Draws the areas, lines, end dots and the active dots. */
	function renderMarks(geometry: IChartGeometry, activeIndex: number): React.ReactNode {
		return folded.series.map((series, seriesIndex) => {
			const color = seriesColor(seriesIndex);
			const points: ChartPoint[] = geometry.positions.map((x, index) => {
				const value = series.values[index];
				if (value === null || value === undefined) return [x, null];
				return [x, geometry.y(value)];
			});

			let lastIndex = -1;
			for (let index = points.length - 1; index >= 0; index--) {
				if (points[index][1] !== null) {
					lastIndex = index;
					break;
				}
			}

			let activeY: number | null = null;
			if (activeIndex >= 0) activeY = points[activeIndex]?.[1] ?? null;

			return (
				<g key={series.id} className="rr-chart__series">
					{area && <path className="rr-chart__area" d={buildAreaPath(points, geometry.baselineY)} style={{ fill: color }} />}
					<path className="rr-chart__line" d={buildLinePath(points)} style={{ stroke: color }} />
					{lastIndex >= 0 && lastIndex !== activeIndex && <circle className="rr-chart__dot" cx={points[lastIndex][0]} cy={points[lastIndex][1] as number} r={4} style={{ fill: color }} />}
					{activeY !== null && <circle className="rr-chart__dot rr-chart__dot--active" cx={points[activeIndex][0]} cy={activeY} r={5} style={{ fill: color }} />}
				</g>
			);
		});
	}

	return <ChartFrame data={folded} label={label} height={height} extent={extent} xMode="point" legendShape="line" showLegend={isLegendShown} formatValue={formatValue} formatTick={formatTick} renderMarks={renderMarks} />;
}
