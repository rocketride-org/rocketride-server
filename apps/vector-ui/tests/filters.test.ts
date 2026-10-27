// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SCOPE AND FILTERS (pure): conditions, the wire filter, matching, the scope's ids and words
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IDocumentItem, IDocumentsFilter, IScopeState } from '../src/contract/types';
import { DOCUMENTS_FILTER_KEYS } from '../src/contract/types';
import { pagerApplyPage, pagerBegin, pagerFail, pagerInit } from '../src/vector/documents';
import type { IPagerState } from '../src/vector/documents';
import { EMPTY_FILTER, FILE_TYPE_RE, FILTER_TEXT_MAX, NO_MATCH_SCOPE, SCOPE_FAILED_TEXT, SCOPE_WAITING_TEXT, checkScope, clientKeys, conditionAvailability, conditionsFilter, directoryExportItems, directoryView, scopeView, conditionLabel, dateToIso, describeFilter, fromDocumentsFilter, instantMs, isFilterExtension, listingFilter, matches, parseFilter, removeCondition, resolveScope, sameFilter, scopeAvailability, scopeFromFilter, scopeWith, filterOf, withText, scopeObjectIds, scopeNoMatchText, scopePartialText, scopeReadiness, scopeStatusText, scopeStripText, setCondition, toDocumentsFilter, tooLargeText, validateFilter } from '../src/vector/filters';
import type { IFilter } from '../src/vector/filters';
import { readDocumentsPage, readStats } from '../src/vector/results';
import { fixture } from './support/fixtures';

/** A synthetic document row. */
function doc(objectId: string, path: string, over: Partial<IDocumentItem> = {}): IDocumentItem {
	return { objectId, path, chunks: 3, has_first_chunk: true, tables: 0, deleted: false, nodeId: 'chunk_1', size: null, modifyTime: null, ingestedAt: null, pointId: null, ...over };
}

/** The Windows, POSIX, share and bare-name rows. */
const PATHS: IDocumentItem[] = readDocumentsPage(fixture('list_documents_windows_and_posix_paths')).items;

/** The paths of the rows a wire filter matches. */
function pathsOf(rows: readonly IDocumentItem[], filter: IDocumentsFilter, keys?: readonly string[]): string[] {
	return rows.filter((row) => matches(row, filter, keys)).map((row) => row.path);
}

/** A complete, settled listing of these rows (as one page). */
function listed(rows: IDocumentItem[], filter: IDocumentsFilter | null = null, answer: Record<string, unknown> = {}): IPagerState {
	return pagerApplyPage(pagerBegin(pagerInit(), filter), readDocumentsPage({ success: true, items: rows, next_cursor: null, total: rows.length, counts_exact: true, distinct: true, sorted: true, caveats: [], ...answer }));
}

/** A scope over a filter, applied everywhere, not resolved yet. */
function scopeOf(filter: IDocumentsFilter, applyTo: Partial<IScopeState['applyTo']> = {}): IScopeState {
	return { filter, label: describeFilter(filter), objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true, ...applyTo } };
}

// =============================================================================
// CONDITIONS
// =============================================================================

test('one condition per kind: adding one of a kind already set replaces it, removing takes it out, the path box is kept', () => {
	let filter: IFilter = { ...EMPTY_FILTER, text: 'falcon' };
	filter = setCondition(filter, { kind: 'folder', prefix: 'C:/demo/' });
	filter = setCondition(filter, { kind: 'fileType', types: ['md', 'PDF', 'md'] });
	filter = setCondition(filter, { kind: 'folder', prefix: 'C:/demo/handbooks/' });
	assert.deepEqual(
		filter.conditions.map((c) => conditionLabel(c)),
		['folder is under C:/demo/handbooks/', 'type is md or pdf']
	);
	assert.equal(filter.text, 'falcon');
	filter = removeCondition(filter, 'folder');
	assert.deepEqual(
		filter.conditions.map((c) => c.kind),
		['fileType']
	);
	assert.equal(removeCondition(filter, 'chunks'), filter, 'removing a kind that is not set changes nothing');
});

test('every condition says what it keeps, in words', () => {
	assert.equal(conditionLabel({ kind: 'folder', prefix: 'C:\\Users\\demo\\' }), 'folder is under C:\\Users\\demo\\');
	assert.equal(conditionLabel({ kind: 'fileType', types: ['pdf'] }), 'type is pdf');
	assert.equal(conditionLabel({ kind: 'fileType', types: ['md', 'pdf', 'txt'] }), 'type is md, pdf or txt');
	assert.equal(conditionLabel({ kind: 'ingestedAfter', at: '2026-10-01T00:00:00Z' }), 'ingested on or after 2026-10-01');
	assert.equal(conditionLabel({ kind: 'ingestedBefore', at: '2026-10-08T00:00:00Z' }), 'ingested before 2026-10-08');
	assert.equal(conditionLabel({ kind: 'chunks', min: 2, max: 10 }), '2 to 10 chunks');
	assert.equal(conditionLabel({ kind: 'chunks', min: 64, max: null }), 'at least 64 chunks');
	assert.equal(conditionLabel({ kind: 'chunks', min: null, max: 1 }), 'at most 1 chunk');
	assert.equal(conditionLabel({ kind: 'hasTables', value: true }), 'has tables');
	assert.equal(conditionLabel({ kind: 'hasTables', value: false }), 'has no tables');
	assert.equal(conditionLabel({ kind: 'firstChunk', present: false }), 'missing first chunk');
	assert.equal(conditionLabel({ kind: 'firstChunk', present: true }), 'has its first chunk');
	assert.equal(describeFilter({ path_prefix: 'C:/demo/handbooks/', file_types: ['md'], path_contains: 'fal' }), "folder is under C:/demo/handbooks/ · type is md · path contains 'fal'");
	assert.equal(describeFilter({}), 'every document');
});

test('dates from the date inputs become UTC midnight', () => {
	assert.equal(dateToIso('2026-10-01'), '2026-10-01T00:00:00Z');
	assert.equal(dateToIso('2026-13-01'), null);
	assert.equal(dateToIso(''), null);
});

// =============================================================================
// THE WIRE FILTER (contract section 4.4-A)
// =============================================================================

test('toDocumentsFilter sends only the keys that are set, the path box as path_contains, and nothing for no condition', () => {
	const filter: IFilter = {
		conditions: [
			{ kind: 'folder', prefix: 'C:/demo/handbooks/' },
			{ kind: 'fileType', types: ['md', 'pdf'] },
			{ kind: 'ingestedAfter', at: '2026-10-01T00:00:00Z' },
			{ kind: 'chunks', min: 1, max: null },
			{ kind: 'firstChunk', present: true },
			{ kind: 'hasTables', value: false },
		],
		text: '  hand ',
	};
	assert.deepEqual(toDocumentsFilter(filter), { path_prefix: 'C:/demo/handbooks/', file_types: ['md', 'pdf'], ingested_after: '2026-10-01T00:00:00Z', min_chunks: 1, has_first_chunk: true, has_tables: false, path_contains: 'hand' });
	assert.deepEqual(toDocumentsFilter({ conditions: [], text: '' }), {});
	for (const key of Object.keys(toDocumentsFilter(filter))) assert.ok((DOCUMENTS_FILTER_KEYS as readonly string[]).includes(key), key);
	assert.deepEqual(listingFilter(toDocumentsFilter(filter)), { path_prefix: 'C:/demo/handbooks/', file_types: ['md', 'pdf'], ingested_after: '2026-10-01T00:00:00Z', min_chunks: 1, has_first_chunk: true, has_tables: false, path_contains: 'hand' }, 'the listing asks the store for the conditions and the path box');
	assert.equal(listingFilter({ path_contains: 'x' }), null, 'the path box alone is not a scope: it asks the store for nothing');
	assert.deepEqual(conditionsFilter(toDocumentsFilter(filter)), { path_prefix: 'C:/demo/handbooks/', file_types: ['md', 'pdf'], ingested_after: '2026-10-01T00:00:00Z', min_chunks: 1, has_first_chunk: true, has_tables: false }, 'the conditions alone (what a saved filter keeps)');
	assert.equal(conditionsFilter({ path_contains: 'x' }), null);
});

test('parseFilter reads the wire shape back into conditions (round trip), and refuses what the node would refuse', () => {
	const wire: IDocumentsFilter = { path_prefix: 'C:/demo/', file_types: ['md'], ingested_after: '2026-10-01T00:00:00Z', ingested_before: '2026-10-09T00:00:00Z', min_chunks: 2, max_chunks: 40, has_first_chunk: false, has_tables: true, path_contains: 'guide' };
	const parsed = parseFilter(wire);
	assert.ok('filter' in parsed);
	assert.deepEqual(toDocumentsFilter(parsed.filter), wire);
	assert.deepEqual(fromDocumentsFilter({ path_prefix: null, file_types: null, min_chunks: 3 }).conditions, [{ kind: 'chunks', min: 3, max: null }], 'nulls are "not filtered by it"');

	const refused = (value: unknown): string => {
		const out = parseFilter(value);
		assert.ok('error' in out, JSON.stringify(value));
		return out.error;
	};
	assert.match(refused({ colour: 'red' }), /colour/);
	assert.match(refused({ ingested_after: '1st of October' }), /ISO-8601/);
	assert.match(refused({ path_prefix: 'x'.repeat(FILTER_TEXT_MAX + 1) }), /1,024/);
	assert.match(refused({ path_contains: 'x'.repeat(FILTER_TEXT_MAX + 1) }), /1,024/);
	assert.match(refused({ min_chunks: 5, max_chunks: 2 }), /at most/);
	assert.match(refused({ min_chunks: -1 }), /whole number/);
	assert.match(refused({ file_types: ['.md'] }), /extension/);
	assert.match(refused({ has_tables: 'yes' }), /true or false/);
	assert.match(refused('folder'), /object/);
	assert.equal(validateFilter({ path_prefix: 'C:/demo/' }), null);
});

/**
 * The node's own verdicts (vx_types.parse_doc_list_filter, run on these filters): true when it accepts one.
 * A refusal is INVALID_INPUT, or worse: '0001-01-01T00:00:00+01:00' and '9999-12-31T23:59:59-01:00' overflow
 * its conversion to UTC.
 */
const NODE_VERDICTS: Array<[IDocumentsFilter, boolean]> = [
	[{ file_types: ['md'] }, true],
	[{ file_types: ['MD'] }, true],
	[{ file_types: [' md '] }, true],
	[{ file_types: ['.md'] }, true],
	[{ file_types: ['x8'] }, true],
	[{ file_types: ['aaaaaaaaaaaaaaaa'] }, true],
	[{ file_types: ['aaaaaaaaaaaaaaaaa'] }, false],
	[{ file_types: ['db_old'] }, false],
	[{ file_types: ['json-ld'] }, false],
	[{ file_types: ['15 meeting'] }, false],
	[{ file_types: [''] }, false],
	[{ file_types: ['tar.gz'] }, false],
	[{ file_types: ['\u00e9'] }, false],
	[{ file_types: ['md5sum'] }, true],
	[{ file_types: ['7z'] }, true],
	[{ file_types: Array(32).fill('md') }, true],
	[{ file_types: Array(33).fill('md') }, false],
	[{ file_types: Array.from({ length: 32 }, (_, i) => `a${i}`) }, true],
	[{ file_types: Array.from({ length: 33 }, (_, i) => `a${i}`) }, false],
	[{ ingested_after: '2026-10-01' }, true],
	[{ ingested_after: '2026-10-01T00:00:00Z' }, true],
	[{ ingested_after: '2026-10-01T00:00Z' }, true],
	[{ ingested_after: '2026-10-01T10:30' }, true],
	[{ ingested_after: '2026-10-01T00:00:00.123456789Z' }, true],
	[{ ingested_after: '2026-10-01T00:00:00.1234567890Z' }, false],
	[{ ingested_after: '2026-10-01T00:00:00+02:00' }, true],
	[{ ingested_after: '2026-10-01T00:00:00+0200' }, false],
	[{ ingested_after: '2026-10-01T00:00:00-23:59' }, true],
	[{ ingested_after: '2026-10-01T00:00:00+24:00' }, false],
	[{ ingested_after: '2026-10-01T00:00:00+02:60' }, false],
	[{ ingested_after: '2026-10-01 00:00:00Z' }, true],
	[{ ingested_after: '2026-10-01t00:00:00z' }, true],
	[{ ingested_after: ' 2026-10-01 ' }, true],
	[{ ingested_after: '2026-02-30' }, false],
	[{ ingested_after: '2026-13-01' }, false],
	[{ ingested_after: '2026-00-10' }, false],
	[{ ingested_after: '2026-10-00' }, false],
	[{ ingested_after: '2026-10-01T24:00:00Z' }, false],
	[{ ingested_after: '2026-10-01T23:60:00Z' }, false],
	[{ ingested_after: '2026-10-01T23:59:60Z' }, false],
	[{ ingested_after: '0000-01-01' }, false],
	[{ ingested_after: '0001-01-01' }, true],
	[{ ingested_after: '0001-01-01T00:00:00+01:00' }, false],
	[{ ingested_after: '9999-12-31T23:59:59Z' }, true],
	[{ ingested_after: '9999-12-31T23:59:59-01:00' }, false],
	[{ ingested_after: '+010000-01-01T00:00:00Z' }, false],
	[{ ingested_after: '2026-10-01Z' }, false],
	[{ ingested_after: '2026-10-01T10Z' }, false],
	[{ ingested_after: '20261001' }, false],
	[{ ingested_after: '2024-02-29' }, true],
	[{ ingested_after: '2023-02-29' }, false],
	[{ ingested_after: '2026-10-01T00:00:00.Z' }, false],
	[{ ingested_after: '1970-01-01T00:00:00Z' }, true],
	[{ path_prefix: 'a'.repeat(1024) }, true],
	[{ path_prefix: 'a'.repeat(1025) }, false],
	[{ path_contains: 'b'.repeat(1024) }, true],
	[{ path_contains: 'b'.repeat(1025) }, false],
];

test("the app's filter grammar is the node's: it never accepts what the node refuses (file types, times, text lengths)", () => {
	for (const [filter, node] of NODE_VERDICTS) {
		const app = validateFilter(filter) === null;
		if (!node) assert.equal(app, false, `the node refuses ${JSON.stringify(filter).slice(0, 80)}`);
	}
	// What the node accepts, the app accepts too, but a leading dot (the app's own matching needs the bare extension).
	const refusedHere = NODE_VERDICTS.filter(([filter, node]) => node && validateFilter(filter) !== null).map(([filter]) => filter);
	assert.deepEqual(refusedHere, [{ file_types: ['.md'] }]);
	assert.equal(FILE_TYPE_RE.source, '^[a-z0-9]{1,16}$', "the node's _FILE_TYPE");
	assert.ok(isFilterExtension('pdf') && isFilterExtension('7z'));
	assert.ok(!isFilterExtension('15 meeting') && !isFilterExtension('db_old') && !isFilterExtension('json-ld') && !isFilterExtension(''));
	// A time is read as the node reads it, for the rows matched here too.
	assert.equal(instantMs('2026-10-01'), Date.parse('2026-10-01T00:00:00Z'));
	assert.equal(instantMs('2026-10-01 02:00:00+02:00'), Date.parse('2026-10-01T00:00:00Z'));
	assert.equal(instantMs('2026-10-01t00:00:00.5z'), Date.parse('2026-10-01T00:00:00Z'), 'the fraction is dropped, as the node does');
	assert.equal(instantMs('0001-01-01'), Date.parse('0001-01-01T00:00:00Z'));
	assert.equal(instantMs('2026-02-30'), null);
	assert.deepEqual(
		[doc('a', 'a.md', { ingestedAt: '2026-10-01T00:30:00Z' }), doc('b', 'b.md', { ingestedAt: '2026-09-30T23:00:00Z' })].filter((r) => matches(r, { ingested_after: '2026-10-01 02:00:00+02:00' })).map((r) => r.objectId),
		['a']
	);
});

test('a chart bar, "Scope to this folder" and the path box reach the scope only with what the node accepts', () => {
	assert.equal(checkScope(null), null, 'no scope is fine');
	assert.equal(checkScope(scopeWith(null, '', { file_types: ['md'] })), null);
	assert.match(checkScope(scopeWith(null, '', { file_types: ['15 meeting'] })) ?? '', /'15 meeting' is not a file extension/);
	assert.match(checkScope(scopeWith(null, '', { path_prefix: 'C:/'.padEnd(FILTER_TEXT_MAX + 1, 'x') })) ?? '', /'path_prefix' is longer than 1,024 characters/);
	assert.match(checkScope(scopeWith(null, 'x'.repeat(FILTER_TEXT_MAX + 1), { path_prefix: 'C:/' })) ?? '', /'path_contains' is longer than 1,024 characters/);
	// The path box: text the node would refuse leaves the scope as it was.
	const scope = scopeWith(null, 'fal', { path_prefix: 'C:/demo/' });
	assert.ok(scope);
	assert.equal(withText(scope, 'x'.repeat(FILTER_TEXT_MAX + 1)), scope);
	assert.equal(withText(scope, 'x'.repeat(FILTER_TEXT_MAX)).filter.path_contains?.length, FILTER_TEXT_MAX);
});

test('sameFilter compares meaning, not key order or empty keys', () => {
	assert.ok(sameFilter({ path_prefix: 'a', file_types: ['md', 'pdf'] }, { file_types: ['pdf', 'md'], path_prefix: 'a', min_chunks: null }));
	assert.ok(!sameFilter({ path_prefix: 'a' }, { path_prefix: 'b' }));
	assert.ok(sameFilter(null, {}));
});

// =============================================================================
// MATCHING (what the app filters here)
// =============================================================================

test('folder is under: the stored path starts with the prefix, case and separators as stored (Windows, POSIX, shares)', () => {
	assert.deepEqual(pathsOf(PATHS, { path_prefix: 'C:\\Users\\demo\\' }), ['C:\\Users\\demo\\Documents\\plan.docx']);
	assert.deepEqual(pathsOf(PATHS, { path_prefix: 'C:/demo/' }), ['C:/demo/handbooks/falcon_handbook.md']);
	assert.deepEqual(pathsOf(PATHS, { path_prefix: '/home/' }), ['/home/demo/notes/todo.md']);
	assert.deepEqual(pathsOf(PATHS, { path_prefix: '\\\\fileserver\\share\\' }), ['\\\\fileserver\\share\\policies\\leave.pdf']);
	assert.deepEqual(pathsOf(PATHS, { path_prefix: 'c:/demo/' }), [], 'case-sensitive, as the store compares');
});

test('file type: by the extension of the file name, ignoring case; bare names count', () => {
	assert.deepEqual(pathsOf(PATHS, { file_types: ['pdf'] }), ['D:/archive/2024/minutes.pdf', '\\\\fileserver\\share\\policies\\leave.pdf', 'report.pdf', 'report.pdf', 'Uploaded/naïve résumé.pdf']);
	assert.deepEqual(pathsOf(PATHS, { file_types: ['MD', 'docx'] }), ['C:\\Users\\demo\\Documents\\plan.docx', 'C:/demo/handbooks/falcon_handbook.md', '/home/demo/notes/todo.md']);
	assert.deepEqual(pathsOf([doc('a', 'C:/x.md/notes')], { file_types: ['md'] }), [], 'a folder named like a type is not the file type');
	assert.deepEqual(pathsOf([doc('a', 'README.MD')], { file_types: ['md'] }), ['README.MD']);
});

test('ingest dates, chunk counts, tables, first chunk and the path box; a value the store did not give never matches', () => {
	const rows = [doc('a', 'C:/demo/a.md', { ingestedAt: '2026-10-01T09:00:00Z', chunks: 1, tables: 0 }), doc('b', 'C:/demo/b.md', { ingestedAt: '2026-10-08T18:20:11Z', chunks: 64, tables: 2 }), doc('c', 'C:/demo/c.md', { ingestedAt: null, chunks: null, tables: null, has_first_chunk: false })];
	const ids = (filter: IDocumentsFilter) => rows.filter((r) => matches(r, filter)).map((r) => r.objectId);
	assert.deepEqual(ids({ ingested_after: '2026-10-02T00:00:00Z' }), ['b']);
	assert.deepEqual(ids({ ingested_before: '2026-10-02T00:00:00Z' }), ['a']);
	assert.deepEqual(ids({ ingested_after: '2026-10-08T18:20:11Z' }), ['b'], 'after is inclusive');
	assert.deepEqual(ids({ min_chunks: 2 }), ['b']);
	assert.deepEqual(ids({ max_chunks: 1 }), ['a']);
	assert.deepEqual(ids({ min_chunks: 1, max_chunks: 64 }), ['a', 'b']);
	assert.deepEqual(ids({ has_tables: true }), ['b']);
	assert.deepEqual(ids({ has_tables: false }), ['a']);
	assert.deepEqual(ids({ has_first_chunk: false }), ['c']);
	assert.deepEqual(ids({ has_first_chunk: true }), ['a', 'b']);
	assert.deepEqual(ids({ path_contains: 'B.MD' }), ['b'], 'the path box ignores case');
	assert.deepEqual(ids({}), ['a', 'b', 'c']);
	assert.deepEqual(
		rows.filter((r) => matches(r, { min_chunks: 2, has_first_chunk: false }, ['has_first_chunk'])).map((r) => r.objectId),
		['c'],
		'only the keys asked for are applied here'
	);
});

test('clientKeys: what the app filters itself after the store answered server, partial or none (or an older node said nothing)', () => {
	const sent: IDocumentsFilter = { path_prefix: 'C:/demo/', ingested_after: '2026-10-01T00:00:00Z', path_contains: 'fal' };
	assert.deepEqual(clientKeys(sent, 'server', []), [], 'the store applied every key it was sent, the path box among them');
	assert.deepEqual(clientKeys(sent, 'partial', ['ingested_after']), ['ingested_after']);
	assert.deepEqual(clientKeys(sent, 'partial', ['ingested_after', 'path_contains']), ['ingested_after', 'path_contains']);
	assert.deepEqual(clientKeys(sent, 'none', ['path_prefix', 'ingested_after']), ['path_prefix', 'ingested_after', 'path_contains']);
	assert.deepEqual(clientKeys(sent, null, []), ['path_prefix', 'ingested_after', 'path_contains'], 'not asked of the store, or an older node: everything here');
});

test('scopeObjectIds: every matching document once, null ids with the count above the cap', () => {
	const rows = [doc('a', 'C:/demo/a.md', { chunks: 4 }), doc('b', 'C:/demo/b.md', { chunks: 6 }), doc('c', 'D:/c.md'), doc('a', 'C:/demo/a.md')];
	assert.deepEqual(scopeObjectIds(rows, { path_prefix: 'C:/demo/' }, 2), { ids: ['a', 'b'], overflow: null, count: 2, chunks: 10 });
	assert.deepEqual(scopeObjectIds(rows, { path_prefix: 'C:/demo/' }, 1), { ids: null, overflow: 2, count: 2, chunks: 10 });
	assert.deepEqual(scopeObjectIds([doc('x', 'C:/demo/x', { chunks: null })], { path_prefix: 'C:/' }, 5).chunks, null, 'chunks only when every matching document was counted');
	const many = Array.from({ length: 2_340 }, (_, i) => doc(`d${i}`, `C:/demo/handbooks/${i}.md`));
	const big = scopeObjectIds(many, { path_prefix: 'C:/demo/handbooks/' }, 2_000);
	assert.equal(big.ids, null);
	assert.equal(big.overflow, 2_340);
});

test('matching 5,000 rows against every condition stays inside a keystroke (16 ms)', () => {
	const rows = Array.from({ length: 5_000 }, (_, i) => doc(`d${i}`, `C:/demo/f${i % 40}/doc_${i}.${i % 3 === 0 ? 'pdf' : 'md'}`, { chunks: i % 90, ingestedAt: `2026-10-0${1 + (i % 8)}T10:00:00Z`, tables: i % 5 }));
	const filter: IDocumentsFilter = { path_prefix: 'C:/demo/f1', file_types: ['md'], ingested_after: '2026-10-03T00:00:00Z', min_chunks: 2, max_chunks: 60, has_tables: true, has_first_chunk: true, path_contains: 'doc_1' };
	scopeObjectIds(rows, filter, 2_000);
	const started = performance.now();
	for (let i = 0; i < 5; i += 1) scopeObjectIds(rows, filter, 2_000);
	const each = (performance.now() - started) / 5;
	assert.ok(each <= 16 * 3, `matching took ${each.toFixed(1)} ms (budget 16 ms, asserted ≤ 3×)`);
});

// =============================================================================
// AVAILABILITY AND WORDS
// =============================================================================

test('conditions the store cannot answer are disabled with their sentence', () => {
	const rows = [doc('a', 'a.md')];
	assert.deepEqual(conditionAvailability('ingestedAfter', { caveats: ['extras_not_stored'], rows }), { enabled: false, reason: 'This store does not keep ingest times' });
	assert.deepEqual(conditionAvailability('ingestedBefore', { caveats: ['extras_not_stored'], rows }), { enabled: false, reason: 'This store does not keep ingest times' });
	assert.deepEqual(conditionAvailability('ingestedAfter', { caveats: [], rows }), { enabled: true, reason: null });
	assert.deepEqual(conditionAvailability('chunks', { caveats: [], rows: [doc('a', 'a', { chunks: null })] }), { enabled: false, reason: 'This store does not count chunks per document' });
	assert.deepEqual(conditionAvailability('hasTables', { caveats: [], rows: [doc('a', 'a', { tables: null })] }), { enabled: false, reason: 'This store does not count table chunks' });
	assert.deepEqual(conditionAvailability('chunks', { caveats: [], rows: [] }), { enabled: true, reason: null }, 'nothing loaded yet: offered');
	assert.deepEqual(conditionAvailability('folder', { caveats: ['extras_not_stored'], rows }), { enabled: true, reason: null });
});

test('the status line under the bar: store, partly here, or here over what is loaded', () => {
	assert.equal(scopeStatusText({ applied: 'server', ignored: [], count: 12, loaded: 12, total: 12, settled: true }), '12 documents match (store)');
	assert.equal(scopeStatusText({ applied: 'server', ignored: [], count: 1, loaded: 1, total: 1, settled: true }), '1 document matches (store)');
	assert.equal(scopeStatusText({ applied: 'server', ignored: [], count: 2_340, loaded: 500, total: 2_340, settled: false }), '2,340 documents match (store)');
	assert.equal(scopeStatusText({ applied: 'partial', ignored: ['ingested_after', 'ingested_before'], count: 12, loaded: 30, total: 30, settled: true }), '12 documents match (store; ingest dates filtered here)');
	assert.equal(scopeStatusText({ applied: 'partial', ignored: ['file_types', 'min_chunks'], count: 3, loaded: 9, total: 9, settled: true }), '3 documents match (store; file types and chunk counts filtered here)');
	assert.equal(scopeStatusText({ applied: 'none', ignored: ['path_prefix'], count: 12, loaded: 1_200, total: null, settled: false }), '12 of 1,200 loaded match (filtered here; the store cannot filter by these)');
	assert.equal(scopeStatusText({ applied: 'here', ignored: [], count: 12, loaded: 1_200, total: null, settled: true }), '12 of 1,200 loaded match (filtered here)');
	assert.equal(scopeStatusText({ applied: 'partial', ignored: ['ingested_after'], count: 12, loaded: 5_000, total: 8_000, settled: true, exact: false }), '12 of 5,000 loaded match (store; ingest dates filtered here)', 'counted here over a listing that stopped short');
	assert.equal(scopeStatusText({ applied: 'server', ignored: [], count: 5_000, loaded: 5_000, total: null, settled: true, exact: false }), '5,000 of 5,000 loaded match (store)');
	assert.equal(scopeStatusText({ applied: 'pending', ignored: [], count: 0, loaded: 0, total: null, settled: false }), 'Loading the documents in scope…', 'the store has not answered: nothing about what it applies');
});

test('the scope too large for the map, search and chat: the sentence, and those three toggles disabled with it', () => {
	assert.equal(tooLargeText(2_340, 2_000), 'Scope too large for the map, search and chat (2,340 documents; at most 2,000). Narrow the folder.');
	const big = { ...scopeOf({ path_prefix: 'C:/demo/' }), overflow: 2_340 };
	const av = scopeAvailability(big, 2_000);
	assert.deepEqual(av.documents, { enabled: true, reason: null });
	for (const target of ['map', 'search', 'chat'] as const) assert.deepEqual(av[target], { enabled: false, reason: tooLargeText(2_340, 2_000) }, target);
	const none = { ...scopeOf({ path_prefix: 'C:/nothing/' }), objectIds: [] as string[] };
	for (const target of ['map', 'search', 'chat'] as const) assert.deepEqual(scopeAvailability(none, 2_000)[target], { enabled: false, reason: 'No document matches these conditions, so the map, search and chat are not scoped.' }, target);
	const fine = { ...scopeOf({ path_prefix: 'C:/demo/' }), objectIds: ['a'] };
	for (const target of ['documents', 'map', 'search', 'chat'] as const) assert.deepEqual(scopeAvailability(fine, 2_000)[target], { enabled: true, reason: null }, target);
});

test("the stats strip's scope line counts documents against the store's figure and sums the chunks here", () => {
	const stats = readStats(fixture('stats_pgvector'));
	assert.equal(scopeStripText({ count: 12, chunks: 318, settled: true, loaded: 12 }, stats), 'Scope: 12 of 42 documents · 318 chunks (counted here)');
	assert.equal(scopeStripText({ count: 12, chunks: null, settled: true, loaded: 12 }, stats), 'Scope: 12 of 42 documents');
	assert.equal(scopeStripText({ count: 1, chunks: 4, settled: true, loaded: 1 }, null), 'Scope: 1 document · 4 chunks (counted here)');
	assert.equal(scopeStripText({ count: 2_340, chunks: 900, settled: false, loaded: 500 }, stats), 'Scope: 2,340 of 42 documents · 900 chunks in the 500 loaded (counted here)');
	assert.equal(scopeStripText({ count: 12, chunks: 30, settled: true, loaded: 5_000, exact: false }, stats), 'Scope: at least 12 of 42 documents · 30 chunks in the 5,000 loaded (counted here)');
	assert.equal(scopeStripText({ count: 12, chunks: null, settled: true, loaded: 5_000, exact: false }, null), 'Scope: at least 12 documents in the 5,000 loaded');
});

// =============================================================================
// RESOLVING THE SCOPE FROM THE DIRECTORY
// =============================================================================

test('a server-filtered listing: the scope is every listed document once the listing settles, null while it loads', () => {
	const server = readDocumentsPage(fixture('list_documents_filter_server'));
	const filter = { path_prefix: 'C:/demo/greenhouse/' };
	const loading = pagerBegin(pagerInit(), filter);
	assert.equal(resolveScope(scopeOf(filter), loading, 2_000).objectIds, null, 'unresolved while the first page is on its way');
	const done = pagerApplyPage(loading, server);
	assert.equal(done.filterApplied, 'server');
	const resolved = resolveScope(scopeOf(filter), done, 2_000);
	assert.deepEqual(
		resolved.objectIds,
		server.items.map((i) => i.objectId)
	);
	assert.equal(resolved.overflow, null);
	assert.equal(resolved.label, 'folder is under C:/demo/greenhouse/');
});

test("a partial answer: the store's rows are filtered here by the keys it skipped", () => {
	const filter: IDocumentsFilter = { path_prefix: 'C:/demo/handbooks/', ingested_after: '2026-10-01T00:00:00Z' };
	const done = pagerApplyPage(pagerBegin(pagerInit(), filter), readDocumentsPage(fixture('list_documents_filter_partial')));
	assert.deepEqual(done.filterIgnored, ['ingested_after']);
	assert.deepEqual(resolveScope(scopeOf(filter), done, 2_000).objectIds, [], 'the legacy row has no ingest time, so it cannot be shown to match');
});

test('a store that filters nothing (none, or an older node that ignores the filter): the loaded rows are matched here', () => {
	const filter: IDocumentsFilter = { path_prefix: 'C:/demo/handbooks/', file_types: ['md'] };
	const none = pagerApplyPage(pagerBegin(pagerInit(), filter), readDocumentsPage({ ...fixture('list_documents_filter_client'), next_cursor: null }));
	assert.equal(none.filterApplied, 'none');
	const falcon = none.rows.filter((r) => r.path === 'C:/demo/handbooks/falcon_handbook.md').map((r) => r.objectId);
	assert.equal(falcon.length, 1);
	assert.deepEqual(resolveScope(scopeOf(filter), none, 2_000).objectIds, falcon);
	const old = listed(readDocumentsPage(fixture('list_documents_page1')).items, filter);
	assert.equal(old.filterApplied, 'none', 'an answer without filter_applied came from a node that ignored the filter');
	assert.deepEqual(old.filterIgnored, ['path_prefix', 'file_types']);
	assert.deepEqual(resolveScope(scopeOf(filter), old, 2_000).objectIds, falcon);
});

test('the Documents toggle off: the directory lists everything and the scope is matched here over the loaded rows', () => {
	const rows = readDocumentsPage(fixture('list_documents_page1')).items;
	const dir = listed(rows, null);
	const scope = scopeOf({ path_prefix: 'C:/demo/greenhouse/' }, { documents: false });
	assert.deepEqual(resolveScope(scope, dir, 2_000).objectIds?.length, 2);
	assert.equal(dir.filterApplied, null);
});

test('the path box goes to the store with the conditions: the store counts it when it applied it, else it is matched here', () => {
	const filter: IDocumentsFilter = { path_prefix: 'C:/demo/greenhouse/', path_contains: 'TXT' };
	const rows = readDocumentsPage(fixture('list_documents_filter_server')).items;
	const txt = rows.filter((r) => r.path.endsWith('.txt'));
	assert.equal(txt.length, 1);
	assert.deepEqual(clientKeys(filter, 'server', []), [], 'the store applied every key, the path box among them');
	const server = listed(txt, listingFilter(filter), { filter_applied: 'server', filter_ignored: [] });
	assert.deepEqual(server.filter, filter, 'the listing asked for the box too');
	assert.deepEqual(resolveScope(scopeOf(filter), server, 2_000).objectIds, [txt[0]?.objectId]);
	assert.equal(directoryView(server, scopeOf(filter), 'TXT', 2_000).summary, '1 document matches (store)');
	// A store that skipped the path text (Chroma answers 'partial' for it): its rows are matched here by the box.
	const partial = listed(rows, listingFilter(filter), { filter_applied: 'partial', filter_ignored: ['path_contains'] });
	assert.deepEqual(clientKeys(filter, 'partial', ['path_contains']), ['path_contains']);
	assert.deepEqual(resolveScope(scopeOf(filter), partial, 2_000).objectIds, [txt[0]?.objectId]);
	assert.equal(directoryView(partial, scopeOf(filter), 'TXT', 2_000).summary, '1 document matches (store; the path text filtered here)');
});

/** `pages` pages of 500 rows from `make`, answered with `answer` (the store's total and how much it applied); `more` when the store has more after them. */
function paged(filter: IDocumentsFilter, pages: number, make: (i: number) => IDocumentItem, answer: Record<string, unknown>, more = false): IPagerState {
	let pager = pagerBegin(pagerInit(), filter);
	for (let p = 0; p < pages; p += 1) {
		const items = Array.from({ length: 500 }, (_, k) => make(p * 500 + k));
		pager = pagerApplyPage(pager, readDocumentsPage({ success: true, items, next_cursor: more || p + 1 < pages ? `c${p + 1}` : null, counts_exact: true, distinct: true, sorted: true, caveats: [], ...answer }));
	}
	return pager;
}

test("the path box in a large folder: the store's count, and the scope is every document it listed, never the loaded ones' match", () => {
	// 8,000 documents under the folder, a quarter of them 'falcon'; the store applies the box and lists the 2,000.
	const name = (i: number): string => `C:/demo/handbooks/${i % 4 === 0 ? 'falcon' : 'orchid'}_${i}.md`;
	const folder = { path_prefix: 'C:/demo/handbooks/' };
	const boxed: IDocumentsFilter = { ...folder, path_contains: 'falcon' };
	const scope = scopeOf(boxed);
	const store = paged(listingFilter(boxed) as IDocumentsFilter, 4, (i) => doc(`f${i}`, name(i * 4), { chunks: 4 }), { total: 2_000, filter_applied: 'server', filter_ignored: [] });
	assert.equal(store.status, 'done');
	assert.equal(directoryView(store, scope, 'falcon', 2_000).summary, '2,000 documents match (store)');
	assert.equal(resolveScope(scope, store, 2_000).objectIds?.length, 2_000, 'the whole scope, at the cap');
	assert.equal(scopeStripText(scopeView(scope, store, 2_000), { documents: 8_000 }), 'Scope: 2,000 of 8,000 documents · 8,000 chunks (counted here)');
	// The listing of the folder alone (the box not sent yet), capped at 5,000 of 8,000: nothing is said to be the store's.
	const folderOnly = paged(folder, 10, (i) => doc(`d${i}`, name(i), { chunks: 4 }), { total: 8_000, filter_applied: 'server', filter_ignored: [] }, true);
	assert.equal(folderOnly.status, 'capped');
	assert.equal(directoryView(folderOnly, scope, 'falcon', 2_000).summary, '1,250 of 5,000 loaded match (filtered here)');
	assert.equal(resolveScope(scope, folderOnly, 2_000).objectIds, null, 'the listing did not ask for the box: the scope waits for the one that does');
});

test('a listing that stopped short (capped, stalled): a count matched here is "N of M loaded", and the strip says "at least"', () => {
	// The legacy table: the store filters the folder and skips the ingest date; 8,000 documents, 5,000 loaded.
	const filter: IDocumentsFilter = { path_prefix: 'C:/demo/', ingested_after: '2026-10-01T00:00:00Z' };
	const capped = paged(filter, 10, (i) => doc(`d${i}`, `C:/demo/${i}.md`, { chunks: 2, ingestedAt: i % 5 === 0 ? '2026-10-05T00:00:00Z' : '2026-09-01T00:00:00Z' }), { total: 8_000, filter_applied: 'partial', filter_ignored: ['ingested_after'] }, true);
	assert.equal(capped.status, 'capped');
	const scope = scopeOf(filter);
	const view = scopeView(scope, capped, 2_000);
	assert.equal(view.exact, false);
	assert.equal(directoryView(capped, scope, '', 2_000).summary, '1,000 of 5,000 loaded match (store; ingest dates filtered here)');
	assert.equal(scopeStripText(view, { documents: 8_000 }), 'Scope: at least 1,000 of 8,000 documents · 2,000 chunks in the 5,000 loaded (counted here)');
	assert.equal(resolveScope(scope, capped, 2_000).objectIds, null, 'the loaded matches are only a part of the scope: no surface is scoped by them');
	assert.deepEqual(scopeAvailability(resolveScope(scope, capped, 2_000), 2_000, capped).chat, { enabled: false, reason: "Only 5,000 of 8,000 documents are loaded, so the scope's documents are not all known: the map, search and chat are not scoped. Load more to include the other 3,000." });
	// Every document loaded: the same count is the scope's.
	const done = paged(filter, 2, (i) => doc(`d${i}`, `C:/demo/${i}.md`, { chunks: 2, ingestedAt: i % 5 === 0 ? '2026-10-05T00:00:00Z' : '2026-09-01T00:00:00Z' }), { total: 1_000, filter_applied: 'partial', filter_ignored: ['ingested_after'] });
	assert.equal(done.status, 'done');
	assert.equal(scopeView(scope, done, 2_000).exact, true);
	assert.equal(resolveScope(scope, done, 2_000).objectIds?.length, 200, 'every document loaded: the matches are the whole scope');
	assert.equal(directoryView(done, scope, '', 2_000).summary, '200 documents match (store; ingest dates filtered here)');
	assert.equal(scopeStripText(scopeView(scope, done, 2_000), { documents: 8_000 }), 'Scope: 200 of 8,000 documents · 400 chunks (counted here)');
	// A store that applied everything but gave no total, capped: it cannot say how many match.
	const noTotal = paged({ path_prefix: 'C:/demo/' }, 10, (i) => doc(`d${i}`, `C:/demo/${i}.md`), { total: null, filter_applied: 'server', filter_ignored: [] }, true);
	assert.equal(noTotal.status, 'capped');
	assert.equal(directoryView(noTotal, scopeOf({ path_prefix: 'C:/demo/' }), '', 2_000).summary, '5,000 of 5,000 loaded match (store)');
	assert.equal(resolveScope(scopeOf({ path_prefix: 'C:/demo/' }), noTotal, 2_000).overflow, 5_000, 'at least 5,000: above the cap all the same');
});

test('before the store answers for a scope: no word about what it applies and no count, while it loads or after its first page failed', () => {
	const filter: IDocumentsFilter = { path_prefix: 'C:/demo/handbooks/', path_contains: 'fal' };
	const scope = scopeOf(filter);
	const stats = { documents: 42 };
	// The first page is on its way (a settled keystroke on a store that applies the path box lists again).
	const loading = pagerBegin(pagerInit(), filter);
	const view = scopeView(scope, loading, 2_000);
	assert.equal(view.applied, 'pending');
	const pending = directoryView(loading, scope, 'fal', 2_000);
	assert.equal(pending.summary, 'Loading the documents in scope…');
	assert.equal(scopeStripText(view, stats), 'Scope: loading…');
	assert.equal(resolveScope(scope, loading, 2_000).objectIds, null);
	// The first page failed: the footer's error and Retry speak; the scope resolves to nothing known, so no toggle claims an empty match.
	const failed = pagerFail(loading, { headline: 'The store did not answer in time.' });
	assert.equal(scopeView(scope, failed, 2_000).applied, 'pending');
	assert.equal(directoryView(failed, scope, 'fal', 2_000).summary, null);
	assert.equal(scopeStripText(scopeView(scope, failed, 2_000), stats), 'Scope: not counted (the listing did not load)');
	const unresolved = resolveScope(scope, failed, 2_000);
	assert.equal(unresolved.objectIds, null);
	// Nothing is known about its documents, so no surface is scoped by it, and the toggles say so (never on and unscoped).
	for (const target of ['map', 'search', 'chat'] as const) assert.deepEqual(scopeAvailability(unresolved, 2_000, failed)[target], { enabled: false, reason: SCOPE_FAILED_TEXT }, target);
	for (const target of ['map', 'search', 'chat'] as const) assert.deepEqual(scopeAvailability(unresolved, 2_000)[target], { enabled: false, reason: SCOPE_WAITING_TEXT }, `${target}, without the listing`);
	assert.deepEqual(scopeAvailability(unresolved, 2_000, failed).documents, { enabled: true, reason: null });
	// The Documents toggle just turned off while the scoped listing loads: still nothing about the store.
	assert.equal(directoryView(loading, scopeOf(filter, { documents: false }), 'fal', 2_000).summary, 'Loading the documents in scope…');
	for (const words of [pending.summary, scopeStripText(view, stats), directoryView(failed, scope, 'fal', 2_000).summary]) assert.doesNotMatch(words ?? '', /cannot filter|at least|0 of 0/);
	// Once the store answers, its own words: 'none' keeps its sentence, 'server' counts.
	const none = pagerApplyPage(loading, readDocumentsPage({ ...fixture('list_documents_filter_client'), next_cursor: null }));
	assert.equal(none.filterApplied, 'none');
	assert.match(directoryView(none, scope, 'fal', 2_000).summary ?? '', /\(filtered here; the store cannot filter by these\)$/);
	const server = pagerApplyPage(loading, readDocumentsPage({ success: true, items: [], next_cursor: null, total: 0, counts_exact: true, distinct: true, sorted: true, caveats: [], filter_applied: 'server', filter_ignored: [] }));
	assert.equal(directoryView(server, scope, 'fal', 2_000).summary, '0 documents match (store)');
	assert.equal(scopeStripText(scopeView(scope, server, 2_000), stats), 'Scope: 0 of 42 documents · 0 chunks (counted here)');
});

/** A Qdrant-like listing for a scope: the store filters nothing ('none'); `pages` pages of 500 from `make`, more when `more`. */
function clientListed(filter: IDocumentsFilter | null, pages: number, make: (i: number) => IDocumentItem, total: number | null, more: boolean, status?: 'unsupported' | 'stalled' | 'error'): IPagerState {
	const answer = filter === null ? { total } : { total, filter_applied: 'none', filter_ignored: filterKeysOf(filter), caveats: ['documents_filter_client'] };
	let pager = paged(filter as IDocumentsFilter, pages, make, answer, more);
	if (filter === null) pager = { ...pager, filter: null, filterApplied: null, filterIgnored: [] };
	if (status === 'error') pager = pagerFail(pager, { headline: 'The store did not answer in time.' });
	if (status === 'stalled' || status === 'unsupported') pager = { ...pager, status, cursor: null };
	return pager;
}

/** The keys a filter sets. */
function filterKeysOf(filter: IDocumentsFilter): string[] {
	return Object.keys(filter).filter((k) => (filter as Record<string, unknown>)[k] != null);
}

test("while the scope's documents are not all known, the map, search and chat are not scoped by it and the toggles say why", () => {
	const folder: IDocumentsFilter = { path_prefix: 'C:/demo/handbooks/' };
	const scope = scopeOf(folder);
	const handbooks = (i: number): IDocumentItem => doc(`d${i}`, i % 3 === 0 ? `C:/demo/handbooks/${i}.md` : `C:/demo/other/${i}.md`);
	const off = (reason: string) => ({ enabled: false, reason });
	const others = (dir: IPagerState) => {
		const av = scopeAvailability(resolveScope(scope, dir, 2_000), 2_000, dir);
		assert.deepEqual(av.documents, { enabled: true, reason: null }, 'Documents is always offered');
		assert.deepEqual(av.map, av.chat);
		assert.deepEqual(av.search, av.chat);
		return av.chat;
	};
	// The first page on its way.
	const begun = pagerBegin(pagerInit(), folder);
	assert.deepEqual(others(begun), off(SCOPE_WAITING_TEXT));
	assert.equal(SCOPE_WAITING_TEXT, "Waiting for the scope's documents; the map, search and chat are not scoped yet.");
	assert.deepEqual(scopeReadiness(scope, 2_000, begun), { phase: 'waiting', reason: SCOPE_WAITING_TEXT });
	// The first of two pages back (Qdrant, a 600-document collection): the second on its way.
	const half = clientListed(folder, 1, handbooks, 600, true);
	assert.equal(half.status, 'loading');
	assert.equal(resolveScope(scope, half, 2_000).objectIds, null);
	assert.deepEqual(others(half), off("Waiting for the scope's documents (500 of 600 loaded); the map, search and chat are not scoped yet."));
	assert.deepEqual(others({ ...half, total: null }), off("Waiting for the scope's documents (500 loaded); the map, search and chat are not scoped yet."));
	// The first page failed: Retry.
	assert.deepEqual(others(pagerFail(begun, { headline: 'The store did not answer in time.' })), off(SCOPE_FAILED_TEXT));
	assert.equal(SCOPE_FAILED_TEXT, "The scope's documents did not load; Retry under the Documents list. The map, search and chat are not scoped.");
	// Every page in: the scope is its matches, and every surface is offered.
	const whole = clientListed(folder, 2, handbooks, 1_000, false);
	assert.equal(whole.status, 'done');
	assert.equal(resolveScope(scope, whole, 2_000).objectIds?.length, 334);
	assert.deepEqual(others(whole), { enabled: true, reason: null });
	assert.deepEqual(scopeReadiness(resolveScope(scope, whole, 2_000), 2_000, whole), { phase: 'ready', reason: null });
});

test('a listing that stopped short never resolves the scope from the rows it loaded: capped, stalled, one page only, failed part-way, and the Documents toggle off', () => {
	const legal: IDocumentsFilter = { path_prefix: 'C:/corp/legal/' };
	const scope = scopeOf(legal);
	// 12,000 documents in storage order; the 304 under the folder all lie past the 5,000 loaded.
	const rows = (i: number): IDocumentItem => doc(`d${i}`, `C:/corp/other/${i}.md`);
	const cases: Array<[string, IPagerState, string]> = [
		['capped', clientListed(legal, 10, rows, 12_000, true), "Only 5,000 of 12,000 documents are loaded, so the scope's documents are not all known: the map, search and chat are not scoped. Load more to include the other 7,000 (5,000 at a time)."],
		['capped, no total', clientListed(legal, 10, rows, null, true), "Only 5,000 documents are loaded and more may exist, so the scope's documents are not all known: the map, search and chat are not scoped. Load more to include them (5,000 at a time)."],
		['stalled', clientListed(legal, 4, rows, 12_000, true, 'stalled'), "Loading stopped at 2,000 documents, so the scope's documents are not all known: the map, search and chat are not scoped."],
		['unsupported', clientListed(legal, 1, rows, 12_000, true, 'unsupported'), "Only the first page of documents is listed (500 loaded), so the scope's documents are not all known: the map, search and chat are not scoped."],
		['error', clientListed(legal, 3, rows, 12_000, true, 'error'), "Loading stopped at 1,500 documents, so the scope's documents are not all known: the map, search and chat are not scoped. Retry under the Documents list to include them."],
	];
	for (const [name, dir, sentence] of cases) {
		const resolved = resolveScope(scope, dir, 2_000);
		assert.equal(resolved.objectIds, null, `${name}: no ids`);
		assert.equal(resolved.overflow, null, name);
		assert.deepEqual(scopeReadiness(resolved, 2_000, dir), { phase: 'partial', reason: sentence }, name);
		for (const target of ['map', 'search', 'chat'] as const) assert.deepEqual(scopeAvailability(resolved, 2_000, dir)[target], { enabled: false, reason: sentence }, `${name} ${target}`);
		assert.doesNotMatch(sentence, /No document matches/, name);
	}
	// Some loaded rows match (100 of a real 404): still only part of the scope, so nothing is scoped by them.
	const some = clientListed(legal, 10, (i) => doc(`d${i}`, i % 50 === 0 ? `C:/corp/legal/${i}.md` : `C:/corp/other/${i}.md`), 12_000, true);
	assert.equal(resolveScope(scope, some, 2_000).objectIds, null);
	assert.equal(scopeReadiness(resolveScope(scope, some, 2_000), 2_000, some).phase, 'partial');
	// pgvector with the Documents toggle off: the list is every document, capped at 5,000 of 20,000 by path.
	const offScope = scopeOf({ path_prefix: 'C:/zeta/' }, { documents: false });
	const unfiltered = clientListed(null, 10, (i) => doc(`d${i}`, `C:/alpha/${i}.md`), 20_000, true);
	assert.equal(unfiltered.status, 'capped');
	assert.equal(resolveScope(offScope, unfiltered, 2_000).objectIds, null);
	assert.deepEqual(scopeAvailability(resolveScope(offScope, unfiltered, 2_000), 2_000, unfiltered).chat, { enabled: false, reason: "Only 5,000 of 20,000 documents are loaded, so the scope's documents are not all known: the map, search and chat are not scoped. Load more to include the other 15,000 (5,000 at a time)." });
	// "No document matches" only once every document is loaded.
	const complete = clientListed(legal, 2, rows, 1_000, false);
	assert.deepEqual(resolveScope(scope, complete, 2_000).objectIds, []);
	assert.deepEqual(scopeReadiness(resolveScope(scope, complete, 2_000), 2_000, complete), { phase: 'empty', reason: NO_MATCH_SCOPE });
	// Above the cap among the loaded rows alone: too large all the same, and "at least" while the listing stopped short.
	const big = clientListed({ path_prefix: 'C:/demo/' }, 10, (i) => doc(`d${i}`, i % 2 === 0 ? `C:/demo/${i}.md` : `C:/else/${i}.md`), 12_000, true);
	const over = resolveScope(scopeOf({ path_prefix: 'C:/demo/' }), big, 2_000);
	assert.equal(over.overflow, 2_500);
	assert.deepEqual(scopeReadiness(over, 2_000, big), { phase: 'overflow', reason: 'Scope too large for the map, search and chat (at least 2,500 documents; at most 2,000). Narrow the folder.' });
	assert.equal(tooLargeText(2_500, 2_000, true), 'Scope too large for the map, search and chat (at least 2,500 documents; at most 2,000). Narrow the folder.');
});

test('a capped listing says how far Load more goes: the documents still to list when the store counted them, and 5,000 a click', () => {
	const T = "so the scope's documents are not all known: the map, search and chat are not scoped.";
	assert.equal(scopePartialText('capped', 5_000, 10_000), `Only 5,000 of 10,000 documents are loaded, ${T} Load more to include the other 5,000.`, 'one click lists the rest');
	assert.equal(scopePartialText('capped', 125_000, 1_000_000), `Only 125,000 of 1,000,000 documents are loaded, ${T} Load more to include the other 875,000 (5,000 at a time).`);
	assert.equal(scopePartialText('capped', 125_000, null), `Only 125,000 documents are loaded and more may exist, ${T} Load more to include them (5,000 at a time).`);
	assert.equal(scopePartialText('capped', 5_000, 4_000), `Only 5,000 documents are loaded and more may exist, ${T} Load more to include them (5,000 at a time).`, 'a total under the loaded rows is not a count of what is left');
});

test("the directory's empty text says when only the loaded documents were matched", () => {
	const legal: IDocumentsFilter = { path_prefix: 'C:/corp/legal/' };
	const rows = (i: number): IDocumentItem => doc(`d${i}`, `C:/corp/other/${i}.md`);
	const capped = clientListed(legal, 10, rows, 12_000, true);
	assert.equal(scopeNoMatchText(scopeView(scopeOf(legal), capped, 2_000)), 'No loaded document matches these conditions (5,000 of 12,000 loaded).');
	const paging = clientListed(legal, 1, rows, null, true);
	assert.equal(scopeNoMatchText(scopeView(scopeOf(legal), paging, 2_000)), 'No loaded document matches these conditions (500 loaded).');
	const complete = clientListed(legal, 2, rows, 1_000, false);
	assert.equal(scopeNoMatchText(scopeView(scopeOf(legal), complete, 2_000)), 'No documents match these conditions.');
});

test("the directory's export: 'Documents in scope' holds the scope's own documents whatever the Documents toggle, and says when it is only the loaded ones", () => {
	const all = pagerApplyPage(pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_page1'))), readDocumentsPage(fixture('list_documents_page2_last')));
	assert.equal(all.status, 'done');
	assert.equal(all.rows.length, 7);
	const filter = { path_prefix: 'C:/demo/greenhouse/' };
	const inScope = (rows: ReadonlyArray<Record<string, unknown>>): boolean => rows.every((row) => String(row.path).startsWith(filter.path_prefix));
	const item = (items: ReturnType<typeof directoryExportItems>, id: string) => {
		const found = items.find((i) => i.id === id);
		assert.ok(found, id);
		return found;
	};
	// No scope: the loaded documents only.
	assert.deepEqual(
		directoryExportItems(all, directoryView(all, null, '', 2_000)).map((i) => [i.id, i.label]),
		[['directory-loaded', 'Loaded documents (7)']]
	);
	// The Documents toggle off: the list shows all 7, the scope item holds the scope's 2.
	const off = directoryExportItems(all, directoryView(all, scopeOf(filter, { documents: false }), '', 2_000));
	assert.equal(item(off, 'directory-loaded').label, 'Loaded documents (7)');
	const offScope = item(off, 'directory-scope');
	const offRows = offScope.rows?.().rows ?? [];
	assert.equal(offScope.label, `Documents in scope (${offRows.length})`);
	assert.equal(offRows.length, 2);
	assert.ok(inScope(offRows), 'every exported row is in the scope');
	assert.equal(offScope.disabled, null);
	// The toggle on, the store applied the scope: the same 2.
	const server = listed(readDocumentsPage(fixture('list_documents_filter_server')).items, filter, { filter_applied: 'server', filter_ignored: [] });
	const onScope = item(directoryExportItems(server, directoryView(server, scopeOf(filter), '', 2_000)), 'directory-scope');
	assert.equal(onScope.label, 'Documents in scope (2)');
	assert.ok(inScope(onScope.rows?.().rows ?? []));
	// The toggle just turned on, the list not yet listed again: every document is loaded, so the match is the whole scope.
	assert.equal(item(directoryExportItems(all, directoryView(all, scopeOf(filter), '', 2_000)), 'directory-scope').label, 'Documents in scope (2)');
	// A finished listing for other conditions: its matches are only part of the scope.
	const other = listed(readDocumentsPage(fixture('list_documents_filter_server')).items, { path_prefix: 'C:/demo/' }, { filter_applied: 'server', filter_ignored: [] });
	assert.equal(item(directoryExportItems(other, directoryView(other, scopeOf(filter), '', 2_000)), 'directory-scope').label, 'Loaded documents in scope (2)');
	// The store has not answered for the scope yet: nothing to export under its name.
	const loading = pagerBegin(pagerInit(), filter);
	const waiting = item(directoryExportItems(loading, directoryView(loading, scopeOf(filter), '', 2_000)), 'directory-scope');
	assert.equal(waiting.label, 'Documents in scope');
	assert.equal(waiting.disabled, 'The documents in scope have not loaded yet');
	// A listing that stopped short: the item says it holds the loaded ones only.
	const capped = paged(filter, 2, (i) => doc(`g${i}`, `C:/demo/greenhouse/${i}.md`), { total: 3_000, filter_applied: 'server', filter_ignored: [] }, true);
	assert.equal(capped.status, 'loading');
	const part = item(directoryExportItems(capped, directoryView(capped, scopeOf(filter), '', 2_000)), 'directory-scope');
	assert.equal(part.label, 'Loaded documents in scope (1,000)');
	assert.equal(part.rows?.().rows.length, 1_000);
	// Nothing in scope among the loaded rows: disabled with the reason.
	const none = item(directoryExportItems(all, directoryView(all, scopeOf({ path_prefix: 'C:/nothing/' }, { documents: false }), '', 2_000)), 'directory-scope');
	assert.equal(none.label, 'Documents in scope (0)');
	assert.equal(none.disabled, 'No document matches the scope');
});

test('above the cap: overflow with the count (from the store total when it said), no ids; resolution is stable', () => {
	const filter = { path_prefix: 'C:/demo/' };
	const rows = Array.from({ length: 500 }, (_, i) => doc(`d${i}`, `C:/demo/${i}.md`));
	const loading = { ...pagerApplyPage(pagerBegin(pagerInit(), filter), readDocumentsPage({ success: true, items: rows, next_cursor: 'c2', total: 2_340, counts_exact: true, distinct: true, sorted: true, caveats: [], filter_applied: 'server', filter_ignored: [] })) };
	assert.equal(loading.status, 'loading');
	const resolved = resolveScope(scopeOf(filter), loading, 2_000);
	assert.equal(resolved.overflow, 2_340, "known from the store's total before the listing ends");
	assert.equal(resolved.objectIds, null);
	assert.equal(resolveScope(resolved, loading, 2_000), resolved, 'resolving again returns the same object');
});

test('a scope is resolved only from the listing it asked for: a stale listing (the list not yet re-listed) resolves nothing', () => {
	const rows = readDocumentsPage(fixture('list_documents_page1')).items;
	const unfiltered = listed(rows, null);
	const scope = scopeOf({ path_prefix: 'C:/demo/greenhouse/' });
	const stale = resolveScope(scope, unfiltered, 2_000);
	assert.equal(stale.objectIds, null, 'the list is still the unfiltered one: wait for the filtered listing');
	assert.equal(stale.overflow, null);
	const greenhouse = listed(
		rows.filter((r) => r.path.startsWith('C:/demo/greenhouse/')),
		{ path_prefix: 'C:/demo/handbooks/' },
		{ filter_applied: 'server', filter_ignored: [] }
	);
	assert.equal(resolveScope(scope, greenhouse, 2_000).objectIds, null, 'a listing for other conditions resolves nothing');
	const off = resolveScope({ ...scope, applyTo: { ...scope.applyTo, documents: false } }, greenhouse, 2_000);
	assert.equal(off.objectIds, null, 'Documents off waits for the unfiltered listing');
	assert.equal(resolveScope({ ...scope, applyTo: { ...scope.applyTo, documents: false } }, unfiltered, 2_000).objectIds?.length, 2);
});

test('building scopes: no condition is no scope, the same conditions keep the scope, a chart or a saved filter sets its kinds', () => {
	assert.equal(scopeFromFilter({ conditions: [], text: 'falcon' }, null), null, 'the path box alone is not a scope');
	const first = scopeFromFilter({ conditions: [{ kind: 'folder', prefix: 'C:/demo/' }], text: '' }, null);
	assert.ok(first);
	assert.deepEqual(first.applyTo, { documents: true, map: true, search: true, chat: true });
	assert.equal(first.label, 'folder is under C:/demo/');
	const resolved = { ...first, objectIds: ['a'], applyTo: { ...first.applyTo, chat: false } };
	assert.equal(scopeFromFilter(filterOf(resolved, ''), resolved), resolved, 'nothing changed: the same scope');
	const typed = withText(resolved, 'orchid');
	assert.deepEqual(typed.filter, { path_prefix: 'C:/demo/', path_contains: 'orchid' });
	assert.equal(typed.objectIds, null, 'new conditions are unresolved');
	assert.equal(typed.applyTo.chat, false, 'the toggles are kept');
	assert.equal(withText(typed, 'orchid'), typed);
	const charted = scopeWith(typed, 'orchid', { min_chunks: 64, max_chunks: 127 });
	assert.deepEqual(charted?.filter, { path_prefix: 'C:/demo/', min_chunks: 64, max_chunks: 127, path_contains: 'orchid' });
	const folder = scopeWith(charted, 'orchid', { path_prefix: 'C:/demo/handbooks/' });
	assert.equal(folder?.filter.path_prefix, 'C:/demo/handbooks/', 'Scope to this folder replaces the folder');
	assert.deepEqual(scopeWith(null, '', { file_types: ['pdf'] })?.filter, { file_types: ['pdf'] }, 'a chart bar with no scope starts one');
});
