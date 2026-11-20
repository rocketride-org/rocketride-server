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
// VECTOR - CHUNK ROWS (pure): a document's chunks as grid rows, and the chunk drawer's neighbours
// =============================================================================
//
// The Chunks grid is handed COPIES of the chunk listing (the listing the tab
// holds is never the grid's), built once per listing. A row keeps a reference
// to its chunk only to read it. The drawer's neighbours come from the store's
// `neighbors` (the 12 nearest chunks of the whole collection, the chunk
// itself left out); a chunk in the trash has none, because the store skips
// trashed chunks.
// =============================================================================

import type { IChunkItem, INeighborItem } from '../contract/types';
import type { IHeatScore } from './heat';

/** How many neighbours the drawer asks for. */
export const DRAWER_NEIGHBOURS = 12;

/** The longest text shown in a cell (the drawer shows all of it). */
export const CELL_TEXT_CHARS = 200;

/** One row of the Chunks grid. */
export interface IChunkRow {
	/** The chunk id as text: the row's id. */
	id: string;
	chunkId: number;
	/** The chunk's text as one line. */
	text: string;
	chars: number;
	isTable: boolean;
	/** The table the chunk belongs to (meaningful when `isTable`). */
	tableId: number;
	isDeleted: boolean;
	/** The chunk's similarity to the active query, or null (no query, or the store scored none). */
	score: number | null;
}

/**
 * A chunk's text as one cell line.
 *
 * @param content - The chunk's text.
 * @returns The text with its whitespace folded, cut to {@link CELL_TEXT_CHARS} characters.
 */
export function cellText(content: string): string {
	const text = content.replace(/\s+/g, ' ').trim();
	return text.length > CELL_TEXT_CHARS ? `${text.slice(0, CELL_TEXT_CHARS - 1)}…` : text;
}

/**
 * The grid's rows for a chunk listing.
 *
 * @param items - The chunks listed, in reading order.
 * @param heat - The chunks' similarity to the active query, when one was scored.
 * @returns New rows (nothing shared with `items`).
 */
export function chunkRows(items: readonly IChunkItem[], heat: readonly IHeatScore[] | null): IChunkRow[] {
	const scores = new Map<number, number>((heat ?? []).map((s) => [s.chunkId, s.sim]));
	return items.map((chunk) => ({ id: String(chunk.chunkId), chunkId: chunk.chunkId, text: cellText(chunk.content), chars: chunk.length, isTable: chunk.isTable, tableId: chunk.tableId, isDeleted: chunk.isDeleted, score: scores.get(chunk.chunkId) ?? null }));
}

/**
 * Why the drawer cannot list a chunk's neighbours, or null when it can.
 *
 * @param chunk - The chunk.
 * @returns The reason.
 */
export function neighboursUnavailable(chunk: Pick<IChunkItem, 'isDeleted'>): string | null {
	return chunk.isDeleted ? 'This chunk is in the trash, and the store skips trashed chunks when it looks for neighbours.' : null;
}

/** One neighbour in the drawer. */
export interface INeighbourRow {
	id: string;
	objectId: string;
	chunkId: number;
	path: string;
	similarity: number;
	preview: string;
	belowFloor: boolean;
}

/** The drawer's neighbours. */
export interface INeighbourList {
	rows: INeighbourRow[];
	/** Chunks of the document itself that were left out. */
	leftOut: number;
}

/**
 * How many neighbours to ask the store for: the rows wanted plus every chunk of the document itself (they can all be
 * among the nearest), at most the store's limit.
 *
 * @param documentChunks - The document's chunk count, when known.
 * @param max - `limits.neighbors_k_max`.
 * @returns k.
 */
export function neighboursK(documentChunks: number | null, max: number): number {
	const extra = documentChunks !== null && Number.isFinite(documentChunks) ? Math.max(0, Math.floor(documentChunks)) : 0;
	return Math.max(1, Math.min(DRAWER_NEIGHBOURS + extra, Math.floor(max)));
}

/**
 * The neighbours as rows, nearest first as the store ranked them: the chunks of the document itself are left out (the
 * Chunks grid lists those) and the rest cut to {@link DRAWER_NEIGHBOURS}.
 *
 * @param items - The store's neighbours.
 * @param objectId - The document the chunk belongs to.
 * @returns The rows and how many of the document's own chunks were left out.
 */
export function neighbourRows(items: readonly INeighborItem[], objectId: string): INeighbourList {
	const others = items.filter((item) => item.key[0] !== objectId);
	const rows = others.slice(0, DRAWER_NEIGHBOURS).map((item) => ({ id: `${item.key[0]}#${item.key[1]}`, objectId: item.key[0], chunkId: item.key[1], path: item.path, similarity: item.sim, preview: item.preview, belowFloor: item.below_floor }));
	return { rows, leftOut: items.length - others.length };
}

/**
 * The line above the neighbours.
 *
 * @param list - The rows and what was left out.
 * @param returned - How many chunks the store returned (before the document's own were left out).
 * @returns What they are, or why there are none.
 */
export function neighboursCaption(list: INeighbourList, returned: number): string {
	const out = list.leftOut === 0 ? '' : ` ${list.leftOut} ${list.leftOut === 1 ? 'chunk' : 'chunks'} of this document ${list.leftOut === 1 ? 'was' : 'were'} left out.`;
	if (list.rows.length === 0) return `None of the ${returned} nearest chunks the store returned is from another document.${out}`;
	return `The ${list.rows.length} nearest ${list.rows.length === 1 ? 'chunk' : 'chunks'} from other documents, out of the ${returned} nearest the store returned.${out}`;
}
