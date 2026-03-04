// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import { useMemo } from 'react';
import { useFuzzySearch } from './useFuzzySearch';

/**
 * Configuration for the {@link useQuery} hook.
 * Combines fuzzy search, filtering, and sorting into a single pipeline over a data array.
 */
interface IUseQuery {
	/** The array of objects to search through. */
	data: Record<string, unknown>[];
	/** The object keys to search on (e.g., ['name', 'description']). */
	keys?: string[];
	/** The string to search on. */
	searchQuery?: string;
	/** The predicate function to filter results. */
	filterFn?: (item: Record<string, unknown>) => boolean;
	/** Comparator function for sorting results. */
	sortFn?: (a: Record<string, unknown>, b: Record<string, unknown>) => number;
}

/**
 * Hook that composes fuzzy search, filtering, and sorting into a unified data query pipeline.
 * Internally delegates to {@link useFuzzySearch} for text matching, then applies optional
 * filter and sort functions. Use this when you need a search bar with combined filtering/sorting.
 *
 * @param options - Configuration with data, searchable keys, filter function, and sort comparator.
 * @returns An object with the filtered/sorted results, the current search query, and a setter.
 */
export default function useQuery({ data, keys, filterFn, sortFn }: IUseQuery) {
	// Delegate text matching to useFuzzySearch; this gives us debounced search for free
	const {
		searchQuery: _searchQuery,
		setSearchQuery,
		searchResults,
		debouncedQuery,
	} = useFuzzySearch({ data: data || [], keys });

	// Pipeline: search -> filter -> sort. Each stage is optional and only applied when its
	// config is present. The memoization prevents re-running the pipeline on unrelated renders.
	const results = useMemo(() => {
		// Start with full data; narrow to search results only if the user typed something
		let results = data || [];

		if (debouncedQuery) {
			results = searchResults || [];
		}

		// Apply the consumer-provided predicate filter (e.g., category or status filter)
		if (filterFn) {
			results = results.filter(filterFn);
		}

		// Shallow-copy before sorting to avoid mutating the upstream array
		if (sortFn) {
			results = [...results].sort(sortFn);
		}

		return results;
	}, [data, debouncedQuery, searchResults, filterFn, sortFn]);

	return {
		results,
		searchQuery: _searchQuery,
		setSearchQuery,
	};
}
