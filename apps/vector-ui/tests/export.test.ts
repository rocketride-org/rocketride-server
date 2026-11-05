// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXPORT: CSV and JSON of what the map, the directory and the search show
// =============================================================================
//
// vector/export.ts turns the rows a host shows into a file: CSV (RFC 4180,
// with a guard for cells a spreadsheet would run as a formula) or JSON
// (schema_version 1), named vector-explorer_<collection>_<kind>_<stamp>.<ext>.
// Every check that matters for privacy reads the produced Blob itself: a row
// carrying a stored vector or a token must leave neither in the file.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXPORT_COLUMNS } from '../src/contract/types';
import type { IDocumentItem, IExportItem, IExportRows, ISampleResult, VectorKey } from '../src/contract/types';
import { ExportMenu, ExportMenuPanel, popoverSide, stepFocus } from '../src/components/ExportMenu';
import { BLOCKED_SENTENCE, EXPORT_SCHEMA_VERSION, LARGE_EXPORT_ROWS, MAP_NOT_DRAWN, NOTHING_SELECTED, cleanRows, documentExportItems, documentRows, fileName, guardCell, keyRows, mapExportItems, pointRows, runExport, searchExportItems, searchRows, toCsv, toJson } from '../src/vector/export';
import type { ISearchExportRow } from '../src/vector/export';
import { fixture } from './support/fixtures';
import { loadSample, modelOf } from './support/map.samples';

/** 2026-10-15 09:05 local time (the file-name stamp reads local time). */
const AT = new Date(2026, 9, 15, 9, 5, 30);

/**
 * Parse RFC 4180 text (the test's own reader, independent of the writer).
 *
 * @param text - The file.
 * @returns Records of fields.
 */
function parseCsv(text: string): string[][] {
	const records: string[][] = [];
	let field = '';
	let record: string[] = [];
	let quoted = false;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i] as string;
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i += 1;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"' && field === '') quoted = true;
		else if (c === ',') {
			record.push(field);
			field = '';
		} else if (c === '\r' && text[i + 1] === '\n') {
			record.push(field);
			records.push(record);
			record = [];
			field = '';
			i += 1;
		} else field += c;
	}
	if (field !== '' || record.length > 0) {
		record.push(field);
		records.push(record);
	}
	return records;
}

/**
 * Runs of at least `min` decimal numbers in a text (a vector written out as text).
 *
 * @param text - The file.
 * @param min - The shortest run that counts.
 * @returns The runs found.
 */
function floatRuns(text: string, min = 8): string[] {
	const runs: string[] = [];
	const re = /-?\d+\.\d+(?:[\s,;"\][]+-?\d+\.\d+){7,}/g;
	for (const match of text.match(re) ?? []) if ((match.match(/-?\d+\.\d+/g) ?? []).length >= min) runs.push(match);
	return runs;
}

/** A capturing download: what the export handed to the browser. */
function capture(result = true): { files: Array<{ blob: Blob; name: string }>; download(blob: Blob, name: string): boolean } {
	const files: Array<{ blob: Blob; name: string }> = [];
	return {
		files,
		download(blob: Blob, name: string): boolean {
			files.push({ blob, name });
			return result;
		},
	};
}

/** The cluster fixture as the map holds it. */
function clusterSample(): ISampleResult {
	return fixture<ISampleResult>('sample_demo_1000_clusters');
}

/** The CSV body of a file (without the byte-order mark). */
async function csvText(blob: Blob): Promise<string> {
	const text = await blob.text();
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// -----------------------------------------------------------------------------
// CSV and JSON writers
// -----------------------------------------------------------------------------

test('CSV quotes a field holding a comma, a quote or a line break (RFC 4180), with CRLF records and the columns first', () => {
	const rows: IExportRows = {
		columns: ['a', 'b', 'c', 'd', 'e'],
		rows: [
			{ a: 'plain', b: 'with, comma', c: 'say "hi"', d: 'two\nlines', e: 'cr\rhere' },
			{ a: 1.5, b: true, c: null, d: false, e: 0 },
		],
	};
	const text = toCsv(rows);
	assert.ok(text.startsWith('a,b,c,d,e\r\n'), 'the header row comes first');
	assert.match(text, /^plain,"with, comma","say ""hi""","two\nlines","cr\rhere"\r\n/m);
	assert.match(text, /\r\n1\.5,true,,false,0\r\n$/);
	assert.deepEqual(parseCsv(text), [
		['a', 'b', 'c', 'd', 'e'],
		['plain', 'with, comma', 'say "hi"', 'two\nlines', 'cr\rhere'],
		['1.5', 'true', '', 'false', '0'],
	]);
});

test('a text cell starting with = + - @ (or a tab or carriage return) is guarded; numbers stay numbers', () => {
	for (const bad of ['=SUM(A1:A9)', '+cmd', '-2+3', '@SUM(1)', '\tx', '\rx']) assert.equal(guardCell(bad), `'${bad}`, JSON.stringify(bad));
	for (const fine of ['C:/demo/a.md', 'falcon · orchid', '', "'quoted"]) assert.equal(guardCell(fine), fine);
	const text = toCsv({
		columns: ['t', 'n'],
		rows: [
			{ t: '=HYPERLINK("http://x","y")', n: -0.25 },
			{ t: '-1,5', n: -3 },
		],
	});
	const records = parseCsv(text);
	assert.deepEqual(records[1], ['\'=HYPERLINK("http://x","y")', '-0.25']);
	assert.deepEqual(records[2], ["'-1,5", '-3']);
});

test('JSON carries schema_version 1, the kind, the collection, the columns and the rows in column order (unguarded)', () => {
	const rows: IExportRows = { columns: ['b', 'a'], rows: [{ a: '=1', b: 2, extra: 'not a column' }] };
	const parsed = JSON.parse(toJson(rows, { kind: 'selection', collection: 'vx_demo_docs', exportedAt: AT }));
	assert.equal(parsed.schema_version, EXPORT_SCHEMA_VERSION);
	assert.equal(EXPORT_SCHEMA_VERSION, 1);
	assert.equal(parsed.kind, 'selection');
	assert.equal(parsed.collection, 'vx_demo_docs');
	assert.equal(parsed.exported_at, AT.toISOString());
	assert.deepEqual(parsed.columns, ['b', 'a']);
	assert.equal(parsed.count, 1);
	assert.deepEqual(Object.keys(parsed.rows[0]), ['b', 'a'], 'only the columns, in their order');
	assert.equal(parsed.rows[0].a, '=1', 'JSON is not a spreadsheet: values are written as they are');
	const none = JSON.parse(toJson({ columns: ['a'], rows: [] }, { kind: 'documents', collection: null, exportedAt: AT }));
	assert.deepEqual([none.count, none.rows, none.collection], [0, [], null]);
});

test('file names: vector-explorer_<collection>_<kind>_<yyyymmdd-hhmm>.<ext>, the collection made safe', () => {
	assert.equal(fileName('vx_demo_docs', 'selection', 'csv', AT), 'vector-explorer_vx_demo_docs_selection_20261015-0905.csv');
	assert.equal(fileName('vx_demo_docs', 'map', 'png', AT), 'vector-explorer_vx_demo_docs_map_20261015-0905.png');
	assert.equal(fileName(null, 'documents', 'json', AT), 'vector-explorer_collection_documents_20261015-0905.json');
	assert.equal(fileName('  ', 'search', 'csv', AT), 'vector-explorer_collection_search_20261015-0905.csv');
	assert.equal(fileName('team/a b:c*?"<>|', 'points', 'csv', AT), 'vector-explorer_team-a-b-c_points_20261015-0905.csv');
	assert.equal(fileName('x'.repeat(200), 'points', 'csv', AT).length, 'vector-explorer__points_20261015-0905.csv'.length + 64);
});

// -----------------------------------------------------------------------------
// Rows: never a vector, a token or more text than a snippet
// -----------------------------------------------------------------------------

test('a row carrying a stored vector and a token leaves neither in the CSV or the JSON (the produced files are read)', async () => {
	const embedding = Array.from({ length: 384 }, (_, i) => Math.sin(i + 0.5) / 3);
	// A stand-in for a session token, assembled so secret scanners do not mistake the test for a leak.
	const token = ['fake', 'session', 'marker', '42'].join('-');
	const row = { objectId: 'o1', chunkId: 0, path: 'C:/demo/a.md', snippet: 'falcon station water', embedding, vector: embedding, token, api_key: token, meta: { token, embedding } };
	const item: IExportItem = {
		id: 'leaky',
		label: 'Leaky rows',
		kind: 'points',
		disabled: null,
		rows: () => ({ columns: ['objectId', 'chunkId', 'path', 'snippet', 'embedding', 'vector', 'token', 'api_key', 'meta'], rows: [row as never] }),
	};
	for (const format of ['csv', 'json'] as const) {
		const sink = capture();
		const outcome = await runExport(item, format, { collection: 'vx_demo_docs', now: () => AT, download: sink.download });
		assert.equal(outcome.status, 'done');
		const text = await sink.files[0]!.blob.text();
		assert.deepEqual(floatRuns(text), [], `${format}: no run of 8 or more decimals`);
		assert.ok(!text.includes(token), `${format}: the token is not in the file`);
		assert.ok(!/embedding|"vector"|token|api_key/.test(text), `${format}: the vector and secret columns are dropped`);
		assert.ok(text.includes('falcon station water') && text.includes('C:/demo/a.md'), `${format}: the words are kept`);
	}
});

test('cleanRows drops vector and secret columns, writes non-scalar cells as empty and clamps content to snippet_chars', () => {
	const long = 'w'.repeat(500);
	const cleaned = cleanRows({ columns: ['path', 'snippet', 'preview', 'values', 'password', 'list', 'n'], rows: [{ path: 'C:/a.md', snippet: long, preview: long, values: [0.1, 0.2] as never, password: 'p', list: [1, 2, 3] as never, n: Number.NaN }] }, { snippetChars: 120 });
	assert.deepEqual(cleaned.columns, ['path', 'snippet', 'preview', 'list', 'n']);
	const r = cleaned.rows[0]!;
	assert.equal((r.snippet as string).length, 120);
	assert.ok((r.snippet as string).endsWith('…'));
	assert.equal((r.preview as string).length, 120);
	assert.equal(r.list, null);
	assert.equal(r.n, null, 'a number that is not finite is empty');
});

test("an export keeps the store's snippet length its rows were built with; rows built by hand are clamped at the node default", async () => {
	const base = clusterSample();
	const snip = Array.from({ length: base.n }, (_, i) => `${i} ${'s'.repeat(280)}`.slice(0, 280));
	const sample = { ...base, points: { ...base.points, snip } };
	const built: IExportItem = { id: 'built', label: 'Built', kind: 'points', disabled: null, rows: () => pointRows({ sample, snippetChars: 300, indices: [0, 1] }) };
	const sink = capture();
	await runExport(built, 'json', { collection: 'c', now: () => AT, download: sink.download });
	const parsed = JSON.parse(await sink.files[0]!.blob.text());
	assert.equal(parsed.rows[0].snippet.length, 280, 'a 280-character snippet under snippet_chars 300 is kept whole');
	const byHand: IExportItem = { id: 'hand', label: 'Hand', kind: 'search', disabled: null, rows: () => ({ columns: ['preview'], rows: [{ preview: 'q'.repeat(500) }] }) };
	const hand = capture();
	await runExport(byHand, 'json', { collection: 'c', now: () => AT, download: hand.download });
	assert.equal(JSON.parse(await hand.files[0]!.blob.text()).rows[0].preview.length, 120, 'full text a host handed over is cut to the default snippet length');
});

test('budget: the CSV of 5,000 points is written in at most 50 ms', () => {
	const light = loadSample('sample_light_5000.json');
	const snip = Array.from({ length: light.n }, (_, i) => `chunk ${i}, with "quotes" and commas, about as long as a snippet is allowed to be by the node……`);
	const sample = { ...light, points: { ...light.points, snip } };
	assert.equal(sample.n, 5000);
	let best = Number.POSITIVE_INFINITY;
	let text = '';
	for (let run = 0; run < 3; run += 1) {
		const t0 = performance.now();
		text = toCsv(pointRows({ sample, snippetChars: 120 }), { snippetChars: 120 });
		best = Math.min(best, performance.now() - t0);
	}
	assert.equal(parseCsv(text).length, 5001);
	assert.ok(best <= 50, `CSV of 5,000 points took ${best.toFixed(1)} ms`);
});

// -----------------------------------------------------------------------------
// The hosts' rows
// -----------------------------------------------------------------------------

test('point rows: the frozen column set, one row per point, matching the sample', () => {
	const sample = clusterSample();
	const sims = Float32Array.from({ length: sample.n }, (_, i) => i / sample.n);
	const rows = pointRows({ sample, snippetChars: 120, querySimilarity: sims });
	assert.deepEqual([...rows.columns], [...EXPORT_COLUMNS.points]);
	assert.equal(rows.rows.length, sample.n);
	const dup = new Set(sample.duplicates.flatMap((d) => [d.a, d.b]));
	const out = new Set(sample.outliers);
	for (const i of [0, 1, 72, sample.outliers[0] as number, sample.n - 1]) {
		const row = rows.rows[i]!;
		const doc = sample.docs[sample.points.doc[i] as number]!;
		assert.equal(row.objectId, doc.objectId);
		assert.equal(row.chunkId, sample.points.chunk[i]);
		assert.equal(row.path, doc.path);
		assert.equal(row.chunk_index, i, 'chunk_index is the point number in the sample (the map and the table use it)');
		assert.equal(row.length, sample.points.len[i]);
		assert.equal(row.density, sample.density[i]);
		assert.equal(row.is_duplicate, dup.has(i));
		assert.equal(row.is_outlier, out.has(i));
		assert.equal(row.x, sample.points.x[i]);
		assert.equal(row.y, sample.points.y[i]);
		assert.equal(row.z, sample.points.z?.[i] ?? null);
		assert.equal(row.snippet, sample.points.snip?.[i]);
		assert.ok(Math.abs((row.query_similarity as number) - (sims[i] as number)) < 1e-6);
		const label = sample.clusters!.labels[i] as number;
		assert.equal(row.cluster, label < 0 ? null : label);
		assert.equal(row.cluster_label, label < 0 ? null : (sample.clusters!.keywords[label] ?? []).join(' · ') || `group ${label}`);
	}
});

test('point rows follow the layout on screen, the folded clusters and the hidden points', () => {
	const sample = clusterSample();
	const xy = Float32Array.from({ length: sample.n * 2 }, (_, i) => i);
	const labels = Int32Array.from(sample.clusters!.labels, (l) => (l === 0 ? -1 : l));
	const hidden = new Uint8Array(sample.n);
	hidden[3] = 1;
	const rows = pointRows({ sample, snippetChars: 120, positions: { xy, dims: 2 }, clusterLabels: labels, clusterName: (c) => `c${c}`, hidden });
	assert.equal(rows.rows.length, sample.n - 1, 'a hidden point is not exported');
	const first = rows.rows[0]!;
	assert.deepEqual([first.x, first.y, first.z], [0, 1, null], 'x and y are where the point is drawn; z is empty in 2D');
	const zeroIdx = sample.clusters!.labels.findIndex((l) => l === 0);
	const zeroRow = rows.rows.find((r) => r.chunk_index === zeroIdx)!;
	assert.equal(zeroRow.cluster, null, 'a group folded into noise has no cluster');
	const other = rows.rows.find((r) => typeof r.cluster === 'number')!;
	assert.equal(other.cluster_label, `c${other.cluster}`);
	const light = loadSample('sample_light_5000.json');
	assert.equal(pointRows({ sample: light, snippetChars: 120, indices: [0] }).rows[0]!.snippet, null, 'light samples carry no text');
});

test('selection rows: one row per selected key, in the Selection tab order, a key outside the sample kept with its ids', () => {
	const sample = clusterSample();
	const key = (i: number): VectorKey => [sample.docs[sample.points.doc[i] as number]!.objectId, sample.points.chunk[i] as number];
	const keys: VectorKey[] = [key(5), key(2), ['gone-object', 4], key(9)];
	const rows = keyRows({ sample, keys, snippetChars: 120 });
	assert.equal(rows.rows.length, 4);
	assert.deepEqual(
		rows.rows.map((r) => [r.objectId, r.chunkId]),
		keys.map((k) => [k[0], k[1]])
	);
	assert.equal(rows.rows[0]!.chunk_index, 5);
	assert.equal(rows.rows[2]!.path, null);
	assert.equal(rows.rows[2]!.chunk_index, null);
});

test('document rows: the frozen column set and the loaded rows as the directory holds them', () => {
	const items = fixture<{ items: IDocumentItem[] }>('list_documents_page1').items;
	const rows = documentRows(items);
	assert.deepEqual([...rows.columns], [...EXPORT_COLUMNS.documents]);
	assert.equal(rows.rows.length, items.length);
	const first = items[0]!;
	assert.deepEqual(rows.rows[0], {
		objectId: first.objectId,
		path: first.path,
		chunks: first.chunks,
		has_first_chunk: first.has_first_chunk,
		tables: first.tables,
		size: first.size,
		ingestedAt: first.ingestedAt,
		deleted_chunks: first.deleted_chunks ?? null,
		max_chunk_id: first.max_chunk_id ?? null,
	});
});

test('search rows: the frozen column set, status words, cited and the preview clamped', () => {
	const results: ISearchExportRow[] = [
		{ rank: 1, objectId: 'o1', chunkId: 0, path: 'C:/a.md', score: 0.91, rawScore: 0.09, status: 'used', inAnswer: true, preview: 'p'.repeat(400) },
		{ rank: 2, objectId: 'o2', chunkId: 3, path: 'C:/b.md', score: 0.31, rawScore: null, status: 'near_miss', inAnswer: false, preview: '=cmd' },
		{ rank: 3, objectId: 'o3', chunkId: 1, path: 'C:/c.md', score: 0.1, rawScore: null, status: 'below_floor', inAnswer: false, preview: '' },
	];
	const rows = searchRows(results, { snippetChars: 120 });
	assert.deepEqual([...rows.columns], [...EXPORT_COLUMNS.search]);
	assert.deepEqual(
		rows.rows.map((r) => [r.rank, r.objectId, r.chunkId, r.status, r.cited]),
		[
			[1, 'o1', 0, 'used', true],
			[2, 'o2', 3, 'below threshold', false],
			[3, 'o3', 1, 'below floor', false],
		]
	);
	assert.equal((rows.rows[0]!.preview as string).length, 120);
	const both = searchExportItems({ a: { question: 'water', rows: results }, b: { question: 'orchids', rows: results.slice(0, 1) }, snippetChars: 120 });
	assert.deepEqual(
		both.map((i) => [i.id, i.kind, i.disabled]),
		[
			['search-a', 'search', null],
			['search-b', 'search', null],
			['search-both', 'search', null],
		]
	);
	const all = both[2]!.rows!();
	assert.deepEqual([...all.columns], ['query', ...EXPORT_COLUMNS.search]);
	assert.deepEqual(
		all.rows.map((r) => r.query),
		['A', 'A', 'A', 'B']
	);
	const onlyA = searchExportItems({ a: { question: 'water', rows: [] }, b: null, snippetChars: 120 });
	assert.deepEqual(
		onlyA.map((i) => [i.id, i.disabled]),
		[['search-a', 'No results to export']]
	);
});

test('the map toolbar items: sample, lasso selection, visible points, clusters, duplicates, outliers and the map picture', () => {
	const sample = clusterSample();
	const model = modelOf(sample);
	const png = async (): Promise<Blob | null> => new Blob(['x'], { type: 'image/png' });
	const items = mapExportItems({ sample: model, selection: [], snippetChars: 120, png, pngDisabled: null });
	assert.deepEqual(
		items.map((i) => i.id),
		['map-sample', 'map-selection', 'map-visible', 'map-clusters', 'map-duplicates', 'map-outliers', 'map-png']
	);
	const byId = new Map(items.map((i) => [i.id, i]));
	assert.equal(byId.get('map-selection')!.disabled, NOTHING_SELECTED);
	assert.equal(byId.get('map-selection')!.kind, 'selection');
	assert.equal(byId.get('map-sample')!.rows!().rows.length, sample.n);
	assert.equal(byId.get('map-clusters')!.rows!().rows.length, sample.n - sample.clusters!.noise, 'every point in a group');
	assert.equal(byId.get('map-outliers')!.rows!().rows.length, sample.outliers.length);
	assert.equal(byId.get('map-duplicates')!.rows!().rows.length, new Set(sample.duplicates.flatMap((d) => [d.a, d.b])).size);
	assert.equal(byId.get('map-png')!.kind, 'map');
	assert.equal(typeof byId.get('map-png')!.png, 'function');
	const lost = mapExportItems({ sample: model, selection: [['o', 1]], snippetChars: 120, png, pngDisabled: MAP_NOT_DRAWN });
	assert.equal(lost.find((i) => i.id === 'map-png')!.disabled, 'The map is not drawn right now.');
	assert.equal(lost.find((i) => i.id === 'map-selection')!.disabled, null);
	assert.match(lost.find((i) => i.id === 'map-selection')!.label, /\(1 point\)/);
	const none = mapExportItems({ sample: null, selection: [], snippetChars: 120, png: null, pngDisabled: null });
	assert.ok(
		none.every((i) => i.disabled !== null),
		'without a sample nothing can be exported'
	);
	const hidden = new Uint8Array(sample.n);
	hidden[sample.outliers[0] as number] = 1;
	const removed = mapExportItems({ sample: model, selection: [], snippetChars: 120, png, pngDisabled: null, hidden });
	assert.equal(removed.find((i) => i.id === 'map-outliers')!.rows!().rows.length, sample.outliers.length - 1, 'a hidden point (its document removed) is not in a queue');
	assert.match(removed.find((i) => i.id === 'map-visible')!.label, new RegExp(`\\(${(sample.n - 1).toLocaleString('en-US')}\\)`));
	const plain = mapExportItems({ sample: modelOf(loadSample('sample_demo_1000.json')), selection: [], snippetChars: 120, png, pngDisabled: null });
	assert.match(plain.find((i) => i.id === 'map-clusters')!.disabled ?? '', /clusters/i, 'no clusters in an answer without them');
});

test('the directory items: the loaded documents, and the scope when one applies', () => {
	const items = fixture<{ items: IDocumentItem[] }>('list_documents_page1').items;
	const plain = documentExportItems({ rows: items, scoped: null });
	assert.deepEqual(
		plain.map((i) => [i.id, i.kind, i.disabled]),
		[['documents-loaded', 'documents', null]]
	);
	assert.match(plain[0]!.label, new RegExp(`Loaded documents \\(${items.length}\\)`));
	const scoped = documentExportItems({ rows: items, scoped: { label: 'C:/demo/field/', rows: items.slice(0, 2) } });
	assert.deepEqual(
		scoped.map((i) => i.id),
		['documents-loaded', 'documents-scoped']
	);
	assert.equal(scoped[1]!.rows!().rows.length, 2);
	assert.equal(documentExportItems({ rows: [], scoped: null })[0]!.disabled, 'No documents loaded');
});

// -----------------------------------------------------------------------------
// The run: download, blocked, large, cancelled
// -----------------------------------------------------------------------------

test('an export hands one named file to the browser; its rows match the on-screen rows', async () => {
	const sample = clusterSample();
	const keys: VectorKey[] = [0, 1, 2, 3, 4].map((i) => [sample.docs[sample.points.doc[i] as number]!.objectId, sample.points.chunk[i] as number]);
	const item = mapExportItems({ sample: modelOf(sample), selection: keys, snippetChars: 120, png: null, pngDisabled: null }).find((i) => i.id === 'map-selection')!;
	const sink = capture();
	const outcome = await runExport(item, 'csv', { collection: 'vx_demo_docs', now: () => AT, download: sink.download });
	assert.deepEqual(outcome, { status: 'done', fileName: 'vector-explorer_vx_demo_docs_selection_20261015-0905.csv', rows: 5, bytes: sink.files[0]!.blob.size });
	assert.equal(sink.files.length, 1);
	assert.match(sink.files[0]!.blob.type, /^text\/csv/);
	const records = parseCsv(await csvText(sink.files[0]!.blob));
	assert.deepEqual(records[0], [...EXPORT_COLUMNS.points]);
	assert.deepEqual(
		records.slice(1).map((r) => [r[0], Number(r[1])]),
		keys.map((k) => [k[0], k[1]])
	);
	const json = capture();
	await runExport(item, 'json', { collection: 'vx_demo_docs', now: () => AT, download: json.download });
	assert.equal(json.files[0]!.name, 'vector-explorer_vx_demo_docs_selection_20261015-0905.json');
	assert.match(json.files[0]!.blob.type, /^application\/json/);
	const parsed = JSON.parse(await json.files[0]!.blob.text());
	assert.equal(parsed.rows.length, 5);
	assert.deepEqual(
		parsed.rows.map((r: { objectId: string; chunkId: number }) => [r.objectId, r.chunkId]),
		keys.map((k) => [k[0], k[1]])
	);
});

test('a refused download says the browser blocked it; a disabled item or an empty picture exports nothing', async () => {
	const item: IExportItem = { id: 'x', label: 'X', kind: 'points', disabled: null, rows: () => ({ columns: ['a'], rows: [{ a: 1 }] }) };
	const refused = await runExport(item, 'csv', { collection: 'c', now: () => AT, download: capture(false).download });
	// The written text is kept, so the menu can offer to copy it instead (a dev-tool mount's webview may refuse downloads).
	assert.deepEqual(refused, { status: 'blocked', fileName: 'vector-explorer_c_points_20261015-0905.csv', message: BLOCKED_SENTENCE, copy: { format: 'csv', text: 'a\r\n1\r\n' } });
	assert.equal(BLOCKED_SENTENCE, 'Your browser blocked the download.');
	const thrown = await runExport(item, 'csv', {
		collection: 'c',
		now: () => AT,
		download: () => {
			throw new Error('sandboxed');
		},
	});
	assert.equal(thrown.status, 'blocked');
	const sink = capture();
	assert.deepEqual(await runExport({ ...item, disabled: NOTHING_SELECTED }, 'csv', { collection: 'c', now: () => AT, download: sink.download }), { status: 'unavailable', message: 'Nothing selected' });
	const picture: IExportItem = { id: 'map-png', label: 'Map as PNG', kind: 'map', disabled: null, png: async () => null };
	assert.deepEqual(await runExport(picture, 'png', { collection: 'c', now: () => AT, download: sink.download }), { status: 'unavailable', message: MAP_NOT_DRAWN });
	assert.equal(sink.files.length, 0);
	const drawn: IExportItem = { ...picture, png: async () => new Blob([new Uint8Array(12_000)], { type: 'image/png' }) };
	const done = await runExport(drawn, 'png', { collection: 'c', now: () => AT, download: sink.download });
	assert.deepEqual(done, { status: 'done', fileName: 'vector-explorer_c_map_20261015-0905.png', rows: null, bytes: 12_000 });
});

test('a large export (more than 20,000 rows) reports progress and can be cancelled before anything is downloaded', async () => {
	const total = LARGE_EXPORT_ROWS + 5_000;
	assert.equal(LARGE_EXPORT_ROWS, 20_000);
	const big: IExportItem = { id: 'big', label: 'Big', kind: 'documents', disabled: null, rows: () => ({ columns: ['i'], rows: Array.from({ length: total }, (_, i) => ({ i })) }) };
	const progress: Array<[number, number]> = [];
	const sink = capture();
	const done = await runExport(big, 'csv', { collection: 'c', now: () => AT, download: sink.download, onProgress: (d, t) => progress.push([d, t]), yieldToUi: async () => undefined });
	assert.equal(done.status, 'done');
	assert.ok(progress.length >= 3, 'several progress steps');
	assert.deepEqual(progress[progress.length - 1], [total, total]);
	assert.equal(parseCsv(await csvText(sink.files[0]!.blob)).length, total + 1);
	const json = capture();
	await runExport(big, 'json', { collection: 'c', now: () => AT, download: json.download, yieldToUi: async () => undefined });
	const parsed = JSON.parse(await json.files[0]!.blob.text());
	assert.deepEqual([parsed.count, parsed.rows.length, parsed.rows[total - 1].i], [total, total, total - 1], 'the JSON written in steps is one valid document');
	const signal = { aborted: false };
	const cancelled = capture();
	const outcome = await runExport(big, 'json', {
		collection: 'c',
		now: () => AT,
		download: cancelled.download,
		signal,
		onProgress: (d) => {
			if (d >= 4_000) signal.aborted = true;
		},
		yieldToUi: async () => undefined,
	});
	assert.deepEqual(outcome, { status: 'cancelled', message: 'Export cancelled.' });
	assert.equal(cancelled.files.length, 0);
	const small = capture();
	const quiet: Array<[number, number]> = [];
	await runExport({ ...big, rows: () => ({ columns: ['i'], rows: [{ i: 1 }] }) }, 'csv', { collection: 'c', now: () => AT, download: small.download, onProgress: (d, t) => quiet.push([d, t]) });
	assert.deepEqual(quiet, [], 'a small export shows no progress');
});

// -----------------------------------------------------------------------------
// The menu
// -----------------------------------------------------------------------------

test('the menu: a built component with its button, disabled when there is nothing to export', () => {
	const item: IExportItem = { id: 'documents-loaded', label: 'Loaded documents (3)', kind: 'documents', disabled: null, rows: () => ({ columns: ['a'], rows: [] }) };
	const html = renderToStaticMarkup(React.createElement(ExportMenu, { items: [item], collection: 'vx_demo_docs' }));
	assert.match(html, /data-component="ExportMenu"/);
	assert.doesNotMatch(html, /data-placeholder|Not built yet/);
	assert.match(html, /<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*>Export/);
	const empty = renderToStaticMarkup(React.createElement(ExportMenu, { items: [], collection: null, label: 'Export results' }));
	assert.match(empty, /<button[^>]*disabled=""[^>]*title="Nothing to export"[^>]*>Export results/);
});

test('the open menu lists each item with its formats, and a disabled item with its reason', () => {
	const items: IExportItem[] = [
		{ id: 'map-selection', label: 'Lasso selection', kind: 'selection', disabled: NOTHING_SELECTED, rows: () => ({ columns: [], rows: [] }) },
		{ id: 'map-sample', label: 'The sample (1,000 points)', kind: 'points', disabled: null, rows: () => ({ columns: [], rows: [] }) },
		{ id: 'map-png', label: 'Map as PNG', kind: 'map', disabled: MAP_NOT_DRAWN, png: async () => null },
	];
	const panel = { id: 'p', items, busy: false, status: null, progress: null, onChoose: (): void => undefined, onCancel: (): void => undefined };
	const html = renderToStaticMarkup(React.createElement(ExportMenuPanel, { ...panel, items }));
	assert.match(html, /role="menu" aria-label="Export choices"/);
	assert.match(html, /data-export-item="map-sample"[\s\S]*data-export-format="csv"[\s\S]*data-export-format="json"/);
	assert.equal((html.match(/role="menuitem"/g) ?? []).length, 5, 'one menu item per format: CSV and JSON twice, PNG once');
	assert.match(html, /<div role="group" aria-labelledby="p-item-1"[^>]*data-export-item="map-sample"/);
	assert.match(html, /aria-label="Lasso selection as CSV" aria-describedby="p-why-0"/);
	assert.match(html, /data-export-item="map-selection"[\s\S]*Nothing selected/);
	assert.match(html, /data-export-item="map-png"[\s\S]*The map is not drawn right now\./);
	const sampleRow = html.slice(html.indexOf('data-export-item="map-sample"'), html.indexOf('data-export-item="map-png"'));
	assert.doesNotMatch(sampleRow, /data-export-format="png"/);
	assert.doesNotMatch(sampleRow, /disabled=""/);
	const pngRow = html.slice(html.indexOf('data-export-item="map-png"'));
	assert.match(pngRow, /<button[^>]*disabled=""[^>]*data-export-format="png"|<button[^>]*data-export-format="png"[^>]*disabled=""/);
	const working = renderToStaticMarkup(React.createElement(ExportMenuPanel, { ...panel, items, busy: true, progress: { done: 12_000, total: 40_000 } }));
	assert.match(working, /Preparing 12,000 of 40,000 rows…/);
	assert.match(working, />Cancel</);
	assert.match(working, /aria-busy="true"/);
	assert.match(working, /data-export-item="map-sample"[\s\S]*?aria-disabled="true"/, 'the choices wait while an export runs, without losing focus');
	const blocked = renderToStaticMarkup(React.createElement(ExportMenuPanel, { ...panel, items, status: BLOCKED_SENTENCE }));
	assert.match(blocked, /role="status"[^>]*>Your browser blocked the download\./);
});

test('the menu keys: arrows wrap, Home and End jump, other keys leave focus alone', () => {
	assert.equal(stepFocus(-1, 5, 'ArrowDown'), 0);
	assert.equal(stepFocus(4, 5, 'ArrowDown'), 0);
	assert.equal(stepFocus(1, 5, 'ArrowRight'), 2);
	assert.equal(stepFocus(0, 5, 'ArrowUp'), 4);
	assert.equal(stepFocus(-1, 5, 'ArrowUp'), 4);
	assert.equal(stepFocus(3, 5, 'ArrowLeft'), 2);
	assert.equal(stepFocus(3, 5, 'Home'), 0);
	assert.equal(stepFocus(0, 5, 'End'), 4);
	assert.equal(stepFocus(2, 5, 'a'), null);
	assert.equal(stepFocus(0, 0, 'ArrowDown'), null);
});

test('a menu opens towards the side with room: from the left edge of its button when it fits, else from the right', () => {
	assert.equal(popoverSide(10, 90, 1200, 320), 'left', 'a button at the left edge (the directory)');
	assert.equal(popoverSide(1000, 1080, 1200, 320), 'right', 'a button at the right edge (the toolbar)');
	assert.equal(popoverSide(100, 180, 300, 320), 'left', 'neither fits: the side with more room');
	assert.equal(popoverSide(200, 280, 300, 320), 'right');
});
