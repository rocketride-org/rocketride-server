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
// LAYOUT - FORCE SIMULATION CORE (runs inside the worker; testable in Node)
// =============================================================================
//
// A deterministic static force layout built on d3-force 3.0.0:
//
//   - d3 MUTATES the node objects it is handed (x, y, vx, vy, index). The
//     request's data is therefore COPIED into fresh objects here and the request
//     is never touched, so the caller's data cannot be corrupted.
//   - The simulation never uses d3's own timer: it is stopped at once and driven
//     by `step()`, a few ticks at a time. That lets the worker yield to its
//     message queue between steps (so a newer request or a cancel is seen) and
//     stop at the deadline with the best positions so far.
//   - A seeded random source makes the result reproducible: same request, same
//     positions. d3 initialises nodes without a position on a phyllotaxis spiral,
//     which is deterministic too.
//   - Pinned nodes are held with fx/fy, so expanding a node only moves the new
//     nodes (and lets the old ones settle only within what pinning allows).
//   - Links to ids that are not in the node list are dropped (d3 would throw).
//
// This module imports d3-force, so it belongs in the worker chunk only; the
// canvas side (workerClient.ts) never imports it.
// =============================================================================

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { ILayoutRequest, ILayoutResult } from './protocol';

// =============================================================================
// TYPES
// =============================================================================

/** The simulation's own copy of a node. */
interface ISimNode extends SimulationNodeDatum {
	id: string;
}

/** The simulation's own copy of a link. */
type ISimLink = SimulationLinkDatum<ISimNode>;

/** A running layout, driven in steps. */
export interface ILayoutJob {
	/** Ticks run so far. */
	readonly ticks: number;
	/** True once all requested ticks ran. */
	readonly done: boolean;
	/** Run up to `count` more ticks. */
	step(count: number): void;
	/** The positions as they stand (a copy; safe to post). */
	positions(): ILayoutResult['positions'];
}

/** Injected clock, for tests. */
export interface ILayoutClock {
	now(): number;
}

// =============================================================================
// RANDOM SOURCE
// =============================================================================

/**
 * A small seeded PRNG (mulberry32) for d3's random source.
 *
 * @param seed - Any integer.
 * @returns A function returning numbers in [0, 1).
 */
export function seededRandom(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// =============================================================================
// JOB
// =============================================================================

/**
 * Start a layout job for a request. Nothing runs until `step` is called.
 *
 * @param request - The layout request (never mutated).
 * @returns The job.
 */
export function createLayoutJob(request: ILayoutRequest): ILayoutJob {
	// Copy into fresh objects; first occurrence of an id wins.
	const nodes: ISimNode[] = [];
	const byId = new Map<string, ISimNode>();
	for (const input of request.nodes) {
		if (byId.has(input.id)) continue;
		const node: ISimNode = { id: input.id };
		if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
			node.x = input.x;
			node.y = input.y;
			if (input.pinned) {
				node.fx = input.x;
				node.fy = input.y;
			}
		}
		nodes.push(node);
		byId.set(input.id, node);
	}
	const links: ISimLink[] = [];
	for (const link of request.links) {
		const source = byId.get(link.source);
		const target = byId.get(link.target);
		if (source && target) links.push({ source, target });
	}

	const radius = Number.isFinite(request.radius) && request.radius > 0 ? request.radius : 28;
	const simulation: Simulation<ISimNode, ISimLink> = forceSimulation<ISimNode>(nodes)
		.stop()
		.randomSource(seededRandom(request.seed))
		.force('charge', forceManyBody<ISimNode>().strength(-260).distanceMax(500))
		.force('link', forceLink<ISimNode, ISimLink>(links).distance(110).strength(0.6))
		.force('x', forceX<ISimNode>(0).strength(0.03))
		.force('y', forceY<ISimNode>(0).strength(0.03))
		.force('collide', forceCollide<ISimNode>(radius + 6));

	const total = Math.max(0, Math.floor(request.ticks));
	let ticks = 0;
	return {
		get ticks() {
			return ticks;
		},
		get done() {
			return ticks >= total;
		},
		step(count: number): void {
			const n = Math.min(Math.max(0, Math.floor(count)), total - ticks);
			if (n > 0) {
				simulation.tick(n);
				ticks += n;
			}
		},
		positions() {
			return nodes.map((node, index) => {
				// A position that went non-finite (it should not) falls back to a
				// deterministic spiral slot instead of poisoning the canvas.
				const ok = Number.isFinite(node.x) && Number.isFinite(node.y);
				const angle = index * 2.399963229728653;
				const r = 40 * Math.sqrt(index + 1);
				return { id: node.id, x: ok ? (node.x as number) : Math.cos(angle) * r, y: ok ? (node.y as number) : Math.sin(angle) * r };
			});
		},
	};
}

/**
 * Run a request to completion, or until its deadline, in one go. The worker
 * drives {@link createLayoutJob} itself (yielding between steps); this is the
 * synchronous form for tests and tools.
 *
 * @param request - The layout request (never mutated).
 * @param clock - Time source (default: `performance.now` / `Date.now`).
 * @param stepSize - Ticks per step between deadline checks.
 * @returns The result.
 */
export function runLayout(request: ILayoutRequest, clock: ILayoutClock = { now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) }, stepSize = 25): ILayoutResult {
	const started = clock.now();
	const job = createLayoutJob(request);
	let timedOut = false;
	while (!job.done) {
		if (clock.now() - started >= request.deadlineMs) {
			timedOut = true;
			break;
		}
		job.step(stepSize);
	}
	return { type: 'result', requestId: request.requestId, positions: job.positions(), ticks: job.ticks, elapsedMs: clock.now() - started, timedOut };
}
