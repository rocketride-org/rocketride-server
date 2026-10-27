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
import { focusStranded, panelOf, reprobeFor, tabKeyTarget, workbenchNonce } from '../src/vector/workbench';
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
	assert.equal(none.find((c) => c.key === 'trash')?.tooltip, 'This store cannot count the documents in its trash.');
});

test('percent shares sum to exactly 100 (largest remainder), and to 0 for nothing', () => {
	assert.deepEqual(percentShares([1, 1, 1]), [34, 33, 33]);
	assert.equal(percentShares([5, 7, 11, 13, 17, 19, 23, 29]).reduce((a, b) => a + b, 0), 100);
	assert.deepEqual(percentShares([0, 0]), [0, 0]);
});

test('top folders: by chunks, the rest in one row, shares that sum to 100; by documents where a count is missing, with no shares', () => {
	const rows = Array.from({ length: 10 }, (_, f) => Array.from({ length: f + 1 }, (_, i) => doc(`docs/f${f}/d${i}.md`, 10 - f))).flat();
	const top = topFolders(rows);
	assert.equal(top.rows.length, TOP_FOLDERS);
	assert.equal(top.others?.folders, 3);
	assert.equal(top.loaded, rows.length);
	assert.equal(top.chunksKnown, true);
	const shares = [...top.rows, top.others].map((r) => r?.share ?? 0);
	assert.equal(shares.reduce((a, b) => a + b, 0), 100);
	for (let i = 1; i < top.rows.length; i += 1) assert.ok((top.rows[i - 1].chunks ?? 0) >= (top.rows[i].chunks ?? 0), 'by chunks');
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
