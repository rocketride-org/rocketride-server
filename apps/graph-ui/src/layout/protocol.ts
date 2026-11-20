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
// LAYOUT - WORKER PROTOCOL
// =============================================================================
//
// The messages between the canvas and the layout worker. Plain data only: the
// request carries ids and numbers, never wire objects, so the worker's d3
// simulation (which mutates the objects it is given) has nothing of the result
// to corrupt. Every request carries a number that the answer echoes; the client
// ignores any answer that is not for its CURRENT request.
// =============================================================================

/** One node to place. */
export interface ILayoutNode {
	id: string;
	/** Starting position, when known (a node that is already drawn, or a ring around an expanded node). */
	x?: number;
	y?: number;
	/** A pinned node keeps exactly `x`,`y` (a node the user dragged, or one already placed). */
	pinned?: boolean;
}

/** One relationship, as the pair of node ids it joins (parallel and self links are fine). */
export interface ILayoutLink {
	source: string;
	target: string;
}

/** Ask for a static layout. */
export interface ILayoutRequest {
	type: 'layout';
	/** Echoed by the answer; the client only accepts the answer to its latest request. */
	requestId: number;
	nodes: ILayoutNode[];
	links: ILayoutLink[];
	/** Seed for the simulation's random source (same input and seed give the same layout). */
	seed: number;
	/** Simulation ticks to run (the static layout; d3's default is 300). */
	ticks: number;
	/** Stop early and answer with the best positions so far after this many milliseconds. */
	deadlineMs: number;
	/** Radius of a node, so overlapping circles are pushed apart. */
	radius: number;
}

/** Best-effort cancellation (the client also terminates a worker it supersedes). */
export interface ILayoutCancel {
	type: 'cancel';
	requestId: number;
}

/** Everything the canvas can send. */
export type LayoutWorkerIn = ILayoutRequest | ILayoutCancel;

/** Final positions. */
export interface ILayoutResult {
	type: 'result';
	requestId: number;
	positions: Array<{ id: string; x: number; y: number }>;
	/** Ticks actually run. */
	ticks: number;
	/** Wall-clock time spent in the worker. */
	elapsedMs: number;
	/** True when the deadline cut the simulation short (positions are still usable). */
	timedOut: boolean;
}

/** The worker could not lay the graph out. */
export interface ILayoutError {
	type: 'error';
	requestId: number;
	message: string;
}

/** Everything the worker can send. */
export type LayoutWorkerOut = ILayoutResult | ILayoutError;

/** Worker defaults. */
export const DEFAULT_TICKS = 300;
export const DEFAULT_DEADLINE_MS = 4000;

/**
 * How long the worker may spend before it answers with the positions it has.
 * Bigger graphs need longer (and the wait is off the main thread), up to a ceiling.
 *
 * @param nodes - Nodes in the layout.
 * @returns Milliseconds.
 */
export function layoutDeadlineMs(nodes: number): number {
	return Math.min(12_000, Math.max(4000, 2000 + nodes * 10));
}
