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
// MAP - LAYOUT WORKER CLIENT (main thread)
// =============================================================================
//
// Runs one layout at a time in the worker and resolves every run with an
// outcome, never a rejection:
//
//   - done        the worker answered the CURRENT request with usable positions;
//   - superseded  a newer run replaced it (its late answer is ignored);
//   - cancelled   Cancel (or dispose): the worker is TERMINATED at once, because
//                 a busy worker only sees messages between steps; the next run
//                 starts a fresh worker;
//   - refused     t-SNE refused the sample's size (the sentence is the worker's);
//   - failed      the worker errored, answered garbage, or stayed silent past
//                 its budget plus a grace period (the watchdog terminates it);
//   - unavailable no worker can be started here (the reason is kept and every
//                 later run answers the same, without trying again).
//
// The map keeps showing PCA in every case but `done`. This module never imports
// a layout: the main thread cannot run one.
// =============================================================================

import type { ISampleResult } from '../contract/types';
import { budgetFor, toLayoutRequest } from './protocol';
import type { ILayoutRequest, ILayoutResult, LayoutAlgorithm, LayoutWorkerIn, LayoutWorkerOut } from './protocol';

/** The slice of a Worker the client uses. */
export interface ILayoutWorkerLike {
	onmessage: ((event: { data: LayoutWorkerOut }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	postMessage(message: LayoutWorkerIn): void;
	terminate(): void;
}

/** Timers (injected by tests). */
export interface ILayoutTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** What to lay out. */
export interface ILayoutSpec {
	sample: ISampleResult;
	algorithm: LayoutAlgorithm;
	seed: number;
	/** 1 for a hidden point (removed document), or null. */
	hidden: Uint8Array | null;
}

/** How a run ended. */
export type LayoutOutcome =
	| { kind: 'done'; result: ILayoutResult }
	| { kind: 'superseded' }
	| { kind: 'cancelled' }
	| { kind: 'refused'; message: string }
	| { kind: 'failed'; message: string }
	| { kind: 'unavailable'; message: string };

/** The client. */
export interface ILayoutClient {
	/** Run a layout; resolves when it ends in any way. */
	run(spec: ILayoutSpec, onProgress?: (ticks: number, total: number) => void): Promise<LayoutOutcome>;
	/** Stop the current run now. */
	cancel(): void;
	/** Stop and refuse further runs. */
	dispose(): void;
	/** True while a run is in progress. */
	readonly busy: boolean;
}

/** Options. */
export interface ILayoutClientOptions {
	createWorker(): ILayoutWorkerLike;
	timers?: ILayoutTimers;
	/** Extra time the watchdog allows past the layout's own budget. */
	watchdogGraceMs?: number;
}

const DEFAULT_TIMERS: ILayoutTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Whether a result is usable: the right number of finite coordinates.
 *
 * @param result - The answer.
 * @param n - Points requested.
 * @returns True when every coordinate is finite and there are 2n of them.
 */
function usable(result: ILayoutResult, n: number): boolean {
	if (!(result.positions instanceof Float32Array) || result.positions.length !== n * 2) return false;
	for (let i = 0; i < result.positions.length; i += 1) if (!Number.isFinite(result.positions[i] as number)) return false;
	return true;
}

/**
 * Create a layout client.
 *
 * @param options - How to start a worker, timers, watchdog grace.
 * @returns The client.
 */
export function createLayoutClient(options: ILayoutClientOptions): ILayoutClient {
	const timers = options.timers ?? DEFAULT_TIMERS;
	const grace = options.watchdogGraceMs ?? 5_000;
	let worker: ILayoutWorkerLike | null = null;
	let unavailable: string | null = null;
	let disposed = false;
	let nextId = 1;
	let pending: { request: ILayoutRequest; resolve: (outcome: LayoutOutcome) => void; onProgress?: (ticks: number, total: number) => void; watchdog: unknown } | null = null;

	/** Resolve the pending run (once) and clear its watchdog. */
	function settle(outcome: LayoutOutcome): void {
		const run = pending;
		if (run === null) return;
		pending = null;
		timers.clear(run.watchdog);
		run.resolve(outcome);
	}

	/** Terminate the worker (the next run starts a new one). */
	function kill(): void {
		const w = worker;
		worker = null;
		if (w !== null) {
			w.onmessage = null;
			w.onerror = null;
			w.terminate();
		}
	}

	/** The running worker, started on first use. */
	function ensureWorker(): ILayoutWorkerLike | null {
		if (worker !== null) return worker;
		if (unavailable !== null) return null;
		try {
			const w = options.createWorker();
			w.onmessage = (event) => {
				const message = event.data;
				const run = pending;
				if (run === null || !message || message.requestId !== run.request.requestId) return;
				if (message.type === 'progress') {
					run.onProgress?.(message.ticks, message.total);
				} else if (message.type === 'result') {
					settle(usable(message, run.request.n) ? { kind: 'done', result: message } : { kind: 'failed', message: 'The layout worker answered with unusable positions; the map keeps the previous layout.' });
				} else if (message.type === 'error') {
					settle(message.tooLarge ? { kind: 'refused', message: message.message } : { kind: 'failed', message: message.message });
				}
			};
			w.onerror = (event) => {
				const detail = event && typeof event === 'object' && 'message' in event ? String((event as { message: unknown }).message) : 'unknown error';
				kill();
				settle({ kind: 'failed', message: `The layout worker failed (${detail}); the map keeps the previous layout.` });
			};
			worker = w;
			return w;
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
			return null;
		}
	}

	return {
		get busy() {
			return pending !== null;
		},
		run(spec, onProgress): Promise<LayoutOutcome> {
			if (disposed) return Promise.resolve({ kind: 'unavailable', message: 'The map was closed.' });
			settle({ kind: 'superseded' });
			const w = ensureWorker();
			if (w === null) return Promise.resolve({ kind: 'unavailable', message: unavailable ?? 'The layout worker could not be started.' });
			const request = toLayoutRequest(spec.sample, { requestId: nextId++, algorithm: spec.algorithm, seed: spec.seed, hidden: spec.hidden });
			return new Promise<LayoutOutcome>((resolve) => {
				const watchdog = timers.set(() => {
					if (pending?.request.requestId !== request.requestId) return;
					kill();
					settle({ kind: 'failed', message: `The layout did not finish within ${Math.round((budgetFor(spec.algorithm) + grace) / 1000)} s; the map keeps the previous layout.` });
				}, budgetFor(spec.algorithm) + grace);
				pending = { request, resolve, onProgress, watchdog };
				w.postMessage(request);
			});
		},
		cancel(): void {
			if (pending === null) return;
			kill();
			settle({ kind: 'cancelled' });
		},
		dispose(): void {
			disposed = true;
			kill();
			settle({ kind: 'cancelled' });
		},
	};
}
