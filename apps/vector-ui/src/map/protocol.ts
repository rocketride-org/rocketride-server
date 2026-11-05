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
// MAP - LAYOUT WORKER PROTOCOL
// =============================================================================
//
// The messages between the map and its layout worker. Plain data only: the
// request carries the PCA start positions and the node's kNN graph as typed
// arrays (indices and similarities), never a vector and never a wire object.
// Every request carries a number its answers echo; the client accepts only
// answers to its CURRENT request.
// =============================================================================

import type { ISampleResult } from '../contract/types';
import { FORCE_BUDGET_MS, TSNE_BUDGET_MS } from './budgets';

/** The refined layouts the worker computes (PCA needs no worker: it is the node's own answer). */
export type LayoutAlgorithm = 'force' | 'tsne';

/** Ask for a layout. */
export interface ILayoutRequest {
	type: 'layout';
	requestId: number;
	algorithm: LayoutAlgorithm;
	/** Number of points. */
	n: number;
	/** PCA start positions, x,y interleaved (2n). */
	init: Float32Array;
	/** kNN graph, Qdrant's offsets layout. */
	offsets: Int32Array;
	cols: Int32Array;
	sims: Float32Array;
	/** 1 for a point to leave out (a removed document), or null. */
	hidden: Uint8Array | null;
	seed: number;
	/** Stop and answer with the positions so far after this long. */
	budgetMs: number;
	/** k of the quality measure (the sample's k, at most 15). */
	qualityK: number;
}

/** Stop the current request without an answer. */
export interface ILayoutCancel {
	type: 'cancel';
	requestId: number;
}

/** Everything the map can send. */
export type LayoutWorkerIn = ILayoutRequest | ILayoutCancel;

/** How far a run is. */
export interface ILayoutProgress {
	type: 'progress';
	requestId: number;
	ticks: number;
	total: number;
}

/** The finished layout, with the quality measure of it and of PCA. */
export interface ILayoutResult {
	type: 'result';
	requestId: number;
	algorithm: LayoutAlgorithm;
	positions: Float32Array;
	ticks: number;
	total: number;
	elapsedMs: number;
	/** The budget ended the run (the positions are still usable). */
	timedOut: boolean;
	/** kNN overlap of this layout. */
	overlap: number;
	/** kNN overlap of the PCA start, the bar this layout must reach. */
	pcaOverlap: number;
}

/** The worker could not lay the sample out. */
export interface ILayoutError {
	type: 'error';
	requestId: number;
	/** A sentence for the person. */
	message: string;
	/** True when t-SNE refused the sample's size. */
	tooLarge: boolean;
}

/** Everything the worker can send. */
export type LayoutWorkerOut = ILayoutProgress | ILayoutResult | ILayoutError;

/** The keys of a request (a test pins that nothing else of the sample travels). */
export const LAYOUT_REQUEST_KEYS = ['type', 'requestId', 'algorithm', 'n', 'init', 'offsets', 'cols', 'sims', 'hidden', 'seed', 'budgetMs', 'qualityK'] as const;

/** The largest k the quality measure compares. */
export const QUALITY_K_MAX = 15;

/**
 * The wall-clock budget of a layout.
 *
 * @param algorithm - The layout.
 * @returns Milliseconds (15 s for the neighbour graph, 20 s for t-SNE).
 */
export function budgetFor(algorithm: LayoutAlgorithm): number {
	return algorithm === 'tsne' ? TSNE_BUDGET_MS : FORCE_BUDGET_MS;
}

/**
 * Build the request for a sample.
 *
 * @param sample - The node's `sample` answer.
 * @param options - Request id, algorithm, seed and the hidden mask.
 * @returns The request (fresh typed arrays; the sample is not referenced).
 */
export function toLayoutRequest(sample: ISampleResult, options: { requestId: number; algorithm: LayoutAlgorithm; seed: number; hidden: Uint8Array | null }): ILayoutRequest {
	const n = sample.n;
	const init = new Float32Array(n * 2);
	for (let i = 0; i < n; i += 1) {
		init[2 * i] = sample.points.x[i] ?? 0;
		init[2 * i + 1] = sample.points.y[i] ?? 0;
	}
	return {
		type: 'layout',
		requestId: options.requestId,
		algorithm: options.algorithm,
		n,
		init,
		offsets: Int32Array.from(sample.knn.offsets_row),
		cols: Int32Array.from(sample.knn.cols),
		sims: Float32Array.from(sample.knn.sims),
		hidden: options.hidden === null ? null : Uint8Array.from(options.hidden),
		seed: options.seed,
		budgetMs: budgetFor(options.algorithm),
		qualityK: Math.max(1, Math.min(QUALITY_K_MAX, sample.knn.k || QUALITY_K_MAX)),
	};
}
