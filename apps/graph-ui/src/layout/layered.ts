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
// LAYOUT - LAYERED LAYOUTS (tree, left to right) AND THE PATH ROW (pure, main thread)
// =============================================================================
//
// The two layouts that are not a force simulation:
//
//   TREE           levels top down: the root on top, its neighbours on the next level, and so on.
//   LEFT TO RIGHT  the same levels as columns, read left to right (chains, flows, paths).
//
// A graph is not a tree, so a spanning tree is taken: a breadth-first walk from the root (the
// selected node, else the node with the most relationships) over relationships in either
// direction, visiting neighbours in id order. A relationship the walk did not use (a cycle, a
// cross link, a parallel or a self relationship) is still drawn; it has no say in where nodes go.
// Every connected component gets its own tree, side by side, the root's first; nodes with no
// relationship at all go on a compact grid beside the trees instead of in one long row.
//
// Within a tree each leaf takes the next slot and a parent sits midway between its first and
// last child, so every subtree owns its own band of slots and nothing on one level can overlap.
// It is O(nodes + relationships) after sorting each neighbour list, deterministic (same input,
// same output, whatever order the relationships come in), and fast enough for the canvas maximum
// (1,000 nodes, 2,000 relationships) to run on the main thread. So it runs the same way in a
// browser and in a VS Code webview, which has no worker: there Force falls back to the grid
// (workerClient.ts), and these layouts do not. No library is used.
//
// The PATH ROW places a found path's nodes in order, left to right on one row above the rest of
// the drawing, which keeps its place.
// =============================================================================

import type { Point } from '../graph/geometry';
import { NODE_RADIUS } from '../graph/geometry';

// =============================================================================
// TYPES AND SPACING
// =============================================================================

/** Levels top down, or levels as columns read left to right. */
export type LayeredOrientation = 'tree' | 'left-right';

/** What to lay out. */
export interface ILayeredInput {
	/** The drawn nodes (a repeated id is placed once). */
	ids: readonly string[];
	/** The relationships, as the node ids they join; either direction counts. */
	links: ReadonlyArray<{ source: string; target: string }>;
	orientation: LayeredOrientation;
	/** The preferred root (the selected node); ignored when it is not drawn. */
	root?: string | null;
	/** The largest node diameter drawn (default: the normal node). */
	diameter?: number;
}

/** The normal node diameter. */
const NORMAL_DIAMETER = NODE_RADIUS * 2;

/** A caption under a node is cut at this width (environment.ts, `.graph-ui-caption`). */
const CAPTION_WIDTH = 150;

/** Width of one character of a relationship label (10 px text, as fitBounds.ts measures it), and the halo on each side. */
const LABEL_CHAR = 5.6;
const LABEL_HALO = 6;

/** How far above the rest of the drawing the path row sits, beyond a node's diameter. */
const ROW_ABOVE = 120;

/**
 * The room between neighbouring slots on one level (`across`) and between levels (`along`).
 * Captions sit under their nodes and are up to 150 px wide, so the axis captions lie along gets
 * that much room; the other axis needs a diameter, a caption's height and a relationship label.
 *
 * @param orientation - Tree or left to right.
 * @param diameter - The largest node diameter.
 * @returns The two distances, in canvas units.
 */
function spacing(orientation: LayeredOrientation, diameter: number): { across: number; along: number } {
	return orientation === 'tree' ? { across: diameter + CAPTION_WIDTH - 46, along: diameter + 84 } : { across: diameter + 44, along: diameter + CAPTION_WIDTH + 14 };
}

// =============================================================================
// LAYERED LAYOUT
// =============================================================================

/**
 * Lay nodes out in levels from a root.
 *
 * @param input - The nodes, relationships, orientation, preferred root and node size.
 * @returns A centre for every node, in the order the ids were given.
 */
export function layeredLayout(input: ILayeredInput): Map<string, Point> {
	const diameter = Number.isFinite(input.diameter) && (input.diameter as number) > 0 ? (input.diameter as number) : NORMAL_DIAMETER;
	const { across, along } = spacing(input.orientation, diameter);

	// Index the nodes; the first occurrence of an id wins.
	const index = new Map<string, number>();
	const ids: string[] = [];
	for (const id of input.ids) {
		if (index.has(id)) continue;
		index.set(id, ids.length);
		ids.push(id);
	}
	const n = ids.length;
	const out = new Map<string, Point>();
	if (n === 0) return out;

	// Each node's neighbours, in both directions, each once, in id order (so the input order never matters).
	const sets: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
	for (const link of input.links) {
		const a = index.get(link.source);
		const b = index.get(link.target);
		if (a === undefined || b === undefined || a === b) continue;
		sets[a].add(b);
		sets[b].add(a);
	}
	const byId = (x: number, y: number): number => (ids[x] < ids[y] ? -1 : ids[x] > ids[y] ? 1 : 0);
	const neighbours = sets.map((set) => [...set].sort(byId));

	// Roots: the preferred one first, then the most connected node of every component not reached yet.
	const order = ids.map((_, i) => i).sort((x, y) => neighbours[y].length - neighbours[x].length || byId(x, y));
	const preferred = input.root != null ? index.get(input.root) : undefined;
	const starts = preferred !== undefined ? [preferred, ...order] : order;

	// A breadth-first spanning tree per component; a node with no relationship waits for the grid.
	const level = new Int32Array(n).fill(-1);
	const children: number[][] = Array.from({ length: n }, () => []);
	const roots: number[] = [];
	const lone: number[] = [];
	for (const start of starts) {
		if (level[start] !== -1) continue;
		level[start] = 0;
		if (neighbours[start].length === 0) {
			lone.push(start);
			continue;
		}
		roots.push(start);
		const queue = [start];
		for (let head = 0; head < queue.length; head++) {
			const u = queue[head];
			for (const v of neighbours[u]) {
				if (level[v] !== -1) continue;
				level[v] = level[u] + 1;
				children[u].push(v);
				queue.push(v);
			}
		}
	}

	// Slots: leaves take the next one, a parent sits midway between its first and last child.
	// Post-order without recursion, so a long chain cannot exhaust the stack.
	const slot = new Float64Array(n);
	let next = 0;
	for (const root of roots) {
		const stack: Array<[node: number, child: number]> = [[root, 0]];
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			const [u, i] = top;
			if (i < children[u].length) {
				top[1] = i + 1;
				stack.push([children[u][i], 0]);
				continue;
			}
			stack.pop();
			const kids = children[u];
			slot[u] = kids.length === 0 ? next++ : (slot[kids[0]] + slot[kids[kids.length - 1]]) / 2;
		}
		next += 1; // one free slot between trees
	}

	// Nodes with no relationship: a square-ish block beside the trees.
	const columns = Math.max(1, Math.ceil(Math.sqrt(lone.length)));
	lone.forEach((u, k) => {
		slot[u] = next + (k % columns);
		level[u] = Math.floor(k / columns);
	});

	for (let u = 0; u < n; u++) {
		out.set(ids[u], input.orientation === 'tree' ? { x: slot[u] * across, y: level[u] * along } : { x: level[u] * along, y: slot[u] * across });
	}
	return out;
}

// =============================================================================
// PATH ROW
// =============================================================================

/**
 * The distance between neighbouring nodes of a path row: room for two captions side by side,
 * and for the longest relationship label between two circles.
 *
 * @param types - The relationship types on the path.
 * @param diameter - The largest node diameter drawn.
 * @returns Canvas units.
 */
export function pathGap(types: readonly string[], diameter: number = NORMAL_DIAMETER): number {
	const longest = types.reduce((most, type) => Math.max(most, type.length), 0);
	return Math.round(Math.max(diameter + CAPTION_WIDTH - 26, diameter + longest * LABEL_CHAR + 2 * LABEL_HALO + 24));
}

/**
 * Place a path's nodes in order, left to right on one row, centred over the rest of the drawing
 * and above it (so no other node is covered). Only the path's nodes get a position here.
 *
 * @param path - The path's node ids in path order (a repeated id is placed once).
 * @param positions - Where everything is now; the nodes not on the path keep their place.
 * @param gap - The distance between neighbouring path nodes (see {@link pathGap}).
 * @param diameter - The largest node diameter drawn.
 * @returns A centre for each path node, in path order.
 */
export function pathRow(path: readonly string[], positions: ReadonlyMap<string, Point>, gap: number, diameter: number = NORMAL_DIAMETER): Map<string, Point> {
	const order: string[] = [];
	const onPath = new Set<string>();
	for (const id of path) {
		if (onPath.has(id)) continue;
		onPath.add(id);
		order.push(id);
	}
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	for (const [id, p] of positions) {
		if (onPath.has(id)) continue;
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
	}
	const others = minY !== Infinity;
	const centre = others ? (minX + maxX) / 2 : 0;
	const y = others ? minY - diameter - ROW_ABOVE : 0;
	const out = new Map<string, Point>();
	order.forEach((id, i) => out.set(id, { x: centre + (i - (order.length - 1) / 2) * gap, y }));
	return out;
}
