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
// VECTOR — COMPARE (pure): two searches side by side
// =============================================================================
//
// Search's Compare runs two questions, A and B, and says how far their
// results agree: by chunk (how many results they share, and the Jaccard
// index |A ∩ B| / |A ∪ B| of the two result sets) and by document (which
// documents only one of them found, whatever chunk). A chunk listed twice in
// one run counts once. Nothing here calls anything.
// =============================================================================

import type { VectorKey } from '../contract/types';

/** What a compared row needs: its chunk and its document. */
export interface CompareRow {
	key: VectorKey;
	objectId: string;
}

/** How two result lists agree. */
export interface CompareSummary {
	/** Distinct chunks A found. */
	sizeA: number;
	/** Distinct chunks B found. */
	sizeB: number;
	/** Chunks both found. */
	shared: number;
	/** Chunks either found. */
	union: number;
	/** shared / union, or null when neither found anything. */
	jaccard: number | null;
	/** Documents A found that B did not (in A's order). */
	onlyA: string[];
	/** Documents B found that A did not (in B's order). */
	onlyB: string[];
	/** keyId of every chunk both found. */
	sharedKeys: ReadonlySet<string>;
}

/** Where a row of one run stands against the other run. */
export type CompareSide = 'both' | 'only-a' | 'only-b';

/**
 * One string per chunk. The chunk number is always last and has no '#', so the last '#' splits it unambiguously.
 *
 * @param key - The chunk.
 * @returns `objectId#chunkId`.
 */
export function keyId(key: VectorKey): string {
	return `${key[0]}#${key[1]}`;
}

/**
 * The React key of a result row: its position, then its chunk. The chunk
 * alone is not unique: a store may answer the same chunk twice, and rows
 * without chunk ids all read as `#-1`. A run's rows are replaced together
 * and keep their order while the threshold moves, so the position is stable
 * for as long as the run is shown.
 *
 * @param key - The row's chunk.
 * @param index - The row's position in its table.
 * @returns `index:objectId#chunkId`.
 */
export function rowKey(key: VectorKey, index: number): string {
	return `${index}:${keyId(key)}`;
}

/**
 * The distinct chunk ids of a run, in order.
 *
 * @param rows - The run's rows.
 * @returns The ids.
 */
function chunkIds(rows: readonly CompareRow[]): Set<string> {
	return new Set(rows.map((row) => keyId(row.key)));
}

/**
 * The documents of `rows` that `other` never mentions, in order, each once.
 *
 * @param rows - One run.
 * @param other - The other run.
 * @returns objectIds.
 */
function documentsOnlyIn(rows: readonly CompareRow[], other: readonly CompareRow[]): string[] {
	const elsewhere = new Set(other.map((row) => row.objectId));
	const out: string[] = [];
	for (const row of rows) if (!elsewhere.has(row.objectId) && !out.includes(row.objectId)) out.push(row.objectId);
	return out;
}

/**
 * Compare two runs.
 *
 * @param a - Run A's rows.
 * @param b - Run B's rows.
 * @returns The summary.
 */
export function compareRuns(a: readonly CompareRow[], b: readonly CompareRow[]): CompareSummary {
	const idsA = chunkIds(a);
	const idsB = chunkIds(b);
	const sharedKeys = new Set([...idsA].filter((id) => idsB.has(id)));
	const union = idsA.size + idsB.size - sharedKeys.size;
	return {
		sizeA: idsA.size,
		sizeB: idsB.size,
		shared: sharedKeys.size,
		union,
		jaccard: union === 0 ? null : sharedKeys.size / union,
		onlyA: documentsOnlyIn(a, b),
		onlyB: documentsOnlyIn(b, a),
		sharedKeys,
	};
}

/**
 * "N result(s)".
 *
 * @param count - How many.
 * @returns The words.
 */
function results(count: number): string {
	return count === 1 ? '1 result' : `${count.toLocaleString('en-US')} results`;
}

/**
 * The sentence the panel shows: "A and B share 4 of 10 results (Jaccard 0.25); 3 documents only in A, 2 only in B".
 *
 * @param summary - The comparison.
 * @returns The sentence.
 */
export function compareSentence(summary: CompareSummary): string {
	if (summary.sizeA === 0 && summary.sizeB === 0) return 'Neither A nor B found anything';
	if (summary.sizeB === 0) return `B found nothing; A found ${results(summary.sizeA)}`;
	if (summary.sizeA === 0) return `A found nothing; B found ${results(summary.sizeB)}`;
	const of = Math.max(summary.sizeA, summary.sizeB);
	const documents = summary.onlyA.length === 1 ? '1 document' : `${summary.onlyA.length.toLocaleString('en-US')} documents`;
	return `A and B share ${summary.shared.toLocaleString('en-US')} of ${results(of)} (Jaccard ${(summary.jaccard ?? 0).toFixed(2)}); ${documents} only in A, ${summary.onlyB.length.toLocaleString('en-US')} only in B`;
}

/**
 * Whether the other run found this row's chunk too.
 *
 * @param summary - The comparison.
 * @param key - The row's chunk.
 * @param run - Which run the row belongs to.
 * @returns 'both', or the run that alone found it.
 */
export function sideOf(summary: CompareSummary, key: VectorKey, run: 'A' | 'B'): CompareSide {
	if (summary.sharedKeys.has(keyId(key))) return 'both';
	return run === 'A' ? 'only-a' : 'only-b';
}
