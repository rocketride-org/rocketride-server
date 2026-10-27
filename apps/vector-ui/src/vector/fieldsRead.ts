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
// VECTOR - READ FIELDS FROM A SAMPLE (the Collection tab's button)
// =============================================================================
//
// No tool lists a collection's fields, so this reads `chunks` of a few
// documents on purpose: the first CHUNKS_PER_DOCUMENT chunks of up to
// SAMPLE_DOCUMENTS documents spread over the loaded folders, at most
// SAMPLE_DOCUMENTS calls, one after the other. What it finds is an estimate
// over those chunks only.
// =============================================================================

import type { IChunkItem, IDocumentItem } from '../contract/types';
import { fetchChunks } from '../adapters/actions';
import type { IVectorCaller } from '../adapters/actions';
import { chunkFields, documentFields, mergeFields, sampleDocuments } from './fields';
import type { IFieldsEstimate } from './fields';

/** How many documents a sample reads chunks of (and so the most calls it sends). */
export const SAMPLE_DOCUMENTS = 5;

/** How many chunks are read from each document. */
export const CHUNKS_PER_DOCUMENT = 20;

/**
 * Read the chunk fields from a sample of the loaded documents.
 *
 * @param caller - The channel to the store.
 * @param nodeId - The store node.
 * @param rows - The loaded documents.
 * @param writes - The connection's write count now (kept with the estimate).
 * @param documents - The store's document count now, when stats have one (kept with the estimate).
 * @returns The estimate (document fields over `rows`, chunk fields over the chunks read).
 * @throws The first failed read's error: nothing is kept from a sample that did not finish.
 */
export async function readFieldsSample(caller: IVectorCaller, nodeId: string, rows: readonly IDocumentItem[], writes = 0, documents: number | null = null): Promise<IFieldsEstimate> {
	const picked = sampleDocuments(rows, SAMPLE_DOCUMENTS);
	const chunks: IChunkItem[] = [];
	let read = 0;
	for (const row of picked) {
		try {
			const page = await fetchChunks(caller, nodeId, { objectId: row.objectId, afterChunk: -1, limit: CHUNKS_PER_DOCUMENT, deleted: 'active' });
			chunks.push(...page.items);
			read += 1;
		} catch (error) {
			// A document trashed or removed since the listing is skipped; any other failure ends the sample.
			const code = (error as { code?: string } | null)?.code;
			if (code !== 'IN_TRASH' && code !== 'NOT_FOUND') throw error;
		}
	}
	return { rows: mergeFields(documentFields(rows), chunkFields(chunks)), chunksRead: chunks.length, documentsRead: read, at: Date.now(), writes, documents };
}
