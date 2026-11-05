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
// HISTORY — OUTCOME BADGE (what one entry's outcome is called)
// =============================================================================
//
// `abandoned` is stored for a statement nobody waited for (Stop waiting) and
// for an apply statement whose fate is not known (a lost commit answer, or an
// engine that may keep no transactions). For anything but a read, either way
// it may or may not have been saved, so the badge says "outcome unknown";
// "abandoned" would read as "nothing ran". The outcome type is shared with the
// other Explorers and stored as is, so the badge reads the entry's kind, and
// stored entries, old ones included, read correctly without a change.
// =============================================================================

import type { HistoryEntry } from './types';

/** A badge: its colour and its words. */
export interface OutcomeBadge {
	/** The shell StatusBadge variant. */
	variant: 'success' | 'info' | 'warning' | 'error' | 'muted';
	/** What it says. */
	label: string;
}

/**
 * The badge for an entry's outcome.
 *
 * @param entry - The entry.
 * @returns The badge.
 */
export function outcomeBadge(entry: HistoryEntry): OutcomeBadge {
	switch (entry.outcome) {
		case 'rows': return {
			variant: 'success',
			// A bare row count cannot say whether it is the whole answer or
			// the ceiling cutting it off, so it never appears without one.
			label: entry.limit !== undefined
				? `${entry.rows ?? 0} rows (limit ${entry.limit})`
				: `${entry.rows ?? 0} rows returned`,
		};
		case 'affected': return { variant: 'info', label: `${entry.affected ?? 0} affected` };
		case 'error': return { variant: 'error', label: 'error' };
		// A read nobody waited for changed nothing.
		default: return entry.kind === 'read' ? { variant: 'muted', label: 'abandoned' } : { variant: 'warning', label: 'outcome unknown' };
	}
}
