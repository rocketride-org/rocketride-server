// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DOCUMENT HEALTH (pure): the flags, what a store does not report, the directory group and the chip
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IDocumentItem } from '../src/contract/types';
import { buildGroups } from '../src/vector/documents';
import { HEALTH_NOT_REPORTED, OVERSIZE_FACTOR, deletedFromTotals, documentHealth, healthSummary, medianChunks } from '../src/vector/health';
import { readDocumentsPage, readStats } from '../src/vector/results';
import { statsChips } from '../src/vector/stats';
import { fixture } from './support/fixtures';

/** A synthetic document row (reporting chunk ids and deleted chunks, as pgvector does). */
function doc(objectId: string, path: string, over: Partial<IDocumentItem> = {}): IDocumentItem {
	return { objectId, path, chunks: 4, has_first_chunk: true, tables: 0, deleted: false, nodeId: 'chunk_1', size: 1000, modifyTime: null, ingestedAt: null, pointId: null, max_chunk_id: 3, deleted_chunks: 0, ...over };
}

/** The kinds of a document's flags. */
function kinds(item: IDocumentItem, ctx: Parameters<typeof documentHealth>[1] = {}): string[] {
	return documentHealth(item, ctx).flags.map((f) => f.kind);
}

test('a healthy document: no flag, and everything was checked', () => {
	const health = documentHealth(doc('a', 'C:/a.md'), { medianChunks: 4 });
	assert.deepEqual(health.flags, []);
	assert.deepEqual(health.unchecked, []);
});

test('no first chunk', () => {
	const health = documentHealth(doc('a', 'C:/a.md', { has_first_chunk: false, chunks: 3, max_chunk_id: 3 }), {});
	assert.deepEqual(
		health.flags.map((f) => [f.kind, f.label]),
		[['no_first_chunk', 'no first chunk']]
	);
	assert.equal(health.flags[0]?.detail, 'Chunk 0 is not stored: the document was partly removed or partly ingested.');
});

test('gaps: chunk ids run past the chunks stored; under the active listing, soft-deleted chunks explain their share of the gap', () => {
	const gap = documentHealth(doc('a', 'C:/a.md', { chunks: 100, max_chunk_id: 111 }), {});
	assert.deepEqual(
		gap.flags.map((f) => [f.kind, f.detail]),
		[['gaps', 'Chunk ids run to 111 but 100 chunks are stored: 12 are missing.']]
	);
	assert.deepEqual(kinds(doc('a', 'C:/a.md', { chunks: 3, max_chunk_id: 3, deleted_chunks: 1 })), ['deleted_chunks'], 'the one missing id is the soft-deleted chunk');
	assert.deepEqual(kinds(doc('a', 'C:/a.md', { chunks: 3, max_chunk_id: 4, deleted_chunks: 1 })), ['gaps', 'deleted_chunks'], 'one more missing than deleted');
	assert.equal(documentHealth(doc('a', 'C:/a.md', { chunks: 3, max_chunk_id: 4, deleted_chunks: 1 }), {}).flags[0]?.detail, 'Chunk ids run to 4 but 3 chunks are stored: 1 is missing beyond the soft-deleted ones.');
	assert.equal(documentHealth(doc('a', 'C:/a.md', { has_first_chunk: false, chunks: 30, max_chunk_id: 40, deleted_chunks: 2 }), {}).flags[1]?.detail, 'Chunk ids run to 40 but 30 chunks are stored: 8 are missing beyond the first chunk and the soft-deleted ones.');
	assert.equal(documentHealth(doc('a', 'C:/a.md', { has_first_chunk: false, chunks: 3, max_chunk_id: 4 }), {}).flags[1]?.detail, 'Chunk ids run to 4 but 3 chunks are stored: 1 is missing beyond the first chunk.');
	assert.deepEqual(kinds(doc('a', 'C:/a.md', { chunks: 4, max_chunk_id: 4, deleted_chunks: 1 }), { listing: 'all' }), ['gaps', 'deleted_chunks'], "listed with deleted:'all', deleted rows are counted, so a gap is a missing row");
	assert.equal(documentHealth(doc('a', 'C:/a.md', { has_first_chunk: false, chunks: 3, max_chunk_id: 4, deleted_chunks: 1 }), { listing: 'all' }).flags[1]?.detail, 'Chunk ids run to 4 but 3 chunks are stored: 1 is missing beyond the first chunk.', "under 'all' the deleted rows are among the chunks stored");
	assert.deepEqual(kinds(doc('a', 'C:/a.md', { chunks: 5, max_chunk_id: 4, deleted_chunks: 1 }), { listing: 'all' }), ['deleted_chunks']);
	const extra = documentHealth(doc('a', 'C:/a.md', { chunks: 6, max_chunk_id: 3 }), {});
	assert.deepEqual(
		extra.flags.map((f) => [f.kind, f.detail]),
		[['gaps', 'More chunks than chunk ids: 6 chunks are stored under ids 0 to 3.']]
	);
});

test('deleted chunks: a real signal under the active listing, counted whatever the mode', () => {
	const one = documentHealth(doc('a', 'C:/a.md', { chunks: 4, max_chunk_id: 4, deleted_chunks: 1 }), {});
	assert.deepEqual(
		one.flags.map((f) => [f.kind, f.label, f.detail]),
		[['deleted_chunks', '1 deleted chunk', '1 soft-deleted chunk of this document is still stored.']]
	);
	assert.equal(documentHealth(doc('a', 'C:/a.md', { deleted_chunks: 3, chunks: 4, max_chunk_id: 6 }), {}).flags[0]?.label, '3 deleted chunks');
});

test('empty parse: no chunk stored, or every loaded chunk empty with the list complete', () => {
	assert.deepEqual(kinds(doc('a', 'C:/a.md', { chunks: 0, max_chunk_id: null, has_first_chunk: true })), ['empty_parse']);
	assert.equal(documentHealth(doc('a', 'C:/a.md', { chunks: 0, max_chunk_id: null }), {}).flags[0]?.detail, 'No chunk is stored for this document: the parser found no text.');
	assert.deepEqual(kinds(doc('a', 'C:/a.md'), { chunkLengths: { lengths: [0, 0, 0, 0], complete: true } }), ['empty_parse']);
	assert.deepEqual(kinds(doc('a', 'C:/a.md'), { chunkLengths: { lengths: [0, 0], complete: false } }), [], 'not while more chunks may come');
	assert.deepEqual(kinds(doc('a', 'C:/a.md'), { chunkLengths: { lengths: [0, 12, 0, 0], complete: true } }), []);
});

test(`oversize: more than ${OVERSIZE_FACTOR}× the median chunks of the loaded documents`, () => {
	const health = documentHealth(doc('m', 'C:/demo/manuals/pump_manual.pdf', { chunks: 96, max_chunk_id: 95 }), { medianChunks: 6 });
	assert.deepEqual(
		health.flags.map((f) => [f.kind, f.detail]),
		[['oversize', '96 chunks: more than 10 times the median of 6 per document loaded.']]
	);
	assert.deepEqual(kinds(doc('m', 'C:/m.pdf', { chunks: 60, max_chunk_id: 59 }), { medianChunks: 6 }), [], 'exactly 10×: not oversize');
	assert.deepEqual(documentHealth(doc('m', 'C:/m.pdf', { chunks: 96, max_chunk_id: 95 }), { medianChunks: null }).unchecked, ['oversize'], 'no median: not computed');
});

test('a store that does not report chunk ids or deleted chunks (null or absent): those flags are not computed, and the panel says which stores report them', () => {
	const qdrant = readDocumentsPage(fixture('list_documents_filter_client')).items[0] as IDocumentItem;
	assert.equal(qdrant.max_chunk_id, null);
	const health = documentHealth(qdrant, { medianChunks: 10 });
	assert.deepEqual(health.flags, []);
	assert.deepEqual(health.unchecked, ['gaps', 'deleted_chunks']);
	const old = readDocumentsPage(fixture('list_documents_page1')).items[0] as IDocumentItem;
	assert.equal('max_chunk_id' in old, false, 'an older node sends no key at all');
	assert.deepEqual(documentHealth(old, { medianChunks: 10 }).unchecked, ['gaps', 'deleted_chunks']);
	assert.equal(HEALTH_NOT_REPORTED, 'This store does not report chunk ids or soft-deleted chunks per document, so gaps and deleted chunks are not checked; pgvector stores report them.');
	assert.deepEqual(documentHealth(doc('a', 'a', { chunks: null, max_chunk_id: null, deleted_chunks: null }), { medianChunks: 4 }).unchecked, ['gaps', 'deleted_chunks', 'empty_parse', 'oversize']);
});

test('the legacy table: the chunk-0-less document and the one with a soft-deleted row, under the active listing', () => {
	const legacy = readDocumentsPage(fixture('list_documents_filter_partial')).items[0] as IDocumentItem;
	assert.deepEqual(kinds(legacy), ['deleted_chunks'], 'falcon handbook: 31 active chunks up to id 30, 1 soft-deleted');
	assert.deepEqual(kinds({ ...legacy, has_first_chunk: false, chunks: 30 }), ['no_first_chunk', 'deleted_chunks']);
});

test('medianChunks over the loaded rows (documents without a count left out); deletedFromTotals from the two chunk totals', () => {
	assert.equal(medianChunks([doc('a', 'a', { chunks: 2 }), doc('b', 'b', { chunks: 10 }), doc('c', 'c', { chunks: null }), doc('d', 'd', { chunks: 6 })]), 6);
	assert.equal(medianChunks([]), null);
	assert.equal(deletedFromTotals(12, 11), 1);
	assert.equal(deletedFromTotals(null, 11), null);
	assert.equal(deletedFromTotals(10, 11), null, 'a store whose totals disagree is not trusted');
});

test('the directory lists a document with a defect under "Needs attention" (sorted by path); an oversize one keeps its folder, with the badge', () => {
	const rows = [doc('a', 'C:/demo/a.md'), doc('b', 'C:/demo/b.md', { deleted_chunks: 1, max_chunk_id: 4 }), doc('c', 'C:/demo/c.md', { has_first_chunk: false, max_chunk_id: 4 }), doc('m', 'C:/demo/big.pdf', { chunks: 96, max_chunk_id: 95 }), doc('d', 'C:/demo/d.md', { chunks: 2, max_chunk_id: 1 })];
	const settled = buildGroups(rows, { medianChunks: 4 });
	assert.deepEqual(
		settled.map((g) => [g.kind, g.label, g.rows.map((r) => r.item.objectId)]),
		[
			['folder', 'C:/demo/', ['a', 'm', 'd']],
			['attention', 'Needs attention (2)', ['b', 'c']],
		]
	);
	assert.deepEqual(
		settled.flatMap((g) => g.rows).map((r) => [r.name, r.flags, r.attention]),
		[
			['a.md', [], false],
			['big.pdf', ['oversize'], false],
			['d.md', [], false],
			['C:/demo/b.md', ['1 deleted chunk'], true],
			['C:/demo/c.md', ['no first chunk'], true],
		]
	);
	const loading = buildGroups(rows, { medianChunks: null });
	assert.deepEqual(
		loading.map((g) => [g.kind, g.rows.map((r) => r.item.objectId)]),
		settled.map((g) => [g.kind, g.rows.map((r) => r.item.objectId)]),
		'with or without the median, no row moves: only the oversize badge waits for it'
	);
	assert.deepEqual(loading[0]?.rows[1]?.flags, []);
	assert.deepEqual(
		buildGroups(rows).map((g) => g.label),
		['C:/demo/', 'Needs attention (2)'],
		'without a median: the documents flagged by their own fields'
	);
});

test('the chip: "N need attention" with the breakdown in its tooltip; counted over the loaded documents, and the store\'s own orphan count beside it', () => {
	const rows = [doc('a', 'C:/demo/a.md'), doc('b', 'C:/demo/b.md', { deleted_chunks: 1, max_chunk_id: 4 }), doc('c', 'C:/demo/c.md', { has_first_chunk: false, max_chunk_id: 4 }), doc('m', 'C:/demo/big.pdf', { chunks: 96, max_chunk_id: 95 })];
	const summary = healthSummary(rows, { medianChunks: 4, complete: true });
	assert.deepEqual(summary.counts, { no_first_chunk: 1, gaps: 0, deleted_chunks: 1, empty_parse: 0, oversize: 1 });
	assert.equal(summary.flagged, 2, 'the documents under "Needs attention": an oversize one is not among them');
	const stats = readStats({ ...fixture('stats_pgvector'), documents_without_first_chunk: 2 });
	const chip = statsChips({ dialect: null, stats, readOnly: false, health: summary }).find((c) => c.key === 'attention');
	assert.ok(chip);
	assert.equal(chip.label, '2 need attention');
	assert.equal(chip.tone, 'warning');
	assert.equal(chip.tooltip, 'Without a first chunk: 1 · Gaps in chunk ids: 0 · Deleted chunks: 1 · Empty: 0 · Oversize: 1. Counted over the 4 documents loaded; the directory lists them under "Needs attention" and marks oversize documents in their folders. The store counts 2 documents without a first chunk.');
	assert.equal(
		statsChips({ dialect: null, stats: readStats(fixture('stats_pgvector')), readOnly: false, health: healthSummary([rows[0] as IDocumentItem, rows[3] as IDocumentItem], { medianChunks: 4, complete: true }) }).some((c) => c.key === 'attention'),
		false,
		'only oversize documents: nothing needs attention'
	);
	assert.equal(
		statsChips({ dialect: null, stats, readOnly: false, health: summary }).some((c) => c.key === 'orphans'),
		false,
		'the attention chip replaces the orphan chip'
	);
	const partial = statsChips({ dialect: null, stats: readStats(fixture('stats_pgvector')), readOnly: false, health: healthSummary(rows, { medianChunks: 4, complete: false }) }).find((c) => c.key === 'attention');
	assert.equal(partial?.label, '2 of 4 loaded need attention');
	const one = statsChips({ dialect: null, stats: readStats(fixture('stats_pgvector')), readOnly: false, health: healthSummary([rows[2] as IDocumentItem], { medianChunks: null, complete: true }) }).find((c) => c.key === 'attention');
	assert.equal(one?.label, '1 needs attention');
	const unreported = healthSummary([{ ...doc('q', 'q.md'), max_chunk_id: null, deleted_chunks: null }], { medianChunks: null, complete: true });
	assert.equal(statsChips({ dialect: null, stats: readStats(fixture('stats_orphans')), readOnly: false, health: unreported }).find((c) => c.key === 'orphans')?.label, '1 without first chunk', "nothing flagged in what is loaded: the store's orphan chip stays");
});
