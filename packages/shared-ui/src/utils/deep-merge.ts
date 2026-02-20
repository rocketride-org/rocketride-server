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
 * Recursively merges properties from `obj2` into `obj1`, mutating `obj1` in place.
 * When both values for a key are plain objects, they are merged recursively;
 * otherwise `obj2`'s value overwrites `obj1`'s. Use this for combining configuration
 * objects or partial updates into a base object.
 *
 * @param obj1 - The target object that receives merged properties (mutated in place).
 * @param obj2 - The source object whose properties are merged into `obj1`.
 * @returns The mutated `obj1` with all properties from `obj2` merged in.
 */
export function deepMerge(obj1: Record<string, unknown>, obj2: Record<string, unknown>) {
	for (const key in obj2) {
		if (key in obj2) {
			// Both values are objects, so recurse to merge nested properties
			if (obj2[key] instanceof Object && obj1[key] instanceof Object) {
				obj1[key] = deepMerge(obj1[key] as Record<string, unknown>, obj2[key] as Record<string, unknown>);
			} else {
				// Primitive or mismatched types: overwrite with source value
				obj1[key] = obj2[key];
			}
		}
	}
	return obj1;
}
