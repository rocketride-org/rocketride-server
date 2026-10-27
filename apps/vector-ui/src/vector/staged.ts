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
// VECTOR - STAGED REMOVALS (pure)
// =============================================================================
//
// Inside a connection's console, "Move to Trash" stages a document instead of
// confirming at once; the pending bar then applies the staged set through the
// controller's one confirmation (requestRemove). The set is the connection's
// `entry.staged` (adapters/connections.ts), keyed by objectId in the order
// the documents were staged. Nothing here sends anything.
//
// Every function returns the SAME set when nothing changed, so a value store
// holding it tells its listeners only about real changes.
// =============================================================================

import type { IRemoveTarget } from './confirm';
import { formatCount } from './stats';

/** The staged documents, by objectId, in the order they were staged. */
export type IStagedSet = ReadonlyMap<string, IRemoveTarget>;

/** Nothing staged. */
export const NO_STAGED: IStagedSet = new Map();

/**
 * Stage documents. A document staged again keeps its place; a chunk count learned since replaces an unknown one.
 *
 * @param set - The staged set.
 * @param targets - The documents to stage.
 * @returns The new set, or `set` itself when nothing changed.
 */
export function stage(set: IStagedSet, targets: readonly IRemoveTarget[]): IStagedSet {
	let next: Map<string, IRemoveTarget> | null = null;
	for (const target of targets) {
		const known = (next ?? set).get(target.objectId);
		if (known !== undefined && (known.chunks !== null || target.chunks === null) && known.path === target.path) continue;
		const merged = known === undefined ? { ...target } : { ...known, path: target.path, chunks: target.chunks ?? known.chunks };
		next ??= new Map(set);
		next.set(target.objectId, merged);
	}
	return next ?? set;
}

/**
 * Take documents out of the staged set.
 *
 * @param set - The staged set.
 * @param objectIds - The documents.
 * @returns The new set, or `set` itself when none of them was staged.
 */
export function unstage(set: IStagedSet, objectIds: Iterable<string>): IStagedSet {
	let next: Map<string, IRemoveTarget> | null = null;
	for (const objectId of objectIds) {
		if (!(next ?? set).has(objectId)) continue;
		next ??= new Map(set);
		next.delete(objectId);
	}
	return next ?? set;
}

/**
 * Drop the staged documents that are gone (another write moved or deleted them, or a complete listing no longer has
 * them).
 *
 * @param set - The staged set.
 * @param isGone - Whether a staged objectId is gone.
 * @returns The new set, or `set` itself when none is gone.
 */
export function dropGone(set: IStagedSet, isGone: (objectId: string) => boolean): IStagedSet {
	return unstage(set, [...set.keys()].filter(isGone));
}

/** What a staged set holds. */
export interface IStagedSummary {
	/** Documents staged. */
	documents: number;
	/** The sum of the chunk counts the store reported for them; null when it reported none of them. */
	chunks: number | null;
	/** Documents staged without a chunk count. */
	unknown: number;
}

/**
 * Count a staged set.
 *
 * @param set - The staged set.
 * @returns Documents, the chunks the store counted for them, and how many have no count.
 */
export function stagedSummary(set: IStagedSet): IStagedSummary {
	let chunks = 0;
	let unknown = 0;
	for (const target of set.values()) {
		if (target.chunks === null) unknown += 1;
		else chunks += target.chunks;
	}
	return { documents: set.size, chunks: set.size > 0 && unknown === set.size ? null : chunks, unknown };
}

/**
 * The staged documents' chunks in words, by the confirmation's rule: a sum only when every count is known (never an
 * estimate), "at least" when some are missing.
 *
 * @param summary - The staged set's summary.
 * @returns e.g. '14 chunks', 'at least 14 chunks; 2 documents not counted', 'chunk counts not reported'.
 */
export function stagedChunksWords(summary: IStagedSummary): string {
	const chunks = summary.chunks;
	if (chunks === null) return 'chunk counts not reported';
	if (summary.unknown === 0) return `${formatCount(chunks)} ${chunks === 1 ? 'chunk' : 'chunks'}`;
	return `at least ${formatCount(chunks)} ${chunks === 1 ? 'chunk' : 'chunks'}; ${formatCount(summary.unknown)} ${summary.unknown === 1 ? 'document' : 'documents'} not counted`;
}

/**
 * The pending bar's sentence.
 *
 * @param summary - The staged set's summary.
 * @returns e.g. '3 documents staged to move to the trash (14 chunks).', or '' with nothing staged.
 */
export function pendingText(summary: IStagedSummary): string {
	const n = summary.documents;
	if (n === 0) return '';
	return `${formatCount(n)} ${n === 1 ? 'document' : 'documents'} staged to move to the trash (${stagedChunksWords(summary)}).`;
}

/**
 * The pending bar's one-line sentence (its full text, pendingText, is its title): the documents and, where every
 * count is known, the chunks; "N+" where some are not counted (at least N).
 *
 * @param summary - The staged set's summary.
 * @returns e.g. '3 staged for the trash (14 chunks)', '3 staged for the trash (14+ chunks)', or '' with nothing staged.
 */
export function pendingShortText(summary: IStagedSummary): string {
	const n = summary.documents;
	if (n === 0) return '';
	const chunks = summary.chunks === null ? '' : ` (${formatCount(summary.chunks)}${summary.unknown > 0 ? '+' : ''} ${summary.chunks === 1 && summary.unknown === 0 ? 'chunk' : 'chunks'})`;
	return `${formatCount(n)} staged for the trash${chunks}`;
}
