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
// CYPHER - BOUNDED PATH SEARCH (iterative deepening, one request at a time)
// =============================================================================
//
// "Find path" between two nodes without shortestPath (Apache AGE has none) and
// without ever running an unbounded traversal: ask for a path of exactly 1
// relationship, then exactly 2, and so on up to the depth limit (10), and stop at
// the FIRST depth that answers. The first answer is therefore a shortest path.
//
//   - ONE request is in flight at a time. Each depth waits for the previous one.
//   - A total DEADLINE bounds the whole search; the per-call client timeout
//     bounds each call.
//   - "No path" is only ever claimed WITHIN the budget: the wording names the
//     depth that was searched, never "no path exists".
//   - Stop waiting returns at once and the late answer of the call in flight is
//     ignored (the server may still finish it; it cannot be cancelled).
//   - The path comes back exactly as the node serialised it: nodes in traversal
//     order, each relationship in its STORED direction.
// =============================================================================

import { PATH_MAX_DEPTH } from '../graph/budgets';
import type { GraphId, GraphPath, ReadQueryResult } from '../graph/types';
import { isGraphPath } from '../graph/values';
import { isRefusal, pathAtDepth } from './recipes';
import type { IEngine, IRecipe } from './recipes';

// =============================================================================
// TYPES
// =============================================================================

/** How a search ended. */
export type PathOutcome =
	| { status: 'found'; depth: number; path: GraphPath; attempts: number }
	| { status: 'none'; maxDepth: number; attempts: number }
	| { status: 'deadline'; depthReached: number; attempts: number }
	| { status: 'stopped'; depthReached: number; attempts: number }
	| { status: 'error'; depth: number; message: string; attempts: number }
	| { status: 'refused'; message: string };

/** What a search needs from its caller. */
export interface IPathSearchDeps {
	engine: IEngine;
	/** Run one generated query through `read_query`. May reject. */
	run(recipe: IRecipe): Promise<ReadQueryResult>;
	/** Clock (default: Date.now). */
	now?: () => number;
	/** Total time allowed for the whole search (default 60 s). */
	deadlineMs?: number;
	/** The deepest path to look for (default and ceiling: 10). */
	maxDepth?: number;
	/** Called before each depth is tried. */
	onDepth?: (depth: number) => void;
}

/** A path search. */
export interface IPathSearch {
	/** Search for a path between two nodes. Rejects never; resolves once. */
	start(fromId: GraphId, toId: GraphId): Promise<PathOutcome>;
	/** Stop waiting. The search resolves `stopped` and a late answer is ignored. */
	stop(): void;
	/** True while a search is running. */
	readonly running: boolean;
}

/** The wording for a search that found nothing within its budget. */
export function noPathText(maxDepth: number): string {
	return `No path within depth ${maxDepth}. Longer paths, or paths this search could not reach in time, are not searched.`;
}

// =============================================================================
// SEARCH
// =============================================================================

/**
 * Create a path search.
 *
 * @param deps - The engine, how to run a query, and optional limits.
 * @returns The search controller.
 */
export function createPathSearch(deps: IPathSearchDeps): IPathSearch {
	const now = deps.now ?? (() => Date.now());
	const deadlineMs = deps.deadlineMs ?? 60_000;
	const maxDepth = Math.min(PATH_MAX_DEPTH, Math.max(1, Math.floor(deps.maxDepth ?? PATH_MAX_DEPTH)));
	let active = false;
	let generation = 0;
	let stopNow: (() => void) | null = null;

	return {
		get running() {
			return active;
		},

		stop(): void {
			// Free the controller at once: a new search may start while the call the
			// user stopped waiting for is still running on the server.
			generation += 1;
			active = false;
			stopNow?.();
			stopNow = null;
		},

		async start(fromId: GraphId, toId: GraphId): Promise<PathOutcome> {
			if (active) return { status: 'refused', message: 'A path search is already running. Stop waiting for it first.' };
			const first = pathAtDepth(deps.engine, fromId, toId, 1);
			if (isRefusal(first)) return { status: 'refused', message: first.refusal };

			active = true;
			const mine = ++generation;
			const started = now();
			let attempts = 0;
			let reached = 0;
			// One promise that settles when the user stops waiting, raced against each call.
			const stopped = new Promise<'stopped'>((resolve) => {
				stopNow = () => resolve('stopped');
			});

			try {
				for (let depth = 1; depth <= maxDepth; depth++) {
					if (generation !== mine) return { status: 'stopped', depthReached: reached, attempts };
					if (now() - started >= deadlineMs) return { status: 'deadline', depthReached: reached, attempts };
					const recipe = pathAtDepth(deps.engine, fromId, toId, depth);
					if (isRefusal(recipe)) return { status: 'refused', message: recipe.refusal };
					deps.onDepth?.(depth);
					attempts += 1;
					let result: ReadQueryResult | 'stopped';
					try {
						result = await Promise.race([deps.run(recipe), stopped]);
					} catch (error) {
						if (generation !== mine) return { status: 'stopped', depthReached: reached, attempts };
						return { status: 'error', depth, message: error instanceof Error ? error.message : String(error), attempts };
					}
					if (result === 'stopped' || generation !== mine) return { status: 'stopped', depthReached: reached, attempts };
					reached = depth;
					const path = firstPath(result);
					if (path) {
						const ends = [path.nodes[0]?.id, path.nodes[path.nodes.length - 1]?.id];
						const matches = (ends[0] === fromId && ends[1] === toId) || (ends[0] === toId && ends[1] === fromId);
						if (!matches) return { status: 'error', depth, message: 'The node answered with a path between other nodes than the two selected.', attempts };
						return { status: 'found', depth, path, attempts };
					}
				}
				return { status: 'none', maxDepth, attempts };
			} finally {
				// A search that was stopped has already released the controller, and a
				// newer search may own it by now: only the owner resets it.
				if (generation === mine) {
					active = false;
					stopNow = null;
				}
			}
		},
	};
}

/**
 * The first path in a result's cells.
 *
 * @param result - A `read_query` answer.
 * @returns The path, or null when the answer holds none.
 */
function firstPath(result: ReadQueryResult): GraphPath | null {
	for (const row of result.rows ?? []) {
		for (const cell of row) if (isGraphPath(cell) && cell.nodes.length >= 2) return cell;
	}
	return null;
}
