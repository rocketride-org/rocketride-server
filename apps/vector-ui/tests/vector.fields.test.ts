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
// VECTOR FIELDS: the chunk fields, the document sampler, the merge, the filter
// phrases and the sample read (at most 5 calls, in order)
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IChunkItem, IDocumentItem } from '../src/contract/types';
import { FIELD_EXAMPLE_MAX, chunkFields, documentFields, filterPhrase, mergeFields, sampleDocuments } from '../src/vector/fields';
import { CHUNKS_PER_DOCUMENT, SAMPLE_DOCUMENTS, readFieldsSample } from '../src/vector/fieldsRead';

const chunk = (id: number, metadata: Record<string, unknown>): IChunkItem => ({ chunkId: id, content: 'text', length: 4, isTable: false, tableId: 0, isDeleted: false, pointId: null, metadata });
const doc = (objectId: string, path: string, over: Partial<IDocumentItem> = {}): IDocumentItem => ({ objectId, path, chunks: 3, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null, ...over });

test('chunk fields: a type per key from all its values, coverage of the chunks read, a cut example', () => {
	const long = 'y'.repeat(200);
	const fields = chunkFields([
		chunk(0, { objectId: 'a', chunkId: 0, isTable: false, score: 1, ingestedAt: '2026-10-01T00:00:00Z', note: long, id: '123e4567-e89b-12d3-a456-426614174000', tags: ['x'] }),
		chunk(1, { objectId: 'a', chunkId: 1, isTable: false, score: 1.5, note: 'short', extra: null }),
		chunk(2, { objectId: 'a', chunkId: 2, isTable: true, mixed: 1 }),
		chunk(3, { mixed: 'one' }),
	]);
	const by = new Map(fields.map((f) => [f.name, f]));
	assert.equal(by.get('chunkId')?.type, 'integer');
	assert.equal(by.get('isTable')?.type, 'boolean');
	assert.equal(by.get('score')?.type, 'number', 'integer and number together are number');
	assert.equal(by.get('ingestedAt')?.type, 'timestamp');
	assert.equal(by.get('id')?.type, 'uuid');
	assert.equal(by.get('tags')?.type, 'json');
	assert.equal(by.get('mixed')?.type, 'unknown', 'mixed types are not guessed');
	assert.equal(by.get('objectId')?.coverage, 3);
	assert.equal(by.get('objectId')?.of, 4);
	assert.equal(by.get('note')?.example?.length, FIELD_EXAMPLE_MAX);
	assert.ok(by.get('note')?.example?.endsWith('…'));
	assert.equal(by.has('extra'), false, 'a key no chunk has a value for is not listed');
	for (const f of fields) assert.equal(f.source, 'chunks');
	assert.deepEqual(chunkFields([]), []);
});

test('chunk fields: which keys search.filter takes; a chunk key never claims a listing filter', () => {
	const fields = chunkFields([chunk(0, { objectId: 'a', chunkId: 0, nodeId: 'n', parent: '/p', isTable: false, permissionId: 'p', signature: 's', tableId: 0 })]);
	assert.deepEqual(fields.filter((f) => f.searchFilter).map((f) => f.name), ['objectId', 'chunkId', 'nodeId', 'parent', 'isTable']);
	assert.equal(fields.some((f) => f.listFilter), false);
});

test('filter phrases name the keys and claim the store applies a listing filter only on pgvector', () => {
	const by = new Map([...documentFields([doc('o', 'docs/a.md', { nodeId: 'n', ingestedAt: '2026-10-01T00:00:00Z' })]), ...chunkFields([chunk(0, { chunkId: 0, parent: '/p', signature: 's' })])].map((f) => [f.name, f]));
	assert.match(filterPhrase(by.get('path')!), /Listing filter: path_prefix/);
	assert.match(filterPhrase(by.get('path')!), /applied by the store on pgvector; elsewhere matched over loaded rows/);
	assert.doesNotMatch(filterPhrase(by.get('path')!), /Search filter/);
	assert.equal(filterPhrase(by.get('nodeId')!), 'Search filter: nodeId');
	assert.equal(filterPhrase(by.get('chunkId')!), 'Search filter: minChunkId, maxChunkId');
	assert.equal(filterPhrase(by.get('parent')!), 'Search filter: parent (an exact path)');
	assert.equal(filterPhrase(by.get('size')!), 'Not filterable');
	assert.equal(filterPhrase(by.get('signature')!), 'Not filterable');
});

test('the sampler: spread over folders in name order, one per folder in turn, skipping trashed and empty documents', () => {
	const rows = [doc('a1', 'b/one.md'), doc('a2', 'b/two.md'), doc('c1', 'a/one.md'), doc('d1', 'a/dead.md', { deleted: true }), doc('e1', 'a/empty.md', { chunks: 0 }), doc('f1', 'z/one.md'), doc('u1', 'loose.md'), doc('u2', 'other.md')];
	assert.deepEqual(sampleDocuments(rows, 5).map((r) => r.objectId), ['u1', 'c1', 'a1', 'f1', 'u2']);
	assert.deepEqual(sampleDocuments(rows, 3).map((r) => r.objectId), ['u1', 'c1', 'a1']);
	assert.deepEqual(sampleDocuments([], 5), []);
	assert.deepEqual(sampleDocuments(rows, 5), sampleDocuments(rows, 5), 'deterministic');
	assert.equal(new Set(sampleDocuments(rows, 5).map((r) => r.objectId)).size, 5);
	assert.equal(sampleDocuments(rows, 50).length, 6, 'never more than the usable documents');
});

test('merge: the listing\'s rows first; a chunk key with a document field\'s name keeps the listing row', () => {
	const listing = documentFields([doc('o', 'docs/a.md', { nodeId: 'n' })]);
	const merged = mergeFields(listing, chunkFields([chunk(0, { nodeId: 'n', custom: 'v' })]));
	assert.deepEqual(merged.map((f) => f.name), [...listing.map((f) => f.name), 'custom']);
	assert.equal(merged.find((f) => f.name === 'nodeId')?.source, 'listing');
});

test('reading a sample sends at most five chunks calls, one after the other, and keeps nothing when one fails', async () => {
	const rows = Array.from({ length: 12 }, (_, i) => doc(`o${i}`, `f${i % 4}/d${i}.md`));
	const calls: Array<Record<string, unknown>> = [];
	let open = 0;
	let overlapped = false;
	const caller = {
		async invoke(_tool: string, input: Record<string, unknown> = {}) {
			calls.push(input);
			open += 1;
			if (open > 1) overlapped = true;
			await Promise.resolve();
			open -= 1;
			return { success: true, items: [{ chunkId: 0, content: 'x', length: 1, isTable: false, tableId: 0, isDeleted: false, pointId: null, metadata: { objectId: input.object_id, tag: 't' } }], has_more: false, next_after: -1, total: 1 };
		},
	};
	const estimate = await readFieldsSample(caller as never, 'store_1', rows);
	assert.equal(calls.length, SAMPLE_DOCUMENTS);
	assert.equal(overlapped, false);
	assert.ok(calls.every((c) => c.limit === CHUNKS_PER_DOCUMENT && c.after_chunk === -1 && c.deleted === 'active'));
	assert.equal(estimate.documentsRead, 5);
	assert.equal(estimate.chunksRead, 5);
	assert.equal(estimate.rows.find((f) => f.name === 'tag')?.of, 5);
	assert.equal(estimate.rows.find((f) => f.name === 'path')?.of, 12, 'document fields stay exact over all the loaded rows');
	const failing = { invoke: async () => Promise.reject(new Error('boom')) };
	await assert.rejects(readFieldsSample(failing as never, 'store_1', rows), /boom/);
});
