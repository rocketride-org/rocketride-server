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
// SQL Explorer's binding of the shared trim (shared/explorer/history/trim):
// the logic lives there; this module fixes the text field to `sql` and keeps
// the limit name `maxSqlChars` that SQL Explorer's callers and tests use.
//
// Entry order is NEWEST FIRST throughout.
// =============================================================================

import { DEFAULT_HISTORY_LIMITS as SHARED_LIMITS, MAX_HISTORY_BAG_CHARS } from 'shared/explorer/history/types';
import { bagSize, trimBag, trimHistory as trimShared } from 'shared/explorer/history/trim';
import type { HistoryEntry } from './types';

export { MAX_HISTORY_BAG_CHARS, bagSize, trimBag };

/** The per-connection bounds applied before every persist. */
export interface HistoryLimits {
	/** Entries kept per connection, PINNED ENTRIES INCLUDED. */
	maxEntries: number;
	/** Longest statement text kept; longer text is cut and marked. */
	maxSqlChars: number;
	/** Longest error text kept. */
	maxErrorChars: number;
}

/** The approved bounds (08-approved-scope.md). */
export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
	maxEntries: SHARED_LIMITS.maxEntries,
	maxSqlChars: SHARED_LIMITS.maxTextChars,
	maxErrorChars: SHARED_LIMITS.maxErrorChars,
};

/**
 * Bring one connection's history inside every bound (collapse repeats, bound
 * each entry's text, cap the count — see shared/explorer/history/trim).
 *
 * @param entries - The connection's entries, newest first.
 * @param limits - The bounds to apply (defaults to the approved bounds).
 * @returns A new, bounded array (newest first).
 */
export function trimHistory(entries: HistoryEntry[], limits: HistoryLimits = DEFAULT_HISTORY_LIMITS): HistoryEntry[] {
	return trimShared<'sql'>(entries, 'sql', {
		maxEntries: limits.maxEntries,
		maxTextChars: limits.maxSqlChars,
		maxErrorChars: limits.maxErrorChars,
	}) as HistoryEntry[];
}
