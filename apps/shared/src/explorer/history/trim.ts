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
// EXPLORER HISTORY — TRIM (the bounds, as pure functions)
// =============================================================================
//
// History rides the app's workspace preferences file, which is read and
// written on every app switch. An unbounded list would make every switch
// slower for everyone, so the bounds below are not advisory — they are
// enforced before every write.
//
// Entry order is NEWEST FIRST throughout this module. The text field's name is
// a parameter (`sql`, `cypher`): the logic never cares what the statement is,
// only how long it is and whether two entries repeat it.
// =============================================================================

import { DEFAULT_HISTORY_LIMITS, MAX_HISTORY_BAG_CHARS } from './types';
import type { IHistoryEntry, IHistoryEntryBase, IHistoryLimits } from './types';

// =============================================================================
// ENTRY ACCESS
// =============================================================================

/** An entry as the trim sees it: the base fields plus the text under some name. */
type AnyEntry = IHistoryEntryBase & Record<string, unknown>;

/**
 * Read an entry's statement text.
 *
 * @param entry - The entry.
 * @param field - The name of the text field.
 * @returns The text ('' when the field is not a string).
 */
export function textOf(entry: IHistoryEntryBase, field: string): string {
	const value = (entry as AnyEntry)[field];
	return typeof value === 'string' ? value : '';
}

// =============================================================================
// PER-CONNECTION TRIM
// =============================================================================

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
function collapse<E extends IHistoryEntryBase>(newer: E, older: E): E {
	const merged: E = {
		...older,
		at: newer.at,
		ms: newer.ms,
		outcome: newer.outcome,
		kind: newer.kind,
	};

	// Run facts are replaced wholesale, so a success after a failure does not
	// keep the stale error (and vice versa). The row limit is one of them: a
	// row count carried over from a run under a different limit would describe
	// the merged entry wrongly in exactly the way IHistoryEntryBase.limit exists
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
 * @param field - The name of the text field.
 * @param limits - The bounds to apply.
 * @returns The bounded entry (the same object when nothing was over).
 */
function boundEntry<E extends IHistoryEntryBase>(entry: E, field: string, limits: IHistoryLimits): E {
	const text = textOf(entry, field);
	const textOver = text.length > limits.maxTextChars;
	const errorOver = (entry.error?.length ?? 0) > limits.maxErrorChars;
	if (!textOver && !errorOver) return entry;

	const bounded: E = { ...entry };
	if (textOver) {
		(bounded as AnyEntry)[field] = text.slice(0, limits.maxTextChars);
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
 *     different statements that happen to share their first `maxTextChars`
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
 * @param field - The name of the persisted text field ('sql', 'cypher').
 * @param limits - The bounds to apply (defaults to the approved bounds).
 * @returns A new, bounded array (newest first).
 */
export function trimHistory<F extends string>(
	entries: IHistoryEntry<F>[],
	field: F,
	limits: IHistoryLimits = DEFAULT_HISTORY_LIMITS,
): IHistoryEntry<F>[] {
	// ── 1. Collapse consecutive repeats, on the UNTRUNCATED text ─────────────
	//
	// Only entries whose text is COMPLETE may be collapsed. Truncation happens
	// in step 2 below, so a run that arrives fresh is still compared on its
	// full text — but `hydrate` feeds ALREADY-BOUNDED entries back through this
	// function on every reload, and there the text is a prefix. Two different
	// statements sharing their first `maxTextChars` characters would compare
	// equal, and the collapse would destroy one real entry each time the app is
	// opened. A prefix cannot prove sameness, so a truncated entry is never
	// merged: keeping a duplicate row costs one line, losing a distinct
	// statement costs the user their history.
	const deduped: IHistoryEntry<F>[] = [];
	for (const entry of entries) {
		const previous = deduped[deduped.length - 1];
		if (previous && !previous.truncated && !entry.truncated && textOf(previous, field) === textOf(entry, field)) {
			// `previous` is the NEWER of the pair (newest-first ordering).
			deduped[deduped.length - 1] = collapse(previous, entry);
			continue;
		}
		deduped.push(entry);
	}

	// ── 2. Per-entry bounds ──────────────────────────────────────────────────
	const bounded = deduped.map((entry) => boundEntry(entry, field, limits));

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

/**
 * Serialised size of the bag, in characters of JSON — the same measure the
 * workspace file is written in, so the budget means what it says.
 *
 * @param bag - The bag to measure.
 * @returns The serialised length.
 */
export function bagSize<E extends IHistoryEntryBase>(bag: Record<string, E[]>): number {
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
export function trimBag<E extends IHistoryEntryBase>(bag: Record<string, E[]>, maxChars: number = MAX_HISTORY_BAG_CHARS): Record<string, E[]> {
	// Copy the arrays so the caller's bag is never mutated.
	const next: Record<string, E[]> = {};
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
				const entry = entries[i] as E;
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
		(next[victimKey] as E[]).splice(victimIndex, 1);
		if ((next[victimKey] as E[]).length === 0) delete next[victimKey];
	}

	return next;
}
