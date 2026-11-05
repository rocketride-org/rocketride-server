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
// MAP - RECOMMEND FROM EXAMPLES (pure, plus the one call helper)
// =============================================================================
//
// "More like these, less like those": the store node ranks the whole
// collection against the positive and negative examples (contract section
// 4.4-D). Average vector is computed by the node on every store; Best score
// is the store's own ranking where `capabilities.recommend_best_score` says
// so (Qdrant), and accepts negatives alone. A node without the tool leaves
// `limits.recommend_examples_max` out, and the panel says to update it.
//
// The examples are keys, kept per connection in the registry's 'recommend
// examples' map (adapters/connections.ts), cleared on a change of identity.
// The only vector a request may carry is the query vector the map holds,
// when "+ current query" is on; it is passed through as the very array
// `embed` returned. Stored vectors never reach the browser.
// =============================================================================

import type { IRoleChannel } from 'shared/explorer';
import type { ExamplePolarity, IRecommendExamples, IRecommendInput, IRecommendRequest, IRecommendResult, ISampleModel, IVectorCapabilities, IVectorLimits, RecommendStrategy, ToolOutcome, VectorKey } from '../contract/types';
import { callRecommend } from './calls';
import { mapFailure } from './wording';

// =============================================================================
// CONSTANTS AND WORDS
// =============================================================================

/** How many results the panel offers to ask for. */
export const RECOMMEND_K_OPTIONS = [6, 12, 24] as const;

/** The default number of results. */
export const RECOMMEND_K_DEFAULT = 12;

/** No examples, no query. */
export const EMPTY_EXAMPLES: IRecommendExamples = Object.freeze({ positive: [], negative: [], withQuery: false });

/** A node without the tool. */
export const RECOMMEND_UNSUPPORTED_NODE = 'This store node does not recommend from examples; update the node.';

/** Best score where the store cannot rank natively. */
export const RECOMMEND_BEST_SCORE_UNSUPPORTED = 'Best score needs a store that ranks examples itself (Qdrant); use Average vector here.';

/** Average vector needs a positive. */
export const RECOMMEND_NEEDS_POSITIVE = 'Add at least one positive example';

/** Best score needs any example. */
export const RECOMMEND_NEEDS_EXAMPLE = 'Add at least one example';

/** Best score with negatives only. */
export const RECOMMEND_NEGATIVES_ONLY = 'Only negatives: showing the least similar chunks';

/** The run is on its way. */
export const RECOMMEND_BUSY = 'Finding chunks like the examples…';

// =============================================================================
// EXAMPLES
// =============================================================================

/** Two keys are the same chunk. */
const same = (a: VectorKey, b: VectorKey): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Whether a key is an example, and on which side.
 *
 * @param examples - The examples.
 * @param key - A chunk.
 * @returns Its side, or null.
 */
export function polarityOf(examples: IRecommendExamples, key: VectorKey): ExamplePolarity | null {
	if (examples.positive.some((k) => same(k, key))) return 'positive';
	if (examples.negative.some((k) => same(k, key))) return 'negative';
	return null;
}

/**
 * Add a chunk as an example. A key already on the other side moves; a key
 * already on this side changes nothing; a full side refuses.
 *
 * @param examples - The examples.
 * @param key - The chunk.
 * @param polarity - Positive or negative.
 * @param max - The node's recommend_examples_max.
 * @returns The new examples (the same object when nothing changed) and why it was refused, if it was.
 */
export function addExample(examples: IRecommendExamples, key: VectorKey, polarity: ExamplePolarity, max: number): { examples: IRecommendExamples; refused: string | null } {
	if (polarityOf(examples, key) === polarity) return { examples, refused: null };
	const side = polarity === 'positive' ? examples.positive : examples.negative;
	if (side.length >= max) return { examples, refused: `At most ${max} ${polarity} examples; remove one first.` };
	const copy: VectorKey = [key[0], key[1]];
	const positive = examples.positive.filter((k) => !same(k, key));
	const negative = examples.negative.filter((k) => !same(k, key));
	if (polarity === 'positive') positive.push(copy);
	else negative.push(copy);
	return { examples: { positive, negative, withQuery: examples.withQuery }, refused: null };
}

/**
 * Remove a chunk from the examples.
 *
 * @param examples - The examples.
 * @param key - The chunk.
 * @returns The new examples.
 */
export function removeExample(examples: IRecommendExamples, key: VectorKey): IRecommendExamples {
	return { positive: examples.positive.filter((k) => !same(k, key)), negative: examples.negative.filter((k) => !same(k, key)), withQuery: examples.withQuery };
}

/**
 * Count the map's current query as a positive, or stop.
 *
 * @param examples - The examples.
 * @param on - Whether to count it.
 * @returns The new examples.
 */
export function setWithQuery(examples: IRecommendExamples, on: boolean): IRecommendExamples {
	return { ...examples, withQuery: on };
}

/**
 * A connection's examples from the registry map.
 *
 * @param cache - The 'recommend examples' map.
 * @param connectionKey - The connection.
 * @returns Its examples (none when it has none).
 */
export function recallExamples(cache: Map<string, IRecommendExamples>, connectionKey: string): IRecommendExamples {
	return cache.get(connectionKey) ?? EMPTY_EXAMPLES;
}

/**
 * Keep a connection's examples in the registry map (an empty set is dropped).
 *
 * @param cache - The 'recommend examples' map.
 * @param connectionKey - The connection.
 * @param examples - Its examples.
 */
export function rememberExamples(cache: Map<string, IRecommendExamples>, connectionKey: string, examples: IRecommendExamples): void {
	if (examples.positive.length === 0 && examples.negative.length === 0 && !examples.withQuery) cache.delete(connectionKey);
	else cache.set(connectionKey, examples);
}

/**
 * Words for a key: its document's path (when the sample holds the document) and chunk.
 *
 * @param sample - The drawn sample, or null.
 * @param key - The chunk.
 * @returns E.g. "C:/demo/a.md #3", or "0123abcd… #3".
 */
export function exampleLabel(sample: Pick<ISampleModel, 'result'> | null, key: VectorKey): string {
	const doc = sample?.result.docs.find((d) => d.objectId === key[0]);
	if (doc) return `${doc.path} #${key[1]}`;
	return `${key[0].length > 8 ? `${key[0].slice(0, 8)}…` : key[0]} #${key[1]}`;
}

// =============================================================================
// BEFORE THE CALL
// =============================================================================

/**
 * Whether the node has the tool (it reports `limits.recommend_examples_max`).
 *
 * @param limits - The dialect's limits.
 * @returns True when the node recommends.
 */
export function recommendAvailable(limits: IVectorLimits): boolean {
	return typeof limits.recommend_examples_max === 'number' && limits.recommend_examples_max > 0;
}

/**
 * Why a run cannot start now, or null.
 *
 * @param input - The examples, the strategy, the node's capabilities and limits, and the map's query text.
 * @returns The sentence, or null.
 */
export function recommendBlocker(input: { examples: IRecommendExamples; strategy: RecommendStrategy; capabilities: IVectorCapabilities; limits: IVectorLimits; queryText: string | null }): string | null {
	if (!recommendAvailable(input.limits)) return RECOMMEND_UNSUPPORTED_NODE;
	if (input.strategy === 'best_score' && input.capabilities.recommend_best_score !== true) return RECOMMEND_BEST_SCORE_UNSUPPORTED;
	const query = input.examples.withQuery && input.queryText !== null && input.queryText.trim() !== '';
	const positives = input.examples.positive.length + (query ? 1 : 0);
	if (input.strategy === 'average_vector' && positives === 0) return RECOMMEND_NEEDS_POSITIVE;
	if (input.strategy === 'best_score' && positives === 0 && input.examples.negative.length === 0) return RECOMMEND_NEEDS_EXAMPLE;
	return null;
}

/**
 * A note on what the run will show, or null.
 *
 * @param examples - The examples.
 * @param strategy - The strategy.
 * @param queryText - The map's query text.
 * @returns The note.
 */
export function recommendNote(examples: IRecommendExamples, strategy: RecommendStrategy, queryText: string | null): string | null {
	const query = examples.withQuery && queryText !== null;
	if (strategy === 'best_score' && examples.positive.length === 0 && !query && examples.negative.length > 0) return RECOMMEND_NEGATIVES_ONLY;
	return null;
}

/**
 * What the panel asks the map to run.
 *
 * @param examples - The examples.
 * @param k - Results wanted.
 * @param strategy - The strategy.
 * @param queryText - The map's query text (the query counts only when there is one).
 * @returns The request.
 */
export function toRequest(examples: IRecommendExamples, k: number, strategy: RecommendStrategy, queryText: string | null): IRecommendRequest {
	return { positive: examples.positive.map((key) => [key[0], key[1]] as VectorKey), negative: examples.negative.map((key) => [key[0], key[1]] as VectorKey), withQuery: examples.withQuery && queryText !== null, k, strategy };
}

/** What the map adds to a request: the query vector it holds, the scope, the limits. */
export interface IRecommendContext {
	/** The query vector `embed` returned (the map's ref), or null. */
	queryVector: number[] | null;
	/** The console's scope on the map, or null. */
	scope: readonly string[] | null;
	limits: IVectorLimits;
}

/**
 * The `recommend` input for a request: the example keys (at most
 * recommend_examples_max per side), the query vector only when the request
 * asks for it (the same array, untouched), k within neighbors_k_max, the
 * scope when it fits scope_keys_max, and the examples left out of the results.
 *
 * @param request - The panel's request.
 * @param ctx - The query vector, the scope and the limits.
 * @returns The input.
 */
export function toRecommendInput(request: IRecommendRequest, ctx: IRecommendContext): IRecommendInput {
	const max = ctx.limits.recommend_examples_max ?? 10;
	const input: IRecommendInput = {
		positive: request.positive.slice(0, max).map((key) => [key[0], key[1]] as VectorKey),
		negative: request.negative.slice(0, max).map((key) => [key[0], key[1]] as VectorKey),
		vector: request.withQuery && ctx.queryVector ? ctx.queryVector : null,
		k: Math.max(1, Math.min(Math.floor(request.k), ctx.limits.neighbors_k_max)),
		strategy: request.strategy,
		exclude_examples: true,
	};
	if (ctx.scope && ctx.scope.length > 0 && ctx.scope.length <= ctx.limits.scope_keys_max) input.filter = { object_ids: [...ctx.scope] };
	return input;
}

/**
 * Run a request on the store node (the map's `onRun`): one `recommend` call
 * through map/calls.ts.
 *
 * @param channel - The role channel that reaches the store node.
 * @param storeNode - The store node id.
 * @param request - The panel's request.
 * @param ctx - The query vector, the scope and the limits.
 * @returns The answer, or the code and sentence of the failure.
 */
export async function runRecommendCall(channel: Pick<IRoleChannel, 'invoke'>, storeNode: string, request: IRecommendRequest, ctx: IRecommendContext): Promise<ToolOutcome<IRecommendResult>> {
	const answer = await callRecommend(channel, toRecommendInput(request, ctx), { nodeId: storeNode });
	return answer.ok ? { ok: true, value: answer.value } : { ok: false, code: answer.code, message: answer.message };
}

// =============================================================================
// THE ANSWER
// =============================================================================

/**
 * A failure in words.
 *
 * @param code - The code, if any.
 * @param message - The node's own sentence.
 * @param strategy - The strategy that was asked.
 * @returns The sentence.
 */
export function recommendFailure(code: string | undefined, message: string, strategy: RecommendStrategy): string {
	switch (code) {
		case 'UNSUPPORTED':
			return strategy === 'best_score' ? 'This store cannot rank by Best score; use Average vector.' : RECOMMEND_UNSUPPORTED_NODE;
		case 'NOT_FOUND':
			return 'None of the positive examples is in the store any more. Remove them and add others.';
		case 'BUSY':
			return 'The store is answering another neighbour search; try again in a moment.';
		case 'INVALID_INPUT':
			return RECOMMEND_NEEDS_POSITIVE;
		default:
			return mapFailure(code, message);
	}
}

/** One result row. */
export interface IRecommendRow {
	key: VectorKey;
	/** "path #chunk". */
	label: string;
	path: string;
	chunkId: number;
	sim: number;
	score: number | null;
	below_floor: boolean;
	preview: string;
	/** The chunk is a point of the drawn sample. */
	inSample: boolean;
}

/**
 * The answer's rows.
 *
 * @param result - The `recommend` answer.
 * @param inSample - Whether a key is a point of the drawn sample.
 * @returns The rows, best first.
 */
export function recommendRows(result: IRecommendResult, inSample: (key: VectorKey) => boolean): IRecommendRow[] {
	return result.items.map((item) => ({
		key: [item.key[0], item.key[1]] as VectorKey,
		label: `${item.path} #${item.chunkId}`,
		path: item.path,
		chunkId: item.chunkId,
		sim: item.sim,
		score: item.score,
		below_floor: item.below_floor,
		preview: item.preview,
		inSample: inSample(item.key),
	}));
}

/**
 * The results outside the sample, to pin on the map (at most project_keys_max).
 *
 * @param rows - The rows.
 * @param max - The node's project_keys_max.
 * @returns The keys and whether some were left out.
 */
export function outsideKeys(rows: readonly IRecommendRow[], max: number): { keys: VectorKey[]; capped: boolean } {
	const outside = rows.filter((r) => !r.inSample).map((r) => r.key);
	return { keys: outside.slice(0, Math.max(0, max)), capped: outside.length > max };
}

/**
 * What the ranking used.
 *
 * @param result - The answer.
 * @returns E.g. "Ranked by 2 positive and 1 negative examples (average vector, computed by the store node)."
 */
export function resolvedLine(result: IRecommendResult): string {
	const { positive, negative } = result.examples_resolved;
	const parts: string[] = [];
	if (positive > 0) parts.push(`${positive} positive`);
	if (negative > 0) parts.push(`${negative} negative`);
	const total = positive + negative;
	const how = result.strategy_used === 'best_score' ? 'best score' : 'average vector';
	const who = result.native ? 'ranked by the store itself' : 'computed by the store node';
	return `Ranked by ${parts.join(' and ')} ${total === 1 ? 'example' : 'examples'} (${how}, ${who}).`;
}

/**
 * The examples the store no longer holds.
 *
 * @param notFound - The answer's `not_found`.
 * @param labelOf - Words for a key.
 * @returns The sentence, or null when there are none.
 */
export function notFoundLine(notFound: readonly VectorKey[], labelOf: (key: VectorKey) => string): string | null {
	if (notFound.length === 0) return null;
	const head = notFound.length === 1 ? '1 example is' : `${notFound.length} examples are`;
	return `${head} no longer in the store: ${notFound.map(labelOf).join(', ')}`;
}
