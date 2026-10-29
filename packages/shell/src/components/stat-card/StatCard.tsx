// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * StatCard — one KPI tile: a label, the value, the change against a named
 * period, and an optional trend.
 *
 *   label   sentence case, no colon ("Pipeline runs")
 *   value   numbers are formatted compactly (1,284 / 12.9K / 4.2M)
 *   delta   percent change; `deltaLabel` names the period ("vs last week")
 *   trend   a Sparkline of recent periods, latest point accented
 *
 * Whether a delta is good depends on the metric: set `isIncreaseGood={false}`
 * for latency, cost or error rate. The tone shows as a tinted pill with an
 * arrow; the number itself stays in the primary text color so it is legible
 * on every theme, and the direction is spoken ("up 12.4%").
 *
 * Lay several out with DashboardGrid (`minItemWidth`).
 *
 * Built on `.rr-paper` and `.rr-stat` from components.css.
 */

import React, { ReactNode, useId } from 'react';
import { DeltaTone, formatCompact, formatDelta, getDeltaDirection, getDeltaTone } from '../chart/chartFormat';
import { Sparkline } from '../chart/Sparkline';
import { Skeleton } from '../skeleton/Skeleton';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link StatCard} component. */
export interface IStatCardProps {
	/** What is measured ("Pipeline runs"). */
	label: string;
	/** The value; numbers go through `formatValue`. */
	value: number | string;
	/** Formats a numeric value. Defaults to {@link formatCompact}. */
	formatValue?: (value: number) => string;
	/** Unit after the value ("ms", "tokens"). */
	unit?: string;
	/** Percent change against the comparison period (see computeDelta). */
	delta?: number | null;
	/** The comparison period ("vs last week"). */
	deltaLabel?: string;
	/** Whether a rise is good news. Defaults to true. */
	isIncreaseGood?: boolean;
	/** Recent values, oldest first, for the sparkline. */
	trend?: number[];
	/** Icon beside the label. */
	icon?: ReactNode;
	/** Extra line at the bottom (a link, a note). */
	footer?: ReactNode;
	/** Show skeletons instead of the value. */
	isLoading?: boolean;
	/** Larger value for the one headline metric on a view. */
	hero?: boolean;
}

/** Props for the {@link DeltaPill} component. */
export interface IDeltaPillProps {
	/** Percent change. */
	delta: number;
	/** Whether a rise is good news. Defaults to true. */
	isIncreaseGood?: boolean;
	/** Unit suffix. Defaults to `'%'`. */
	unit?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Arrow glyph per direction; a flat change shows none. */
const ARROWS = { up: '▲', down: '▼', flat: '' } as const;

/** Spoken direction. */
const SPOKEN = { up: 'up', down: 'down', flat: 'unchanged' } as const;

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a signed change with a direction arrow, tinted by whether the
 * change is good news.
 *
 * @param props - {@link IDeltaPillProps}.
 * @returns The pill.
 */
export function DeltaPill({ delta, isIncreaseGood = true, unit = '%' }: IDeltaPillProps): React.ReactElement {
	const direction = getDeltaDirection(delta);
	const tone: DeltaTone = getDeltaTone(delta, isIncreaseGood);
	let spoken: string = SPOKEN[direction];
	const shown = formatDelta(delta, unit);
	if (direction !== 'flat') spoken += ` ${shown.slice(1)}`;
	return (
		<span className={`rr-delta rr-delta--${tone}`}>
			{ARROWS[direction] && (
				<span className="rr-delta__arrow" aria-hidden="true">
					{ARROWS[direction]}
				</span>
			)}
			<span aria-hidden="true">{shown}</span>
			<span className="rr-sr-only">{spoken}</span>
		</span>
	);
}

/**
 * Renders a KPI tile.
 *
 * @param props - {@link IStatCardProps}.
 * @returns The tile.
 */
export function StatCard({ label, value, formatValue = formatCompact, unit, delta, deltaLabel, isIncreaseGood = true, trend, icon, footer, isLoading = false, hero = false }: IStatCardProps): React.ReactElement {
	const labelId = useId();

	let classes = 'rr-paper rr-stat';
	let skeletonHeight = 28;
	if (hero) {
		classes += ' rr-stat--hero';
		skeletonHeight = 44;
	}

	let shown = String(value);
	if (typeof value === 'number') shown = formatValue(value);

	const hasDelta = delta !== null && delta !== undefined && Number.isFinite(delta);
	const hasTrend = Boolean(trend && trend.length > 1);

	if (isLoading) {
		return (
			<div className={classes} role="group" aria-labelledby={labelId} aria-busy="true">
				<div className="rr-stat__label">
					{icon && <span className="rr-stat__icon">{icon}</span>}
					<span id={labelId}>{label}</span>
				</div>
				<Skeleton width="60%" height={skeletonHeight} />
				<Skeleton width="40%" height={14} />
			</div>
		);
	}

	return (
		<div className={classes} role="group" aria-labelledby={labelId}>
			<div className="rr-stat__label">
				{icon && <span className="rr-stat__icon">{icon}</span>}
				<span id={labelId}>{label}</span>
			</div>
			<div className="rr-stat__value">
				{shown}
				{unit && <span className="rr-stat__unit">{unit}</span>}
			</div>
			{hasDelta && (
				<div className="rr-stat__delta">
					<DeltaPill delta={delta as number} isIncreaseGood={isIncreaseGood} />
					{deltaLabel && <span className="rr-stat__delta-label">{deltaLabel}</span>}
				</div>
			)}
			{hasTrend && (
				<div className="rr-stat__trend">
					<Sparkline values={trend as number[]} label={`${label} trend`} formatValue={formatValue} />
				</div>
			)}
			{footer && <div className="rr-stat__footer">{footer}</div>}
		</div>
	);
}
