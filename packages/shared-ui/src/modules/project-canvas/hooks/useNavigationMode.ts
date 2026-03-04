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

/**
 * Hook that manages the canvas navigation mode (DRAG vs SELECT) and persists
 * the user's choice via the host preference store or localStorage.
 */
import { useState, useCallback } from 'react';
import { NavigationMode, STORAGE_KEY } from '../constants';

/** Retrieves a stored preference value by key. */
type GetPreference = (key: string) => unknown;

/** Persists a preference value by key. */
type SetPreference = (key: string, value: unknown) => void;

/** Return type of the {@link useNavigationMode} hook. */
interface UseNavigationModeReturn {
	navigationMode: NavigationMode;
	setNavigationMode: (mode: NavigationMode) => void;
}

/**
 * Reads the persisted navigation mode on mount and provides a setter that
 * updates both the React state and the preference store.
 * Falls back to `NavigationMode.DRAG` when no stored preference exists.
 *
 * @param getPreference - Optional host-provided preference getter.
 * @param setPreference - Optional host-provided preference setter.
 * @returns The current navigation mode and a setter function.
 */
export const useNavigationMode = (
	getPreference?: GetPreference,
	setPreference?: SetPreference
): UseNavigationModeReturn => {
	// Lazy initialiser: read the persisted mode once on mount
	const [navigationMode, _setNavigationMode] = useState<NavigationMode>(() => {
		// Try the host preference store first, fall back to localStorage
		const stored = getPreference
			? (getPreference(STORAGE_KEY.NAVIGATION_MODE) as string | undefined)
			: localStorage.getItem(STORAGE_KEY.NAVIGATION_MODE);
		const storedValue = stored as NavigationMode;
		// Only accept valid enum values; default to DRAG for unrecognised/missing values
		if (storedValue === NavigationMode.DRAG || storedValue === NavigationMode.SELECT) {
			return storedValue;
		}
		return NavigationMode.DRAG;
	});

	// Wrapper that updates both React state and the persisted preference in one call
	const setNavigationMode = useCallback(
		(mode: NavigationMode) => {
			_setNavigationMode(mode);
			if (setPreference) setPreference(STORAGE_KEY.NAVIGATION_MODE, mode);
			else localStorage.setItem(STORAGE_KEY.NAVIGATION_MODE, mode);
		},
		[setPreference]
	);

	return {
		navigationMode,
		setNavigationMode,
	};
};
