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

import { useState, useMemo, useEffect } from 'react';
import fuzzysort from 'fuzzysort';

/**
 * Configuration options for the {@link useFuzzySearch} hook.
 * Defines the data set, searchable keys, debounce timing, and fuzzysort options.
 */
interface IUseFuzzySearch {
	/** The array of objects to search through. */
	data: Record<string, unknown>[];
	/** The object keys to search on (e.g., ['name', 'description'] or nested like ['pipeline.name']). */
	keys?: string[];
	/** Debounce delay in milliseconds. */
	debounceDelay?: number;
	/** Additional fuzzysort options (e.g., { threshold: -10000 }). */
	options?: Record<string, unknown>;
}

/**
 * Gets a nested value from an object using dot notation.
 * e.g., getNestedValue(obj, 'pipeline.name') returns obj.pipeline.name
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	// Walk the dot-separated path segments, drilling into nested objects one level at a time.
	// Returns undefined early if any intermediate segment is not an object.
	return path.split('.').reduce((current: unknown, key: string) => {
		if (current && typeof current === 'object') {
			return (current as Record<string, unknown>)[key];
		}
		return undefined;
	}, obj);
}

/**
 * Hook that provides fuzzy search functionality over an array of objects using fuzzysort.
 * It debounces the search query to avoid excessive re-computation and supports searching
 * on nested keys via dot notation (e.g., 'pipeline.name').
 *
 * @param options - Configuration including the data array, searchable keys, debounce delay, and fuzzysort options.
 * @returns An object with the current search query, a setter, the filtered search results, and the debounced query string.
 */
export function useFuzzySearch({ data, keys, debounceDelay = 300, options = {} }: IUseFuzzySearch) {
	const [searchQuery, setSearchQuery] = useState('');
	const [debouncedQuery, setDebouncedQuery] = useState('');

	// Pre-compute fuzzysort "prepared" targets for each searchable key.
	// Preparation converts strings into an internal format that speeds up repeated searches.
	const preparedData = useMemo(() => {
		if (!Array.isArray(data)) {
			return [];
		}

		// If no keys are specified, return raw data (fuzzysort will search the objects directly)
		if (!keys || keys.length === 0) {
			return data;
		}

		// For each item, resolve the nested key value and create a prepared fuzzysort target
		// stored under a "prepared_<key>" property so we can reference it during the search step.
		return data.map((item) => {
			if (typeof item !== 'object') {
				return {};
			}
			const preparedItem = { ...item };
			keys.forEach((key) => {
				const value = getNestedValue(item, key);
				if (typeof value === 'string') {
					preparedItem[`prepared_${key}`] = fuzzysort.prepare(value);
				}
			});
			return preparedItem;
		});
	}, [data, keys]);

	// Debounce the search query to avoid running expensive fuzzy matching on every keystroke
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedQuery(searchQuery);
		}, debounceDelay);

		return () => clearTimeout(timer);
	}, [searchQuery, debounceDelay]);

	// Run the actual fuzzysort search whenever the debounced query or prepared data changes
	const searchResults = useMemo(() => {
		// No query means no filtering -- return the full dataset
		if (!debouncedQuery) {
			return data || [];
		}

		if (!preparedData) {
			return [];
		}

		// Map original keys to their prepared counterparts so fuzzysort knows which fields to compare
		let preparedKeys: string[] = [];

		if (keys) {
			preparedKeys = keys.map((key) => `prepared_${key}`);
		}

		try {
			const fuzzyResults = fuzzysort.go(debouncedQuery, preparedData, {
				keys: preparedKeys,
				threshold: 0.7,
				all: true,
				...options,
			});

			// Strip the temporary "prepared_*" fields from each result before returning,
			// so consumers see the original data shape.
			return fuzzyResults.map((result) => {
				const cleanItem = { ...result.obj };
				preparedKeys.forEach((key) => delete cleanItem[key]);
				return cleanItem;
			});
		} catch (error) {
			// Gracefully degrade on malformed data rather than crashing the search UI
			console.error('Fuzzy search error:', error);
			return [];
		}
	}, [debouncedQuery, preparedData, keys, options, data]);

	return { searchQuery, setSearchQuery, searchResults, debouncedQuery };
}
