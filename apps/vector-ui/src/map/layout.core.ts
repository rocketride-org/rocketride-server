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
// MAP - NEIGHBOUR-GRAPH LAYOUT (seeded d3-force; runs in the layout worker, testable in Node)
// =============================================================================
//
// The "Neighbour graph" layout: start from the node's PCA coordinates and let a
// force simulation pull every point towards its kNN neighbours (stronger and
// shorter for more similar neighbours) while a short-range charge keeps points
// from piling up. The result keeps far more of each neighbourhood than PCA does
// (quality.ts measures it; the map shows it only when it beats PCA).
//
//   - Deterministic: the simulation never uses d3's timer; it is stopped at once
//     and driven by `step()`, and d3's random source (only used to separate
//     coincident points) is seeded. Same input and seed, same positions.
//   - Bounded: `runJob` stops at a time budget or when asked to cancel, with the
//     positions reached so far; the worker drives the same job in small steps so
//     it can see a newer request or a Cancel between them.
//   - The input is never touched: d3 mutates the node objects it is given, so
//     they are fresh copies.
//
// No module here ever sees a vector: the inputs are 2D start positions and the
// kNN graph the node computed (indices and similarities).
// =============================================================================

import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { FORCE_TICKS } from './budgets';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The budgets live in budgets.ts (no imports) so the main thread can read them. */
export { FORCE_BUDGET_MS, FORCE_TICKS } from './budgets';

/** Length scale of the layout: the start is scaled to a radius of LAYOUT_UNIT * sqrt(n). */
export const LAYOUT_UNIT = 10;

/**
 * Force parameters, in layout units. Tuned on the seeded fixtures: on
 * sample_demo_1000.json the kNN overlap goes from PCA's 0.167 to about 0.50,
 * and on the 5,000-point light sample from 0.03 to about 0.40.
 */
const FORCE = {
	charge: -15,
	chargeRange: 8 * LAYOUT_UNIT,
	theta: 0.9,
	linkBase: 0.3 * LAYOUT_UNIT,
	linkSpan: 1.2 * LAYOUT_UNIT,
	linkStrength: 0.8,
	gravity: 0.01,
} as const;

// =============================================================================
// TYPES
// =============================================================================

/** The kNN graph (the slice of IKnnBlock the layouts need). */
export interface IKnnGraph {
	offsets_row: ArrayLike<number>;
	cols: ArrayLike<number>;
	sims: ArrayLike<number>;
}

/** What the neighbour-graph layout starts from. */
export interface IForceLayoutInput {
	/** Number of points. */
	n: number;
	/** PCA start positions, x,y interleaved (2n floats). Never mutated. */
	init: ArrayLike<number>;
	knn: IKnnGraph;
	/** Seed of the simulation's random source. */
	seed: number;
	/** Ticks to run (default FORCE_TICKS). */
	ticks?: number;
	/** Points to leave out of the graph (removed documents). */
	hidden?: ArrayLike<number> | null;
}

/** A layout in progress, driven in steps (the force layout and t-SNE share it). */
export interface ILayoutJob {
	/** Steps (ticks or iterations) run so far. */
	readonly ticks: number;
	/** Steps the job runs to completion. */
	readonly total: number;
	/** True once all steps ran. */
	readonly done: boolean;
	/** Run up to `count` more steps. */
	step(count: number): void;
	/** The positions as they stand, x,y interleaved (a fresh copy). */
	positions(): Float32Array;
}

/** Injected time source (tests). */
export interface ILayoutClock {
	now(): number;
}

/** The outcome of running a job to completion, to its budget, or to a Cancel. */
export interface ILayoutRun {
	positions: Float32Array;
	ticks: number;
	elapsedMs: number;
	/** The budget ran out first (the positions are still usable). */
	timedOut: boolean;
	/** Cancelled between two steps. */
	cancelled: boolean;
}

/** One undirected link of the neighbour graph, `source < target`, weight 0..1 (1 = the row's most similar). */
export interface INeighbourLink {
	source: number;
	target: number;
	w: number;
}

interface ISimNode extends SimulationNodeDatum {
	index?: number;
}

interface ISimLink extends SimulationLinkDatum<ISimNode> {
	w: number;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * A small seeded PRNG (mulberry32).
 *
 * @param seed - Any integer.
 * @returns Numbers in [0, 1).
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

/**
 * A deterministic spiral slot (used when a start position is missing or degenerate).
 *
 * @param index - Point index.
 * @returns x and y in layout units.
 */
function spiral(index: number): [number, number] {
	const angle = index * 2.399963229728653;
	const r = LAYOUT_UNIT * Math.sqrt(index + 0.5);
	return [Math.cos(angle) * r, Math.sin(angle) * r];
}

/**
 * Scale PCA start positions to the layout's length scale: the largest
 * coordinate becomes LAYOUT_UNIT * sqrt(n), so the start has room for the
 * link lengths. A start with no spread (or non-finite values) becomes a
 * deterministic spiral.
 *
 * @param init - x,y interleaved.
 * @param n - Number of points.
 * @returns A new array of 2n coordinates.
 */
export function normaliseInit(init: ArrayLike<number>, n: number): Float64Array {
	const out = new Float64Array(n * 2);
	let max = 0;
	for (let i = 0; i < n * 2; i += 1) {
		const v = init[i] as number;
		if (Number.isFinite(v)) max = Math.max(max, Math.abs(v));
	}
	const scale = max > 0 ? (LAYOUT_UNIT * Math.sqrt(Math.max(1, n))) / max : 0;
	for (let i = 0; i < n; i += 1) {
		const x = init[2 * i] as number;
		const y = init[2 * i + 1] as number;
		if (scale > 0 && Number.isFinite(x) && Number.isFinite(y)) {
			out[2 * i] = x * scale;
			out[2 * i + 1] = y * scale;
		} else {
			const [sx, sy] = spiral(i);
			out[2 * i] = sx;
			out[2 * i + 1] = sy;
		}
	}
	return out;
}

/**
 * The undirected neighbour graph: one link per pair that either row lists,
 * weighted by the similarity normalised within the listing row (the row's most
 * similar neighbour 1, its least 0; a pair listed twice keeps the higher).
 *
 * @param knn - The kNN graph.
 * @param n - Number of points.
 * @param hidden - Points to leave out.
 * @returns The links, in first-seen order.
 */
export function neighbourLinks(knn: IKnnGraph, n: number, hidden?: ArrayLike<number> | null): INeighbourLink[] {
	const isHidden = (i: number): boolean => hidden != null && (hidden[i] as number) !== 0;
	const byPair = new Map<number, INeighbourLink>();
	for (let i = 0; i < n; i += 1) {
		if (isHidden(i)) continue;
		const start = knn.offsets_row[i] as number;
		const end = knn.offsets_row[i + 1] as number;
		let lo = Infinity;
		let hi = -Infinity;
		const valid = (j: number): boolean => j !== i && j >= 0 && j < n && Number.isInteger(j) && !isHidden(j);
		for (let e = start; e < end; e += 1) {
			if (!valid(knn.cols[e] as number)) continue;
			const s = knn.sims[e] as number;
			if (s < lo) lo = s;
			if (s > hi) hi = s;
		}
		for (let e = start; e < end; e += 1) {
			const j = knn.cols[e] as number;
			if (!valid(j)) continue;
			const s = knn.sims[e] as number;
			const w = hi > lo ? (s - lo) / (hi - lo) : 1;
			const a = Math.min(i, j);
			const b = Math.max(i, j);
			const key = a * n + b;
			const seen = byPair.get(key);
			if (seen === undefined) byPair.set(key, { source: a, target: b, w });
			else if (w > seen.w) seen.w = w;
		}
	}
	return Array.from(byPair.values());
}

// =============================================================================
// JOB
// =============================================================================

/**
 * Start a neighbour-graph layout. Nothing runs until `step` is called.
 *
 * @param input - The start positions and graph (never mutated).
 * @returns The job.
 */
export function createForceJob(input: IForceLayoutInput): ILayoutJob {
	const n = Math.max(0, Math.floor(input.n));
	const start = normaliseInit(input.init, n);
	const nodes: ISimNode[] = Array.from({ length: n }, (_, i) => ({ x: start[2 * i] as number, y: start[2 * i + 1] as number }));
	const links: ISimLink[] = neighbourLinks(input.knn, n, input.hidden).map((l) => ({ source: l.source, target: l.target, w: l.w }));
	const simulation = forceSimulation<ISimNode>(nodes)
		.stop()
		.randomSource(seededRandom(input.seed))
		.force('charge', forceManyBody<ISimNode>().strength(FORCE.charge).distanceMax(FORCE.chargeRange).theta(FORCE.theta))
		.force(
			'link',
			forceLink<ISimNode, ISimLink>(links)
				.distance((l) => FORCE.linkBase + FORCE.linkSpan * (1 - l.w))
				.strength(FORCE.linkStrength),
		)
		.force('x', forceX<ISimNode>(0).strength(FORCE.gravity))
		.force('y', forceY<ISimNode>(0).strength(FORCE.gravity));

	const total = Math.max(0, Math.floor(input.ticks ?? FORCE_TICKS));
	let ticks = 0;
	return {
		get ticks() {
			return ticks;
		},
		get total() {
			return total;
		},
		get done() {
			return ticks >= total;
		},
		step(count: number): void {
			const k = Math.min(Math.max(0, Math.floor(count)), total - ticks);
			if (k > 0 && n > 0) simulation.tick(k);
			ticks += Math.max(0, k);
		},
		positions(): Float32Array {
			const out = new Float32Array(n * 2);
			nodes.forEach((node, i) => {
				const ok = Number.isFinite(node.x) && Number.isFinite(node.y);
				const [sx, sy] = ok ? [node.x as number, node.y as number] : spiral(i);
				out[2 * i] = sx;
				out[2 * i + 1] = sy;
			});
			return out;
		},
	};
}

/** The default clock. */
const defaultClock: ILayoutClock = { now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) };

/**
 * Run a job to completion, to its budget, or until `isCancelled` says so
 * (checked before every step). The synchronous form, for tests and tools;
 * the worker drives jobs itself so it can yield between steps.
 *
 * @param job - The job.
 * @param budgetMs - Wall-clock budget.
 * @param clock - Time source.
 * @param stepSize - Steps between checks.
 * @param isCancelled - Asked before every step.
 * @returns The positions and how the run ended.
 */
export function runJob(job: ILayoutJob, budgetMs: number, clock: ILayoutClock = defaultClock, stepSize = 25, isCancelled?: () => boolean): ILayoutRun {
	const started = clock.now();
	let timedOut = false;
	let cancelled = false;
	while (!job.done) {
		if (isCancelled?.()) {
			cancelled = true;
			break;
		}
		if (clock.now() - started >= budgetMs) {
			timedOut = true;
			break;
		}
		job.step(stepSize);
	}
	return { positions: job.positions(), ticks: job.ticks, elapsedMs: clock.now() - started, timedOut, cancelled };
}
