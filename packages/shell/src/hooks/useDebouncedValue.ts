// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useDebouncedValue — returns a trailing-debounced copy of a changing value.
 *
 * The standard companion to a DataGrid toolbar search input: bind the input
 * to local state, debounce it here, and react to the debounced value (filter
 * local rows or refetch a remote page). Replaces the built-in debounce the
 * old DataTable owned.
 */

import { useEffect, useState } from 'react';

/**
 * Debounce a value: the returned value updates only after `delayMs` of
 * silence following the last change.
 *
 * @typeParam T - Value type.
 * @param value - The rapidly-changing source value.
 * @param delayMs - Trailing debounce window in milliseconds.
 * @returns The debounced value.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);

	useEffect(() => {
		// Arm the trailing timer; a newer value cancels and re-arms it.
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);

	return debounced;
}
