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
// EXPLORER HISTORY — TYPES (the record of one statement the user ran)
// =============================================================================
//
// Shared between each app's query runner (which emits entries) and the history
// store (which keeps and persists them). Entries ride the app's server-side
// workspace preferences, so every field here ends up on disk: the statement
// text is stored AS TYPED, literal values included.
//
// The text field's NAME is a parameter of the store (`sql` for SQL Explorer,
// `cypher` for Graph Explorer) because renaming a stored field silently
// orphans every user's saved history. The type below is generic over it.
// =============================================================================

/** How a statement ended. */
export type HistoryOutcome = 'rows' | 'affected' | 'error' | 'abandoned';

/** Everything about one run except the statement text. */
export interface IHistoryEntryBase {
	/** Stable identity within the connection's list. */
	id: string;
	/** Unix ms the run started. */
	at: number;
	/** Round-trip milliseconds (tool call out and back, not database time). */
	ms: number;
	/** How the run ended. */
	outcome: HistoryOutcome;
	/** Rows returned, when the outcome is `rows`. */
	rows?: number;
	/**
	 * The row limit in force for this run, when one was applied. A row count
	 * without its limit is ambiguous: `1000 rows` could be the whole answer or
	 * the ceiling cutting it off, and those mean opposite things.
	 */
	limit?: number;
	/** Rows affected, when the outcome is `affected`. */
	affected?: number;
	/** Error text, when the outcome is `error` (stored bounded). */
	error?: string;
	/**
	 * What the statement was, by TEXT PATTERN — a lexical guess, not a promise
	 * from the database. The vocabulary belongs to the app.
	 */
	kind: string;
	/** Pinned entries survive trimming until only pinned entries remain. */
	pinned?: boolean;
	/** The user's own note on this entry. */
	note?: string;
	/** True when the statement text was cut to fit the per-statement bound. */
	truncated?: boolean;
}

/**
 * One statement the user ran on one connection. `F` names the persisted text
 * field: `IHistoryEntry<'sql'>` carries `sql`, `IHistoryEntry<'cypher'>` carries `cypher`.
 */
export type IHistoryEntry<F extends string> = IHistoryEntryBase & { [K in F]: string };

/** The per-connection bounds applied before every persist. */
export interface IHistoryLimits {
	/** Entries kept per connection, PINNED ENTRIES INCLUDED. */
	maxEntries: number;
	/** Longest statement text kept; longer text is cut and marked. */
	maxTextChars: number;
	/** Longest error text kept. */
	maxErrorChars: number;
}

/** The approved bounds (08-approved-scope.md). */
export const DEFAULT_HISTORY_LIMITS: IHistoryLimits = {
	maxEntries: 100,
	maxTextChars: 8 * 1024,
	maxErrorChars: 1024,
};

/** Ceiling on the whole multi-connection bag, measured as serialised JSON. */
export const MAX_HISTORY_BAG_CHARS = 256 * 1024;

/** History for every connection, keyed by endpoint key (newest first per connection). */
export type HistoryBag<F extends string> = Record<string, IHistoryEntry<F>[]>;

/** The `{ getPref, setPref }` accessor the store persists through (the shell's IPrefsApi satisfies it). */
export interface IPrefsAccessor {
	/** Read one preference. */
	getPref(key: string): unknown;
	/** Write one preference. */
	setPref(key: string, value: unknown): void;
}
