// MIT License
//
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
// KNOWLEDGE — what the Knowledge screen asks the engine
// =============================================================================
//
// Three engine calls, all through pipes the eval loop already runs, so this
// screen adds no pipeline of its own:
//
// SEARCH BY MEANING is `eval-retrieve.pipe`, the same retrieval the grader and
// the Teach Ralph landing check use: the text goes in, up to 25 chunks come
// back, each with `metadata.objectId` and a `score` that is a Chroma DISTANCE
// (lower is closer). The chunks are grouped by document here, and a document's
// distance is its closest chunk's.
//
// CHUNKS are the same task's `chroma` component, asked through its `get` tool
// (`client.tool`) with the document's objectId. The `search` tool would need an
// embedding bound to the node, which the retrieve pipe does not give it; `get`
// filters on objectId alone and needs none.
//
// ADD is `eval-kb-writeback.pipe`, exactly as Teach Ralph sends: one document
// under a stable name, its objectId read back from `send`, and the task
// terminated afterwards. It queues on Teach Ralph's own chain, because the two
// share that task.
//
// The retrieve task is never terminated here: it is shared with the grader by
// task identity, and its ttl reclaims it (see `src/eval/teach.ts`).
// =============================================================================

import type { RocketRideClient } from 'shell';
import { EVAL_PIPES, EVAL_TASK_TTL_SECONDS, evalPipelineOf, type EvalPipe } from '../eval/pipes';
import { retrievedDocuments } from '../eval/grader';
import { serializeKbWrite } from '../eval/teach';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Longest text a meaning search sends — the retrieval pipe's own clip. */
export const SEARCH_TEXT_LIMIT = 4000;

/** How many chunks one `get` call asks for; the tool's own default page. */
const CHUNK_PAGE = 100;

/** Safety stop for the chunk pager: no document here comes near it. */
const CHUNK_PAGE_LIMIT = 50;

/** Longest slug in an uploaded document's name. */
const SLUG_LIMIT = 60;

/** How long one chunk read may take (ms). */
const TOOL_TIMEOUT_MS = 30_000;

/** The file types "Add document" accepts, with the mimetype each is sent as. */
export const UPLOAD_TYPES: Record<string, string> = {
	md: 'text/markdown',
	txt: 'text/plain',
	pdf: 'application/pdf',
};

// =============================================================================
// TYPES
// =============================================================================

/** One document a meaning search found, with its closest chunk. */
export interface MeaningHit {
	/** The document's objectId — the join key to the catalog. */
	objectId: string;
	/** The name the chunk carries as its `parent`, for a document the catalog lacks. */
	parent: string;
	/** The closest chunk's distance. Lower is closer. */
	distance: number;
	/** The closest chunk's text. */
	snippet: string;
	/** How many of the returned chunks belong to this document. */
	chunks: number;
}

/** One stored chunk of a document. */
export interface KbChunk {
	/** Its place in the document, from 0. */
	chunkId: number;
	/** Its text, as embedded. */
	text: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Start an eval pipe, or attach to the task a previous run left warm. */
async function startEvalPipe(client: RocketRideClient, pipe: EvalPipe): Promise<string> {
	const result = await client.use({
		pipeline: evalPipelineOf(pipe),
		source: pipe.source,
		useExisting: true,
		ttl: EVAL_TASK_TTL_SECONDS,
		name: `Discord Dashboard ${pipe.label}`,
	});
	return result.token;
}

/**
 * The id of the retrieve pipe's `chroma` component — the node the chunk read
 * is addressed to.
 */
function chromaNodeId(): string {
	const components = (EVAL_PIPES.retrieve.pipeline.components ?? []) as Record<string, unknown>[];
	const store = components.find((component) => component.provider === 'chroma');
	return String(store?.id ?? '');
}

/** A unique object name for one search. */
let searchSeq = 0;
function searchName(): string {
	searchSeq += 1;
	return `kbsearch-${Date.now()}-${searchSeq}.txt`;
}

/**
 * Close or further, in words, the way the eval rules read a distance.
 *
 * At or below `matchDistance` (`settings.eval.matchDistance`) the knowledge
 * base counts as holding the answer — `analyzeRetrievalDistance` in
 * `src/eval/rules.ts` — so that is "closer"; above it is "further".
 *
 * @param distance - A chunk's Chroma distance.
 * @param matchDistance - The eval threshold.
 * @returns Which side of the threshold it is on.
 */
export function closenessOf(distance: number, matchDistance: number): 'closer' | 'further' {
	return distance <= matchDistance ? 'closer' : 'further';
}

/**
 * A title as a name fragment: lower case, letters and digits, dashes between.
 *
 * @param title - What the uploader typed, or the file's name.
 * @returns The slug, or `document` when nothing usable is left.
 */
export function slugOf(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SLUG_LIMIT)
		.replace(/-+$/g, '');
	return slug.length > 0 ? slug : 'document';
}

/**
 * The name an added document is sent under: `upload-<slug>.<ext>`.
 *
 * The knowledge base derives a document's objectId from its name, so adding a
 * second document with the same title REPLACES the first, in the collection
 * and in the catalog alike.
 *
 * @param title - The document's title.
 * @param ext - `md`, `txt` or `pdf`.
 * @returns The name.
 */
export function uploadName(title: string, ext: string): string {
	return `upload-${slugOf(title)}.${ext}`;
}

/**
 * Group retrieved chunks by document, closest document first.
 *
 * @param documents - What the retrieve pipe returned.
 * @returns One hit per objectId, with its closest chunk.
 */
export function groupHits(documents: ReturnType<typeof retrievedDocuments>): MeaningHit[] {
	const byId = new Map<string, MeaningHit>();
	for (const document of documents) {
		const objectId = String(document.metadata?.objectId ?? '');
		const distance = document.score;
		if (objectId.length === 0 || typeof distance !== 'number' || !Number.isFinite(distance)) continue;
		const text = typeof document.page_content === 'string' ? document.page_content : typeof document.text === 'string' ? document.text : '';
		const parent = typeof document.metadata?.parent === 'string' ? document.metadata.parent : '';
		const known = byId.get(objectId);
		if (known === undefined) {
			byId.set(objectId, { objectId, parent, distance, snippet: text, chunks: 1 });
		} else {
			known.chunks += 1;
			if (distance < known.distance) {
				known.distance = distance;
				known.snippet = text;
			}
		}
	}
	return [...byId.values()].sort((a, b) => a.distance - b.distance);
}

// =============================================================================
// API
// =============================================================================

/**
 * Search the knowledge base by meaning.
 *
 * @param client - The shell's connected client.
 * @param text - What to look for.
 * @returns The documents found, closest first.
 */
export async function searchByMeaning(client: RocketRideClient, text: string): Promise<MeaningHit[]> {
	const token = await startEvalPipe(client, EVAL_PIPES.retrieve);
	const result = await client.send(token, text.slice(0, SEARCH_TEXT_LIMIT), { name: searchName() }, 'text/plain');
	return groupHits(retrievedDocuments(result));
}

/**
 * Every stored chunk of one document, in order.
 *
 * @param client - The shell's connected client.
 * @param objectId - The document.
 * @returns Its chunks, by `chunkId`.
 */
export async function loadChunks(client: RocketRideClient, objectId: string): Promise<KbChunk[]> {
	const token = await startEvalPipe(client, EVAL_PIPES.retrieve);
	const nodeId = chromaNodeId();
	const out: KbChunk[] = [];
	for (let page = 0; page < CHUNK_PAGE_LIMIT; page += 1) {
		const result = await client.tool<{ success?: boolean; error?: string; chunks?: { content?: unknown; chunkId?: unknown }[] }>({
			token,
			tool: 'get',
			nodeId,
			input: { object_id: objectId, offset: page * CHUNK_PAGE, limit: CHUNK_PAGE },
			timeout: TOOL_TIMEOUT_MS,
		});
		if (result?.success === false) throw new Error(result.error ?? 'The knowledge base would not return the chunks.');
		const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
		for (const chunk of chunks) {
			out.push({
				chunkId: typeof chunk.chunkId === 'number' ? chunk.chunkId : Number(chunk.chunkId ?? 0) || 0,
				text: typeof chunk.content === 'string' ? chunk.content : '',
			});
		}
		if (chunks.length < CHUNK_PAGE) break;
	}
	return out.sort((a, b) => a.chunkId - b.chunkId);
}

/**
 * Send one document into the knowledge base, as Teach Ralph does.
 *
 * @param client - The shell's connected client.
 * @param name - The stable name — see {@link uploadName}.
 * @param data - The text, or a file's bytes.
 * @param mimetype - How the parser should read it.
 * @returns The objectId the knowledge base gave it.
 */
export function addToKnowledgeBase(client: RocketRideClient, name: string, data: string | Uint8Array, mimetype: string): Promise<string> {
	return serializeKbWrite(async () => {
		const token = await startEvalPipe(client, EVAL_PIPES.kbWriteback);
		try {
			const sent = await client.send(token, data, { name }, mimetype);
			const objectId = typeof sent?.objectId === 'string' ? sent.objectId : '';
			if (objectId.length === 0) throw new Error('The knowledge base did not return an id for the document.');
			return objectId;
		} finally {
			// Best effort, as Teach Ralph's: a task the engine already reclaimed
			// must not turn a document that was sent into a failed add.
			await client.terminate(token).catch(() => undefined);
		}
	});
}
