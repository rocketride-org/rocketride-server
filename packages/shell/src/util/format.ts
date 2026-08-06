// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Shared value formatters — human-readable byte sizes, dates, and durations.
 *
 * Consolidated for reuse across apps (ported from the per-app formatter copies).
 * Pure functions with no dependencies; safe to import anywhere in shared-ui.
 */

// =============================================================================
// FORMATTERS
// =============================================================================

/**
 * Formats a byte count as a human-readable size with a unit suffix.
 *
 * @param bytes - The size in bytes.
 * @returns A short size string, e.g. `formatBytes(512)` → `"512 B"`,
 *   `formatBytes(2048)` → `"2.0 KB"`, `formatBytes(5_242_880)` → `"5.0 MB"`.
 */
export function formatBytes(bytes: number): string {
	// Plain bytes below 1 KiB.
	if (bytes < 1024) return `${bytes} B`;
	// Kibibytes below 1 MiB.
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	// Mebibytes below 1 GiB.
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	// Gibibytes and above.
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Formats an ISO date string as a short localised "month day, time" label.
 *
 * @param iso - An ISO-8601 date string.
 * @returns A short date/time string, e.g. `formatDate('2026-07-07T14:30:00Z')`
 *   → `"Jul 7, 02:30 PM"` (exact form depends on the runtime locale).
 */
export function formatDate(iso: string): string {
	const d = new Date(iso);
	// toLocaleString (not toLocaleDateString): the date-only variant is permitted
	// to ignore the hour/minute options, so some runtimes would drop the time this
	// function promises. toLocaleString honors both date and time fields.
	return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Formats a millisecond duration as a compact human-readable string.
 *
 * @param ms - The duration in milliseconds.
 * @returns A short duration string, e.g. `formatDuration(750)` → `"750ms"`,
 *   `formatDuration(1500)` → `"1.5s"`, `formatDuration(90000)` → `"1m 30s"`.
 */
export function formatDuration(ms: number): string {
	// Sub-second durations in whole milliseconds.
	if (ms < 1000) return `${Math.round(ms)}ms`;
	// Under a minute: seconds with one decimal. Guard the boundary: values just
	// under 60s round up to "60.0", which must carry into the minute form.
	if (ms < 60000) {
		const secs = (ms / 1000).toFixed(1);
		return secs === '60.0' ? '1m 0s' : `${secs}s`;
	}
	// A minute or more: whole minutes + seconds.
	let minutes = Math.floor(ms / 60000);
	let seconds = Math.round((ms % 60000) / 1000);
	// Carry a rounded-up 60 seconds into the next minute.
	if (seconds === 60) {
		minutes += 1;
		seconds = 0;
	}
	return `${minutes}m ${seconds}s`;
}
