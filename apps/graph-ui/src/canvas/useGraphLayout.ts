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
// CANVAS - LAYOUT HOOK (positions for the model's nodes, from the worker)
// =============================================================================
//
// Keeps a position for every drawn node. A node that already has one is PINNED
// in the next layout (so expanding or dismissing never shuffles what the user
// is looking at, and a node the user dragged stays where it was dropped); new
// nodes start on a ring around the node that was expanded, or around the
// centroid of what is already drawn, and the worker places them.
//
// Every layout runs in the worker (graph/layout). When the worker cannot run,
// the grid answers instead and the hook reports why; the force simulation is
// never run on the main thread. Superseded and stale answers are dropped by the
// client, and an unmount disposes the client (terminating the worker).
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../graph/geometry';
import type { IGraphModel } from '../graph/model';
import type { GraphId } from '../graph/types';
import { ringAround } from '../layout/gridFallback';
import { createLayoutClient } from '../layout/workerClient';
import type { FallbackReason, ILayoutClient } from '../layout/workerClient';
import { layoutDeadlineMs } from '../layout/protocol';
import type { ILayoutNode } from '../layout/protocol';
import { spawnLayoutWorker } from '../layout/spawnWorker';
import { stableHash } from '../graph/colors';

/** How the last layout went. */
export type LayoutStatus = { state: 'idle' } | { state: 'working' } | { state: 'ready'; timedOut: boolean; ticks: number; elapsedMs: number } | { state: 'fallback'; reason: FallbackReason; detail: string };

/** Where new nodes should start. */
export interface IExpandHint {
	centerId: GraphId;
	newIds: readonly GraphId[];
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

/**
 * Lay out the model's nodes.
 *
 * @param model - The canvas model.
 * @param seedKey - Any text; the same key gives the same layout for the same graph.
 * @param hint - Where new nodes from an expansion should start.
 * @returns Positions, status and a version counter.
 */
export function useGraphLayout(model: IGraphModel, seedKey: string, hint: IExpandHint | null): IGraphLayout {
	const [positions, setPositions] = useState<ReadonlyMap<GraphId, Point>>(() => new Map());
	const [status, setStatus] = useState<LayoutStatus>({ state: 'idle' });
	const [version, setVersion] = useState(0);
	const known = useRef<Map<GraphId, Point>>(new Map());
	const client = useRef<ILayoutClient | null>(null);

	// One client per mount; it terminates its worker on unmount.
	useEffect(
		() => () => {
			client.current?.dispose();
			client.current = null;
		},
		[]
	);

	useEffect(() => {
		// Forget nodes that are gone.
		let removed = false;
		for (const id of [...known.current.keys()]) {
			if (!model.nodes.has(id)) {
				known.current.delete(id);
				removed = true;
			}
		}
		const fresh = [...model.nodes.keys()].filter((id) => !known.current.has(id));
		if (fresh.length === 0) {
			if (removed) setPositions(new Map(known.current));
			return;
		}

		// Start positions for new nodes: around the expanded node, else around what is drawn.
		const starts = new Map<GraphId, Point>();
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

		const nodes: ILayoutNode[] = [...model.nodes.keys()].map((id) => {
			const at = known.current.get(id);
			if (at) return { id, x: at.x, y: at.y, pinned: true };
			const start = starts.get(id);
			return start ? { id, x: start.x, y: start.y } : { id };
		});
		const links = [...model.relationships.values()].map((r) => ({ source: r.start, target: r.end }));
		if (!client.current) client.current = createLayoutClient({ createWorker: spawnLayoutWorker });

		let alive = true;
		setStatus({ state: 'working' });
		void client.current
			.layout({ nodes, links, seed: stableHash(seedKey), ticks: known.current.size === 0 ? 300 : 150, deadlineMs: layoutDeadlineMs(nodes.length) })
			.then((outcome) => {
				if (!alive || outcome.status === 'stale') return;
				for (const [id, p] of outcome.positions) if (model.nodes.has(id)) known.current.set(id, p);
				setPositions(new Map(known.current));
				setVersion((v) => v + 1);
				setStatus(outcome.status === 'ok' ? { state: 'ready', timedOut: outcome.timedOut, ticks: outcome.ticks, elapsedMs: outcome.elapsedMs } : { state: 'fallback', reason: outcome.reason, detail: outcome.detail });
			});
		return () => {
			alive = false;
		};
		// The layout depends on WHICH nodes and relationships are drawn, not on their contents.
	}, [model.nodes, model.relationships, seedKey, hint]);

	// A drop must NOT publish a new positions map: that would rebuild every node and edge of the canvas
	// (hundreds of elements, measured at about 100 ms for 300 nodes) to record one node's new place. The
	// dragged node already shows where it was dropped; what matters is that the NEXT time the canvas builds
	// its lists (a selection, a caption, a new layout) it reads that place. So the published map is updated
	// in place, and only a real layout result replaces it.
	const published = useRef(positions);
	published.current = positions;
	const pin = useCallback((id: GraphId, at: Point) => {
		known.current.set(id, at);
		(published.current as Map<GraphId, Point>).set(id, at);
	}, []);

	return useMemo(() => ({ positions, status, version, pin }), [positions, status, version, pin]);
}
