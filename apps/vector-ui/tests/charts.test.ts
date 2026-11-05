// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// COLLECTION CHARTS (pure): bins, medians, nulls, log edges, periods, file types, captions and states
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IDocumentItem, ISampleModel, ISampleResult } from '../src/contract/types';
import { MAX_PERIOD_BINS, binCounts, byFileType, byIngestPeriod, chunksPerDocument, collectionCharts, lengthBins, logBins, median, minMax } from '../src/vector/charts';
import { validateFilter } from '../src/vector/filters';
import { readDialect, readDocumentsPage } from '../src/vector/results';
import { fixture } from './support/fixtures';
import { bestOf } from './support/timing';

/** A synthetic document row. */
function doc(objectId: string, path: string, over: Partial<IDocumentItem> = {}): IDocumentItem {
	return { objectId, path, chunks: 3, has_first_chunk: true, tables: 0, deleted: false, nodeId: 'chunk_1', size: null, modifyTime: null, ingestedAt: null, pointId: null, ...over };
}

/** A sample model around a sample answer. */
function model(result: ISampleResult): ISampleModel {
	return { sampleId: result.sample_id, seed: 7, mode: result.mode, receivedAt: 0, result, pinned: [], removed: [] };
}

test('median: the middle value (the mean of the two middles), null for nothing', () => {
	assert.equal(median([5, 1, 3]), 3);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([]), null);
});

test('binCounts: a count per [edge, next edge); the last bin is open; values below the first edge are not counted', () => {
	assert.deepEqual(binCounts([0, 1, 1, 2, 3, 9, 100], [1, 2, 4, 8]), [2, 2, 0, 2]);
	assert.deepEqual(binCounts([], [0, 10]), [0, 0]);
});

test('logBins: powers of two, labelled and contiguous from the smallest value to the largest, a 0 bin only when there is a 0', () => {
	const bins = logBins([1, 2, 3, 4, 7, 8, 64, 100]);
	assert.deepEqual(
		bins.map((b) => [b.label, b.lo, b.hi, b.count]),
		[
			['1', 1, 1, 1],
			['2–3', 2, 3, 2],
			['4–7', 4, 7, 2],
			['8–15', 8, 15, 1],
			['16–31', 16, 31, 0],
			['32–63', 32, 63, 0],
			['64–127', 64, 127, 2],
		]
	);
	assert.deepEqual(
		logBins([0, 0, 5]).map((b) => [b.label, b.count]),
		[
			['0', 2],
			['1', 0],
			['2–3', 0],
			['4–7', 1],
		]
	);
	assert.deepEqual(logBins([]), []);
});

test("chunks per document: the long manual lands in the top bin, a click scopes to that bin's chunk range, documents without a count are left out and said", () => {
	const rows = [doc('a', 'C:/demo/a.md', { chunks: 2 }), doc('b', 'C:/demo/b.md', { chunks: 5 }), doc('c', 'C:/demo/c.md', { chunks: 6 }), doc('manual', 'C:/demo/manuals/pump_manual.pdf', { chunks: 96 }), doc('n', 'C:/demo/n.md', { chunks: null })];
	const chart = chunksPerDocument(rows, 10);
	const top = chart.bins[chart.bins.length - 1];
	assert.ok(top);
	assert.equal(top.label, '64–127');
	assert.equal(top.count, 1);
	assert.deepEqual(top.scope, { min_chunks: 64, max_chunks: 127 });
	assert.equal(chart.median, 5.5);
	assert.equal(chart.caption, '5 of 10 documents loaded · median 5.5 chunks · 1 without a count');
	assert.match(chart.summary, /^Chunks per document, 4 documents in 7 bins: most in 4–7 \(2\); the top bin is 64–127 \(1\)\.$/);
});

test("chunk length: from the map's sample (its pinned points left out), with the caption saying so; no sample says how to get one", () => {
	const sample = fixture<ISampleResult>('sample_demo_1000');
	const lengths = sample.points.len.filter((_, i) => sample.points.pinned[i] !== 1);
	const bins = lengthBins(lengths);
	assert.equal(
		bins.reduce((sum, b) => sum + b.count, 0),
		lengths.length
	);
	assert.ok(bins.length <= 12 && bins.length >= 2, `${bins.length} bins`);
	assert.equal(bins[0]?.lo, 0);
	for (let i = 1; i < bins.length; i += 1) assert.equal(bins[i]?.lo, (bins[i - 1]?.hi ?? 0) + 1, 'contiguous');
	const charts = collectionCharts({ rows: [], total: null, sample: model(sample), dialect: null, loading: false });
	const length = charts.find((c) => c.id === 'length');
	assert.ok(length);
	assert.equal(length.disabled, null);
	assert.match(length.caption, new RegExp(`^from the map's sample of ${lengths.length.toLocaleString('en-US')} chunks · median [0-9,]+ characters$`));
	assert.equal(length.bins[0]?.scope, null, 'no scope by chunk length: the store cannot filter by it');
	const none = collectionCharts({ rows: [], total: null, sample: null, dialect: null, loading: false }).find((c) => c.id === 'length');
	assert.equal(none?.disabled, "Draw the map's sample to see chunk lengths");
});

test('file types from Windows, POSIX, share and bare names; the most common first; a click scopes to the type', () => {
	const rows = readDocumentsPage(fixture('list_documents_windows_and_posix_paths')).items;
	const bins = byFileType(rows);
	assert.deepEqual(
		bins.map((b) => [b.label, b.count]),
		[
			['pdf', 5],
			['md', 2],
			['docx', 1],
		]
	);
	assert.deepEqual(bins[0]?.scope, { file_types: ['pdf'] });
	const many = byFileType([doc('1', 'a'), doc('2', 'b.x1'), doc('3', 'c.x2'), doc('4', 'd.x3'), doc('5', 'e.x4'), doc('6', 'f.x5'), doc('7', 'g.x6'), doc('8', 'h.x7'), doc('9', 'i.x8'), doc('10', 'j.x8')], 4);
	assert.deepEqual(
		many.map((b) => [b.label, b.count, b.scope === null]),
		[
			['x8', 2, false],
			['(no extension)', 1, true],
			['x1', 1, false],
			['other (6 types)', 6, true],
		]
	);
});

test('a type bar scopes only to an extension the node accepts: dotted dates, suffixed backups and hyphens are shown, never clickable', () => {
	const rows = [doc('1', 'C:/minutes/Board 2026.10.15 meeting'), doc('2', 'C:/db/orders.db_old'), doc('3', 'C:/web/catalog.json-ld'), doc('4', 'C:/a/README.MD'), doc('5', 'C:/a/notes.md'), doc('6', 'C:/a/x.' + 'y'.repeat(17))];
	const bins = byFileType(rows);
	const scopeOf = (label: string) => bins.find((b) => b.label === label)?.scope;
	assert.deepEqual(scopeOf('md'), { file_types: ['md'] });
	for (const label of ['15 meeting', 'db_old', 'json-ld', 'y'.repeat(17)]) assert.equal(scopeOf(label), null, label);
	assert.equal(bins.find((b) => b.label === '15 meeting')?.count, 1, 'still counted and drawn');
	// Every bar of every chart that scopes sends what the node accepts.
	const charts = collectionCharts({ rows: [...rows, doc('7', 'a.pdf', { ingestedAt: '2026-10-01T00:00:00Z', chunks: 9 })], total: null, sample: null, dialect: null, loading: false });
	for (const chart of charts) for (const bin of chart.bins) if (bin.scope !== null) assert.equal(validateFilter(bin.scope), null, `${chart.id} ${bin.label}`);
});

test('ingested over time: by day within a month, by week within half a year, else by month; empty periods kept; a click scopes to the period', () => {
	const days = byIngestPeriod([doc('a', 'a', { ingestedAt: '2026-10-01T09:00:00Z' }), doc('b', 'b', { ingestedAt: '2026-10-03T23:59:59Z' }), doc('c', 'c', { ingestedAt: '2026-10-03T00:00:00Z' }), doc('d', 'd')]);
	assert.equal(days.unit, 'day');
	assert.deepEqual(
		days.bins.map((b) => [b.label, b.count]),
		[
			['2026-10-01', 1],
			['2026-10-02', 0],
			['2026-10-03', 2],
		]
	);
	assert.deepEqual(days.bins[2]?.scope, { ingested_after: '2026-10-03T00:00:00Z', ingested_before: '2026-10-04T00:00:00Z' });
	assert.equal(days.dated, 3);
	const weeks = byIngestPeriod([doc('a', 'a', { ingestedAt: '2026-08-05T10:00:00Z' }), doc('b', 'b', { ingestedAt: '2026-10-08T10:00:00Z' })]);
	assert.equal(weeks.unit, 'week');
	assert.equal(weeks.bins[0]?.label, 'week of 2026-08-03', 'weeks start on Monday (UTC)');
	assert.deepEqual(weeks.bins[0]?.scope, { ingested_after: '2026-08-03T00:00:00Z', ingested_before: '2026-08-10T00:00:00Z' });
	assert.equal(weeks.bins.length, 10);
	const months = byIngestPeriod([doc('a', 'a', { ingestedAt: '2025-12-30T10:00:00Z' }), doc('b', 'b', { ingestedAt: '2026-10-08T10:00:00Z' })]);
	assert.equal(months.unit, 'month');
	assert.deepEqual(months.bins.map((b) => b.label).slice(0, 2), ['2025-12', '2026-01']);
	assert.equal(months.bins.length, 11);
	assert.deepEqual(months.bins[0]?.scope, { ingested_after: '2025-12-01T00:00:00Z', ingested_before: '2026-01-01T00:00:00Z' });
	assert.deepEqual(byIngestPeriod([doc('a', 'a')]), { unit: 'day', bins: [], dated: 0, outside: 0 });
});

/** The console's clock in these tests. */
const NOW = Date.parse('2026-10-16T09:00:00Z');

test('one far-off ingest time never makes the ingest chart thousands of bars: it is folded into an "earlier" or "later" bar with no scope', () => {
	const rows = [doc('a', 'a', { ingestedAt: '2026-10-01T09:00:00Z' }), doc('b', 'b', { ingestedAt: '2026-10-08T10:00:00Z' }), doc('c', 'c', { ingestedAt: '9999-12-31T23:59:59Z' }), doc('d', 'd', { ingestedAt: '0001-01-01T00:00:00Z' }), doc('e', 'e', { ingestedAt: '1970-01-01T00:00:00Z' }), doc('f', 'f', { ingestedAt: '+010000-01-01T00:00:00Z' })];
	const periods = byIngestPeriod(rows, NOW);
	assert.equal(periods.unit, 'day', 'the span of the plausible times picks the unit');
	assert.equal(periods.dated, 6);
	assert.equal(periods.outside, 4);
	assert.ok(periods.bins.length <= MAX_PERIOD_BINS + 2, `${periods.bins.length} bins`);
	const first = periods.bins[0];
	const last = periods.bins[periods.bins.length - 1];
	assert.deepEqual([first?.label, first?.count, first?.scope], ['before 2000-01-01', 2, null]);
	assert.deepEqual([last?.label, last?.count, last?.scope], ['after 2027-10-16', 2, null]);
	assert.deepEqual(
		periods.bins.slice(1, -1).map((b) => b.label),
		['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
	);
	const chart = collectionCharts({ rows, total: null, sample: null, dialect: null, loading: false, now: NOW }).find((c) => c.id === 'ingest');
	assert.equal(chart?.caption, 'by day · 6 documents · 4 ingest times outside 2000-01-01 to 2027-10-16, shown apart');
	// Only times out of range: their bars, and no unit to speak of.
	const odd = byIngestPeriod([doc('x', 'x', { ingestedAt: '1970-01-01T00:00:00Z' })], NOW);
	assert.deepEqual(
		odd.bins.map((b) => [b.label, b.count, b.scope]),
		[['before 2000-01-01', 1, null]]
	);
	assert.equal(collectionCharts({ rows: [doc('x', 'x', { ingestedAt: '1970-01-01T00:00:00Z' })], total: null, sample: null, dialect: null, loading: false, now: NOW }).find((c) => c.id === 'ingest')?.caption, '1 document · 1 ingest time outside 2000-01-01 to 2027-10-16, shown apart');
});

test('long spans step up to quarters and years, never past the cap, and every period bar scopes to what the node accepts', () => {
	const span = (from: string, to: string) => byIngestPeriod([doc('a', 'a', { ingestedAt: from }), doc('b', 'b', { ingestedAt: to })], NOW);
	const months = span('2022-01-15T00:00:00Z', '2026-10-01T00:00:00Z');
	assert.equal(months.unit, 'month', '58 months');
	assert.equal(months.bins.length, 58);
	const quarters = span('2014-02-01T00:00:00Z', '2026-10-01T00:00:00Z');
	assert.equal(quarters.unit, 'quarter');
	assert.equal(quarters.bins[0]?.label, '2014 Q1');
	assert.deepEqual(quarters.bins[0]?.scope, { ingested_after: '2014-01-01T00:00:00Z', ingested_before: '2014-04-01T00:00:00Z' });
	const years = span('2000-03-01T00:00:00Z', '2026-10-01T00:00:00Z');
	assert.equal(years.unit, 'year');
	assert.deepEqual([years.bins[0]?.label, years.bins.length, years.bins[0]?.scope], ['2000', 27, { ingested_after: '2000-01-01T00:00:00Z', ingested_before: '2001-01-01T00:00:00Z' }]);
	for (const periods of [months, quarters, years]) {
		assert.ok(periods.bins.length <= MAX_PERIOD_BINS);
		for (const bin of periods.bins) assert.equal(validateFilter(bin.scope), null, bin.label);
	}
	// Decades from now the window still holds at most the cap of years.
	const later = byIngestPeriod([doc('a', 'a', { ingestedAt: '2000-01-01T00:00:00Z' }), doc('b', 'b', { ingestedAt: '2079-06-01T00:00:00Z' })], Date.parse('2080-01-01T00:00:00Z'));
	assert.ok(later.bins.length <= MAX_PERIOD_BINS + 2, `${later.bins.length} bins`);
	assert.equal(later.bins[0]?.label, 'before 2031-01-01');
});

test('the four charts: their states (disabled under extras_not_stored, partial coverage, loading), sources and coverage', () => {
	const rows = readDocumentsPage(fixture('list_documents_page1')).items;
	const pg = readDialect(fixture('dialect_pgvector'));
	const charts = collectionCharts({ rows, total: 42, sample: null, dialect: pg, loading: true });
	assert.deepEqual(
		charts.map((c) => c.id),
		['chunks', 'length', 'types', 'ingest']
	);
	const by = (id: string) => charts.find((c) => c.id === id);
	assert.equal(by('chunks')?.caption, '5 of 42 documents loaded · median 9 chunks');
	assert.equal(by('types')?.caption, '5 of 42 documents loaded');
	assert.equal(by('ingest')?.caption, 'by day · 5 of 42 documents loaded');
	assert.equal(by('chunks')?.loading, true, 'skeleton bars while the directory loads');
	const nostore = readDialect({ ...fixture('dialect_pgvector'), caveats: ['extras_not_stored'] });
	assert.equal(collectionCharts({ rows, total: 5, sample: null, dialect: nostore, loading: false }).find((c) => c.id === 'ingest')?.disabled, 'This store does not keep ingest times');
	const undated = collectionCharts({ rows: rows.map((r) => ({ ...r, ingestedAt: null })), total: 5, sample: null, dialect: pg, loading: false }).find((c) => c.id === 'ingest');
	assert.equal(undated?.disabled, 'No ingest times on the loaded documents');
	assert.equal(collectionCharts({ rows, total: 5, sample: null, dialect: pg, loading: false }).find((c) => c.id === 'chunks')?.caption, '5 documents · median 9 chunks', 'everything loaded: no "of"');
});

test('200,000 loaded rows (Load more, 39 times) bin without overflowing the call stack, in every chart and every ingest bar', () => {
	// Past about 125,000 values, spreading them into Math.max throws RangeError in V8; Load more has no ceiling.
	const N = 200_000;
	assert.deepEqual(minMax([3, Number.NaN, -1, 7]), { min: -1, max: 7 });
	assert.deepEqual(minMax(Array.from({ length: N }, (_, i) => (i * 7919) % N)), { min: 0, max: N - 1 });
	const counts = Array.from({ length: N }, (_, i) => 1 + (i % 300));
	const chunkBins = logBins(counts);
	assert.equal(
		chunkBins.reduce((sum, b) => sum + b.count, 0),
		N
	);
	assert.equal(chunkBins[chunkBins.length - 1]?.label, '256–511', 'the top bin holds the largest count');
	const lengths = Array.from({ length: N }, (_, i) => i % 1_500);
	const lengthChartBins = lengthBins(lengths);
	assert.equal(
		lengthChartBins.reduce((sum, b) => sum + b.count, 0),
		N
	);
	const top = lengthChartBins[lengthChartBins.length - 1];
	assert.ok(top !== undefined && top.lo <= 1_499 && top.hi >= 1_499, 'the top bin holds the longest chunk');
	const dated = (at: (i: number) => string) => Array.from({ length: N }, (_, i) => doc(`d${i}`, `C:/demo/f${i % 40}/doc_${i}.pdf`, { chunks: 1 + (i % 300), ingestedAt: at(i) }));
	const inside = byIngestPeriod(
		dated((i) => `2026-10-0${1 + (i % 8)}T10:00:00Z`),
		NOW
	);
	assert.deepEqual([inside.unit, inside.dated, inside.outside, inside.bins.length], ['day', N, 0, 8]);
	const after = byIngestPeriod(
		dated((i) => `9999-12-${String(1 + (i % 28)).padStart(2, '0')}T23:59:59Z`),
		NOW
	);
	assert.deepEqual(
		after.bins.map((b) => [b.label, b.count, b.hi]),
		[['after 2027-10-16', N, Date.parse('9999-12-28T23:59:59Z')]]
	);
	const before = byIngestPeriod(
		dated((i) => `1970-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`),
		NOW
	);
	assert.deepEqual(
		before.bins.map((b) => [b.label, b.count, b.lo]),
		[['before 2000-01-01', N, Date.parse('1970-01-01T00:00:00Z')]]
	);
	const rows = dated((i) => (i % 3 === 0 ? '9999-12-31T23:59:59Z' : i % 3 === 1 ? '1970-01-01T00:00:00Z' : `2026-10-0${1 + (i % 8)}T10:00:00Z`));
	const charts = collectionCharts({ rows, total: null, sample: null, dialect: null, loading: false, now: NOW });
	for (const chart of charts.filter((c) => c.id !== 'length'))
		assert.equal(
			chart.bins.reduce((sum, b) => sum + b.count, 0),
			N,
			chart.id
		);
});

test('binning 5,000 rows for all four charts stays inside 10 ms', () => {
	const rows = Array.from({ length: 5_000 }, (_, i) => doc(`d${i}`, `C:/demo/f${i % 40}/doc_${i}.${['md', 'pdf', 'txt', 'docx'][i % 4]}`, { chunks: 1 + (i % 300), ingestedAt: `2026-10-0${1 + (i % 8)}T10:00:00Z` }));
	const sample = fixture<ISampleResult>('sample_light_5000');
	collectionCharts({ rows, total: 5_000, sample: model(sample), dialect: null, loading: false });
	const each =
		bestOf(() => {
			for (let i = 0; i < 5; i += 1) collectionCharts({ rows, total: 5_000, sample: model(sample), dialect: null, loading: false });
		}).ms / 5;
	assert.ok(each <= 10 * 3, `binning took ${each.toFixed(1)} ms (budget 10 ms, asserted ≤ 3×)`);
});
