// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProgressBar and Spinner — work in progress.
 *
 * ProgressBar is determinate when `value` is given (uploads, batch jobs,
 * quota use) and indeterminate otherwise. Spinner is for short, unmeasured
 * waits inside a button, a row or a panel. Both are `role="progressbar"`
 * with an accessible name; give a meaningful `label` ("Uploading
 * dataset.csv") rather than relying on the default.
 *
 * Built on `.rr-progress` and `.rr-spinner` from components.css.
 */

import React from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ProgressBar} component. */
export interface IProgressBarProps {
	/** Progress from `min` to `max`; omit for indeterminate. */
	value?: number;
	/** Lower bound. Defaults to 0. */
	min?: number;
	/** Upper bound. Defaults to 100. */
	max?: number;
	/** Accessible name; shown above the bar when `showLabel` is set. */
	label: string;
	/** Show the label (and the percentage) above the bar. */
	showLabel?: boolean;
	/** Formats the shown and spoken value. Defaults to a whole percentage. */
	formatValue?: (value: number, percent: number) => string;
	/** Color the bar for a failed or over-quota state. */
	tone?: 'accent' | 'success' | 'warning' | 'error';
}

/** Props for the {@link Spinner} component. */
export interface ISpinnerProps {
	/** Accessible name. Defaults to `'Loading'`. */
	label?: string;
	/** 12px, 16px (default) or 28px. */
	size?: 'sm' | 'md' | 'lg';
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Converts a value to a 0 to 100 percentage, clamped.
 *
 * @param value - The value.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The percentage.
 */
export function toPercent(value: number, min: number, max: number): number {
	if (max <= min) return 0;
	const percent = ((value - min) / (max - min)) * 100;
	return Math.min(100, Math.max(0, percent));
}

/** The default value text: a whole percentage. */
function defaultFormat(_value: number, percent: number): string {
	return `${Math.round(percent)}%`;
}

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a linear progress bar.
 *
 * @param props - {@link IProgressBarProps}.
 * @returns The progress bar (with its label row when shown).
 */
export function ProgressBar({ value, min = 0, max = 100, label, showLabel = false, formatValue = defaultFormat, tone = 'accent' }: IProgressBarProps): React.ReactElement {
	const isDeterminate = value !== undefined;

	let percent = 0;
	let valueText: string | undefined;
	if (isDeterminate) {
		percent = toPercent(value, min, max);
		valueText = formatValue(value, percent);
	}

	let trackClassName = 'rr-progress';
	if (!isDeterminate) trackClassName += ' rr-progress--indeterminate';
	if (tone !== 'accent') trackClassName += ` rr-progress--${tone}`;

	let barStyle: React.CSSProperties | undefined;
	let range: { 'aria-valuemin'?: number; 'aria-valuemax'?: number; 'aria-valuenow'?: number } = {};
	if (isDeterminate) {
		barStyle = { width: `${percent}%` };
		range = { 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': value };
	}

	return (
		<div className="rr-progress-row">
			{showLabel && (
				<div className="rr-progress-row__label">
					<span className="rr-truncate">{label}</span>
					{valueText && <span className="rr-text-mono rr-text-secondary">{valueText}</span>}
				</div>
			)}
			<div className={trackClassName} role="progressbar" aria-label={label} {...range} aria-valuetext={valueText}>
				<div className="rr-progress__bar" style={barStyle} />
			</div>
		</div>
	);
}

/**
 * Renders an indeterminate spinner.
 *
 * @param props - {@link ISpinnerProps}.
 * @returns The spinner element.
 */
export function Spinner({ label = 'Loading', size = 'md' }: ISpinnerProps): React.ReactElement {
	let classes = 'rr-spinner';
	if (size === 'sm') classes += ' rr-spinner--sm';
	if (size === 'lg') classes += ' rr-spinner--lg';
	return <span className={classes} role="progressbar" aria-label={label} />;
}
