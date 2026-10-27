// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.


// =============================================================================
// THE DOCUMENTS AND TRASH TABS AND THE PENDING BAR (static renders; no effects, no focus)
// =============================================================================
//
// What the markup holds: the grid's rows and columns, staging and its
// Status, the Health column, the review, the "sorted within" line, the
// writes-off reasons as text, the folder rail's tree, the pending bar's
// sentence and buttons, and the Trash tab's writes. Focus moves, Escape and
// layout are checked live (PLAN-MAP M9, M11-M13, M15, M33, M34).
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import type { IDocumentItem, IExportItem } from '../src/contract/types';
import { fixture } from './support/fixtures';

// The shell's building blocks exist only inside a running shell: plain stand-ins that render their text.
const shellStandIn = {
	commonStyles: new Proxy({}, { get: () => ({}) }),
	Banner: (p: { children?: React.ReactNode }) => <div role="alert">{p.children}</div>,
	Button: (p: { children?: React.ReactNode; disabled?: boolean }) => (
		<button type="button" disabled={p.disabled}>
			{p.children}
		</button>
	),
	BxTrash: () => <svg aria-hidden="true" />,
};
const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	return originalLoad.call(this, request, parent, isMain);
};

// The export menu as the tabs hand it its items: a stand-in that records them.
let exportItems: readonly IExportItem[] = [];
function ExportMenuStandIn(props: { items: readonly IExportItem[] }): React.ReactElement {
	exportItems = props.items;
	return <span data-component="ExportMenu" />;
}
const exportMenuPath = require.resolve('../src/components/ExportMenu');
require.cache[exportMenuPath] = { id: exportMenuPath, filename: exportMenuPath, loaded: true, exports: { __esModule: true, default: ExportMenuStandIn, ExportMenu: ExportMenuStandIn } } as never;

const { WRITES_OFF, panelEntry, panelModel, renderDocumentsTab, renderPendingBar, renderTrashTab } = require('./support/panels') as typeof import('./support/panels');
const { documentsFolder, stagedReview } = require('../src/adapters/consoleActions') as typeof import('../src/adapters/consoleActions');
const { pagerApplyPage, pagerBegin, pagerInit, pagerPause } = require('../src/vector/documents') as typeof import('../src/vector/documents');
const { readDocumentsPage } = require('../src/vector/results') as typeof import('../src/vector/results');
const { stage } = require('../src/vector/staged') as typeof import('../src/vector/staged');

/** A complete listing of these rows. */
function listing(items: IDocumentItem[], over: { sorted?: boolean; nextCursor?: string | null } = {}): ReturnType<typeof pagerInit> {
	return pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage({ success: true, items, next_cursor: over.nextCursor ?? null, total: over.nextCursor ? null : items.length, counts_exact: true, distinct: true, sorted: over.sorted ?? true, caveats: [] }));
}

/** A document. */
function doc(objectId: string, path: string, over: Partial<IDocumentItem> = {}): IDocumentItem {
	return { objectId, path, chunks: 3, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: 2048, modifyTime: null, ingestedAt: '2026-10-08T18:20:11Z', pointId: null, max_chunk_id: 2, deleted_chunks: 0, ...over };
}

/** One grid row's cells' text, by its objectId. */
function cells(html: string, objectId: string): string[] {
	const at = html.indexOf(`data-row-id="${objectId}"`);
	assert.ok(at >= 0, `${objectId} is listed`);
	const row = html.slice(at, html.indexOf('</div></div>', html.indexOf('role="gridcell"', at)) + 12);
	return [...row.matchAll(/role="gridcell"[^>]*>(.*?)<\/div>(?=<div role="gridcell"|<\/div>|$)/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));
}

const ROWS = [doc('a', 'C:/demo/handbooks/manual.pdf', { chunks: 7, max_chunk_id: 6 }), doc('b', 'C:/demo/handbooks/guide.md'), doc('c', 'C:/demo/greenhouse/orchids.md', { deleted_chunks: 1, max_chunk_id: 3 }), doc('d', 'notes.txt', { chunks: null, max_chunk_id: null, deleted_chunks: null, size: null, ingestedAt: null })];

test('the Documents tab: the folder rail, the ScopeBar, then the grid of every loaded document with its declared columns', () => {
	const html = renderDocumentsTab({ directory: listing(ROWS) });
	assert.match(html, /<nav aria-label="Folders"/);
	assert.match(html, /role="tree" aria-label="Folders of the loaded documents"/);
	assert.match(html, /role="treeitem" data-item-id="all" aria-level="1" aria-setsize="2" aria-posinset="1" aria-expanded="true" aria-selected="true" aria-label="All documents, 4 loaded documents" tabindex="0"/);
	assert.match(html, /role="treeitem" data-item-id="f:C:\/demo\/" aria-level="2" aria-setsize="2" aria-posinset="1" aria-expanded="false" aria-selected="false" aria-label="C:\/demo\/, 3 loaded documents"/);
	assert.match(html, /role="treeitem" data-item-id="trash" aria-level="1" aria-setsize="2" aria-posinset="2" aria-label="Trash"/);
	assert.ok(html.indexOf('data-component="ScopeBar"') < html.indexOf('role="grid"'), 'the filter row above the grid');
	assert.match(html, /role="grid" aria-label="Stored documents" aria-rowcount="5" aria-colcount="10"/);
	const headers = [...html.matchAll(/role="columnheader"[^>]*>(?:<button[^>]*>)?<span>([^<]*)<\/span>/g)].map((m) => m[1]);
	assert.deepEqual(headers, ['', 'Name', 'Folder', 'Type', 'Chunks', 'Tables', 'Size', 'Ingested', 'Health', 'Status']);
	assert.match(html, /role="columnheader" aria-label="Staged to move to the trash"/);
	assert.deepEqual(cells(html, 'a').slice(1), ['manual.pdf', 'C:/demo/handbooks/', 'PDF', '7', '0', '2 KB', '2026-10-08', '', '']);
	assert.deepEqual(cells(html, 'd').slice(1, 8), ['notes.txt', 'Uploaded', 'Text', '—', '0', '—', '—'], 'unreported values are "—", never 0');
	assert.deepEqual(exportItems.map((i) => i.id), ['directory-loaded'], 'the export reads the listing');
	assert.match(html, />4 documents<\/span>/, 'the footer counts what is listed');
});

test('the Health column carries the old directory\'s badges: a defect needs attention, and "—" where the store reports nothing to check', () => {
	const rows = [...readDocumentsPage(fixture('list_documents_page1')).items.map((r) => ({ ...r, max_chunk_id: (r.chunks ?? 1) - 1, deleted_chunks: 0 })), { ...(readDocumentsPage(fixture('list_documents_filter_partial')).items[0] as IDocumentItem), objectId: 'legacy-falcon' }];
	const html = renderDocumentsTab({ directory: listing(rows) });
	assert.equal(cells(html, 'legacy-falcon')[8], '1 deleted chunk');
	assert.match(html, /title="[^"]*needs attention: 1 deleted chunk · objectId legacy-falcon"/, 'the row says it needs attention');
	const legacy = renderDocumentsTab({ directory: listing([doc('q', 'C:/q.md', { max_chunk_id: null, deleted_chunks: null })]) });
	assert.equal(cells(legacy, 'q')[8], '—');
	const memo = (i: number): IDocumentItem => doc(`m${i}`, `C:/corp/memos/memo_${i}.txt`, { chunks: 1, max_chunk_id: 0 });
	const big = renderDocumentsTab({ directory: listing([...Array.from({ length: 20 }, (_, i) => memo(i)), doc('manual-1', 'C:/corp/handbooks/manual.pdf', { chunks: 40, max_chunk_id: 39 })]) });
	assert.equal(cells(big, 'manual-1')[8], 'oversize');
	assert.match(big, /title="C:\/corp\/handbooks\/manual\.pdf · [^"]*· oversize · objectId manual-1"/, 'oversize is a note, not "needs attention"');
});

test('staging: a ticked row reads "to Trash"; the toolbar counts the staged rows shown; nothing is sent', () => {
	const entry = panelEntry('k-stage');
	entry.staged.set(stage(entry.staged.get(), [{ objectId: 'b', path: 'C:/demo/handbooks/guide.md', chunks: 3 }]));
	const html = renderDocumentsTab({ entry, directory: listing(ROWS) });
	assert.match(html, /<input type="checkbox"[^>]*aria-label="Stage guide\.md to move to the trash"[^>]*checked=""/);
	assert.equal(cells(html, 'b')[9], 'to Trash');
	assert.equal(cells(html, 'a')[9], '');
	assert.match(html, />1 of the 4 shown is staged\.</);
	assert.match(html, /<button type="button"[^>]*>Stage all shown \(4\)<\/button>/);
	assert.doesNotMatch(html, /aria-disabled="true"[^>]*>Unstage all shown/, 'a staged row is shown: Unstage all shown is available');
});

test('writes off: every staging control says why, as text and on the control, and stays focusable', () => {
	const html = renderDocumentsTab({ model: panelModel({ writes: WRITES_OFF }), directory: listing(ROWS) });
	assert.match(html, /aria-disabled="true" title="Removing documents is turned off on this store node \(allow_writes\)\."[^>]*>Stage all shown/);
	assert.match(html, />Staging is unavailable: Removing documents is turned off on this store node \(allow_writes\)\.</);
	assert.match(html, /<input type="checkbox"[^>]*aria-label="Stage manual\.pdf to move to the trash" aria-disabled="true" title="Removing documents/);
	assert.doesNotMatch(html, /<button[^>]*disabled=""/, 'nothing is `disabled` (a focused control would drop the focus)');
});

test('the review lists only the staged documents, loaded or not, and says how many', () => {
	const entry = panelEntry('k-review');
	entry.staged.set(stage(entry.staged.get(), [{ objectId: 'c', path: 'C:/demo/greenhouse/orchids.md', chunks: 3 }, { objectId: 'm', path: 'C:/map/staged.md', chunks: null }]));
	stagedReview(entry).set(true);
	const html = renderDocumentsTab({ entry, directory: listing(ROWS) });
	assert.match(html, />Showing the 2 staged documents \(1 not among the loaded rows\)\.</);
	assert.match(html, /aria-rowcount="3"/);
	assert.deepEqual(cells(html, 'm').slice(1, 3), ['staged.md', 'C:/map/'], 'a document staged on the map keeps its path');
	assert.equal(cells(html, 'm')[8], '—', 'its health is not known here');
	assert.doesNotMatch(html, /data-row-id="a"/);
});

test('"sorted within" shows while the listing is incomplete and the rows are sorted here (storage order once loading stopped)', () => {
	const partial = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage({ success: true, items: ROWS, next_cursor: 'c2', total: null, counts_exact: true, distinct: true, sorted: false, caveats: [] }));
	assert.doesNotMatch(renderDocumentsTab({ directory: partial }), /Sorted within/, 'pages still arriving: nothing is sorted yet');
	assert.match(renderDocumentsTab({ directory: pagerPause(partial) }), />Sorted within the 4 loaded documents; more may exist\.</, 'paused: sorted here, over what is loaded');
	assert.doesNotMatch(renderDocumentsTab({ directory: listing(ROWS, { sorted: false }) }), /Sorted within/, 'complete: the sort covers everything');
});

test('the pending bar: nothing while nothing is staged; the documents and, by the confirmation\'s rule, their chunks; Review, Discard, Apply', () => {
	assert.equal(renderPendingBar(), '');
	const entry = panelEntry('k-bar');
	entry.staged.set(stage(entry.staged.get(), [{ objectId: 'a', path: 'a.md', chunks: 4 }, { objectId: 'b', path: 'b.md', chunks: 3 }]));
	const html = renderPendingBar({ entry });
	assert.match(html, /role="region" aria-label="Pending changes"/);
	assert.match(html, /role="status"[^>]*>2 documents staged to move to the trash \(7 chunks\)\.<\/span>/);
	assert.deepEqual([...html.matchAll(/<button type="button"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]), ['Review', 'Discard', 'Apply']);
	entry.staged.set(stage(entry.staged.get(), [{ objectId: 'm', path: 'm.md', chunks: null }]));
	assert.match(renderPendingBar({ entry }), /3 documents staged to move to the trash \(at least 7 chunks; 1 document not counted\)\./, 'never a sum that leaves some out');
	const off = renderPendingBar({ entry, model: panelModel({ writes: WRITES_OFF }) });
	assert.match(off, /aria-disabled="true" aria-describedby="[^"]+" title="Removing documents[^"]*"[^>]*>Apply<\/button>/);
	assert.match(off, />Apply is unavailable: Removing documents is turned off on this store node \(allow_writes\)\.</, 'the staged set stays, and the bar says why');
	assert.match(renderPendingBar({ entry, removal: { status: 'running', message: null } }), /aria-disabled="true"[^>]*>Apply<\/button>/, 'while another write runs');
});

test('the Trash tab: Restore and Delete permanently per row and for the ticked rows, Empty trash apart under its consequence, the store count', () => {
	const listed = readDocumentsPage(fixture('list_documents_page1'));
	const trash = pagerApplyPage(pagerBegin(pagerInit()), { ...listed, items: listed.items.map((item) => ({ ...item, deleted: true })) });
	const first = listed.items[0]!.path;
	const html = renderTrashTab({ trash, trashCount: 3 });
	assert.match(html, /role="grid" aria-label="Documents in the trash"/);
	assert.ok(html.includes(`aria-label="Restore ${first}"`));
	assert.ok(html.includes(`aria-label="Delete ${first} permanently"`));
	assert.doesNotMatch(html, /to the trash"/, 'a trashed document is not moved again');
	assert.match(html, /role="group" aria-label="Danger zone"/);
	assert.ok(html.indexOf('>Restore selected<') < html.indexOf('aria-label="Danger zone"'), 'Restore sits apart from the permanent writes');
	assert.match(html, />Empty trash…<\/button>/);
	assert.match(html, />The store counts 3 documents in the trash\.</);
	const empty = renderTrashTab({ trash: pagerApplyPage(pagerBegin(pagerInit()), { ...listed, items: [], nextCursor: null, total: 0 }), trashCount: 0 });
	assert.match(empty, /The trash is empty\./);
	assert.match(empty, /aria-disabled="true" title="The trash is empty\."[^>]*>Empty trash…<\/button>/, 'nothing to empty');
	const off = renderTrashTab({ trash, trashCount: 7, model: panelModel({ writes: WRITES_OFF }) });
	assert.match(off, /aria-disabled="true" title="Removing documents[^"]*"[^>]*>Empty trash…<\/button>/);
	assert.ok(off.includes(`aria-label="Restore ${first}" title="Removing documents is turned off on this store node (allow_writes)." aria-disabled="true"`), 'writes off: a row\'s Restore says why');
	assert.match(off, />Restoring and deleting are unavailable: Removing documents is turned off on this store node \(allow_writes\)\.</);
	assert.match(renderTrashTab({ trash, trashCount: null }), /role="grid"/);
	assert.doesNotMatch(renderTrashTab({ trash, trashCount: null }), /The store counts/, 'no count where the store cannot count');
});

test("the tabs' sources: the hand grid (never the shell's DataGrid), no row copies, keys on their own elements, nothing stopped", () => {
	const read = (file: string): string => fs.readFileSync(path.join(__dirname, '..', 'src', 'components', file), 'utf8');
	for (const file of ['DocumentsTab.tsx', 'TrashTab.tsx', 'DocumentDrawer.tsx', 'FolderRail.tsx', 'PendingBar.tsx', 'GatedButton.tsx']) {
		const source = read(file);
		assert.doesNotMatch(source, /DataGrid|tableId|persistence|stopPropagation|addEventListener|localStorage|sessionStorage/, file);
		assert.doesNotMatch(source, /<(Modal|ConfirmDialog|DetailPanel)\b/, `${file} renders no window-wide overlay`);
	}
	assert.match(read('DocumentsTab.tsx'), /const columns = useMemo\(\(\) => documentColumns\(ctx\), \[\]\);/, 'the columns are declared once, never derived from rows');
	assert.match(read('DocumentsTab.tsx'), /if \(visible\) entry\.controller\.setView\('active'\);/, 'Load more and Retry page the documents while Documents shows');
	assert.match(read('TrashTab.tsx'), /if \(visible\) entry\.controller\.setView\('trash'\);/);
	const drawer = read('DocumentDrawer.tsx');
	assert.match(drawer, /if \(event\.defaultPrevented \|\| event\.key !== 'Escape'\) return;\s*event\.preventDefault\(\);\s*onClose\(\);/, 'Escape: the innermost handler acts');
	assert.match(read('FolderRail.tsx'), /role="treeitem"[\s\S]*aria-level=\{item\.level\}[\s\S]*aria-setsize=\{item\.setsize\}[\s\S]*aria-posinset=\{item\.posinset\}/);
});

test("the pending sentence uses the confirmation's rule for chunks: a sum only when every count is known", () => {
	const { pendingText, stagedChunksWords } = require('../src/vector/staged') as typeof import('../src/vector/staged');
	assert.equal(pendingText({ documents: 0, chunks: null, unknown: 0 }), '');
	assert.equal(pendingText({ documents: 1, chunks: 1, unknown: 0 }), '1 document staged to move to the trash (1 chunk).');
	assert.equal(stagedChunksWords({ documents: 3, chunks: 14, unknown: 0 }), '14 chunks');
	assert.equal(stagedChunksWords({ documents: 3, chunks: 14, unknown: 2 }), 'at least 14 chunks; 2 documents not counted');
	assert.equal(stagedChunksWords({ documents: 2, chunks: null, unknown: 2 }), 'chunk counts not reported');
});

test('a folder view (the rail, or another tab through documentsFolder) narrows what is loaded and offers the scope as its own action', () => {
	const entry = panelEntry('k-folder');
	documentsFolder(entry).set({ kind: 'folder', prefix: 'C:/demo/handbooks/' });
	const html = renderDocumentsTab({ entry, directory: listing(ROWS) });
	assert.match(html, /role="status">Folder C:\/demo\/handbooks\/: 2 of 4 documents, of what is loaded\.<\/span>/);
	assert.match(html, /aria-rowcount="3"/);
	assert.match(html, />Show all documents<\/button>/);
	assert.match(html, />Scope search, map and Ask to this folder<\/button>/);
	assert.match(html, /role="treeitem" data-item-id="f:C:\/demo\/"/, 'the rail keeps every folder of what is loaded');
	assert.equal(documentsFolder(panelEntry('k-other')).get(), null, 'per connection');
});

test('while a move to the trash is confirmed (and while it runs), the grid marks the row after the documents it moves', () => {
	const confirm = { action: 'trash' as const, kind: 'single' as const, targets: [{ objectId: 'b', path: 'C:/demo/handbooks/guide.md', chunks: 3 }], origin: 'console' };
	const html = renderDocumentsTab({ directory: listing(ROWS), confirm });
	assert.match(html, /data-row-id="a" aria-rowindex="4" data-return-focus=""/);
	assert.doesNotMatch(renderDocumentsTab({ directory: listing(ROWS), confirm: { ...confirm, origin: 'document:b' } }), /data-return-focus/, "a document tab's confirmation is not this grid's");
	const trashConfirm = { action: 'delete' as const, kind: 'single' as const, targets: [{ objectId: 'b', path: 'C:/demo/handbooks/guide.md', chunks: 3 }], origin: 'console' };
	const listed = readDocumentsPage(fixture('list_documents_page1'));
	const trash = pagerApplyPage(pagerBegin(pagerInit()), { ...listed, items: ROWS.map((r) => ({ ...r, deleted: true })) });
	assert.match(renderTrashTab({ trash, confirm: trashConfirm }), /data-row-id="a" aria-rowindex="4" data-return-focus=""/, 'and the Trash grid for a permanent delete');
	assert.doesNotMatch(renderDocumentsTab({ directory: listing(ROWS), confirm: trashConfirm }), /data-return-focus/);
});

test('the audit of the last write behind a disclosure: one line per batch, what the store recorded', () => {
	const { WriteAuditDetails } = require('../src/components/WriteAuditDetails') as typeof import('../src/components/WriteAuditDetails');
	const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
	assert.equal(renderToStaticMarkup(<WriteAuditDetails audit={undefined} />), '');
	assert.equal(renderToStaticMarkup(<WriteAuditDetails audit={[]} />), '');
	const html = renderToStaticMarkup(<WriteAuditDetails audit={[{ action: 'vector.soft_delete', rows: 12, caller: 'account' }, { action: 'vector.soft_delete', rows: null, caller: null }]} />);
	assert.match(html, /<summary[^>]*>Write details<\/summary>/, 'not the header\'s "Details" (the connection\'s)');
	assert.match(renderToStaticMarkup(<WriteAuditDetails audit={[{ action: 'vector.delete', rows: 1, caller: null }]} label="Audit" />), /<summary[^>]*>Audit<\/summary>/, 'a label replaces it');
	assert.match(html, /<li>Batch 1: vector\.soft_delete, 12 rows, called by account<\/li><li>Batch 2: vector\.soft_delete, rows not counted, called by an unnamed caller<\/li>/);
});

test("the Documents tab takes another tab's request for a document once, and the Trash's danger sentence says what deleted_only keeps", () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DocumentsTab.tsx'), 'utf8');
	assert.match(source, /if \(asked === null\) return;\s*entry\.openDocument\.set\(null\);/, 'read once, then cleared');
	const { TRASH_DANGER_SENTENCE } = require('../src/components/TrashTab') as typeof import('../src/components/TrashTab');
	assert.match(TRASH_DANGER_SENTENCE, /a document that still has chunks outside the trash is kept whole/);
});

test('on a store that filters nothing (Qdrant: filter_applied none) the rail counts the loaded documents the scope keeps, as the grid lists them', () => {
	const filter = { path_prefix: 'C:/demo/handbooks/' };
	const page = readDocumentsPage({ success: true, items: ROWS, next_cursor: null, total: ROWS.length, counts_exact: true, distinct: true, sorted: false, caveats: ['documents_filter_client'], filter_applied: 'none', filter_ignored: ['path_prefix'] });
	const pager = pagerApplyPage(pagerBegin(pagerInit(), filter), page);
	assert.equal(pager.rows.length, 4, 'the premise: every loaded document is kept by the listing');
	const scope = { filter, label: 'folder is under C:/demo/handbooks/', objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } };
	const html = renderDocumentsTab({ directory: pager, scope });
	assert.match(html, /aria-rowcount="3"/, 'the grid lists the 2 in scope');
	assert.match(html, />Counts over 2 loaded documents in the scope</);
	assert.match(html, /aria-label="All documents, 2 loaded documents"/);
	assert.doesNotMatch(html, /data-item-id="f:C:\/demo\/greenhouse\/"|data-item-id="uploaded"/, 'no folder outside the scope');
	const off = renderDocumentsTab({ directory: pager, scope: { ...scope, applyTo: { ...scope.applyTo, documents: false } } });
	assert.match(off, />4 documents</, 'the scope off the list: every loaded document');
});

test('unstaging never waits for the writes: a staged row stays tickable and Unstage all shown stays available while writes are off', () => {
	const entry = panelEntry('k-unstage');
	entry.staged.set(stage(entry.staged.get(), [{ objectId: 'b', path: 'C:/demo/handbooks/guide.md', chunks: 3 }]));
	const html = renderDocumentsTab({ entry, model: panelModel({ writes: WRITES_OFF }), directory: listing(ROWS) });
	assert.match(html, /<input type="checkbox"[^>]*aria-label="Stage guide\.md to move to the trash"[^>]*tabindex="-1" checked=""/);
	assert.doesNotMatch(html, /aria-label="Stage guide\.md to move to the trash" aria-disabled/);
	assert.match(html, /aria-label="Stage manual\.pdf to move to the trash" aria-disabled="true"/);
	assert.match(html, /<button type="button"[^>]*>Unstage all shown<\/button>/);
	assert.doesNotMatch(html, /aria-disabled="true"[^>]*>Unstage all shown/);
	stagedReview(entry).set(true);
	assert.match(renderDocumentsTab({ entry, directory: listing(ROWS) }), /<span>1 staged<\/span>/, 'the review counts the staged documents, not the loaded ones');
});

test('the Trash: its export (as the old Trash view had), the first-chunk wording where the store lists by first chunk, and no "empty" before it is listed', () => {
	const listed = readDocumentsPage(fixture('list_documents_page1'));
	const trash = pagerApplyPage(pagerBegin(pagerInit()), { ...listed, items: listed.items.map((item) => ({ ...item, deleted: true })) });
	const html = renderTrashTab({ trash });
	assert.match(html, /data-component="ExportMenu"/);
	assert.deepEqual(exportItems.map((i) => [i.id, i.label]), [['directory-loaded', `Loaded documents (${listed.items.length})`]]);
	assert.match(html, />Documents with chunks in the trash\./);
	const byFirst = pagerApplyPage(pagerBegin(pagerInit()), { ...listed, caveats: ['documents_by_first_chunk'], items: listed.items.map((item) => ({ ...item, deleted: true })) });
	assert.match(renderTrashTab({ trash: byFirst }), />Documents whose first chunk is in the trash \(this store lists the trash by the first chunk\)\./);
	const loading = renderTrashTab({ trash: pagerBegin(pagerInit()), trashCount: null });
	assert.doesNotMatch(loading, /title="The trash is empty\."/, 'not claimed before the listing answered');
});

test('the typed field of a single permanent delete shows the whole path beside it, and the field is described by it', () => {
	const { InlineRemoveConfirm } = require('../src/components/InlineRemoveConfirm') as typeof import('../src/components/InlineRemoveConfirm');
	const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
	const entry = panelEntry('k-typed');
	entry.controller.setWritesEnabled(true);
	entry.controller.requestDelete([{ objectId: 'x1', path: 'C:/demo/handbooks/guide.md', chunks: 3 }]);
	const html = renderToStaticMarkup(<InlineRemoveConfirm entry={entry} probe={undefined} />);
	assert.match(html, /Type the file name &#x27;guide\.md&#x27; to confirm\.<\/span><span id="([^"]+)">Full path: C:\/demo\/handbooks\/guide\.md<\/span>/);
	const pathId = html.match(/<span id="([^"]+)">Full path:/)?.[1];
	assert.ok(pathId && new RegExp(`aria-describedby="[^"]+ ${pathId.replace(/[:]/g, '\\:')}"`).test(html), 'the field is described by the consequence and the path');
	entry.controller.dispose();
});

test("controls that go away when they act hand the focus to the grid's row, never the page", () => {
	const read = (file: string): string => fs.readFileSync(path.join(__dirname, '..', 'src', 'components', file), 'utf8');
	const documents = read('DocumentsTab.tsx');
	for (const control of ['thenGrid(() => setFolder(null))', 'thenGrid(() => scopeToFolder(folder.prefix))', 'thenGrid(() => reviewStore.set(false))', 'thenGrid(() => entry.controller.loadMoreDocuments())', 'thenGrid(() => entry.controller.retryDocuments())', 'thenGrid(() => setForceRail(!forceRail))']) assert.ok(documents.includes(control), control);
	assert.match(documents, /if \(focusFell\(\)\) afterToolGone\(focusChain\(\)\)\?\.focus\(\);/, 'through the pure chain (vector/grid.ts afterToolGone)');
	assert.match(documents, /if \(focusFell\(\)\) afterDrawerClosed\(grid\.current\?\.rowElement\(was\) \?\? null, focusChain\(\)\)\?\.focus\(\);/, "the drawer's row, else the chain");
	assert.equal(documents.match(/>\s*Folders\s*</g)?.length, 1, 'one Folders toggle, pressed or not');
	assert.match(documents, /afterNeighbourChosen\(grid\.current\?\.rowElement\(id\) \?\? null, heading\)\?\.focus\(\);/, "a neighbour: its row when listed, else the drawer's heading");
	assert.match(read('DocumentDrawer.tsx'), /\{allChunks && \(\s*<GatedButton unavailable=\{mine\?\.hasMore \?/, 'More chunks stays, unavailable once every chunk is read');
	const trash = read('TrashTab.tsx');
	for (const control of ['thenGrid(() => entry.controller.loadMoreDocuments())', 'thenGrid(() => entry.controller.retryDocuments())']) assert.ok(trash.includes(control), control);
	assert.match(trash, /if \(focusFell\(\)\) afterToolGone\(focusChain\(\)\)\?\.focus\(\);/);
	const grid = read('VectorGrid.tsx');
	assert.match(grid, /if \(event\.target !== grid\.current \|\| stop < 0\) return;/, 'the grid itself focused: a move key enters at the row in the tab order');
	assert.match(read('ScopeBar.tsx'), /if \(event\.defaultPrevented \|\| event\.key !== 'Escape' \|\| \(menu === null && editor === null && !saving\)\) return;\s*event\.preventDefault\(\);/);
});

test('the Folders toggle asked for beside a drawer lets the layout decide again once the drawer closes, handing a focus on it to the grid', () => {
	const documents = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DocumentsTab.tsx'), 'utf8');
	assert.match(documents, /if \(drawerWasShown\.current && !drawerShown && forceRailRef\.current\) \{\s*\/\/[^\n]*\n\s*refocus\.current = true;\s*setForceRail\(false\);/);
});

test('R1-I4: after "Scope … to this folder" the list keeps its folder view and the rail its siblings, on pgvector (server) and on a store that filters nothing', () => {
	const { folderScope } = require('../src/vector/filters') as typeof import('../src/vector/filters');
	const scope = folderScope(null, '', 'C:/demo/handbooks/');
	assert.ok(scope);
	const stores = {
		pgvector: listing(ROWS),
		qdrant: pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage({ success: true, items: ROWS, next_cursor: null, total: ROWS.length, counts_exact: true, distinct: true, sorted: false, caveats: [] })),
	};
	for (const [store, directory] of Object.entries(stores)) {
		const entry = panelEntry(`k-i4-${store}`);
		documentsFolder(entry).set({ kind: 'folder', prefix: 'C:/demo/handbooks/' });
		const before = renderDocumentsTab({ entry, directory });
		const after = renderDocumentsTab({ entry, directory, scope });
		const listed = (html: string): string[] => [...html.matchAll(/data-row-id="(\w)"/g)].map((m) => m[1] as string).sort();
		assert.deepEqual(listed(after), listed(before), `${store}: the list is unchanged`);
		assert.deepEqual(listed(after), ['a', 'b'], `${store}: the folder view of what is loaded`);
		assert.match(after, /data-item-id="f:C:\/demo\/"/, `${store}: the rail keeps every folder`);
		assert.match(after, /aria-label="All documents, 4 loaded documents"/, `${store}: counted over every loaded document (the scope is off the list)`);
		assert.match(after, /aria-pressed="false"[^>]*>Documents<\/button>/, `${store}: the ScopeBar shows the list off the scope`);
	}
});

test('the export offers what the list shows when a folder or the review narrows it; Escape on a row closes the drawer', () => {
	const entry = panelEntry('k-shown');
	documentsFolder(entry).set({ kind: 'folder', prefix: 'C:/demo/handbooks/' });
	renderDocumentsTab({ entry, directory: listing(ROWS) });
	const shown = exportItems.find((i) => i.id === 'directory-shown');
	assert.equal(shown?.label, 'Documents shown, folder C:/demo/handbooks/ (2)');
	assert.deepEqual(shown?.rows?.().rows.map((r) => r.objectId), ['b', 'a']);
	renderDocumentsTab({ directory: listing(ROWS) });
	assert.ok(!exportItems.some((i) => i.id === 'directory-shown'), 'nothing narrows the list: no such item');
	const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DocumentsTab.tsx'), 'utf8');
	assert.match(source, /if \(event\.defaultPrevented \|\| event\.key !== 'Escape' \|\| drawerId === null\) return;\s*event\.preventDefault\(\);\s*setDrawerOpen\(false\);/);
	assert.match(source, /sortVersion=\{sort\?\.column === 'status' \? staged : sort\?\.column === 'health' \? healthOf : null\}/, 'Status and Health sort again when their values change');
});
