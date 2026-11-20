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
// MAP - LAYOUT SERVER (the worker's serving loop; testable in Node)
// =============================================================================
//
// Receives layout requests and runs the job in small steps, yielding to the
// message queue between steps so a newer request or a Cancel is seen: a
// superseded or cancelled run stops silently. A finished run (or one cut short
// by its budget) is measured with the kNN overlap, together with its PCA start,
// so the map can keep PCA when the refined layout is no better.
//
// layout.worker.ts binds this to the worker scope; tests drive it directly.
// =============================================================================

import { createForceJob } from './layout.core';
import type { IKnnGraph, ILayoutJob } from './layout.core';
import type { ILayoutRequest, LayoutWorkerIn, LayoutWorkerOut } from './protocol';
import { knnOverlap } from './quality';
import { TsneTooLargeError, createTsneJob } from './tsne.core';

/** What the server needs from its host. */
export interface ILayoutServerDeps {
	post(message: LayoutWorkerOut): void;
	now(): number;
	/** Let queued messages run (the worker: a zero timeout). */
	yieldToQueue(): Promise<void>;
}

/** A layout server. */
export interface ILayoutServer {
	receive(message: LayoutWorkerIn): void;
	/** Resolves once no run is in progress (tests). */
	idle(): Promise<void>;
}

/** Steps between yields: about 20-30 ms of work at 1,000 points. */
const STEP = { force: 10, tsne: 5 } as const;

/**
 * Ticks per step for `n` points: fewer for larger samples, so the budget is
 * checked about as often in time (at 5,000 points a step is 2 force ticks)
 * and a run past its budget leaves little work before it answers.
 *
 * @param algorithm - The layout.
 * @param n - Points in the sample.
 * @returns Ticks per step, at least 1.
 */
function stepFor(algorithm: keyof typeof STEP, n: number): number {
	return Math.max(1, Math.floor(STEP[algorithm] * Math.min(1, 1000 / Math.max(1, n))));
}

/** Steps between progress messages. */
const PROGRESS_EVERY = { force: 30, tsne: 50 } as const;

/**
 * Create a layout server.
 *
 * @param deps - Posting, clock and yielding.
 * @returns The server.
 */
export function createLayoutServer(deps: ILayoutServerDeps): ILayoutServer {
	let current = -1;
	const running = new Set<Promise<void>>();

	/** Serve one request to its end, unless it stops being current. */
	async function serve(request: ILayoutRequest): Promise<void> {
		const id = request.requestId;
		const started = deps.now();
		const graph: IKnnGraph = { offsets_row: request.offsets, cols: request.cols, sims: request.sims };
		let job: ILayoutJob;
		try {
			const input = { n: request.n, init: request.init, knn: graph, seed: request.seed, hidden: request.hidden };
			job = request.algorithm === 'tsne' ? createTsneJob(input) : createForceJob(input);
		} catch (error) {
			if (current === id) deps.post({ type: 'error', requestId: id, message: error instanceof Error ? error.message : String(error), tooLarge: error instanceof TsneTooLargeError });
			return;
		}
		const step = stepFor(request.algorithm, request.n);
		let sinceProgress = 0;
		let timedOut = false;
		try {
			// PCA's overlap does not depend on the run: measure it now, so only the layout's is left after the budget.
			const pcaOverlap = knnOverlap(request.init, graph, request.qualityK, 2, request.hidden);
			while (!job.done) {
				if (current !== id) return;
				if (deps.now() - started >= request.budgetMs) {
					timedOut = true;
					break;
				}
				job.step(step);
				sinceProgress += step;
				if (sinceProgress >= PROGRESS_EVERY[request.algorithm]) {
					sinceProgress = 0;
					deps.post({ type: 'progress', requestId: id, ticks: job.ticks, total: job.total });
				}
				await deps.yieldToQueue();
			}
			if (current !== id) return;
			const positions = job.positions();
			const overlap = knnOverlap(positions, graph, request.qualityK, 2, request.hidden);
			deps.post({ type: 'result', requestId: id, algorithm: request.algorithm, positions, ticks: job.ticks, total: job.total, elapsedMs: deps.now() - started, timedOut, overlap, pcaOverlap });
		} catch (error) {
			if (current === id) deps.post({ type: 'error', requestId: id, message: `The layout failed: ${error instanceof Error ? error.message : String(error)}`, tooLarge: false });
		}
	}

	return {
		receive(message: LayoutWorkerIn): void {
			if (!message || typeof message !== 'object') return;
			if (message.type === 'cancel') {
				if (message.requestId === current) current = -1;
				return;
			}
			if (message.type === 'layout') {
				current = message.requestId;
				const run = serve(message).finally(() => running.delete(run));
				running.add(run);
			}
		},
		async idle(): Promise<void> {
			while (running.size > 0) await Promise.all([...running]);
		},
	};
}
