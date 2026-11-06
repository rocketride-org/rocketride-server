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

// =============================================================================
// USE LATEST — the canonical latest-ref pattern
// =============================================================================
//
// Keeps a render-fresh value readable from long-lived closures (effects,
// subscriptions, timers) WITHOUT putting it in their dependency arrays.
// This is the pattern ~30 call sites hand-rolled as
// `const ref = useRef(fn); ref.current = fn;` — stated once, so the write
// timing can evolve in one place if React's concurrent semantics demand it.
// =============================================================================

import { useRef } from 'react';

/**
 * A ref whose `.current` always holds the latest render's value.
 *
 * @param value - The value to track.
 * @returns A stable ref to the freshest value.
 */
export function useLatest<T>(value: T): { readonly current: T } {
	const ref = useRef(value);
	ref.current = value;
	return ref;
}
