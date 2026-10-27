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
// THE OVERVIEW AND THE TAB ROW (pure): cards, top folders, insights, keys, focus
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IDocumentItem } from '../src/contract/types';
import { healthSummary } from '../src/vector/health';
import { TOP_FOLDERS, insights, insightsLabel, overLine, overviewCards, percentShares, topFolders } from '../src/vector/overview';
import { readDialect, readStats } from '../src/vector/results';
import { NO_FAILURES, bottomSlot, focusStranded, panelOf, reprobeFor, statsFailures, tabKeyTarget, unreachableShown, workbenchNonce, writeTouches } from '../src/vector/workbench';
import { documentFocus } from '../src/vector/focus';
import { fixture } from './support/fixtures';

/** A document row. */
function doc(path: string, chunks: number | null, over: Partial<IDocumentItem> = {}): IDocumentItem {
	return { objectId: path, path, chunks, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null, ...over };
}

test('the cards: the store figures in order, In trash with its chunks, dimension · metric · index, and Size only when reported', () => {
	const stats = readStats(fixture('stats_pgvector'));
	const dialect = readDialect(fixture('dialect_pgvector'));
	const cards = overviewCards(stats, dialect);
	assert.deepEqual(cards.map((c) => c.key), ['documents', 'chunks', 'avg', 'trash', 'model', 'index']);
	assert.deepEqual(cards.map((c) => c.value).slice(0, 4), ['42', '1,318', '31.4', '0']);
	assert.equal(cards.find((c) => c.key === 'model')?.value, 'all-MiniLM-L6-v2');
	assert.match(cards.find((c) => c.key === 'index')?.value ?? '', /^384-d · cosine · /);
	assert.ok(overviewCards(stats, readDialect(fixture('dialect_enriched'))).some((c) => c.key === 'size'), 'Size where the store reports it');
	const none = overviewCards(null, null);
	assert.ok(none.every((c) => c.missing && c.value === '—'), 'nothing counted: every card says "—"');
	assert.ok(none.every((c) => c.tooltip === 'Not read yet.'), 'before the first answer no card blames the store');
	assert.equal(overviewCards(stats, dialect).find((c) => c.key === 'trash')?.tooltip?.startsWith('This store cannot') ?? false, false);
	assert.equal(overviewCards({ ...stats, deletedDocuments: null }, dialect).find((c) => c.key === 'trash')?.tooltip, 'This store cannot count the documents in its trash.', 'with an answer, what the store did not count is said');
});

test('percent shares sum to exactly 100 (largest remainder), and to 0 for nothing', () => {
	assert.deepEqual(percentShares([1, 1, 1]), [34, 33, 33]);
	assert.equal(percentShares([5, 7, 11, 13, 17, 19, 23, 29]).reduce((a, b) => a + b, 0), 100);
	assert.deepEqual(percentShares([0, 0]), [0, 0]);
});

test('top folders: each folder with its subfolders, by chunks, never overlapping; the rest in one row; shares that sum to 100', () => {
	const rows = Array.from({ length: 10 }, (_, f) => Array.from({ length: f + 1 }, (_, i) => doc(`C:/docs/f${f}/${i % 2 === 0 ? '' : 'sub/'}d${i}.md`, 10 - f))).flat();
	const top = topFolders(rows);
	assert.equal(top.rows.length, TOP_FOLDERS);
	assert.equal(top.others?.folders, 3);
	assert.equal(top.loaded, rows.length);
	assert.equal(top.chunksKnown, true);
	assert.ok(top.rows.every((r) => r.kind === 'folder' && /^C:\/docs\/f\d\/$/.test(r.folder)), 'the one folder every document is in is opened into its folders');
	const f5 = top.rows.find((r) => r.folder === 'C:/docs/f5/');
	assert.equal(f5?.documents, 6, 'a folder counts the documents of its subfolders too, as Documents shows it');
	const shares = [...top.rows, top.others].map((r) => r?.share ?? 0);
	assert.equal(shares.reduce((a, b) => a + b, 0), 100);
	assert.equal([...top.rows, top.others].reduce((n, r) => n + (r?.documents ?? 0), 0), rows.length, 'no document is counted twice');
	const mixed = topFolders([doc('C:/docs/readme.md', 1), doc('C:/docs/a/x.md', 2), doc('C:/docs/b/y.md', 3), doc('bare.md', 4)]);
	assert.deepEqual(mixed.rows.map((r) => [r.kind, r.folder, r.documents]), [['folder', 'C:/docs/', 3], ['uploaded', 'Uploaded', 1]], 'with documents under a bare name, the top level stays');
	const direct = topFolders([doc('C:/docs/readme.md', 1), doc('C:/docs/a/x.md', 2), doc('C:/docs/b/y.md', 3)]);
	assert.deepEqual(direct.rows.map((r) => [r.kind, r.folder, r.documents]), [['folder', 'C:/docs/b/', 1], ['folder', 'C:/docs/a/', 1], ['direct', 'C:/docs/', 1]], "an opened folder's own documents are a row of their own");
	const unknown = topFolders([doc('a/1.md', 3), doc('a/2.md', 2), doc('b/1.md', null)]);
	assert.equal(unknown.chunksKnown, false);
	assert.deepEqual(unknown.rows.map((r) => [r.folder, r.documents, r.chunks, r.share]), [['a/', 2, 5, null], ['b/', 1, null, null]], 'by documents; a folder with an uncounted document has no chunk total');
	assert.deepEqual(topFolders([]).rows, []);
});

test('what top folders were counted over: nothing when it is every document; the loaded ones; the scope', () => {
	assert.equal(overLine({ loaded: 40, complete: true, scoped: false }), null);
	assert.equal(overLine({ loaded: 5000, complete: false, scoped: false }), 'Over the 5,000 documents loaded so far.');
	assert.equal(overLine({ loaded: 12, complete: true, scoped: true }), 'Within the current scope.');
	assert.equal(overLine({ loaded: 12, complete: false, scoped: true }), 'Within the current scope; over the 12 documents loaded so far.');
});

test("insights are the attention chip's documents, by path; the label says + while more may need attention", () => {
	const rows = [doc('b.md', 3), doc('a.md', 2, { has_first_chunk: false }), doc('c.md', 4, { max_chunk_id: 3, deleted_chunks: 1 }), doc('big.md', 400)];
	const median = 3;
	const flagged = insights(rows, median);
	assert.deepEqual(flagged.map((f) => f.path), ['a.md', 'c.md'], 'defects only: oversize alone is not one');
	assert.equal(flagged.length, healthSummary(rows, { medianChunks: median, complete: true }).flagged, 'the same count as the chip');
	assert.equal(insightsLabel(2, true), 'Insights (2)');
	assert.equal(insightsLabel(2, false), 'Insights (2+)');
});

test('the tab row moves the focus with Left, Right (wrapping), Home and End, and no other key', () => {
	assert.equal(tabKeyTarget('ArrowRight', 5, 6), 0);
	assert.equal(tabKeyTarget('ArrowLeft', 0, 6), 5);
	assert.equal(tabKeyTarget('Home', 3, 6), 0);
	assert.equal(tabKeyTarget('End', 0, 6), 5);
	for (const key of ['Enter', ' ', 'ArrowDown', 'Tab']) assert.equal(tabKeyTarget(key, 2, 6), null, key);
	assert.equal(tabKeyTarget('ArrowRight', 0, 0), null);
});

test('a focus left in a hidden panel after a tab switch is stranded; in the shown panel or outside every panel it is not', () => {
	const inPanel = (id: string | null) => ({ closest: () => (id === null ? null : { getAttribute: () => id }) });
	assert.equal(panelOf(inPanel('map')), 'map');
	assert.equal(panelOf(null), null);
	assert.equal(focusStranded(inPanel('documents'), 'map'), true);
	assert.equal(focusStranded(inPanel('map'), 'map'), false);
	assert.equal(focusStranded(inPanel(null), 'map'), false, 'the tab row, the header');
	assert.notEqual(workbenchNonce('document'), workbenchNonce('document'));
});

test('B1(b) probes once per disagreement: again only after the stats and the probe agreed, or for another connection', () => {
	let step = reprobeFor(null, true, 'k1');
	assert.deepEqual(step, { probe: true, tried: 'k1' });
	step = reprobeFor(step.tried, true, 'k1');
	assert.deepEqual(step, { probe: false, tried: 'k1' }, 'the next quick tick asks nothing');
	assert.deepEqual(reprobeFor(step.tried, true, 'k2'), { probe: true, tried: 'k2' }, 'another connection');
	step = reprobeFor(step.tried, false, 'k1');
	assert.deepEqual(step, { probe: false, tried: null }, 'they agree: the episode ends');
	assert.deepEqual(reprobeFor(step.tried, true, 'k1'), { probe: true, tried: 'k1' }, 'a new disagreement probes once more');
});

test('a dev-tool document reads itself again only for a write that names it, or names no document', () => {
	assert.equal(writeTouches(['a', 'b'], 'c'), false, 'another document moved: the view stays as it is');
	assert.equal(writeTouches(['a', 'c'], 'c'), true);
	assert.equal(writeTouches([], 'c'), true, 'a restore, or an outcome not known');
	assert.equal(writeTouches(undefined, 'c'), true);
});

test('the store-unreachable banner: after a refresh someone asked for failed, after two failed ticks in a row, or with nothing read; never for one tick', () => {
	const e1 = { headline: 'x' };
	const e2 = { headline: 'y' };
	let f = statsFailures(NO_FAILURES, { status: 'error', error: e1, asked: false });
	assert.equal(unreachableShown(f, true), false, 'one failed quick tick: nothing above every tab');
	assert.equal(statsFailures(f, { status: 'error', error: e1, asked: false }), f, 'the same failure is counted once');
	assert.equal(unreachableShown(f, false), true, 'nothing read yet: say it');
	f = statsFailures(f, { status: 'loading', error: e1, asked: false });
	f = statsFailures(f, { status: 'error', error: e2, asked: false });
	assert.equal(unreachableShown(f, true), true, 'the second in a row');
	f = statsFailures(f, { status: 'ready', error: null, asked: false });
	assert.equal(f, NO_FAILURES, 'an answer starts the count over');
	assert.equal(unreachableShown(statsFailures(NO_FAILURES, { status: 'error', error: e1, asked: true }), true), true, 'a refresh someone asked for, at once');
});

test('the focus in a document surface: the opener while shown, the shown sub-tab, the gone state, then its first control', () => {
	const el = (shown: boolean) => ({ isConnected: true, offsetParent: shown ? {} : null, focus: () => undefined });
	const opener = el(true);
	const tab = el(true);
	const gone = el(true);
	const first = el(true);
	const root = (map: Record<string, ReturnType<typeof el> | null>, all: Array<ReturnType<typeof el>> = []) => ({ querySelector: (s: string) => map[s] ?? null, querySelectorAll: () => all });
	const TABS = '[data-document-tabs] [aria-pressed="true"]';
	assert.equal(documentFocus(root({ [TABS]: tab }), opener), opener);
	assert.equal(documentFocus(root({ [TABS]: tab }), el(false)), tab, 'an opener that is hidden is passed over');
	assert.equal(documentFocus(root({ '[data-document-gone]': gone }), null), gone);
	assert.equal(documentFocus(root({}, [el(false), first]), null), first, 'else the first control shown');
	assert.equal(documentFocus(null, opener), opener);
});

test("the bottom slot's one line: the pending bar while staged, else the write's line; a result that lands while staged shows first", () => {
	const at = (over: Partial<Parameters<typeof bottomSlot>[0]>) => bottomSlot({ staged: 3, write: 'result', fresh: false, stagedSince: false, held: false, showing: 'write', ...over });
	assert.equal(at({ staged: 0, write: null }), 'empty');
	assert.equal(at({ staged: 0 }), 'write');
	assert.equal(at({ write: null }), 'pending');
	assert.equal(at({ fresh: true, showing: 'pending' }), 'write', 'a Restore in the Trash while documents are staged: seen, not only announced');
	assert.equal(at({}), 'pending', 'then the bar comes back');
	assert.equal(at({ fresh: true, stagedSince: true }), 'pending', 'or as soon as the staged set changes');
	// A running write: its line until its result, whatever else.
	assert.equal(at({ write: 'running', stagedSince: true, showing: 'pending' }), 'write');
	// The focus or the pointer in the line (Write details, Show pending): it is not swapped out from under them...
	assert.equal(at({ held: true }), 'write');
	assert.equal(at({ held: true, stagedSince: true }), 'write');
	// ...but resting on the bar never brings an old result back.
	assert.equal(at({ held: true, showing: 'pending' }), 'pending');
	// A failure, or a write that did not do all it was asked (kept whole, already gone), has no timer: it stays until
	// the staged set changes or Show pending sets it aside (no longer a line).
	assert.equal(at({ write: 'failure' }), 'write');
	assert.equal(at({ write: 'failure', fresh: false, showing: 'write' }), 'write', 'long after it landed');
	assert.equal(at({ write: 'failure', stagedSince: true }), 'pending');
	assert.equal(at({ write: 'result', fresh: false, showing: 'write' }), 'pending', 'only a success goes after a few seconds');
	assert.equal(at({ write: null, showing: 'write' }), 'pending', 'Show pending: the bar');
	assert.equal(at({ write: null, staged: 0, showing: 'write' }), 'empty', 'nothing to show, nothing staged: an empty line');
});

