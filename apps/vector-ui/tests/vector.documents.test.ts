// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DIRECTORY: folders from paths, the special groups, the filter, and the background auto-pager
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IDocumentItem } from '../src/contract/types';
import { DIRECTORY_AUTO_ROWS, DIRECTORY_LOAD_MORE } from '../src/vector/budgets';
import { DOCUMENTS_LAYOUT, MORE_MAY_EXIST, listingComplete, chunkPreview, directoryHeading, documentTooltip, documentsLayout, healthCell, healthLookup, listCountText, noDocumentsText, similarDocuments, similarFailureText, similarK, sortNote, stagedRows, filterItems, filterSummary, pagerApplyPage, pagerBegin, pagerFail, pagerFooter, pagerInit, pagerLoadMore, pagerPause, pagerProgressText, pagerResume, pagerWantsPage, splitPath } from '../src/vector/documents';
import { readDocumentsPage } from '../src/vector/results';
import type { IDocumentsPageView } from '../src/vector/results';
import { HEALTH_NOT_REPORTED } from '../src/vector/health';
import { CAVEAT_SENTENCES, DOCUMENTS_REPEATED_TEXT } from '../src/vector/wording';
import { fixture } from './support/fixtures';

/** A synthetic document row. */
function doc(objectId: string, path: string, over: Partial<IDocumentItem> = {}): IDocumentItem {
	return { objectId, path, chunks: 3, has_first_chunk: true, tables: 0, deleted: false, nodeId: 'chunk_1', size: null, modifyTime: null, ingestedAt: null, pointId: null, ...over };
}

/** A synthetic page. */
function page(items: IDocumentItem[], over: Partial<IDocumentsPageView> = {}): IDocumentsPageView {
	return { items, nextCursor: 'next', total: null, countsExact: true, distinct: true, sorted: false, caveats: [], warnings: [], pagingUnsupported: false, ...over };
}

/** Rows in the order the Documents grid lists them without a column sort: the listing's own. */
function displayed(rows: IDocumentItem[]): string[] {
	return rows.map((r) => r.objectId);
}

test('paths: forward and back slashes, drive letters, network shares, POSIX roots; a bare name is Uploaded', () => {
	assert.deepEqual(splitPath('C:/demo/handbooks/falcon_handbook.md'), { folder: 'C:/demo/handbooks/', name: 'falcon_handbook.md', uploaded: false });
	assert.deepEqual(splitPath('C:\\Users\\demo\\Documents\\plan.docx'), { folder: 'C:\\Users\\demo\\Documents\\', name: 'plan.docx', uploaded: false });
	assert.deepEqual(splitPath('\\\\fileserver\\share\\policies\\leave.pdf'), { folder: '\\\\fileserver\\share\\policies\\', name: 'leave.pdf', uploaded: false });
	assert.deepEqual(splitPath('/home/demo/notes/todo.md'), { folder: '/home/demo/notes/', name: 'todo.md', uploaded: false });
	assert.deepEqual(splitPath('D:/x.txt'), { folder: 'D:/', name: 'x.txt', uploaded: false });
	assert.deepEqual(splitPath('report.pdf'), { folder: 'Uploaded', name: 'report.pdf', uploaded: true });
	assert.deepEqual(splitPath('Uploaded/naïve résumé.pdf'), { folder: 'Uploaded/', name: 'naïve résumé.pdf', uploaded: false });
	assert.deepEqual(splitPath(''), { folder: 'Uploaded', name: '(no path)', uploaded: true });
});

test('the listing\'s order: folders, then bare names, then documents without a first chunk; two documents with one path stay two rows', () => {
	const items = readDocumentsPage(fixture('list_documents_windows_and_posix_paths')).items;
	items.push(doc('orphan-1', 'ops/old_memo.txt', { has_first_chunk: false }));
	const state = pagerApplyPage(pagerBegin(pagerInit()), page(items, { nextCursor: null, total: items.length }));
	assert.deepEqual(
		state.rows.map((r) => splitPath(r.path).folder),
		['/home/demo/notes/', '\\\\fileserver\\share\\policies\\', 'C:/demo/handbooks/', 'C:\\Users\\demo\\Documents\\', 'D:/archive/2024/', 'Uploaded/', 'Uploaded', 'Uploaded', 'ops/']
	);
	const reports = state.rows.filter((r) => r.path === 'report.pdf');
	assert.equal(reports.length, 2, 'two documents with one path stay two rows (the grid adds a short objectId to each name)');
	assert.notEqual(reports[0]!.objectId.slice(0, 8), reports[1]!.objectId.slice(0, 8));
	const orphan = state.rows[state.rows.length - 1]!;
	assert.deepEqual(healthCell(orphan, null), { text: 'no first chunk', title: 'Chunk 0 is not stored: the document was partly removed or partly ingested.', attention: true }, 'its Health cell says why it needs attention');
	assert.equal(healthCell(reports[0]!, null).attention, false);
});

test('R2-B2: a Health cell is kept by its row, never by its objectId: a relist with the same median shows the new health', () => {
	const lookup = healthLookup(3, new Set());
	const before = doc('jp', '/misc/japanese.txt', { chunks: 2, max_chunk_id: 1, deleted_chunks: 0 });
	// The same document after its chunk 0 was removed and the list was refreshed: a new row, the same median.
	const after = { ...before, chunks: 1, has_first_chunk: false };
	assert.equal(lookup(before).text, '');
	assert.equal(lookup(after).text, 'no first chunk', 'the relisted row is worked out again');
	assert.equal(lookup(after).attention, true, 'so the grid agrees with the Overview\'s "need attention"');
	assert.equal(lookup(before), lookup(before), 'the same row: worked out once');
	assert.deepEqual(healthLookup(3, new Set(['jp']))(after), { text: '—', title: 'Not among the loaded rows: its health is not known here.', attention: false }, 'a staged document the listing has not loaded');
	const fs = require('node:fs') as typeof import('node:fs');
	const path = require('node:path') as typeof import('node:path');
	const tab = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DocumentsTab.tsx'), 'utf8');
	assert.ok(tab.includes('const healthOf = useMemo(() => healthLookup(median, unloaded), [median, unloaded]);'), 'the Documents grid reads its cells through it');
	assert.doesNotMatch(tab, /new Map<string, IHealthCell>/, 'and keeps no cache of its own by objectId');
});

test('the Health cell: a defect needs attention; "oversize" is a note that waits for the median; "—" where the store reports nothing to check', () => {
	// 400 one-chunk memos and 20 manuals of 20 chunks: the median is 1, so every manual is more than 10 times it.
	const memo = doc('m0', 'C:/corp/memos/memo_0.txt', { chunks: 1, max_chunk_id: 0, deleted_chunks: 0 });
	const manual = doc('h0', 'C:/corp/handbooks/manual_0.pdf', { chunks: 20, max_chunk_id: 19, deleted_chunks: 0 });
	assert.deepEqual(healthCell(memo, 1), { text: '', title: 'No problem found in what this store reports.', attention: false });
	assert.deepEqual(healthCell(manual, 1), { text: 'oversize', title: '20 chunks: more than 10 times the median of 1 per document loaded.', attention: false }, 'oversize alone is a note');
	assert.equal(healthCell(manual, null).text, '', 'no median yet: oversize is not checked, nothing else is wrong');
	const broken = doc('x', 'C:/corp/handbooks/broken.pdf', { chunks: 19, max_chunk_id: 19, has_first_chunk: false, deleted_chunks: 0 });
	assert.deepEqual([healthCell(broken, 1).text, healthCell(broken, 1).attention], ['no first chunk, oversize', true]);
	const legacy = doc('q', 'C:/q.md');
	assert.deepEqual(healthCell(legacy, 3), { text: '—', title: HEALTH_NOT_REPORTED, attention: false }, 'a store that reports no chunk ids or deleted chunks: not checked, never "no problem"');
	assert.equal(documentTooltip(broken, healthCell(broken, 1)), 'C:/corp/handbooks/broken.pdf · PDF · needs attention: no first chunk, oversize · objectId x');
	assert.equal(documentTooltip(manual, healthCell(manual, 1)), 'C:/corp/handbooks/manual_0.pdf · PDF · oversize · objectId h0');
});

test('the filter is client-side over what is loaded, case-insensitive, and says how much is loaded while loading', () => {
	const items = readDocumentsPage(fixture('list_documents_page1')).items;
	assert.deepEqual(
		filterItems(items, 'ORCHID').map((i) => i.path),
		['C:/demo/greenhouse/orchid_notes.pdf', 'C:/demo/greenhouse/orchid_notes.txt']
	);
	assert.equal(filterItems(items, '   ').length, items.length);
	let state = pagerApplyPage(pagerBegin(pagerInit()), page(items, { total: 7 }));
	assert.equal(filterSummary(state, 'orchid', 2), 'filtering 5 of 7 loaded', 'while loading: how much is loaded');
	state = pagerApplyPage(state, page([doc('z1', 'C:/demo/ops/shift_rota.docx'), doc('z2', 'report.pdf')], { nextCursor: null, total: 7 }));
	assert.equal(filterSummary(state, 'orchid', 2), '2 of 7 documents');
	assert.equal(filterSummary(state, '', 7), null);
});

test('the heading counts what the store said, or what is loaded', () => {
	const state = pagerApplyPage(pagerBegin(pagerInit()), page([doc('a', 'a.md')], { total: 42 }));
	assert.equal(directoryHeading(state), '42 documents');
	const unknown = pagerApplyPage(pagerBegin(pagerInit()), page([doc('a', 'a.md')], { total: null }));
	assert.equal(directoryHeading(unknown), '1 loaded');
	const done = pagerApplyPage(pagerBegin(pagerInit()), page([doc('a', 'a.md')], { total: null, nextCursor: null }));
	assert.equal(directoryHeading(done), '1 document');
});

test('auto-pager: keeps asking for pages in the background until the store has no more', () => {
	let state = pagerInit();
	assert.equal(state.status, 'idle');
	assert.equal(pagerWantsPage(state), false);
	state = pagerBegin(state);
	assert.equal(pagerWantsPage(state), true);
	state = pagerApplyPage(state, readDocumentsPage(fixture('list_documents_page1')));
	assert.equal(state.status, 'loading');
	assert.equal(pagerWantsPage(state), true);
	assert.equal(state.cursor, readDocumentsPage(fixture('list_documents_page1')).nextCursor);
	assert.equal(pagerProgressText(state), 'Loading documents… 5 of 7');
	state = pagerApplyPage(state, readDocumentsPage(fixture('list_documents_page2_last')));
	assert.equal(state.status, 'done');
	assert.equal(pagerWantsPage(state), false);
	assert.equal(state.rows.length, 7);
	assert.equal(pagerProgressText(state), null);
	assert.equal(pagerFooter(state), null, 'a sorted store that listed everything needs no footer');
});

test('auto-pager: stops at the 5,000-row cap with "Limit reached", and Load more raises the cap by 5,000', () => {
	assert.equal(DIRECTORY_AUTO_ROWS, 5_000);
	assert.equal(DIRECTORY_LOAD_MORE, 5_000);
	let state = pagerBegin(pagerInit());
	let pages = 0;
	while (pagerWantsPage(state)) {
		const items = Array.from({ length: 500 }, (_, i) => doc(`d${pages}-${i}`, `C:/bulk/${String(pages).padStart(3, '0')}/${i}.txt`));
		state = pagerApplyPage(state, page(items, { total: 12_000 }));
		pages += 1;
		assert.ok(pages <= 10, 'never past the cap');
	}
	assert.equal(pages, 10);
	assert.equal(state.status, 'capped');
	assert.equal(state.rows.length, 5_000);
	assert.deepEqual(pagerFooter(state), { text: 'Limit reached at 5,000 documents; more may exist', loadMore: true, caveat: null, retry: false });
	state = pagerLoadMore(state);
	assert.equal(state.status, 'loading');
	assert.equal(state.cap, 10_000);
	assert.equal(pagerLoadMore(pagerApplyPage(pagerBegin(pagerInit()), page([doc('a', 'a')], { nextCursor: null }))).status, 'done', 'nothing more to load: Load more does nothing');
});

test('auto-pager: never reshuffles mid-load; rows that are shown keep their order until loading ends, then all are sorted', () => {
	let state = pagerBegin(pagerInit());
	state = pagerApplyPage(state, page([doc('m', 'C:/b/m.md'), doc('a', 'C:/a/a.md'), doc('z', 'C:/b/z.md')], { total: 6 }));
	const first = displayed(state.rows);
	assert.deepEqual(first, ['a', 'm', 'z'], 'the first page is sorted');
	state = pagerApplyPage(state, page([doc('b', 'C:/a/b.md'), doc('c', 'C:/0/c.md')], { total: 6 }));
	const mid = displayed(state.rows);
	assert.deepEqual(
		mid.filter((id) => first.includes(id)),
		first,
		'the rows already shown are in the same order'
	);
	assert.deepEqual(mid.slice(0, 1), ['a'], 'nothing is put above the first row while pages arrive');
	state = pagerApplyPage(state, page([doc('n', 'C:/b/n.md')], { nextCursor: null, total: 6 }));
	assert.deepEqual(displayed(state.rows), ['c', 'a', 'b', 'm', 'n', 'z'], 'loading ended: everything is sorted');
});

test('auto-pager: a pause re-sorts what is loaded; resume picks up at the cursor', () => {
	let state = pagerBegin(pagerInit());
	state = pagerApplyPage(state, page([doc('m', 'C:/b/m.md')]));
	state = pagerApplyPage(state, page([doc('a', 'C:/a/a.md')]));
	assert.deepEqual(displayed(state.rows), ['m', 'a']);
	state = pagerPause(state);
	assert.equal(state.status, 'paused');
	assert.equal(pagerWantsPage(state), false);
	assert.deepEqual(displayed(state.rows), ['a', 'm']);
	assert.equal(pagerFooter(state)?.text, 'Loading paused at 2 documents');
	state = pagerResume(state);
	assert.equal(state.status, 'loading');
	assert.equal(pagerWantsPage(state), true);
});

test('auto-pager: handles a null total, a repeated page and an error', () => {
	let state = pagerBegin(pagerInit());
	state = pagerApplyPage(state, page([doc('a', 'a.md'), doc('b', 'b.md')], { total: null }));
	assert.equal(pagerProgressText(state), 'Loading documents… 2 loaded');
	state = pagerApplyPage(state, page([doc('a', 'a.md'), doc('c', 'c.md')], { total: null }));
	assert.equal(state.rows.length, 3, 'a row seen before is not listed twice');
	state = pagerFail(state, { headline: 'The store answered with an error.' });
	assert.equal(state.status, 'error');
	assert.equal(pagerWantsPage(state), false);
	assert.deepEqual(pagerFooter(state), { text: 'Loading stopped at 3 documents: The store answered with an error.', loadMore: false, caveat: null, retry: true });
	assert.equal(pagerResume(state).status, 'loading', 'Retry asks for the same cursor again');
});

test('auto-pager: a repeated page ends the listing instead of asking for it again and again', () => {
	const rows = [doc('b', 'C:/x/b.md'), doc('a', 'C:/x/a.md')];
	// The same page again with the same cursor: a store that ignores the cursor.
	let state = pagerApplyPage(pagerBegin(pagerInit()), page(rows, { nextCursor: 'c1', total: null }));
	assert.equal(state.status, 'loading');
	state = pagerApplyPage(state, page(rows, { nextCursor: 'c1', total: null }));
	assert.equal(state.status, 'stalled');
	assert.equal(pagerWantsPage(state), false);
	assert.equal(state.cursor, null, 'nothing is left to resume from');
	assert.deepEqual(
		state.rows.map((r) => r.objectId),
		['a', 'b'],
		'what is loaded stays, sorted'
	);
	assert.equal(pagerProgressText(state), null);
	assert.deepEqual(pagerFooter(state), { text: 'Loading stopped at 2 documents; more may exist', loadMore: false, caveat: DOCUMENTS_REPEATED_TEXT, retry: false });
	assert.equal(pagerResume(state).status, 'stalled', 'Retry is not offered: the store would answer the same page');
	assert.equal(pagerLoadMore(state).status, 'stalled');
	assert.equal(pagerPause(state).status, 'stalled');
	// The cursor moves on but the rows do not: an offset the store ignores, answered without the node's caveat.
	let moving = pagerApplyPage(pagerBegin(pagerInit()), page(rows, { nextCursor: 'o500', total: 9 }));
	moving = pagerApplyPage(moving, page([rows[1]], { nextCursor: 'o1000', total: 9 }));
	assert.equal(moving.status, 'stalled');
	assert.equal(directoryHeading(moving), '9 documents', 'the heading still says what the store counted');
	// The node's own caveat still names the reason when it comes with the repeated page.
	const named = pagerApplyPage(pagerApplyPage(pagerBegin(pagerInit()), page(rows, { nextCursor: 'c1' })), page(rows, { nextCursor: null, pagingUnsupported: true }));
	assert.equal(named.status, 'unsupported');
	// A page of rows already listed after everything the store counted is just the end.
	let full = pagerApplyPage(pagerBegin(pagerInit()), page(rows, { nextCursor: 'c1', total: 2 }));
	full = pagerApplyPage(full, page(rows, { nextCursor: 'c2', total: 2 }));
	assert.equal(full.status, 'done');
	assert.equal(full.cursor, null);
	// Bounded: a store that answers the same page forever is asked for it twice.
	let loop = pagerBegin(pagerInit());
	let asks = 0;
	while (pagerWantsPage(loop) && asks < 10_000) {
		loop = pagerApplyPage(loop, page(rows, { nextCursor: `o${asks}` }));
		asks += 1;
	}
	assert.equal(asks, 2);
});

test('a store that cannot page ends the listing with its caveat; one that lists in storage order is sorted here, and the footer says nothing once all is loaded', () => {
	const stuck = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_paging_unsupported')));
	assert.equal(stuck.status, 'unsupported');
	assert.equal(pagerWantsPage(stuck), false);
	assert.deepEqual(pagerFooter(stuck), { text: 'Limit reached at 5 documents; more may exist', loadMore: false, caveat: CAVEAT_SENTENCES.documents_paging_unsupported, retry: false });
	const unsorted = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_unsorted')));
	assert.equal(unsorted.status, 'done');
	assert.equal(pagerFooter(unsorted), null, 'complete: the grid sorts everything, so there is nothing to say');
	assert.equal(sortNote(unsorted, true), null, 'and no "sorted within" line');
	assert.deepEqual(
		unsorted.rows.map((r) => r.path),
		['C:/demo/field/kestrel_field_guide.md', 'C:/demo/handbooks/falcon_handbook.md', 'report.pdf', 'ops/old_memo.txt'],
		'sorted here: folders, a bare name, then the document without its first chunk'
	);
});

test("the directory's export: the documents columns, each row the directory's own words and numbers, nothing else the store sent", () => {
	const { documentExportRows } = require('../src/vector/documents') as typeof import('../src/vector/documents');
	const { EXPORT_COLUMNS } = require('../src/contract/types') as typeof import('../src/contract/types');
	const items = readDocumentsPage(fixture('list_documents_filter_server')).items;
	const out = documentExportRows([{ ...items[0], embedding: [0.1, 0.2], token: 'secret' } as unknown as IDocumentItem, items[1] as IDocumentItem]);
	assert.deepEqual(out.columns, EXPORT_COLUMNS.documents);
	assert.equal(out.rows.length, 2);
	assert.deepEqual(Object.keys(out.rows[0] as object), [...EXPORT_COLUMNS.documents]);
	assert.deepEqual(out.rows[0], { objectId: items[0]?.objectId, path: 'C:/demo/greenhouse/orchid_notes.pdf', chunks: 6, has_first_chunk: true, tables: 0, size: 181220, ingestedAt: '2026-10-08T18:20:11Z', deleted_chunks: 0, max_chunk_id: 5 });
	assert.doesNotMatch(JSON.stringify(out), /secret|embedding/);
	assert.equal(documentExportRows([doc('a', 'a.md')]).rows[0]?.deleted_chunks, null, 'not reported: empty, not 0');
});


test('the "sorted within" line: only while the listing is incomplete and the rows are sorted here (a column, or storage order once loading stopped)', () => {
	const rows = [doc('a', 'C:/a.md'), doc('b', 'C:/b.md')];
	const loading = { status: 'loading' as const, storeSorted: true, rows };
	assert.equal(sortNote(loading, false), null, 'a sorting store (pgvector) listing in its path order');
	assert.equal(sortNote(loading, true), 'Sorted within the 2 loaded documents; more may exist.', 'a column sort over part of the documents');
	assert.equal(sortNote({ ...loading, storeSorted: false }, false), null, 'storage order while pages are still appended: nothing is sorted yet');
	assert.equal(sortNote({ ...loading, storeSorted: false, status: 'paused' }, false), 'Sorted within the 2 loaded documents; more may exist.', 'a store that lists in storage order (Qdrant), sorted here once loading stopped');
	for (const status of ['capped', 'paused', 'stalled', 'unsupported', 'error'] as const) assert.ok(sortNote({ ...loading, status }, true), status);
	assert.equal(sortNote({ ...loading, status: 'done' }, true), null, 'complete: the sort covers everything');
	assert.equal(sortNote({ ...loading, rows: [] }, true), null);
});

test('the counts say what is loaded and never a total the store did not give', () => {
	const rows = [doc('a', 'a'), doc('b', 'b'), doc('c', 'c')];
	assert.equal(listCountText(3, { status: 'done', rows }), '3 documents');
	assert.equal(listCountText(1, { status: 'done', rows }), '1 of 3 documents');
	assert.equal(listCountText(3, { status: 'loading', rows }), '3 loaded');
	assert.equal(listCountText(2, { status: 'capped', rows }), '2 of 3 loaded');
	assert.equal(noDocumentsText(true), 'No documents yet. Use Add documents, in the header, to add the first one.');
	assert.equal(noDocumentsText(false), 'No documents yet.', 'a mount that cannot add says nothing it cannot do');
});

test('the layout keeps the grid at least 600 px inside its chrome: the rail goes first when the drawer opens, then the drawer narrows, then it moves under the grid', () => {
	const { rail, railGap, drawer, drawerMin, drawerGap, gridMin, chrome } = DOCUMENTS_LAYOUT;
	const withRail = rail + railGap;
	const grid = gridMin + chrome;
	assert.deepEqual(documentsLayout(1400, { drawer: false, forceRail: false }), { rail: true, railHidden: false, drawer: 0, stacked: false });
	assert.deepEqual(documentsLayout(withRail + drawer + drawerGap + grid, { drawer: true, forceRail: false }), { rail: true, railHidden: false, drawer, stacked: false });
	assert.deepEqual(documentsLayout(1100, { drawer: true, forceRail: false }), { rail: false, railHidden: true, drawer, stacked: false }, 'VS Code at 1440 with its sidebar open');
	assert.deepEqual(documentsLayout(grid + drawerMin + drawerGap + 20, { drawer: true, forceRail: false }), { rail: false, railHidden: true, drawer: drawerMin + 20, stacked: false });
	assert.deepEqual(documentsLayout(700, { drawer: true, forceRail: false }), { rail: false, railHidden: true, drawer: 0, stacked: true });
	assert.deepEqual(documentsLayout(1200, { drawer: true, forceRail: true }), { rail: true, railHidden: false, drawer: 1200 - withRail - grid - drawerGap, stacked: false }, 'the rail asked back: the drawer narrows');
	assert.deepEqual(documentsLayout(1100, { drawer: true, forceRail: true }), { rail: true, railHidden: false, drawer: 0, stacked: true }, 'too narrow for both beside the grid: the drawer goes under it');
	for (const width of [700, 900, 1000, 1100, 1180, 1300, 1440]) {
		const layout = documentsLayout(width, { drawer: true, forceRail: false });
		const left = width - (layout.rail ? withRail : 0) - (layout.drawer > 0 ? layout.drawer + drawerGap : 0) - chrome;
		assert.ok(layout.stacked || left >= gridMin, `${width}: the grid keeps ${gridMin} px (${left})`);
	}
	assert.deepEqual(documentsLayout(700, { drawer: false, forceRail: false }), { rail: false, railHidden: true, drawer: 0, stacked: false });
});

test('Find similar: k covers the document\'s own chunks within the node\'s limit; its own chunks are left out; the nearest document first; BUSY says so', async () => {
	assert.equal(similarK(50, 5, 3), 17);
	assert.equal(similarK(50, null, 8), 20, 'no count from the store: the chunks read');
	assert.equal(similarK(50, 400, 100), 50, 'never above neighbors_k_max');
	const item = (id: string, chunk: number, sim: number, path = `${id}.md`): import('../src/contract/types').INeighborItem => ({ key: [id, chunk], sim, score: sim, below_floor: false, path, chunkId: chunk, preview: '' });
	assert.deepEqual(similarDocuments([item('self', 1, 0.99), item('b', 0, 0.8), item('c', 2, 0.9), item('b', 4, 0.85), item('self', 2, 0.95)], 'self'), [
		{ objectId: 'c', path: 'c.md', best: 0.9, chunks: 1 },
		{ objectId: 'b', path: 'b.md', best: 0.85, chunks: 2 },
	]);
	assert.deepEqual(similarDocuments([item('self', 1, 0.99)], 'self'), [], 'only its own chunks: no other document');
	const { ExplorerToolError } = await import('shared/explorer');
	assert.equal(similarFailureText(new ExplorerToolError({ kind: 'store', tool: 'neighbors', code: 'BUSY', message: 'busy' })), 'The store is answering another neighbours or recommend request; try again in a moment.');
	assert.equal(similarFailureText(new ExplorerToolError({ kind: 'stale', tool: 'neighbors', message: 'stale' })), 'A newer neighbours request replaced this one; try again.', 'replaced by a newer request: it says so, and Find similar asks again');
});

test('the review lists every staged document: its loaded row, else what staging kept', () => {
	const loaded = new Map([['a', doc('a', 'C:/a.md', { chunks: 7 })]]);
	const { rows, unloaded } = stagedRows([{ objectId: 'a', path: 'C:/a.md', chunks: 7 }, { objectId: 'm', path: 'C:/map/m.md', chunks: null }], loaded);
	assert.equal(rows[0], loaded.get('a'), 'the loaded row itself');
	assert.deepEqual([rows[1]?.objectId, rows[1]?.path, rows[1]?.chunks, rows[1]?.size], ['m', 'C:/map/m.md', null, null], 'a document staged on the map: its path, nothing invented');
	assert.deepEqual([...unloaded], ['m']);
	assert.equal(chunkPreview('  a\n b  '), 'a b');
	assert.ok(chunkPreview('word '.repeat(100)).endsWith('…'));
});

test('one test of completeness for every line: an incomplete listing is "loaded", never a total, and every line that speaks of the rest says "more may exist"', () => {
	const rows = [doc('a', 'C:/a.md'), doc('b', 'C:/b.md')];
	assert.equal(listingComplete({ status: 'done' }), true);
	for (const status of ['loading', 'paused', 'capped', 'unsupported', 'stalled', 'error'] as const) {
		const state = { ...pagerInit(), rows, status, pages: 1, storeSorted: false };
		assert.equal(listingComplete(state), false, status);
		assert.equal(listCountText(2, state), '2 loaded', `${status}: what is loaded`);
		assert.equal(directoryHeading(state), '2 loaded', `${status}: the heading too`);
		assert.ok(sortNote(state, true)?.endsWith(`; ${MORE_MAY_EXIST}.`), `${status}: the sort line`);
		const footer = pagerFooter(state)?.text ?? '';
		assert.doesNotMatch(footer, /the store holds|more exist\b/, `${status}: the footer claims nothing more`);
		if (status === 'capped' || status === 'unsupported' || status === 'stalled') assert.ok(footer.endsWith(MORE_MAY_EXIST), `${status}: the footer agrees`);
	}
});

test("the heading names the store's total only when the store counted what the list shows (never over a scope matched here)", () => {
	const rows = [doc('a', 'C:/a.md'), doc('b', 'C:/b.md')];
	const base = { ...pagerInit(), rows, status: 'capped' as const, pages: 1, total: 900 };
	assert.equal(directoryHeading(base), '900 documents', 'no filter: the store total');
	assert.equal(directoryHeading({ ...base, filter: { path_prefix: 'C:/' }, filterApplied: 'server' }), '900 documents', 'the store applied the filter');
	assert.equal(directoryHeading({ ...base, filter: { path_prefix: 'C:/' }, filterApplied: 'none' }), '2 loaded', 'Qdrant: its total counted every document');
	assert.equal(directoryHeading({ ...base, filter: { path_prefix: 'C:/' }, filterApplied: 'partial' }), '2 loaded', 'Chroma: only part applied');
});
