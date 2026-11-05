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
// GRAPH - EDGE GEOMETRY (pure functions, no DOM)
// =============================================================================
//
// Nodes are circles. A relationship is drawn from the EDGE of its start circle
// to the edge of its end circle (never from centre to centre), curves apart from
// the other relationships between the same two nodes, loops back onto the node
// for a self-relationship, and ends in an arrow that sits exactly on the end
// circle's boundary. All of it is computed here as plain numbers and strings so
// it can be tested without a browser; the edge component is a thin SVG wrapper.
//
// Conventions
//   - Positions are circle CENTRES, in canvas units. Radii are in the same units.
//   - Parallel relationships (and relationships in opposite directions) between
//     one pair of nodes form a GROUP. Each member gets a slot; the slots fan out
//     symmetrically around the straight line, using one fixed frame per pair
//     (from the lower id to the higher id), so a relationship stored the other
//     way round does not land on top of its neighbour.
//   - Self-relationships on one node form their own group: loops of growing size
//     around the node, each leaving the circle at a different angle.
//   - Direction is the STORED direction (start -> end): the arrow points at the
//     end node even when a path was walked the other way.
// =============================================================================

// =============================================================================
// TYPES AND CONSTANTS
// =============================================================================

/** A point in canvas units. */
export interface Point {
	x: number;
	y: number;
}

/** What the geometry needs to know about a relationship. */
export interface IEdgeSpec {
	id: string;
	/** Start node id (stored direction). */
	source: string;
	/** End node id (stored direction). */
	target: string;
}

/** Where a relationship sits among its siblings. */
export interface IEdgeSlot {
	/** Zero-based position within the group (ordered by relationship id). */
	index: number;
	/** Group size. */
	count: number;
	/** True when the relationship is stored against the group's fixed frame (higher id -> lower id). */
	reversed: boolean;
	/** True for a self-relationship. */
	loop: boolean;
}

/** The drawable result for one relationship. */
export interface IEdgeShape {
	/** SVG path data for the line (it stops at the arrow's base). */
	path: string;
	/** SVG polygon points for the arrow head. */
	arrow: string;
	/** Where the arrow's tip touches the end circle. */
	tip: Point;
	/** Where the line leaves the start circle. */
	from: Point;
	/** The midpoint of the drawn curve, for the type label. */
	label: Point;
	/** Rotation for the label in degrees, kept upright (within -90..90). */
	labelAngle: number;
	/** True for a self-relationship. */
	loop: boolean;
}

/** Radius of a node circle, in canvas units. */
export const NODE_RADIUS = 28;

/** Length of the arrow head along the edge. */
export const ARROW_LENGTH = 10;

/** Half the arrow head's width. */
export const ARROW_HALF_WIDTH = 5;

/** Distance between the apexes of neighbouring parallel curves. */
export const PARALLEL_SPACING = 30;

/** How far the first self-loop reaches beyond the circle. */
export const LOOP_REACH = 36;

/** Extra reach for each further self-loop on the same node. */
export const LOOP_STEP = 14;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format a coordinate with two decimals and no trailing zeros.
 *
 * @param n - A finite number.
 * @returns Compact text.
 */
function fmt(n: number): string {
	const rounded = Math.round(n * 100) / 100;
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Unit vector from `a` to `b`, or a fixed fallback when they coincide.
 *
 * @param a - Start point.
 * @param b - End point.
 * @param fallbackAngle - Angle (radians) used when the points are the same.
 * @returns A unit vector.
 */
function unit(a: Point, b: Point, fallbackAngle = 0): Point {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy);
	if (!(length > 1e-9)) return { x: Math.cos(fallbackAngle), y: Math.sin(fallbackAngle) };
	return { x: dx / length, y: dy / length };
}

/**
 * The point on a circle's boundary in the direction of a target point.
 *
 * @param center - The circle's centre.
 * @param radius - The circle's radius.
 * @param toward - The point to aim at.
 * @param fallbackAngle - Direction used when `toward` is the centre itself.
 * @returns A point exactly `radius` from the centre.
 */
export function anchorOnCircle(center: Point, radius: number, toward: Point, fallbackAngle = 0): Point {
	const u = unit(center, toward, fallbackAngle);
	return { x: center.x + u.x * radius, y: center.y + u.y * radius };
}

/**
 * A point on a quadratic Bezier curve.
 *
 * @param p0 - Start.
 * @param c - Control point.
 * @param p2 - End.
 * @param t - Parameter in [0, 1].
 * @returns The point.
 */
function quad(p0: Point, c: Point, p2: Point, t: number): Point {
	const k = 1 - t;
	return { x: k * k * p0.x + 2 * k * t * c.x + t * t * p2.x, y: k * k * p0.y + 2 * k * t * c.y + t * t * p2.y };
}

/**
 * Keep a label upright: rotate by 180 degrees when it would read upside down.
 *
 * @param degrees - A tangent angle in degrees.
 * @returns An angle within [-90, 90].
 */
function upright(degrees: number): number {
	let a = ((degrees + 180) % 360) - 180;
	if (a > 90) a -= 180;
	else if (a < -90) a += 180;
	return a;
}

/**
 * The arrow head polygon for a tip and the direction the edge arrives from.
 *
 * @param tip - Where the arrow touches the circle.
 * @param heading - Unit vector of the travel direction at the tip.
 * @returns SVG polygon points.
 */
function arrowPoints(tip: Point, heading: Point): string {
	const base = { x: tip.x - heading.x * ARROW_LENGTH, y: tip.y - heading.y * ARROW_LENGTH };
	const nx = -heading.y;
	const ny = heading.x;
	const a = { x: base.x + nx * ARROW_HALF_WIDTH, y: base.y + ny * ARROW_HALF_WIDTH };
	const b = { x: base.x - nx * ARROW_HALF_WIDTH, y: base.y - ny * ARROW_HALF_WIDTH };
	return `${fmt(tip.x)},${fmt(tip.y)} ${fmt(a.x)},${fmt(a.y)} ${fmt(b.x)},${fmt(b.y)}`;
}

// =============================================================================
// SLOTS (which relationships share a pair of nodes)
// =============================================================================

/**
 * Assign every relationship its place among the relationships between the same
 * two nodes (either direction), or among the self-relationships of its node.
 * Independent of input order: members are ordered by relationship id.
 *
 * @param edges - The relationships.
 * @returns A slot per relationship id.
 */
export function edgeSlots(edges: readonly IEdgeSpec[]): Map<string, IEdgeSlot> {
	const groups = new Map<string, IEdgeSpec[]>();
	for (const edge of edges) {
		const loop = edge.source === edge.target;
		const [low, high] = edge.source <= edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
		const key = JSON.stringify(loop ? ['loop', edge.source] : ['pair', low, high]);
		const list = groups.get(key);
		if (list) list.push(edge);
		else groups.set(key, [edge]);
	}
	const slots = new Map<string, IEdgeSlot>();
	for (const list of groups.values()) {
		list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		list.forEach((edge, index) => {
			const loop = edge.source === edge.target;
			slots.set(edge.id, { index, count: list.length, reversed: !loop && edge.source > edge.target, loop });
		});
	}
	return slots;
}

// =============================================================================
// SHAPES
// =============================================================================

/**
 * Geometry for a relationship between two different nodes.
 *
 * @param source - Centre of the start node.
 * @param target - Centre of the end node.
 * @param sourceRadius - Radius of the start circle.
 * @param targetRadius - Radius of the end circle.
 * @param slot - The relationship's slot in its group.
 * @returns The drawable shape.
 */
function pairShape(source: Point, target: Point, sourceRadius: number, targetRadius: number, slot: IEdgeSlot): IEdgeShape {
	// The fan-out frame is fixed per pair: its normal comes from the lower-id node
	// to the higher-id node. `reversed` says the stored direction is the other way.
	const frameFrom = slot.reversed ? target : source;
	const frameTo = slot.reversed ? source : target;
	const dir = unit(frameFrom, frameTo);
	const normal = { x: -dir.y, y: dir.x };
	const apex = (slot.index - (slot.count - 1) / 2) * PARALLEL_SPACING;
	const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
	// A quadratic's apex is half-way between the chord midpoint and the control point.
	const control = { x: mid.x + normal.x * apex * 2, y: mid.y + normal.y * apex * 2 };

	const from = anchorOnCircle(source, sourceRadius, control);
	const tip = anchorOnCircle(target, targetRadius, control);
	const heading = unit(control, tip);
	const base = { x: tip.x - heading.x * ARROW_LENGTH, y: tip.y - heading.y * ARROW_LENGTH };

	const straight = Math.abs(apex) < 1e-9;
	const path = straight ? `M${fmt(from.x)} ${fmt(from.y)}L${fmt(base.x)} ${fmt(base.y)}` : `M${fmt(from.x)} ${fmt(from.y)}Q${fmt(control.x)} ${fmt(control.y)} ${fmt(base.x)} ${fmt(base.y)}`;
	const label = straight ? { x: (from.x + tip.x) / 2, y: (from.y + tip.y) / 2 } : quad(from, control, tip, 0.5);
	const tangent = straight ? unit(from, tip) : unit(quad(from, control, tip, 0.45), quad(from, control, tip, 0.55));
	return { path, arrow: arrowPoints(tip, heading), tip, from, label, labelAngle: upright((Math.atan2(tangent.y, tangent.x) * 180) / Math.PI), loop: false };
}

/**
 * Geometry for a self-relationship: a loop that leaves and re-enters the circle.
 *
 * @param center - Centre of the node.
 * @param radius - Radius of the circle.
 * @param slot - The loop's slot among the node's self-relationships.
 * @returns The drawable shape.
 */
function loopShape(center: Point, radius: number, slot: IEdgeSlot): IEdgeShape {
	// Loops fan out around the node starting at the top: 0, +55, -55, +110, ...
	// degrees from straight up, and each further loop reaches a little further out.
	const step = slot.index === 0 ? 0 : Math.ceil(slot.index / 2) * (slot.index % 2 === 1 ? 1 : -1);
	const centerAngle = -Math.PI / 2 + (step * 55 * Math.PI) / 180;
	const half = (24 * Math.PI) / 180;
	const reach = radius + LOOP_REACH + slot.index * LOOP_STEP;
	const startAngle = centerAngle - half;
	const endAngle = centerAngle + half;
	const from = { x: center.x + Math.cos(startAngle) * radius, y: center.y + Math.sin(startAngle) * radius };
	const tip = { x: center.x + Math.cos(endAngle) * radius, y: center.y + Math.sin(endAngle) * radius };
	// Two control points push the curve out along each leaving direction.
	const c1 = { x: center.x + Math.cos(startAngle - 0.15) * reach * 1.45, y: center.y + Math.sin(startAngle - 0.15) * reach * 1.45 };
	const c2 = { x: center.x + Math.cos(endAngle + 0.15) * reach * 1.45, y: center.y + Math.sin(endAngle + 0.15) * reach * 1.45 };
	const heading = unit(c2, tip);
	const base = { x: tip.x - heading.x * ARROW_LENGTH, y: tip.y - heading.y * ARROW_LENGTH };
	const path = `M${fmt(from.x)} ${fmt(from.y)}C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(base.x)} ${fmt(base.y)}`;
	// The cubic's apex (t = 0.5) of the curve ending at the arrow's tip.
	const label = {
		x: 0.125 * from.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * tip.x,
		y: 0.125 * from.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * tip.y,
	};
	// A loop's label stays horizontal: it sits outside the circle, away from the node's own caption.
	return { path, arrow: arrowPoints(tip, heading), tip, from, label, labelAngle: 0, loop: true };
}

/**
 * Compute the drawable shape of one relationship.
 *
 * @param source - Centre of the start node.
 * @param target - Centre of the end node (equal to `source` for a self-relationship).
 * @param slot - The relationship's slot (see {@link edgeSlots}).
 * @param sourceRadius - Radius of the start circle.
 * @param targetRadius - Radius of the end circle.
 * @returns The shape. Always finite, even when the circles overlap or coincide.
 */
export function edgeShape(source: Point, target: Point, slot: IEdgeSlot, sourceRadius: number = NODE_RADIUS, targetRadius: number = NODE_RADIUS): IEdgeShape {
	if (slot.loop) return loopShape(source, sourceRadius, slot);
	return pairShape(source, target, sourceRadius, targetRadius, slot);
}

/**
 * Shapes for a whole set of relationships.
 *
 * @param edges - The relationships.
 * @param positions - Centre of each node, by id.
 * @param radius - Node radius (constant, or per node id).
 * @returns A shape per relationship id; relationships whose end has no position are left out.
 */
export function layoutEdges(edges: readonly IEdgeSpec[], positions: ReadonlyMap<string, Point>, radius: number | ((id: string) => number) = NODE_RADIUS): Map<string, IEdgeShape> {
	const slots = edgeSlots(edges);
	const radiusOf = typeof radius === 'number' ? () => radius : radius;
	const out = new Map<string, IEdgeShape>();
	for (const edge of edges) {
		const a = positions.get(edge.source);
		const b = positions.get(edge.target);
		const slot = slots.get(edge.id);
		if (!a || !b || !slot) continue;
		out.set(edge.id, edgeShape(a, b, slot, radiusOf(edge.source), radiusOf(edge.target)));
	}
	return out;
}
