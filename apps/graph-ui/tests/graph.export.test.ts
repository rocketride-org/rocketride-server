// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXPORT: A RESULT AS CSV OR JSON, DOWNLOADED OR COPIED
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_COPY_CHARS, deliverExport, exportColumns, exportFileName, exportNote, exportResult, toCsv, toJson } from '../src/graph/exportRows';
import type { ReadQueryResult } from '../src/graph/types';
import { node, readQueryFixture } from './support/builders';

const result = (columns: string[], rows: unknown[][], over: Partial<ReadQueryResult> = {}): ReadQueryResult => ({ columns, rows: rows as ReadQueryResult['rows'], row_limit: 1000, truncated: false, truncated_by: null, element_limit: 10000, elements: 0, value_limit: 500000, values: 0, ...over });

test('column names: as they are, an empty one named by its position, a repeat numbered', () => {
	assert.deepEqual(exportColumns(['a', 'b']), ['a', 'b']);
	assert.deepEqual(exportColumns(['name', '', 'name', 'name']), ['name', '(column 2)', 'name (2)', 'name (3)']);
	assert.deepEqual(exportColumns(['x', 'x (2)', 'x']), ['x', 'x (2)', 'x (3)'], 'a generated name never collides with a real one');
});

test('JSON keys are the Cypher column names, not c0 and c1, and a duplicate column keeps both values', () => {
	const r = result(['p.name', 'n', 'n'], [['Ada', 1, 2], ['Grace', 3, 4]]);
	assert.deepEqual(JSON.parse(toJson(r)), [{ 'p.name': 'Ada', n: 1, 'n (2)': 2 }, { 'p.name': 'Grace', n: 3, 'n (2)': 4 }]);
	assert.doesNotMatch(toJson(r), /"c0"/);
});

test('a column named __proto__ is a key like any other', () => {
	const parsed = JSON.parse(toJson(result(['__proto__'], [[1]]))) as Array<Record<string, unknown>>;
	assert.deepEqual(Object.keys(parsed[0]), ['__proto__']);
});

test('JSON keeps graph values in their wire form, so nothing is rounded or lost', () => {
	const big = { '@kind': 'number', value: '9007199254740993' };
	const n = node('n1', ['Person'], { name: 'Ada' });
	const parsed = JSON.parse(toJson(result(['big', 'n'], [[big, n]]))) as Array<Record<string, unknown>>;
	assert.deepEqual(parsed[0].big, big);
	assert.deepEqual(parsed[0].n, n);
});

test('a short row gives null for what it lacks', () => {
	assert.deepEqual(JSON.parse(toJson(result(['a', 'b'], [[1]]))), [{ a: 1, b: null }]);
});

test('the export is made from the result\'s own rows: changing the export leaves the result as it was', () => {
	const rows = [[{ k: [1, 2] }, 'x']];
	const r = result(['m', 's'], rows);
	const before = JSON.stringify(r);
	const parsed = JSON.parse(toJson(r)) as Array<{ m: { k: number[] } }>;
	parsed[0].m.k.push(3);
	assert.equal(JSON.stringify(r), before);
	// Keys a grid writes into rows (Tabulator) are not columns, and the export never reads them.
	(r.rows[0] as unknown as Record<string, unknown>).__row = 0;
	(r.rows[0] as unknown as Record<string, unknown>).c0 = 'grid';
	assert.deepEqual(JSON.parse(toJson(r)), [{ m: { k: [1, 2] }, s: 'x' }]);
	assert.equal(toCsv(r), 'm,s\r\n"{""k"":[1,2]}",x');
});

test('CSV: a header, then one CRLF-separated line per row, in column order', () => {
	assert.equal(toCsv(result(['id', 'name'], [[1, 'a'], [2, 'b']])), 'id,name\r\n1,a\r\n2,b');
});

test('CSV quotes a field holding a comma, a quote or a line break, doubling the quote', () => {
	assert.equal(toCsv(result(['v'], [['a,b'], ['say "hi"'], ['two\nlines'], ['cr\rhere']])), 'v\r\n"a,b"\r\n"say ""hi"""\r\n"two\nlines"\r\n"cr\rhere"');
	assert.equal(toCsv(result(['a,b'], [])), '"a,b"');
});

test('CSV writes null as an empty field and an empty string as "", so the two stay apart', () => {
	assert.equal(toCsv(result(['a', 'b'], [[null, '']])), 'a,b\r\n,""');
});

test('CSV writes lists, maps and graph values as JSON text, and tagged scalars as their text', () => {
	const n = node('n1', ['P'], {});
	const csv = toCsv(result(['list', 'n', 'big', 'when'], [[[1, 2], n, { '@kind': 'number', value: '-9007199254740993' }, { '@kind': 'temporal', type: 'date', value: '2026-10-04' }]]));
	const [, line] = csv.split('\r\n');
	assert.match(line, /^"\[1,2\]","\{""@kind"":""node""/);
	assert.match(line, /,-9007199254740993,2026-10-04$/, 'a tagged number keeps its sign: it is a number');
});

test('CSV puts a quote before text a spreadsheet would run as a formula: = + - @, a tab, a carriage return', () => {
	const csv = toCsv(result(['v'], [['=1+1'], ['+1'], ['-2'], ['@SUM(A1)'], ['\tx'], ['\rx'], ['=HYPERLINK("http://x")']]));
	assert.equal(csv, 'v\r\n\'=1+1\r\n\'+1\r\n\'-2\r\n\'@SUM(A1)\r\n\'\tx\r\n"\'\rx"\r\n"\'=HYPERLINK(""http://x"")"');
});

test('CSV guards a header too, and leaves numbers and later characters alone', () => {
	assert.equal(toCsv(result(['-n.age', 'a=b'], [[-5, 'x-1'], [1.5, 'y+']])), '\'-n.age,a=b\r\n-5,x-1\r\n1.5,y+');
});

test('JSON keeps text as it is: the guard is CSV only', () => {
	assert.deepEqual(JSON.parse(toJson(result(['v'], [['=1+1']]))), [{ v: '=1+1' }]);
});

test('a real result: the Neo4j fixture exports every row under its column names', () => {
	const r = readQueryFixture('neo4j');
	assert.equal((JSON.parse(toJson(r)) as unknown[]).length, r.rows.length);
	assert.equal(toCsv(r).split('\r\n').length, r.rows.length + 1);
});

test('payload and file name', () => {
	const r = result(['a'], [[1]]);
	assert.deepEqual(exportResult('csv', r), { text: 'a\r\n1', mime: 'text/csv;charset=utf-8', extension: 'csv' });
	assert.equal(exportResult('json', r).extension, 'json');
	assert.equal(exportFileName(Date.UTC(2026, 9, 4, 15, 30, 5), 'json'), 'graph-results-20261004-153005.json');
});

test('the note says how many rows, and that a limit cut the result short', () => {
	assert.equal(exportNote(result(['a'], [[1]])), 'The 1 row returned (limit 1,000).');
	assert.equal(exportNote(result(['a'], [[1], [2]], { truncated: true, truncated_by: 'rows' })), 'The 2 rows returned (limit 1,000), not the whole result: the limit was reached.');
	assert.match(exportNote(result(['a'], [[1]], { truncated: true, truncated_by: 'elements' })), /not the whole result/);
});

// -----------------------------------------------------------------------------
// Delivery
// -----------------------------------------------------------------------------

const payload = { ...exportResult('csv', result(['a'], [[1]])), fileName: 'x.csv' };

test('a download is a download, unless downloads are refused or throw, and then the text is copied', async () => {
	const calls: string[] = [];
	const deps = (over: Partial<Parameters<typeof deliverExport>[1]> = {}): Parameters<typeof deliverExport>[1] => ({ downloadsRefused: false, download: () => calls.push('download'), copy: async () => void calls.push('copy'), ...over });
	assert.equal(await deliverExport(payload, deps()), 'downloaded');
	assert.equal(await deliverExport(payload, deps({ downloadsRefused: true })), 'copied');
	assert.equal(await deliverExport(payload, deps({ download: () => { throw new Error('blocked'); } })), 'copied');
	assert.equal(await deliverExport(payload, deps({ downloadsRefused: true, copy: async () => { throw new Error('no clipboard'); } })), 'failed');
	assert.deepEqual(calls, ['download', 'copy', 'copy']);
});

test('a copy that the page refuses is a failure the caller can show, never a silent success', async () => {
	assert.equal(await deliverExport(payload, { downloadsRefused: true, download: () => undefined, copy: () => Promise.reject(new Error('refused')) }), 'failed');
});

test('a copy over the cap is not attempted and says so; a download of any size is not capped', async () => {
	const big = { ...payload, text: 'x'.repeat(MAX_COPY_CHARS + 1) };
	let copied = false;
	assert.equal(await deliverExport(big, { downloadsRefused: true, download: () => undefined, copy: async () => { copied = true; } }), 'too-large');
	assert.equal(copied, false);
	assert.equal(await deliverExport(big, { downloadsRefused: false, download: () => undefined, copy: async () => undefined }), 'downloaded');
	assert.equal(await deliverExport(big, { downloadsRefused: false, download: () => { throw new Error('blocked'); }, copy: async () => undefined }), 'too-large', 'the fallback is capped too');
});

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------

const SRC = path.resolve(__dirname, '..', 'src');
const code = (file: string): string => fs.readFileSync(path.join(SRC, ...file.split('/')), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the table drops the grid\'s own export, keeps its layout in the session only, and hands the grid copies', () => {
	const views = code('components/ResultViews.tsx');
	assert.match(views, /noExport/);
	assert.match(views, /guardLayouts\(RESULT_LAYOUTS,/);
	assert.doesNotMatch(views, /gridPersistence/, 'the results layout never reaches the env\'s persistence');
	assert.match(views, /toGridRows\(result\)/, 'the grid is given rows built fresh from the result');
});

test('the export menu reads the result, never the grid, and copies where VS Code refuses downloads', () => {
	const menu = code('components/ExportMenu.tsx');
	assert.match(menu, /isInVSCode\(\)/);
	assert.match(menu, /exportResult\(format, result\)/);
	assert.doesNotMatch(menu, /\.getData\(|tabulator|__row/i, 'the grid\'s rows are never read');
	assert.match(menu, /Copy as CSV/);
	assert.match(menu, /Download CSV/);
});
