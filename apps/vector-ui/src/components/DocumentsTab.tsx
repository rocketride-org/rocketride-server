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
// VECTOR-UI - THE DOCUMENTS TAB (the workbench's listing of a connection)
// =============================================================================
//
// Every document the console has loaded (the controller pages the store in
// the background, vector/documents.ts), in a sortable grid
// (components/VectorGrid.tsx) beside the folder rail
// (components/FolderRail.tsx), with a document's drawer docked on the right
// (components/DocumentDrawer.tsx).
//
// THE FILTERS. The ScopeBar is the one filter: without a condition its path
// box filters what is loaded (150 ms after the last keystroke); its
// conditions make the connection's scope, which the listing asks the store
// for together with the path box (vector/filters.ts directoryView). A folder
// chosen in the rail narrows the list to what is loaded under it, without
// asking the store again or changing the scope; "Scope search, map and Ask
// to this folder" is the separate, explicit action that sets the scope.
//
// SORTING. A column's header sorts the loaded rows. While the listing is not
// complete and the rows are not in the store's own path order, a line says
// the sort covers only what is loaded (vector/documents.ts sortNote).
//
// STAGING. A row's tick (or Space on it) stages the document to move to the
// trash, and the Status column says "to Trash"; nothing is sent: the
// workbench's pending bar applies the staged documents through one
// confirmation. "Stage all shown" and "Unstage all shown" act on the rows
// listed. The pending bar's Review lists only the staged documents, loaded
// or not. Staging is unavailable, with the reason shown, while writing is
// off. The Trash is its own tab.
//
// THE FOCUS. Escape in the drawer closes it and the focus goes back to its
// row. While a move to the trash is being confirmed, the grid marks the row
// after the documents it moves (`data-return-focus`), where the workbench
// puts the focus after Confirm. A row that leaves the list hands the focus to
// the next row (the grid). Another tab can ask for a document's drawer
// (`entry.openDocument`) or a folder (adapters/consoleActions.ts
// documentsFolder).
//
// The grid reads the controller's rows and never writes to them; the
// export reads the same rows (vector/filters.ts directoryExportItems).
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { documentsFolder, stagedReview } from '../adapters/consoleActions';
import type { Availability, IDocumentItem } from '../contract/types';
import { CONSOLE_ORIGIN } from '../vector/confirm';
import { writesDuringRemoval } from '../vector/consoleModel';
import { directoryHeading, documentTooltip, documentsLayout, healthCell, listCountText, listingComplete, noDocumentsText, pagerFooter, pagerProgressText, sortNote, splitPath, stagedRows, targetOf } from '../vector/documents';
import type { IHealthCell } from '../vector/documents';
import { fileTypeOf, formatSize } from '../vector/fileType';
import { FILTER_DEBOUNCE_MS, checkScope, directoryExportItems, directoryView, folderScope, folderScopeLabel, folderScopeTargets, sameFilter, scopeNoMatchText, shownExportItem, withText } from '../vector/filters';
import { afterDrawerClosed, afterNeighbourChosen, afterToolGone } from '../vector/grid';
import type { IFocusChain, IGridSort } from '../vector/grid';
import { medianChunks } from '../vector/health';
import { stage, statusSortVersion, unstage } from '../vector/staged';
import type { IStagedSet, IStatusSortState } from '../vector/staged';
import { formatCount } from '../vector/stats';
import { buildTree, flatFolders, folderRows } from '../vector/tree';
import type { FolderView } from '../vector/tree';
import { EMPTY } from '../vector/wording';
import { styles as appStyles } from '../styles';
import DocumentDrawer from './DocumentDrawer';
import ExportMenu from './ExportMenu';
import FolderRail from './FolderRail';
import GatedButton from './GatedButton';
import ScopeBar from './ScopeBar';
import VectorGrid from './VectorGrid';
import type { IGridColumn, IVectorGridHandle } from './VectorGrid';
import { currentTabOf, focusFell } from './focusTargets';
import type { IDocumentsTabProps } from './workbenchProps';

const styles = {
	tab: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', gap: 12 } as CSSProperties,
	rail: (width: number): CSSProperties => ({ flex: `0 0 ${width}px`, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 8 }),
	main: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 8 } as CSSProperties,
	header: { ...appStyles.panelTitle, flexWrap: 'wrap' } as CSSProperties,
	headerCount: { ...appStyles.small, fontWeight: 400, textTransform: 'none', letterSpacing: 0 } as CSSProperties,
	headerEnd: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0, fontWeight: 400 } as CSSProperties,
	line: { ...appStyles.small, padding: '0 12px 6px' } as CSSProperties,
	lineRow: { ...appStyles.small, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '0 12px 6px' } as CSSProperties,
	toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '0 12px 8px' } as CSSProperties,
	body: (stacked: boolean): CSSProperties => ({ flex: 1, minHeight: 0, display: 'flex', flexDirection: stacked ? 'column' : 'row', gap: 8, padding: '0 8px 8px' }),
	gridBox: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--rr-border)' } as CSSProperties,
	drawerBox: (width: number, stacked: boolean): CSSProperties => (stacked ? { flex: '0 0 320px', minHeight: 0 } : { flex: `0 0 ${width}px`, minWidth: 0, minHeight: 0 }),
	footer: { ...appStyles.small, padding: '6px 12px', borderTop: '1px solid var(--rr-border)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as CSSProperties,
	caveat: { flexBasis: '100%' } as CSSProperties,
	check: { margin: 0 } as CSSProperties,
};

/**
 * The value, once it has not changed for `ms`.
 *
 * @param value - The value.
 * @param ms - How long it must hold.
 * @returns The settled value.
 */
export function useDebounced<T>(value: T, ms: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		if (Object.is(settled, value)) return undefined;
		const id = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(id);
	}, [value, settled, ms]);
	return settled;
}

/** A row's id. */
const rowId = (item: IDocumentItem): string => item.objectId;

/** What the Documents grid's cells read (kept in a ref, so the columns, and the rows' order, stay put while it changes). */
interface IGridContext {
	staged: IStagedSet;
	writes: Availability;
	health(item: IDocumentItem): IHealthCell;
	duplicate(item: IDocumentItem): boolean;
	onToggle(item: IDocumentItem): void;
}

/** A document's name in the grid (with its short objectId when another loaded document has the same path). */
function nameOf(item: IDocumentItem, duplicate: boolean): string {
	const name = splitPath(item.path).name;
	return duplicate ? `${name} (${item.objectId.slice(0, 8)})` : name;
}

/**
 * The Documents grid's columns (declared here, never derived from rows). At their least they come to 908 px together,
 * what they took before every header was fitted to its words: Folder's minimum gives back what Chunks, Tables and
 * Status gained, so a narrow tab scrolls no further sideways.
 *
 * @param ctx - What the cells read.
 * @returns The columns.
 */
export function documentColumns(ctx: { current: IGridContext }): Array<IGridColumn<IDocumentItem>> {
	return [
		{
			id: 'stage',
			label: '',
			ariaLabel: 'Staged to move to the trash',
			width: 34,
			align: 'center',
			cell: (item, cell) => {
				const { staged, writes } = ctx.current;
				const name = nameOf(item, ctx.current.duplicate(item));
				// Unstaging is always possible; staging waits for the writes.
				const blocked = !writes.enabled && !staged.has(item.objectId);
				return <input type="checkbox" style={styles.check} checked={staged.has(item.objectId)} aria-label={`Stage ${name} to move to the trash`} aria-disabled={blocked ? true : undefined} title={blocked ? (writes.reason ?? undefined) : undefined} tabIndex={cell.tabIndex} onChange={() => ctx.current.onToggle(item)} />;
			},
		},
		{ id: 'name', label: 'Name', width: 'flex', minWidth: 160, sortValue: (item) => splitPath(item.path).name, cell: (item) => nameOf(item, ctx.current.duplicate(item)) },
		{ id: 'folder', label: 'Folder', width: 'flex', minWidth: 88, sortValue: (item) => splitPath(item.path).folder, cell: (item) => (splitPath(item.path).uploaded ? 'Uploaded' : splitPath(item.path).folder) },
		{ id: 'type', label: 'Type', width: 70, sortValue: (item) => fileTypeOf(item.path), cell: (item) => fileTypeOf(item.path) },
		{ id: 'chunks', label: 'Chunks', width: 70, align: 'right', sortValue: (item) => item.chunks, cell: (item) => (item.chunks === null ? <span title="The store does not count chunks per document">—</span> : formatCount(item.chunks)) },
		{ id: 'tables', label: 'Tables', width: 64, align: 'right', sortValue: (item) => item.tables, cell: (item) => (item.tables === null ? '—' : formatCount(item.tables)) },
		{ id: 'size', label: 'Size', width: 76, align: 'right', sortValue: (item) => item.size, cell: (item) => formatSize(item.size) },
		{ id: 'ingested', label: 'Ingested', width: 104, sortValue: (item) => item.ingestedAt, cell: (item) => (item.ingestedAt === null ? '—' : <span title={item.ingestedAt.replace('T', ' ').replace('Z', ' UTC')}>{item.ingestedAt.slice(0, 10)}</span>) },
		{
			id: 'health',
			label: 'Health',
			width: 130,
			sortValue: (item) => ctx.current.health(item).text || null,
			cell: (item) => {
				const health = ctx.current.health(item);
				return <span title={health.title}>{health.text}</span>;
			},
		},
		{ id: 'status', label: 'Status', width: 80, sortValue: (item) => (ctx.current.staged.has(item.objectId) ? 'to Trash' : null), cell: (item) => (ctx.current.staged.has(item.objectId) ? 'to Trash' : '') },
	];
}

/** No id. */
const NONE: ReadonlySet<string> = new Set();

/**
 * The Documents tab.
 *
 * @param props - {@link IDocumentsTabProps}.
 * @returns The tab's panel.
 */
export function DocumentsTab({ entry, model, channels, actions, console: state, selection, visible, scope, onScope, cap, available, saved, onSave, onDeleteSaved }: IDocumentsTabProps): React.ReactElement {
	// Load more and Retry page the listing the controller's view names: the documents while this tab shows.
	useEffect(() => {
		if (visible) entry.controller.setView('active');
	}, [visible, entry]);
	// A listing that starts over with the same conditions (Refresh, a write) keeps showing the rows it had until its
	// first page arrives, so the list neither flashes empty nor loses the focused row.
	const held = useRef(state.directory);
	const restarting = state.directory.status === 'loading' && state.directory.pages === 0 && held.current.rows.length > 0 && sameFilter(state.directory.filter, held.current.filter);
	if (!restarting) held.current = state.directory;
	const pager = restarting ? held.current : state.directory;
	const staged = useSyncExternalStore(entry.staged.subscribe, entry.staged.get, entry.staged.get);
	const reviewStore = stagedReview(entry);
	const review = useSyncExternalStore(reviewStore.subscribe, reviewStore.get, reviewStore.get);
	useEffect(() => {
		if (review && staged.size === 0) reviewStore.set(false);
	}, [review, staged, reviewStore]);
	const writes = writesDuringRemoval(model.writes, state.removal.status);

	// The path box joins the scope (as path_contains) once its text settles; a scope set elsewhere takes the box's text too.
	const [text, setText] = useState('');
	const applied = useDebounced(text, FILTER_DEBOUNCE_MS);
	useEffect(() => {
		if (scope === null) return;
		const next = withText(scope, applied);
		if (next !== scope) onScope(next);
	}, [applied, scope, onScope]);
	const view = useMemo(() => directoryView(pager, scope, applied, cap), [pager, scope, applied, cap]);

	// The folder rail: a view of what is loaded (C2), kept per connection so another tab can ask for one; the scope is
	// the explicit action.
	const folderStore = documentsFolder(entry);
	const folder = useSyncExternalStore(folderStore.subscribe, folderStore.get, folderStore.get);
	const setFolder = (next: FolderView | null): void => folderStore.set(next);
	const [folderError, setFolderError] = useState<string | null>(null);
	useEffect(() => setFolderError(null), [scope]);
	// The rail counts what the list can show: with the scope on the list, the loaded documents it keeps (a store that
	// filters nothing, or part of it, lists every document and the scope is matched here).
	const scopeOnList = scope !== null && scope.applyTo.documents;
	const treeRows = useMemo(() => (scopeOnList ? (view.scopeRows ?? []) : pager.rows), [scopeOnList, view.scopeRows, pager.rows]);
	const tree = useMemo(() => buildTree(treeRows), [treeRows]);
	const folders = useMemo(() => flatFolders(buildTree(pager.rows)).map((f) => f.prefix), [pager.rows]);
	const chooseFolder = (next: FolderView | null): void => {
		reviewStore.set(false);
		setFolder(next);
	};
	// The folder for the scope's surfaces (vector/filters.ts folderScope): a scope off the list (or a new one) leaves the
	// list on this folder view, with no new listing; a scope already on the list keeps it there, as the label says.
	const scopeToFolder = (prefix: string): void => {
		const next = folderScope(scope, applied, prefix);
		const refused = checkScope(next);
		setFolderError(refused);
		if (refused === null) onScope(next);
	};
	const folderTargets = folderScopeTargets(scope);

	// The rows: the listing as the ScopeBar filters it, then the folder; the review lists the staged documents instead.
	const median = useMemo(() => (pager.status === 'loading' || pager.status === 'idle' ? null : medianChunks(pager.rows)), [pager.status, pager.rows]);
	const loadedById = useMemo(() => new Map(pager.rows.map((row) => [row.objectId, row])), [pager.rows]);
	const reviewed = useMemo(() => (review ? stagedRows(staged.values(), loadedById) : null), [review, staged, loadedById]);
	const rows = useMemo(() => (reviewed ? reviewed.rows : folderRows(view.rows, folder)), [reviewed, view.rows, folder]);
	const unloaded = reviewed?.unloaded ?? NONE;
	const pathCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const row of pager.rows) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
		return counts;
	}, [pager.rows]);
	const healthOf = useMemo(() => {
		const cache = new Map<string, IHealthCell>();
		return (item: IDocumentItem): IHealthCell => {
			let cell = cache.get(item.objectId);
			if (!cell) {
				cell = unloaded.has(item.objectId) ? { text: '—', title: 'Not among the loaded rows: its health is not known here.', attention: false } : healthCell(item, median);
				cache.set(item.objectId, cell);
			}
			return cell;
		};
	}, [median, unloaded]);

	// Unstaging sends nothing, so it works whatever the writes; staging waits for them.
	// A row ticked in the grid (its set is remembered: a sort by Status does not move that row under the pointer).
	const ownTick = useRef<IStagedSet | null>(null);
	const toggle = (item: IDocumentItem): void => {
		const now = entry.staged.get();
		if (!now.has(item.objectId) && !writes.enabled) {
			if (writes.reason) actions.announce(writes.reason);
			return;
		}
		const next = now.has(item.objectId) ? unstage(now, [item.objectId]) : stage(now, [targetOf(item)]);
		ownTick.current = next;
		entry.staged.set(next);
	};
	// Status and Health sort again only when their values change elsewhere (vector/staged.ts statusSortVersion).
	const statusSort = useRef<IStatusSortState>({ version: 0, seen: staged });
	statusSort.current = statusSortVersion(statusSort.current, staged, ownTick.current);
	const ctx = useRef<IGridContext>({ staged, writes, health: healthOf, duplicate: () => false, onToggle: toggle });
	ctx.current = { staged, writes, health: healthOf, duplicate: (item) => (pathCounts.get(item.path) ?? 0) > 1, onToggle: toggle };
	const columns = useMemo(() => documentColumns(ctx), []);
	const [sort, setSort] = useState<IGridSort | null>(null);
	const grid = useRef<IVectorGridHandle>(null);
	// A control that goes away when it acts (Show all documents, the scope action, the review's way out, Load more,
	// Retry, a Folders toggle that is no longer needed): the focus goes to the grid's row in the tab order, else the
	// grid, when it fell to the page.
	const refocus = useRef(false);
	const focusChain = (): IFocusChain<HTMLElement> => {
		const handle = grid.current;
		const element = handle?.element() ?? null;
		return { stopRow: handle?.stopElement() ?? null, grid: element, tab: currentTabOf(element) };
	};
	const thenGrid = (act: () => void) => (): void => {
		refocus.current = true;
		act();
	};
	useEffect(() => {
		if (!refocus.current) return;
		refocus.current = false;
		if (focusFell()) afterToolGone(focusChain())?.focus();
	});

	// The drawer: the selected document, opened from a row (or Neighbours); it follows the shared selection.
	const selectedId = selection.document?.objectId ?? null;
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [focusNonce, setFocusNonce] = useState(0);
	const drawerId = drawerOpen ? selectedId : null;
	const openRow = useCallback(
		(item: IDocumentItem): void => {
			entry.selection.selectDocument({ objectId: item.objectId, path: item.path });
			setDrawerOpen(true);
			setFocusNonce((n) => n + 1);
		},
		[entry]
	);
	// Closed (Escape, Close, or its document left): the focus goes back to its row, else the grid, when it fell to the page.
	const lastDrawer = useRef<string | null>(null);
	useEffect(() => {
		const was = lastDrawer.current;
		lastDrawer.current = drawerId;
		if (was === null || drawerId !== null) return;
		if (focusFell()) afterDrawerClosed(grid.current?.rowElement(was) ?? null, focusChain())?.focus();
	}, [drawerId]);

	// A neighbour chosen in the drawer: once it is the selected document, its row when the grid lists it, else the
	// drawer's heading (the list it was chosen from goes with the old document).
	const neighbour = useRef<string | null>(null);
	useEffect(() => {
		const id = neighbour.current;
		if (id === null || selectedId !== id) return;
		neighbour.current = null;
		const heading = root.current?.querySelector<HTMLElement>('[data-document-drawer] h2') ?? null;
		afterNeighbourChosen(grid.current?.rowElement(id) ?? null, heading)?.focus();
	});

	// Another tab asks for a document (Overview's Insights, a query result): its drawer opens here, once.
	const asked = useSyncExternalStore(entry.openDocument.subscribe, entry.openDocument.get, entry.openDocument.get);
	const showPending = useRef<string | null>(null);
	useEffect(() => {
		if (asked === null) return;
		entry.openDocument.set(null);
		const row = entry.controller.getState().directory.rows.find((r) => r.objectId === asked.objectId) ?? null;
		// A folder or the review that would hide it gives way.
		const view = folderStore.get();
		if (view !== null && (row === null || folderRows([row], view).length === 0)) folderStore.set(null);
		if (reviewStore.get() && !entry.staged.get().has(asked.objectId)) reviewStore.set(false);
		// Its path where the listing or the selection knows it; else none (the drawer says it is not known).
		const known = entry.selection.getState().document;
		entry.selection.selectDocument({ objectId: asked.objectId, path: row?.path ?? (known?.objectId === asked.objectId ? known.path : '') });
		setDrawerOpen(true);
		setFocusNonce((n) => n + 1);
		showPending.current = asked.objectId;
	}, [asked, entry, folderStore, reviewStore]);
	useEffect(() => {
		const id = showPending.current;
		if (id === null) return;
		// Shown once listed; forgotten when the drawer moved on to another document.
		if (selectedId !== id || grid.current?.showRow(id)) showPending.current = null;
	});

	// The rows a move to the trash is about to take away (its confirmation open, or its write running): the grid marks
	// the row after them, where the focus goes when the confirmation closes.
	const pendingMove = state.confirm !== null && state.confirm.origin === CONSOLE_ORIGIN && state.confirm.action === 'trash' ? state.confirm.targets : null;
	const moving = useMemo(() => (pendingMove === null ? null : new Set(pendingMove.map((t) => t.objectId))), [pendingMove]);
	const lastMoving = useRef<ReadonlySet<string> | null>(null);
	if (moving !== null) lastMoving.current = moving;
	else if (state.removal.status !== 'running') lastMoving.current = null;
	const leaving = lastMoving.current;

	// The layout: the grid keeps its room; the rail goes first when the drawer opens on a narrow tab.
	const root = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(1200);
	const [forceRail, setForceRail] = useState(false);
	const forceRailRef = useRef(forceRail);
	forceRailRef.current = forceRail;
	// A rail asked back is dropped whenever a drawer closes, so the layout decides again (also a rail asked for on a
	// narrow tab before that drawer opened); one asked for with no drawer opening after it stays.
	const drawerShown = drawerId !== null;
	const drawerWasShown = useRef(drawerShown);
	useEffect(() => {
		if (drawerWasShown.current && !drawerShown && forceRailRef.current) {
			// The Folders toggle may go with it: a focus on it goes to the grid.
			refocus.current = true;
			setForceRail(false);
		}
		drawerWasShown.current = drawerShown;
	}, [drawerShown]);
	useEffect(() => {
		const el = root.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth > 0) setWidth(el.clientWidth);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const layout = documentsLayout(width, { drawer: drawerId !== null, forceRail });

	// What the list says.
	const scoped = scope !== null && scope.applyTo.documents && view.scope !== null ? view.scope : null;
	let empty: string | undefined;
	if (review) empty = 'Nothing is staged.';
	else if (pager.rows.length === 0 && pager.status === 'error') empty = EMPTY.unreachable(pager.error?.headline ?? 'the store did not answer.');
	else if (pager.rows.length === 0 && (pager.status === 'loading' || pager.status === 'idle')) empty = 'Loading documents…';
	else if (pager.rows.length === 0 && scoped === null) empty = noDocumentsText(model.ingest.enabled);
	else if (pager.rows.length === 0 || view.rows.length === 0) empty = scoped !== null ? scopeNoMatchText(scoped) : EMPTY.noMatch(applied.trim());
	else empty = 'No loaded document is under this folder.';
	const progress = pagerProgressText(pager);
	const footer = pagerFooter(pager);
	const note = review ? null : sortNote(pager, sort !== null);
	const shownStaged = rows.reduce((n, row) => n + (staged.has(row.objectId) ? 1 : 0), 0);
	const writesReason = writes.enabled ? null : writes.reason;
	// The reason shown as text is the store's (it stays); a write running elsewhere only makes the controls wait.
	const offReason = model.writes.enabled ? null : model.writes.reason;
	const folderLabel = folder === null ? null : folder.kind === 'uploaded' ? 'Uploaded (documents stored under a bare file name)' : folder.prefix;
	const counted = treeRows.length;
	const countsLine = listingComplete(pager) && !scopeOnList ? `${formatCount(counted)} ${counted === 1 ? 'document' : 'documents'}` : `Counts over ${formatCount(counted)} loaded ${counted === 1 ? 'document' : 'documents'}${scopeOnList ? ' in the scope' : ''}`;
	const drawerItem = drawerId === null ? null : (loadedById.get(drawerId) ?? null);
	// The export: the loaded documents and the scope's, and what the list shows when a folder or the review narrows it.
	const narrowedBy = review ? 'staged' : folder === null ? null : folder.kind === 'uploaded' ? 'Uploaded' : `folder ${folder.prefix}`;
	const exportItems = narrowedBy === null ? directoryExportItems(pager, view) : [...directoryExportItems(pager, view), shownExportItem(rows, narrowedBy)];

	return (
		<div ref={root} style={styles.tab} data-documents-tab="">
			{layout.rail && (
				<div style={styles.rail(220)}>
					<FolderRail tree={tree} countsLine={countsLine} view={folder} onView={chooseFolder} onOpenDocument={openRow} trashCount={state.stats.view?.deletedDocuments ?? null} onTrash={() => (actions.openTab ? actions.openTab('trash') : entry.tab.set('trash'))} onRefresh={() => entry.controller.refresh()} refreshDisabled={!entry.opened} />
				</div>
			)}
			<section aria-label="Documents" style={styles.main}>
				<div style={styles.header}>
					<span>Documents</span>
					<span style={styles.headerCount}>{pager.status === 'idle' ? '' : directoryHeading(pager)}</span>
					<span style={styles.headerEnd}>
						{(layout.railHidden || forceRail) && (
							<GatedButton pressed={forceRail} onClick={thenGrid(() => setForceRail(!forceRail))} title={forceRail ? 'Hide the folder rail again (it makes room for the drawer)' : 'Show the folder rail (the drawer narrows)'}>
								Folders
							</GatedButton>
						)}
						<ExportMenu items={exportItems} collection={model.collection} />
					</span>
				</div>
				<ScopeBar text={text} scopeText={applied} onText={setText} scope={scope} onScope={onScope} cap={cap} available={available} folders={folders} saved={saved} onSave={onSave} onDeleteSaved={onDeleteSaved} listing={state.directory} />
				{folderError !== null && (
					<div role="alert" style={styles.line}>
						{folderError}
					</div>
				)}
				{(view.summary || progress) && (
					<div role="status" style={styles.line}>
						{view.summary ?? progress}
					</div>
				)}
				{folderLabel !== null && !review && (
					<div style={styles.lineRow}>
						<span role="status">{`Folder ${folderLabel}: ${listCountText(rows.length, pager)}, of what is loaded.`}</span>
						<GatedButton onClick={thenGrid(() => setFolder(null))}>Show all documents</GatedButton>
						{folder?.kind === 'folder' && (
							<GatedButton onClick={thenGrid(() => scopeToFolder(folder.prefix))} title={folderTargets.documents ? 'The scope gets this folder; the list stays scoped and is listed again with it' : 'The scope gets this folder for these only; the list keeps showing what is loaded under it'}>
								{folderScopeLabel(folderTargets)}
							</GatedButton>
						)}
					</div>
				)}
				<div style={styles.toolbar} role="group" aria-label="Staging">
					{review ? (
						<>
							<span role="status" style={appStyles.small}>{`Showing the ${formatCount(rows.length)} staged ${rows.length === 1 ? 'document' : 'documents'}${unloaded.size > 0 ? ` (${formatCount(unloaded.size)} not among the loaded rows)` : ''}.`}</span>
							<GatedButton onClick={thenGrid(() => reviewStore.set(false))}>Show all documents</GatedButton>
						</>
					) : (
						<span style={appStyles.small}>{shownStaged === 0 ? 'Tick a document to stage it for the trash.' : `${formatCount(shownStaged)} of the ${formatCount(rows.length)} shown ${shownStaged === 1 ? 'is' : 'are'} staged.`}</span>
					)}
					<GatedButton unavailable={writesReason ?? (rows.length === 0 || shownStaged === rows.length ? 'Every document shown is staged.' : null)} onClick={() => entry.staged.set(stage(entry.staged.get(), rows.map(targetOf)))}>
						{`Stage all shown (${formatCount(rows.length)})`}
					</GatedButton>
					<GatedButton unavailable={shownStaged === 0 ? 'No document shown is staged.' : null} onClick={() => entry.staged.set(unstage(entry.staged.get(), rows.map((row) => row.objectId)))}>
						Unstage all shown
					</GatedButton>
					{offReason !== null && <span style={appStyles.small}>{`Staging is unavailable: ${offReason}`}</span>}
				</div>
				<div style={styles.body(layout.stacked)}>
					<div
						style={styles.gridBox}
						onKeyDown={(event) => {
							// Escape on a row closes the drawer (the focus stays on the row); an inner handler that acted wins.
							if (event.defaultPrevented || event.key !== 'Escape' || drawerId === null) return;
							event.preventDefault();
							setDrawerOpen(false);
						}}
					>
						<VectorGrid ref={grid} label="Stored documents" rows={rows} rowId={rowId} columns={columns} sort={sort} onSort={setSort} sortVersion={sort?.column === 'status' ? statusSort.current.version : sort?.column === 'health' ? healthOf : null} selectedId={selectedId} onActivate={openRow} onToggle={toggle} activateOnClick leaving={leaving} empty={empty} rowTitle={(item) => documentTooltip(item, healthOf(item))} />
					</div>
					{drawerId !== null && (
						<div style={styles.drawerBox(layout.drawer, layout.stacked)}>
							<DocumentDrawer
								objectId={drawerId}
								item={drawerItem}
								path={drawerItem?.path ?? selection.document?.path ?? ''}
								chunks={state.chunks}
								median={median}
								staged={staged.has(drawerId)}
								writes={writes}
								chat={model.chat}
								neighborsMax={model.limits.neighbors_k_max}
								neighbors={{ caller: channels.tools, nodeId: model.nodes.store }}
								focusNonce={focusNonce}
								onClose={() => setDrawerOpen(false)}
								onStage={() => entry.staged.set(stage(entry.staged.get(), [drawerItem ? targetOf(drawerItem) : { objectId: drawerId, path: selection.document?.path ?? '', chunks: null }]))}
								onUnstage={() => entry.staged.set(unstage(entry.staged.get(), [drawerId]))}
								onShowOnMap={(keys) => actions.showOnMap(keys, 'document')}
								onAskAbout={() => actions.askAbout([drawerId])}
								onOpenDocument={(chunkId) => actions.openDocument(drawerId, chunkId)}
								onMoreChunks={() => entry.controller.loadMoreChunks()}
								onShowDocument={(objectId, path) => {
									entry.selection.selectDocument({ objectId, path });
									neighbour.current = objectId;
								}}
								announce={(message) => actions.announce(message)}
							/>
						</div>
					)}
				</div>
				<div style={styles.footer}>
					<span>{review ? `${formatCount(rows.length)} staged` : listCountText(rows.length, pager)}</span>
					{restarting && <span role="status">Listing the documents again…</span>}
					{footer && <span>{footer.text}</span>}
					{footer?.loadMore && <GatedButton onClick={thenGrid(() => entry.controller.loadMoreDocuments())}>Load more</GatedButton>}
					{footer?.retry && <GatedButton onClick={thenGrid(() => entry.controller.retryDocuments())}>Retry</GatedButton>}
					{note !== null && <span style={styles.caveat}>{note}</span>}
					{footer?.caveat && <span style={styles.caveat}>{footer.caveat}</span>}
				</div>
			</section>
		</div>
	);
}

export default DocumentsTab;
