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
// VECTOR - HEAT (pure): one document's chunks against the active query
// =============================================================================
//
// The heat strip shows how similar every chunk of one document is to the
// active query: the text query placed on the map, or the chat question the
// map was shown (SelectionState.query). The store scores the document's chunk
// keys (`neighbors` with `scope_keys`) and answers one similarity per key, or
// null for a key it does not hold; a null is "no similarity", never 0. The
// call itself is adapters/actions.ts `scoreChunks`; the map's Heat strip tab
// and the document tab both read its answer through `heatScores`.
// =============================================================================

import type { VectorKey } from '../contract/types';

/** One chunk's similarity to the query. */
export interface IHeatScore {
	chunkId: number;
	sim: number;
}

/** The document tab without an active query. */
export const HEAT_NO_QUERY = 'Run a text query on the Map, or show a chat answer there, to see how similar each chunk of this document is to it.';

/** The document tab with a query but nothing that can embed it. */
export const HEAT_NO_EMBED = 'No embedding node is reachable on this connection, so the chunks cannot be scored against the query.';

/** While the store scores the chunks. */
export const HEAT_SCORING = 'Scoring each chunk against the query…';

/**
 * The line above the strip.
 *
 * @param query - The active query.
 * @returns E.g. 'Similarity of each chunk to "where does the water come from?"'.
 */
export function heatCaption(query: string): string {
	return `Similarity of each chunk to "${query}"`;
}

/**
 * The keys to score: one per chunk in reading order, at most `max`.
 *
 * @param objectId - The document.
 * @param chunks - Its chunk count.
 * @param max - `limits.scope_keys_max`.
 * @returns The keys.
 */
export function heatKeys(objectId: string, chunks: number, max: number): VectorKey[] {
	const n = Number.isFinite(chunks) ? Math.max(0, Math.min(Math.floor(chunks), Math.floor(max))) : 0;
	return Array.from({ length: n }, (_, c) => [objectId, c] as const);
}

/**
 * The strip's scores from a `neighbors` scope answer.
 *
 * @param ids - The chunk ids, in the order their keys were sent.
 * @param scores - The answer's `scores`, one per key (null for a key the store does not hold).
 * @returns The chunks that have a similarity.
 */
export function heatScores(ids: readonly number[], scores: ReadonlyArray<number | null | undefined>): IHeatScore[] {
	const out: IHeatScore[] = [];
	ids.forEach((chunkId, i) => {
		const sim = scores[i];
		if (typeof sim === 'number' && Number.isFinite(sim)) out.push({ chunkId, sim });
	});
	return out;
}
