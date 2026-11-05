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
// LAYOUT - GRID FALLBACK AND INITIAL PLACEMENT (pure, cheap)
// =============================================================================
//
// The layout of last resort: when the worker is unavailable, fails or runs out
// of time, nodes go on a deterministic grid. It costs a few arithmetic
// operations per node and is the ONLY layout the main thread ever computes - a
// force simulation is never run on the main thread, not even after a worker
// failure. The Table view stays available for every retained row either way.
// =============================================================================

import type { Point } from '../graph/geometry';

/** Distance between neighbouring grid cells. */
export const GRID_SPACING = 120;

/**
 * Lay nodes out on a grid, in the order given. Nodes that already have a place
 * keep it, and new nodes take the first cells not already taken.
 *
 * @param ids - Node ids, in drawing order.
 * @param kept - Positions to keep (a dragged or already placed node).
 * @returns A position for every id.
 */
export function gridLayout(ids: readonly string[], kept: ReadonlyMap<string, Point> = new Map()): Map<string, Point> {
	const out = new Map<string, Point>();
	const taken = new Set<string>();
	const cell = (p: Point): string => `${Math.round(p.x / GRID_SPACING)},${Math.round(p.y / GRID_SPACING)}`;
	for (const id of ids) {
		const at = kept.get(id);
		if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
			out.set(id, { x: at.x, y: at.y });
			taken.add(cell(at));
		}
	}
	const free = ids.filter((id) => !out.has(id));
	const columns = Math.max(1, Math.ceil(Math.sqrt(ids.length * 1.4)));
	let next = 0;
	for (const id of free) {
		let point: Point;
		do {
			point = { x: (next % columns) * GRID_SPACING, y: Math.floor(next / columns) * GRID_SPACING };
			next += 1;
		} while (taken.has(cell(point)));
		taken.add(cell(point));
		out.set(id, point);
	}
	return out;
}

/**
 * Starting positions for new nodes: a ring around the node that was expanded,
 * deterministic in the order given, so a new neighbour starts near what it
 * hangs from instead of at the origin.
 *
 * @param center - Position of the expanded node.
 * @param ids - The new nodes, in order.
 * @param radius - Distance of the first ring from the centre.
 * @returns A start position per id.
 */
export function ringAround(center: Point, ids: readonly string[], radius = 110): Map<string, Point> {
	const out = new Map<string, Point>();
	let placed = 0;
	let ring = 0;
	while (placed < ids.length) {
		const capacity = Math.max(6, Math.floor((2 * Math.PI * (radius + ring * 70)) / 70));
		const here = Math.min(capacity, ids.length - placed);
		for (let i = 0; i < here; i++) {
			const angle = (2 * Math.PI * i) / here + ring * 0.4;
			out.set(ids[placed + i], { x: center.x + Math.cos(angle) * (radius + ring * 70), y: center.y + Math.sin(angle) * (radius + ring * 70) });
		}
		placed += here;
		ring += 1;
	}
	return out;
}
