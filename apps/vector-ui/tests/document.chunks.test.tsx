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
// THE DOCUMENT TAB'S CHUNKS: the sub-tabs, the grid's columns, the drawer's wiring
// =============================================================================
//
// The harness renders on the server only, so what happens in a browser (focus
// back to the row, Escape, the neighbours call on open) is pinned in the
// source here and checked live (PLAN-MAP M31, M33, M34).
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChunksGrid, chunkColumns } from '../src/components/ChunksGrid';
import { metadataText } from '../src/components/ChunkDrawer';
import { chunkRows } from '../src/vector/chunkRows';
import type { IChunkItem } from '../src/contract/types';

const code = (file: string): string =>
	fs
		.readFileSync(path.resolve(__dirname, '..', 'src', file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

const chunk = (id: number, over: Partial<IChunkItem> = {}): IChunkItem => ({ chunkId: id, content: `text ${id}`, length: 6, isTable: false, tableId: 0, isDeleted: false, pointId: null, metadata: {}, ...over });

test('the Chunks columns: #, Text, Chars, Table, Deleted, and Score only when the chunks were scored', () => {
	assert.deepEqual(chunkColumns(false).map((c) => c.label), ['#', 'Text', 'Chars', 'Table', 'Deleted']);
	assert.deepEqual(chunkColumns(true).map((c) => c.label), ['#', 'Text', 'Chars', 'Table', 'Deleted', 'Score']);
	const rows = chunkRows([chunk(2, { isTable: true }), chunk(1, { isDeleted: true })], [{ chunkId: 1, sim: 0.5 }]);
	const by = new Map(chunkColumns(true).map((c) => [c.id, c]));
	assert.deepEqual(rows.map((r) => by.get('score')?.sortValue?.(r)), [null, 0.5]);
	assert.equal(by.get('table')?.cell(rows[0], { tabIndex: -1 }), 'Table');
	assert.equal(by.get('deleted')?.cell(rows[1], { tabIndex: -1 }), 'Deleted');
	assert.equal(by.get('score')?.cell(rows[1], { tabIndex: -1 }), '0.500');
	assert.equal(by.get('score')?.cell(rows[0], { tabIndex: -1 }), '—');
});

test('the grid renders as a grid with every chunk a row, one of them in the tab order', () => {
	const rows = chunkRows([chunk(0), chunk(1), chunk(2)], null);
	const html = renderToStaticMarkup(<ChunksGrid rows={rows} selectedId="1" withScore={false} hold={false} onOpen={() => undefined} />);
	assert.match(html, /role="grid"/);
	assert.match(html, /aria-label="Chunks"/);
	assert.equal(html.match(/role="row"/g)?.length, 4, 'a header and three chunks');
	assert.equal(html.match(/tabindex="0"/g)?.length, 1);
});

test('a metadata value is text, cut to a line', () => {
	assert.equal(metadataText('a'), 'a');
	assert.equal(metadataText({ k: 1 }), '{"k":1}');
	assert.equal(metadataText('z'.repeat(500)).length, 200);
});

test('the document tab: Reader and Chunks; the grid has no persisted layout; copyText stays exported', () => {
	const view = code('views/DocumentView.tsx');
	assert.match(view, /\{ id: 'reader', label: 'Reader' \}/);
	assert.match(view, /\{ id: 'chunks', label: 'Chunks' \}/);
	assert.match(view, /export function copyText\(text: string, announce: \(message: string\) => void\): void/, 'P2 imports it');
	assert.match(view, /useMemo\(\(\) => chunkRows\(chunks\.items, scores\), \[chunks\.items, scores\]\)/, 'copies of the listing, rebuilt only when it changes');
	assert.match(view, /\{chunksShown && \(/, 'the grid mounts when first shown');
	for (const file of ['views/DocumentView.tsx', 'components/ChunksGrid.tsx', 'components/ChunkDrawer.tsx']) {
		const text = code(file);
		assert.doesNotMatch(text, /tableId=|persistence=|<DataGrid\b|<(Modal|DetailPanel|ConfirmDialog)\b/, `${file}: no persisted grid layout and no overlay`);
		assert.doesNotMatch(text, /stopPropagation|(window|document)\.addEventListener/, `${file}: no stopped events and no page listeners`);
	}
});

test('the chunk drawer: neighbours on open (12, none for a trashed chunk), Escape that skips a handled event, focus back on the row', () => {
	const drawer = code('components/ChunkDrawer.tsx');
	assert.match(drawer, /fetchNeighbors\(caller, store, key, asked\)/);
	assert.match(drawer, /neighboursUnavailable\(\{ isDeleted: deleted \}\)/);
	assert.match(drawer, /if \(event\.key !== 'Escape' \|\| event\.defaultPrevented\) return;\s*event\.preventDefault\(\);\s*onClose\(\);/);
	assert.match(drawer, /Try again/, 'a busy store is said, with a way to ask again');
	const view = code('views/DocumentView.tsx');
	assert.match(view, /gridRef\.current\?\.focusRow\(String\(openChunk\)\)/);
	assert.match(view, /\{openChunk !== null && <ChunkDrawer /);
	assert.match(view, /\{\.\.\.\(actions\.useAsQuery \? \{ onUseAsQuery: actions\.useAsQuery \} : \{\}\)\}/, "'Use as query' only where the console's actions carry it (a dev-tool document frame strips it)");
});
