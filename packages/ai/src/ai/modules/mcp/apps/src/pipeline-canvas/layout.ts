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
	/** An invoke (control) edge: an agent calling its LLM, memory or tool. Data edges by default. */
	control?: boolean;
}

export type Positions = Record<string, { x: number; y: number }>;

/**
 * Returns a top-left position for every id in `ids`, from data edges only.
 *
 * A node's layer is the length of the longest path to it from a node with no
 * incoming edge. Edges that close a cycle are ignored for layering, so a
 * cyclic graph still gets a finite layout. Within a layer, nodes keep the
 * order of `ids` (the order of the saved file), and each layer is centred
 * vertically on the tallest layer.
 */
export function layoutLayers(ids: string[], edges: LayoutEdge[], sizeOf: (id: string) => LayoutSize): Positions {
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

	const positions: Positions = {};
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

/**
 * Lays out a whole pipeline: the data flow left to right (`layoutLayers`),
 * and the nodes an agent only invokes (its LLM, memory and tools, which
 * neither take nor send data) in a row under the data flow, starting below
 * their agent, as builder users usually place them. A node invoked by
 * another invoked node joins its invoker's row. An invoked node that sends
 * data (a pipeline tool that starts a sub-flow) stays in the data flow, one
 * layer after its invoker. Nothing overlaps.
 */
export function layoutPipeline(ids: string[], edges: LayoutEdge[], sizeOf: (id: string) => LayoutSize): Positions {
	const known = new Set(ids);
	const dataEdges = edges.filter((e) => !e.control && known.has(e.source) && known.has(e.target));
	const dataTargets = new Set(dataEdges.map((e) => e.target));
	const dataSources = new Set(dataEdges.map((e) => e.source));
	const invokedBy = new Map<string, string>();
	for (const edge of edges) {
		if (edge.control && known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target && !invokedBy.has(edge.target)) {
			invokedBy.set(edge.target, edge.source);
		}
	}
	const satellites = ids.filter((id) => invokedBy.has(id) && !dataTargets.has(id) && !dataSources.has(id));
	const satelliteSet = new Set(satellites);
	const main = ids.filter((id) => !satelliteSet.has(id));
	if (!satellites.length || !main.length) {
		return layoutLayers(
			ids,
			edges.map((e) => ({ source: e.source, target: e.target })),
			sizeOf
		);
	}

	// Data edges, plus invoke edges between two data-flow nodes, set the layers.
	const positions = layoutLayers(
		main,
		edges.filter((e) => !e.control || (!satelliteSet.has(e.source) && !satelliteSet.has(e.target))),
		sizeOf
	);
	const bandBottom = Math.max(...main.map((id) => positions[id].y + sizeOf(id).height));

	// The main-flow node each satellite hangs under (following invokers up).
	const anchorOf = (id: string): string | undefined => {
		const seen = new Set<string>();
		let current: string | undefined = id;
		while (current && satelliteSet.has(current) && !seen.has(current)) {
			seen.add(current);
			current = invokedBy.get(current);
		}
		return current && !satelliteSet.has(current) ? current : undefined;
	};
	const groups = new Map<string, string[]>();
	for (const id of satellites) {
		const anchor = anchorOf(id) ?? '';
		if (!groups.has(anchor)) groups.set(anchor, []);
		groups.get(anchor)!.push(id);
	}
	const anchors = [...groups.keys()].sort((a, b) => (a ? positions[a].x : Infinity) - (b ? positions[b].x : Infinity));

	const y = bandBottom + LAYER_GAP;
	let cursor = -Infinity;
	for (const anchor of anchors) {
		let x = Math.max(anchor ? positions[anchor].x : 0, cursor);
		for (const id of groups.get(anchor)!) {
			positions[id] = { x, y };
			x += sizeOf(id).width + NODE_GAP;
		}
		cursor = x;
	}
	return positions;
}
