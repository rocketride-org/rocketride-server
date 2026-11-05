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
// VECTOR - DOCUMENT DIRECTORY (pure): folders from paths, and the background auto-pager
// =============================================================================
//
// The directory lists every document once by its path (R3). Folders are
// derived here, in the browser, from `/` and `\` in the stored path (the
// store keeps paths as the ingest sent them: Windows drive letters, network
// shares and POSIX roots stay as they are). A bare file name goes under
// "Uploaded"; a document with a defect (vector/health.ts: no first chunk,
// gaps, deleted chunks, empty parse) goes under "Needs attention", by its
// whole path, with its flags as badges; an oversize document keeps its
// folder and gets the badge there; two documents with the same path stay two
// rows, told apart by a short objectId.
//
// AUTO-PAGING. After the first page the directory keeps asking for pages in
// the background, up to DIRECTORY_AUTO_ROWS (5,000) rows. The first page is
// sorted; later pages are APPENDED (each row at the end of its folder, new
// folders after the existing ones), so a row that is on screen never moves
// above another while pages arrive; everything is sorted again when loading
// ends, pauses or fails. Past the cap the footer says "Limit reached at N
// documents; more may exist" with Load more (+5,000). A store that ignores
// the page offset ends the listing with `documents_paging_unsupported`. A row
// seen before (same objectId) is never listed twice, and a page that brings no
// row not already listed ends the listing too (the store sent rows it had sent
// before; asking again would get them again), so every page that keeps the
// listing going adds a row and the cap always ends it.
// =============================================================================

import type { FilterApplied, IDocumentItem, IDocumentsFilter, IExportRows } from '../contract/types';
import { EXPORT_COLUMNS } from '../contract/types';
import { DIRECTORY_AUTO_ROWS, DIRECTORY_LOAD_MORE } from './budgets';
import { documentHealth, needsAttention } from './health';
import type { IDocumentsPageView } from './results';
import { formatCount } from './stats';
import { CAVEAT_SENTENCES, DOCUMENTS_REPEATED_TEXT } from './wording';
import type { IFailureText } from './wording';

// =============================================================================
// PATHS AND GROUPS
// =============================================================================

/** Where a stored path puts a document. */
export interface IPathParts {
	/** The folder label: everything up to the last separator (kept as stored), or 'Uploaded'. */
	folder: string;
	/** The file name. */
	name: string;
	/** True when the path is a bare name (no folder). */
	uploaded: boolean;
}

/** The group of bare names. */
export const UPLOADED_LABEL = 'Uploaded';

/**
 * Split a stored path into its folder and file name.
 *
 * @param path - The path as stored (`metadata.parent`).
 * @returns The parts.
 */
export function splitPath(path: string): IPathParts {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (cut < 0) return { folder: UPLOADED_LABEL, name: path === '' ? '(no path)' : path, uploaded: true };
	return { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) || path, uploaded: false };
}

/** One row of the directory. */
export interface IDirectoryRow {
	item: IDocumentItem;
	/** The name shown: the file name, or the whole path in the "Needs attention" group. */
	name: string;
	/** True when another loaded document has the same path. */
	duplicate: boolean;
	/** The first 8 characters of the objectId (shown on hover, and beside a duplicate). */
	shortId: string;
	/** The health flags' badges ('no first chunk', '1 deleted chunk', 'oversize'); empty for a healthy document. */
	flags: string[];
	/** The row is under "Needs attention" (a defect; an oversize document alone keeps its folder). */
	attention: boolean;
}

/** One group of the directory. */
export interface IDirectoryGroup {
	key: string;
	label: string;
	kind: 'folder' | 'uploaded' | 'attention';
	rows: IDirectoryRow[];
}

/** Rank of each group kind: folders, then Uploaded, then Needs attention. */
const KIND_RANK: Readonly<Record<IDirectoryGroup['kind'], number>> = { folder: 0, uploaded: 1, attention: 2 };

/** The group kind and folder label of one document (by its first chunk; buildGroups adds the other flags). */
function placeOf(item: IDocumentItem): { kind: IDirectoryGroup['kind']; folder: string; name: string } {
	if (!item.has_first_chunk) return { kind: 'attention', folder: '', name: item.path || '(no path)' };
	const parts = splitPath(item.path);
	return { kind: parts.uploaded ? 'uploaded' : 'folder', folder: parts.folder, name: parts.name };
}

/** Code-point comparison, lower case first, so the order is the same in every browser and locale. */
function compareText(a: string, b: string): number {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	if (la !== lb) return la < lb ? -1 : 1;
	return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The directory's order: folders (by label), Uploaded, documents without a first chunk; inside a group by name, path, objectId.
 *
 * @param a - A document.
 * @param b - Another document.
 * @returns Negative, zero or positive.
 */
export function compareDocuments(a: IDocumentItem, b: IDocumentItem): number {
	const pa = placeOf(a);
	const pb = placeOf(b);
	return KIND_RANK[pa.kind] - KIND_RANK[pb.kind] || compareText(pa.folder, pb.folder) || compareText(pa.name, pb.name) || compareText(a.path, b.path) || compareText(a.objectId, b.objectId);
}

/**
 * Sort documents in the directory's order (a copy).
 *
 * @param items - The documents.
 * @returns The sorted copy.
 */
export function sortDocuments(items: readonly IDocumentItem[]): IDocumentItem[] {
	return [...items].sort(compareDocuments);
}

/**
 * Group rows for display, keeping their order: folders in order of first
 * appearance, then Uploaded, then Needs attention (by path). The pager decides
 * when the rows are sorted (see the header), so grouping never reorders a
 * folder. A document goes under Needs attention when it has a defect flag;
 * "oversize" (which needs the median, passed once the listing settled) is a
 * badge in the document's own folder, so no row moves when it comes or goes.
 *
 * In the Trash view (`trash`) every document has chunks in the trash: that is why it is listed there, so its
 * deleted chunks are neither a badge nor a reason to need attention.
 *
 * @param rows - The documents, in display order.
 * @param health - The median chunks per loaded document (null while unknown); `trash` for the Trash view.
 * @returns The groups.
 */
export function buildGroups(rows: readonly IDocumentItem[], health: { medianChunks: number | null; trash?: boolean } = { medianChunks: null }): IDirectoryGroup[] {
	const pathCounts = new Map<string, number>();
	for (const item of rows) pathCounts.set(item.path, (pathCounts.get(item.path) ?? 0) + 1);
	const folders = new Map<string, IDirectoryGroup>();
	const uploaded: IDirectoryGroup = { key: 'uploaded', label: UPLOADED_LABEL, kind: 'uploaded', rows: [] };
	const attention: IDirectoryGroup = { key: 'attention', label: '', kind: 'attention', rows: [] };
	for (const item of rows) {
		const place = placeOf(item);
		const all = documentHealth(item, { medianChunks: health.medianChunks }).flags;
		const shown = health.trash ? all.filter((f) => f.kind !== 'deleted_chunks') : all;
		const row: IDirectoryRow = { item, name: place.name, duplicate: (pathCounts.get(item.path) ?? 0) > 1, shortId: item.objectId.slice(0, 8), flags: shown.map((f) => f.label), attention: needsAttention({ flags: shown }) };
		if (row.attention) attention.rows.push({ ...row, name: item.path || '(no path)' });
		else if (place.kind === 'uploaded') uploaded.rows.push(row);
		else {
			let group = folders.get(place.folder);
			if (!group) {
				group = { key: `folder:${place.folder}`, label: place.folder, kind: 'folder', rows: [] };
				folders.set(place.folder, group);
			}
			group.rows.push(row);
		}
	}
	attention.rows.sort((a, b) => compareText(a.item.path, b.item.path) || compareText(a.item.objectId, b.item.objectId));
	attention.label = `Needs attention (${formatCount(attention.rows.length)})`;
	return [...folders.values(), uploaded, attention].filter((group) => group.rows.length > 0);
}

/**
 * The documents whose path contains the filter text (case-insensitive), in order.
 *
 * @param items - The loaded documents.
 * @param text - The filter box's text.
 * @returns The matches (all of them for a blank filter).
 */
export function filterItems(items: readonly IDocumentItem[], text: string): IDocumentItem[] {
	const needle = text.trim().toLowerCase();
	if (needle === '') return [...items];
	return items.filter((item) => item.path.toLowerCase().includes(needle));
}

// =============================================================================
// AUTO-PAGER
// =============================================================================

/** Where the directory's listing is. */
export type PagerStatus = 'idle' | 'loading' | 'paused' | 'done' | 'capped' | 'unsupported' | 'stalled' | 'error';

/** The directory's listing state (replaced, never mutated). */
export interface IPagerState {
	/** Every loaded document once, in display order (see the header). */
	rows: IDocumentItem[];
	/** The cursor of the next page, or null when the store has no more. */
	cursor: string | null;
	/** The store's total, when it said. */
	total: number | null;
	status: PagerStatus;
	/** Stop asking at this many rows (Load more raises it). */
	cap: number;
	/** False when the store lists in storage order (the directory sorts here). */
	storeSorted: boolean;
	/** Caveats of the last page. */
	caveats: string[];
	/** Why loading stopped, when it failed. */
	error: IFailureText | null;
	/** Pages applied so far. */
	pages: number;
	/** What this listing asked the store for (the scope's conditions and path box), or null for every document. */
	filter: IDocumentsFilter | null;
	/**
	 * How much of `filter` the store applied, from its first answer: 'server', 'partial' or 'none' ('none' too
	 * when an older node answered without saying, having ignored it); null while unknown or without a filter.
	 */
	filterApplied: FilterApplied | null;
	/** The keys of `filter` the store did not apply (filtered here). */
	filterIgnored: string[];
}

/**
 * A listing that has not asked for anything yet.
 *
 * @param cap - The auto-load cap.
 * @returns The state.
 */
export function pagerInit(cap: number = DIRECTORY_AUTO_ROWS): IPagerState {
	return { rows: [], cursor: null, total: null, status: 'idle', cap, storeSorted: true, caveats: [], error: null, pages: 0, filter: null, filterApplied: null, filterIgnored: [] };
}

/**
 * Start (or restart) the listing from the first page.
 *
 * @param state - The state (its cap is kept).
 * @param filter - The conditions to ask the store for (default: the listing's own; null for every document).
 * @returns A loading state with nothing loaded.
 */
export function pagerBegin(state: IPagerState, filter: IDocumentsFilter | null = state.filter): IPagerState {
	return { ...pagerInit(state.cap), status: 'loading', filter };
}

/** The keys a filter sets (null and absent keys are not filtered by). */
function setKeys(filter: IDocumentsFilter): string[] {
	return Object.entries(filter)
		.filter(([, value]) => value !== null && value !== undefined)
		.map(([key]) => key);
}

/**
 * Whether the listing wants its next page now.
 *
 * @param state - The state.
 * @returns True while loading.
 */
export function pagerWantsPage(state: IPagerState): boolean {
	return state.status === 'loading';
}

/**
 * Apply one page.
 *
 * @param state - The state (loading).
 * @param page - The page the store answered with.
 * @returns The next state.
 */
export function pagerApplyPage(state: IPagerState, page: IDocumentsPageView): IPagerState {
	const seen = new Set(state.rows.map((row) => row.objectId));
	const fresh: IDocumentItem[] = [];
	for (const item of page.items) {
		if (seen.has(item.objectId)) continue;
		seen.add(item.objectId);
		fresh.push(item);
	}
	const first = state.pages === 0;
	let rows = first ? sortDocuments(fresh) : [...state.rows, ...fresh];
	// With a filter, the first answer says how much of it the store applied; an older node says nothing (it ignored it).
	let filterApplied = state.filterApplied;
	let filterIgnored = state.filterIgnored;
	if (first && state.filter !== null) {
		filterApplied = page.filterApplied ?? 'none';
		filterIgnored = page.filterApplied === undefined ? setKeys(state.filter) : [...(page.filterIgnored ?? [])];
	}
	const base = { ...state, cursor: page.nextCursor, total: page.total ?? state.total, storeSorted: page.sorted, caveats: page.caveats, error: null, pages: state.pages + 1, filterApplied, filterIgnored };
	let status: PagerStatus = 'loading';
	if (page.pagingUnsupported) status = 'unsupported';
	else if (page.nextCursor === null || page.items.length === 0) status = 'done';
	// Nothing new on a page means the store answered rows it had already sent (it
	// ignored the cursor): asking again would get the same rows. Every page that
	// does not end the listing therefore adds a row, so the listing ends by the cap.
	else if (fresh.length === 0) status = base.total !== null && rows.length >= base.total ? 'done' : 'stalled';
	else if (rows.length >= state.cap) status = 'capped';
	if (status !== 'loading') rows = sortDocuments(rows);
	return { ...base, rows, status, cursor: status === 'loading' || status === 'capped' ? base.cursor : null };
}

/**
 * Loading failed: keep what is loaded (sorted) and say why.
 *
 * @param state - The state.
 * @param error - Why.
 * @returns An error state.
 */
export function pagerFail(state: IPagerState, error: IFailureText): IPagerState {
	return { ...state, rows: sortDocuments(state.rows), status: 'error', error };
}

/**
 * Pause a listing that is loading (the console was hidden): what is loaded is sorted.
 *
 * @param state - The state.
 * @returns The paused state, or the state as it was.
 */
export function pagerPause(state: IPagerState): IPagerState {
	return state.status === 'loading' && state.pages > 0 ? { ...state, rows: sortDocuments(state.rows), status: 'paused' } : state;
}

/**
 * Resume a paused or failed listing at its cursor (a failed first page starts again).
 *
 * @param state - The state.
 * @returns The loading state, or the state as it was.
 */
export function pagerResume(state: IPagerState): IPagerState {
	if (state.status === 'error' && state.pages === 0) return pagerBegin(state);
	return (state.status === 'paused' || state.status === 'error') && state.cursor !== null ? { ...state, status: 'loading', error: null } : state;
}

/**
 * Load more past the cap.
 *
 * @param state - The state.
 * @returns Loading again with the cap raised, or the state as it was when there is nothing more.
 */
export function pagerLoadMore(state: IPagerState): IPagerState {
	return state.status === 'capped' && state.cursor !== null ? { ...state, status: 'loading', cap: state.cap + DIRECTORY_LOAD_MORE } : state;
}

/**
 * The progress line while loading ("Loading documents… 1,200 of 10,000").
 *
 * @param state - The state.
 * @returns The line, or null when not loading.
 */
export function pagerProgressText(state: IPagerState): string | null {
	if (state.status !== 'loading' || state.pages === 0) return null;
	const loaded = formatCount(state.rows.length);
	return state.total === null ? `Loading documents… ${loaded} loaded` : `Loading documents… ${loaded} of ${formatCount(state.total)}`;
}

/** The directory's footer. */
export interface IPagerFooter {
	text: string;
	/** Offer Load more (past the cap, with a cursor). */
	loadMore: boolean;
	/** A caveat sentence to show under it. */
	caveat: string | null;
	/** Offer Retry (loading failed). */
	retry: boolean;
}

/**
 * The footer under the directory, or null when there is nothing to say.
 *
 * @param state - The state.
 * @returns The footer.
 */
export function pagerFooter(state: IPagerState): IPagerFooter | null {
	const loaded = formatCount(state.rows.length);
	switch (state.status) {
		case 'capped':
			return { text: `Limit reached at ${loaded} documents; more may exist`, loadMore: true, caveat: null, retry: false };
		case 'unsupported':
			return { text: `Limit reached at ${loaded} documents; more may exist`, loadMore: false, caveat: CAVEAT_SENTENCES.documents_paging_unsupported, retry: false };
		case 'stalled':
			return { text: `Loading stopped at ${loaded} documents; more may exist`, loadMore: false, caveat: DOCUMENTS_REPEATED_TEXT, retry: false };
		case 'error':
			return { text: `Loading stopped at ${loaded} documents: ${state.error?.headline ?? 'the store did not answer.'}`, loadMore: false, caveat: null, retry: true };
		case 'paused':
			return { text: `Loading paused at ${loaded} documents`, loadMore: false, caveat: null, retry: false };
		case 'done':
			return state.storeSorted ? null : { text: 'sorted here; this store lists documents in storage order', loadMore: false, caveat: null, retry: false };
		default:
			return null;
	}
}

/**
 * The count beside the DOCUMENTS heading: the store's total when it said, else what is loaded.
 *
 * @param state - The state.
 * @returns e.g. '42 documents' or '1,200 loaded'.
 */
export function directoryHeading(state: IPagerState): string {
	if (state.total !== null) return `${formatCount(state.total)} ${state.total === 1 ? 'document' : 'documents'}`;
	const n = state.rows.length;
	if (state.status === 'done') return `${formatCount(n)} ${n === 1 ? 'document' : 'documents'}`;
	return `${formatCount(n)} loaded`;
}

/**
 * What the filter box says while a filter is applied.
 *
 * @param state - The state.
 * @param filter - The filter text.
 * @param matches - How many loaded rows match.
 * @returns "filtering N of M loaded" while loading, "N of M documents" when complete, null without a filter.
 */
export function filterSummary(state: IPagerState, filter: string, matches: number): string | null {
	if (filter.trim() === '') return null;
	const total = state.total ?? state.rows.length;
	if (state.status === 'loading' || state.status === 'paused') return `filtering ${formatCount(state.rows.length)} of ${formatCount(total)} loaded`;
	return `${formatCount(matches)} of ${formatCount(total)} documents`;
}

/**
 * Directory rows as an export (the documents columns): words and numbers the
 * directory shows, never anything else the store sent.
 *
 * @param items - The documents, in the directory's order.
 * @returns The columns and rows.
 */
export function documentExportRows(items: readonly IDocumentItem[]): IExportRows {
	return {
		columns: EXPORT_COLUMNS.documents,
		rows: items.map((item) => ({
			objectId: item.objectId,
			path: item.path,
			chunks: item.chunks,
			has_first_chunk: item.has_first_chunk,
			tables: item.tables,
			size: item.size,
			ingestedAt: item.ingestedAt,
			deleted_chunks: item.deleted_chunks ?? null,
			max_chunk_id: item.max_chunk_id ?? null,
		})),
	};
}
