/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Left-to-right layered layout for a pipeline saved without positions.
 * The builder starts every such node at 0,0 (canvas/util/graph.ts) and only
 * lays a graph out when the user asks (its ELK "Tidy layout" action), so
 * without this the nodes would stack. ELK is not bundled: a pipeline is a
 * small graph, and longest-path layering is enough to keep nodes apart.
 */

/** Gap between two layers (columns), in px. */
export const LAYER_GAP = 80;
/** Gap between two nodes in one layer, in px. */
export const NODE_GAP = 60;

export interface LayoutSize {
	width: number;
	height: number;
}

export interface LayoutEdge {
	source: string;
	target: string;
}

/**
 * Returns a top-left position for every id in `ids`.
 *
 * A node's layer is the length of the longest path to it from a node with no
 * incoming edge. Edges that close a cycle are ignored for layering, so a
 * cyclic graph still gets a finite layout. Within a layer, nodes keep the
 * order of `ids` (the order of the saved file), and each layer is centred
 * vertically on the tallest layer.
 */
export function layoutLayers(ids: string[], edges: LayoutEdge[], sizeOf: (id: string) => LayoutSize): Record<string, { x: number; y: number }> {
	const known = new Set(ids);
	const order = new Map(ids.map((id, index) => [id, index]));
	const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
	const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
	for (const { source, target } of edges) {
		if (!known.has(source) || !known.has(target) || source === target) continue;
		outgoing.get(source)!.push(target);
		indegree.set(target, indegree.get(target)! + 1);
	}

	// Kahn's order; a node left over when the queue empties sits on a cycle.
	// Release the earliest such node and carry on, dropping its unvisited
	// incoming edges for layering.
	const layer = new Map<string, number>(ids.map((id) => [id, 0]));
	const remaining = new Map(indegree);
	const done = new Set<string>();
	const queue = ids.filter((id) => remaining.get(id) === 0);
	while (done.size < ids.length) {
		if (queue.length === 0) {
			const next = ids.find((id) => !done.has(id))!;
			remaining.set(next, 0);
			queue.push(next);
		}
		const id = queue.shift()!;
		if (done.has(id)) continue;
		done.add(id);
		for (const target of outgoing.get(id)!) {
			if (done.has(target)) continue;
			layer.set(target, Math.max(layer.get(target)!, layer.get(id)! + 1));
			const left = remaining.get(target)! - 1;
			remaining.set(target, left);
			if (left === 0) queue.push(target);
		}
	}

	const columns: string[][] = [];
	for (const id of ids) {
		const index = layer.get(id)!;
		(columns[index] ??= []).push(id);
	}
	const columnList = columns.filter(Boolean).map((column) => column.sort((a, b) => order.get(a)! - order.get(b)!));

	const columnHeight = (column: string[]) => column.reduce((sum, id) => sum + sizeOf(id).height, 0) + NODE_GAP * Math.max(column.length - 1, 0);
	const tallest = Math.max(0, ...columnList.map(columnHeight));

	const positions: Record<string, { x: number; y: number }> = {};
	let x = 0;
	for (const column of columnList) {
		let y = (tallest - columnHeight(column)) / 2;
		let width = 0;
		for (const id of column) {
			const size = sizeOf(id);
			positions[id] = { x, y };
			y += size.height + NODE_GAP;
			width = Math.max(width, size.width);
		}
		x += width + LAYER_GAP;
	}
	return positions;
}
