// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Number formatting for dashboards: compact values (1,284 / 12.9K / 4.2M),
 * period-over-period deltas, and whether a delta is good news.
 */

// =============================================================================
// TYPES
// =============================================================================

/** Whether a change is good, bad or neither for the reader. */
export type DeltaTone = 'good' | 'bad' | 'neutral';

/** Direction of a change. */
export type DeltaDirection = 'up' | 'down' | 'flat';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Typographic minus: reads as "minus" to screen readers and matches the plus width. */
const MINUS = '−';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Formats a number compactly from 10,000 up (12.9K, 4.2M) and with
 * grouping below that (1,284). Small fractions keep up to two decimals.
 *
 * @param value - The number.
 * @param locale - BCP 47 locale. Defaults to `'en-US'` so output is stable.
 * @returns The formatted string.
 */
export function formatCompact(value: number, locale = 'en-US'): string {
	if (!Number.isFinite(value)) return String(value);
	if (Math.abs(value) >= 10000) {
		return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
	}
	let digits = 0;
	if (Math.abs(value) < 10 && !Number.isInteger(value)) digits = 2;
	if (Math.abs(value) >= 10 && Math.abs(value) < 100 && !Number.isInteger(value)) digits = 1;
	return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value).replace('-', MINUS);
}

/**
 * Formats an axis tick: compact from 1,000 up (0 / 500 / 1K / 1.5K) so
 * tick labels stay short.
 *
 * @param value - The tick value.
 * @returns The label.
 */
export function formatAxisTick(value: number): string {
	if (Math.abs(value) >= 1000) {
		return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value).replace('-', MINUS);
	}
	return formatCompact(value);
}

/**
 * Percent change from `previous` to `current`.
 *
 * @param current - This period.
 * @param previous - The comparison period.
 * @returns The change in percent, or null when `previous` is zero or missing.
 */
export function computeDelta(current: number, previous: number | null | undefined): number | null {
	if (previous === null || previous === undefined || previous === 0) return null;
	return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Direction of a delta; anything that rounds to zero at one decimal is flat.
 *
 * @param delta - The change.
 * @returns `'up'`, `'down'` or `'flat'`.
 */
export function getDeltaDirection(delta: number): DeltaDirection {
	const rounded = Math.round(delta * 10) / 10;
	if (rounded > 0) return 'up';
	if (rounded < 0) return 'down';
	return 'flat';
}

/**
 * Whether a delta is good news: direction times whether up is good
 * (latency and error rate going up is bad).
 *
 * @param delta - The change.
 * @param isIncreaseGood - Whether a rise is good. Defaults to true.
 * @returns The tone.
 */
export function getDeltaTone(delta: number, isIncreaseGood = true): DeltaTone {
	const direction = getDeltaDirection(delta);
	if (direction === 'flat') return 'neutral';
	const isUp = direction === 'up';
	if (isUp === isIncreaseGood) return 'good';
	return 'bad';
}

/**
 * A signed delta with one decimal: `+12.4%`, `−3.1%`, `0%`.
 *
 * @param delta - The change.
 * @param unit - Suffix. Defaults to `'%'`; pass `''` for absolute deltas.
 * @returns The formatted delta.
 */
export function formatDelta(delta: number, unit = '%'): string {
	const direction = getDeltaDirection(delta);
	if (direction === 'flat') return `0${unit}`;
	const magnitude = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(Math.abs(delta));
	if (direction === 'up') return `+${magnitude}${unit}`;
	return `${MINUS}${magnitude}${unit}`;
}
