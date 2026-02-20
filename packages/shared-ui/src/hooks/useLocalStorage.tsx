// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { useState, useEffect } from 'react';

/**
 * Hook that synchronizes a piece of React state with `localStorage`.
 * On mount, it reads the stored value (falling back to `initialValue` if absent),
 * and it writes back to `localStorage` whenever the state changes.
 * Use this to persist user preferences, UI state, or small data across sessions.
 *
 * @template T - The type of the stored value.
 * @param key - The localStorage key to read from and write to.
 * @param initialValue - The fallback value if the key does not exist in localStorage.
 * @returns A tuple of the current value and a state setter, mirroring `useState`.
 */
export function useLocalStorage<T>(
	key: string,
	initialValue: unknown
): readonly [T, React.Dispatch<React.SetStateAction<T>>] {
	// Lazy initializer: read from localStorage only once on mount, avoiding
	// unnecessary reads on every render. Falls back to initialValue if the key
	// is missing or the stored JSON is malformed.
	const [state, setState] = useState<T>(() => {
		try {
			const stored = localStorage.getItem(key);
			return stored !== null ? JSON.parse(stored) : initialValue;
		} catch (err) {
			console.error('Failed to read from localStorage:', err);
			return initialValue;
		}
	});

	// Sync state back to localStorage whenever the key or value changes.
	// Null/undefined values are treated as "remove" to keep storage clean.
	useEffect(() => {
		try {
			if (state === null || state === undefined) {
				localStorage.removeItem(key);
			} else {
				localStorage.setItem(key, JSON.stringify(state));
			}
		} catch (err) {
			// localStorage can throw in private browsing or when quota is exceeded
			console.error('Failed to write to localStorage:', err);
		}
	}, [key, state]);

	return [state, setState];
}
