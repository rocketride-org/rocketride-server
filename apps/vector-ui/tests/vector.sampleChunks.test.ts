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
// VECTOR SAMPLE CHUNKS: when the drawer asks, the two reads, the kept answer
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { connectionCaches } from '../src/adapters/explorer';
import { sourcesSentence } from '../src/components/VectorConnectionCard';
import type { IDialectResult } from '../src/contract/types';
import { fieldsCaption } from '../src/components/CollectionPanel';
import { fieldsSummary } from '../src/vector/fields';
import { readStats } from '../src/vector/results';
import { SAMPLE_CHUNKS, SNIPPET_CHARS, cachedSample, loadSampleChunks, sampleVersion, skipReason, snippetOf } from '../src/vector/sampleChunks';
import { fixture } from './support/fixtures';

const src = (file: string): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', file), 'utf8');

test('a snippet folds whitespace and is cut to one short line', () => {
	assert.equal(snippetOf('  a\n\n b\t c '), 'a b c');
	const cut = snippetOf('x'.repeat(500));
	assert.equal(cut.length, SNIPPET_CHARS);
	assert.ok(cut.endsWith('…'));
});

test('the store is asked only when it can be read and may hold documents (the rule the strip and the card use)', () => {
	const missing = { health: { collection_exists: false } } as unknown as IDialectResult;
	const present = { health: { collection_exists: true } } as unknown as IDialectResult;
	const full = readStats({ ...fixture('stats_pgvector'), documents: 3, chunks: 9 });
	const empty = readStats({ ...fixture('stats_pgvector'), documents: 0, chunks: 0 });
	assert.match(skipReason(false, present, null) ?? '', /cannot be read/);
	assert.match(skipReason(true, missing, null) ?? '', /no documents yet/, 'the dialect says no collection');
	assert.match(skipReason(true, present, empty) ?? '', /no documents yet/, 'the stats count none');
	assert.equal(skipReason(true, present, null), null);
	assert.equal(skipReason(true, present, full), null);
	assert.equal(skipReason(true, missing, full), null, 'fresh stats win over a dialect that still says no collection');
	const gone = readStats({ ...fixture('stats_pgvector'), collection_exists: false, documents: null, chunks: null });
	assert.match(skipReason(true, present, gone) ?? '', /no documents yet/, 'stats say missing while the dialect says it exists: the same rule as the card')
});

test('two reads: the first document and its first chunks; the answer is kept until a write', async () => {
	const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
	const caller = {
		async invoke(tool: string, input: Record<string, unknown> = {}) {
			calls.push({ tool, input });
			if (tool === 'list_documents') return { success: true, items: [{ objectId: 'o1', path: 'docs/a.md', chunks: 4, has_first_chunk: true, tables: 0, deleted: false }], next_cursor: null, total: 1, sorted: true };
			return { success: true, items: [0, 1, 2, 3].map((i) => ({ chunkId: i, content: `chunk ${i}\n text`, length: 10, isTable: false, tableId: 0, isDeleted: false, pointId: null, metadata: {} })), has_more: false, next_after: -1, total: 4 };
		},
	};
	const v0 = sampleVersion(0, 3);
	assert.equal(cachedSample('k1', v0), undefined);
	const sample = await loadSampleChunks(caller as never, 'store_1', 'k1', v0);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((c) => c.tool), ['list_documents', 'chunks']);
	assert.equal(calls[0].input.limit, 1);
	assert.equal(calls[1].input.limit, SAMPLE_CHUNKS);
	assert.equal(sample?.path, 'docs/a.md');
	assert.deepEqual(sample?.chunks.map((c) => c.snippet), ['chunk 0 text', 'chunk 1 text', 'chunk 2 text']);
	assert.deepEqual(cachedSample('k1', v0), sample, 'kept for the same version');
	assert.equal(cachedSample('k1', sampleVersion(1, 3)), undefined, 'a write drops it');
	assert.equal(cachedSample('k1', sampleVersion(0, 4)), undefined, 'so does a refresh that finds another document count');
	assert.equal(cachedSample('k1', sampleVersion(0, 3)), undefined, 'and it stays dropped');
});

test('a read that began before a reset does not put its answer back (a new identity must not see the old sample)', async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const caller = {
		async invoke(tool: string) {
			await gate;
			if (tool === 'list_documents') return { success: true, items: [{ objectId: 'o1', path: 'docs/a.md', chunks: 1, has_first_chunk: true, tables: 0, deleted: false }], next_cursor: null, total: 1, sorted: true };
			return { success: true, items: [{ chunkId: 0, content: 'old', length: 3, isTable: false, tableId: 0, isDeleted: false, pointId: null, metadata: {} }], has_more: false, next_after: -1, total: 1 };
		},
	};
	const reading = loadSampleChunks(caller as never, 'store_1', 'k3', sampleVersion(0, 1));
	connectionCaches.clearAll();
	release();
	assert.equal((await reading)?.path, 'docs/a.md', 'the caller still gets its answer');
	assert.equal(cachedSample('k3', sampleVersion(0, 1)), undefined, 'but it is not kept');
	await loadSampleChunks({ invoke: caller.invoke } as never, 'store_1', 'k3', sampleVersion(0, 1));
	assert.ok(cachedSample('k3', sampleVersion(0, 1)), 'a read after the reset is kept');
});

test('a store that lists nothing is asked with one call and not remembered', async () => {
	let n = 0;
	const caller = {
		invoke: async () => {
			n += 1;
			return { success: true, items: [], next_cursor: null, total: 0, sorted: true };
		},
	};
	assert.equal(await loadSampleChunks(caller as never, 'store_1', 'k2', sampleVersion(0, null)), null);
	assert.equal(n, 1, 'one call');
	assert.equal(cachedSample('k2', sampleVersion(0, null)), undefined, 'an empty answer is not kept: a store found empty is the one filled next');
});

test('the fields line says what was read, and the card says which sources run', () => {
	assert.match(fieldsSummary(null), /^Not read yet\./);
	assert.equal(fieldsSummary({ rows: [{ name: 'path', type: 'text', coverage: 1, of: 1, example: null, searchFilter: false, listFilter: true, source: 'listing' }], chunksRead: 0, documentsRead: 0, at: 0 }), 'path (document fields only).');
	assert.match(fieldsSummary({ rows: Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, type: 'text' as const, coverage: 1, of: 1, example: null, searchFilter: false, listFilter: false, source: 'chunks' as const })), chunksRead: 1, documentsRead: 1, at: 0 }), /, and 2 more \(chunk fields estimated from 1 chunk\)\.$/);
	assert.equal(sourcesSentence({ roleLine: 'ingest ✓ · chat – · tools ✓' }), 'Sources: ingest running, chat not running, tools running');
});

test('the fields caption says when documents were written since the sample', () => {
	const read = { rows: [], chunksRead: 3, documentsRead: 1, at: 0, writes: 0 };
	assert.match(fieldsCaption(4, 4, false, true, null, true)[1], /^Documents were written since the chunk fields were read/);
	assert.match(fieldsCaption(4, 4, false, true, read, false)[1], /^Chunk fields are estimated/);
});

test('wiring: the landing drawer is the only DetailPanel; the card and the details panel use the shared content', () => {
	assert.match(src('views/ConnectionsView.tsx'), /<DetailPanel\b/);
	for (const file of ['components/ConnectionDetailsPanel.tsx', 'components/ConnectionDrawerDetails.tsx', 'components/VectorConnectionCard.tsx', 'components/CollectionPanel.tsx']) assert.doesNotMatch(src(file), /<(DetailPanel|Modal|ConfirmDialog)\b/, file);
	assert.match(src('views/ConnectionsView.tsx'), /<VectorConnectionCard key=\{endpoint\.key\}/);
	assert.match(src('views/ConnectionsView.tsx'), /vectorCardView\(endpoint, probe, stats\)/, 'the drawer reads the same flags as the card');
	assert.match(src('components/ConnectionDetailsPanel.tsx'), /useSampleChunks\(endpoint, probe, stats\)/);
});

test('the drawer reads again when the console refreshes and finds documents (R2-B5)', () => {
	const hook = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/useSampleChunks.ts'), 'utf8');
	assert.match(hook, /sampleVersion\(writes, stats\?\.documents \?\? null\)/);
	assert.match(hook, /\[endpoint\.key, endpoint\.nodeId, version, reason, caller === null\]/, 'a new version reads again');
	assert.equal(sampleVersion(0, null), '0:');
	assert.notEqual(sampleVersion(0, null), sampleVersion(0, 2), 'a store found empty and filled from outside');
	assert.equal(skipReason(true, { health: { collection_exists: false } } as never, readStats({ ...fixture('stats_pgvector'), documents: 2, chunks: 6 })), null, 'and the skip lifts once the stats count documents');
});
