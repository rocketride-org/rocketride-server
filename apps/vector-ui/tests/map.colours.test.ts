// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP COLOURS: categories, ramps, the "Other" bucket and outlines
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IDocumentItem, ISampleResult } from '../src/contract/types';
import { COLOUR_MODES, DOCUMENT_ROWS_NONE, TABLE_UNSUPPORTED, TOP_CATEGORIES, categoryOf, colourModeReason, colourPoints, documentHealth } from '../src/map/colours';
import { contrastRatio, parseColor } from '../src/map/contrast';
import { MIN_GRAPHIC_CONTRAST, readPalette } from '../src/map/tokens';
import type { IMapPalette } from '../src/map/tokens';
import { loadSample } from './support/map.samples';

const THEME_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'shell', 'public', 'themes');
const theme = (name: string): IMapPalette => {
	const tokens = JSON.parse(fs.readFileSync(path.join(THEME_DIR, `${name}.json`), 'utf8')) as Record<string, string>;
	return readPalette((token) => tokens[token] ?? '');
};
const demo = loadSample('sample_demo_1000.json');

test('colour by document: the ten largest documents get their own colour, everything else is "Other"', () => {
	const out = colourPoints(demo, 'document', theme('rocketride'));
	assert.equal(out.colours.length, demo.n);
	assert.equal(out.rgba.length, demo.n * 4);
	const named = out.legend.filter((e) => e.key !== 'other');
	assert.equal(named.length, TOP_CATEGORIES);
	// Largest first; counts add up to every point.
	for (let i = 1; i < named.length; i += 1) assert.ok((named[i - 1]?.count as number) >= (named[i]?.count as number));
	assert.equal(out.legend.reduce((s, e) => s + e.count, 0), demo.n);
	assert.equal(named[0]?.label, 'ops_005.pdf');
	assert.equal(named[0]?.count, 70);
	const other = out.legend.find((e) => e.key === 'other');
	assert.equal(other?.label, 'Other (32 documents)');
	// Every point of a document shares its colour.
	const first = demo.points.doc.indexOf(27);
	for (let i = 0; i < demo.n; i += 1) if (demo.points.doc[i] === 27) assert.equal(out.colours[i], out.colours[first]);
	// Same input, same colours.
	assert.deepEqual(colourPoints(demo, 'document', theme('rocketride')).colours, out.colours);
});

test('categories: folder from / or \\ paths, bare names under "Uploaded"; type from the extension', () => {
	assert.equal(categoryOf('folder', 'C:/demo/field/a.md'), 'C:/demo/field');
	assert.equal(categoryOf('folder', 'C:\\share\\b.pdf'), 'C:\\share');
	assert.equal(categoryOf('folder', 'report.pdf'), 'Uploaded');
	assert.equal(categoryOf('type', 'C:/x/Report.PDF'), 'pdf');
	assert.equal(categoryOf('type', 'C:/x/README'), 'no extension');
	const out = colourPoints(demo, 'folder', theme('light'));
	assert.deepEqual(out.legend.map((e) => e.label).sort(), ['C:/demo/field', 'C:/demo/finance', 'C:/demo/greenhouse', 'C:/demo/handbooks', 'C:/demo/legal', 'C:/demo/ops', 'C:/demo/research', 'C:/demo/support']);
	const types = colourPoints(demo, 'type', theme('light'));
	assert.deepEqual(types.legend.map((e) => e.label).sort(), ['docx', 'md', 'pdf', 'txt']);
});

test('ramps: chunk position, density and query similarity map low to high in order, with a legend ramp', () => {
	const palette = theme('rocketride-light');
	const sims = demo.points.x.map((x) => x);
	const byQuery = colourPoints(demo, 'query-similarity', palette, { querySims: sims });
	assert.ok(byQuery.ramp && byQuery.ramp.stops.length >= 5);
	assert.equal(byQuery.ramp?.low, 'least similar');
	assert.equal(byQuery.ramp?.high, 'most similar');
	// The point with the highest similarity gets the last stop, the lowest the first.
	const hi = sims.indexOf(Math.max(...sims));
	const lo = sims.indexOf(Math.min(...sims));
	assert.equal(byQuery.colours[hi], byQuery.ramp?.stops.at(-1));
	assert.equal(byQuery.colours[lo], byQuery.ramp?.stops[0]);
	const noQuery = colourPoints(demo, 'query-similarity', palette);
	assert.equal(noQuery.note, 'Run a text query to colour the points by their similarity to it.');
	assert.equal(new Set(noQuery.colours).size, 1);
	const position = colourPoints(demo, 'chunk-position', palette);
	const firstChunk = demo.points.chunk.indexOf(0);
	assert.equal(position.colours[firstChunk], position.ramp?.stops[0]);
	assert.ok(colourPoints(demo, 'density', palette).ramp);
});

test('a colour below 3:1 on either surface is drawn with an outline; one that clears it is not', () => {
	for (const name of ['light', 'rocketride-light', 'rocketride', 'gray', 'dark', 'visual-studio']) {
		const palette = theme(name);
		const out = colourPoints(demo, 'document', palette);
		const surfaces = [palette.surfaces.default, palette.surfaces.paper].map((c) => parseColor(c)!);
		for (let i = 0; i < demo.n; i += 1) {
			const rgb = parseColor(out.colours[i] as string)!;
			const weak = surfaces.some((s) => contrastRatio(rgb, s) < MIN_GRAPHIC_CONTRAST);
			assert.equal(out.outlined[i], weak ? 1 : 0, `${name}: point ${i} ${out.colours[i]}`);
		}
	}
});

test('hidden points keep their slot but are left out of the legend counts', () => {
	const hidden = new Uint8Array(demo.n);
	for (let i = 0; i < demo.n; i += 1) if (demo.points.doc[i] === 27) hidden[i] = 1;
	const out = colourPoints(demo, 'document', theme('dark'), { hidden });
	assert.equal(out.colours.length, demo.n);
	assert.equal(out.legend.reduce((s, e) => s + e.count, 0), demo.n - 70);
	assert.ok(!out.legend.some((e) => e.label === 'ops_005.pdf'));
});

// -----------------------------------------------------------------------------
// Colour by document details (the console's directory rows) and table chunks
// -----------------------------------------------------------------------------

const clustered = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'provisional', 'sample_demo_1000_clusters.json'), 'utf8')) as ISampleResult;

/** Directory rows for the sample's documents (every other one loaded unless `all`). */
function rowsFor(sample: ISampleResult, fill: (doc: ISampleResult['docs'][number], d: number) => Partial<IDocumentItem>, all = true): Map<string, IDocumentItem> {
	const rows = new Map<string, IDocumentItem>();
	sample.docs.forEach((doc, d) => {
		if (!all && d % 2 === 1) return;
		rows.set(doc.objectId, { objectId: doc.objectId, path: doc.path, chunks: doc.chunks, has_first_chunk: true, tables: 0, deleted: false, nodeId: 'parse_1', size: 1000, modifyTime: null, ingestedAt: '2026-10-01T09:00:00Z', pointId: null, ...fill(doc, d) });
	});
	return rows;
}

/** Visible points per legend row add up to the sample. */
const total = (legend: Array<{ count: number }>): number => legend.reduce((s, e) => s + e.count, 0);

test('colour by ingest date: a ramp from the oldest to the newest ingest day of the loaded documents', () => {
	const rows = rowsFor(demo, (_doc, d) => ({ ingestedAt: d % 3 === 0 ? '2026-10-01T09:00:00Z' : '2026-10-02T17:30:00Z' }));
	const out = colourPoints(demo, 'ingest-date', theme('dark'), { docRows: rows });
	assert.equal(out.note, null);
	assert.equal(out.ramp?.low, 'oldest (2026-10-01)');
	assert.equal(out.ramp?.high, 'newest (2026-10-02)');
	const first = demo.points.doc.findIndex((d) => d % 3 === 0);
	const later = demo.points.doc.findIndex((d) => d % 3 !== 0);
	assert.equal(out.colours[first], out.ramp?.stops[0]);
	assert.equal(out.colours[later], out.ramp?.stops.at(-1));
	// Points whose document the directory has not loaded keep the neutral colour and are counted so.
	const half = colourPoints(demo, 'ingest-date', theme('dark'), { docRows: rowsFor(demo, () => ({}), false) });
	const notLoaded = half.legend.find((e) => e.key === 'not-loaded');
	assert.ok(notLoaded && notLoaded.count > 0);
	assert.equal(notLoaded.count, demo.points.doc.filter((d) => d % 2 === 1).length);
});

test('colour by file size: a log ramp named by the smallest and largest sizes', () => {
	const rows = rowsFor(demo, (_doc, d) => ({ size: 1024 * (d + 1) }));
	const out = colourPoints(demo, 'file-size', theme('light'), { docRows: rows });
	assert.equal(out.ramp?.low, 'smallest (1 KB)');
	assert.equal(out.ramp?.high, `largest (${demo.docs.length} KB)`);
});

test('colour by health: the first flag of each document from its directory row, coloured by a fixed slot', () => {
	const rows = rowsFor(demo, (doc, d) => (d === 0 ? { has_first_chunk: false } : d === 1 ? { max_chunk_id: (doc.chunks ?? 1) + 2 } : d === 2 ? { deleted_chunks: 1, max_chunk_id: (doc.chunks ?? 1) - 1 } : { max_chunk_id: (doc.chunks ?? 1) - 1, deleted_chunks: 0 }));
	const out = colourPoints(demo, 'health', theme('rocketride'), { docRows: rows });
	const labels = out.legend.map((e) => e.label);
	for (const label of ['No first chunk', 'Gaps in chunk numbers', 'Has deleted chunks', 'Nothing to report']) assert.ok(labels.includes(label), `${label} in ${labels.join(', ')}`);
	assert.equal(total(out.legend), demo.n);
	assert.equal(out.legend.find((e) => e.label === 'No first chunk')?.count, demo.points.doc.filter((d) => d === 0).length);
	assert.equal(documentHealth({ ...[...rows.values()][3]!, chunks: 0 }, 10), 'empty');
	assert.equal(documentHealth({ ...[...rows.values()][3]!, chunks: 500, max_chunk_id: 499 }, 10), 'oversize');
	assert.equal(documentHealth({ ...[...rows.values()][3]!, chunks: 500, max_chunk_id: 499 }, null), 'healthy', 'no median, no oversize');
	assert.equal(documentHealth({ ...[...rows.values()][3]!, chunks: 500, max_chunk_id: null }, null), 'healthy', 'a store that does not report max_chunk_id has no gaps flag');
});

test('colour by ingest node and by table chunks', () => {
	const rows = rowsFor(demo, (_doc, d) => ({ nodeId: d < 10 ? 'parse_1' : 'ocr_2' }));
	const byNode = colourPoints(demo, 'ingest-node', theme('gray'), { docRows: rows });
	assert.deepEqual(byNode.legend.map((e) => e.label).sort(), ['ocr_2', 'parse_1']);
	assert.equal(total(byNode.legend), demo.n);
	const table = colourPoints(clustered, 'table', theme('gray'));
	const tables = (clustered.points.table ?? []).filter((t) => t === 1).length;
	assert.equal(table.legend.find((e) => e.key === 'table')?.count, tables);
	assert.equal(table.legend.find((e) => e.key === 'text')?.count, clustered.n - tables);
});

test('a document-detail mode without its data, or table chunks on an older node, is disabled with the reason', () => {
	assert.equal(colourModeReason('ingest-date', { sample: demo }), DOCUMENT_ROWS_NONE);
	assert.equal(colourModeReason('health', { sample: demo, docRows: new Map() }), DOCUMENT_ROWS_NONE);
	assert.equal(colourModeReason('ingest-date', { sample: demo, docRows: rowsFor(demo, () => ({ ingestedAt: null })) }), 'This store does not keep ingest times.');
	assert.equal(colourModeReason('file-size', { sample: demo, docRows: rowsFor(demo, () => ({ size: null })) }), 'This store does not report file sizes.');
	assert.equal(colourModeReason('ingest-node', { sample: demo, docRows: rowsFor(demo, () => ({ nodeId: null })) }), 'This store does not record which node added a document.');
	assert.equal(colourModeReason('ingest-date', { sample: demo, docRows: rowsFor(demo, () => ({})) }), null);
	assert.equal(colourModeReason('table', { sample: demo }), TABLE_UNSUPPORTED);
	assert.equal(colourModeReason('table', { sample: clustered }), null);
	for (const mode of ['document', 'folder', 'type', 'chunk-position', 'query-similarity', 'density'] as const) assert.equal(colourModeReason(mode, { sample: demo }), null, mode);
	// Every mode is offered, grouped as the toolbar shows them.
	assert.deepEqual([...new Set(COLOUR_MODES.map((m) => m.group))], ['Content', 'Document', 'Analysis']);
	assert.equal(COLOUR_MODES.length, 12);
	assert.equal(colourPoints(demo, 'ingest-date', theme('dark'), {}).note, DOCUMENT_ROWS_NONE);
});
