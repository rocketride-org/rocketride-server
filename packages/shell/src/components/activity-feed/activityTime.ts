// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Time helpers for ActivityFeed: relative times ("5 minutes ago"), day labels
 * ("Today", "Yesterday", "Mon, Oct 26") and grouping by local day. Every
 * function takes `now` so output is deterministic in tests.
 */

// =============================================================================
// TYPES
// =============================================================================

/** Anything a timestamp can be given as. */
export type TimestampInput = Date | number | string;

/** Items that fall on one local day. */
export interface IDayGroup<T> {
	/** Local date key, `YYYY-MM-DD`. */
	key: string;
	/** Heading ("Today", "Yesterday", "Mon, Oct 26"). */
	label: string;
	/** Items, in the order given. */
	items: T[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Normalizes a timestamp to a Date.
 *
 * @param input - Date, epoch milliseconds or an ISO string.
 * @returns The Date.
 */
export function toDate(input: TimestampInput): Date {
	if (input instanceof Date) return input;
	return new Date(input);
}

/**
 * The local calendar day of a date.
 *
 * @param date - The date.
 * @returns `YYYY-MM-DD` in local time.
 */
export function getDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Whole local days between two dates (calendar days, not 24h spans).
 *
 * @param date - The earlier date.
 * @param now - The reference date.
 * @returns Days from `date` to `now`.
 */
function calendarDaysBetween(date: Date, now: Date): number {
	const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	return Math.round((end - start) / DAY);
}

/**
 * A short relative time: "just now", "5 minutes ago", "3 hours ago", "yesterday",
 * "4 days ago", then the date for anything older than a week.
 *
 * @param input - The timestamp.
 * @param now - The reference time. Defaults to the current time.
 * @param locale - BCP 47 locale. Defaults to `'en-US'`.
 * @returns The relative time.
 */
export function formatRelativeTime(input: TimestampInput, now: Date = new Date(), locale = 'en-US'): string {
	const date = toDate(input);
	const elapsed = now.getTime() - date.getTime();
	const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
	if (elapsed < MINUTE) return 'just now';
	if (elapsed < HOUR) return format.format(-Math.floor(elapsed / MINUTE), 'minute');
	if (elapsed < 12 * HOUR) return format.format(-Math.floor(elapsed / HOUR), 'hour');
	const days = calendarDaysBetween(date, now);
	if (days === 0) return format.format(-Math.floor(elapsed / HOUR), 'hour');
	if (days < 7) return format.format(-days, 'day');
	return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

/**
 * The full date and time, for a tooltip.
 *
 * @param input - The timestamp.
 * @param locale - BCP 47 locale. Defaults to `'en-US'`.
 * @returns "Oct 29, 2026, 5:54 PM".
 */
export function formatFullTime(input: TimestampInput, locale = 'en-US'): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(toDate(input));
}

/**
 * A day heading: "Today", "Yesterday", "Mon, Oct 26", or with the year when
 * it differs from `now`.
 *
 * @param date - A date on the day.
 * @param now - The reference date.
 * @param locale - BCP 47 locale. Defaults to `'en-US'`.
 * @returns The heading.
 */
export function getDayLabel(date: Date, now: Date, locale = 'en-US'): string {
	const days = calendarDaysBetween(date, now);
	if (days === 0) return 'Today';
	if (days === 1) return 'Yesterday';
	const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
	if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
	return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * Groups items by local day, keeping the given order (feeds are usually
 * newest first, so groups come out newest first too).
 *
 * @param items - The items.
 * @param getTimestamp - Reads an item's timestamp.
 * @param now - The reference date for labels.
 * @returns One group per day, in first-seen order.
 */
export function groupByDay<T>(items: T[], getTimestamp: (item: T) => TimestampInput, now: Date): IDayGroup<T>[] {
	const groups: IDayGroup<T>[] = [];
	const byKey = new Map<string, IDayGroup<T>>();
	for (const item of items) {
		const date = toDate(getTimestamp(item));
		const key = getDayKey(date);
		let group = byKey.get(key);
		if (!group) {
			group = { key, label: getDayLabel(date, now), items: [] };
			byKey.set(key, group);
			groups.push(group);
		}
		group.items.push(item);
	}
	return groups;
}
