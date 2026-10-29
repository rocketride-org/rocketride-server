// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Chart math — the pure geometry behind Sparkline, LineChart and BarChart:
 * nice axis ticks, linear and band scales, SVG paths, hover lookup and the
 * series cap. No DOM, no React, so every rule is unit-tested in node.
 */

// =============================================================================
// TYPES
// =============================================================================

/** One series: an id (stable color key), a label and one value per category. */
export interface IChartSeries {
	/** Stable id. Color follows the id's position, so keep the order stable when filtering. */
	id: string;
	/** Legend, tooltip and table label. */
	label: string;
	/** One value per category; `null` is a gap (no data), not zero. */
	values: (number | null)[];
}

/** Data shared by LineChart, BarChart and the ChartCard table view. */
export interface IChartData {
	/** X-axis categories (dates, buckets, names), in order. */
	categories: string[];
	/** Series, in legend order. At most {@link MAX_CHART_SERIES} are drawn. */
	series: IChartSeries[];
}

/** A point in pixel space; `y` is null for a gap. */
export type ChartPoint = [x: number, y: number | null];

/** Band layout for bar charts: one band per category. */
export interface IBandLayout {
	/** Distance between band starts. */
	step: number;
	/** Usable width of one band (step minus the gap between bands). */
	bandwidth: number;
	/** Left edge of band `index`. */
	start: (index: number) => number;
	/** Center of band `index`. */
	center: (index: number) => number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Series drawn with distinct colors; more fold into "Other". Matches SERIES_TOKENS. */
export const MAX_CHART_SERIES = 6;

/** Thickest bar we draw (px). Wider bands keep the leftover as air. */
export const MAX_BAR_THICKNESS = 24;

/** Surface gap between touching bars and stacked segments (px). */
export const BAR_GAP = 2;

/** Rounded data-end radius for bars (px). */
export const BAR_RADIUS = 4;

// =============================================================================
// TICKS AND SCALES
// =============================================================================

/**
 * Picks a "nice" step (1, 2, 2.5 or 5 times a power of ten) that splits
 * `span` into about `targetCount` intervals.
 *
 * @param span - Domain width (max minus min).
 * @param targetCount - Desired number of intervals.
 * @returns The step; 1 when the span is empty.
 */
export function niceStep(span: number, targetCount: number): number {
	if (!(span > 0) || targetCount < 1) return 1;
	const raw = span / targetCount;
	const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
	const residual = raw / magnitude;
	if (residual <= 1) return magnitude;
	if (residual <= 2) return 2 * magnitude;
	if (residual <= 2.5) return 2.5 * magnitude;
	if (residual <= 5) return 5 * magnitude;
	return 10 * magnitude;
}

/**
 * Nice, evenly spaced ticks that cover `[min, max]`. The first and last
 * tick become the axis domain, so the plot always ends on a labelled line.
 *
 * @param min - Smallest data value.
 * @param max - Largest data value.
 * @param targetCount - Desired number of intervals. Defaults to 4.
 * @returns Ascending tick values (at least two).
 */
export function niceTicks(min: number, max: number, targetCount = 4): number[] {
	let low = min;
	let high = max;
	if (low === high) {
		if (low === 0) high = 1;
		if (low > 0) low = 0;
		if (high < 0) high = 0;
		if (low === high) high = low + 1;
	}
	const step = niceStep(high - low, targetCount);
	const first = Math.floor(low / step) * step;
	const last = Math.ceil(high / step) * step;
	const ticks: number[] = [];
	const count = Math.round((last - first) / step);
	for (let index = 0; index <= count; index++) {
		// Round away float noise (0.1 + 0.2) so labels stay clean.
		ticks.push(Number((first + index * step).toPrecision(12)));
	}
	return ticks;
}

/**
 * The value extent a chart must show.
 *
 * @param series - The series.
 * @param options - `stacked` sums each category; `includeZero` anchors bars to a zero baseline.
 * @returns `[min, max]`; `[0, 1]` when there is no data.
 */
export function getValueExtent(series: IChartSeries[], options: { stacked?: boolean; includeZero?: boolean } = {}): [number, number] {
	let min = Infinity;
	let max = -Infinity;
	if (options.stacked) {
		const length = Math.max(0, ...series.map((entry) => entry.values.length));
		for (let index = 0; index < length; index++) {
			let total = 0;
			for (const entry of series) total += Math.max(0, entry.values[index] ?? 0);
			min = Math.min(min, total);
			max = Math.max(max, total);
		}
	}
	if (!options.stacked) {
		for (const entry of series) {
			for (const value of entry.values) {
				if (value === null || !Number.isFinite(value)) continue;
				min = Math.min(min, value);
				max = Math.max(max, value);
			}
		}
	}
	if (min === Infinity) return [0, 1];
	if (options.includeZero) {
		min = Math.min(0, min);
		max = Math.max(0, max);
	}
	return [min, max];
}

/**
 * A linear scale from a value domain to a pixel range.
 *
 * @param domain - `[d0, d1]` values.
 * @param range - `[r0, r1]` pixels (r1 may be smaller, as for a y axis).
 * @returns A function mapping a value to a pixel position.
 */
export function scaleLinear(domain: [number, number], range: [number, number]): (value: number) => number {
	const [d0, d1] = domain;
	const [r0, r1] = range;
	if (d1 === d0) return () => (r0 + r1) / 2;
	const ratio = (r1 - r0) / (d1 - d0);
	return (value: number) => r0 + (value - d0) * ratio;
}

/**
 * Evenly spaced x positions for a line chart: first category on the left
 * edge, last on the right edge.
 *
 * @param count - Number of categories.
 * @param left - Left edge (px).
 * @param right - Right edge (px).
 * @returns One x per category; a single category sits in the middle.
 */
export function pointPositions(count: number, left: number, right: number): number[] {
	if (count <= 0) return [];
	if (count === 1) return [(left + right) / 2];
	const step = (right - left) / (count - 1);
	return Array.from({ length: count }, (_, index) => left + index * step);
}

/**
 * Splits `[left, right]` into one band per category with a gap between
 * bands of `paddingRatio` of the step.
 *
 * @param count - Number of categories.
 * @param left - Left edge (px).
 * @param right - Right edge (px).
 * @param paddingRatio - Share of each step left empty. Defaults to 0.3.
 * @returns The band layout.
 */
export function bandLayout(count: number, left: number, right: number, paddingRatio = 0.3): IBandLayout {
	const safeCount = Math.max(1, count);
	const step = (right - left) / safeCount;
	const bandwidth = step * (1 - paddingRatio);
	const inset = (step - bandwidth) / 2;
	return {
		step,
		bandwidth,
		start: (index: number) => left + index * step + inset,
		center: (index: number) => left + index * step + step / 2,
	};
}

/**
 * Bar geometry inside one band for a grouped bar chart: bars are capped at
 * {@link MAX_BAR_THICKNESS}, separated by {@link BAR_GAP}, and the group is
 * centered in the band.
 *
 * @param bandStart - Left edge of the band.
 * @param bandwidth - Band width.
 * @param seriesCount - Bars in the group.
 * @returns Bar thickness and the left edge of each bar.
 */
export function groupedBarLayout(bandStart: number, bandwidth: number, seriesCount: number): { thickness: number; offsets: number[] } {
	const count = Math.max(1, seriesCount);
	const fitted = (bandwidth - BAR_GAP * (count - 1)) / count;
	const thickness = Math.max(1, Math.min(MAX_BAR_THICKNESS, fitted));
	const groupWidth = thickness * count + BAR_GAP * (count - 1);
	const first = bandStart + (bandwidth - groupWidth) / 2;
	const offsets = Array.from({ length: count }, (_, index) => first + index * (thickness + BAR_GAP));
	return { thickness, offsets };
}

// =============================================================================
// PATHS
// =============================================================================

/** Formats a coordinate to at most two decimals. */
function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/**
 * An SVG path through the points; a `null` y breaks the line (a gap).
 *
 * @param points - Pixel points in x order.
 * @returns The `d` attribute, or `''` when nothing is drawable.
 */
export function buildLinePath(points: ChartPoint[]): string {
	let path = '';
	let isDrawing = false;
	for (const [x, y] of points) {
		if (y === null) {
			isDrawing = false;
			continue;
		}
		let command = 'L';
		if (!isDrawing) command = 'M';
		path += `${command}${round(x)},${round(y)}`;
		isDrawing = true;
	}
	return path;
}

/**
 * Closed SVG area paths under each unbroken run of points, down to
 * `baselineY`.
 *
 * @param points - Pixel points in x order.
 * @param baselineY - The y of the zero line (or the plot bottom).
 * @returns The `d` attribute (one subpath per run), or `''`.
 */
export function buildAreaPath(points: ChartPoint[], baselineY: number): string {
	const runs: [number, number][][] = [];
	let current: [number, number][] = [];
	for (const [x, y] of points) {
		if (y === null) {
			if (current.length) runs.push(current);
			current = [];
			continue;
		}
		current.push([x, y]);
	}
	if (current.length) runs.push(current);

	let path = '';
	for (const run of runs) {
		if (run.length < 2) continue;
		const base = round(baselineY);
		path += `M${round(run[0][0])},${base}`;
		for (const [x, y] of run) path += `L${round(x)},${round(y)}`;
		path += `L${round(run[run.length - 1][0])},${base}Z`;
	}
	return path;
}

/**
 * A bar with a rounded data end and a square base, growing up from
 * `baseY` (or down, for a negative value whose `topY` is below the base).
 *
 * @param x - Left edge.
 * @param width - Bar thickness.
 * @param baseY - Baseline y.
 * @param valueY - The y of the value.
 * @param radius - Data-end radius. Defaults to {@link BAR_RADIUS}.
 * @returns The `d` attribute, or `''` for a zero-height bar.
 */
export function buildBarPath(x: number, width: number, baseY: number, valueY: number, radius = BAR_RADIUS): string {
	const height = Math.abs(baseY - valueY);
	if (height < 0.5 || width <= 0) return '';
	const r = Math.min(radius, width / 2, height);
	const left = round(x);
	const right = round(x + width);
	const base = round(baseY);
	const end = round(valueY);
	if (valueY <= baseY) {
		return `M${left},${base}V${round(valueY + r)}Q${left},${end} ${round(x + r)},${end}H${round(x + width - r)}Q${right},${end} ${right},${round(valueY + r)}V${base}Z`;
	}
	return `M${left},${base}V${round(valueY - r)}Q${left},${end} ${round(x + r)},${end}H${round(x + width - r)}Q${right},${end} ${right},${round(valueY - r)}V${base}Z`;
}

// =============================================================================
// LABELS, HOVER, SERIES CAP
// =============================================================================

/**
 * Which category labels fit on the x axis without colliding: every k-th,
 * always ending on the last category (the most recent period).
 *
 * @param count - Number of categories.
 * @param plotWidth - Width available for labels (px).
 * @param labelWidth - Widest label (px), including breathing room.
 * @returns Indexes of the categories to label.
 */
export function pickLabelIndexes(count: number, plotWidth: number, labelWidth: number): number[] {
	if (count <= 0) return [];
	const fit = Math.max(1, Math.floor(plotWidth / Math.max(1, labelWidth)));
	const every = Math.max(1, Math.ceil(count / fit));
	const indexes: number[] = [];
	for (let index = count - 1; index >= 0; index -= every) indexes.unshift(index);
	return indexes;
}

/**
 * The category nearest a pointer x.
 *
 * @param positions - Category x positions, ascending.
 * @param x - Pointer x.
 * @returns The nearest index, or -1 when there are no positions.
 */
export function nearestIndex(positions: number[], x: number): number {
	if (!positions.length) return -1;
	let best = 0;
	let bestDistance = Math.abs(positions[0] - x);
	for (let index = 1; index < positions.length; index++) {
		const distance = Math.abs(positions[index] - x);
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Caps the series at `max`: the first `max - 1` keep their slots and the
 * rest are summed into one "Other" series. A 7th color is never generated.
 *
 * @param series - The series.
 * @param max - Most series to draw. Defaults to {@link MAX_CHART_SERIES}.
 * @param otherLabel - Label for the folded series. Defaults to `'Other'`.
 * @returns The series to draw (unchanged when within the cap).
 */
export function foldSeries(series: IChartSeries[], max = MAX_CHART_SERIES, otherLabel = 'Other'): IChartSeries[] {
	if (series.length <= max) return series;
	const kept = series.slice(0, max - 1);
	const rest = series.slice(max - 1);
	const length = Math.max(...rest.map((entry) => entry.values.length));
	const values: (number | null)[] = [];
	for (let index = 0; index < length; index++) {
		let total: number | null = null;
		for (const entry of rest) {
			const value = entry.values[index];
			if (value === null || value === undefined) continue;
			total = (total ?? 0) + value;
		}
		values.push(total);
	}
	return [...kept, { id: '__other__', label: otherLabel, values }];
}

/** The ordered series tokens, slot 1 first (see rocketride-default.css). */
export const SERIES_TOKENS = ['--rr-chart-series-1', '--rr-chart-series-2', '--rr-chart-series-3', '--rr-chart-series-4', '--rr-chart-series-5', '--rr-chart-series-6'] as const;

/**
 * The CSS color for series slot `index` (0-based). Past the last slot it
 * stays on the last token: series are folded before drawing, never cycled.
 *
 * @param index - Series position.
 * @returns A `var(...)` reference to the slot token.
 */
export function seriesColor(index: number): string {
	const slot = Math.min(SERIES_TOKENS.length - 1, Math.max(0, index));
	return `var(${SERIES_TOKENS[slot]})`;
}
