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
 * shape that fits the widget's frame instead of becoming a thin line. A data
 * connection from one band to a later one runs right, down into the gap
 * above the later band, across it, and down into its target, so it never
 * crosses the drawing (see WrapEdge).
 */

/** Gap between two layers (columns), in px. */
export const LAYER_GAP = 80;
/** Gap between two nodes in one layer, in px. */
export const NODE_GAP = 60;
/** Gap between two bands of a wrapped flow, in px. */
export const BAND_GAP = 100;
/** How far a connection between bands runs out of its source and into its target before it turns, in px. */
export const WRAP_OFFSET = 20;
/**
 * How far past its node an overview label can reach, in px at zoom 1: to the
 * side, a share of the column gap (see LABEL_GAP_SHARE in CanvasApp.tsx); up,
 * a two-line label at the lowest zoom a wrapped flow is drawn at; down, the
 * same for an invoked node's label, which grows down from its top.
 */
export const LABEL_REACH = { side: Math.ceil(LAYER_GAP * 0.46), up: 70, down: 60 };
/**
 * A flow wraps into bands only when one band would be drawn smaller than this
 * zoom. The overview labels keep names readable down to about here, and
 * every wrap adds a long connection, so wrapping is the last resort.
 */
export const WRAP_BELOW_ZOOM = 0.3;

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

/** Top-left of each node, and the band it is in when the flow wraps. */
export type Positions = Record<string, { x: number; y: number; band?: number }>;

/** The middle of the gap above each band after the first, keyed by band. */
export function bandGaps(positions: Positions): Map<number, number> {
	const tops = new Map<number, number>();
	for (const { y, band } of Object.values(positions)) {
		if (band !== undefined) tops.set(band, Math.min(tops.get(band) ?? Infinity, y));
	}
	const gaps = new Map<number, number>();
	for (const [band, top] of tops) if (band > 0) gaps.set(band, top - BAND_GAP / 2);
	return gaps;
}

/** Where a data connection into a later band runs across: the gap above its target's band. */
export function wrapCenterY(positions: Positions, edge: LayoutEdge, gaps: Map<number, number>): number | undefined {
	const from = positions[edge.source]?.band;
	const to = positions[edge.target]?.band;
	if (edge.control || from === undefined || to === undefined || to <= from) return undefined;
	return gaps.get(to);
}

/**
 * Where a connection into a later band drops: right of its source, and right
 * of every other node, with the room its label can take (LABEL_REACH), that
 * the drop would pass on its way down to `centerY`.
 */
export function wrapTrunkX(positions: Positions, edge: LayoutEdge, sizeOf: (id: string) => LayoutSize, centerY: number): number {
	const source = positions[edge.source];
	const size = sizeOf(edge.source);
	const top = source.y + size.height / 2;
	const boxes = Object.entries(positions)
		.filter(([id]) => id !== edge.source && id !== edge.target)
		.map(([id, p]) => ({ left: p.x - LABEL_REACH.side, right: p.x + sizeOf(id).width + LABEL_REACH.side, top: p.y - LABEL_REACH.up, bottom: p.y + sizeOf(id).height + LABEL_REACH.down }));
	let x = source.x + size.width + WRAP_OFFSET;
	for (let i = 0; i < boxes.length; i++) {
		const hit = boxes.find((box) => x > box.left && x < box.right && box.bottom > top && box.top < centerY);
		if (!hit) break;
		x = hit.right + WRAP_OFFSET;
	}
	return x;
}

/** The corners of a connection into a later band, from its source handle to its target handle. */
export function wrapCorners(x1: number, y1: number, x2: number, y2: number, trunkX: number, centerY: number): Array<[number, number]> {
	return [
		[x1, y1],
		[trunkX, y1],
		[trunkX, centerY],
		[x2 - WRAP_OFFSET, centerY],
		[x2 - WRAP_OFFSET, y2],
		[x2, y2],
	];
}

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
				const rows = incoming
					.get(id)!
					.filter((source) => row.has(source))
					.map((source) => row.get(source)!);
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
	bands.forEach((band, index) => {
		// A single band has no band index: nothing wraps.
		const tag = bands.length > 1 ? { band: index } : {};
		const tallest = Math.max(0, ...band.map(columnHeight));
		let x = 0;
		const anchors: string[] = [];
		for (const column of band) {
			let y = top + (tallest - columnHeight(column)) / 2;
			let width = 0;
			for (const id of column) {
				positions[id] = { x, y, ...tag };
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
					positions[id] = { x: sx, y: rowY, ...tag };
					sx += sizeOf(id).width + NODE_GAP;
					rowHeight = Math.max(rowHeight, sizeOf(id).height);
				}
				cursor = sx;
			}
			bottom = rowY + rowHeight;
		}
		top = bottom + BAND_GAP;
	});
	return positions;
}

/**
 * How many connections pass through a node that is not one of their two
 * ends. Each is followed along the path the canvas draws for it. Within a
 * band that is React Flow's getBezierPath curve (the builder's edge): a data
 * connection from the source's right side to the target's left side, an
 * invoke from the invoker's bottom to the invoked node's top. A data
 * connection into a later band runs through the gap above that band.
 * Handles are taken at the middle of each side.
 */
export function edgesThroughNodes(positions: Positions, edges: LayoutEdge[], sizeOf: (id: string) => LayoutSize): number {
	const boxes = Object.entries(positions).map(([id, p]) => ({ id, ...p, ...sizeOf(id) }));
	const gaps = bandGaps(positions);
	let count = 0;
	for (const edge of edges) {
		const a = positions[edge.source];
		const b = positions[edge.target];
		if (!a || !b || edge.source === edge.target) continue;
		const sa = sizeOf(edge.source);
		const sb = sizeOf(edge.target);
		const [x1, y1, x2, y2] = edge.control ? [a.x + sa.width / 2, a.y + sa.height, b.x + sb.width / 2, b.y] : [a.x + sa.width, a.y + sa.height / 2, b.x, b.y + sb.height / 2];
		const points: Array<[number, number]> = [];
		const centerY = wrapCenterY(positions, edge, gaps);
		if (centerY !== undefined) {
			const corners = wrapCorners(x1, y1, x2, y2, wrapTrunkX(positions, edge, sizeOf, centerY), centerY);
			for (let i = 1; i < corners.length; i++) {
				const [px, py] = corners[i - 1];
				const [qx, qy] = corners[i];
				for (let j = 0; j < 24; j++) points.push([px + ((qx - px) * j) / 24, py + ((qy - py) * j) / 24]);
			}
		} else {
			// The curve React Flow's getBezierPath draws (curvature 0.25), which the builder's edge uses.
			const offset = (distance: number) => (distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance));
			const [c1x, c1y, c2x, c2y] = edge.control ? [x1, y1 + offset(y2 - y1), x2, y2 - offset(y2 - y1)] : [x1 + offset(x2 - x1), y1, x2 - offset(x2 - x1), y2];
			for (let i = 1; i < 48; i++) {
				const t = i / 48;
				const u = 1 - t;
				points.push([u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2]);
			}
		}
		const hit = boxes.some((box) => box.id !== edge.source && box.id !== edge.target && points.some(([x, y]) => x > box.x + 2 && x < box.x + box.width - 2 && y > box.y + 2 && y < box.y + box.height - 2));
		if (hit) count += 1;
	}
	return count;
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
	const crossing = (cut: number) => edges.filter((e) => columnOf.has(e.source) && columnOf.has(e.target) && columnOf.get(e.source)! < cut !== columnOf.get(e.target)! < cut).length;
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

	// Every way to cut the columns into `bands` bands, when there are few
	// enough to try them all; otherwise the cuts near even positions.
	const allCutsFor = (bands: number): string[][][][] => {
		if (bands === 1) return [[columns]];
		if (columns.length > 16 || bands > 4) return [cutsFor(bands)];
		const sets: string[][][][] = [];
		const pick = (start: number, left: number, cuts: number[]) => {
			if (left === 0) {
				const ends = [...cuts, columns.length];
				sets.push([0, ...cuts].map((from, i) => columns.slice(from, ends[i])));
				return;
			}
			for (let cut = start; cut <= columns.length - left; cut++) pick(cut + 1, left - 1, [...cuts, cut]);
		};
		pick(1, bands - 1, []);
		return sets;
	};

	// Keep one band (the builder's own shape) unless it would be drawn too
	// small to read in the frame. Then use the fewest bands that reach a
	// readable zoom with no connection behind a node (of those, the largest
	// drawing), else the readable one with the fewest such connections, else
	// the largest drawing.
	let readable: { positions: Positions; through: number; zoom: number } | null = null;
	let best: Positions | null = null;
	let bestZoom = -Infinity;
	for (let bands = 1; bands <= columns.length; bands++) {
		let clear: { positions: Positions; zoom: number } | null = null;
		for (const cut of allCutsFor(bands)) {
			const positions = placeBands(cut, satellites, sizeOf);
			const size = bounds(positions, sizeOf);
			const zoom = Math.min(1, frame.width / Math.max(size.width, 1), frame.height / Math.max(size.height, 1));
			// One readable band stays one band: wrapping cannot help a connection that skips a column.
			if (bands === 1 && zoom >= WRAP_BELOW_ZOOM) return positions;
			if (zoom >= WRAP_BELOW_ZOOM) {
				const through = edgesThroughNodes(positions, edges, sizeOf);
				if (through === 0 && (!clear || zoom > clear.zoom * 1.01)) clear = { positions, zoom };
				if (!readable || through < readable.through || (through === readable.through && zoom > readable.zoom * 1.01)) readable = { positions, through, zoom };
			}
			if (zoom > bestZoom * 1.05) {
				best = positions;
				bestZoom = zoom;
			}
		}
		if (clear) return clear.positions;
	}
	if (readable) return readable.positions;
	return best!;
}
