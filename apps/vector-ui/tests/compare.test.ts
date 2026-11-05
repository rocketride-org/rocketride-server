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
// compare — two searches side by side (Search's Compare)
// =============================================================================
//
// Run A and run B are compared by chunk (the Jaccard index of their result
// sets) and by document (which documents only one of them found). The
// sentence is the one the panel shows: "A and B share 4 of 10 results
// (Jaccard 0.25); 3 documents only in A, 2 only in B".
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VectorKey } from '../src/contract/types';
import { compareRuns, compareSentence, keyId, rowKey, sideOf } from '../src/vector/compare';
import type { CompareRow } from '../src/vector/compare';

/**
 * Result rows from `objectId#chunk` names.
 *
 * @param names - e.g. 'a#0'.
 * @returns The rows.
 */
function rows(names: readonly string[]): CompareRow[] {
	return names.map((name) => {
		const [objectId, chunk] = name.split('#');
		return { key: [objectId, Number(chunk)] as VectorKey, objectId };
	});
}

test('keyId: one string per chunk', () => {
	assert.equal(keyId(['a', 3]), 'a#3');
	assert.notEqual(keyId(['a#3', 0]), keyId(['a', 30]));
});

test('rowKey: a chunk listed twice, or rows without chunk ids, still key each row apart; the same row keeps its key', () => {
	const repeated: VectorKey[] = [
		['a', 3],
		['a', 3],
		['b', 1],
	];
	assert.equal(new Set(repeated.map((key, index) => rowKey(key, index))).size, 3);
	const bare: VectorKey[] = [
		['', -1],
		['', -1],
	];
	assert.equal(new Set(bare.map((key, index) => rowKey(key, index))).size, 2);
	assert.equal(rowKey(['a', 3], 1), rowKey(['a', 3], 1));
	assert.notEqual(rowKey(['a', 3], 0), rowKey(['b', 3], 0), 'another run at the same position is another row');
});

test('compareRuns: shared results, the Jaccard index and the documents only one run found', () => {
	// 10 each, 4 shared chunks: union 16, Jaccard 0.25.
	const a = rows(['s#1', 's#2', 't#1', 't#2', 'a1#0', 'a1#1', 'a2#0', 'a3#0', 'u#5', 'u#6']);
	const b = rows(['s#1', 's#2', 't#1', 't#2', 'b1#0', 'b2#0', 'b2#1', 'u#7', 'u#8', 'u#9']);
	const summary = compareRuns(a, b);
	assert.equal(summary.sizeA, 10);
	assert.equal(summary.sizeB, 10);
	assert.equal(summary.shared, 4);
	assert.equal(summary.union, 16);
	assert.equal(summary.jaccard, 0.25);
	// u is found by both (different chunks): it is no document "only in" either.
	assert.deepEqual(summary.onlyA, ['a1', 'a2', 'a3']);
	assert.deepEqual(summary.onlyB, ['b1', 'b2']);
	assert.equal(compareSentence(summary), 'A and B share 4 of 10 results (Jaccard 0.25); 3 documents only in A, 2 only in B');
});

test('compareRuns: a chunk listed twice counts once; sizes may differ', () => {
	const summary = compareRuns(rows(['a#0', 'a#0', 'b#0']), rows(['b#0', 'c#0', 'd#0', 'e#0']));
	assert.equal(summary.sizeA, 2);
	assert.equal(summary.sizeB, 4);
	assert.equal(summary.shared, 1);
	assert.equal(summary.union, 5);
	assert.equal(summary.jaccard, 0.2);
	assert.equal(compareSentence(summary), 'A and B share 1 of 4 results (Jaccard 0.20); 1 document only in A, 3 only in B');
});

test('compareRuns: identical runs, disjoint runs, empty runs', () => {
	const same = compareRuns(rows(['a#0', 'b#0']), rows(['b#0', 'a#0']));
	assert.equal(same.jaccard, 1);
	assert.equal(compareSentence(same), 'A and B share 2 of 2 results (Jaccard 1.00); 0 documents only in A, 0 only in B');
	const apart = compareRuns(rows(['a#0']), rows(['b#0']));
	assert.equal(apart.jaccard, 0);
	assert.equal(compareSentence(apart), 'A and B share 0 of 1 result (Jaccard 0.00); 1 document only in A, 1 only in B');
	const oneEmpty = compareRuns(rows(['a#0']), []);
	assert.equal(oneEmpty.jaccard, 0);
	assert.equal(compareSentence(oneEmpty), 'B found nothing; A found 1 result');
	const none = compareRuns([], []);
	assert.equal(none.jaccard, null);
	assert.equal(compareSentence(none), 'Neither A nor B found anything');
});

test('sideOf: each row says whether the other run found it too', () => {
	const summary = compareRuns(rows(['a#0', 'b#0']), rows(['b#0', 'c#0']));
	assert.equal(sideOf(summary, ['a', 0], 'A'), 'only-a');
	assert.equal(sideOf(summary, ['b', 0], 'A'), 'both');
	assert.equal(sideOf(summary, ['b', 0], 'B'), 'both');
	assert.equal(sideOf(summary, ['c', 0], 'B'), 'only-b');
});
