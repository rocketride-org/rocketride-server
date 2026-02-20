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

/**
 * Recursively removes all properties with `undefined` values from an object.
 * Nested plain objects are processed recursively; arrays and other types are
 * preserved as-is. Returns a new object without mutating the original.
 * Useful for cleaning up objects before JSON serialization or API submission.
 *
 * @template T - The object type.
 * @param obj - The object to clean.
 * @returns A new object with all `undefined` values stripped out.
 */
export function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
	const result = {} as T;

	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		// Skip undefined values entirely so they are omitted from the result
		if (value !== undefined) {
			// Recurse into nested plain objects (but not arrays) to strip their undefined values too
			if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
				result[key as keyof T] = removeUndefined(
					value as Record<string, unknown>
				) as T[keyof T];
			} else {
				// Primitives and arrays are kept as-is
				result[key as keyof T] = value as T[keyof T];
			}
		}
	}

	return result;
}
