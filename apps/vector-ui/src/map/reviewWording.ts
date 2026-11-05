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
// MAP - WHAT THE REVIEW PANELS SAY (duplicates, outliers, recommend, matrix, text)
// =============================================================================
//
// Every sentence of the duplicates queue, the outlier review, Recommend, the
// similarity matrix and the chunk text panel, in one place so the tests and
// the browser lanes read the same words. Counts are the ones the node
// returned or the browser counted from the sample; nothing here invents one.
// =============================================================================

import type { KeepPolicy } from './dedupe';
import type { MatrixSource, VectorMetric } from '../contract/types';
import { mapFailure } from './wording';

/**
 * en-US number.
 *
 * @param value - A number.
 * @returns It with thousands separators.
 */
export function num(value: number): string {
	return value.toLocaleString('en-US');
}

/**
 * "1 document" / "3 documents".
 *
 * @param n - A count.
 * @param one - The singular.
 * @param many - The plural (default: singular + s).
 * @returns The phrase.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
	return `${num(n)} ${n === 1 ? one : many}`;
}

/**
 * A similarity as the panels print it: 2 to 4 decimals, no trailing zeros past 2.
 *
 * @param value - A similarity.
 * @returns E.g. "0.97", "0.975", "0.9998".
 */
export function simText(value: number): string {
	const fixed = value.toFixed(4).replace(/0{1,2}$/, '');
	return fixed;
}

/**
 * A range of similarities ("0.9991–0.9992", or one value when they are equal).
 *
 * @param lo - The lowest.
 * @param hi - The highest.
 * @returns The range.
 */
export function simRange(lo: number, hi: number): string {
	return lo === hi ? simText(lo) : `${simText(lo)}–${simText(hi)}`;
}

// =============================================================================
// DUPLICATES QUEUE
// =============================================================================

/** The picker's words per policy. */
export const POLICY_LABELS: Readonly<Record<KeepPolicy, string>> = {
	oldest: 'Keep oldest ingest',
	'shortest-path': 'Keep shortest path',
	'most-chunks': 'Keep most chunks',
	manual: 'Choose manually',
};

/** Why a policy cannot choose anywhere in this queue. */
export const POLICY_UNAVAILABLE: Readonly<Record<Exclude<KeepPolicy, 'manual' | 'shortest-path'>, string>> = {
	oldest: 'no ingest time is known for these documents',
	'most-chunks': 'no chunk count is known for these documents',
};

/**
 * No pair at the threshold.
 *
 * @param threshold - The slider's similarity.
 * @returns The sentence.
 */
export function duplicatesNone(threshold: number): string {
	return `No near-duplicate pairs at similarity ${simText(threshold)} or above in this sample.`;
}

/**
 * Where the pairs come from.
 *
 * @param k - The sample's kNN width.
 * @returns The caveat under the slider.
 */
export function duplicatesKnnCaveat(k: number): string {
	return `Pairs among each point's ${num(k)} nearest neighbours in this sample, plus the pairs the store node reported.`;
}

/**
 * The queue covers the sample only.
 *
 * @param n - Points in the sample.
 * @returns The sentence.
 */
export function duplicatesSampleCaveat(n: number): string {
	return `Within this sample of ${plural(n, 'chunk')}; draw a larger or light sample to cover more.`;
}

/**
 * The slider's spoken value.
 *
 * @param threshold - The similarity.
 * @returns E.g. "similarity 0.97".
 */
export function thresholdValueText(threshold: number): string {
	return `similarity ${simText(threshold)}`;
}

/**
 * How many documents are queued.
 *
 * @param n - Queued documents.
 * @param policyChose - True when a keep policy chose in the groups (nothing it keeps holds another document, as far as the sample shows).
 * @returns E.g. "3 documents queued".
 */
export function queuedLine(n: number, policyChose = false): string {
	if (n > 0) return `${plural(n, 'document')} queued`;
	return policyChose ? 'No document queued: this sample does not show that a kept document holds another one. Choose a keep by hand to queue one anyway.' : 'No document queued. Choose which document to keep in each group.';
}

/**
 * The bulk button.
 *
 * @param n - Queued documents.
 * @returns E.g. "Move all queued to the trash (3 documents)".
 */
export function removeAllLabel(n: number): string {
	return `Move all queued to the trash (${plural(n, 'document')})`;
}

/**
 * A group's own remove button.
 *
 * @param n - The group's queued documents.
 * @returns E.g. "Move the others to the trash (2)".
 */
export function removeOthersLabel(n: number): string {
	if (n === 0) return 'Move the others to the trash';
	return n === 1 ? 'Move the other to the trash' : `Move the others to the trash (${num(n)})`;
}

/** A group has no kept document yet. */
export const CHOOSE_KEEP_FIRST = 'Choose the document to keep first';

/** Every document of a group holds text the others do not, as the sample shows. */
export const SHARED_PASSAGES_NOTE = 'Shared passages only: this sample shows that each of these documents holds text the others do not. Moving a document to the trash moves all of it.';

/** Some document of a group holds text the others do not, as the sample shows. */
export const NOT_WHOLE_COPIES_NOTE = 'Not every document here is a copy of the others: this sample shows that at least one holds text the others do not.';

/** The sample holds too few chunks of a document of the group to tell copies from shared text. */
export const TOO_FEW_SAMPLED_NOTE = 'This sample holds too few chunks of these documents to tell copies from shared text.';

/** The sample holds enough of a group's documents but cannot tell yet whether they are whole copies. */
export const PARTLY_MATCHED_NOTE = 'This sample cannot tell yet whether these documents are whole copies of each other: it holds part of each, and part of a document may be text the others do not have.';

/** The store did not report the chunk counts the verdict needs. */
export const UNSIZED_NOTE = 'The store did not report how many chunks these documents have, so this sample cannot tell copies from shared text.';

/** The sample was not drawn evenly within documents (strategy 'first', or a refill). */
export const UNEVEN_SAMPLE_NOTE = 'This sample was not drawn evenly within these documents, so it can only compare the chunks it holds, and those do not tell.';

/** A policy queues a document only where the sample shows the kept one holds it. */
export const POLICY_LEAVES_GROUP = 'A keep policy queues a document only when this sample shows that the kept one holds it.';

/** Under a document a policy leaves in place: the sample shows it holds text the kept one does not. */
export const HELD_OWN_TEXT = 'holds text the kept document does not, so not queued';

/** Under a document a policy leaves in place: the sample does not show the kept one holds it. */
export const HELD_NOT_SHOWN = 'this sample does not show that the kept document holds it, so not queued';

/** Under a document queued by a hand-picked keep: the sample shows it holds text the kept one does not. */
export const BY_HAND_OWN_TEXT = 'queued by your choice; this sample shows it holds text the kept document does not';

/** Under a document queued by a hand-picked keep: the sample does not show the kept one holds it. */
export const BY_HAND_NOT_SHOWN = 'queued by your choice; this sample does not show that the kept document holds it';

/** A group's Move to trash button when its keep holds no other document, as far as the sample shows. */
export const NOTHING_SHOWN_HELD = 'This sample does not show that the kept document holds the others.';

/**
 * After the console moved queued documents to the trash. The chunk count is
 * the document list's (the node's own count of what it moved does not reach
 * the panel), and nothing is said about documents not moved: a cancelled
 * dialog and a batch that stopped at an error look the same from here.
 *
 * @param removed - Documents now in the trash.
 * @param chunks - Their chunks as the document list counts them, or null when one is unknown.
 * @returns E.g. "Moved 3 documents to the trash (41 chunks as listed)".
 */
export function removedLine(removed: number, chunks: number | null): string {
	const counted = chunks === null ? '' : ` (${plural(chunks, 'chunk')} as listed)`;
	return `Moved ${plural(removed, 'document')} to the trash${counted}`;
}

/**
 * A group's legend.
 *
 * @param id - The group number (from 0).
 * @param documents - Its documents.
 * @param lo - Lowest similarity inside.
 * @param hi - Highest similarity inside.
 * @returns E.g. "Group 1 · 2 documents · similarity 0.981–0.995".
 */
export function groupLegend(id: number, documents: number, lo: number, hi: number): string {
	return `Group ${num(id + 1)} · ${plural(documents, 'document')} · similarity ${simRange(lo, hi)}`;
}

/**
 * How much of a document the group covers.
 *
 * @param shared - Its points in the group.
 * @param inSample - Its points in the sample.
 * @returns E.g. "2 of 7 sampled chunks match".
 */
export function sharedLine(shared: number, inSample: number): string {
	return `${num(shared)} of ${plural(inSample, 'sampled chunk')} ${shared === 1 ? 'matches' : 'match'}`;
}

/** A document another group keeps is not queued. */
export const KEPT_ELSEWHERE = 'kept by another group, so not queued';

/** Heading of the groups inside one document. */
export const REPEATED_HEADING = 'Repeated text inside one document';

/** What a repeated-text group is. */
export const REPEATED_NOTE = 'The same text more than once inside one document. Open the document to look; nothing is removed from here.';

/** Several documents need the console's multi-remove dialog, which this view was not given. */
export const NO_BULK_REMOVE = 'This view cannot move several documents to the trash at once.';

/**
 * Only the largest groups are drawn.
 *
 * @param shown - Groups drawn.
 * @param total - Groups found.
 * @returns The sentence.
 */
export function groupsCappedLine(shown: number, total: number): string {
	return `Showing the ${num(shown)} largest of ${num(total)} groups.`;
}

/**
 * Pairs not listed under a group.
 *
 * @param n - Pairs left out.
 * @returns E.g. "and 4 more pairs".
 */
export function morePairsLine(n: number): string {
	return `and ${plural(n, 'more pair')}`;
}

/**
 * Documents of a group not listed under it.
 *
 * @param n - Documents left out.
 * @param queuedAmong - Of those, the queued ones.
 * @param unshownAmong - Of the queued ones, those queued by a hand-picked keep the sample does not show to hold them.
 * @returns E.g. "and 980 more documents, none of them queued. Show group selects the whole group on the map."
 */
export function moreDocumentsLine(n: number, queuedAmong: number, unshownAmong = 0): string {
	const which = queuedAmong <= 0 ? (n === 1 ? 'not queued' : 'none of them queued') : queuedAmong >= n ? (n === 1 ? 'queued' : `all ${num(n)} of them queued`) : `${num(queuedAmong)} of them queued`;
	const unshown = unshownAmong > 0 ? `, ${num(unshownAmong)} by your choice although this sample does not show that the kept document holds ${unshownAmong === 1 ? 'it' : 'them'}` : '';
	return `and ${plural(n, 'more document')}, ${which}${unshown}. Show group selects the whole group on the map.`;
}

/**
 * Reviewed groups.
 *
 * @param n - Reviewed groups.
 * @returns E.g. "Reviewed (2 groups)".
 */
export function reviewedGroupsHeading(n: number): string {
	return `Reviewed (${plural(n, 'group')})`;
}

// =============================================================================
// OUTLIER REVIEW
// =============================================================================

/** No outlier (the node found none: a handful of points, or all equally dense). */
export const OUTLIERS_NONE = 'No outliers in this sample.';

/** What the review lists. */
export const OUTLIERS_NOTE = "The sample's sparsest points, lowest density first. The store node's lowest 1 % are ringed on the map; a larger share is picked here from the same sample, without drawing it again.";

/**
 * The review's spoken count.
 *
 * @param n - Rows listed.
 * @param pct - The percentile.
 * @param reviewed - Rows whose document was marked reviewed.
 * @returns E.g. "10 points: the lowest 1 % by density · 2 reviewed".
 */
export function outliersStatus(n: number, pct: number, reviewed: number): string {
	return `${plural(n, 'point')}: the lowest ${pct} % by density${reviewed > 0 ? ` · ${num(reviewed)} reviewed` : ''}`;
}

// =============================================================================
// SIMILARITY MATRIX
// =============================================================================

/** A node without the tool. */
export const MATRIX_UNSUPPORTED = 'This store node does not compute a similarity matrix; update the node.';

/** No channel reaches the store node. */
export const MATRIX_NO_CHANNEL = 'No running source reaches the store node, so the matrix cannot be computed.';

/** The call is on its way. */
export const MATRIX_BUSY = 'Computing…';

/**
 * Which rows of the matrix's table are shown.
 *
 * @param from - The first row (from 1).
 * @param to - The last row.
 * @param n - All rows.
 * @returns E.g. "Rows 21–40 of 100".
 */
export function matrixTableRowsLine(from: number, to: number, n: number): string {
	return `Rows ${num(from)}–${num(to)} of ${num(n)}`;
}

/** No pair picked yet. */
export const PICK_A_PAIR = 'Click a cell to pick a pair.';

/**
 * Too few points selected.
 *
 * @param max - The node's matrix_keys_max.
 * @returns The sentence.
 */
export function matrixTooFew(max: number): string {
	return `Select 2 to ${num(max)} points to compare them.`;
}

/**
 * Too many points selected.
 *
 * @param max - The node's matrix_keys_max.
 * @param n - Points selected.
 * @returns The sentence.
 */
export function matrixTooMany(max: number, n: number): string {
	return `Select at most ${num(max)} points for a matrix (${num(n)} selected).`;
}

/**
 * A failed matrix call in words.
 *
 * @param code - The code, if any.
 * @param message - The node's own sentence.
 * @param max - The node's matrix_keys_max.
 * @returns The sentence.
 */
export function matrixFailure(code: string | undefined, message: string, max = 100): string {
	switch (code) {
		case 'NOT_FOUND':
			return 'Fewer than 2 of the selected points are still in the store.';
		case 'LIMIT_EXCEEDED':
			return `Select at most ${num(max)} points for a matrix.`;
		case 'UNSUPPORTED':
			return MATRIX_UNSUPPORTED;
		case 'BUSY':
			return 'The store is busy with another request; try again in a moment.';
		default:
			return mapFailure(code, message);
	}
}

/**
 * Where the matrix's vectors came from.
 *
 * @param source - The answer's `source`.
 * @returns The sentence.
 */
export function matrixSourceLine(source: MatrixSource): string {
	if (source === 'cache') return "Computed by the store node from the map's sample.";
	if (source === 'store') return 'Computed by the store node from the stored vectors.';
	return "Computed by the store node, partly from the map's sample and partly from the stored vectors.";
}

/**
 * What the matrix shows.
 *
 * @param n - Chunks compared.
 * @param metric - The store's metric.
 * @returns The caption.
 */
export function matrixCaption(n: number, metric: VectorMetric): string {
	const words = metric === 'cosine' ? 'cosine similarity' : metric === 'ip' ? 'inner product' : "the store's L2 similarity";
	return `${plural(n, 'chunk')} compared by ${words}; similar chunks are placed next to each other.`;
}

/**
 * The ramp's legend in words.
 *
 * @param min - The lowest value between two chunks.
 * @param max - The highest value between two chunks.
 * @param dp - Decimal places.
 * @returns The legend.
 */
export function matrixLegend(min: number, max: number, dp: number): string {
	return `Lighter: less similar (${min.toFixed(dp)}) · darker: more similar (${max.toFixed(dp)} and above)`;
}

/**
 * Selected keys the store no longer holds.
 *
 * @param labels - Their words.
 * @returns The sentence, or null when there are none.
 */
export function matrixNotFound(labels: readonly string[]): string | null {
	if (labels.length === 0) return null;
	return `${labels.length === 1 ? '1 selected point is' : `${num(labels.length)} selected points are`} no longer in the store: ${labels.join(', ')}`;
}

/**
 * The picked pair.
 *
 * @param a - Its first chunk's words.
 * @param b - Its second chunk's words.
 * @param value - Their similarity, as printed.
 * @returns The line.
 */
export function selectedPairLine(a: string, b: string, value: string): string {
	return `Selected: ${a} ↔ ${b} · similarity ${value}`;
}

// =============================================================================
// CHUNK TEXT
// =============================================================================

/** The text is on its way. */
export const CHUNK_LOADING = "Loading the chunk's text…";

/** Matching is by words; retrieval is not. */
export const CHUNK_LEXICAL = 'Lexical matches only; retrieval is by meaning';

/** No query to mark. */
export const CHUNK_NO_QUERY = 'Run a text query on the map to mark its words here.';

/** None of the query's words is in the chunk. */
export const CHUNK_NO_MATCH = 'No word of the query appears in this chunk.';

/** The chunk is longer than the panel shows. */
export const CHUNK_TRUNCATED = 'Showing the first 20,000 characters of this chunk.';

/**
 * How many words are marked, and which.
 *
 * @param n - Marked words.
 * @param words - The query's words.
 * @returns E.g. "4 matches of the query's words (falcon, station, water)".
 */
export function chunkMatchesLine(n: number, words: readonly string[]): string {
	return `${num(n)} ${n === 1 ? 'match' : 'matches'} of the query's words (${words.join(', ')})`;
}

/**
 * The store has no such chunk.
 *
 * @param chunkId - The chunk asked for.
 * @returns The sentence.
 */
export function chunkMissing(chunkId: number): string {
	return `This document has no chunk ${chunkId} in the store.`;
}
