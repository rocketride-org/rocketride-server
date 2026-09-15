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
// HISTORY — TRIM (the bounds, as pure functions)
// =============================================================================
//
// History rides the app's workspace preferences file, which is read and
// written on every app switch. An unbounded list would make every switch
// slower for everyone, so the bounds below are not advisory — they are
// enforced before every write.
//
// Entry order is NEWEST FIRST throughout this module.
// =============================================================================

import type { IHistoryEntry } from './types';

// =============================================================================
// LIMITS
// =============================================================================

/** The per-connection bounds applied before every persist. */
export interface IHistoryLimits {
	/** Entries kept per connection, PINNED ENTRIES INCLUDED. */
	maxEntries: number;
	/** Longest statement text kept; longer text is cut and marked. */
	maxSqlChars: number;
	/** Longest error text kept. */
	maxErrorChars: number;
}

/** The approved bounds (08-approved-scope.md). */
export const DEFAULT_HISTORY_LIMITS: IHistoryLimits = {
	maxEntries: 100,
	maxSqlChars: 8 * 1024,
	maxErrorChars: 1024,
};

/** Ceiling on the whole multi-connection bag, measured as serialised JSON. */
export const MAX_HISTORY_BAG_CHARS = 256 * 1024;

// =============================================================================
// PER-CONNECTION TRIM
// =============================================================================

/**
 * Whether two adjacent entries record the same statement text.
 *
 * @param a - The newer entry.
 * @param b - The older entry.
 * @returns True when the statements are identical.
 */
function sameStatement(a: IHistoryEntry, b: IHistoryEntry): boolean {
	return a.sql === b.sql;
}

/**
 * Collapse a newer entry onto the older one it repeats.
 *
 * The OLDER entry survives, keeping its id, pin and note — a person who
 * pinned or annotated a statement means that statement, and re-running it
 * must not silently discard what they wrote. Everything about the RUN comes
 * from the newer entry.
 *
 * @param newer - The newer, duplicate entry.
 * @param older - The older entry it repeats.
 * @returns The merged entry.
 */
function collapse(newer: IHistoryEntry, older: IHistoryEntry): IHistoryEntry {
	const merged: IHistoryEntry = {
		...older,
		at: newer.at,
		ms: newer.ms,
		outcome: newer.outcome,
		kind: newer.kind,
	};

	// Run facts are replaced wholesale, so a success after a failure does not
	// keep the stale error (and vice versa). The row limit is one of them: a
	// row count carried over from a run under a different limit would describe
	// the merged entry wrongly in exactly the way IHistoryEntry.limit exists
	// to prevent.
	delete merged.rows;
	delete merged.affected;
	delete merged.error;
	delete merged.limit;
	if (newer.rows !== undefined) merged.rows = newer.rows;
	if (newer.affected !== undefined) merged.affected = newer.affected;
	if (newer.error !== undefined) merged.error = newer.error;
	if (newer.limit !== undefined) merged.limit = newer.limit;

	if (newer.truncated) merged.truncated = true;
	// A note on the newer entry only wins when the older one carries none.
	if (newer.note && !older.note) merged.note = newer.note;
	if (newer.pinned) merged.pinned = true;

	return merged;
}

/**
 * Apply the per-entry bounds: statement text and error text.
 *
 * @param entry - The entry to bound.
 * @param limits - The bounds to apply.
 * @returns The bounded entry (the same object when nothing was over).
 */
function boundEntry(entry: IHistoryEntry, limits: IHistoryLimits): IHistoryEntry {
	const sqlOver = entry.sql.length > limits.maxSqlChars;
	const errorOver = (entry.error?.length ?? 0) > limits.maxErrorChars;
	if (!sqlOver && !errorOver) return entry;

	const bounded: IHistoryEntry = { ...entry };
	if (sqlOver) {
		bounded.sql = entry.sql.slice(0, limits.maxSqlChars);
		bounded.truncated = true;
	}
	if (errorOver) bounded.error = (entry.error as string).slice(0, limits.maxErrorChars);
	return bounded;
}

/**
 * Bring one connection's history inside every bound.
 *
 * Order of work, and why:
 *  1. collapse consecutive repeats of the same statement, carrying the newer
 *     run onto the older entry — compared on the FULL text, because two
 *     different statements that happen to share their first `maxSqlChars`
 *     characters are not the same statement and must not become one entry.
 *     An entry that is ALREADY truncated no longer has its full text, so it
 *     is never collapsed at all (see the step itself);
 *  2. bound each entry's statement and error text — a single huge statement
 *     must not be able to consume the whole budget;
 *  3. cap the count at {@link IHistoryLimits.maxEntries}, PINS INCLUDED,
 *     dropping unpinned entries oldest-first and only then pinned ones. A pin
 *     buys priority, not immunity: an unbounded pinned list is the same
 *     problem under a nicer name.
 *
 * @param entries - The connection's entries, newest first.
 * @param limits - The bounds to apply (defaults to the approved bounds).
 * @returns A new, bounded array (newest first).
 */
export function trimHistory(
	entries: IHistoryEntry[],
	limits: IHistoryLimits = DEFAULT_HISTORY_LIMITS,
): IHistoryEntry[] {
	// ── 1. Collapse consecutive repeats, on the UNTRUNCATED text ─────────────
	//
	// Only entries whose text is COMPLETE may be collapsed. Truncation happens
	// in step 2 below, so a run that arrives fresh is still compared on its
	// full text — but `historyStore.hydrate` feeds ALREADY-BOUNDED entries
	// back through this function on every reload, and there `sql` is a prefix.
	// Two different statements sharing their first `maxSqlChars` characters
	// would compare equal, and the collapse would destroy one real entry each
	// time the app is opened. A prefix cannot prove sameness, so a truncated
	// entry is never merged: keeping a duplicate row costs one line, losing a
	// distinct statement costs the user their history.
	const deduped: IHistoryEntry[] = [];
	for (const entry of entries) {
		const previous = deduped[deduped.length - 1];
		if (previous && !previous.truncated && !entry.truncated && sameStatement(previous, entry)) {
			// `previous` is the NEWER of the pair (newest-first ordering).
			deduped[deduped.length - 1] = collapse(previous, entry);
			continue;
		}
		deduped.push(entry);
	}

	// ── 2. Per-entry bounds ──────────────────────────────────────────────────
	const bounded = deduped.map((entry) => boundEntry(entry, limits));

	// ── 3. Count cap: unpinned oldest-first, then pinned oldest-first ────────
	if (bounded.length <= limits.maxEntries) return bounded;

	const doomed = new Set<number>();
	let excess = bounded.length - limits.maxEntries;

	for (let i = bounded.length - 1; i >= 0 && excess > 0; i -= 1) {
		if (!bounded[i]?.pinned) {
			doomed.add(i);
			excess -= 1;
		}
	}
	for (let i = bounded.length - 1; i >= 0 && excess > 0; i -= 1) {
		if (doomed.has(i)) continue;
		doomed.add(i);
		excess -= 1;
	}

	return bounded.filter((_, index) => !doomed.has(index));
}

// =============================================================================
// WHOLE-BAG TRIM
// =============================================================================

/** History for every connection, keyed by endpoint key. */
export type HistoryBag = Record<string, IHistoryEntry[]>;

/**
 * Serialised size of the bag, in characters of JSON — the same measure the
 * workspace file is written in, so the budget means what it says.
 *
 * @param bag - The bag to measure.
 * @returns The serialised length.
 */
export function bagSize(bag: HistoryBag): number {
	return JSON.stringify(bag).length;
}

/**
 * Bring the whole multi-connection bag under a byte budget by dropping the
 * globally OLDEST entry until it fits — unpinned entries first, across every
 * connection, then pinned ones. Connections left empty are removed entirely,
 * which reads the same as never having recorded (unknown keys are empty).
 *
 * @param bag - History for every connection.
 * @param maxChars - The budget (defaults to {@link MAX_HISTORY_BAG_CHARS}).
 * @returns A new bag within budget.
 */
export function trimBag(bag: HistoryBag, maxChars: number = MAX_HISTORY_BAG_CHARS): HistoryBag {
	// Copy the arrays so the caller's bag is never mutated.
	const next: HistoryBag = {};
	for (const [key, entries] of Object.entries(bag)) next[key] = [...entries];

	while (bagSize(next) > maxChars) {
		// Oldest first, preferring unpinned; the loop's two passes keep pins
		// alive until nothing else is left to give.
		let victimKey: string | null = null;
		let victimIndex = -1;
		let victimAt = Number.POSITIVE_INFINITY;
		let victimPinned = true;

		for (const [key, entries] of Object.entries(next)) {
			for (let i = 0; i < entries.length; i += 1) {
				const entry = entries[i] as IHistoryEntry;
				const pinned = !!entry.pinned;
				// An unpinned candidate always beats a pinned one; among equals,
				// the older `at` wins.
				const better = victimPinned && !pinned ? true
					: (!victimPinned && pinned ? false : entry.at < victimAt);
				if (!better) continue;
				victimKey = key;
				victimIndex = i;
				victimAt = entry.at;
				victimPinned = pinned;
			}
		}

		// Nothing left to drop — return what we have rather than spin.
		if (victimKey === null || victimIndex < 0) break;
		(next[victimKey] as IHistoryEntry[]).splice(victimIndex, 1);
		if ((next[victimKey] as IHistoryEntry[]).length === 0) delete next[victimKey];
	}

	return next;
}
