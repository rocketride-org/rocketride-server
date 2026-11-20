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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// MAP - LASSO (select the points inside a drawn outline, on screen coordinates)
// =============================================================================

/**
 * Whether a point is inside a polygon (even-odd rule).
 *
 * @param x - Point x.
 * @param y - Point y.
 * @param polygon - Vertices x,y interleaved (closed implicitly).
 * @returns True when inside.
 */
export function pointInPolygon(x: number, y: number, polygon: ArrayLike<number>): boolean {
	const m = Math.floor(polygon.length / 2);
	let inside = false;
	for (let a = 0, b = m - 1; a < m; b = a, a += 1) {
		const xa = polygon[2 * a] as number;
		const ya = polygon[2 * a + 1] as number;
		const xb = polygon[2 * b] as number;
		const yb = polygon[2 * b + 1] as number;
		if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
	}
	return inside;
}

/**
 * Thin a drawn path: keep a point only when it is at least `minDistPx` from the
 * last kept one; the first and last points are always kept.
 *
 * @param path - x,y interleaved.
 * @param minDistPx - Minimum spacing.
 * @returns The thinned path.
 */
export function simplifyPath(path: readonly number[], minDistPx = 3): number[] {
	const m = Math.floor(path.length / 2);
	if (m === 0) return [];
	const out = [path[0] as number, path[1] as number];
	for (let i = 1; i < m; i += 1) {
		const x = path[2 * i] as number;
		const y = path[2 * i + 1] as number;
		const lx = out[out.length - 2] as number;
		const ly = out[out.length - 1] as number;
		const last = i === m - 1;
		if (Math.hypot(x - lx, y - ly) >= minDistPx || last) out.push(x, y);
	}
	return out;
}

/**
 * The visible points inside a lasso outline.
 *
 * @param xy - Screen x,y per point.
 * @param polygon - The outline, x,y interleaved (at least three vertices).
 * @param hidden - Optional mask.
 * @returns Point indices, ascending.
 */
export function lassoSelect(xy: Float32Array, polygon: readonly number[], hidden?: ArrayLike<number> | null): number[] {
	const m = Math.floor(polygon.length / 2);
	if (m < 3) return [];
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (let a = 0; a < m; a += 1) {
		const x = polygon[2 * a] as number;
		const y = polygon[2 * a + 1] as number;
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	const out: number[] = [];
	const n = Math.floor(xy.length / 2);
	for (let i = 0; i < n; i += 1) {
		if (hidden != null && (hidden[i] as number) !== 0) continue;
		const x = xy[2 * i] as number;
		const y = xy[2 * i + 1] as number;
		if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) continue;
		if (pointInPolygon(x, y, polygon)) out.push(i);
	}
	return out;
}
