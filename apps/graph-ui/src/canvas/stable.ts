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
// CANVAS - STABLE IDENTITIES (an unchanged node or edge keeps the same object)
// =============================================================================
//
// React Flow decides what to redo by object identity: a node or edge object it has
// seen before is skipped, a new one is adopted, its subscribers re-run and its
// component re-renders. The canvas rebuilds its node and edge lists whenever the
// selection, the focus, a caption or a position changes, and used to hand React Flow
// a brand-new object for EVERY node and edge each time: a click on one node redid 300
// nodes and 600 edges (about 100 ms at that size, measured in a real shell).
//
// `stabilise` hands back the previous object for every item that did not change, so
// only what changed is redone. It is a pure function over a cache the caller keeps.
// =============================================================================

/**
 * Whether two flat records hold the same values (one level deep, by Object.is).
 *
 * @param a - A record.
 * @param b - Another record.
 * @returns True when both have the same keys with identical values.
 */
export function sameShallow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	if (a === b) return true;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	for (const key of keys) if (!Object.is(a[key], b[key])) return false;
	return true;
}

/**
 * Reuse the previous object for every item that did not change.
 *
 * @param cache - What the caller handed out last time, by id. Updated in place.
 * @param items - The freshly built items.
 * @param same - Whether a previous and a new item are the same.
 * @returns The list to use: previous objects where `same`, the new ones elsewhere.
 */
export function stabilise<T extends { id: string }>(cache: Map<string, T>, items: readonly T[], same: (previous: T, next: T) => boolean): T[] {
	const live = new Set<string>();
	const out = items.map((item) => {
		live.add(item.id);
		const previous = cache.get(item.id);
		if (previous !== undefined && same(previous, item)) return previous;
		cache.set(item.id, item);
		return item;
	});
	for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
	return out;
}

/** The zoom at or above which relationship type labels are always drawn. */
export const LABELS_ALWAYS_FROM_ZOOM = 1;

/** The zoom below which they are never drawn (they would be unreadable). */
export const LABELS_NEVER_BELOW_ZOOM = 0.6;

/** With more relationships than this, labels are drawn only when zoomed in to the normal size. */
export const LABELS_MAX_EDGES = 200;

/**
 * Whether relationship type labels are drawn.
 *
 * Hundreds of rotated text labels are unreadable when the graph is zoomed out and cost the browser
 * paint and layout work on every drag. Each relationship still carries its type in its accessible
 * name and a tooltip, the inspector and the Table list it, and zooming in brings the labels back.
 *
 * @param zoom - The canvas zoom (1 = normal size).
 * @param edgeCount - How many relationships are drawn.
 * @returns True when labels are drawn.
 */
export function edgeLabelsVisible(zoom: number, edgeCount: number): boolean {
	if (zoom >= LABELS_ALWAYS_FROM_ZOOM) return true;
	return zoom >= LABELS_NEVER_BELOW_ZOOM && edgeCount <= LABELS_MAX_EDGES;
}

/**
 * The zoom as one of three levels, so a subscriber re-renders only when the level changes, never on every pan or zoom step.
 *
 * @param zoom - The canvas zoom.
 * @returns 0 below the never-draw zoom, 1 between, 2 from the always-draw zoom.
 */
export function zoomLevel(zoom: number): 0 | 1 | 2 {
	return zoom >= LABELS_ALWAYS_FROM_ZOOM ? 2 : zoom >= LABELS_NEVER_BELOW_ZOOM ? 1 : 0;
}

/**
 * Whether labels are drawn for a zoom level (see {@link zoomLevel}).
 *
 * @param level - 0, 1 or 2.
 * @param edgeCount - How many relationships are drawn.
 * @returns True when labels are drawn.
 */
export function labelsVisibleAt(level: 0 | 1 | 2, edgeCount: number): boolean {
	return level === 2 || (level === 1 && edgeCount <= LABELS_MAX_EDGES);
}
