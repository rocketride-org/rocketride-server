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
import { buildGroups, directoryHeading, filterItems, filterSummary, pagerApplyPage, pagerBegin, pagerFail, pagerFooter, pagerInit, pagerLoadMore, pagerPause, pagerProgressText, pagerResume, pagerWantsPage, splitPath } from '../src/vector/documents';
import { readDocumentsPage } from '../src/vector/results';
import type { IDocumentsPageView } from '../src/vector/results';
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

/** Rows in display order: every group's rows, groups in order. */
function displayed(rows: IDocumentItem[]): string[] {
	return buildGroups(rows).flatMap((g) => g.rows.map((r) => r.item.objectId));
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

test('groups: one per folder, then Uploaded, then Needs attention; duplicate paths kept with a short objectId', () => {
	const items = readDocumentsPage(fixture('list_documents_windows_and_posix_paths')).items;
	items.push(doc('orphan-1', 'ops/old_memo.txt', { has_first_chunk: false }));
	const state = pagerApplyPage(pagerBegin(pagerInit()), page(items, { nextCursor: null, total: items.length }));
	const groups = buildGroups(state.rows);
	assert.deepEqual(
		groups.map((g) => [g.kind, g.label, g.rows.length]),
		[
			['folder', '/home/demo/notes/', 1],
			['folder', '\\\\fileserver\\share\\policies\\', 1],
			['folder', 'C:/demo/handbooks/', 1],
			['folder', 'C:\\Users\\demo\\Documents\\', 1],
			['folder', 'D:/archive/2024/', 1],
			['folder', 'Uploaded/', 1],
			['uploaded', 'Uploaded', 2],
			['attention', 'Needs attention (1)', 1],
		]
	);
	const reports = groups.find((g) => g.kind === 'uploaded')!.rows;
	assert.deepEqual(
		reports.map((r) => [r.name, r.duplicate]),
		[
			['report.pdf', true],
			['report.pdf', true],
		]
	);
	assert.notEqual(reports[0].shortId, reports[1].shortId, 'two documents with one path stay two rows, told apart by their objectId');
	assert.equal(reports[0].shortId.length, 8);
	const orphan = groups.find((g) => g.kind === 'attention')!.rows[0];
	assert.equal(orphan.name, 'ops/old_memo.txt', 'an orphan shows its whole path');
	assert.deepEqual(orphan.flags, ['no first chunk'], 'and says why it needs attention');
	assert.deepEqual(reports[0].flags, [], 'a healthy document has no badge');
});

test('"oversize" is a badge in its folder, never a reason to leave it: a folder of manuals among one-chunk memos stays listed', () => {
	// 400 one-chunk memos and 20 manuals of 20 chunks: the median is 1, so every manual is more than 10 times it.
	const rows: IDocumentItem[] = [];
	for (let i = 0; i < 400; i += 1) rows.push(doc(`m${i}`, `C:/corp/memos/memo_${i}.txt`, { chunks: 1, max_chunk_id: 0, deleted_chunks: 0 }));
	for (let i = 0; i < 20; i += 1) rows.push(doc(`h${i}`, `C:/corp/handbooks/manual_${i}.pdf`, { chunks: 20, max_chunk_id: 19, deleted_chunks: 0 }));
	const groups = buildGroups(rows, { medianChunks: 1 });
	assert.deepEqual(
		groups.map((g) => [g.kind, g.label, g.rows.length]),
		[
			['folder', 'C:/corp/memos/', 400],
			['folder', 'C:/corp/handbooks/', 20],
		]
	);
	const manual = groups[1]?.rows[0];
	assert.equal(manual?.name, 'manual_0.pdf', 'listed by its name in its folder');
	assert.deepEqual(manual?.flags, ['oversize'], 'with the badge');
	assert.equal(manual?.attention, false);
	// A defect still moves the document, with every badge it has.
	const broken = buildGroups([...rows, doc('x', 'C:/corp/handbooks/broken.pdf', { chunks: 19, max_chunk_id: 19, has_first_chunk: false, deleted_chunks: 0 })], { medianChunks: 1 });
	const attention = broken.find((g) => g.kind === 'attention');
	assert.deepEqual(
		attention?.rows.map((r) => [r.name, r.flags, r.attention]),
		[['C:/corp/handbooks/broken.pdf', ['no first chunk', 'oversize'], true]]
	);
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

test('a store that cannot page ends the listing with its caveat; one that lists in storage order is sorted here', () => {
	const stuck = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_paging_unsupported')));
	assert.equal(stuck.status, 'unsupported');
	assert.equal(pagerWantsPage(stuck), false);
	assert.deepEqual(pagerFooter(stuck), { text: 'Limit reached at 5 documents; more may exist', loadMore: false, caveat: CAVEAT_SENTENCES.documents_paging_unsupported, retry: false });
	const unsorted = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_unsorted')));
	assert.equal(unsorted.status, 'done');
	assert.deepEqual(pagerFooter(unsorted), { text: 'sorted here; this store lists documents in storage order', loadMore: false, caveat: null, retry: false });
	assert.deepEqual(
		buildGroups(unsorted.rows).map((g) => g.label),
		['C:/demo/field/', 'C:/demo/handbooks/', 'Uploaded', 'Needs attention (1)']
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

test('the Trash view groups its documents by folder: their deleted chunks are why they are listed, not a defect', () => {
	const trashed = (objectId: string, path: string): IDocumentItem => ({ objectId, path, chunks: 3, has_first_chunk: true, tables: 0, deleted: true, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null, deleted_chunks: 3 });
	const rows = [trashed('a', 'C:/demo/field/gull.md'), trashed('b', 'C:/demo/field/heron.md'), { ...trashed('c', 'C:/demo/notes.md'), has_first_chunk: false }];
	const active = buildGroups(rows);
	assert.ok(
		active.some((g) => g.kind === 'attention' && g.rows.length === 3),
		'in the Documents view, deleted chunks need attention'
	);
	const bin = buildGroups(rows, { medianChunks: null, trash: true });
	assert.deepEqual(
		bin.map((g) => [g.kind, g.rows.map((r) => r.item.objectId)]),
		[
			['folder', ['a', 'b']],
			['attention', ['c']],
		],
		'only a real defect (no first chunk) still needs attention'
	);
	assert.deepEqual(bin[0]!.rows[0]!.flags, [], 'and no row carries the deleted-chunks badge');
});
