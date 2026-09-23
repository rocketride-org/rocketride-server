// MIT License
//
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
// HISTORY TRIM — unit tests for every bound the history store enforces
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IHistoryEntry } from '../src/history/types';
import {
	DEFAULT_HISTORY_LIMITS,
	MAX_HISTORY_BAG_CHARS,
	bagSize,
	trimBag,
	trimHistory,
} from '../src/history/trim';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build one entry. Defaults are a plain successful read.
 *
 * @param over - Fields to override.
 * @returns The entry.
 */
function entry(over: Partial<IHistoryEntry> = {}): IHistoryEntry {
	return {
		id: over.id ?? `e${over.at ?? 0}`,
		sql: 'SELECT 1',
		at: 0,
		ms: 5,
		outcome: 'rows',
		rows: 1,
		kind: 'read',
		...over,
	};
}

/**
 * Build `count` entries, newest first, each with a distinct statement.
 *
 * @param count - How many entries.
 * @param over - Fields applied to every entry.
 * @returns The entries, newest first.
 */
function series(count: number, over: Partial<IHistoryEntry> = {}): IHistoryEntry[] {
	return Array.from({ length: count }, (_, i) => entry({
		id: `e${count - i}`,
		sql: `SELECT ${count - i}`,
		at: count - i,
		...over,
	}));
}

// =============================================================================
// PER-ENTRY BOUNDS
// =============================================================================

describe('trimHistory — statement and error text', () => {
	it('cuts a statement over the bound and marks it truncated', () => {
		const long = 'x'.repeat(DEFAULT_HISTORY_LIMITS.maxSqlChars + 500);
		const [kept] = trimHistory([entry({ sql: long })]);
		assert.equal(kept?.sql.length, DEFAULT_HISTORY_LIMITS.maxSqlChars);
		assert.equal(kept?.truncated, true);
	});

	it('leaves a statement at exactly the bound alone', () => {
		const exact = 'x'.repeat(DEFAULT_HISTORY_LIMITS.maxSqlChars);
		const [kept] = trimHistory([entry({ sql: exact })]);
		assert.equal(kept?.sql.length, DEFAULT_HISTORY_LIMITS.maxSqlChars);
		assert.equal(kept?.truncated, undefined);
	});

	it('cuts error text to its own smaller bound', () => {
		const long = 'e'.repeat(DEFAULT_HISTORY_LIMITS.maxErrorChars + 42);
		const [kept] = trimHistory([entry({ outcome: 'error', error: long })]);
		assert.equal(kept?.error?.length, DEFAULT_HISTORY_LIMITS.maxErrorChars);
	});

	it('does not mutate the entries it was given', () => {
		const original = entry({ sql: 'y'.repeat(DEFAULT_HISTORY_LIMITS.maxSqlChars + 1) });
		trimHistory([original]);
		assert.equal(original.sql.length, DEFAULT_HISTORY_LIMITS.maxSqlChars + 1);
		assert.equal(original.truncated, undefined);
	});
});

// =============================================================================
// DEDUPE
// =============================================================================

describe('trimHistory — consecutive repeats', () => {
	it('collapses a repeat onto the older entry, keeping its identity', () => {
		const kept = trimHistory([
			entry({ id: 'new', at: 20, outcome: 'error', error: 'boom', rows: undefined }),
			entry({ id: 'old', at: 10, outcome: 'rows', rows: 7 }),
		]);
		assert.equal(kept.length, 1);
		assert.equal(kept[0]?.id, 'old');
		assert.equal(kept[0]?.at, 20);
		assert.equal(kept[0]?.outcome, 'error');
		assert.equal(kept[0]?.error, 'boom');
		// The previous run's row count must not survive a later failure.
		assert.equal(kept[0]?.rows, undefined);
	});

	it('keeps the pin and note the user attached to the older entry', () => {
		const kept = trimHistory([
			entry({ id: 'new', at: 20 }),
			entry({ id: 'old', at: 10, pinned: true, note: 'the nightly check' }),
		]);
		assert.equal(kept.length, 1);
		assert.equal(kept[0]?.pinned, true);
		assert.equal(kept[0]?.note, 'the nightly check');
	});

	it('leaves non-consecutive repeats alone', () => {
		const kept = trimHistory([
			entry({ id: 'c', at: 30, sql: 'SELECT 1' }),
			entry({ id: 'b', at: 20, sql: 'SELECT 2' }),
			entry({ id: 'a', at: 10, sql: 'SELECT 1' }),
		]);
		assert.deepEqual(kept.map((e) => e.id), ['c', 'b', 'a']);
	});

	it('carries the newer run\'s row limit onto the surviving entry', () => {
		// A row count without ITS limit is ambiguous, so keeping the older
		// run's limit beside the newer run's count describes neither.
		const kept = trimHistory([
			entry({ id: 'new', at: 20, rows: 200, limit: 200 }),
			entry({ id: 'old', at: 10, rows: 1000, limit: 1000 }),
		]);
		assert.equal(kept.length, 1);
		assert.equal(kept[0]?.rows, 200);
		assert.equal(kept[0]?.limit, 200);
	});

	it('drops the older limit when the newer run had none', () => {
		const kept = trimHistory([
			entry({ id: 'new', at: 20, rows: 4000 }),
			entry({ id: 'old', at: 10, rows: 1000, limit: 1000 }),
		]);
		assert.equal(kept.length, 1);
		assert.equal(kept[0]?.limit, undefined);
	});

	it('does not collapse two statements that only agree up to the bound', () => {
		// Deduplication used to run on the TRUNCATED text, so two different
		// statements sharing a long prefix became one entry and one of them
		// was lost from history entirely.
		const prefix = 'SELECT '.padEnd(DEFAULT_HISTORY_LIMITS.maxSqlChars, 'a');
		const kept = trimHistory([
			entry({ id: 'new', at: 20, sql: `${prefix} FROM invoices` }),
			entry({ id: 'old', at: 10, sql: `${prefix} FROM orders` }),
		]);
		assert.deepEqual(kept.map((e) => e.id), ['new', 'old']);
		// Both are still bounded for storage.
		assert.deepEqual(kept.map((e) => e.sql.length), [DEFAULT_HISTORY_LIMITS.maxSqlChars, DEFAULT_HISTORY_LIMITS.maxSqlChars]);
		assert.deepEqual(kept.map((e) => e.truncated), [true, true]);
	});

	it('does not collapse entries that arrive ALREADY truncated', () => {
		// The reload path: `historyStore.hydrate` reads bounded entries back
		// out of the workspace file and passes them through trimHistory again.
		// Their `sql` is now a prefix, so comparing text cannot tell two
		// different statements apart — and collapsing them would delete one
		// real entry on every open. Feeding the OUTPUT of the previous test
		// back in is exactly that situation.
		const prefix = 'SELECT '.padEnd(DEFAULT_HISTORY_LIMITS.maxSqlChars, 'a');
		const stored = trimHistory([
			entry({ id: 'new', at: 20, sql: `${prefix} FROM invoices` }),
			entry({ id: 'old', at: 10, sql: `${prefix} FROM orders` }),
		]);
		assert.equal(stored[0]?.sql, stored[1]?.sql, 'the stored prefixes are identical, which is the trap');

		const reloaded = trimHistory(stored);
		assert.deepEqual(reloaded.map((e) => e.id), ['new', 'old']);
	});

	it('keeps a fresh repeat of a truncated statement as its own entry', () => {
		// The conservative direction of the same rule: a prefix cannot prove
		// two statements are the same, so re-running a huge statement adds a
		// row instead of merging into one that may not match. One extra row
		// is the acceptable cost of never destroying a distinct statement.
		const long = 'x'.repeat(DEFAULT_HISTORY_LIMITS.maxSqlChars + 40);
		const kept = trimHistory([
			entry({ id: 'new', at: 20, sql: long }),
			entry({ id: 'old', at: 10, sql: long, truncated: true }),
		]);
		assert.deepEqual(kept.map((e) => e.id), ['new', 'old']);
	});

	it('collapses a run of three identical statements into one', () => {
		const kept = trimHistory([
			entry({ id: 'c', at: 30 }),
			entry({ id: 'b', at: 20 }),
			entry({ id: 'a', at: 10 }),
		]);
		assert.deepEqual(kept.map((e) => [e.id, e.at]), [['a', 30]]);
	});
});

// =============================================================================
// COUNT CAP
// =============================================================================

describe('trimHistory — the 100-entry cap', () => {
	it('keeps 100 and drops the oldest', () => {
		const kept = trimHistory(series(130));
		assert.equal(kept.length, 100);
		assert.equal(kept[0]?.id, 'e130');
		assert.equal(kept[99]?.id, 'e31');
	});

	it('counts pinned entries against the same cap', () => {
		const entries = series(120);
		// Pin the three oldest.
		for (const e of entries.slice(-3)) e.pinned = true;
		const kept = trimHistory(entries);
		assert.equal(kept.length, 100);
		// The pins survive; unpinned entries were dropped instead.
		assert.equal(kept.filter((e) => e.pinned).length, 3);
		assert.deepEqual(kept.slice(-3).map((e) => e.id), ['e3', 'e2', 'e1']);
	});

	it('drops pinned entries oldest-first once nothing else is left', () => {
		const kept = trimHistory(series(110, { pinned: true }));
		assert.equal(kept.length, 100);
		assert.equal(kept[0]?.id, 'e110');
		assert.equal(kept[99]?.id, 'e11');
	});

	it('leaves a list at the cap untouched', () => {
		const kept = trimHistory(series(100));
		assert.equal(kept.length, 100);
	});

	it('handles an empty list', () => {
		assert.deepEqual(trimHistory([]), []);
	});
});

// =============================================================================
// WHOLE-BAG BUDGET
// =============================================================================

describe('trimBag', () => {
	it('leaves a small bag alone', () => {
		const bag = { 'p:s:n1': series(3), 'p:s:n2': series(2) };
		const kept = trimBag(bag);
		assert.equal(bagSize(kept), bagSize(bag));
	});

	it('drops the oldest entries across connections until it fits', () => {
		const filler = 'z'.repeat(3000);
		// Connection n1 holds the older half of the bag, n2 the newer half.
		const bag = {
			'p:s:n1': series(60, { sql: filler }).map((e, i) => ({ ...e, at: 1000 + i })),
			'p:s:n2': series(60, { sql: filler }).map((e, i) => ({ ...e, at: 2000 + i })),
		};
		assert.equal(bagSize(bag) > MAX_HISTORY_BAG_CHARS, true);

		const kept = trimBag(bag);
		assert.equal(bagSize(kept) <= MAX_HISTORY_BAG_CHARS, true);
		// Age decides, not which connection: the newer connection is untouched
		// while the older one still has entries to give.
		assert.equal(kept['p:s:n2']?.length, 60);
		assert.equal((kept['p:s:n1']?.length ?? 0) < 60, true);
	});

	it('keeps pinned entries until only pinned entries are left', () => {
		const filler = 'z'.repeat(400);
		const bag: Record<string, IHistoryEntry[]> = {
			k: [
				entry({ id: 'pin', at: 1, sql: filler, pinned: true }),
				entry({ id: 'a', at: 2, sql: `${filler}a` }),
				entry({ id: 'b', at: 3, sql: `${filler}b` }),
			],
		};
		const kept = trimBag(bag, 700);
		assert.deepEqual(kept.k?.map((e) => e.id), ['pin']);
	});

	it('removes a connection whose entries are all gone', () => {
		const bag = { k: [entry({ id: 'only', sql: 'z'.repeat(500) })] };
		assert.deepEqual(trimBag(bag, 50), {});
	});

	it('does not mutate the bag it was given', () => {
		const bag = { k: [entry({ id: 'a', sql: 'z'.repeat(500) })] };
		trimBag(bag, 50);
		assert.equal(bag.k.length, 1);
	});

	it('stops rather than spinning when nothing can be dropped', () => {
		assert.deepEqual(trimBag({}, 0), {});
	});
});
