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

// =============================================================================
// VECTOR - SAMPLE CHUNKS (what the connection drawer shows of the collection)
// =============================================================================
//
// Two reads when a drawer or the Details panel opens: the first document
// the store lists (`list_documents {limit: 1}`) and its first chunks
// (`chunks {limit: 3}`). Only a store that may hold documents is asked.
// The answer is kept per connection in memory until the console writes to the
// store (the documents may have changed) or the identity changes, so closing
// and opening the drawer asks nothing again.
// =============================================================================

import { fetchChunks, fetchDocumentsPage } from '../adapters/actions';
import type { IVectorCaller } from '../adapters/actions';
import { connectionCaches } from '../adapters/explorer';
import type { IDialectResult } from '../contract/types';
import type { IStatsView } from './results';
import { collectionMissing } from './stats';

/** How many chunks are shown. */
export const SAMPLE_CHUNKS = 3;

/** The longest snippet of a chunk shown. */
export const SNIPPET_CHARS = 160;

/** What the drawer shows of the first document. */
export interface ISampleChunks {
	/** The document's path as the store keeps it. */
	path: string;
	objectId: string;
	chunks: Array<{ chunkId: number; snippet: string }>;
}

/** The sample chunks section's state. */
export type SampleState = { status: 'skipped'; reason: string } | { status: 'loading' } | { status: 'empty' } | { status: 'done'; sample: ISampleChunks } | { status: 'error'; message: string };

/**
 * A chunk's text as one short line.
 *
 * @param content - The chunk's text.
 * @returns The text with its whitespace folded, cut to {@link SNIPPET_CHARS} characters.
 */
export function snippetOf(content: string): string {
	const text = content.replace(/\s+/g, ' ').trim();
	return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
}

/**
 * Whether to ask the store for a sample, and if not why not. A missing collection is decided by the rule the stats
 * strip and the card flag use.
 *
 * @param openable - Whether the console can be opened (the card's `openable`).
 * @param dialect - The node's dialect, or null.
 * @param stats - The console's last stats, when it has them.
 * @returns A reason to skip, or null to ask.
 */
export function skipReason(openable: boolean, dialect: IDialectResult | null, stats: IStatsView | null): string | null {
	if (!openable) return 'The store cannot be read now.';
	if (collectionMissing(dialect, stats) || (stats !== null && stats.documents === 0)) return 'The collection has no documents yet.';
	return null;
}

interface ICached {
	/** The console's write count when it was read. */
	writes: number;
	sample: ISampleChunks | null;
}

const cache = new Map<string, ICached>();
/** Bumped whenever the cache is cleared: a read that began before cannot put its answer back. */
let generation = 0;
connectionCaches.register(
	'sample chunks',
	() => {
		generation += 1;
		cache.clear();
	},
	(key) => {
		generation += 1;
		cache.delete(key);
	}
);

/**
 * The kept sample of a connection, when no write has happened since it was read.
 *
 * @param key - The connection key.
 * @param writes - The console's write count now.
 * @returns The kept answer, or undefined.
 */
export function cachedSample(key: string, writes: number): ISampleChunks | null | undefined {
	const kept = cache.get(key);
	if (kept === undefined) return undefined;
	if (kept.writes !== writes) {
		cache.delete(key);
		return undefined;
	}
	return kept.sample;
}

/**
 * Read the first document and its first chunks (two calls), and keep the answer.
 *
 * @param caller - The channel to the store.
 * @param nodeId - The store node.
 * @param key - The connection key.
 * @param writes - The console's write count now.
 * @returns The sample, or null when the store lists no document.
 */
export async function loadSampleChunks(caller: IVectorCaller, nodeId: string, key: string, writes: number): Promise<ISampleChunks | null> {
	const started = generation;
	const page = await fetchDocumentsPage(caller, nodeId, { cursor: null, limit: 1 });
	const first = page.items[0];
	let sample: ISampleChunks | null = null;
	if (first) {
		const chunks = await fetchChunks(caller, nodeId, { objectId: first.objectId, afterChunk: -1, limit: SAMPLE_CHUNKS, deleted: 'active' });
		sample = { path: first.path, objectId: first.objectId, chunks: chunks.items.slice(0, SAMPLE_CHUNKS).map((c) => ({ chunkId: c.chunkId, snippet: snippetOf(c.content) })) };
	}
	// A reset while the two reads ran (a new identity): the answer is for the old one and is not kept.
	if (started === generation) cache.set(key, { writes, sample });
	return sample;
}
