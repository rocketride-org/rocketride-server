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
// VECTOR - SAVED FILTERS (pure): named condition sets, per connection, in memory
// =============================================================================
//
// The ScopeBar's Save and Saved. A saved filter is a name and the conditions
// in the wire shape of `documents.filter` (never the path box, never a
// document id, never anything from the store's answers), kept in a Map keyed
// by the endpoint key that the app owns (adapters/connections.ts
// `savedFilters`, registered as 'saved filters' with the cache registry): it
// survives switching connections within a session and is emptied on a change
// of identity. Nothing is written to browser storage.
// =============================================================================

import type { IDocumentsFilter, ISavedFilter } from '../contract/types';
import { conditionsFilter, validateFilter } from './filters';

/** At most this many saved filters per connection. */
export const SAVED_FILTERS_MAX = 20;

/** A saved filter's name has at most this many characters. */
export const SAVED_NAME_MAX = 60;

/** The app's map of saved filters, by endpoint key. */
export type SavedFiltersMap = Map<string, readonly ISavedFilter[]>;

/** The outcome of Save. */
export type SaveOutcome = { ok: true; saved: ISavedFilter } | { ok: false; error: string };

/** One connection's saved filters. */
export interface ISavedFilters {
	/** The saved filters, oldest first (a frozen copy). */
	list(): readonly ISavedFilter[];
	get(id: string): ISavedFilter | null;
	/** Save the conditions under a name; a name already used (ignoring case) is replaced in place. */
	save(name: string, filter: IDocumentsFilter, now?: number): SaveOutcome;
	remove(id: string): void;
}

let sequence = 0;

/**
 * A frozen deep copy of a saved filter.
 *
 * @param entry - The entry.
 * @returns The copy.
 */
function frozen(entry: ISavedFilter): ISavedFilter {
	const filter = { ...entry.filter };
	if (filter.file_types) filter.file_types = Object.freeze([...filter.file_types]) as string[];
	return Object.freeze({ ...entry, filter: Object.freeze(filter) });
}

/**
 * The saved filters of one connection.
 *
 * @param map - The app's map (adapters/connections.ts `savedFilters`; tests pass their own).
 * @param connectionKey - endpoint.key.
 * @param opts - `newId` (tests make ids predictable).
 * @returns The accessor.
 */
export function savedFiltersFor(map: SavedFiltersMap, connectionKey: string, opts: { newId?: () => string } = {}): ISavedFilters {
	const newId = opts.newId ?? (() => `saved-${(sequence += 1)}`);
	const current = (): readonly ISavedFilter[] => map.get(connectionKey) ?? [];
	const put = (list: readonly ISavedFilter[]): void => {
		if (list.length === 0) map.delete(connectionKey);
		else map.set(connectionKey, Object.freeze([...list]));
	};
	return {
		list: () => Object.freeze([...current()]),
		get: (id) => current().find((f) => f.id === id) ?? null,
		save(name, filter, now = Date.now()): SaveOutcome {
			const clean = name.trim();
			if (clean === '') return { ok: false, error: 'Name the filter first.' };
			if (clean.length > SAVED_NAME_MAX) return { ok: false, error: `A name has at most ${SAVED_NAME_MAX} characters.` };
			const conditions = conditionsFilter(filter);
			if (conditions === null) return { ok: false, error: 'Add a condition before saving.' };
			const invalid = validateFilter(conditions);
			if (invalid !== null) return { ok: false, error: invalid };
			const list = current();
			const at = list.findIndex((f) => f.name.toLowerCase() === clean.toLowerCase());
			if (at < 0 && list.length >= SAVED_FILTERS_MAX) return { ok: false, error: `At most ${SAVED_FILTERS_MAX} saved filters per connection; delete one first.` };
			const saved = frozen({ id: at < 0 ? newId() : (list[at] as ISavedFilter).id, name: clean, filter: conditions, savedAt: now });
			put(at < 0 ? [...list, saved] : list.map((f, i) => (i === at ? saved : f)));
			return { ok: true, saved };
		},
		remove(id): void {
			put(current().filter((f) => f.id !== id));
		},
	};
}
