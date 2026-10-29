// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Sparkline — a word-sized trend with no axes: the shape of the last N
 * periods next to a number (StatCard, a table cell, a list row).
 *
 * The line is drawn in a de-emphasized ink and only the latest point wears
 * the accent series color, so the eye lands on "now". It stretches to its
 * container's width (the stroke keeps its 1.5px weight) and has a fixed
 * height.
 *
 * It is one image to assistive tech, named by `label` plus a generated
 * summary ("Runs, last 12 days: 1,020 to 1,284, low 980, high 1,310").
 *
 * Built on `.rr-sparkline` from components.css.
 */

import React from 'react';
import { formatCompact } from './chartFormat';
import { buildAreaPath, buildLinePath, ChartPoint } from './chartMath';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Sparkline} component. */
export interface ISparklineProps {
	/** Values, oldest first. */
	values: number[];
	/** What the trend is of ("Runs, last 12 days"); the summary is appended. */
	label: string;
	/** Height in px. Defaults to 32. */
	height?: number;
	/** Wash under the line. */
	area?: boolean;
	/** Formats the spoken summary values. Defaults to {@link formatCompact}. */
	formatValue?: (value: number) => string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** ViewBox width; the SVG stretches it to the container. */
const VIEW_WIDTH = 100;

/** Vertical inset so the end dot is never clipped. */
const INSET = 4;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The spoken summary of a trend.
 *
 * @param values - Values, oldest first.
 * @param formatValue - Value formatter.
 * @returns "1,020 to 1,284, low 980, high 1,310", or "no data".
 */
export function summarizeTrend(values: number[], formatValue: (value: number) => string = formatCompact): string {
	if (!values.length) return 'no data';
	const first = values[0];
	const last = values[values.length - 1];
	const low = Math.min(...values);
	const high = Math.max(...values);
	return `${formatValue(first)} to ${formatValue(last)}, low ${formatValue(low)}, high ${formatValue(high)}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders an inline trend line.
 *
 * @param props - {@link ISparklineProps}.
 * @returns The sparkline.
 */
export function Sparkline({ values, label, height = 32, area = false, formatValue = formatCompact }: ISparklineProps): React.ReactElement {
	const accessibleName = `${label}: ${summarizeTrend(values, formatValue)}`;
	const low = Math.min(...values);
	const high = Math.max(...values);
	const span = high - low;

	/** Value to y inside the inset band; a flat series sits in the middle. */
	function toY(value: number): number {
		if (span === 0) return height / 2;
		return INSET + (1 - (value - low) / span) * (height - INSET * 2);
	}

	const step = VIEW_WIDTH / Math.max(1, values.length - 1);
	const points: ChartPoint[] = values.map((value, index) => [index * step, toY(value)]);

	let endStyle: React.CSSProperties | null = null;
	if (values.length) {
		const [x, y] = points[points.length - 1];
		endStyle = { left: `${x}%`, top: y as number };
	}

	return (
		<span className="rr-sparkline" role="img" aria-label={accessibleName} style={{ height }}>
			<svg className="rr-sparkline__svg" viewBox={`0 0 ${VIEW_WIDTH} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true" focusable="false">
				{area && <path className="rr-sparkline__area" d={buildAreaPath(points, height)} />}
				<path className="rr-sparkline__line" d={buildLinePath(points)} vectorEffect="non-scaling-stroke" />
			</svg>
			{endStyle && <span className="rr-sparkline__dot" style={endStyle} aria-hidden="true" />}
		</span>
	);
}
