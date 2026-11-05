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
// VECTOR - WORDING (pure): one sentence per code, per caveat, per busy state
// =============================================================================
//
// Plain, specific sentences in the voice of SQL and Graph Explorer. Badges and
// chips carry the whole message (colour never does alone), the app never
// claims a count the node did not return, and a refused write says WHICH rule
// refused it. tests/vector.wording.test.ts pins that every documented code
// and caveat has a sentence here.
// =============================================================================

import { ExplorerToolError, splitMessage } from 'shared/explorer';
import type { Caveat, ToolCode } from '../contract/types';

// =============================================================================
// CODES
// =============================================================================

/** What every refusal the app cannot name more precisely says. */
export const GENERIC_REFUSAL = "The store refused this request; see the pipeline's run log.";

/** The write refusals: the sentence is the whole message (the node's own text adds nothing). */
const WRITE_CODES: ReadonlySet<string> = new Set(['WRITES_DISABLED', 'WRITES_SOURCE', 'WRITES_PUBLIC', 'WRITES_BROADCAST', 'WRITES_UNKNOWN_CALLER', 'RESERVED_ID']);

/** One sentence per documented code. */
export const CODE_SENTENCES: Readonly<Record<ToolCode, string>> = {
	INVALID_INPUT: 'The store node did not accept the input of this request.',
	UNSUPPORTED: 'This store cannot do that.',
	NOT_FOUND: 'That document is not stored in this collection.',
	IN_TRASH: 'This document is in the trash. Restore it to read it.',
	RESERVED_ID: "That record is the collection's control record and cannot be removed.",
	COLLECTION_MISSING: 'The collection does not exist yet; add a document to create it.',
	STORE_ERROR: 'The store answered with an error.',
	DIMENSION_MISMATCH: "The vector's length does not match this collection's dimension.",
	MODEL_MISMATCH: 'The vector was made with another embedding model than this collection.',
	NO_EMBEDDER: 'No embedding node is bound to this store, so a text query cannot be embedded.',
	LIMIT_EXCEEDED: 'That is more than this store node allows in one call.',
	SAMPLE_EXPIRED: 'The node no longer holds this sample; draw it again.',
	BUSY: 'Another sample or projection is running on this store; try again when it ends.',
	TIMEOUT: 'The store did not finish within its time budget.',
	RATE_LIMITED: 'Too many embedding calls on this pipeline; try again shortly.',
	WRITES_DISABLED: 'Removing documents is turned off on this store node (allow_writes).',
	WRITES_SOURCE: 'Only a Tools source may remove documents.',
	WRITES_PUBLIC: GENERIC_REFUSAL,
	WRITES_BROADCAST: GENERIC_REFUSAL,
	WRITES_UNKNOWN_CALLER: 'The engine did not identify this request, so the store refused the write. Update the engine to a version that supports the Vector Explorer.',
	// The app signs in with an account, never with a task's public key, so it does not meet this one.
	READS_PUBLIC: GENERIC_REFUSAL,
};

/**
 * The sentence for a code.
 *
 * @param code - A code from a failure envelope (or anything else).
 * @returns Its sentence; an unknown or missing code reads as the generic refusal.
 */
export function codeSentence(code: string | undefined): string {
	return code !== undefined && Object.prototype.hasOwnProperty.call(CODE_SENTENCES, code) ? CODE_SENTENCES[code as ToolCode] : GENERIC_REFUSAL;
}

// =============================================================================
// CAVEATS
// =============================================================================

/** One sentence per documented caveat. */
export const CAVEAT_SENTENCES: Readonly<Record<Caveat, string>> = {
	brute_force_search: 'This store searches by brute force (exact); large collections answer slowly.',
	no_filtered_count: 'This store cannot count with a filter, so some figures are not shown.',
	biased_sample: 'This sample is not uniform: some documents are over-represented.',
	score_scale_raw: "Scores are the backend's raw values, not 0–1.",
	score_scale_inverted_fixed: 'Scores on this store were inverted before this release; they now rise with similarity.',
	shared_org_table: 'Shared table: every pipeline in this organization that names this table reads and writes these rows.',
	experimental: 'Experimental: this store was checked against stand-ins only in this build.',
	cloud_only_unverified: 'This backend was not run against a live server in this build.',
	extras_not_stored: 'This backend does not keep file size or ingest time.',
	documents_by_first_chunk: 'Documents are counted by their first chunk on this store.',
	document_count_capped: 'Orphan counts above 1,000 are not exact on this store.',
	documents_unsorted: 'This store lists documents in storage order; the directory sorts what is loaded.',
	documents_paging_unsupported: 'This store cannot page its document list; only the first page is shown.',
	model_mismatch: 'The chat embedding model differs from the one this collection was built with; results may be meaningless.',
	meta_column_pending: 'File size and ingest time are not stored yet: another session holds this table; the store will retry.',
	filtered_search_may_underfill: 'A search limited to some documents may return fewer results than asked: this pgvector is older than 0.8.',
	listing_truncated: "Sampled from part of the collection: the store's document listing stopped before its end.",
	documents_filter_partial: 'The store applied some of these conditions; the rest are filtered here, over the documents loaded.',
	documents_filter_client: 'This store cannot filter its documents by these conditions; they are filtered here, over the documents loaded.',
	trash_scan_cut: 'The trash is large, so only part of it was read: a document moved to the trash during its upload may be missing from this list.',
};

/**
 * The sentence for a caveat.
 *
 * @param caveat - A caveat a tool answered with.
 * @returns Its sentence, or null for a caveat this build does not know (never an invented one).
 */
export function caveatSentence(caveat: string): string | null {
	return Object.prototype.hasOwnProperty.call(CAVEAT_SENTENCES, caveat) ? CAVEAT_SENTENCES[caveat as Caveat] : null;
}

// =============================================================================
// FAILURES
// =============================================================================

/** What a failed write the app stopped waiting for says (nothing cancels it on the server). */
export const WRITE_TIMEOUT_TEXT = 'The request may still complete on the server. Refresh to check.';

/** What a cancelled confirmation says. */
export const CANCELLED_TEXT = 'Cancelled. Nothing was sent.';

/** Under the directory when a page brought no document that was not already listed (the listing stops there). */
export const DOCUMENTS_REPEATED_TEXT = 'The store sent documents it had already listed instead of the next page, so the directory stopped asking.';

/** Server codes that mean the task is not running (yet). */
const NOT_RUNNING_CODES: ReadonlySet<string> = new Set(['TASK_STOPPED', 'TASK_NOT_REGISTERED', 'TASK_COMPLETED']);

/** A failure as the console shows it: a headline and, when there is more to say, a detail. */
export interface IFailureText {
	headline: string;
	detail?: string;
}

/**
 * What a failed call says on screen.
 *
 * @param error - Whatever the call rejected with.
 * @param ctx - `write: true` for delete / soft_delete / restore / upsert.
 * @returns The text, or null for a dropped (stale) result, which is never shown.
 */
export function failureText(error: unknown, ctx: { write?: boolean } = {}): IFailureText | null {
	if (error instanceof ExplorerToolError) {
		switch (error.kind) {
			case 'stale':
				return null;
			case 'store': {
				const sentence = codeSentence(error.code);
				if (error.code === undefined || WRITE_CODES.has(error.code) || !Object.prototype.hasOwnProperty.call(CODE_SENTENCES, error.code)) {
					// A legacy failure (no code) still has the node's own words, which say more than the generic sentence.
					if (error.code === undefined && error.message.trim() !== '') return { headline: error.headline, ...(error.detail ? { detail: error.detail } : {}) };
					return { headline: sentence };
				}
				const own = error.message.trim();
				return own === '' || own === sentence ? { headline: sentence } : { headline: sentence, detail: own };
			}
			case 'timeout':
				return ctx.write ? { headline: WRITE_TIMEOUT_TEXT } : { headline: error.headline, ...(error.detail ? { detail: error.detail } : {}) };
			case 'upgrade':
				return { headline: `This store node cannot run ${error.tool}. Update the pipeline's store node to a version that supports Vector Explorer.` };
			case 'raised':
				if (error.code !== undefined && NOT_RUNNING_CODES.has(error.code)) {
					return { headline: 'The pipeline is not running (it may be restarting). Refresh when it runs again.' };
				}
				return { headline: error.headline, ...(error.detail ? { detail: error.detail } : {}) };
			case 'malformed':
				return { headline: 'The store node answered in a form this app does not read.', detail: error.message };
			default:
				return { headline: error.headline, ...(error.detail ? { detail: error.detail } : {}) };
		}
	}
	const { headline, detail } = splitMessage(error instanceof Error ? error.message : String(error));
	return detail === undefined ? { headline } : { headline, detail };
}

// =============================================================================
// BUSY STATES AND EMPTY STATES
// =============================================================================

/** What a busy button says. */
export const BUSY = {
	refreshing: 'Refreshing…',
	sampling: 'Sampling…',
	embedding: 'Embedding…',
	removing: 'Removing…',
	restoring: 'Restoring…',
	listingTrash: 'Listing the trash…',
	uploading: 'Uploading…',
	layingOut: 'Laying out…',
	loadingDocuments: 'Loading documents…',
} as const;

/** The console's empty states. */
export const EMPTY = {
	noDocuments: 'No documents yet. Drop a file on the right to add the first one.',
	trash: 'The trash is empty.',
	noMatch: (filter: string): string => `No documents match '${filter}'`,
	unreachable: (detail: string): string => `Store unreachable: ${detail}`,
	noIngest: 'This pipeline has no running Ingest source. Start its dropper source to add documents.',
	noChat: 'This pipeline has no running Chat source.',
	readOnly: 'No Tools source: documents cannot be added or removed from here',
	noEmbed: 'Text queries need the embedding node reachable from the Tools source',
} as const;
