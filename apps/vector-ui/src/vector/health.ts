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
// VECTOR - DOCUMENT HEALTH (pure): what may be wrong with one stored document
// =============================================================================
//
// From the document's directory row (contract section 4.4-F adds
// `max_chunk_id` and `deleted_chunks`; pgvector reports them, other stores
// answer null, an older node sends neither):
//
//   no first chunk  chunk 0 is not stored (partly removed or ingested);
//   gaps            chunk ids run past the chunks stored (or the reverse),
//                   beyond what a missing chunk 0 and, in an active
//                   listing, the soft-deleted chunks explain;
//   deleted chunks  soft-deleted rows of the document are still stored (a
//                   real signal under deleted:'active', whose `chunks`
//                   counts active rows only);
//   empty parse     no chunk stored, or every chunk of a fully loaded list
//                   is empty;
//   oversize        more than 10 times the median chunks per loaded
//                   document (only once that median is settled).
//
// The first four are defects of what is stored and put the document under
// the directory's "Needs attention" (ATTENTION_KINDS, needsAttention).
// Oversize compares with whatever else is loaded, so it is a badge only: the
// document stays in its folder.
//
// A flag whose fields the store did not give is not computed and listed as
// unchecked; the panel says which stores report them. Nothing here calls.
// =============================================================================

import type { IDocumentItem } from '../contract/types';

/** The kinds of flag, in the order they are listed. */
export const HEALTH_KINDS = ['no_first_chunk', 'gaps', 'deleted_chunks', 'empty_parse', 'oversize'] as const;

/** One kind of flag. */
export type HealthKind = (typeof HEALTH_KINDS)[number];

/** The flags that put a document under "Needs attention": defects of what is stored, not its size. */
export const ATTENTION_KINDS: readonly HealthKind[] = ['no_first_chunk', 'gaps', 'deleted_chunks', 'empty_parse'];

/** A document with more than this many times the median chunks is oversize. */
export const OVERSIZE_FACTOR = 10;

/** Why gaps and deleted chunks are not checked on a store. */
export const HEALTH_NOT_REPORTED = 'This store does not report chunk ids or soft-deleted chunks per document, so gaps and deleted chunks are not checked; pgvector stores report them.';

/** One flag. */
export interface IHealthFlag {
	kind: HealthKind;
	/** The badge's words ('no first chunk', '1 deleted chunk'). */
	label: string;
	/** A sentence with the numbers. */
	detail: string;
}

/** A document's health. */
export interface IDocumentHealth {
	flags: IHealthFlag[];
	/** The flags not computed because the store did not give their fields. */
	unchecked: HealthKind[];
}

/** What a document's health is computed against. */
export interface IHealthContext {
	/** Median chunks per loaded document, for "oversize"; null or absent when unknown (not computed). */
	medianChunks?: number | null;
	/** The row's listing: 'active' (the directory; `chunks` counts active rows) or 'all' (a document tab). */
	listing?: 'active' | 'all';
	/** The lengths of the document's chunks, when they are loaded, and whether every one is. */
	chunkLengths?: { lengths: readonly number[]; complete: boolean } | null;
}

/** A count with its noun. */
function plural(n: number, one: string, many: string): string {
	return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** A value the store reported (not null, not absent). */
function reported(value: number | null | undefined): value is number {
	return value !== null && value !== undefined && Number.isFinite(value);
}

/**
 * The health of one document.
 *
 * @param item - Its directory row.
 * @param ctx - The median, the row's listing mode and the loaded chunk lengths.
 * @returns Its flags and what was not checked.
 */
export function documentHealth(item: IDocumentItem, ctx: IHealthContext = {}): IDocumentHealth {
	const flags: IHealthFlag[] = [];
	const unchecked: HealthKind[] = [];
	const listing = ctx.listing ?? 'active';

	if (!item.has_first_chunk) flags.push({ kind: 'no_first_chunk', label: 'no first chunk', detail: 'Chunk 0 is not stored: the document was partly removed or partly ingested.' });

	if (reported(item.max_chunk_id) && reported(item.chunks)) {
		const ids = item.max_chunk_id + 1;
		if (item.chunks > ids) flags.push({ kind: 'gaps', label: 'gaps', detail: `More chunks than chunk ids: ${plural(item.chunks, 'chunk is', 'chunks are')} stored under ids 0 to ${item.max_chunk_id.toLocaleString('en-US')}.` });
		else {
			const missing = ids - item.chunks;
			// A missing chunk 0 has its own flag; in an active listing the soft-deleted chunks are not counted either.
			const first = item.has_first_chunk ? 0 : 1;
			const deleted = listing === 'active' && reported(item.deleted_chunks) ? item.deleted_chunks : 0;
			if (missing > first + deleted) {
				const unexplained = missing - first - deleted;
				const reasons = [first > 0 ? 'the first chunk' : null, deleted > 0 ? 'the soft-deleted ones' : null].filter((r): r is string => r !== null);
				const why = reasons.length === 0 ? '' : ` beyond ${reasons.join(' and ')}`;
				flags.push({ kind: 'gaps', label: 'gaps', detail: `Chunk ids run to ${item.max_chunk_id.toLocaleString('en-US')} but ${plural(item.chunks, 'chunk is', 'chunks are')} stored: ${unexplained.toLocaleString('en-US')} ${unexplained === 1 ? 'is' : 'are'} missing${why}.` });
			}
		}
	} else unchecked.push('gaps');

	if (reported(item.deleted_chunks)) {
		const n = item.deleted_chunks;
		if (n > 0) flags.push({ kind: 'deleted_chunks', label: plural(n, 'deleted chunk', 'deleted chunks'), detail: `${plural(n, 'soft-deleted chunk', 'soft-deleted chunks')} of this document ${n === 1 ? 'is' : 'are'} still stored.` });
	} else unchecked.push('deleted_chunks');

	const lengths = ctx.chunkLengths;
	if (item.chunks === 0) flags.push({ kind: 'empty_parse', label: 'empty', detail: 'No chunk is stored for this document: the parser found no text.' });
	else if (lengths && lengths.complete && lengths.lengths.length > 0 && lengths.lengths.every((n) => n === 0)) flags.push({ kind: 'empty_parse', label: 'empty', detail: 'Every chunk of this document is empty: the parser found no text.' });
	else if (!reported(item.chunks) && !(lengths && lengths.complete)) unchecked.push('empty_parse');

	const median = ctx.medianChunks;
	if (reported(median) && median > 0 && reported(item.chunks)) {
		if (item.chunks > OVERSIZE_FACTOR * median) flags.push({ kind: 'oversize', label: 'oversize', detail: `${plural(item.chunks, 'chunk', 'chunks')}: more than ${OVERSIZE_FACTOR} times the median of ${(Math.round(median * 10) / 10).toLocaleString('en-US')} per document loaded.` });
	} else unchecked.push('oversize');

	return { flags, unchecked };
}

/**
 * Whether a document goes under "Needs attention": it has a defect flag (an
 * oversize document alone stays in its folder, with the badge).
 *
 * @param health - Its health.
 * @returns True with at least one of {@link ATTENTION_KINDS}.
 */
export function needsAttention(health: Pick<IDocumentHealth, 'flags'>): boolean {
	return health.flags.some((flag) => ATTENTION_KINDS.includes(flag.kind));
}

/**
 * The median chunks per document of the loaded rows (documents without a count left out).
 *
 * @param rows - The loaded rows.
 * @returns The median, or null.
 */
export function medianChunks(rows: readonly IDocumentItem[]): number | null {
	const counts = rows
		.map((r) => r.chunks)
		.filter(reported)
		.sort((a, b) => a - b);
	if (counts.length === 0) return null;
	const mid = Math.floor(counts.length / 2);
	return counts.length % 2 === 1 ? (counts[mid] as number) : ((counts[mid - 1] as number) + (counts[mid] as number)) / 2;
}

/**
 * Soft-deleted chunks from a document's two chunk totals (every row, active rows).
 *
 * @param all - The total of `chunks {deleted:'all'}`, or null when the store did not count.
 * @param active - The total of `chunks {deleted:'active'}`, or null.
 * @returns The difference, or null when either is unknown or they disagree.
 */
export function deletedFromTotals(all: number | null, active: number | null): number | null {
	if (all === null || active === null || all < active) return null;
	return all - active;
}

/** The health of the loaded documents, for the stats strip's chip. */
export interface IHealthSummary {
	/** Documents that need attention (a defect flag; oversize alone does not count). */
	flagged: number;
	/** Documents per flag. */
	counts: Record<HealthKind, number>;
	/** Flags no loaded document could be checked for. */
	unreported: HealthKind[];
	loaded: number;
	/** Every document is loaded. */
	complete: boolean;
}

/**
 * The health of the loaded documents.
 *
 * @param rows - The loaded rows.
 * @param ctx - The median (null while the listing loads) and whether every document is loaded.
 * @returns The summary.
 */
export function healthSummary(rows: readonly IDocumentItem[], ctx: { medianChunks: number | null; complete: boolean }): IHealthSummary {
	const counts = Object.fromEntries(HEALTH_KINDS.map((k) => [k, 0])) as Record<HealthKind, number>;
	const checked = Object.fromEntries(HEALTH_KINDS.map((k) => [k, 0])) as Record<HealthKind, number>;
	let flagged = 0;
	for (const row of rows) {
		const health = documentHealth(row, { medianChunks: ctx.medianChunks });
		if (needsAttention(health)) flagged += 1;
		for (const flag of health.flags) counts[flag.kind] += 1;
		for (const kind of HEALTH_KINDS) if (!health.unchecked.includes(kind)) checked[kind] += 1;
	}
	const unreported = rows.length === 0 ? [] : HEALTH_KINDS.filter((k) => checked[k] === 0);
	return { flagged, counts, unreported, loaded: rows.length, complete: ctx.complete };
}

/** What each flag is called in the chip's breakdown. */
export const HEALTH_TITLES: Readonly<Record<HealthKind, string>> = {
	no_first_chunk: 'Without a first chunk',
	gaps: 'Gaps in chunk ids',
	deleted_chunks: 'Deleted chunks',
	empty_parse: 'Empty',
	oversize: 'Oversize',
};
