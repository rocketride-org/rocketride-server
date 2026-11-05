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
// VECTOR-UI — RETRIEVAL ("Why these?")
// =============================================================================
//
// Explains an answer's sources. The debugger:
//
//   1. embeds the question on the pipeline's embedding node (`embed`, through
//      the Tools source) — the one vector the console ever sends is the exact
//      vector this call returned;
//   2. searches the store with it for k + 10 rows, asking for the rows below
//      the node's threshold and below the driver's floor too, within the
//      documents the question was asked about when the chat was scoped;
//   3. lays the rows out against the threshold and floor: "used" rows are what
//      the chat pipeline's store would pass on, "near misses" fell under the
//      threshold, the rest fell under the floor.
//
// Pure: builds inputs and reads answers; the RetrievalDebugger component does
// the calls.
// =============================================================================

import type { IChatSource, IEmbedInput, IScoreInfo, ISearchInput, ISearchItem, ISearchResult, IVectorLimits, VectorKey } from '../contract/types';

/** How many rows past the answer's k the debugger asks for. */
export const DEBUGGER_EXTRA = 10;

/** Bins of the score histogram. */
export const HISTOGRAM_BINS = 100;

/** k when the answer cited nothing. */
const DEFAULT_TOP_K = 10;

/** The node's documented maximum for `top_k`, when no dialect says otherwise. */
const TOP_K_MAX = 100;

/** Longest text `embed` accepts. */
const EMBED_TEXT_MAX = 8_000;

/** Characters of a row's content kept for display. */
const PREVIEW_CHARS = 280;

/** Shown when the search reports a model mismatch. */
export const MODEL_MISMATCH_SENTENCE = 'The chat embedding model differs from the one this collection was built with; results may be meaningless.';

/** Where a row falls. */
export type RetrievalStatus = 'used' | 'near_miss' | 'below_floor';

/** One row of the debugger. */
export interface RetrievalRow {
	rank: number;
	key: VectorKey;
	objectId: string;
	chunkId: number;
	path: string;
	/** The driver's score (see dialect.score). */
	score: number | null;
	rawScore: number | null;
	sim: number | null;
	status: RetrievalStatus;
	/** True when the answer cited this chunk. */
	inAnswer: boolean;
	preview: string;
}

/** The debugger's view of one search. */
export interface RetrievalView {
	rows: RetrievalRow[];
	threshold: number | null;
	floor: number | null;
	counts: { used: number; nearMisses: number; belowFloor: number };
	/** "threshold 0.30 · 2 near misses hidden · 6 below the floor". */
	summary: string;
	modelMismatch: boolean;
	modelMismatchSentence: string | null;
	keywordFallback: boolean;
}

/**
 * The `embed` input for a question.
 *
 * @param question - The question.
 * @returns One query text, trimmed and capped.
 */
export function embedInput(question: string): IEmbedInput {
	return { texts: [question.trim().slice(0, EMBED_TEXT_MAX)], kind: 'query' };
}

/**
 * How many rows the debugger asks for: the answer's k plus {@link DEBUGGER_EXTRA}, within the node's limit.
 * "Open in Search" hands this k to Search, so its first run lists the same rows.
 *
 * @param topK - The answer's k.
 * @param limits - The node's limits, or null.
 * @returns k.
 */
export function debuggerTopK(topK: number, limits: Pick<IVectorLimits, 'top_k_max'> | null): number {
	const max = limits?.top_k_max ?? TOP_K_MAX;
	const k = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : DEFAULT_TOP_K - DEBUGGER_EXTRA;
	return Math.max(1, Math.min(max, k + DEBUGGER_EXTRA));
}

/**
 * The `search` input of the debugger.
 *
 * @param vector - Exactly the vector `embed` returned for the question.
 * @param embeddingModel - The model `embed` reported (lets the store warn on a mismatch), or null.
 * @param topK - The answer's k.
 * @param limits - The node's limits, or null.
 * @returns The input.
 */
export function debuggerSearchInput(vector: number[], embeddingModel: string | null, topK: number, limits: IVectorLimits | null): ISearchInput {
	const input: ISearchInput = {
		vector,
		top_k: debuggerTopK(topK, limits),
		mode: 'semantic',
		include_below_floor: true,
		include_below_threshold: true,
	};
	if (embeddingModel !== null && embeddingModel !== '') input.embedding_model = embeddingModel;
	return input;
}

/**
 * A search input limited to the documents the question was asked about, as the chat sent them
 * (`filter.objectIds`); no documents means the whole collection, as the chat does.
 *
 * @param input - The input.
 * @param objectIds - The documents, or null.
 * @returns A copy with the filter (the same vector), or the input itself.
 */
export function withScope(input: ISearchInput, objectIds: readonly string[] | null | undefined): ISearchInput {
	if (!objectIds || objectIds.length === 0) return input;
	return { ...input, filter: { ...input.filter, objectIds: [...objectIds] } };
}

/**
 * The debugger's line when the question was asked about some documents only.
 *
 * @param objectIds - The documents, or null.
 * @returns The sentence, or null for the whole collection.
 */
export function debuggerScopeSentence(objectIds: readonly string[] | null | undefined): string | null {
	if (!objectIds || objectIds.length === 0) return null;
	return `Searched only the ${objectIds.length === 1 ? 'document' : `${objectIds.length.toLocaleString('en-US')} documents`} the question was asked about.`;
}

/**
 * Whether `score` is worse than `line` under the store's ordering.
 *
 * @param score - The score.
 * @param line - The threshold or floor.
 * @param higherIsBetter - The ordering.
 * @returns True when the score falls under the line.
 */
function under(score: number, line: number, higherIsBetter: boolean): boolean {
	return higherIsBetter ? score < line : score > line;
}

/**
 * A finite number, or null.
 *
 * @param value - Anything.
 * @returns The number or null.
 */
function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Lay a debugger search out against the threshold and floor.
 *
 * @param result - The `search` answer.
 * @param score - `dialect.score`, or null when the probe did not answer.
 * @param answerSources - The answer's citations (marked in the rows).
 * @returns The view.
 */
export function classifyRetrieval(result: ISearchResult, score: IScoreInfo | null, answerSources: readonly IChatSource[]): RetrievalView {
	const threshold = score !== null ? num(score.threshold) : null;
	const floor = score !== null ? num(score.floor) : null;
	const higherIsBetter = score?.higher_is_better !== false;
	const cited = new Set(answerSources.map((source) => `${source.objectId}#${source.chunkId}`));
	const items: ISearchItem[] = Array.isArray(result?.results) ? result.results : [];

	const rows: RetrievalRow[] = items.map((item, index) => {
		const metadata = item.metadata ?? {};
		const objectId = typeof metadata.objectId === 'string' ? metadata.objectId : '';
		const chunkId = typeof metadata.chunkId === 'number' ? metadata.chunkId : -1;
		const value = num(item.score);
		const belowFloor = typeof item.below_floor === 'boolean' ? item.below_floor : value !== null && floor !== null && under(value, floor, higherIsBetter);
		const belowThreshold = typeof item.below_threshold === 'boolean' ? item.below_threshold : value !== null && threshold !== null && under(value, threshold, higherIsBetter);
		const status: RetrievalStatus = belowFloor ? 'below_floor' : belowThreshold ? 'near_miss' : 'used';
		const content = typeof item.content === 'string' ? item.content : '';
		return {
			rank: typeof item.rank === 'number' ? item.rank : index + 1,
			key: [objectId, chunkId] as VectorKey,
			objectId,
			chunkId,
			path: typeof metadata.parent === 'string' ? metadata.parent : '',
			score: value,
			rawScore: num(item.raw_score),
			sim: num(item.sim),
			status,
			inAnswer: cited.has(`${objectId}#${chunkId}`),
			preview: content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content,
		};
	});

	const counts = {
		used: rows.filter((row) => row.status === 'used').length,
		nearMisses: rows.filter((row) => row.status === 'near_miss').length,
		belowFloor: rows.filter((row) => row.status === 'below_floor').length,
	};
	const parts: string[] = [];
	if (threshold !== null) {
		parts.push(`threshold ${threshold.toFixed(2)}`);
		parts.push(counts.nearMisses === 1 ? '1 near miss hidden' : `${counts.nearMisses} near misses hidden`);
	}
	if (floor !== null && counts.belowFloor > 0) parts.push(`${counts.belowFloor} below the floor`);
	if (parts.length === 0) parts.push(rows.length === 1 ? '1 result' : `${rows.length} results`);

	const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
	const modelMismatch = warnings.includes('model_mismatch');
	return {
		rows,
		threshold,
		floor,
		counts,
		summary: parts.join(' · '),
		modelMismatch,
		modelMismatchSentence: modelMismatch ? MODEL_MISMATCH_SENTENCE : null,
		keywordFallback: warnings.includes('keyword_fallback'),
	};
}

/** A score histogram. */
export interface ScoreHistogram {
	bins: number[];
	min: number;
	max: number;
	/** The bin a score falls in (clamped). */
	binOf(score: number): number;
}

/**
 * Count scores into {@link HISTOGRAM_BINS} equal bins.
 *
 * @param scores - The scores.
 * @param range - The score range (dialect.score.range), else the scores' own span.
 * @returns The histogram.
 */
export function scoreHistogram(scores: readonly number[], range?: readonly [number, number] | null): ScoreHistogram {
	const finite = scores.filter((value) => Number.isFinite(value));
	let min = range ? range[0] : finite.length > 0 ? Math.min(...finite) : 0;
	let max = range ? range[1] : finite.length > 0 ? Math.max(...finite) : 1;
	if (!(max > min)) {
		min -= 0.5;
		max += 0.5;
	}
	const span = max - min;
	const binOf = (score: number): number => Math.max(0, Math.min(HISTOGRAM_BINS - 1, Math.floor(((score - min) * HISTOGRAM_BINS) / span + 1e-9)));
	const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
	for (const value of finite) bins[binOf(value)] += 1;
	return { bins, min, max, binOf };
}

/**
 * The code and text of a failure envelope or a thrown error.
 *
 * @param failure - A `{success:false}` answer or anything thrown.
 * @returns code (if any), the headline, and retry_after_s (if any).
 */
function readFailure(failure: unknown): { code: string | null; message: string; retryAfter: number | null; kind: string | null } {
	if (failure !== null && typeof failure === 'object') {
		const record = failure as Record<string, unknown>;
		const message = typeof record.headline === 'string' ? record.headline : typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : 'no reason given';
		return {
			code: typeof record.code === 'string' ? record.code : null,
			message,
			retryAfter: num(record.retry_after_s),
			kind: typeof record.kind === 'string' ? record.kind : null,
		};
	}
	return { code: null, message: String(failure), retryAfter: null, kind: null };
}

/**
 * Why the question could not be embedded.
 *
 * @param failure - The `embed` failure envelope or the thrown error.
 * @returns A sentence.
 */
export function embedErrorSentence(failure: unknown): string {
	const read = readFailure(failure);
	if (read.code === 'RATE_LIMITED') {
		const wait = read.retryAfter !== null ? ` in ${Math.ceil(read.retryAfter)} s` : ' in a minute';
		return `Too many questions were embedded in the last minute. Try "Why these?" again${wait}.`;
	}
	if (read.kind === 'timeout') return 'The embedding node did not answer in time. Try again.';
	return `The embedding node could not embed the question: ${read.message}`;
}

/**
 * Why the debugger's search failed.
 *
 * @param failure - The `search` failure envelope or the thrown error.
 * @returns A sentence.
 */
export function retrievalErrorSentence(failure: unknown): string {
	const read = readFailure(failure);
	if (read.kind === 'timeout' || read.code === 'TIMEOUT') return 'The store did not answer in time. Try again.';
	return `The store refused the search: ${read.message}`;
}
