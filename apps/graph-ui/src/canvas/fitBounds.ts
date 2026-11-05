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
// CANVAS - WHAT THE FIT MUST SHOW (node boxes AND everything drawn around them)
// =============================================================================
//
// React Flow's own fit works from node boxes. The graph draws more than that: a
// self-relationship loops OUT of its node (36 units and more beyond the circle), a
// parallel relationship bows away from the straight line, every relationship has a
// type label, and every node a caption underneath. A graph fitted to its node boxes
// therefore clipped a loop on the topmost node at the canvas edge.
//
// This computes the bounds of everything drawn, from the same pure geometry the edge
// layer draws from (graph/geometry.ts), so the two cannot disagree. A Bezier curve lies
// inside the hull of its control points, so the control points in the path data are a safe
// (slightly generous) extent for the curve.
// =============================================================================

import { NODE_RADIUS, edgeShape } from '../graph/geometry';
import type { IEdgeShape, IEdgeSlot, Point } from '../graph/geometry';

/** A rectangle in canvas units (React Flow's `Rect`). */
export interface IRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What the bounds need to know about a relationship. */
export interface IBoundsEdge {
	source: string;
	target: string;
	slot: IEdgeSlot;
	/** The relationship type, which is its label's text. */
	type: string;
}

/** Room under a node circle for its caption (margin and one line of text). */
export const CAPTION_BELOW = 22;

/** Approximate width of one character of an edge label (10 px text), and the room its halo adds. */
const LABEL_CHAR = 5.6;
const LABEL_HALO = 6;
/** Half the height of an edge label. */
const LABEL_HALF_HEIGHT = 7;

interface IExtent {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Grow an extent to include a point.
 *
 * @param extent - The extent, updated in place.
 * @param x - The point's x.
 * @param y - The point's y.
 */
function include(extent: IExtent, x: number, y: number): void {
	if (x < extent.minX) extent.minX = x;
	if (x > extent.maxX) extent.maxX = x;
	if (y < extent.minY) extent.minY = y;
	if (y > extent.maxY) extent.maxY = y;
}

/**
 * Every coordinate pair in SVG path data or polygon points.
 *
 * @param text - `M1 2Q3 4 5 6`, or `1,2 3,4 5,6`.
 * @returns The points, in order.
 */
export function pairsIn(text: string): Point[] {
	const numbers = text.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? [];
	const out: Point[] = [];
	for (let i = 0; i + 1 < numbers.length; i += 2) out.push({ x: Number(numbers[i]), y: Number(numbers[i + 1]) });
	return out;
}

/**
 * Grow an extent to include everything one relationship draws.
 *
 * @param extent - The extent, updated in place.
 * @param shape - The relationship's shape.
 * @param type - Its type (the label text).
 */
function includeEdge(extent: IExtent, shape: IEdgeShape, type: string): void {
	// The line: every control point of its path (a curve stays inside their hull).
	for (const p of pairsIn(shape.path)) include(extent, p.x, p.y);
	// The arrow head.
	for (const p of pairsIn(shape.arrow)) include(extent, p.x, p.y);
	include(extent, shape.from.x, shape.from.y);
	include(extent, shape.tip.x, shape.tip.y);
	// The label: a box of the text's size, turned by the label's angle.
	const halfWidth = (type.length * LABEL_CHAR) / 2 + LABEL_HALO;
	const angle = (shape.labelAngle * Math.PI) / 180;
	const reachX = halfWidth * Math.abs(Math.cos(angle)) + LABEL_HALF_HEIGHT * Math.abs(Math.sin(angle));
	const reachY = halfWidth * Math.abs(Math.sin(angle)) + LABEL_HALF_HEIGHT * Math.abs(Math.cos(angle));
	include(extent, shape.label.x - reachX, shape.label.y - reachY);
	include(extent, shape.label.x + reachX, shape.label.y + reachY);
}

/**
 * The bounds of everything the graph draws: node circles with their captions, relationship
 * lines (loops and curves included), arrow heads and type labels.
 *
 * @param centers - The centre of every node, by id.
 * @param edges - The relationships to draw (one with an end that has no centre is skipped, as the layer skips it).
 * @param radius - Node radius.
 * @returns The bounds, or null when there are no nodes.
 */
export function contentBounds(centers: ReadonlyMap<string, Point>, edges: readonly IBoundsEdge[], radius: number = NODE_RADIUS): IRect | null {
	if (centers.size === 0) return null;
	const extent: IExtent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const c of centers.values()) {
		include(extent, c.x - radius, c.y - radius);
		include(extent, c.x + radius, c.y + radius + CAPTION_BELOW);
	}
	for (const edge of edges) {
		const a = centers.get(edge.source);
		const b = centers.get(edge.target);
		if (!a || !b) continue;
		includeEdge(extent, edgeShape(a, b, edge.slot, radius, radius), edge.type);
	}
	return { x: extent.minX, y: extent.minY, width: extent.maxX - extent.minX, height: extent.maxY - extent.minY };
}

/**
 * The bounds of the node circles alone: what React Flow's own fit used.
 *
 * @param centers - The centre of every node, by id.
 * @param radius - Node radius.
 * @returns The bounds, or null when there are no nodes.
 */
export function nodeBoxBounds(centers: ReadonlyMap<string, Point>, radius: number = NODE_RADIUS): IRect | null {
	if (centers.size === 0) return null;
	const extent: IExtent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const c of centers.values()) {
		include(extent, c.x - radius, c.y - radius);
		include(extent, c.x + radius, c.y + radius);
	}
	return { x: extent.minX, y: extent.minY, width: extent.maxX - extent.minX, height: extent.maxY - extent.minY };
}
