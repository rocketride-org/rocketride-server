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
 * Hook that debounces a rapidly changing value, delaying updates until a specified
 * period of inactivity has passed. Useful for reducing expensive operations triggered
 * by user input, such as search queries or API calls.
 *
 * @template T - The type of the value being debounced.
 * @param value - The value to debounce.
 * @param delay - The debounce delay in milliseconds.
 * @returns The debounced value, which only updates after `delay` ms of inactivity.
 */
export function useDebounce<T>(value: T, delay: number) {
	// Initialize with the raw value so the first render has something to show immediately
	const [debouncedValue, setDebouncedValue] = useState<T>(value);

	useEffect(() => {
		// Start a timer that will commit the latest value after `delay` ms of inactivity
		const handler = setTimeout(() => {
			setDebouncedValue(value);
		}, delay);

		// If value or delay changes before the timer fires, cancel and restart.
		// This is the core debounce mechanism -- only the last update within the window takes effect.
		return () => {
			clearTimeout(handler);
		};
	}, [value, delay]);

	return debouncedValue;
}
