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
// MAP - PICKING (hover and click on screen coordinates; the keyboard path)
// =============================================================================
//
// Points are bucketed into a uniform grid of screen cells, rebuilt whenever the
// camera or the layout changes (a few milliseconds for 5,000 points), so a hover
// looks at a handful of cells instead of every point. Ties go to the nearer
// depth (3D), then the lower point index, so a pick is deterministic.
//
// The keyboard path moves from the focused point to the nearest point inside the
// 90° sector of the arrow pressed (screen y points down, so "up" is -y).
// =============================================================================

import type { IViewport } from './camera';

/** The grid over screen coordinates. */
export interface IScreenIndex {
	readonly xy: Float32Array;
	readonly depth: Float32Array | null;
	readonly cell: number;
	readonly cols: number;
	readonly rows: number;
	readonly margin: number;
	/** First point in each cell (-1 when empty); `next` chains the rest. */
	readonly heads: Int32Array;
	readonly next: Int32Array;
}

/** Arrow-key directions. */
export type SectorDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Bucket on-screen points into a grid.
 *
 * @param xy - Screen x,y per point (NaN for points behind the eye).
 * @param vp - The viewport.
 * @param hidden - Optional mask of points that cannot be picked.
 * @param depth - Optional depth per point (smaller is nearer).
 * @param cellPx - Cell size in pixels.
 * @returns The index.
 */
export function buildScreenIndex(xy: Float32Array, vp: IViewport, hidden?: ArrayLike<number> | null, depth?: Float32Array | null, cellPx = 16): IScreenIndex {
	const margin = cellPx;
	const cols = Math.max(1, Math.ceil((vp.width + 2 * margin) / cellPx));
	const rows = Math.max(1, Math.ceil((vp.height + 2 * margin) / cellPx));
	const heads = new Int32Array(cols * rows).fill(-1);
	const n = Math.floor(xy.length / 2);
	const next = new Int32Array(n).fill(-1);
	for (let i = n - 1; i >= 0; i -= 1) {
		if (hidden != null && (hidden[i] as number) !== 0) continue;
		const x = xy[2 * i] as number;
		const y = xy[2 * i + 1] as number;
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		const c = Math.floor((x + margin) / cellPx);
		const r = Math.floor((y + margin) / cellPx);
		if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
		const at = r * cols + c;
		next[i] = heads[at] as number;
		heads[at] = i;
	}
	return { xy, depth: depth ?? null, cell: cellPx, cols, rows, margin, heads, next };
}

/**
 * The point nearest a screen position within a radius.
 *
 * @param index - From {@link buildScreenIndex}.
 * @param sx - Screen x.
 * @param sy - Screen y.
 * @param radiusPx - Largest distance that counts.
 * @returns The point index, or null.
 */
export function pickNearest(index: IScreenIndex, sx: number, sy: number, radiusPx: number): number | null {
	const r2 = radiusPx * radiusPx;
	const c0 = Math.max(0, Math.floor((sx - radiusPx + index.margin) / index.cell));
	const c1 = Math.min(index.cols - 1, Math.floor((sx + radiusPx + index.margin) / index.cell));
	const r0 = Math.max(0, Math.floor((sy - radiusPx + index.margin) / index.cell));
	const r1 = Math.min(index.rows - 1, Math.floor((sy + radiusPx + index.margin) / index.cell));
	let best = -1;
	let bestD = Infinity;
	let bestZ = Infinity;
	for (let r = r0; r <= r1; r += 1) {
		for (let c = c0; c <= c1; c += 1) {
			for (let i = index.heads[r * index.cols + c] as number; i !== -1; i = index.next[i] as number) {
				const dx = (index.xy[2 * i] as number) - sx;
				const dy = (index.xy[2 * i + 1] as number) - sy;
				const d = dx * dx + dy * dy;
				if (d > r2) continue;
				const z = index.depth ? (index.depth[i] as number) : 0;
				if (d < bestD || (d === bestD && (z < bestZ || (z === bestZ && i < best)))) {
					best = i;
					bestD = d;
					bestZ = z;
				}
			}
		}
	}
	return best === -1 ? null : best;
}

/**
 * Where an arrow key moves the keyboard focus.
 *
 * @param xy - Screen x,y per point.
 * @param from - The focused point, or null (then: the point nearest the viewport centre).
 * @param direction - The arrow.
 * @param vp - The viewport.
 * @param hidden - Optional mask.
 * @returns The next point, or null when the sector is empty.
 */
export function nearestInSector(xy: Float32Array, from: number | null, direction: SectorDirection, vp: IViewport, hidden?: ArrayLike<number> | null): number | null {
	const n = Math.floor(xy.length / 2);
	const ok = (i: number): boolean => !(hidden != null && (hidden[i] as number) !== 0) && Number.isFinite(xy[2 * i] as number) && Number.isFinite(xy[2 * i + 1] as number);
	const ox = from === null ? vp.width / 2 : (xy[2 * from] as number);
	const oy = from === null ? vp.height / 2 : (xy[2 * from + 1] as number);
	let best: number | null = null;
	let bestD = Infinity;
	for (let j = 0; j < n; j += 1) {
		if (j === from || !ok(j)) continue;
		const dx = (xy[2 * j] as number) - ox;
		const dy = (xy[2 * j + 1] as number) - oy;
		if (from !== null) {
			const inSector = direction === 'right' ? dx > 0 && Math.abs(dy) <= dx : direction === 'left' ? dx < 0 && Math.abs(dy) <= -dx : direction === 'down' ? dy > 0 && Math.abs(dx) <= dy : dy < 0 && Math.abs(dx) <= -dy;
			if (!inSector) continue;
		}
		const d = dx * dx + dy * dy;
		if (d < bestD) {
			best = j;
			bestD = d;
		}
	}
	return best;
}
