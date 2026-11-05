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
// ADAPTER - TYPED TOOL CALLS (pure: a session or a role channel goes in)
// =============================================================================
//
// Every call names its node (the store node, or the embedding node for
// `embed`) and unwraps the answer: a success comes back read by
// vector/results.ts, a failure envelope rejects as an ExplorerToolError of
// kind `store` that keeps its code. Writes go through the batch calls below
// (`trashBatch`, `restoreBatch`, `deleteBatch`), once per batch, never retried
// (the tool table marks them so).
// =============================================================================

import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerClient, IExplorerEndpoint, IEndpointStore, IInvokeOptions } from 'shared/explorer';
import type { IDocumentsFilter, IEmbedResult, INeighborsScopeResult, VectorChannels, VectorKey } from '../contract/types';
import { heatScores } from '../vector/heat';
import type { IHeatScore } from '../vector/heat';
import { readChunksPage, readDeleteResult, readDocumentsPage, readStats, readTrashResult, unwrapEnvelope } from '../vector/results';
import type { IChunksPageView, IDocumentsPageView, IRemoveView, IStatsView, ITrashView } from '../vector/results';
import { TOOL } from './explorer';

/** What can call a tool: a session (the anchor token) or a role channel. */
export interface IVectorCaller {
	invoke<T = unknown>(tool: string, input?: Record<string, unknown>, opts?: IInvokeOptions): Promise<T>;
}

/**
 * Call one tool on one node and unwrap its answer.
 *
 * @param caller - A session or a role channel.
 * @param nodeId - The node (always named; a role channel requires it).
 * @param tool - The tool.
 * @param input - Its input.
 * @param opts - Per-call options (generation ticket, timeout).
 * @returns The success answer.
 */
export async function callVector<T = Record<string, unknown>>(caller: IVectorCaller, nodeId: string, tool: string, input: Record<string, unknown> = {}, opts: IInvokeOptions = {}): Promise<T> {
	const value = await caller.invoke<unknown>(tool, input, { ...opts, nodeId });
	return unwrapEnvelope<T>(tool, value);
}

/**
 * `stats` in full or quick mode.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param mode - 'full' recomputes the counts; 'quick' answers the cached ones.
 * @param opts - Per-call options.
 * @returns The figures.
 */
export async function fetchStats(caller: IVectorCaller, nodeId: string, mode: 'full' | 'quick', opts: IInvokeOptions = {}): Promise<IStatsView> {
	return readStats(await callVector(caller, nodeId, TOOL.stats, { mode }, opts));
}

/**
 * One page of `list_documents` (path order), optionally filtered: the active documents, or the trash.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param page - The cursor (null for the first page) and the page size.
 * @param opts - Per-call options.
 * @param filter - The directory's conditions (contract section 4.4-A), sent only when given; the answer says
 *   how much of it the store applied (`filterApplied`), and an older node ignores it.
 * @param deleted - 'active' (the default) or 'deleted': the documents with a chunk in the trash.
 * @returns The page.
 */
export async function fetchDocumentsPage(caller: IVectorCaller, nodeId: string, page: { cursor: string | null; limit: number }, opts: IInvokeOptions = {}, filter?: IDocumentsFilter | null, deleted: 'active' | 'deleted' = 'active'): Promise<IDocumentsPageView> {
	const input: Record<string, unknown> = { cursor: page.cursor, limit: page.limit, deleted, sort: 'path' };
	if (filter) input.filter = { ...filter };
	return readDocumentsPage(await callVector(caller, nodeId, TOOL.listDocuments, input, opts));
}

/**
 * One page of a document's chunks, in reading order.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param page - The objectId, the last chunk id already listed (-1 for the start), the page size and which rows.
 * @param opts - Per-call options.
 * @returns The page.
 */
export async function fetchChunks(caller: IVectorCaller, nodeId: string, page: { objectId: string; afterChunk: number; limit: number; deleted?: 'active' | 'all' }, opts: IInvokeOptions = {}): Promise<IChunksPageView> {
	return readChunksPage(await callVector(caller, nodeId, TOOL.chunks, { object_id: page.objectId, after_chunk: page.afterChunk, limit: page.limit, deleted: page.deleted ?? 'active' }, opts));
}

/**
 * The existence probe: whether a document is stored and, when the store
 * counted them, how many chunks it has.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param objectId - The objectId.
 * @returns `{ chunks }` when stored (`chunks` null when the store gave no total and has more than the one chunk asked for), or null for NOT_FOUND.
 */
export async function chunkCount(caller: IVectorCaller, nodeId: string, objectId: string): Promise<{ chunks: number | null } | null> {
	try {
		const page = readChunksPage(await callVector(caller, nodeId, TOOL.chunks, { object_id: objectId, limit: 1 }));
		return { chunks: page.total ?? (page.hasMore ? null : page.items.length) };
	} catch (error) {
		if (error instanceof Error && (error as { code?: string }).code === 'NOT_FOUND') return null;
		throw error;
	}
}

/**
 * Delete one batch of documents permanently (`delete`, the gated write). Sent once; never retried.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param objectIds - At most write_ids_max objectIds.
 * @param opts - `deletedOnly`: remove a document only when every chunk of it is in the trash (Empty trash).
 * @returns What the node removed, and what it kept because a chunk of it is live.
 */
export async function deleteBatch(caller: IVectorCaller, nodeId: string, objectIds: readonly string[], opts: { deletedOnly?: boolean } = {}): Promise<IRemoveView> {
	const input: Record<string, unknown> = { object_ids: [...objectIds] };
	if (opts.deletedOnly) input.deleted_only = true;
	return readDeleteResult(await callVector(caller, nodeId, TOOL.delete, input, { idempotent: false }), objectIds);
}

/**
 * Move one batch of documents to the trash (`soft_delete`). Sent once; never retried.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param objectIds - At most write_ids_max objectIds.
 * @returns What it moved.
 */
export async function trashBatch(caller: IVectorCaller, nodeId: string, objectIds: readonly string[]): Promise<ITrashView> {
	return readTrashResult(await callVector(caller, nodeId, TOOL.softDelete, { object_ids: [...objectIds] }, { idempotent: false }));
}

/**
 * Restore one batch of documents from the trash (`restore`). Sent once; never retried.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param objectIds - At most write_ids_max objectIds.
 * @returns What it moved back.
 */
export async function restoreBatch(caller: IVectorCaller, nodeId: string, objectIds: readonly string[]): Promise<ITrashView> {
	return readTrashResult(await callVector(caller, nodeId, TOOL.restore, { object_ids: [...objectIds] }, { idempotent: false }));
}

/**
 * Embed query texts on the embedding node of the same task.
 *
 * @param caller - A session (anchor token) or a channel that reaches the embedding node.
 * @param embedNodeId - The embedding node (embed_1).
 * @param texts - 1 to 8 texts.
 * @returns The vectors.
 */
export async function embedTexts(caller: IVectorCaller, embedNodeId: string, texts: readonly string[]): Promise<IEmbedResult> {
	return callVector<IEmbedResult>(caller, embedNodeId, TOOL.embed, { texts: [...texts], kind: 'query' });
}

/** How long `scoreChunks` waits before asking a busy store again: one wait per retry. */
const BUSY_RETRY_MS = [400, 1000, 2500];

/**
 * Score chunks against a query text: embed it on the embedding node, then send
 * that exact vector to the store's `neighbors` with the keys as `scope_keys`.
 * The vector is used for this one call and not kept. A store runs one
 * neighbour search at a time and refuses another with BUSY (the map may be
 * asking at the same moment), so a BUSY is asked again after a short wait, a
 * few times, with the same vector.
 *
 * @param store - The store node and a caller that reaches it.
 * @param embed - The embedding node and a caller that reaches it.
 * @param keys - The chunk keys of one document (at most `limits.scope_keys_max`).
 * @param query - The query text.
 * @param opts - `wait` (tests replace the timer).
 * @returns The chunks that have a similarity (none for an empty `keys`, without a call).
 */
export async function scoreChunks(store: { caller: IVectorCaller; nodeId: string }, embed: { caller: IVectorCaller; nodeId: string }, keys: readonly VectorKey[], query: string, opts: { wait?: (ms: number) => Promise<void> } = {}): Promise<IHeatScore[]> {
	if (keys.length === 0) return [];
	const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const embedded = await embedTexts(embed.caller, embed.nodeId, [query]);
	const vector = Array.isArray(embedded.vectors) ? embedded.vectors[0] : undefined;
	if (!Array.isArray(vector) || vector.length === 0) throw new ExplorerToolError({ kind: 'malformed', tool: TOOL.embed, message: 'The embedding node answered without a vector.' });
	const input = { vector, scope_keys: keys.map((key) => [...key]) };
	for (let attempt = 0; ; attempt += 1) {
		try {
			const answer = await callVector<INeighborsScopeResult>(store.caller, store.nodeId, TOOL.neighbors, input);
			return heatScores(
				keys.map((key) => key[1]),
				Array.isArray(answer.scores) ? answer.scores : []
			);
		} catch (error) {
			const delay = BUSY_RETRY_MS[attempt];
			if (!(error instanceof ExplorerToolError && error.code === 'BUSY') || delay === undefined) throw error;
			await wait(delay);
		}
	}
}

/**
 * The role channels of a connection: null for a role whose source is not running.
 *
 * @param store - The endpoint store.
 * @param client - The client.
 * @param endpoint - The connection.
 * @returns The channels.
 */
export function vectorChannels(store: Pick<IEndpointStore, 'channel'>, client: IExplorerClient, endpoint: IExplorerEndpoint): VectorChannels {
	const bound = (role: string) => (endpoint.roles[role] ? store.channel(client, endpoint, role) : null);
	return { tools: bound('tools'), chat: bound('chat'), ingest: bound('ingest') };
}

/**
 * One document's directory row (`list_documents` with `object_ids`), or null when it is not stored.
 *
 * @param caller - A session or channel.
 * @param nodeId - The store node.
 * @param objectId - The objectId.
 * @returns The row, or null.
 */
export async function fetchDocument(caller: IVectorCaller, nodeId: string, objectId: string): Promise<IDocumentsPageView['items'][number] | null> {
	const page = readDocumentsPage(await callVector(caller, nodeId, TOOL.listDocuments, { cursor: null, limit: 1, object_ids: [objectId], deleted: 'all', sort: 'path' }));
	return page.items.find((item) => item.objectId === objectId) ?? null;
}
