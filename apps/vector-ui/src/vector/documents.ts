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
// VECTOR - THE DOCUMENTS LISTING (pure): paths, the background auto-pager, and the Documents tab's words
// =============================================================================
//
// The Documents tab lists every document once by its path (R3). Folders are
// derived in the browser from `/` and `\` in the stored path (the store keeps
// paths as the ingest sent them: Windows drive letters, network shares and
// POSIX roots stay as they are); a bare file name is "Uploaded". Two
// documents with the same path stay two rows, told apart by a short
// objectId. A document's defects (vector/health.ts) are its Health cell.
//
// AUTO-PAGING. After the first page the listing keeps asking for pages in
// the background, up to DIRECTORY_AUTO_ROWS (5,000) rows. The first page is
// sorted; later pages are APPENDED, so a row on screen never moves above
// another while pages arrive; everything is sorted again when loading ends,
// pauses or fails (folders, then Uploaded, then documents without a first
// chunk; by name inside). Past the cap the footer says "Limit reached at N
// documents; more may exist" with Load more (+5,000). A store that ignores
// the page offset ends the listing with `documents_paging_unsupported`. A row
// seen before (same objectId) is never listed twice, and a page that brings no
// row not already listed ends the listing too (the store sent rows it had sent
// before; asking again would get them again), so every page that keeps the
// listing going adds a row and the cap always ends it.
//
// THE TAB'S WORDS. Counts are of what is loaded unless the store gave a total
// (listCountText, directoryHeading); a column sort says when it covers only
// the loaded rows (sortNote); the layout keeps the grid its room (documentsLayout).
// =============================================================================

import { ExplorerToolError } from 'shared/explorer';
import type { FilterApplied, IDocumentItem, IDocumentsFilter, IExportRows, INeighborItem } from '../contract/types';
import { EXPORT_COLUMNS } from '../contract/types';
import { DIRECTORY_AUTO_ROWS, DIRECTORY_LOAD_MORE } from './budgets';
import { HEALTH_NOT_REPORTED, documentHealth, needsAttention } from './health';
import type { IDocumentsPageView } from './results';
import { fileTypeOf, formatSize } from './fileType';
import { formatCount } from './stats';
import { CAVEAT_SENTENCES, DOCUMENTS_REPEATED_TEXT, failureText } from './wording';
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

/** Where a document sorts: in a folder, under a bare name, or without its first chunk. */
type PlaceKind = 'folder' | 'uploaded' | 'attention';

/** Rank of each place: folders, then bare names, then documents without a first chunk. */
const KIND_RANK: Readonly<Record<PlaceKind, number>> = { folder: 0, uploaded: 1, attention: 2 };

/** Where one document sorts (by its first chunk). */
function placeOf(item: IDocumentItem): { kind: PlaceKind; folder: string; name: string } {
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
 * The listing's order: folders (by label), bare names, documents without a first chunk; inside each by name, path, objectId.
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
 * Sort documents in the listing's order (a copy).
 *
 * @param items - The documents.
 * @returns The sorted copy.
 */
export function sortDocuments(items: readonly IDocumentItem[]): IDocumentItem[] {
	return [...items].sort(compareDocuments);
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

/** Where the documents listing is. */
export type PagerStatus = 'idle' | 'loading' | 'paused' | 'done' | 'capped' | 'unsupported' | 'stalled' | 'error';

/** The documents listing's state (replaced, never mutated). */
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
	/** False when the store lists in storage order (the rows are sorted here). */
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
	/**
	 * The rows of the listing this one started over from (a refresh, a retry), with the same filter: kept until the
	 * first page lands, so a first page that fails shows them again instead of nothing.
	 */
	held?: IDocumentItem[];
	/** The rows are the last known ones (held): reading them again failed before its first page. */
	stale?: boolean;
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
	// The same listing again keeps what it showed (or what it still held); another filter is another listing.
	const held = filter === state.filter ? (state.rows.length > 0 ? state.rows : (state.held ?? [])) : [];
	return { ...pagerInit(state.cap), status: 'loading', filter, ...(held.length > 0 ? { held } : {}) };
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
	// The first page replaces what the listing held from before.
	const { held: _held, stale: _stale, ...rest } = state;
	const base = { ...rest, cursor: page.nextCursor, total: page.total ?? state.total, storeSorted: page.sorted, caveats: page.caveats, error: null, pages: state.pages + 1, filterApplied, filterIgnored };
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
	// Started over and failed before its first page: the last known rows show again, marked as such.
	if (state.pages === 0 && state.held !== undefined && state.held.length > 0) return { ...state, rows: sortDocuments(state.held), status: 'error', error, stale: true };
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

/**
 * Whether the listing holds every document: the one test the sort line, the counts, the heading and the rail share,
 * so none of them claims a total, or more documents, that another does not.
 *
 * @param state - The listing.
 * @returns True once the store said it has no more.
 */
export function listingComplete(state: Pick<IPagerState, 'status'>): boolean {
	return state.status === 'done';
}

/** What every line says of a listing that is not complete. */
export const MORE_MAY_EXIST = 'more may exist';

/** The listing's footer. */
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
 * The footer under the list, or null when there is nothing to say.
 *
 * @param state - The state.
 * @returns The footer.
 */
export function pagerFooter(state: IPagerState): IPagerFooter | null {
	const loaded = formatCount(state.rows.length);
	switch (state.status) {
		case 'capped':
			return { text: `Limit reached at ${loaded} documents; ${MORE_MAY_EXIST}`, loadMore: true, caveat: null, retry: false };
		case 'unsupported':
			return { text: `Limit reached at ${loaded} documents; ${MORE_MAY_EXIST}`, loadMore: false, caveat: CAVEAT_SENTENCES.documents_paging_unsupported, retry: false };
		case 'stalled':
			return { text: `Loading stopped at ${loaded} documents; ${MORE_MAY_EXIST}`, loadMore: false, caveat: DOCUMENTS_REPEATED_TEXT, retry: false };
		case 'error':
			if (state.stale) return { text: `Showing the last known ${loaded} documents; reading them again failed: ${state.error?.headline ?? 'the store did not answer.'}`, loadMore: false, caveat: null, retry: true };
			return { text: `Loading stopped at ${loaded} documents: ${state.error?.headline ?? 'the store did not answer.'}`, loadMore: false, caveat: null, retry: true };
		case 'paused':
			return { text: `Loading paused at ${loaded} documents`, loadMore: false, caveat: null, retry: false };
		default:
			return null;
	}
}

/**
 * The count beside the DOCUMENTS heading: the store's total when it said (and counted what the list shows), else
 * what is loaded.
 *
 * @param state - The state.
 * @returns e.g. '42 documents' or '1,200 loaded'.
 */
export function directoryHeading(state: IPagerState): string {
	// A store that did not apply the listing's filter (or only part of it) counted every document: its total is not
	// what the list shows, which is matched here.
	const totalShown = state.filter === null || state.filterApplied === 'server';
	if (state.total !== null && totalShown) return `${formatCount(state.total)} ${state.total === 1 ? 'document' : 'documents'}`;
	const n = state.rows.length;
	if (state.stale) return `${formatCount(n)} last known`;
	if (listingComplete(state)) return `${formatCount(n)} ${n === 1 ? 'document' : 'documents'}`;
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
 * Listed documents as an export (the documents columns): words and numbers the
 * list shows, never anything else the store sent.
 *
 * @param items - The documents, in the listing's order.
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

// =============================================================================
// THE DOCUMENTS TAB: its grid's words, its layout and Find similar
// =============================================================================

/**
 * The line beside a sorted grid when the sort covers only what is loaded (more may exist): shown while the listing is
 * incomplete and the rows are sorted here, by a column or (a store that lists in storage order) once loading stopped.
 * A complete listing is sorted whole, and rows still arriving are not sorted at all, so neither shows it.
 *
 * @param state - The listing.
 * @param columnSorted - True while a column's header sorts the grid.
 * @returns The line, or null.
 */
export function sortNote(state: Pick<IPagerState, 'status' | 'storeSorted' | 'rows'>, columnSorted: boolean): string | null {
	if (listingComplete(state) || state.status === 'idle' || state.rows.length === 0) return null;
	// Without a column sort the rows are in the store's order, or sorted here once loading stopped (while pages are
	// still appended, nothing is sorted yet).
	if (!columnSorted && (state.storeSorted || state.status === 'loading')) return null;
	const n = state.rows.length;
	return `Sorted within the ${formatCount(n)} loaded ${n === 1 ? 'document' : 'documents'}; ${MORE_MAY_EXIST}.`;
}

/**
 * How many documents the list shows, out of what is loaded (never a total the store did not give).
 *
 * @param shown - Rows the grid lists (after the path box, the folder and the review).
 * @param state - The listing.
 * @returns e.g. '42 documents', '12 of 42 documents', '1,200 loaded', '12 of 1,200 loaded'.
 */
export function listCountText(shown: number, state: Pick<IPagerState, 'status' | 'rows'>): string {
	const loaded = state.rows.length;
	if (listingComplete(state)) return shown === loaded ? `${formatCount(loaded)} ${loaded === 1 ? 'document' : 'documents'}` : `${formatCount(shown)} of ${formatCount(loaded)} documents`;
	return shown === loaded ? `${formatCount(loaded)} loaded` : `${formatCount(shown)} of ${formatCount(loaded)} loaded`;
}

/** A document's Health cell: the flags' words, '—' where the store does not report what they need, else empty. */
export interface IHealthCell {
	text: string;
	/** The flags' sentences, or why nothing is said. */
	title: string;
	/** A defect (not oversize alone). */
	attention: boolean;
}

/**
 * The Health column of one document (its flags' words; a defect needs attention).
 *
 * @param item - The document.
 * @param median - The median chunks per loaded document once the listing settled, else null (oversize not checked).
 * @returns The cell.
 */
export function healthCell(item: IDocumentItem, median: number | null): IHealthCell {
	const health = documentHealth(item, { medianChunks: median });
	if (health.flags.length > 0) return { text: health.flags.map((f) => f.label).join(', '), title: health.flags.map((f) => f.detail).join(' '), attention: needsAttention(health) };
	if (health.unchecked.includes('gaps') || health.unchecked.includes('deleted_chunks')) return { text: '—', title: HEALTH_NOT_REPORTED, attention: false };
	return { text: '', title: 'No problem found in what this store reports.', attention: false };
}

/** A staged document the review lists but the listing has not loaded. */
const HEALTH_NOT_LOADED: IHealthCell = Object.freeze({ text: '—', title: 'Not among the loaded rows: its health is not known here.', attention: false });

/**
 * The grid's Health cells, each worked out once per row. They are kept by the row itself, never by its objectId: a
 * relist (Refresh, a write, the first listing after one held over) brings new rows, so their cells are worked out
 * again even when the median is unchanged.
 *
 * @param median - The loaded documents' median chunks (null while unknown).
 * @param unloaded - The staged documents the review lists without a loaded row.
 * @returns A row's Health cell.
 */
export function healthLookup(median: number | null, unloaded: ReadonlySet<string>): (item: IDocumentItem) => IHealthCell {
	const cache = new WeakMap<IDocumentItem, IHealthCell>();
	return (item) => {
		let cell = cache.get(item);
		if (!cell) {
			cell = unloaded.has(item.objectId) ? HEALTH_NOT_LOADED : healthCell(item, median);
			cache.set(item, cell);
		}
		return cell;
	};
}

/**
 * The Documents tab's widths (px): the rail (with the gap after it), the drawer (with the gap before it), the grid's
 * least, and the chrome around the grid (the panel's borders and the body's padding).
 */
export const DOCUMENTS_LAYOUT = Object.freeze({ rail: 220, railGap: 12, drawer: 360, drawerMin: 300, drawerGap: 8, gridMin: 600, chrome: 18 });

/** Where the Documents tab's parts go. */
export interface IDocumentsLayout {
	/** The folder rail is shown. */
	rail: boolean;
	/** The rail is hidden only to leave the grid its room (a "Folders" button brings it back). */
	railHidden: boolean;
	/** The drawer's width beside the grid (px), or 0 when it is closed or stacked under the grid. */
	drawer: number;
	/** The drawer goes under the grid (too narrow for both side by side). */
	stacked: boolean;
}

/**
 * The Documents tab's layout: the grid keeps at least `gridMin` px. With the drawer open the rail goes first, then the
 * drawer narrows to its minimum, then it moves under the grid.
 *
 * @param width - The tab's width (px).
 * @param opts - `drawer`: the drawer is open; `forceRail`: the rail was asked back.
 * @returns The layout.
 */
export function documentsLayout(width: number, opts: { drawer: boolean; forceRail: boolean }): IDocumentsLayout {
	const { rail: railWidth, railGap, drawer: drawerWidth, drawerMin, drawerGap, gridMin, chrome } = DOCUMENTS_LAYOUT;
	const rail = railWidth + railGap;
	// What the grid needs with the chrome around it, and the room a drawer takes with its gap.
	const grid = gridMin + chrome;
	const drawer = drawerWidth + drawerGap;
	const narrowest = drawerMin + drawerGap;
	if (!opts.drawer) {
		const fits = width >= rail + grid;
		return { rail: fits || opts.forceRail, railHidden: !fits && !opts.forceRail, drawer: 0, stacked: false };
	}
	if (width >= rail + drawer + grid) return { rail: true, railHidden: false, drawer: drawerWidth, stacked: false };
	if (opts.forceRail) return width >= rail + narrowest + grid ? { rail: true, railHidden: false, drawer: width - rail - grid - drawerGap, stacked: false } : { rail: true, railHidden: false, drawer: 0, stacked: true };
	if (width >= drawer + grid) return { rail: false, railHidden: true, drawer: drawerWidth, stacked: false };
	if (width >= narrowest + grid) return { rail: false, railHidden: true, drawer: width - grid - drawerGap, stacked: false };
	return { rail: false, railHidden: true, drawer: 0, stacked: true };
}

/** The neighbours the drawer asks for, beyond the document's own chunks. */
export const SIMILAR_K = 12;

/**
 * How many neighbours Find similar asks for: enough that the document's own chunks (left out of the answer) do not
 * crowd out the others, within the node's limit.
 *
 * @param max - `limits.neighbors_k_max`.
 * @param chunks - The document's chunk count, or null when the store did not count them.
 * @param loaded - Chunks of it the drawer has read (the count to use when the store gave none).
 * @returns k.
 */
export function similarK(max: number, chunks: number | null, loaded: number): number {
	return Math.max(1, Math.min(max, SIMILAR_K + Math.max(0, chunks ?? loaded)));
}

/** One document near another one's chunk. */
export interface ISimilarDocument {
	objectId: string;
	path: string;
	/** The highest similarity of its chunks among the neighbours. */
	best: number;
	/** How many of its chunks are among the neighbours. */
	chunks: number;
}

/**
 * The documents among a chunk's neighbours, the document itself left out, the nearest first.
 *
 * @param items - The `neighbors` answer's items.
 * @param objectId - The document whose chunk was asked about.
 * @returns The documents.
 */
export function similarDocuments(items: readonly INeighborItem[], objectId: string): ISimilarDocument[] {
	const byDoc = new Map<string, ISimilarDocument>();
	for (const item of items) {
		const id = item.key[0];
		if (id === objectId) continue;
		const known = byDoc.get(id);
		if (known) {
			known.best = Math.max(known.best, item.sim);
			known.chunks += 1;
		} else byDoc.set(id, { objectId: id, path: item.path, best: item.sim, chunks: 1 });
	}
	return [...byDoc.values()].sort((a, b) => b.best - a.best || compareText(a.path, b.path) || compareText(a.objectId, b.objectId));
}

/**
 * The rows of the staged documents (the review): the loaded row of each, else what staging kept (its path and chunk
 * count; the rest not known).
 *
 * @param staged - The staged documents, in the order staged.
 * @param loaded - The loaded rows by objectId.
 * @returns The rows, and the ids that have no loaded row.
 */
export function stagedRows(staged: Iterable<{ objectId: string; path: string; chunks: number | null }>, loaded: ReadonlyMap<string, IDocumentItem>): { rows: IDocumentItem[]; unloaded: ReadonlySet<string> } {
	const rows: IDocumentItem[] = [];
	const unloaded = new Set<string>();
	for (const target of staged) {
		const row = loaded.get(target.objectId);
		if (row) {
			rows.push(row);
			continue;
		}
		unloaded.add(target.objectId);
		rows.push({ objectId: target.objectId, path: target.path, chunks: target.chunks, has_first_chunk: true, tables: null, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null });
	}
	return { rows, unloaded };
}

/** How much of a chunk the drawer shows (the document tab shows it all). */
export const CHUNK_PREVIEW_CHARS = 180;

/**
 * The first characters of a chunk, on one line.
 *
 * @param text - The chunk.
 * @returns At most CHUNK_PREVIEW_CHARS characters, with an ellipsis when cut.
 */
export function chunkPreview(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= CHUNK_PREVIEW_CHARS ? flat : `${flat.slice(0, CHUNK_PREVIEW_CHARS).replace(/\s+\S*$/, '')}…`;
}

/**
 * The Documents list when the store holds no document yet.
 *
 * @param canAdd - Adding documents works in this mount (the header's Add documents).
 * @returns The sentence.
 */
export function noDocumentsText(canAdd: boolean): string {
	return canAdd ? 'No documents yet. Use Add documents, in the header, to add the first one.' : 'No documents yet.';
}

/**
 * A document as the write confirmations need it.
 *
 * @param item - The document.
 * @returns The target: its path and the chunk count the store reported.
 */
export function targetOf(item: Pick<IDocumentItem, 'objectId' | 'path' | 'chunks'>): { objectId: string; path: string; chunks: number | null } {
	return { objectId: item.objectId, path: item.path, chunks: item.chunks };
}

/** Find similar replaced by a newer neighbours request of the same connection before the store answered it. */
export const SIMILAR_REPLACED_TEXT = 'A newer neighbours request replaced this one; try again.';

/** Find similar while the store answers another neighbours or recommend call (it runs one at a time). */
export const SIMILAR_BUSY_TEXT = 'The store is answering another neighbours or recommend request; try again in a moment.';

/**
 * Why Find similar has no answer.
 *
 * @param error - What the call threw.
 * @returns The sentence (a request replaced by a newer one says so), or null.
 */
export function similarFailureText(error: unknown): string | null {
	if (error instanceof ExplorerToolError && error.code === 'BUSY') return SIMILAR_BUSY_TEXT;
	if (error instanceof ExplorerToolError && error.kind === 'stale') return SIMILAR_REPLACED_TEXT;
	const text = failureText(error);
	return text === null ? null : text.headline;
}

/**
 * A row's tooltip in the Documents grid: path, type, size, ingest time, its health and its objectId.
 *
 * @param item - The document.
 * @param health - Its Health cell.
 * @returns The tooltip.
 */
export function documentTooltip(item: IDocumentItem, health: Pick<IHealthCell, 'text' | 'attention'>): string {
	const parts = [item.path || '(no path)', fileTypeOf(item.path)];
	if (item.size !== null) parts.push(formatSize(item.size));
	if (item.ingestedAt !== null) parts.push(`ingested ${item.ingestedAt.replace('T', ' ').replace('Z', ' UTC')}`);
	if (health.text !== '' && health.text !== '—') parts.push(health.attention ? `needs attention: ${health.text}` : health.text);
	parts.push(`objectId ${item.objectId}`);
	return parts.join(' · ');
}

/**
 * What a Trash row says of a document that also has chunks outside the trash (a partly trashed one), when the
 * loaded live listing holds it; nothing otherwise (the live listing may not have loaded it).
 *
 * @param live - The live listing's row of the same objectId, or undefined.
 * @returns e.g. '4 chunks outside the trash', 'chunks outside the trash' (no count), or null.
 */
export function outsideTrashText(live: Pick<IDocumentItem, 'chunks'> | undefined): string | null {
	if (live === undefined) return null;
	if (live.chunks === null) return 'chunks outside the trash';
	return `${formatCount(live.chunks)} ${live.chunks === 1 ? 'chunk' : 'chunks'} outside the trash`;
}
