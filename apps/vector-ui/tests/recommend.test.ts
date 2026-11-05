// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// RECOMMEND: examples, what is sent, and what the answer says
// =============================================================================
//
// Recommend finds chunks of the whole collection like the positive examples
// and unlike the negative ones. The examples are keys, kept per connection
// in the 'recommend examples' cache; the only vector a request may carry is
// the query vector the map holds (when "+ current query" is on), passed
// through untouched. The node computes the ranking; the app checks what it
// can before the call (an old node, Best score where the store cannot rank
// natively, no positive) and words every failure code.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IRoleChannel } from 'shared/explorer';
import { recommendExamples } from '../src/adapters/connections';
import { connectionCaches } from '../src/adapters/explorer';
import type { IRecommendExamples, IRecommendResult, IVectorCapabilities, IVectorLimits, VectorKey } from '../src/contract/types';
import { EMPTY_EXAMPLES, RECOMMEND_K_DEFAULT, RECOMMEND_K_OPTIONS, addExample, exampleLabel, notFoundLine, outsideKeys, polarityOf, recallExamples, recommendAvailable, recommendBlocker, recommendFailure, recommendNote, recommendRows, rememberExamples, removeExample, resolvedLine, runRecommendCall, setWithQuery, toRecommendInput, toRequest } from '../src/map/recommend';
import { keyIndex } from '../src/map/model';
import { fixture } from './support/fixtures';
import { loadSample } from './support/map.samples';

const LIMITS = fixture<{ limits: IVectorLimits }>('dialect_enriched').limits;
const CAPS = fixture<{ capabilities: IVectorCapabilities }>('dialect_enriched').capabilities;
const QDRANT_CAPS: IVectorCapabilities = { ...CAPS, recommend_best_score: true };
const OLD_LIMITS: IVectorLimits = (({ recommend_examples_max: _r, matrix_keys_max: _m, max_components: _c, ...rest }) => rest)(LIMITS);
const A: VectorKey = ['falcon-object', 7];
const B: VectorKey = ['kestrel-object', 2];
const G: VectorKey = ['greenhouse-object', 3];

// =============================================================================
// EXAMPLES
// =============================================================================

test('examples: add to a side, move between sides, never twice, at most recommend_examples_max per side', () => {
	let ex: IRecommendExamples = EMPTY_EXAMPLES;
	ex = addExample(ex, A, 'positive', 10).examples;
	ex = addExample(ex, B, 'positive', 10).examples;
	ex = addExample(ex, G, 'negative', 10).examples;
	assert.deepEqual(ex, { positive: [A, B], negative: [G], withQuery: false });
	assert.equal(addExample(ex, A, 'positive', 10).examples, ex, 'adding again changes nothing');
	const moved = addExample(ex, B, 'negative', 10).examples;
	assert.deepEqual(moved, { positive: [A], negative: [G, B], withQuery: false }, 'a key is on one side only');
	assert.equal(polarityOf(moved, ['kestrel-object', 2]), 'negative');
	assert.equal(polarityOf(moved, ['nope', 0]), null);
	const full = addExample(ex, ['x', 1], 'positive', 2);
	assert.equal(full.examples, ex);
	assert.equal(full.refused, 'At most 2 positive examples; remove one first.');
	assert.deepEqual(removeExample(ex, ['falcon-object', 7]), { positive: [B], negative: [G], withQuery: false });
	assert.deepEqual(setWithQuery(ex, true).withQuery, true);
	assert.deepEqual(EMPTY_EXAMPLES, { positive: [], negative: [], withQuery: false });
	assert.deepEqual(RECOMMEND_K_OPTIONS, [6, 12, 24]);
	assert.equal(RECOMMEND_K_DEFAULT, 12);
});

test("examples are kept per connection in the 'recommend examples' cache and cleared through the registry", () => {
	const ex = addExample(EMPTY_EXAMPLES, A, 'positive', 10).examples;
	rememberExamples(recommendExamples, 'conn-1', ex);
	assert.deepEqual(recallExamples(recommendExamples, 'conn-1'), ex);
	assert.deepEqual(recallExamples(recommendExamples, 'conn-2'), EMPTY_EXAMPLES, 'another connection has none');
	rememberExamples(recommendExamples, 'conn-1', EMPTY_EXAMPLES);
	assert.equal(recommendExamples.has('conn-1'), false, 'an empty set is not kept');
	rememberExamples(recommendExamples, 'conn-1', ex);
	assert.ok(connectionCaches.names().includes('recommend examples'));
	connectionCaches.clearAll();
	assert.deepEqual(recallExamples(recommendExamples, 'conn-1'), EMPTY_EXAMPLES);
});

// =============================================================================
// BEFORE THE CALL
// =============================================================================

test('what stops a run, in order: an old node, Best score without native ranking, no positive', () => {
	const one = addExample(EMPTY_EXAMPLES, A, 'positive', 10).examples;
	const negOnly = addExample(EMPTY_EXAMPLES, G, 'negative', 10).examples;
	assert.equal(recommendAvailable(LIMITS), true);
	assert.equal(recommendAvailable(OLD_LIMITS), false);
	assert.equal(recommendBlocker({ examples: one, strategy: 'average_vector', capabilities: CAPS, limits: OLD_LIMITS, queryText: null }), 'This store node does not recommend from examples; update the node.');
	assert.equal(recommendBlocker({ examples: one, strategy: 'best_score', capabilities: CAPS, limits: LIMITS, queryText: null }), 'Best score needs a store that ranks examples itself (Qdrant); use Average vector here.');
	assert.equal(recommendBlocker({ examples: EMPTY_EXAMPLES, strategy: 'average_vector', capabilities: CAPS, limits: LIMITS, queryText: null }), 'Add at least one positive example');
	assert.equal(recommendBlocker({ examples: negOnly, strategy: 'average_vector', capabilities: CAPS, limits: LIMITS, queryText: null }), 'Add at least one positive example');
	assert.equal(recommendBlocker({ examples: one, strategy: 'average_vector', capabilities: CAPS, limits: LIMITS, queryText: null }), null);
	assert.equal(recommendBlocker({ examples: setWithQuery(EMPTY_EXAMPLES, true), strategy: 'average_vector', capabilities: CAPS, limits: LIMITS, queryText: 'falcon water' }), null, 'the current query counts as a positive');
	assert.equal(recommendBlocker({ examples: setWithQuery(EMPTY_EXAMPLES, true), strategy: 'average_vector', capabilities: CAPS, limits: LIMITS, queryText: null }), 'Add at least one positive example', 'no query on the map: it cannot count');
	assert.equal(recommendBlocker({ examples: negOnly, strategy: 'best_score', capabilities: QDRANT_CAPS, limits: LIMITS, queryText: null }), null, 'Best score accepts negatives alone');
	assert.equal(recommendBlocker({ examples: EMPTY_EXAMPLES, strategy: 'best_score', capabilities: QDRANT_CAPS, limits: LIMITS, queryText: null }), 'Add at least one example');
	assert.equal(recommendNote(negOnly, 'best_score', null), 'Only negatives: showing the least similar chunks');
	assert.equal(recommendNote(one, 'best_score', null), null);
});

test('the request: keys as given, the query only when asked and there is one, k from the select', () => {
	const ex = setWithQuery(addExample(addExample(EMPTY_EXAMPLES, A, 'positive', 10).examples, G, 'negative', 10).examples, true);
	assert.deepEqual(toRequest(ex, 12, 'average_vector', 'falcon water'), { positive: [A], negative: [G], withQuery: true, k: 12, strategy: 'average_vector' });
	assert.equal(toRequest(ex, 12, 'average_vector', null).withQuery, false);
});

test('the input sent: example keys, the query vector untouched and only when asked, k within the node limit, the scope, examples left out', () => {
	const queryVector = Array.from({ length: 384 }, (_, i) => (i % 7) / 10 + 0.013);
	const request = { positive: [A, B], negative: [G], withQuery: true, k: 12, strategy: 'average_vector' as const };
	const input = toRecommendInput(request, { queryVector, scope: ['falcon-object', 'kestrel-object'], limits: LIMITS });
	assert.deepEqual(input.positive, [
		['falcon-object', 7],
		['kestrel-object', 2],
	]);
	assert.deepEqual(input.negative, [['greenhouse-object', 3]]);
	assert.equal(input.vector, queryVector, 'the very array embed returned, not a copy or another vector');
	assert.equal(input.k, 12);
	assert.equal(input.strategy, 'average_vector');
	assert.deepEqual(input.filter, { object_ids: ['falcon-object', 'kestrel-object'] });
	assert.equal(input.exclude_examples, true);
	const noQuery = toRecommendInput({ ...request, withQuery: false }, { queryVector, scope: null, limits: LIMITS });
	assert.equal(noQuery.vector, null, 'no query asked: no vector at all');
	assert.equal('filter' in noQuery, false, 'no scope: no filter');
	assert.equal(toRecommendInput({ ...request, k: 500 }, { queryVector: null, scope: null, limits: LIMITS }).k, LIMITS.neighbors_k_max);
	assert.equal(toRecommendInput({ ...request, withQuery: true }, { queryVector: null, scope: null, limits: LIMITS }).vector, null, 'asked, but no query placed: nothing');
	const many = Array.from({ length: 14 }, (_, i) => [`o${i}`, i] as VectorKey);
	assert.equal(toRecommendInput({ ...request, positive: many }, { queryVector: null, scope: null, limits: LIMITS }).positive?.length, 10, 'at most recommend_examples_max per side');
	const big = Array.from({ length: LIMITS.scope_keys_max + 1 }, (_, i) => `d${i}`);
	assert.equal('filter' in toRecommendInput(request, { queryVector: null, scope: big, limits: LIMITS }), false, 'a scope above scope_keys_max is never sent');
	const numericArrays = JSON.stringify(noQuery).match(/\[(-?\d+(\.\d+)?,){7,}/g);
	assert.equal(numericArrays, null, 'no vector rides along without the query');
});

test('runRecommendCall: one recommend call on the store node with that input; failures keep their code', async () => {
	const sent: Array<[string, unknown, unknown]> = [];
	const answer = fixture<IRecommendResult>('recommend_ok');
	const channel = {
		invoke: async (tool: string, input: unknown, opts: unknown) => {
			sent.push([tool, input, opts]);
			return answer;
		},
	} as unknown as Pick<IRoleChannel, 'invoke'>;
	const request = { positive: [A], negative: [G], withQuery: false, k: 6, strategy: 'average_vector' as const };
	const ok = await runRecommendCall(channel, 'store_1', request, { queryVector: null, scope: null, limits: LIMITS });
	assert.equal(ok.ok, true);
	assert.deepEqual(sent, [['recommend', { positive: [['falcon-object', 7]], negative: [['greenhouse-object', 3]], vector: null, k: 6, strategy: 'average_vector', exclude_examples: true }, { nodeId: 'store_1' }]]);
	const refusing = { invoke: async () => fixture('recommend_unsupported') } as unknown as Pick<IRoleChannel, 'invoke'>;
	const refused = await runRecommendCall(refusing, 'store_1', { ...request, strategy: 'best_score' }, { queryVector: null, scope: null, limits: LIMITS });
	assert.deepEqual(refused.ok ? null : [refused.code, refused.message], ['UNSUPPORTED', 'best_score is not supported by this store; use average_vector.']);
});

// =============================================================================
// THE ANSWER
// =============================================================================

test('failure codes in words', () => {
	assert.equal(recommendFailure('UNSUPPORTED', 'x', 'best_score'), 'This store cannot rank by Best score; use Average vector.');
	assert.equal(recommendFailure('UNSUPPORTED', 'x', 'average_vector'), 'This store node does not recommend from examples; update the node.');
	assert.equal(recommendFailure('NOT_FOUND', 'x', 'average_vector'), 'None of the positive examples is in the store any more. Remove them and add others.');
	assert.equal(recommendFailure('BUSY', 'x', 'average_vector'), 'The store is answering another neighbour search; try again in a moment.');
	assert.equal(recommendFailure('INVALID_INPUT', 'x', 'average_vector'), 'Add at least one positive example');
	assert.match(recommendFailure('DIMENSION_MISMATCH', 'x', 'average_vector'), /dimension/);
	assert.match(recommendFailure(undefined, 'boom', 'average_vector'), /boom/);
});

test('rows: path, chunk, similarity, preview, and whether each is in the drawn sample; the ones outside can be pinned up to project_keys_max', () => {
	const answer = fixture<IRecommendResult>('recommend_ok');
	const demo = loadSample('sample_demo_1000.json');
	const idx = keyIndex(demo);
	const first = demo.docs[demo.points.doc[0] as number]!.objectId;
	const withInside: IRecommendResult = { ...answer, items: [{ ...answer.items[0]!, key: [first, demo.points.chunk[0] as number] }, ...answer.items.slice(1)] };
	const rows = recommendRows(withInside, (key) => idx.has(`${key[0]}#${key[1]}`));
	assert.equal(rows.length, 6);
	assert.equal(rows[0]!.inSample, true);
	assert.ok(rows.slice(1).every((r) => !r.inSample));
	assert.equal(rows[1]!.label, 'C:/demo/field/kestrel_field_guide.md #2');
	assert.equal(rows[1]!.sim, 0.66);
	const outside = outsideKeys(rows, 3);
	assert.equal(outside.keys.length, 3);
	assert.equal(outside.capped, true);
	assert.deepEqual(outsideKeys(rows, 200), { keys: rows.slice(1).map((r) => r.key), capped: false });
});

test('what the answer says it was ranked by, and the examples the store no longer holds', () => {
	const answer = fixture<IRecommendResult>('recommend_ok');
	assert.equal(resolvedLine(answer), 'Ranked by 2 positive and 1 negative examples (average vector, computed by the store node).');
	assert.equal(resolvedLine({ ...answer, strategy_used: 'best_score', native: true, examples_resolved: { positive: 0, negative: 2 } }), 'Ranked by 2 negative examples (best score, ranked by the store itself).');
	assert.equal(resolvedLine({ ...answer, examples_resolved: { positive: 1, negative: 0 } }), 'Ranked by 1 positive example (average vector, computed by the store node).');
	const demo = loadSample('sample_demo_1000.json');
	const doc = demo.docs[0]!;
	assert.equal(exampleLabel({ result: demo } as never, [doc.objectId, 4]), `${doc.path} #4`);
	assert.equal(exampleLabel(null, ['abcdef0123456789', 4]), 'abcdef01… #4');
	assert.equal(
		notFoundLine([[doc.objectId, 4]], (key) => exampleLabel({ result: demo } as never, key)),
		`1 example is no longer in the store: ${doc.path} #4`
	);
	assert.equal(
		notFoundLine([], () => ''),
		null
	);
});
