/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Layout for a pipeline saved without positions. The builder starts every
 * such node at 0,0 (canvas/util/graph.ts) and only lays a graph out when the
 * user asks (its ELK "Tidy layout" action), so without this the nodes would
 * stack. ELK is not bundled: a pipeline is a small graph, and longest-path
 * layering is enough to keep nodes apart.
 *
 * The data flow runs left to right in layers (columns). The nodes an agent
 * only invokes (its LLM, memory and tools) sit in a row under their agent.
 * A long flow wraps into bands, one under the other, so the drawing keeps a
 * shape that fits the widget's frame instead of becoming a thin line.
 */

/** Gap between two layers (columns), in px. */
export const LAYER_GAP = 80;
/** Gap between two nodes in one layer, in px. */
export const NODE_GAP = 60;
/** Gap between two bands of a wrapped flow, in px. */
export const BAND_GAP = 100;
/** A flow wraps into bands only when one band would be drawn smaller than this zoom. */
export const WRAP_BELOW_ZOOM = 0.5;

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

/** The frame the drawing will be fitted into, to choose how a long flow wraps. */
export interface LayoutFrame {
	width: number;
	height: number;
}

export type Positions = Record<string, { x: number; y: number }>;

/**
 * The layers of a graph, in order, each in file order. A node's layer is the
 * length of the longest path to it from a node with no incoming edge. Edges
 * that close a cycle are ignored, so a cyclic graph still gets layers.
 */
function layersOf(ids: string[], edges: LayoutEdge[]): string[][] {
	const known = new Set(ids);
	const order = new Map(ids.map((id, index) => [id, index]));
	const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
	const remaining = new Map<string, number>(ids.map((id) => [id, 0]));
	const fedByData = new Set<string>();
	const invoked = new Set<string>();
	for (const { source, target, control } of edges) {
		if (!known.has(source) || !known.has(target) || source === target) continue;
		outgoing.get(source)!.push(target);
		remaining.set(target, remaining.get(target)! + 1);
		(control ? invoked : fedByData).add(target);
	}

	// Kahn's order; a node left over when the queue empties sits on a cycle.
	// Release the earliest such node and carry on.
	const layer = new Map<string, number>(ids.map((id) => [id, 0]));
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
	const byLayer: string[][] = [];
	for (const id of ids) (byLayer[layer.get(id)!] ??= []).push(id);
	for (const column of byLayer.filter(Boolean)) columns.push(column.sort((a, b) => order.get(a)! - order.get(b)!));

	// One left-to-right pass of barycentre ordering: a node moves toward the
	// average row of the nodes that feed it, which removes most crossings in a
	// pipeline. A node only invoked (a pipeline tool that starts a sub-flow)
	// goes below the others, so the invoke edge drops down to it from its
	// agent's bottom edge. Ties, and nodes fed by nothing earlier, keep file
	// order.
	const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
	for (const [source, targets] of outgoing) for (const target of targets) incoming.get(target)!.push(source);
	const row = new Map<string, number>();
	columns[0]?.forEach((id, index) => row.set(id, index));
	for (const column of columns.slice(1)) {
		const key = new Map(
			column.map((id) => {
				const rows = incoming.get(id)!.filter((source) => row.has(source)).map((source) => row.get(source)!);
				return [id, rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.POSITIVE_INFINITY];
			})
		);
		const below = (id: string) => (invoked.has(id) && !fedByData.has(id) ? 1 : 0);
		column.sort((a, b) => below(a) - below(b) || key.get(a)! - key.get(b)! || order.get(a)! - order.get(b)!);
		column.forEach((id, index) => row.set(id, index));
	}
	return columns;
}

/**
 * Places bands of columns, one band under the other. Each band runs left to
 * right; within a band each column is centred on the band's tallest column.
 * The satellites of a column's nodes (the nodes they invoke) go in a row
 * under that band, starting below their anchor.
 */
function placeBands(bands: string[][][], satellites: Map<string, string[]>, sizeOf: (id: string) => LayoutSize): Positions {
	const positions: Positions = {};
	const columnHeight = (column: string[]) => column.reduce((sum, id) => sum + sizeOf(id).height, 0) + NODE_GAP * Math.max(column.length - 1, 0);
	let top = 0;
	for (const band of bands) {
		const tallest = Math.max(0, ...band.map(columnHeight));
		let x = 0;
		const anchors: string[] = [];
		for (const column of band) {
			let y = top + (tallest - columnHeight(column)) / 2;
			let width = 0;
			for (const id of column) {
				positions[id] = { x, y };
				y += sizeOf(id).height + NODE_GAP;
				width = Math.max(width, sizeOf(id).width);
				if (satellites.has(id)) anchors.push(id);
			}
			x += width + LAYER_GAP;
		}
		let bottom = top + tallest;
		if (anchors.length) {
			const rowY = bottom + LAYER_GAP;
			let cursor = -Infinity;
			let rowHeight = 0;
			for (const anchor of anchors.sort((a, b) => positions[a].x - positions[b].x)) {
				let sx = Math.max(positions[anchor].x, cursor);
				for (const id of satellites.get(anchor)!) {
					positions[id] = { x: sx, y: rowY };
					sx += sizeOf(id).width + NODE_GAP;
					rowHeight = Math.max(rowHeight, sizeOf(id).height);
				}
				cursor = sx;
			}
			bottom = rowY + rowHeight;
		}
		top = bottom + BAND_GAP;
	}
	return positions;
}

function bounds(positions: Positions, sizeOf: (id: string) => LayoutSize): LayoutSize {
	let width = 0;
	let height = 0;
	for (const [id, { x, y }] of Object.entries(positions)) {
		width = Math.max(width, x + sizeOf(id).width);
		height = Math.max(height, y + sizeOf(id).height);
	}
	return { width, height };
}

/**
 * Returns a top-left position for every id in `ids`, from data edges only,
 * in one band: each layer is a column, and each column is centred on the
 * tallest one.
 */
export function layoutLayers(ids: string[], edges: LayoutEdge[], sizeOf: (id: string) => LayoutSize): Positions {
	return placeBands([layersOf(ids, edges)], new Map(), sizeOf);
}

/**
 * Lays out a whole pipeline. The data flow runs left to right. The nodes an
 * agent only invokes (no data in or out) sit in a row under the agent; a node
 * invoked by another invoked node joins its invoker's row. An invoked node
 * that sends data (a pipeline tool that starts a sub-flow) stays in the flow,
 * one layer after its invoker. With a `frame`, a flow too long to read in
 * one band wraps into the fewest even bands that can be read. Nothing
 * overlaps.
 */
export function layoutPipeline(ids: string[], edges: LayoutEdge[], sizeOf: (id: string) => LayoutSize, frame?: LayoutFrame): Positions {
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
	let satelliteIds = ids.filter((id) => invokedBy.has(id) && !dataTargets.has(id) && !dataSources.has(id));
	let main = ids.filter((id) => !satelliteIds.includes(id));
	if (!main.length) {
		main = ids;
		satelliteIds = [];
	}
	const satelliteSet = new Set(satelliteIds);

	// The data-flow node each satellite hangs under (following invokers up).
	const anchorOf = (id: string): string | undefined => {
		const seen = new Set<string>();
		let current: string | undefined = id;
		while (current && satelliteSet.has(current) && !seen.has(current)) {
			seen.add(current);
			current = invokedBy.get(current);
		}
		return current && !satelliteSet.has(current) ? current : undefined;
	};
	const satellites = new Map<string, string[]>();
	const orphans: string[] = [];
	for (const id of satelliteIds) {
		const anchor = anchorOf(id);
		if (!anchor) {
			orphans.push(id);
			continue;
		}
		if (!satellites.has(anchor)) satellites.set(anchor, []);
		satellites.get(anchor)!.push(id);
	}

	// Data edges, plus invoke edges between two data-flow nodes, set the layers.
	const columns = layersOf(
		main,
		edges.filter((e) => !e.control || (!satelliteSet.has(e.source) && !satelliteSet.has(e.target)))
	);
	// A satellite with no data-flow anchor (a cycle of invokes) gets a column of its own.
	if (orphans.length) columns.push(orphans);

	if (!frame || columns.length < 2) return placeBands([columns], satellites, sizeOf);

	// Where to cut a band: near the even position, at the column boundary the
	// fewest edges cross, so few connections wrap from one band to the next.
	const columnOf = new Map<string, number>();
	columns.forEach((column, index) => column.forEach((id) => columnOf.set(id, index)));
	const crossing = (cut: number) =>
		edges.filter((e) => columnOf.has(e.source) && columnOf.has(e.target) && (columnOf.get(e.source)! < cut) !== (columnOf.get(e.target)! < cut)).length;
	const cutsFor = (bands: number): string[][][] => {
		const cuts: number[] = [];
		for (let i = 1; i < bands; i++) {
			const even = Math.round((i * columns.length) / bands);
			const low = Math.max((cuts[cuts.length - 1] ?? 0) + 1, even - 1);
			const high = Math.min(columns.length - (bands - i), even + 1);
			let best = Math.min(Math.max(even, low), high);
			for (let cut = low; cut <= high; cut++) if (crossing(cut) < crossing(best)) best = cut;
			cuts.push(best);
		}
		const result: string[][][] = [];
		[0, ...cuts].forEach((start, i) => result.push(columns.slice(start, [...cuts, columns.length][i])));
		return result;
	};

	// Keep one band (the builder's own shape) unless it would be drawn too
	// small to read in the frame. Then use the fewest bands that reach a
	// readable zoom, or the largest drawing when none does.
	let best: Positions | null = null;
	let bestZoom = -Infinity;
	for (let bands = 1; bands <= columns.length; bands++) {
		// Even bands: 8 columns in two bands are about 4 and 4, never 7 and 1.
		const positions = placeBands(cutsFor(bands), satellites, sizeOf);
		const size = bounds(positions, sizeOf);
		const zoom = Math.min(1, frame.width / Math.max(size.width, 1), frame.height / Math.max(size.height, 1));
		if (zoom >= WRAP_BELOW_ZOOM) return positions;
		if (zoom > bestZoom * 1.05) {
			best = positions;
			bestZoom = zoom;
		}
	}
	return best!;
}
