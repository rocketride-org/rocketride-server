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

import { useRef, useEffect } from 'react';

/**
 * Hook that tracks the previous render's value of a given variable.
 * Returns `undefined` on the first render, then the value from the prior render cycle.
 * Useful for comparing current vs. previous props or state to trigger side effects.
 *
 * @template T - The type of the tracked value.
 * @param value - The current value to track.
 * @returns The value from the previous render, or `undefined` on the first render.
 */
export default function usePrevious<T>(value: T): T | undefined {
	// Ref persists across renders without causing re-renders when mutated
	const ref = useRef<T | undefined>(undefined);

	// Update the ref *after* render completes (useEffect runs post-render),
	// so during the current render cycle ref.current still holds the previous value.
	useEffect(() => {
		ref.current = value;
	}, [value]);

	// On first render this returns undefined; on subsequent renders it returns the prior value
	return ref.current;
}
