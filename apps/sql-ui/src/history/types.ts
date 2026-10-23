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
// HISTORY — TYPES (the record of one statement the user ran)
// =============================================================================
//
// SQL Explorer's binding of the shared history types (shared/explorer/history).
// Entries ride the app's server-side workspace preferences, so every field
// here ends up on disk: the statement text is stored AS TYPED, literal values
// included, under the persisted field name `sql` — which must never change,
// because renaming it silently orphans every user's saved history.
// =============================================================================

import type { IHistoryEntryBase } from 'shared/explorer/history/types';

export type { HistoryOutcome } from 'shared/explorer/history/types';

/**
 * What the statement was, by TEXT PATTERN — a lexical guess, not a promise
 * from the database.
 */
export type HistoryKind = 'read' | 'write' | 'ddl' | 'tx' | 'other';

/** One statement the user ran on one connection. */
export type HistoryEntry = IHistoryEntryBase & {
	/** The statement text as typed (possibly truncated — see `truncated`). */
	sql: string;
	/** Statement kind, by pattern. */
	kind: HistoryKind;
};
