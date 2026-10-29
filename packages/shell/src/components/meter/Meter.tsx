// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Meter — a measured amount against a limit: plan quota, tokens this month,
 * storage, concurrent runs. Use ProgressBar for work that completes; use a
 * Meter for a level that can sit anywhere.
 *
 * The fill carries severity: accent below `warningAt`, warning from there,
 * error from `dangerAt` (fractions of `max`). The unfilled track is a light
 * tint of the same color, so the state reads across the whole bar. Past the
 * warning threshold a status line ("Near limit", "At limit") appears with an
 * icon, so severity is never color alone.
 *
 * `role="meter"` with min, max, now and a spoken value text.
 *
 * Built on `.rr-meter` from components.css.
 */

import React, { ReactNode, useId } from 'react';
import { formatCompact } from '../chart/chartFormat';
import { toPercent } from '../progress/Progress';

// =============================================================================
// TYPES
// =============================================================================

/** Severity of a meter reading. */
export type MeterLevel = 'normal' | 'warning' | 'danger';

/** Props for the {@link Meter} component. */
export interface IMeterProps {
	/** What is measured ("Tokens this month"). */
	label: string;
	/** Current amount. */
	value: number;
	/** The limit. */
	max: number;
	/** Formats value and max. Defaults to {@link formatCompact}. */
	formatValue?: (value: number) => string;
	/** Fraction of `max` where the warning starts. Defaults to 0.8. */
	warningAt?: number;
	/** Fraction of `max` where danger starts. Defaults to 0.95. */
	dangerAt?: number;
	/** Extra line under the bar ("Resets Nov 1"). */
	hint?: ReactNode;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The severity of a reading.
 *
 * @param value - Current amount.
 * @param max - The limit.
 * @param warningAt - Warning threshold as a fraction of max.
 * @param dangerAt - Danger threshold as a fraction of max.
 * @returns The level.
 */
export function getMeterLevel(value: number, max: number, warningAt = 0.8, dangerAt = 0.95): MeterLevel {
	if (max <= 0) return 'normal';
	const ratio = value / max;
	if (ratio >= dangerAt) return 'danger';
	if (ratio >= warningAt) return 'warning';
	return 'normal';
}

/** Status line per level. */
const STATUS_TEXT: Record<MeterLevel, string> = { normal: '', warning: 'Near limit', danger: 'At limit' };

/** Status icon per level. */
const STATUS_ICON: Record<MeterLevel, string> = { normal: '', warning: '!', danger: '!' };

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a quota / usage meter.
 *
 * @param props - {@link IMeterProps}.
 * @returns The meter.
 */
export function Meter({ label, value, max, formatValue = formatCompact, warningAt = 0.8, dangerAt = 0.95, hint }: IMeterProps): React.ReactElement {
	const labelId = useId();
	const level = getMeterLevel(value, max, warningAt, dangerAt);
	const percent = toPercent(value, 0, max);
	const amount = `${formatValue(value)} / ${formatValue(max)}`;

	let valueText = `${formatValue(value)} of ${formatValue(max)}`;
	if (level !== 'normal') valueText += `, ${STATUS_TEXT[level].toLowerCase()}`;

	return (
		<div className={`rr-meter rr-meter--${level}`}>
			<div className="rr-meter__header">
				<span id={labelId} className="rr-meter__label">
					{label}
				</span>
				<span className="rr-meter__amount" aria-hidden="true">
					{amount}
				</span>
			</div>
			<div className="rr-meter__track" role="meter" aria-labelledby={labelId} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} aria-valuetext={valueText}>
				<div className="rr-meter__fill" style={{ width: `${percent}%` }} />
			</div>
			{(level !== 'normal' || hint) && (
				<div className="rr-meter__footer">
					{level !== 'normal' && (
						<span className="rr-meter__status">
							<span className="rr-meter__status-icon" aria-hidden="true">
								{STATUS_ICON[level]}
							</span>
							{STATUS_TEXT[level]}
						</span>
					)}
					{hint && <span className="rr-meter__hint">{hint}</span>}
				</div>
			)}
		</div>
	);
}
