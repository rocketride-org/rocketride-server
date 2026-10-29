// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ChartFrame — the shared shell of LineChart and BarChart (internal; not part
 * of the public API).
 *
 * It owns everything that is not marks: measuring its width, the y axis
 * (nice ticks, hairline grid), x labels that never collide, the legend, and
 * the hover layer. Pointer hover snaps to the nearest category and shows a
 * crosshair plus a tooltip listing every series. The plot is focusable: the
 * arrow keys, Home and End move the same reading, which is also announced
 * through a polite live region, so keyboard and screen-reader users get the
 * values without a mouse. The SVG itself is hidden from assistive tech.
 *
 * Text always wears text tokens; only marks and legend keys carry the series
 * color.
 */

import React, { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { bandLayout, IBandLayout, IChartData, nearestIndex, niceTicks, pickLabelIndexes, pointPositions, scaleLinear, seriesColor } from './chartMath';

// =============================================================================
// TYPES
// =============================================================================

/** The plot geometry handed to a chart's mark renderer. */
export interface IChartGeometry {
	/** Plot box, in px from the SVG origin. */
	left: number;
	right: number;
	top: number;
	bottom: number;
	/** Value to y pixel. */
	y: (value: number) => number;
	/** The y of zero (clamped into the plot). */
	baselineY: number;
	/** X of each category (point position or band center). */
	positions: number[];
	/** Band layout (bar charts only). */
	band: IBandLayout | null;
}

/** Props for the internal {@link ChartFrame}. */
export interface IChartFrameProps {
	/** Data, already folded to the series cap. */
	data: IChartData;
	/** Accessible name of the chart. */
	label: string;
	/** Total height in px. */
	height: number;
	/** `[min, max]` the y axis must cover. */
	extent: [number, number];
	/** X layout: points edge to edge (lines) or bands (bars). */
	xMode: 'point' | 'band';
	/** Legend key shape. */
	legendShape: 'line' | 'square';
	/** Show the legend. */
	showLegend: boolean;
	/** Formats tooltip and announced values. */
	formatValue: (value: number) => string;
	/** Formats y-axis ticks. */
	formatTick: (value: number) => string;
	/** Draws the marks for the measured geometry. */
	renderMarks: (geometry: IChartGeometry, activeIndex: number) => ReactNode;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Average glyph width of the 11px tick font, for layout estimates. */
const CHAR_WIDTH = 6.4;

/** Space under the plot for x labels. */
const X_AXIS_HEIGHT = 22;

/** Space above the plot so the top tick label is not clipped. */
const TOP_PAD = 8;

/** Space right of the plot for end markers. */
const RIGHT_PAD = 8;

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Tracks an element's width with a ResizeObserver.
 *
 * @param ref - The element.
 * @returns Its current width in px (0 until measured).
 */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element) return undefined;
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) setWidth(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The reading for one category: "Oct 3: Runs 1,204, Errors 12".
 *
 * @param data - The chart data.
 * @param index - Category index.
 * @param formatValue - Value formatter.
 * @returns The sentence.
 */
export function describeCategory(data: IChartData, index: number, formatValue: (value: number) => string): string {
	const parts = data.series.map((series) => {
		const value = series.values[index];
		let shown = 'no data';
		if (value !== null && value !== undefined) shown = formatValue(value);
		return `${series.label} ${shown}`;
	});
	return `${data.categories[index]}: ${parts.join(', ')}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the chart frame: legend, axes, hover layer and the marks.
 *
 * @param props - {@link IChartFrameProps}.
 * @returns The chart element.
 */
export function ChartFrame({ data, label, height, extent, xMode, legendShape, showLegend, formatValue, formatTick, renderMarks }: IChartFrameProps): React.ReactElement {
	const plotRef = useRef<HTMLDivElement>(null);
	const width = useElementWidth(plotRef);
	const [activeIndex, setActiveIndex] = useState(-1);
	const hintId = useId();
	const count = data.categories.length;

	const ticks = niceTicks(extent[0], extent[1]);
	const tickLabels = ticks.map(formatTick);
	const left = Math.ceil(Math.max(...tickLabels.map((text) => text.length)) * CHAR_WIDTH) + 10;
	const right = Math.max(left + 1, width - RIGHT_PAD);
	const top = TOP_PAD;
	const bottom = height - X_AXIS_HEIGHT;
	const y = scaleLinear([ticks[0], ticks[ticks.length - 1]], [bottom, top]);
	const baselineY = Math.min(bottom, Math.max(top, y(0)));

	let band: IBandLayout | null = null;
	let positions = pointPositions(count, left, right);
	if (xMode === 'band') {
		band = bandLayout(count, left, right);
		positions = Array.from({ length: count }, (_, index) => (band as IBandLayout).center(index));
	}
	const geometry: IChartGeometry = { left, right, top, bottom, y, baselineY, positions, band };

	const longestCategory = Math.max(1, ...data.categories.map((text) => text.length));
	const labelIndexes = pickLabelIndexes(count, right - left, longestCategory * CHAR_WIDTH + 16);

	/** Snaps the reading to the category nearest the pointer. */
	function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
		if (!count) return;
		const rect = event.currentTarget.getBoundingClientRect();
		setActiveIndex(nearestIndex(positions, event.clientX - rect.left));
	}

	/** Arrow keys, Home and End move the reading; Escape clears it. */
	function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
		if (!count) return;
		let next = activeIndex;
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(count - 1, activeIndex + 1);
		if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, activeIndex - 1);
		if (activeIndex < 0 && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) next = count - 1;
		if (event.key === 'Home') next = 0;
		if (event.key === 'End') next = count - 1;
		if (event.key === 'Escape') next = -1;
		if (next === activeIndex) return;
		event.preventDefault();
		setActiveIndex(next);
	}

	const isMeasured = width > 0;
	const hasActive = isMeasured && activeIndex >= 0 && activeIndex < count;
	let markIndex = -1;
	if (hasActive) markIndex = activeIndex;

	let tooltip: ReactNode = null;
	if (hasActive) {
		const x = positions[activeIndex];
		const isRightHalf = x > width / 2;
		let style: React.CSSProperties = { left: x + 12, top };
		if (isRightHalf) style = { right: width - x + 12, top };
		tooltip = (
			<div className="rr-chart__tooltip" style={style} aria-hidden="true">
				<div className="rr-chart__tooltip-title">{data.categories[activeIndex]}</div>
				{data.series.map((series, seriesIndex) => {
					const value = series.values[activeIndex];
					let shown = '–';
					if (value !== null && value !== undefined) shown = formatValue(value);
					return (
						<div key={series.id} className="rr-chart__tooltip-row">
							<span className={`rr-chart__key rr-chart__key--${legendShape}`} style={{ background: seriesColor(seriesIndex) }} />
							<span className="rr-chart__tooltip-label">{series.label}</span>
							<span className="rr-chart__tooltip-value">{shown}</span>
						</div>
					);
				})}
			</div>
		);
	}

	let announcement = '';
	if (hasActive) announcement = describeCategory(data, activeIndex, formatValue);

	return (
		<div className="rr-chart">
			{showLegend && (
				<ul className="rr-chart__legend" aria-label={`${label} legend`}>
					{data.series.map((series, seriesIndex) => (
						<li key={series.id} className="rr-chart__legend-item">
							<span className={`rr-chart__key rr-chart__key--${legendShape}`} style={{ background: seriesColor(seriesIndex) }} aria-hidden="true" />
							{series.label}
						</li>
					))}
				</ul>
			)}
			<div ref={plotRef} className="rr-chart__plot" style={{ height }} tabIndex={0} role="group" aria-roledescription="chart" aria-label={label} aria-describedby={hintId} onPointerMove={handlePointerMove} onPointerLeave={() => setActiveIndex(-1)} onKeyDown={handleKeyDown} onBlur={() => setActiveIndex(-1)}>
				{isMeasured && (
					<svg className="rr-chart__svg" width={width} height={height} aria-hidden="true" focusable="false">
						<g className="rr-chart__grid">
							{ticks.map((tick, index) => (
								<g key={tick}>
									<line x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
									<text className="rr-chart__tick" x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
										{tickLabels[index]}
									</text>
								</g>
							))}
						</g>
						{hasActive && band && <rect className="rr-chart__band-highlight" x={positions[activeIndex] - band.step / 2} y={top} width={band.step} height={bottom - top} />}
						{hasActive && !band && <line className="rr-chart__crosshair" x1={positions[activeIndex]} x2={positions[activeIndex]} y1={top} y2={bottom} />}
						{renderMarks(geometry, markIndex)}
						<g className="rr-chart__x-axis">
							{labelIndexes.map((index) => {
								let anchor: 'start' | 'middle' | 'end' = 'middle';
								if (xMode === 'point' && index === 0 && count > 1) anchor = 'start';
								if (xMode === 'point' && index === count - 1 && count > 1) anchor = 'end';
								return (
									<text key={index} className="rr-chart__tick" x={positions[index]} y={height - 6} textAnchor={anchor}>
										{data.categories[index]}
									</text>
								);
							})}
						</g>
					</svg>
				)}
				{!count && <div className="rr-chart__no-data">No data</div>}
				{tooltip}
			</div>
			<span id={hintId} className="rr-sr-only">
				Use the arrow keys to read values.
			</span>
			<span className="rr-sr-only" aria-live="polite">
				{announcement}
			</span>
		</div>
	);
}
