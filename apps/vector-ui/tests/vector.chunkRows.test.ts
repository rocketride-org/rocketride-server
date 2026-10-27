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

// =============================================================================
// VECTOR CHUNK ROWS: copies for the grid, the cell text, the drawer's neighbours
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IChunkItem, INeighborItem } from '../src/contract/types';
import { CELL_TEXT_CHARS, DRAWER_NEIGHBOURS, cellText, chunkRows, neighbourRows, neighboursCaption, neighboursK, neighboursUnavailable } from '../src/vector/chunkRows';

const chunk = (id: number, over: Partial<IChunkItem> = {}): IChunkItem => ({ chunkId: id, content: `text ${id}`, length: 6, isTable: false, tableId: 0, isDeleted: false, pointId: null, metadata: {}, ...over });

test('rows are copies: a grid that writes to them leaves the listing alone, and a score reaches only its chunk', () => {
	const items = [chunk(0), chunk(1, { isTable: true }), chunk(2, { isDeleted: true })];
	const frozen = JSON.stringify(items);
	const rows = chunkRows(items, [{ chunkId: 1, sim: 0.83 }]);
	assert.deepEqual(rows.map((r) => [r.id, r.score, r.isTable, r.isDeleted]), [['0', null, false, false], ['1', 0.83, true, false], ['2', null, false, true]]);
	(rows[0] as unknown as Record<string, unknown>).tabulatorKey = 1;
	assert.equal(JSON.stringify(items), frozen);
	assert.notEqual(chunkRows(items, null)[0], rows[0], 'new rows each time it is called');
	assert.equal(chunkRows(items, null).every((r) => r.score === null), true);
});

test('cell text folds whitespace and is cut; the chars column is the stored length', () => {
	assert.equal(cellText(' a\n\nb  c '), 'a b c');
	assert.equal(cellText('y'.repeat(900)).length, CELL_TEXT_CHARS);
	assert.equal(chunkRows([chunk(0, { content: 'y'.repeat(900), length: 900 })], null)[0].chars, 900);
});

test('a trashed chunk has no neighbours, and says why', () => {
	assert.equal(neighboursUnavailable({ isDeleted: false }), null);
	assert.match(neighboursUnavailable({ isDeleted: true }) ?? '', /trash.*skips trashed chunks/);
});

test('neighbours: the document\'s own chunks are left out, the rest keep the store\'s order and are cut to 12; k covers the own chunks', () => {
	const item = (o: string, c: number, sim: number): INeighborItem => ({ key: [o, c], sim, score: sim, below_floor: false, path: `${o}.md`, chunkId: c, preview: 'p' });
	const list = neighbourRows([item('a', 3, 0.9), item('b', 0, 0.8), item('a', 4, 0.7), item('c', 1, 0.6)], 'a');
	assert.deepEqual(list.rows.map((r) => r.id), ['b#0', 'c#1']);
	assert.equal(list.leftOut, 2);
	assert.equal(neighboursCaption(list, 16), 'The 2 nearest chunks from other documents, out of the 16 nearest the store returned. 2 chunks of this document were left out.');
	const none = neighbourRows([item('a', 3, 0.9)], 'a');
	assert.equal(neighboursCaption(none, 12), 'None of the 12 nearest chunks the store returned is from another document. 1 chunk of this document was left out.');
	const many = neighbourRows(Array.from({ length: 30 }, (_, i) => item('b', i, 1 - i / 100)), 'a');
	assert.equal(many.rows.length, DRAWER_NEIGHBOURS);
	assert.equal(neighboursK(null, 50), 12);
	assert.equal(neighboursK(20, 50), 32);
	assert.equal(neighboursK(500, 50), 50, 'never over the store\'s limit');
	assert.equal(neighboursK(500, 10), 10);
});
