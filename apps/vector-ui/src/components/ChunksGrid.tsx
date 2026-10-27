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
// VECTOR-UI - CHUNKS GRID (a document's chunks: sortable, one row in the tab order)
// =============================================================================
//
// The Chunks sub-tab of a document. Columns: #, Text, Chars, Table, Deleted,
// and Score while the heat strip has scored the chunks against a query. The
// rows are copies built from the listing (vector/chunkRows.ts); sorting is in
// the browser over the chunks listed. Enter or a click on a row opens the
// chunk drawer. No persisted layout: the grid keeps nothing between visits.
// =============================================================================

import React, { forwardRef, useMemo, useState } from 'react';
import type { ForwardedRef } from 'react';
import type { IChunkRow } from '../vector/chunkRows';
import type { IGridSort } from '../vector/grid';
import VectorGrid from './VectorGrid';
import type { IGridColumn, IVectorGridHandle } from './VectorGrid';

/** The columns. Score only when the chunks were scored. */
export function chunkColumns(withScore: boolean): Array<IGridColumn<IChunkRow>> {
	const columns: Array<IGridColumn<IChunkRow>> = [
		{ id: 'chunk', label: '#', width: 64, align: 'right', sortValue: (r) => r.chunkId, cell: (r) => String(r.chunkId) },
		{ id: 'text', label: 'Text', width: 'flex', minWidth: 220, sortValue: (r) => r.text, cell: (r) => r.text || '(no text)' },
		{ id: 'chars', label: 'Chars', width: 80, align: 'right', sortValue: (r) => r.chars, cell: (r) => r.chars.toLocaleString('en-US') },
		{ id: 'table', label: 'Table', width: 70, sortValue: (r) => (r.isTable ? 1 : 0), cell: (r) => (r.isTable ? `Table ${r.tableId}` : '') },
		{ id: 'deleted', label: 'Deleted', width: 80, sortValue: (r) => (r.isDeleted ? 1 : 0), cell: (r) => (r.isDeleted ? 'Deleted' : '') },
	];
	if (withScore) columns.push({ id: 'score', label: 'Score', width: 80, align: 'right', title: "Similarity to the active query, recomputed by the store's metric", sortValue: (r) => r.score, cell: (r) => (r.score === null ? '—' : r.score.toFixed(3)) });
	return columns;
}

const rowId = (row: IChunkRow): string => row.id;

/** Props. */
export interface IChunksGridProps {
	rows: readonly IChunkRow[];
	/** The chunk shown in the drawer, if any. */
	selectedId: string | null;
	withScore: boolean;
	onOpen(row: IChunkRow): void;
	/** Keep the last rows while a new listing loads. */
	hold: boolean;
}

/**
 * The grid.
 *
 * @param props - {@link IChunksGridProps}.
 * @param ref - {@link IVectorGridHandle}.
 * @returns The grid.
 */
function ChunksGridInner({ rows, selectedId, withScore, onOpen, hold }: IChunksGridProps, ref: ForwardedRef<IVectorGridHandle>): React.ReactElement {
	const [sort, setSort] = useState<IGridSort | null>(null);
	const columns = useMemo(() => chunkColumns(withScore), [withScore]);
	// A sort on a column that is gone (Score, once the query is) falls back to the listing's order.
	const effective = sort !== null && columns.some((c) => c.id === sort.column) ? sort : null;
	return <VectorGrid ref={ref} label="Chunks" rows={rows} rowId={rowId} columns={columns} sort={effective} onSort={setSort} selectedId={selectedId} onActivate={onOpen} activateOnClick hold={hold} empty="No chunks are listed." />;
}

export const ChunksGrid = forwardRef(ChunksGridInner);

export default ChunksGrid;
