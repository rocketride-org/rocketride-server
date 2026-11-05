// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// STATS STRIP: the figures (never invented), the chips, quick vs full refresh, "counts as of"
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUICK_STATS_INTERVAL_MS } from '../src/vector/budgets';
import { readDialect, readStats } from '../src/vector/results';
import { countsAsOfText, formatCount, statsChips, statsFigures, statsRefreshPlan } from '../src/vector/stats';
import { CAVEAT_SENTENCES, CODE_SENTENCES } from '../src/vector/wording';
import { fixture } from './support/fixtures';

const pg = readDialect(fixture('dialect_pgvector'))!;

/** The figure with this key. */
function figure(figures: ReturnType<typeof statsFigures>, key: string) {
	const found = figures.find((f) => f.key === key);
	assert.ok(found, key);
	return found;
}

test('the figures of a full answer, formatted en-US, with the legacy count only in the Chunks tooltip', () => {
	const figures = statsFigures(readStats(fixture('stats_pgvector')), pg);
	assert.deepEqual(
		figures.map((f) => [f.label, f.value]),
		[
			['Documents', '42'],
			['Chunks', '1,318'],
			['Deleted', '0'],
			['Avg', '31.4/doc'],
			['Model', 'all-MiniLM-L6-v2 · 384-d'],
			['Metric', 'cosine · HNSW'],
		]
	);
	assert.equal(figure(figures, 'chunks').tooltip, '1,319 rows including the control record');
	assert.equal(figure(figures, 'model').tooltip, 'sentence-transformers/all-MiniLM-L6-v2');
	assert.equal(formatCount(1234567), '1,234,567');
});

test('a figure the store did not count is "—" with a tooltip saying so; nothing is estimated', () => {
	const figures = statsFigures(readStats(fixture('stats_pinecone_nulls')), readDialect(fixture('dialect_experimental_milvus')));
	for (const key of ['documents', 'chunks', 'deleted', 'avg']) {
		const f = figure(figures, key);
		assert.equal(f.value, '—', key);
		assert.equal(f.missing, true, key);
		assert.match(f.tooltip ?? '', /^This store cannot count /, key);
	}
	const legacy = statsFigures(readStats({ success: true, count: 1319, model: 'm', vector_size: 384 }), null);
	assert.equal(figure(legacy, 'documents').value, '—', 'an older node answering the legacy keys only: no document count');
	assert.equal(figure(legacy, 'chunks').value, '—');
	assert.equal(figure(legacy, 'chunks').tooltip, 'This store cannot count chunks. 1,319 rows including the control record');
});

test('documents counted by their first chunk say so on the Documents figure', () => {
	const stats = readStats({ ...fixture('stats_pgvector'), caveats: ['documents_by_first_chunk'] });
	assert.equal(figure(statsFigures(stats, pg), 'documents').tooltip, CAVEAT_SENTENCES.documents_by_first_chunk);
	const viaDialect = readDialect({ ...fixture('dialect_qdrant'), caveats: ['documents_by_first_chunk'] });
	assert.equal(figure(statsFigures(readStats(fixture('stats_pgvector')), viaDialect), 'documents').tooltip, CAVEAT_SENTENCES.documents_by_first_chunk);
});

test('chips: support, writes, caveats and health, each with the whole message in its label', () => {
	const labels = (chips: ReturnType<typeof statsChips>) => chips.map((c) => c.label);
	assert.deepEqual(labels(statsChips({ dialect: pg, stats: readStats(fixture('stats_pgvector')), readOnly: false })), ['Supported', 'Writes on']);
	const qdrant = statsChips({ dialect: readDialect(fixture('dialect_qdrant')), stats: readStats(fixture('stats_orphans')), readOnly: false });
	assert.ok(labels(qdrant).includes('1 without first chunk'));
	const milvus = statsChips({ dialect: readDialect(fixture('dialect_experimental_milvus')), stats: null, readOnly: false });
	assert.ok(labels(milvus).includes('Experimental'));
	assert.equal(milvus.find((c) => c.label === 'Experimental')?.tooltip, CAVEAT_SENTENCES.experimental);
	assert.ok(labels(milvus).includes('No file size or ingest time'));
	const off = statsChips({ dialect: readDialect({ ...fixture('dialect_pgvector'), allow_writes: false }), stats: null, readOnly: false });
	assert.ok(labels(off).includes('Writes off'));
	assert.equal(off.find((c) => c.label === 'Writes off')?.tooltip, CODE_SENTENCES.WRITES_DISABLED);
	const readOnly = statsChips({ dialect: pg, stats: null, readOnly: true });
	assert.ok(labels(readOnly).includes('Read-only'));
	assert.ok(!labels(readOnly).includes('Writes on'), 'a read-only card never says writes are on');
	assert.ok(labels(statsChips({ dialect: readDialect(fixture('dialect_repair_needed')), stats: null, readOnly: false })).includes('Repair needed'));
	assert.ok(labels(statsChips({ dialect: readDialect(fixture('dialect_meta_pending')), stats: null, readOnly: false })).includes('Metadata column pending'));
	assert.ok(labels(statsChips({ dialect: readDialect(fixture('dialect_collection_missing')), stats: readStats(fixture('stats_collection_missing_legacy')), readOnly: false })).includes('Empty collection'));
	const mismatch = statsChips({ dialect: readDialect({ ...fixture('dialect_pgvector'), health: { ...fixture('dialect_pgvector').health, model_mismatch: true } }), stats: null, readOnly: false });
	assert.equal(mismatch.find((c) => c.label === 'Model mismatch')?.tooltip, CAVEAT_SENTENCES.model_mismatch);
	const brute = statsChips({ dialect: readDialect({ ...fixture('dialect_pgvector'), caveats: ['brute_force_search', 'score_scale_raw', 'shared_org_table'] }), stats: null, readOnly: false });
	assert.deepEqual(labels(brute).slice(2), ['Brute-force search', 'Raw scores', 'Shared table']);
	for (const chip of [...brute, ...milvus, ...qdrant]) assert.ok(chip.label.length > 0 && chip.tone, chip.key);
});

test('refresh plan: full on open, after a write or an upload and on Refresh; quick at most every 15 s while visible', () => {
	const now = 1_000_000;
	for (const trigger of ['open', 'write', 'upload', 'manual'] as const) {
		assert.equal(statsRefreshPlan(trigger, { visible: false, lastAt: now, now, inFlight: false }), 'full', trigger);
	}
	assert.equal(QUICK_STATS_INTERVAL_MS, 15_000);
	assert.equal(statsRefreshPlan('tick', { visible: true, lastAt: now - 14_999, now, inFlight: false }), null, 'not before 15 s');
	assert.equal(statsRefreshPlan('tick', { visible: true, lastAt: now - 15_000, now, inFlight: false }), 'quick');
	assert.equal(statsRefreshPlan('tick', { visible: false, lastAt: now - 60_000, now, inFlight: false }), null, 'never while hidden');
	assert.equal(statsRefreshPlan('tick', { visible: true, lastAt: now - 60_000, now, inFlight: true }), null, 'never on top of a call in flight');
	assert.equal(statsRefreshPlan('tick', { visible: true, lastAt: null, now, inFlight: false }), null, 'the first answer is a full one');
	assert.equal(statsRefreshPlan('tick', { visible: true, lastAt: null, failedAt: now - 15_000, now, inFlight: false }), 'full', 'a failed first load is asked again in full');
	assert.equal(statsRefreshPlan('tick', { visible: true, lastAt: null, failedAt: now - 14_999, now, inFlight: false }), null, 'at the quick-stats pace');
	assert.equal(statsRefreshPlan('tick', { visible: false, lastAt: null, failedAt: now - 60_000, now, inFlight: false }), null, 'never while hidden');
	assert.equal(statsRefreshPlan('tick', { visible: true, lastAt: now - 15_000, failedAt: now - 60_000, now, inFlight: false }), 'quick', 'with figures, a failure is refreshed quickly as before');
});

test('"counts as of": seconds, then minutes; nothing when the node gave no time', () => {
	const asOf = Date.parse('2026-10-08T18:30:40Z');
	const quick = readStats(fixture('stats_quick'));
	assert.equal(countsAsOfText(quick, asOf + 12_000), 'counts as of 12 s ago');
	assert.equal(countsAsOfText(quick, asOf + 125_000), 'counts as of 2 min ago');
	assert.equal(countsAsOfText(quick, asOf - 5_000), 'counts as of 0 s ago', 'a clock behind the node never says a negative age');
	assert.equal(countsAsOfText(readStats(fixture('stats_pinecone_nulls')), asOf), null);
	assert.equal(countsAsOfText(null, asOf), null);
	assert.equal(countsAsOfText(readStats({ ...fixture('stats_quick'), counts_as_of: 'not a time' }), asOf), null);
});

test('a Size figure joins the strip when the dialect reports the bytes the collection takes; never otherwise', () => {
	const enriched = readDialect(fixture('dialect_enriched'));
	assert.ok(enriched);
	const figures = statsFigures(readStats(fixture('stats_pgvector')), enriched);
	const size = figures.find((f) => f.key === 'size');
	assert.ok(size, 'present');
	assert.equal(figures[figures.length - 1], size, 'at the end of the strip');
	assert.equal(size.label, 'Size');
	assert.equal(size.value, '46 MB');
	assert.equal(size.tooltip, '46 MB on the store (48,234,496 bytes)');
	assert.equal(size.missing, false);
	assert.equal(
		statsFigures(readStats(fixture('stats_pgvector')), pg).some((f) => f.key === 'size'),
		false,
		'a dialect without size_bytes: no figure, not a dash'
	);
	assert.equal(
		statsFigures(readStats(fixture('stats_pgvector')), readDialect({ ...fixture('dialect_enriched'), size_bytes: null })).some((f) => f.key === 'size'),
		false
	);
});

test('Empty collection: fresh stats win over the dialect read when the store was found empty', () => {
	const labels = (chips: ReturnType<typeof statsChips>) => chips.map((c) => c.label);
	const foundEmpty = readDialect(fixture('dialect_collection_missing'));
	// After an upload the store holds documents: the strip must not say "Documents 42" beside "Empty collection".
	assert.ok(!labels(statsChips({ dialect: foundEmpty, stats: readStats(fixture('stats_pgvector')), readOnly: false })).includes('Empty collection'));
	// Before the first stats answer the dialect decides; fresh stats that say the collection is missing win as well.
	assert.ok(labels(statsChips({ dialect: foundEmpty, stats: null, readOnly: false })).includes('Empty collection'));
	assert.ok(labels(statsChips({ dialect: readDialect(fixture('dialect_pgvector')), stats: readStats(fixture('stats_collection_missing_legacy')), readOnly: false })).includes('Empty collection'));
});
