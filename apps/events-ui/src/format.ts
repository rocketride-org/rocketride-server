// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EVENTS-UI — FORMATTING HELPERS
// =============================================================================

/** Body keys probed, in order, for a compact one-line event summary. */
const SUMMARY_HINT_KEYS = ['action', 'state', 'status', 'name', 'op'] as const;

/** Number of leading body keys shown when no hint key is present. */
const SUMMARY_PREVIEW_KEYS = 4;

/**
 * Format an epoch-millisecond timestamp as a local wall-clock time with
 * millisecond precision (HH:MM:SS.mmm) — the resolution an event monitor
 * needs to read burst ordering.
 *
 * @param ms - Timestamp in epoch milliseconds.
 * @returns The formatted time string.
 */
export function formatTime(ms: number): string {
	const d = new Date(ms);
	// Zero-pad each part so the column stays fixed-width and monospace-aligned.
	const h = String(d.getHours()).padStart(2, '0');
	const m = String(d.getMinutes()).padStart(2, '0');
	const s = String(d.getSeconds()).padStart(2, '0');
	const millis = String(d.getMilliseconds()).padStart(3, '0');
	return `${h}:${m}:${s}.${millis}`;
}

/**
 * Derive a compact one-line summary of a DAP event body: prefer a recognised
 * hint key (action / state / status / name / op) rendered as `key=value`, and
 * otherwise list the first few keys. Empty bodies read as '{}'.
 *
 * @param body - The DAP event body.
 * @returns The one-line summary string.
 */
export function summarize(body: Record<string, unknown>): string {
	const keys = Object.keys(body);
	if (keys.length === 0) return '{}';

	// Prefer a semantic hint key when present (the most useful at-a-glance value).
	for (const hint of SUMMARY_HINT_KEYS) {
		if (body[hint] !== undefined && body[hint] !== null) {
			return `${hint}=${JSON.stringify(body[hint])}`;
		}
	}

	// Fallback: a preview of the leading keys, elided when there are more.
	const preview = keys.slice(0, SUMMARY_PREVIEW_KEYS).join(', ');
	return keys.length > SUMMARY_PREVIEW_KEYS ? `{${preview}, ...}` : `{${preview}}`;
}
