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
// retrieval — "Why these?": what the store found for a question, and why the
// answer used some chunks and not others
// =============================================================================
//
// The debugger embeds the question on the pipeline's embedding node, searches
// the store with that vector for k + 10 results including rows below the
// threshold and below the driver's floor, and lays them out against the
// threshold and floor lines. The request carries the exact vector `embed`
// returned and nothing else vector-shaped.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer';
import type { IChatSource, IDialectResult, ISearchResult } from '../src/contract/types';
import { DEBUGGER_EXTRA, HISTOGRAM_BINS, classifyRetrieval, debuggerScopeSentence, debuggerSearchInput, debuggerTopK, embedErrorSentence, embedInput, retrievalErrorSentence, scoreHistogram, withScope } from '../src/vector/retrieval';

/**
 * Read a provisional fixture.
 *
 * @param name - File name.
 * @returns The parsed JSON.
 */
function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'provisional', name), 'utf8')) as T;
}

const dialect = fixture<IDialectResult>('dialect_pgvector.json');

test('debuggerSearchInput: k + 10, the exact query vector, rows below threshold and floor included', () => {
	const vector = fixture<{ vectors: number[][] }>('embed_ok.json').vectors[0];
	const input = debuggerSearchInput(vector, 'sentence-transformers/all-MiniLM-L6-v2', 3, dialect.limits);
	assert.equal(DEBUGGER_EXTRA, 10);
	assert.equal(input.top_k, 13);
	assert.equal(input.vector, vector, 'the vector embed returned, not a copy or another vector');
	assert.equal(input.embedding_model, 'sentence-transformers/all-MiniLM-L6-v2');
	assert.equal(input.include_below_floor, true);
	assert.equal(input.include_below_threshold, true);
	assert.equal(input.mode, 'semantic');
	assert.equal(input.query, undefined);
	const vectorShaped = Object.values(input).filter((value) => Array.isArray(value));
	assert.equal(vectorShaped.length, 1);
});

test('debuggerSearchInput: clamps to the node limit and to at least one row', () => {
	assert.equal(debuggerSearchInput([0.1], null, 95, dialect.limits).top_k, 100);
	assert.equal(debuggerSearchInput([0.1], null, 0, null).top_k, 10);
	assert.equal(debuggerSearchInput([0.1], null, -5, null).top_k, 10);
	assert.equal('embedding_model' in debuggerSearchInput([0.1], null, 2, null), false);
});

test('debuggerTopK: the k debuggerSearchInput asks for, so Search can run the same search', () => {
	for (const [topK, limits] of [
		[3, dialect.limits],
		[0, null],
		[-5, null],
		[95, dialect.limits],
		[2.7, null],
		[Number.NaN, null],
	] as const) {
		assert.equal(debuggerTopK(topK, limits), debuggerSearchInput([0.1], null, topK, limits).top_k, `topK ${topK}`);
	}
	assert.equal(debuggerTopK(3, dialect.limits), 13);
});

test('withScope: the documents the question was asked about go out as filter.objectIds; none means the whole collection', () => {
	const input = debuggerSearchInput([0.1], null, 3, dialect.limits);
	const scoped = withScope(input, ['d2', 'd1']);
	assert.deepEqual(scoped.filter, { objectIds: ['d2', 'd1'] });
	assert.equal(scoped.vector, input.vector, 'the same vector, not a copy');
	assert.equal('filter' in input, false, 'the input it was given is left alone');
	assert.equal('filter' in withScope(input, null), false);
	assert.equal('filter' in withScope(input, []), false, 'an empty scope would search the whole collection, as the chat does');
});

test('debuggerScopeSentence: says when "Why these?" searched only the documents the question was asked about', () => {
	assert.equal(debuggerScopeSentence(null), null);
	assert.equal(debuggerScopeSentence([]), null);
	assert.equal(debuggerScopeSentence(['d1']), 'Searched only the document the question was asked about.');
	assert.equal(debuggerScopeSentence(['d1', 'd2']), 'Searched only the 2 documents the question was asked about.');
});

test('embedInput: one query text, trimmed and capped', () => {
	assert.deepEqual(embedInput('  where is the water?  '), { texts: ['where is the water?'], kind: 'query' });
	assert.equal(embedInput('x'.repeat(9000)).texts[0].length, 8000);
});

test('classifyRetrieval: used, near misses and below-floor rows against the threshold and floor', () => {
	const result = fixture<ISearchResult>('search_below_floor.json');
	// One synthetic near miss: above the floor (0.2), below the threshold (0.3).
	const withNearMiss: ISearchResult = {
		...result,
		results: [...result.results.slice(0, 4), { content: 'near miss', score: 0.25, metadata: { objectId: 'near', chunkId: 3, parent: 'C:/demo/near.md' }, rank: 5, raw_score: 0.25, sim: 0.25, below_threshold: true, below_floor: false }, ...result.results.slice(4)],
	};
	const answer: IChatSource[] = [{ rank: 1, key: ['2ed1cfeb-37ac-4394-30f7-699303f093bd', 39], objectId: '2ed1cfeb-37ac-4394-30f7-699303f093bd', chunkId: 39, path: 'C:/demo/ops/ops_021.pdf', score: 0.5433, text: '' }];
	const view = classifyRetrieval(withNearMiss, dialect.score, answer);
	assert.equal(view.threshold, 0.3);
	assert.equal(view.floor, 0.2);
	assert.deepEqual(view.counts, { used: 4, nearMisses: 1, belowFloor: 6 });
	assert.deepEqual(
		view.rows.map((row) => row.status),
		['used', 'used', 'used', 'used', 'near_miss', 'below_floor', 'below_floor', 'below_floor', 'below_floor', 'below_floor', 'below_floor']
	);
	assert.equal(view.rows[0].inAnswer, true);
	assert.equal(view.rows[1].inAnswer, false);
	assert.deepEqual(view.rows[4].key, ['near', 3]);
	assert.equal(view.rows[4].path, 'C:/demo/near.md');
	assert.equal(view.summary, 'threshold 0.30 · 1 near miss hidden · 6 below the floor');
	assert.equal(view.modelMismatch, false);
});

test('classifyRetrieval: flags win; without flags the score is compared with the dialect', () => {
	const result: ISearchResult = {
		results: [
			{ content: 'a', score: 0.5, metadata: { objectId: 'a', chunkId: 0 } },
			{ content: 'b', score: 0.25, metadata: { objectId: 'b', chunkId: 0 } },
			{ content: 'c', score: 0.1, metadata: { objectId: 'c', chunkId: 0 } },
			{ content: 'd', score: 0.9, metadata: { objectId: 'd', chunkId: 0 }, below_threshold: true, below_floor: false },
		],
		total: 4,
	};
	const view = classifyRetrieval(result, dialect.score, []);
	assert.deepEqual(
		view.rows.map((row) => [row.key[0], row.status]),
		[
			['a', 'used'],
			['b', 'near_miss'],
			['c', 'below_floor'],
			['d', 'near_miss'],
		]
	);
});

test('classifyRetrieval: a lower-is-better score inverts the comparison', () => {
	const score = { formula: 'l2 distance', higher_is_better: false, floor: 2, threshold: 1 };
	const result: ISearchResult = { results: [0.5, 1.5, 3].map((value, i) => ({ content: String(i), score: value, metadata: { objectId: `o${i}`, chunkId: 0 } })), total: 3 };
	assert.deepEqual(
		classifyRetrieval(result, score, []).rows.map((row) => row.status),
		['used', 'near_miss', 'below_floor']
	);
});

test('classifyRetrieval: warnings surface the model mismatch and the keyword fallback', () => {
	const mismatch = classifyRetrieval(fixture<ISearchResult>('search_model_mismatch_warning.json'), dialect.score, []);
	assert.equal(mismatch.modelMismatch, true);
	assert.equal(mismatch.modelMismatchSentence, 'The chat embedding model differs from the one this collection was built with; results may be meaningless.');
	const fallback = classifyRetrieval(fixture<ISearchResult>('search_keyword_fallback_warning.json'), dialect.score, []);
	assert.equal(fallback.keywordFallback, true);
	assert.equal(fallback.modelMismatch, false);
});

test('classifyRetrieval: no dialect still lists the rows, with no lines', () => {
	const view = classifyRetrieval(fixture<ISearchResult>('search_vector.json'), null, []);
	assert.equal(view.threshold, null);
	assert.equal(view.floor, null);
	assert.equal(view.rows.length, 8);
	assert.ok(view.rows.every((row) => row.status === 'used'));
	assert.equal(view.summary, '8 results');
});

test('scoreHistogram: 100 bins over the score range, every score counted once', () => {
	assert.equal(HISTOGRAM_BINS, 100);
	const scores = [-1, -0.5, 0, 0.29, 0.3, 0.5433, 1];
	const histogram = scoreHistogram(scores, [-1, 1]);
	assert.equal(histogram.bins.length, 100);
	assert.equal(
		histogram.bins.reduce((sum, count) => sum + count, 0),
		scores.length
	);
	assert.equal(histogram.bins[0], 1);
	assert.equal(histogram.bins[99], 1);
	assert.equal(histogram.min, -1);
	assert.equal(histogram.max, 1);
	assert.equal(histogram.binOf(0.3), 65);
	// Without a range, the scores' own span (widened when they are all equal).
	const own = scoreHistogram([0.4, 0.4]);
	assert.ok(own.min < 0.4 && own.max > 0.4);
	assert.equal(
		scoreHistogram([]).bins.every((count) => count === 0),
		true
	);
});

test('embedErrorSentence and retrievalErrorSentence: refusals read as sentences', () => {
	const limited = embedErrorSentence({ success: false, code: 'RATE_LIMITED', error: 'Too many embed calls on this task; try again in 12 s.', retry_after_s: 12 });
	assert.equal(limited, 'Too many questions were embedded in the last minute. Try "Why these?" again in 12 s.');
	assert.equal(embedErrorSentence(new ExplorerToolError({ kind: 'raised', tool: 'embed', message: 'No handler found for embed' })), 'The embedding node could not embed the question: No handler found for embed');
	assert.equal(retrievalErrorSentence({ success: false, code: 'DIMENSION_MISMATCH', error: 'The vector has 768 values; this collection stores 384.' }), 'The store refused the search: The vector has 768 values; this collection stores 384.');
	assert.equal(retrievalErrorSentence(new ExplorerToolError({ kind: 'timeout', tool: 'search', message: 'Stopped waiting' })), 'The store did not answer in time. Try again.');
});
