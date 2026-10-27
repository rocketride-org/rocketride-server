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
// CANVAS - LAYOUT HOOK (positions for the model's nodes)
// =============================================================================
//
// Keeps a position for every drawn node, in one of three layouts:
//
//   FORCE          the d3-force simulation, in the worker (layout/). A node that already has
//                  a position is PINNED in the next layout, so expanding or dismissing never
//                  shuffles what the user is looking at; new nodes start on a ring around the
//                  node that was expanded, or around the centroid of what is drawn, and the
//                  worker places them. When the worker cannot run, the grid answers instead
//                  and the hook reports why; the simulation never runs on the main thread.
//   TREE           levels top down from the selected node (layout/layered.ts).
//   LEFT TO RIGHT  the same levels as columns. Both are pure, fast and run on the main
//                  thread, so they work where there is no worker (VS Code) and re-flow the
//                  whole drawing whenever nodes come or go.
//
// Switching layout, or asking for a re-layout, lays out EVERY node again; a node the user
// dropped keeps its place when "keep dragged nodes pinned" is on. A found PATH is laid on one
// row above the rest of the drawing, in path order, left to right; the other nodes keep their
// place, and when the path is cleared its nodes go back to where the layout had them.
//
// Superseded and stale worker answers are dropped by the client, and an unmount disposes
// the client (terminating the worker).
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../graph/geometry';
import { NODE_RADIUS } from '../graph/geometry';
import type { IGraphModel } from '../graph/model';
import type { GraphId } from '../graph/types';
import { ringAround } from '../layout/gridFallback';
import { layeredLayout, pathGap, pathRow } from '../layout/layered';
import { createLayoutClient } from '../layout/workerClient';
import type { FallbackReason, ILayoutClient } from '../layout/workerClient';
import { layoutDeadlineMs } from '../layout/protocol';
import type { ILayoutNode } from '../layout/protocol';
import { spawnLayoutWorker } from '../layout/spawnWorker';
import { stableHash } from '../graph/colors';

/** How the last layout went. */
export type LayoutStatus = { state: 'idle' } | { state: 'working' } | { state: 'ready'; timedOut: boolean; ticks: number; elapsedMs: number } | { state: 'fallback'; reason: FallbackReason; detail: string };

/** How the canvas places nodes: the force layout, top-down levels, or levels as columns (paths). */
export type LayoutMode = 'force' | 'tree' | 'left-right';

/** Where new nodes should start. */
export interface IExpandHint {
	centerId: GraphId;
	newIds: readonly GraphId[];
}

/** What the layout follows besides the model. */
export interface ILayoutOptions {
	/** The layout (default force). */
	mode?: LayoutMode;
	/** Increase to lay every node out again. */
	nonce?: number;
	/** Whether a full layout keeps the nodes the user dropped where they are (default on). */
	keepPinned?: boolean;
	/** The root of a tree or left-to-right layout (the selected node), read when a layout runs. */
	root?: GraphId | null;
	/** A found path's nodes in order, laid on one row while it is shown; null or empty for none. */
	path?: readonly GraphId[] | null;
	/** The relationship types on that path (their labels need room between its nodes). */
	pathTypes?: readonly string[];
	/** The largest node diameter drawn (sizes S, M, L). */
	diameter?: number;
}

/** What the hook gives the canvas. */
export interface IGraphLayout {
	positions: ReadonlyMap<GraphId, Point>;
	status: LayoutStatus;
	/** Increments every time a layout is applied (the canvas fits the view on it). */
	version: number;
	/** Remember where the user dropped a node. */
	pin(id: GraphId, at: Point): void;
}

/** A clock for the layered layouts' elapsed time. */
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Lay out the model's nodes.
 *
 * @param model - The canvas model.
 * @param seedKey - Any text; the same key gives the same layout for the same graph.
 * @param hint - Where new nodes from an expansion should start.
 * @param options - The layout mode, re-layout nonce, pinning, root, path and node size.
 * @returns Positions, status and a version counter.
 */
export function useGraphLayout(model: IGraphModel, seedKey: string, hint: IExpandHint | null, options: ILayoutOptions = {}): IGraphLayout {
	const mode = options.mode ?? 'force';
	const nonce = options.nonce ?? 0;
	const [positions, setPositions] = useState<ReadonlyMap<GraphId, Point>>(() => new Map());
	const [status, setStatus] = useState<LayoutStatus>({ state: 'idle' });
	const [version, setVersion] = useState(0);
	// Where each node is in the layout (under any path row), and which nodes the user dropped.
	const known = useRef<Map<GraphId, Point>>(new Map());
	const dropped = useRef<Set<GraphId>>(new Set());
	// The path row while a path is shown: it is drawn over `known`, which keeps where the path's nodes go back to.
	const row = useRef<Map<GraphId, Point> | null>(null);
	// The mode and nonce the positions in `known` were last laid out for; a difference asks for a full layout.
	const applied = useRef<{ mode: LayoutMode; nonce: number }>({ mode: 'force', nonce: 0 });
	// Read when a layout runs, so a new selection or a resize of the style alone never re-lays anything out.
	const settings = useRef(options);
	settings.current = options;
	const current = useRef(model);
	current.current = model;
	const client = useRef<ILayoutClient | null>(null);

	// One client per mount; it terminates its worker on unmount.
	useEffect(
		() => () => {
			client.current?.dispose();
			client.current = null;
		},
		[]
	);

	/** Publish the layout with the path row over it. */
	const publish = useCallback(() => {
		const out = new Map(known.current);
		if (row.current) for (const [id, p] of row.current) if (current.current.nodes.has(id)) out.set(id, p);
		setPositions(out);
	}, []);

	/** Place the path row against the layout as it stands (or take it away when no path of two drawn nodes is shown). */
	const placeRow = useCallback(() => {
		const { path = null, pathTypes = [], diameter = NODE_RADIUS * 2 } = settings.current;
		const ids = (path ?? []).filter((id) => current.current.nodes.has(id));
		row.current = ids.length < 2 ? null : pathRow(ids, known.current, pathGap(pathTypes, diameter), diameter);
	}, []);

	useEffect(() => {
		// Forget nodes that are gone.
		let removed = false;
		for (const id of [...known.current.keys()]) {
			if (!model.nodes.has(id)) {
				known.current.delete(id);
				dropped.current.delete(id);
				removed = true;
			}
		}
		const full = applied.current.mode !== mode || applied.current.nonce !== nonce;
		const fresh = [...model.nodes.keys()].filter((id) => !known.current.has(id));
		// A path row placed before there was a layout (or over the one being replaced) is placed again on the new one.
		const replaceRow = full || known.current.size === 0;
		if (!full && fresh.length === 0) {
			if (removed) publish();
			return undefined;
		}
		const { keepPinned = true, root = null, diameter = NODE_RADIUS * 2 } = settings.current;
		const links = [...model.relationships.values()].map((r) => ({ source: r.start, target: r.end }));
		// When every node is laid out again, a dropped node keeps its place only when the user asked for that.
		const kept = new Map<GraphId, Point>();
		if (keepPinned) {
			for (const id of dropped.current) {
				const at = known.current.get(id);
				if (at) kept.set(id, at);
			}
		}

		if (mode !== 'force') {
			// Tree and left to right: every node, every time, on the main thread (fast and deterministic).
			const started = now();
			const placed = layeredLayout({ ids: [...model.nodes.keys()], links, orientation: mode, root, diameter });
			for (const [id, p] of placed) known.current.set(id, kept.get(id) ?? p);
			if (!keepPinned) dropped.current.clear();
			applied.current = { mode, nonce };
			if (replaceRow) placeRow();
			publish();
			setVersion((v) => v + 1);
			setStatus({ state: 'ready', timedOut: false, ticks: 0, elapsedMs: now() - started });
			return undefined;
		}

		// Force. Start positions for new nodes: around the expanded node, else around what is drawn.
		const starts = new Map<GraphId, Point>();
		if (!full) {
			if (hint && known.current.has(hint.centerId)) for (const [id, p] of ringAround(known.current.get(hint.centerId) as Point, hint.newIds.filter((id) => fresh.includes(id)))) starts.set(id, p);
			if (known.current.size > 0) {
				let sx = 0;
				let sy = 0;
				for (const p of known.current.values()) {
					sx += p.x;
					sy += p.y;
				}
				const centroid = { x: sx / known.current.size, y: sy / known.current.size };
				for (const [id, p] of ringAround(centroid, fresh.filter((id) => !starts.has(id)), 220)) starts.set(id, p);
			}
		}
		// A full layout starts from nothing (the same seed gives the first layout again), around the kept nodes.
		const nodes: ILayoutNode[] = [...model.nodes.keys()].map((id) => {
			const at = full ? kept.get(id) : known.current.get(id);
			if (at) return { id, x: at.x, y: at.y, pinned: true };
			const start = starts.get(id);
			return start ? { id, x: start.x, y: start.y } : { id };
		});
		if (!client.current) client.current = createLayoutClient({ createWorker: spawnLayoutWorker });

		let alive = true;
		setStatus({ state: 'working' });
		void client.current
			.layout({ nodes, links, seed: stableHash(seedKey), ticks: known.current.size === 0 || full ? 300 : 150, deadlineMs: layoutDeadlineMs(nodes.length), radius: diameter / 2 })
			.then((outcome) => {
				if (!alive || outcome.status === 'stale') return;
				for (const [id, p] of outcome.positions) if (model.nodes.has(id)) known.current.set(id, p);
				if (full && !keepPinned) dropped.current.clear();
				applied.current = { mode, nonce };
				if (replaceRow) placeRow();
				publish();
				setVersion((v) => v + 1);
				setStatus(outcome.status === 'ok' ? { state: 'ready', timedOut: outcome.timedOut, ticks: outcome.ticks, elapsedMs: outcome.elapsedMs } : { state: 'fallback', reason: outcome.reason, detail: outcome.detail });
			});
		return () => {
			alive = false;
		};
		// The layout depends on WHICH nodes and relationships are drawn, not on their contents.
	}, [model.nodes, model.relationships, seedKey, hint, mode, nonce, publish, placeRow]);

	// The path row: laid out when a path is shown, taken away when it is cleared. It is placed against the drawing as
	// it stands then, and stays put while the path is shown.
	const pathKey = (options.path ?? []).join('\u0000');
	useEffect(() => {
		const before = row.current;
		placeRow();
		if (before === null && row.current === null) return;
		publish();
		setVersion((v) => v + 1);
	}, [pathKey, placeRow, publish]);

	// A drop must NOT publish a new positions map: that would rebuild every node and edge of the canvas
	// (hundreds of elements, measured at about 100 ms for 300 nodes) to record one node's new place. The
	// dragged node already shows where it was dropped; what matters is that the NEXT time the canvas builds
	// its lists (a selection, a caption, a new layout) it reads that place. So the published map is updated
	// in place, and only a real layout result replaces it.
	const published = useRef(positions);
	published.current = positions;
	const pin = useCallback((id: GraphId, at: Point) => {
		known.current.set(id, at);
		dropped.current.add(id);
		if (row.current?.has(id)) row.current.set(id, at);
		(published.current as Map<GraphId, Point>).set(id, at);
	}, []);

	return useMemo(() => ({ positions, status, version, pin }), [positions, status, version, pin]);
}
