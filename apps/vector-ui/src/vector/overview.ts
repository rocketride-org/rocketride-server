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
// VECTOR - THE OVERVIEW TAB (pure): its cards, top folders and insights
// =============================================================================
//
// The Overview says what a collection holds on one screen. Its cards are the
// store's own figures (`stats`, and the probe's `dialect`): a figure the
// store did not count is "—" with the reason, never an estimate. Top
// folders and Insights are read from the documents the console has loaded,
// so each says what it was counted over: every document, or "N loaded", and
// "within the current scope" while a scope filters the listing.
// =============================================================================

import type { IDialectResult, IDocumentItem } from '../contract/types';
import { UPLOADED_LABEL } from './documents';
import { formatSize } from './fileType';
import { documentHealth, needsAttention } from './health';
import type { IHealthFlag } from './health';
import type { IStatsView } from './results';
import { buildTree } from './tree';
import type { ITreeFolder } from './tree';
import { MISSING, formatCount, statsFigures } from './stats';

// =============================================================================
// CARDS
// =============================================================================

/** A card's reason while nothing was read yet. */
export const NOT_READ_YET = 'Not read yet.';

/** One card of the Summary. */
export interface IOverviewCard {
	key: 'documents' | 'chunks' | 'avg' | 'trash' | 'model' | 'index' | 'size';
	label: string;
	/** The value shown: a formatted figure, or "—" when the store did not give it. */
	value: string;
	tooltip: string | null;
	missing: boolean;
}

/**
 * The Summary's cards: Documents, Chunks, Chunks per document, In trash, Model, Dimensions · metric · index, and
 * Size only when the store reports it.
 *
 * @param stats - The last `stats` answer, or null before the first.
 * @param dialect - The probe's answer, or null.
 * @returns The cards, in that order.
 */
export function overviewCards(stats: IStatsView | null, dialect: IDialectResult | null): IOverviewCard[] {
	const figures = new Map(statsFigures(stats, dialect).map((f) => [f.key, f]));
	const from = (key: 'documents' | 'chunks' | 'avg', label: string, cardKey: IOverviewCard['key']): IOverviewCard => {
		const f = figures.get(key);
		return { key: cardKey, label, value: f?.value ?? MISSING, tooltip: f?.tooltip ?? null, missing: f?.missing ?? true };
	};
	const avg = from('avg', 'Chunks per document', 'avg');
	if (!avg.missing) avg.value = avg.value.replace(/\/doc$/, '');

	const inTrash = stats?.deletedDocuments ?? null;
	const deletedChunks = stats?.deleted ?? null;
	const trash: IOverviewCard =
		inTrash === null
			? { key: 'trash', label: 'In trash', value: MISSING, tooltip: 'This store cannot count the documents in its trash.', missing: true }
			: { key: 'trash', label: 'In trash', value: formatCount(inTrash), tooltip: deletedChunks === null ? `${formatCount(inTrash)} ${inTrash === 1 ? 'document' : 'documents'} with a chunk in the trash.` : `${formatCount(inTrash)} ${inTrash === 1 ? 'document' : 'documents'} with a chunk in the trash; ${formatCount(deletedChunks)} ${deletedChunks === 1 ? 'chunk' : 'chunks'} in all.`, missing: false };

	const model = stats?.model ?? dialect?.model ?? null;
	const modelCard: IOverviewCard = model === null ? { key: 'model', label: 'Model', value: MISSING, tooltip: 'This store does not record its embedding model.', missing: true } : { key: 'model', label: 'Model', value: model.split('/').pop() ?? model, tooltip: model, missing: false };

	const dimension = stats?.dimension ?? dialect?.dimension ?? null;
	const metric = stats?.metric ?? dialect?.metric ?? null;
	const index = dialect?.index?.type ?? null;
	const parts = [dimension === null ? null : `${formatCount(dimension)}-d`, metric, index === null ? null : index.toUpperCase()];
	const indexCard: IOverviewCard = parts.every((p) => p === null) ? { key: 'index', label: 'Dimensions · metric · index', value: MISSING, tooltip: 'This store does not report its dimension, metric or index.', missing: true } : { key: 'index', label: 'Dimensions · metric · index', value: parts.map((p) => p ?? MISSING).join(' · '), tooltip: parts.some((p) => p === null) ? 'A part the store does not report reads "—".' : null, missing: false };

	const cards = [from('documents', 'Documents', 'documents'), from('chunks', 'Chunks', 'chunks'), avg, trash, modelCard, indexCard];
	// Nothing read yet (the first answer is on its way, or failed): no card blames the store for it.
	if (stats === null) for (const card of cards) if (card.missing && (dialect === null || ['documents', 'chunks', 'avg', 'trash'].includes(card.key))) card.tooltip = NOT_READ_YET;
	const bytes = dialect?.size_bytes;
	if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) cards.push({ key: 'size', label: 'Size', value: formatSize(bytes), tooltip: `${formatSize(bytes)} on the store (${formatCount(bytes)} bytes)`, missing: false });
	return cards;
}

// =============================================================================
// TOP FOLDERS
// =============================================================================

/** How many folders the table names; the rest are one "Other folders" row. */
export const TOP_FOLDERS = 7;

/**
 * One row of Top folders: a folder with its subfolders (as Documents' folder view shows it), the documents stored
 * directly in a folder whose subfolders have rows of their own, or the documents stored under a bare name.
 */
export interface ITopFolder {
	kind: 'folder' | 'direct' | 'uploaded';
	/** The folder's prefix ("docs/field/"), separator included; the uploaded label for bare names. */
	folder: string;
	documents: number;
	/** Chunks of its documents, or null when the store did not count every one of them. */
	chunks: number | null;
	/** Its share of the chunks in percent (the rows sum to 100), or null when chunks are not known for every folder. */
	share: number | null;
}

/** Top folders, and what they were counted over. */
export interface ITopFolders {
	rows: ITopFolder[];
	/** The folders after the first {@link TOP_FOLDERS}, in one row; null when there are none. */
	others: (ITopFolder & { folders: number }) | null;
	/** Documents counted (the loaded ones). */
	loaded: number;
	/** Every folder has its chunk count. */
	chunksKnown: boolean;
}

/**
 * Integer percents of each value that sum to exactly 100 (largest remainder).
 *
 * @param values - Non-negative values.
 * @returns The percents, in the same order (all 0 when the values sum to 0).
 */
export function percentShares(values: readonly number[]): number[] {
	const total = values.reduce((sum, v) => sum + v, 0);
	if (total <= 0) return values.map(() => 0);
	const exact = values.map((v) => (v / total) * 100);
	const floors = exact.map(Math.floor);
	let left = 100 - floors.reduce((sum, v) => sum + v, 0);
	const order = exact.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
	for (const { i } of order) {
		if (left <= 0) break;
		floors[i] += 1;
		left -= 1;
	}
	return floors;
}

/** A group of documents before it is a row. */
interface IGroup {
	kind: ITopFolder['kind'];
	folder: string;
	rows: readonly IDocumentItem[];
}

/** Every document under a folder, its subfolders' included. */
function documentsUnder(folder: ITreeFolder): IDocumentItem[] {
	return [...folder.files, ...folder.children.flatMap(documentsUnder)];
}

/**
 * The folders of the loaded documents, each with its subfolders (the same documents Documents shows for it), by
 * their chunks (by documents where the store does not count chunks). The rows never overlap: from the top of the
 * folder tree, a level that is one folder alone is opened into its subfolders, and the documents stored directly in
 * it become a row of their own.
 *
 * @param rows - The loaded documents.
 * @param n - How many rows to name.
 * @returns The rows, the rest in one row, and what they were counted over.
 */
export function topFolders(rows: readonly IDocumentItem[], n: number = TOP_FOLDERS): ITopFolders {
	const tree = buildTree(rows);
	let level: ITreeFolder[] = tree.folders;
	const groups: IGroup[] = [];
	// A level of one folder says nothing: show what is inside it instead.
	while (level.length === 1 && tree.uploaded.length === 0 && level[0].children.length > 0) {
		const only = level[0];
		if (only.files.length > 0) groups.push({ kind: 'direct', folder: only.prefix, rows: only.files });
		level = only.children;
	}
	for (const folder of level) groups.push({ kind: 'folder', folder: folder.prefix, rows: documentsUnder(folder) });
	if (tree.uploaded.length > 0) groups.push({ kind: 'uploaded', folder: UPLOADED_LABEL, rows: tree.uploaded });

	const counted = groups.map((g) => ({ ...g, documents: g.rows.length, chunks: g.rows.reduce((sum, r) => sum + (r.chunks ?? 0), 0), unknown: g.rows.filter((r) => r.chunks === null).length }));
	const chunksKnown = rows.length > 0 && counted.every((g) => g.unknown === 0);
	const sorted = [...counted].sort((a, b) => (chunksKnown ? b.chunks - a.chunks : 0) || b.documents - a.documents || a.folder.localeCompare(b.folder));
	const named = sorted.slice(0, n);
	const rest = sorted.slice(n);
	const restSum = rest.reduce((sum, g) => ({ documents: sum.documents + g.documents, chunks: sum.chunks + g.chunks, unknown: sum.unknown + g.unknown }), { documents: 0, chunks: 0, unknown: 0 });
	const shares = chunksKnown ? percentShares([...named.map((g) => g.chunks), ...(rest.length === 0 ? [] : [restSum.chunks])]) : null;
	const toRow = (g: { kind: ITopFolder['kind']; folder: string; documents: number; chunks: number; unknown: number }, i: number): ITopFolder => ({ kind: g.kind, folder: g.folder, documents: g.documents, chunks: g.unknown === 0 ? g.chunks : null, share: shares === null ? null : (shares[i] ?? null) });
	const out = named.map((g, i) => toRow(g, i));
	const others = rest.length === 0 ? null : { ...toRow({ kind: 'folder', folder: '', ...restSum }, named.length), folders: rest.length };
	return { rows: out, others, loaded: rows.length, chunksKnown };
}

/**
 * The line under Top folders: what the rows were counted over.
 *
 * @param input - Documents loaded, whether the listing is complete, and whether a scope filters it.
 * @returns The line, or null when the rows are every document of the collection.
 */
export function overLine(input: { loaded: number; complete: boolean; scoped: boolean }): string | null {
	const base = input.complete ? null : `Over the ${formatCount(input.loaded)} ${input.loaded === 1 ? 'document' : 'documents'} loaded so far.`;
	if (!input.scoped) return base;
	return base === null ? 'Within the current scope.' : `Within the current scope; ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
}

// =============================================================================
// INSIGHTS
// =============================================================================

/** One document that needs attention. */
export interface IInsight {
	objectId: string;
	path: string;
	/** Its defect flags (oversize alone never puts a document here). */
	flags: IHealthFlag[];
}

/**
 * The loaded documents that need attention (the attention chip's count), by path.
 *
 * @param rows - The loaded documents.
 * @param median - Their median chunks per document, or null while the listing loads.
 * @returns The documents.
 */
export function insights(rows: readonly IDocumentItem[], median: number | null): IInsight[] {
	const out: IInsight[] = [];
	for (const row of rows) {
		const health = documentHealth(row, { medianChunks: median });
		if (needsAttention(health)) out.push({ objectId: row.objectId, path: row.path, flags: health.flags });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The Insights sub-tab's label: its count, with "+" while more documents may need attention than the loaded ones.
 *
 * @param flagged - Documents of the loaded ones that need attention.
 * @param complete - Every document is loaded.
 * @returns e.g. "Insights (3)", "Insights (3+)".
 */
export function insightsLabel(flagged: number, complete: boolean): string {
	return `Insights (${formatCount(flagged)}${complete ? '' : '+'})`;
}
