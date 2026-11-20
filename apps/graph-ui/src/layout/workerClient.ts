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
// LAYOUT - WORKER CLIENT (request ids, supersession, watchdog, fallback)
// =============================================================================
//
// What the canvas talks to. It owns three guarantees:
//
//   1. STALE ANSWERS ARE IGNORED. Every request gets a fresh id, the worker
//      echoes it, and only the answer to the CURRENT request is accepted. A
//      request that is superseded (a newer one arrives) or disposed resolves as
//      `stale`, which callers drop.
//   2. SUPERSEDED JOBS DO NOT LINGER. A worker with a job in flight is
//      TERMINATED when a newer request arrives (it is the only way to stop a
//      busy worker at once), and a fresh one is started for the next request.
//   3. THE MAIN THREAD NEVER RUNS THE FORCE SIMULATION. When the worker cannot
//      be started, errors, returns nonsense or exceeds its time, the client
//      answers with the cheap deterministic grid (gridFallback.ts) and says why.
//      After a worker start failure or error the client stays on the grid for
//      good, instead of retrying a worker that cannot work. This file therefore
//      does not import d3-force, and a test keeps it that way.
//
// The worker is injected, so all of this is tested in Node with a fake worker.
// =============================================================================

import type { Point } from '../graph/geometry';
import { NODE_RADIUS } from '../graph/geometry';
import { gridLayout } from './gridFallback';
import { DEFAULT_DEADLINE_MS, DEFAULT_TICKS } from './protocol';
import type { ILayoutNode, ILayoutRequest, LayoutWorkerOut } from './protocol';

// =============================================================================
// TYPES
// =============================================================================

/** The slice of a Worker the client uses. */
export interface ILayoutWorkerLike {
	postMessage(message: unknown): void;
	terminate(): void;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

/** What to lay out. */
export interface ILayoutSpec {
	nodes: ILayoutNode[];
	links: Array<{ source: string; target: string }>;
	seed: number;
	ticks?: number;
	deadlineMs?: number;
	radius?: number;
}

/** Why the grid was used instead of the force layout. */
export type FallbackReason = 'worker-unavailable' | 'worker-error' | 'timeout' | 'bad-result';

/** How a layout request ended. */
export type LayoutOutcome =
	| { status: 'ok'; requestId: number; positions: Map<string, Point>; timedOut: boolean; ticks: number; elapsedMs: number }
	| { status: 'fallback'; requestId: number; positions: Map<string, Point>; reason: FallbackReason; detail: string }
	| { status: 'stale'; requestId: number };

/** The client. */
export interface ILayoutClient {
	/** Lay a graph out. Resolves once, and never rejects. */
	layout(spec: ILayoutSpec): Promise<LayoutOutcome>;
	/** Stop everything; pending requests resolve as stale. */
	dispose(): void;
	/** True once the worker could not be started or errored; the grid is used from then on. */
	readonly broken: boolean;
}

/** Timer functions, injectable for tests. */
export interface ILayoutTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** Client options. */
export interface ILayoutClientOptions {
	/** Start a worker; may throw. */
	createWorker: () => ILayoutWorkerLike;
	timers?: ILayoutTimers;
	/** Slack added to a request's deadline before the client gives up on the worker. */
	watchdogGraceMs?: number;
}

/** A request in flight. */
interface IPending {
	id: number;
	spec: ILayoutSpec;
	ids: string[];
	resolve: (outcome: LayoutOutcome) => void;
	timer: unknown;
}

// =============================================================================
// CLIENT
// =============================================================================

/**
 * Create a layout client.
 *
 * @param options - How to start a worker, and optional timers.
 * @returns The client.
 */
export function createLayoutClient(options: ILayoutClientOptions): ILayoutClient {
	const timers: ILayoutTimers = options.timers ?? { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
	const grace = options.watchdogGraceMs ?? 2000;
	let worker: ILayoutWorkerLike | null = null;
	let pending: IPending | null = null;
	let counter = 0;
	let broken = false;
	let disposed = false;

	/**
	 * The grid answer for a spec.
	 *
	 * @param spec - What was asked.
	 * @param requestId - The request's id.
	 * @param reason - Why the grid is used.
	 * @param detail - Human-readable detail.
	 * @returns A fallback outcome.
	 */
	const fallback = (spec: ILayoutSpec, requestId: number, reason: FallbackReason, detail: string): LayoutOutcome => {
		const kept = new Map<string, Point>();
		for (const node of spec.nodes) if (node.pinned && Number.isFinite(node.x) && Number.isFinite(node.y)) kept.set(node.id, { x: node.x as number, y: node.y as number });
		return { status: 'fallback', requestId, positions: gridLayout(spec.nodes.map((n) => n.id), kept), reason, detail };
	};

	/** Stop and forget the worker. */
	const dropWorker = (): void => {
		if (!worker) return;
		worker.onmessage = null;
		worker.onerror = null;
		try {
			worker.terminate();
		} catch {
			// a worker that cannot be terminated is already gone
		}
		worker = null;
	};

	/**
	 * Finish the pending request.
	 *
	 * @param outcome - What to resolve it with.
	 */
	const settle = (outcome: LayoutOutcome): void => {
		const current = pending;
		if (!current) return;
		pending = null;
		timers.clear(current.timer);
		current.resolve(outcome);
	};

	/**
	 * Accept a message from the worker.
	 *
	 * @param data - The message.
	 */
	const onMessage = (data: unknown): void => {
		const current = pending;
		const message = data as LayoutWorkerOut | null;
		if (!current || !message || typeof message !== 'object' || message.requestId !== current.id) return; // stale: not our current request
		if (message.type === 'error') {
			settle(fallback(current.spec, current.id, 'worker-error', message.message));
			return;
		}
		if (message.type !== 'result') return;
		const positions = new Map<string, Point>();
		for (const p of message.positions ?? []) {
			if (p && typeof p.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y)) positions.set(p.id, { x: p.x, y: p.y });
		}
		const complete = current.ids.every((id) => positions.has(id)) && positions.size === current.ids.length;
		if (!complete) {
			settle(fallback(current.spec, current.id, 'bad-result', 'The worker answered with missing or non-finite positions.'));
			return;
		}
		settle({ status: 'ok', requestId: current.id, positions, timedOut: !!message.timedOut, ticks: message.ticks, elapsedMs: message.elapsedMs });
	};

	/** A worker error means the worker cannot be trusted: stay on the grid. */
	const onError = (event: unknown): void => {
		broken = true;
		const detail = event && typeof event === 'object' && 'message' in event ? String((event as { message: unknown }).message) : 'The layout worker failed.';
		dropWorker();
		if (pending) settle(fallback(pending.spec, pending.id, 'worker-error', detail));
	};

	return {
		get broken() {
			return broken;
		},

		layout(spec: ILayoutSpec): Promise<LayoutOutcome> {
			const requestId = ++counter;
			if (disposed) return Promise.resolve({ status: 'stale', requestId });

			// A newer request supersedes the one in flight, and the busy worker is
			// stopped at once rather than left to finish work nobody wants.
			if (pending) {
				settle({ status: 'stale', requestId: pending.id });
				dropWorker();
			}
			if (broken) return Promise.resolve(fallback(spec, requestId, 'worker-unavailable', 'The layout worker is not available; nodes are placed on a grid.'));

			if (!worker) {
				try {
					worker = options.createWorker();
				} catch (error) {
					broken = true;
					worker = null;
					return Promise.resolve(fallback(spec, requestId, 'worker-unavailable', error instanceof Error ? error.message : String(error)));
				}
				worker.onmessage = (event) => onMessage(event.data);
				worker.onerror = onError;
			}

			const request: ILayoutRequest = {
				type: 'layout',
				requestId,
				nodes: spec.nodes,
				links: spec.links,
				seed: spec.seed,
				ticks: spec.ticks ?? DEFAULT_TICKS,
				deadlineMs: spec.deadlineMs ?? DEFAULT_DEADLINE_MS,
				radius: spec.radius ?? NODE_RADIUS,
			};
			return new Promise<LayoutOutcome>((resolve) => {
				const entry: IPending = { id: requestId, spec, ids: Array.from(new Set(spec.nodes.map((n) => n.id))), resolve, timer: null };
				entry.timer = timers.set(() => {
					// The worker is silent past its own deadline: give up on it. It is not
					// "broken" (a big graph can simply be slow); the next request gets a new one.
					if (pending && pending.id === requestId) {
						dropWorker();
						settle(fallback(spec, requestId, 'timeout', `The layout did not finish within ${(request.deadlineMs + grace) / 1000} s.`));
					}
				}, request.deadlineMs + grace);
				pending = entry;
				try {
					worker?.postMessage(request);
				} catch (error) {
					onError({ message: error instanceof Error ? error.message : String(error) });
				}
			});
		},

		dispose(): void {
			disposed = true;
			if (pending) settle({ status: 'stale', requestId: pending.id });
			dropWorker();
		},
	};
}
