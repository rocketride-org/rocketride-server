// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BarChart — compare magnitudes across categories (runs per pipeline, cost
 * per model, errors per day). Grouped by default; `stacked` shows parts of
 * a total (positive values only).
 *
 * Marks follow the dashboard spec: columns at most 24px thick with a 4px
 * rounded data end and a square base, a 2px surface gap between touching
 * bars and between stacked segments, one zero baseline. Colors come from
 * the ordered chart series palette (SERIES_TOKENS); more than six series fold into
 * "Other".
 *
 * Hover or focus the plot to read every series in a category; the reading
 * is announced for screen readers.
 *
 * Built on `.rr-chart` from components.css.
 */

import React from 'react';
import { formatAxisTick, formatCompact } from './chartFormat';
import { ChartFrame, IChartGeometry } from './ChartFrame';
import { BAR_GAP, buildBarPath, foldSeries, getValueExtent, groupedBarLayout, IChartData, MAX_BAR_THICKNESS, seriesColor } from './chartMath';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link BarChart} component. */
export interface IBarChartProps {
	/** Categories and series. */
	data: IChartData;
	/** Accessible name ("Runs per pipeline"). */
	label: string;
	/** Height in px. Defaults to 220. */
	height?: number;
	/** Stack series into one column per category (positive values). */
	stacked?: boolean;
	/** Show the legend. Defaults to true for two or more series. */
	showLegend?: boolean;
	/** Formats tooltip values. Defaults to {@link formatCompact}. */
	formatValue?: (value: number) => string;
	/** Formats y-axis ticks. Defaults to {@link formatAxisTick}. */
	formatTick?: (value: number) => string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * A square-cornered rectangle path (stacked segments below the top one).
 *
 * @param x - Left edge.
 * @param width - Width.
 * @param y0 - Lower edge y.
 * @param y1 - Upper edge y.
 * @returns The `d` attribute, or `''` when too thin to draw.
 */
function rectPath(x: number, width: number, y0: number, y1: number): string {
	if (y0 - y1 < 0.5) return '';
	return `M${x},${y0}V${y1}H${x + width}V${y0}Z`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a responsive grouped or stacked column chart.
 *
 * @param props - {@link IBarChartProps}.
 * @returns The chart.
 */
export function BarChart({ data, label, height = 220, stacked = false, showLegend, formatValue = formatCompact, formatTick = formatAxisTick }: IBarChartProps): React.ReactElement {
	const folded: IChartData = { categories: data.categories, series: foldSeries(data.series) };
	const extent = getValueExtent(folded.series, { stacked, includeZero: true });

	let isLegendShown = folded.series.length > 1;
	if (showLegend !== undefined) isLegendShown = showLegend;

	/** Draws one group (or one stack) of bars per category. */
	function renderMarks(geometry: IChartGeometry): React.ReactNode {
		const band = geometry.band;
		if (!band) return null;
		return folded.categories.map((category, categoryIndex) => {
			const bandStart = band.start(categoryIndex);

			if (stacked) {
				const thickness = Math.max(1, Math.min(MAX_BAR_THICKNESS, band.bandwidth));
				const x = bandStart + (band.bandwidth - thickness) / 2;
				const values = folded.series.map((series) => Math.max(0, series.values[categoryIndex] ?? 0));
				let topIndex = -1;
				values.forEach((value, index) => {
					if (value > 0) topIndex = index;
				});
				let total = 0;
				let drawn = 0;
				return (
					<g key={category}>
						{values.map((value, seriesIndex) => {
							if (value <= 0) return null;
							let lower = geometry.y(total);
							if (drawn > 0) lower -= BAR_GAP;
							total += value;
							drawn += 1;
							const upper = geometry.y(total);
							let d = rectPath(x, thickness, lower, upper);
							if (seriesIndex === topIndex) d = buildBarPath(x, thickness, lower, upper);
							return <path key={folded.series[seriesIndex].id} className="rr-chart__bar" d={d} style={{ fill: seriesColor(seriesIndex) }} />;
						})}
					</g>
				);
			}

			const { thickness, offsets } = groupedBarLayout(bandStart, band.bandwidth, folded.series.length);
			return (
				<g key={category}>
					{folded.series.map((series, seriesIndex) => {
						const value = series.values[categoryIndex];
						if (value === null || value === undefined) return null;
						return <path key={series.id} className="rr-chart__bar" d={buildBarPath(offsets[seriesIndex], thickness, geometry.baselineY, geometry.y(value))} style={{ fill: seriesColor(seriesIndex) }} />;
					})}
				</g>
			);
		});
	}

	return <ChartFrame data={folded} label={label} height={height} extent={extent} xMode="band" legendShape="square" showLegend={isLegendShown} formatValue={formatValue} formatTick={formatTick} renderMarks={renderMarks} />;
}
