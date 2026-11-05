// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// RESULTS: what the app reads out of each tool answer, and what it refuses to read
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { DEFAULT_LIMITS, readChunksPage, readDeleteResult, readDialect, readDocumentsPage, readStats, readTrashResult, unwrapEnvelope } from '../src/vector/results';
import { fixture } from './support/fixtures';
import defaults from './fixtures/defaults.json';

/** The error a call throws. */
function caught(fn: () => unknown): ExplorerToolError {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof ExplorerToolError, `an ExplorerToolError, got ${String(error)}`);
		return error;
	}
	assert.fail('expected a throw');
}

test('unwrapEnvelope: a success passes through, a failure envelope becomes a store error that keeps its code', () => {
	const ok = fixture('stats_pgvector');
	assert.equal(unwrapEnvelope('stats', ok), ok);
	for (const [code, envelope] of Object.entries(fixture<Record<string, { error: string }>>('errors'))) {
		const error = caught(() => unwrapEnvelope('stats', envelope));
		assert.equal(error.kind, 'store', code);
		assert.equal(error.code, code);
		assert.equal(error.message, envelope.error);
		assert.equal(error.tool, 'stats');
	}
	const legacy = caught(() => unwrapEnvelope('delete', { success: false, error: 'collection not found' }));
	assert.equal(legacy.code, undefined, 'an older node sends no code');
	assert.equal(legacy.message, 'collection not found');
	assert.equal(caught(() => unwrapEnvelope('stats', { success: false })).message, 'stats reported a failure without saying why.');
	assert.equal(caught(() => unwrapEnvelope('stats', [1, 2])).kind, 'malformed');
	assert.equal(caught(() => unwrapEnvelope('stats', null)).kind, 'malformed');
});

test('readDialect: the probe answer, or null for an old or foreign node; missing limits and capabilities fall back', () => {
	const pg = readDialect(fixture('dialect_pgvector'));
	assert.ok(pg);
	assert.equal(pg.backend, 'pgvector');
	assert.equal(pg.limits.documents_page, 500);
	assert.equal(pg.capabilities.remove, true);
	assert.equal(readDialect(null), null);
	assert.equal(readDialect({ dialect: 'postgres' }), null, 'a SQL node is not a vector store');
	const thin = readDialect({ success: true, dialect: 'vector', provider: 'qdrant', backend: 'qdrant' });
	assert.ok(thin);
	assert.deepEqual(thin.limits, DEFAULT_LIMITS);
	assert.deepEqual(DEFAULT_LIMITS, defaults.VECTOR_TOOL_LIMITS, "the fallback limits are the node's own (generated from vx_defaults.py)");
	assert.deepEqual(thin.capabilities, {});
	assert.deepEqual(thin.caveats, []);
	assert.equal(thin.allow_writes, false, 'an answer that does not say writes are on reads as off');
	assert.equal('agent_writes' in pg, false, 'allow_write alone decides agent writes: the dialect has no agent switch');
	assert.equal('agent_writes' in readDialect({ ...fixture('dialect_pgvector'), agent_writes: false })!, false, 'an agent_writes key a node sends is not read');
	assert.equal(thin.health.collection_exists, false);
	const missing = readDialect(fixture('dialect_collection_missing'));
	assert.equal(missing?.health.collection_exists, false);
	assert.equal(missing?.dimension, null);
});

test('no wire fixture names an agent write switch or its refusal', () => {
	const root = path.resolve(__dirname, 'fixtures');
	const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
	const files = walk(root).filter((file) => file.endsWith('.json'));
	assert.ok(files.some((file) => file.includes(`${path.sep}live${path.sep}`)) && files.some((file) => file.includes(`${path.sep}provisional${path.sep}`)), 'the premise: live and provisional fixtures are read');
	const naming = files.filter((file) => /agent_writes|WRITES_AGENT|AGENT_WRITES/.test(fs.readFileSync(file, 'utf8')));
	assert.deepEqual(
		naming.map((file) => path.relative(root, file)),
		[]
	);
});

test('readStats: the extended figures, never the legacy count as documents or chunks', () => {
	const full = readStats(fixture('stats_pgvector'));
	assert.equal(full.documents, 42);
	assert.equal(full.chunks, 1318);
	assert.equal(full.legacyCount, 1319, 'kept for the tooltip only');
	assert.equal(full.collectionExists, true);
	assert.equal(full.legacyOnly, false);
	const legacy = readStats({ success: true, count: 1319, model: 'sentence-transformers/all-MiniLM-L6-v2', vector_size: 384 });
	assert.equal(legacy.legacyOnly, true);
	assert.equal(legacy.documents, null, 'an older node: the legacy count is NOT a document count');
	assert.equal(legacy.chunks, null);
	assert.equal(legacy.dimension, 384, 'the legacy vector_size is the dimension');
	assert.equal(legacy.model, 'sentence-transformers/all-MiniLM-L6-v2');
	assert.equal(legacy.collectionExists, true);
});

test('readStats: a missing collection keeps the legacy success envelope and reads as an empty collection', () => {
	const missing = readStats(fixture('stats_collection_missing_legacy'));
	assert.equal(missing.collectionExists, false);
	assert.equal(missing.documents, null);
	assert.equal(missing.model, null, "the legacy '' model is no model");
	assert.equal(missing.dimension, null, 'and the legacy 0 is no dimension');
	assert.equal(readStats({ success: true, count: 0, model: '', vector_size: 0 }).collectionExists, true, 'an older node does not say; nothing is invented');
});

test('readStats: figures a store cannot count stay null; quick answers carry counts_as_of', () => {
	const pinecone = readStats(fixture('stats_pinecone_nulls'));
	assert.equal(pinecone.documents, null);
	assert.equal(pinecone.chunks, null);
	assert.equal(pinecone.rawCount, 1319);
	assert.deepEqual(pinecone.caveats, ['experimental', 'cloud_only_unverified', 'no_filtered_count']);
	const quick = readStats(fixture('stats_quick'));
	assert.equal(quick.countsAsOf, '2026-10-08T18:30:40Z');
	assert.equal(quick.computedAt, '2026-10-08T18:31:45Z');
	assert.equal(readStats(fixture('stats_orphans')).withoutFirstChunk, 1);
	assert.equal(readStats({ success: true, count: 'x', model: 3, vector_size: -1, documents: 'many' }).documents, null, 'a non-number is no count');
});

test('readDocumentsPage: a list page with its cursor, order and caveats; never the control record', () => {
	const page = readDocumentsPage(fixture('list_documents_page1'));
	assert.equal(page.items.length, 5);
	assert.equal(typeof page.nextCursor, 'string');
	assert.equal(page.total, 7);
	assert.equal(page.sorted, true);
	assert.equal(page.pagingUnsupported, false);
	const unsorted = readDocumentsPage(fixture('list_documents_unsorted'));
	assert.equal(unsorted.sorted, false);
	assert.equal(unsorted.total, null);
	assert.ok(unsorted.caveats.includes('documents_unsorted'));
	const stuck = readDocumentsPage(fixture('list_documents_paging_unsupported'));
	assert.equal(stuck.pagingUnsupported, true);
	assert.equal(stuck.nextCursor, null);
	assert.equal(stuck.items[0].chunks, null);
	const withControl = fixture('list_documents_page2_last');
	withControl.items.push({ ...withControl.items[0], objectId: 'schema', path: 'schema' });
	assert.ok(!readDocumentsPage(withControl).items.some((item) => item.objectId === 'schema'), 'the control record is never listed');
});

test('readDocumentsPage refuses a dict of documents and rows without an objectId', () => {
	assert.throws(() => readDocumentsPage({ success: true, items: { a: {} }, next_cursor: null }), /items must be a list/);
	const page = readDocumentsPage({ success: true, items: [{ path: 'x' }, { objectId: 'id-1', path: 'a.md', chunks: 2, has_first_chunk: true }], next_cursor: null, total: 1, counts_exact: true, distinct: true, sorted: true, caveats: [] });
	assert.deepEqual(
		page.items.map((item) => item.objectId),
		['id-1']
	);
	assert.equal(page.items[0].deleted, false, 'absent booleans read as false');
	assert.equal(page.items[0].size, null);
});

test('readChunksPage: chunks in order, never a vector; the existence probe reads its total', () => {
	const page = readChunksPage(fixture('chunks_page'));
	assert.deepEqual(
		page.items.map((c) => c.chunkId),
		[0, 1, 2]
	);
	assert.equal(page.hasMore, true);
	assert.equal(page.nextAfter, 2);
	assert.equal(page.total, 12);
	for (const chunk of page.items) assert.equal('vector' in chunk || 'embedding' in chunk, false);
	assert.equal(readChunksPage(fixture('chunks_exists_probe')).total, 19);
	assert.equal(caught(() => unwrapEnvelope('chunks', fixture('chunks_not_found'))).code, 'NOT_FOUND');
});

test('readDeleteResult: the batch less what was not found or kept live, and nothing the node did not say', () => {
	const kestrel = fixture('delete_ok').audit.object_ids[0];
	const ok = readDeleteResult(fixture('delete_ok'), [kestrel]);
	assert.equal(ok.removedChunks, 12);
	assert.deepEqual(ok.removed, [{ objectId: kestrel, chunks: null }], "delete names no rows per document: each one's count is unknown");
	assert.deepEqual([ok.notFound, ok.keptLive], [[], []]);
	const unknown = readDeleteResult({ success: true, deleted_count: 2, not_found: ['b'], removed_chunks: null }, ['a', 'b', 'a']);
	assert.equal(unknown.removedChunks, null, 'a store that cannot count says so; the app does not add up');
	assert.deepEqual([unknown.removed.map((r) => r.objectId), unknown.notFound, unknown.keptLive], [['a'], ['b'], []], 'each id once; an answer without kept_live keeps nothing');
	const emptied = readDeleteResult(fixture('delete_deleted_only'), fixture('delete_deleted_only').audit.object_ids);
	assert.deepEqual(
		emptied.removed.map((r) => r.objectId),
		[kestrel]
	);
	assert.deepEqual(emptied.keptLive, fixture('delete_deleted_only').kept_live, 'a partly trashed document is reported, not removed');
});

test('readTrashResult: soft_delete and restore say which documents moved and how many chunks', () => {
	for (const name of ['soft_delete_ok', 'restore_ok']) {
		const view = readTrashResult(fixture(name));
		assert.deepEqual([view.moved, view.notFound, view.movedChunks], [fixture(name).object_ids, [], 12], name);
	}
	const mixed = readTrashResult({ success: true, object_ids: ['a', 'b', 'a'], not_found: ['b'], matched_chunks: 9, moved_chunks: null });
	assert.deepEqual([mixed.moved, mixed.notFound, mixed.movedChunks], [['a'], ['b'], null]);
});

test('readTrashResult reads moved_chunks, never matched_chunks: a batch whose documents were already restored moved nothing', () => {
	// develop\'s matched_chunks counts every chunk the store holds for the ids; only moved_chunks says what moved.
	const already = readTrashResult({ success: true, object_ids: ['a', 'b'], not_found: [], matched_chunks: 8, moved_chunks: 0 });
	assert.equal(already.movedChunks, 0);
	const partial = readTrashResult({ success: true, object_ids: ['a', 'b'], not_found: [], matched_chunks: 8, moved_chunks: 3 });
	assert.equal(partial.movedChunks, 3);
	// A node older than the field reports nothing, and the app does not fall back to the other count.
	assert.equal(readTrashResult({ success: true, object_ids: ['a'], not_found: [], matched_chunks: 8 }).movedChunks, null);
});

test('readStats: deleted_documents is the Trash count, null where the store cannot count', () => {
	assert.equal(readStats(fixture('stats_pgvector')).deletedDocuments, 0);
	assert.equal(readStats({ ...fixture('stats_pgvector'), deleted_documents: 3 }).deletedDocuments, 3);
	assert.equal(readStats(fixture('stats_collection_missing_legacy')).deletedDocuments, null);
	assert.equal(readStats({ success: true, count: 4, model: 'm', vector_size: 8 }).deletedDocuments, null, 'an older node has no Trash count');
	assert.equal(caught(() => unwrapEnvelope('chunks', fixture('chunks_in_trash'))).code, 'IN_TRASH');
});
