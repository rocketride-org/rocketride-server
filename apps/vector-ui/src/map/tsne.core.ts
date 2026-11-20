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
// MAP - EXACT t-SNE FROM THE kNN GRAPH (runs in the layout worker, testable in Node)
// =============================================================================
//
// The "t-SNE" layout, for samples of at most 1,000 points:
//
//   1. Affinities: each point's conditional distribution over its kNN neighbours
//      (a Gaussian on the dissimilarity smax - sim, its width found by binary
//      search so the row's perplexity is k/3), symmetrised into a joint P that
//      sums to 1. P is sparse: only the node's kNN pairs, never a vector.
//   2. Exact gradient: the Student-t similarities Q over EVERY pair (n² per
//      iteration, about 1 ms at 1,000 points), with early exaggeration for the
//      first 250 iterations, momentum and per-coordinate gains, as in van der
//      Maaten's reference implementation.
//
// Deterministic: the start is the PCA layout scaled to a standard deviation of
// 1e-4 (a seeded Gaussian start only when PCA has no spread). Driven in steps
// like the force layout (layout.core's ILayoutJob), so the worker can stop it at
// its 20 s budget or on Cancel. More than 1,000 points are refused up front:
// the n² cost and memory grow too fast for the browser.
// =============================================================================

import { TSNE_ITERATIONS, TSNE_MAX_POINTS } from './budgets';
import { seededRandom } from './layout.core';
import type { IKnnGraph, ILayoutJob } from './layout.core';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The budgets live in budgets.ts (no imports) so the main thread can read them. */
export { TSNE_BUDGET_MS, TSNE_ITERATIONS, TSNE_MAX_POINTS } from './budgets';

/** Iterations with early exaggeration (at most a third of the run). */
const EXAGGERATION_ITERATIONS = 250;
const EXAGGERATION = 12;
const MOMENTUM_EARLY = 0.5;
const MOMENTUM_LATE = 0.8;
const MIN_GAIN = 0.01;
const START_STD = 1e-4;

// =============================================================================
// ERRORS
// =============================================================================

/** Raised (before any work) for a sample above TSNE_MAX_POINTS. */
export class TsneTooLargeError extends RangeError {
	constructor(readonly points: number) {
		super(`t-SNE is limited to ${TSNE_MAX_POINTS.toLocaleString('en-US')} points; this sample has ${points.toLocaleString('en-US')}. Draw a smaller sample or use the neighbour graph layout.`);
		this.name = 'TsneTooLargeError';
	}
}

// =============================================================================
// AFFINITIES
// =============================================================================

/** The sparse joint affinities: one entry per unordered pair i < j; the ordered P sums to 1. */
export interface ITsneAffinities {
	rows: Int32Array;
	cols: Int32Array;
	vals: Float64Array;
}

/**
 * The perplexity used for a kNN graph of k neighbours per row.
 *
 * @param k - Neighbours per row.
 * @returns k / 3, clamped to 2..30.
 */
export function tsnePerplexity(k: number): number {
	return Math.min(30, Math.max(2, k / 3));
}

/**
 * One point's conditional distribution over its neighbours: p_j ∝ exp(-beta d_j²),
 * with beta found by binary search so the entropy is log(perplexity) (or the
 * uniform distribution when the row is too short to reach it).
 *
 * @param distances - Dissimilarity to each neighbour.
 * @param perplexity - Target perplexity.
 * @returns The probabilities (in input order) and the precision found.
 */
export function conditionalRow(distances: readonly number[], perplexity: number): { p: number[]; beta: number } {
	const m = distances.length;
	if (m === 0) return { p: [], beta: 0 };
	if (m === 1) return { p: [1], beta: 0 };
	const d2 = distances.map((d) => d * d);
	const base = Math.min(...d2);
	const target = Math.log(perplexity);
	if (target >= Math.log(m)) return { p: new Array<number>(m).fill(1 / m), beta: 0 };
	let beta = 1;
	let lo = 0;
	let hi = Infinity;
	let p: number[] = [];
	for (let iter = 0; iter < 200; iter += 1) {
		p = d2.map((v) => Math.exp(-(v - base) * beta));
		const sum = p.reduce((a, b) => a + b, 0);
		let entropy = 0;
		for (let t = 0; t < m; t += 1) {
			const v = (p[t] as number) / sum;
			p[t] = v;
			if (v > 0) entropy -= v * Math.log(v);
		}
		const gap = entropy - target;
		if (Math.abs(gap) < 1e-7) break;
		if (gap > 0) {
			// Too flat: sharpen.
			lo = beta;
			beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
		} else {
			hi = beta;
			beta = (beta + lo) / 2;
		}
	}
	return { p, beta };
}

/**
 * The joint affinities of a kNN graph.
 *
 * @param knn - The graph (similarities: higher is closer).
 * @param n - Number of points.
 * @param perplexity - Target perplexity per row.
 * @param hidden - Points to leave out.
 * @returns One entry per unordered pair.
 */
export function tsneAffinities(knn: IKnnGraph, n: number, perplexity: number, hidden?: ArrayLike<number> | null): ITsneAffinities {
	const isHidden = (i: number): boolean => hidden != null && (hidden[i] as number) !== 0;
	const valid = (i: number, j: number): boolean => j !== i && j >= 0 && j < n && Number.isInteger(j) && !isHidden(j);
	let smax = -Infinity;
	for (let i = 0; i < n; i += 1) {
		if (isHidden(i)) continue;
		for (let e = knn.offsets_row[i] as number; e < (knn.offsets_row[i + 1] as number); e += 1) {
			if (valid(i, knn.cols[e] as number)) smax = Math.max(smax, knn.sims[e] as number);
		}
	}
	const pairs = new Map<number, number>();
	let rowsCounted = 0;
	for (let i = 0; i < n; i += 1) {
		if (isHidden(i)) continue;
		const js: number[] = [];
		const ds: number[] = [];
		for (let e = knn.offsets_row[i] as number; e < (knn.offsets_row[i + 1] as number); e += 1) {
			const j = knn.cols[e] as number;
			if (!valid(i, j) || js.includes(j)) continue;
			js.push(j);
			ds.push(Math.max(0, smax - (knn.sims[e] as number)));
		}
		if (js.length === 0) continue;
		rowsCounted += 1;
		const { p } = conditionalRow(ds, perplexity);
		js.forEach((j, t) => {
			const key = Math.min(i, j) * n + Math.max(i, j);
			pairs.set(key, (pairs.get(key) ?? 0) + (p[t] as number));
		});
	}
	const size = pairs.size;
	const out: ITsneAffinities = { rows: new Int32Array(size), cols: new Int32Array(size), vals: new Float64Array(size) };
	let e = 0;
	for (const [key, value] of pairs) {
		out.rows[e] = Math.floor(key / n);
		out.cols[e] = key % n;
		out.vals[e] = value / (2 * rowsCounted);
		e += 1;
	}
	return out;
}

/**
 * KL(P || Q) of a layout (for tests and diagnostics; O(n²)).
 *
 * @param p - The joint affinities.
 * @param positions - x,y interleaved.
 * @param n - Number of points.
 * @returns The divergence in nats.
 */
export function klDivergence(p: ITsneAffinities, positions: ArrayLike<number>, n: number): number {
	let z = 0;
	for (let i = 0; i < n; i += 1) {
		for (let j = i + 1; j < n; j += 1) {
			const dx = (positions[2 * i] as number) - (positions[2 * j] as number);
			const dy = (positions[2 * i + 1] as number) - (positions[2 * j + 1] as number);
			z += 2 / (1 + dx * dx + dy * dy);
		}
	}
	let kl = 0;
	for (let e = 0; e < p.vals.length; e += 1) {
		const i = p.rows[e] as number;
		const j = p.cols[e] as number;
		const dx = (positions[2 * i] as number) - (positions[2 * j] as number);
		const dy = (positions[2 * i + 1] as number) - (positions[2 * j + 1] as number);
		const q = 1 / (1 + dx * dx + dy * dy) / z;
		const v = p.vals[e] as number;
		kl += 2 * v * Math.log(v / Math.max(q, 1e-300));
	}
	return kl;
}

// =============================================================================
// JOB
// =============================================================================

/** What a t-SNE run starts from. */
export interface ITsneInput {
	n: number;
	/** PCA start positions, x,y interleaved. Never mutated. */
	init: ArrayLike<number>;
	knn: IKnnGraph;
	/** Seeds the start only when PCA has no spread. */
	seed: number;
	/** Iterations (default TSNE_ITERATIONS). */
	iterations?: number;
	/** Default: tsnePerplexity(k). */
	perplexity?: number;
	hidden?: ArrayLike<number> | null;
}

/**
 * The start: PCA scaled to a standard deviation of START_STD, or a seeded
 * Gaussian of that spread when PCA has none.
 */
function startPositions(input: ITsneInput, n: number): Float64Array {
	const y = new Float64Array(n * 2);
	let sum = 0;
	let sumSq = 0;
	let finite = true;
	for (let i = 0; i < n; i += 1) {
		const x = input.init[2 * i] as number;
		if (!Number.isFinite(x) || !Number.isFinite(input.init[2 * i + 1] as number)) finite = false;
		sum += x;
		sumSq += x * x;
	}
	const mean = n > 0 ? sum / n : 0;
	const std = n > 0 ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
	if (finite && std > 0) {
		for (let t = 0; t < n * 2; t += 1) y[t] = ((input.init[t] as number) / std) * START_STD;
		return y;
	}
	const rand = seededRandom(input.seed);
	for (let t = 0; t < n * 2; t += 1) {
		// Box-Muller.
		const u = Math.max(rand(), 1e-12);
		y[t] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * START_STD;
	}
	return y;
}

/**
 * Start a t-SNE run. Nothing runs until `step` is called.
 *
 * @param input - Start positions and graph (never mutated).
 * @returns The job.
 * @throws TsneTooLargeError above TSNE_MAX_POINTS points.
 */
export function createTsneJob(input: ITsneInput): ILayoutJob {
	const n = Math.max(0, Math.floor(input.n));
	if (n > TSNE_MAX_POINTS) throw new TsneTooLargeError(n);
	let kMax = 0;
	for (let i = 0; i < n; i += 1) kMax = Math.max(kMax, (input.knn.offsets_row[i + 1] as number) - (input.knn.offsets_row[i] as number));
	const p = tsneAffinities(input.knn, n, input.perplexity ?? tsnePerplexity(kMax), input.hidden);
	const isHidden = (i: number): boolean => input.hidden != null && (input.hidden[i] as number) !== 0;
	const active: number[] = [];
	for (let i = 0; i < n; i += 1) if (!isHidden(i)) active.push(i);

	const y = startPositions(input, n);
	const update = new Float64Array(n * 2);
	const gains = new Float64Array(n * 2).fill(1);
	const attract = new Float64Array(n * 2);
	const repel = new Float64Array(n * 2);
	const total = Math.max(0, Math.floor(input.iterations ?? TSNE_ITERATIONS));
	const exaggerated = Math.min(EXAGGERATION_ITERATIONS, Math.floor(total / 3));
	const rate = Math.max(active.length / EXAGGERATION, 50);
	let iteration = 0;

	/** One gradient-descent iteration. */
	function iterate(): void {
		const exaggeration = iteration < exaggerated ? EXAGGERATION : 1;
		const momentum = iteration < exaggerated ? MOMENTUM_EARLY : MOMENTUM_LATE;
		attract.fill(0);
		repel.fill(0);
		// Repulsion over every pair: sum of num² (yi - yj), and Z.
		let z = 0;
		for (let a = 0; a < active.length; a += 1) {
			const i = active[a] as number;
			const xi = y[2 * i] as number;
			const yi = y[2 * i + 1] as number;
			let rx = 0;
			let ry = 0;
			for (let b = a + 1; b < active.length; b += 1) {
				const j = active[b] as number;
				const dx = xi - (y[2 * j] as number);
				const dy = yi - (y[2 * j + 1] as number);
				const num = 1 / (1 + dx * dx + dy * dy);
				z += 2 * num;
				const f = num * num;
				rx += f * dx;
				ry += f * dy;
				repel[2 * j] = (repel[2 * j] as number) - f * dx;
				repel[2 * j + 1] = (repel[2 * j + 1] as number) - f * dy;
			}
			repel[2 * i] = (repel[2 * i] as number) + rx;
			repel[2 * i + 1] = (repel[2 * i + 1] as number) + ry;
		}
		// Attraction over the sparse P.
		for (let e = 0; e < p.vals.length; e += 1) {
			const i = p.rows[e] as number;
			const j = p.cols[e] as number;
			const dx = (y[2 * i] as number) - (y[2 * j] as number);
			const dy = (y[2 * i + 1] as number) - (y[2 * j + 1] as number);
			const f = (exaggeration * (p.vals[e] as number)) / (1 + dx * dx + dy * dy);
			attract[2 * i] = (attract[2 * i] as number) + f * dx;
			attract[2 * i + 1] = (attract[2 * i + 1] as number) + f * dy;
			attract[2 * j] = (attract[2 * j] as number) - f * dx;
			attract[2 * j + 1] = (attract[2 * j + 1] as number) - f * dy;
		}
		let mx = 0;
		let my = 0;
		for (const i of active) {
			for (let c = 0; c < 2; c += 1) {
				const t = 2 * i + c;
				const grad = 4 * ((attract[t] as number) - (z > 0 ? (repel[t] as number) / z : 0));
				const u = update[t] as number;
				gains[t] = Math.sign(grad) !== Math.sign(u) ? (gains[t] as number) + 0.2 : Math.max((gains[t] as number) * 0.8, MIN_GAIN);
				update[t] = momentum * u - rate * (gains[t] as number) * grad;
				y[t] = (y[t] as number) + (update[t] as number);
			}
			mx += y[2 * i] as number;
			my += y[2 * i + 1] as number;
		}
		// Keep the cloud centred.
		if (active.length > 0) {
			mx /= active.length;
			my /= active.length;
			for (const i of active) {
				y[2 * i] = (y[2 * i] as number) - mx;
				y[2 * i + 1] = (y[2 * i + 1] as number) - my;
			}
		}
		iteration += 1;
	}

	return {
		get ticks() {
			return iteration;
		},
		get total() {
			return total;
		},
		get done() {
			return iteration >= total;
		},
		step(count: number): void {
			const k = Math.min(Math.max(0, Math.floor(count)), total - iteration);
			for (let s = 0; s < k; s += 1) iterate();
		},
		positions(): Float32Array {
			const out = new Float32Array(n * 2);
			for (let t = 0; t < n * 2; t += 1) out[t] = Number.isFinite(y[t] as number) ? (y[t] as number) : 0;
			return out;
		},
	};
}
