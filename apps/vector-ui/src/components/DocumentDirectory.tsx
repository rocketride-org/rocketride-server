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
// VECTOR-UI — DOCUMENT DIRECTORY (R3: every document by its path, with its trash button)
// =============================================================================
//
// Renders the auto-pager's rows (vector/documents.ts) as folder groups in a
// hand-windowed list (fixed 28 px rows, only the visible window mounted), so
// 5,000 documents scroll smoothly without a windowing library. The filter row
// is the ScopeBar: without a condition its path box filters what is loaded,
// as it always did (150 ms after the last keystroke); its conditions make
// the console's scope, which the listing asks the store for together with
// the path box, and the status line words honestly (vector/filters.ts
// directoryView). Right-clicking a folder offers "Scope to
// this folder". Rows can be checked to move several to the trash at once.
//
// THE TRASH. With a host that has it, the title holds a Documents / Trash
// switch; "Trash (N)" is the store's count (stats.deleted_documents), never the
// loaded rows. The Trash view lists the console's trash listing: each row
// restores (at once) or deletes permanently (confirmed and typed by the
// console), checked rows do the same together, and Empty trash asks the
// console to empty the whole trash. Writes always go through the console.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'shell';
import type { Availability, IDocumentItem, IDocumentsFilter, IExportItem, IScopeState, ISavedFilter } from '../contract/types';
import type { IRemoveTarget } from '../vector/confirm';
import type { DirectoryView } from '../vector/consoleStore';
import { buildGroups, directoryHeading, pagerFooter, pagerProgressText } from '../vector/documents';
import type { IDirectoryGroup, IDirectoryRow, IPagerState } from '../vector/documents';
import { FILTER_DEBOUNCE_MS, checkScope, directoryExportItems, directoryView, scopeNoMatchText, scopeWith, withText } from '../vector/filters';
import { medianChunks } from '../vector/health';
import type { ConditionKind } from '../vector/filters';
import { DEFAULT_LIMITS } from '../vector/results';
import { formatCount } from '../vector/stats';
import { EMPTY } from '../vector/wording';
import { ChevronIcon } from '../icons';
import { FOCUS_RING, styles } from '../styles';
import DocumentRow from './DocumentRow';
import ExportMenu from './ExportMenu';
import ScopeBar from './ScopeBar';

/** The height of every row of the list (the windowing depends on it). */
export const ROW_HEIGHT = 28;

/** Rows rendered above and below the visible window. */
const OVERSCAN = 12;

/** Props for the {@link DocumentDirectory} component. */
export interface IDocumentDirectoryProps {
	pager: IPagerState;
	selectedId: string | null;
	writes: Availability;
	onSelect(item: IDocumentItem): void;
	/** Move to trash (the console confirms; nothing to type). */
	onRemove(targets: IRemoveTarget[]): void;
	onLoadMore(): void;
	onRetry(): void;
	/** The collection, for export file names. */
	collection?: string | null;
	/** The console's scope (ConsoleModel.scope), or null with no condition. */
	scope?: IScopeState | null;
	/** The ScopeBar changed the scope (null: no condition left). */
	onScope?(scope: IScopeState | null): void;
	/** `limits.scope_keys_max`. */
	cap?: number;
	/** Whether each kind of condition can be offered on this store. */
	available?: Partial<Record<ConditionKind, Availability>>;
	/** This connection's saved filters, and saving and deleting them. */
	saved?: readonly ISavedFilter[];
	onSave?(name: string, filter: IDocumentsFilter): string | null;
	onDeleteSaved?(id: string): void;
	/** Which listing `pager` is; with `onView` the title switches between them. */
	view?: DirectoryView;
	onView?(view: DirectoryView): void;
	/** Documents in the trash as the store counts them (stats.deleted_documents), or null where it cannot count. */
	trashCount?: number | null;
	/** The Trash view's writes: restore at once, delete permanently (confirmed), empty the whole trash (confirmed). */
	onRestore?(targets: IRemoveTarget[]): void;
	onDelete?(targets: IRemoveTarget[]): void;
	onEmptyTrash?(): void;
}

/** The value, once it has not changed for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		if (Object.is(settled, value)) return undefined;
		const id = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(id);
	}, [value, settled, ms]);
	return settled;
}

/** The "Scope to this folder" menu of one folder group, at the pointer. */
interface IFolderMenu {
	folder: string;
	x: number;
	y: number;
}

/** One line of the flattened list. */
type Line = { kind: 'group'; group: IDirectoryGroup; collapsed: boolean } | { kind: 'row'; row: IDirectoryRow };

/**
 * A document as the remove dialogs need it.
 *
 * @param item - The document.
 * @returns The target.
 */
export function targetOf(item: IDocumentItem): IRemoveTarget {
	return { objectId: item.objectId, path: item.path, chunks: item.chunks };
}

/**
 * The directory.
 *
 * @param props - {@link IDocumentDirectoryProps}.
 * @returns The panel element.
 */
export function DocumentDirectory({ pager, selectedId, writes, onSelect, onRemove, onLoadMore, onRetry, collection = null, scope: activeScope = null, onScope: onActiveScope, cap = DEFAULT_LIMITS.scope_keys_max, available, saved, onSave, onDeleteSaved, view: shownView = 'active', onView, trashCount = null, onRestore, onDelete, onEmptyTrash }: IDocumentDirectoryProps): React.ReactElement {
	// The scope belongs to the stored documents: the trash is listed whole, its path box filtering what is loaded.
	const inTrash = shownView === 'trash';
	const scope = inTrash ? null : activeScope;
	const onScope = inTrash ? undefined : onActiveScope;
	const [filter, setFilter] = useState('');
	const applied = useDebounced(filter, FILTER_DEBOUNCE_MS);
	const [folderMenu, setFolderMenu] = useState<IFolderMenu | null>(null);
	// Why "Scope to this folder" was not applied (the node would refuse the folder), until the scope changes.
	const [folderError, setFolderError] = useState<string | null>(null);
	useEffect(() => setFolderError(null), [scope]);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
	const [scrollTop, setScrollTop] = useState(0);
	const [height, setHeight] = useState(400);
	const viewport = useRef<HTMLDivElement>(null);

	// Measure the list's viewport (never allocate for a 0x0 box: keep the last size).
	useEffect(() => {
		const el = viewport.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => {
			if (el.clientHeight > 0) setHeight(el.clientHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// A checked document that is no longer listed (removed, or a new listing) is unchecked.
	useEffect(() => {
		if (checked.size === 0) return;
		const listed = new Set(pager.rows.map((r) => r.objectId));
		const kept = [...checked].filter((id) => listed.has(id));
		if (kept.length !== checked.size) setChecked(new Set(kept));
	}, [pager.rows, checked]);

	// The path box joins the scope (as path_contains) once its text settles, and any scope set elsewhere (a chart's
	// bar, a saved filter) takes the box's text too; withText returns the same scope when nothing changes, so this settles.
	useEffect(() => {
		if (scope === null || !onScope) return;
		const next = withText(scope, applied);
		if (next !== scope) onScope(next);
	}, [applied, scope, onScope]);

	const view = useMemo(() => directoryView(pager, scope, applied, cap), [pager, scope, applied, cap]);
	const matches = view.rows;
	// "Oversize" compares with the median of the loaded documents, once the listing settled (no row moves while pages arrive).
	const median = useMemo(() => (pager.status === 'loading' || pager.status === 'idle' ? null : medianChunks(pager.rows)), [pager.status, pager.rows]);
	const groups = useMemo(() => buildGroups(matches, { medianChunks: median, trash: inTrash }), [matches, median, inTrash]);
	const folders = useMemo(() => [...new Set(groups.filter((g) => g.kind === 'folder').map((g) => g.label))], [groups]);
	// "Documents in scope" holds the scope's own documents even while its Documents toggle is off (vector/filters.ts).
	const exportItems = useMemo<IExportItem[]>(() => directoryExportItems(pager, view), [pager, view]);
	const lines = useMemo<Line[]>(() => {
		const out: Line[] = [];
		for (const group of groups) {
			const isCollapsed = collapsed.has(group.key);
			out.push({ kind: 'group', group, collapsed: isCollapsed });
			if (!isCollapsed) for (const row of group.rows) out.push({ kind: 'row', row });
		}
		return out;
	}, [groups, collapsed]);

	const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
	const last = Math.min(lines.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
	const progress = pagerProgressText(pager);
	const footer = pagerFooter(pager);
	const summary = view.summary;
	const checkedItems = pager.rows.filter((r) => checked.has(r.objectId));

	const toggle = (key: string): void => {
		const next = new Set(collapsed);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setCollapsed(next);
	};
	const toggleCheck = (id: string): void => {
		const next = new Set(checked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setChecked(next);
	};

	// With the scope on the list, "no match" is of the loaded rows until every document is loaded.
	const scoped = scope !== null && scope.applyTo.documents && view.scope !== null ? view.scope : null;
	let empty: string | null = null;
	if (pager.rows.length === 0 && pager.status === 'done' && scoped === null) empty = inTrash ? EMPTY.trash : EMPTY.noDocuments;
	else if (pager.rows.length === 0 && pager.status === 'error') empty = EMPTY.unreachable(pager.error?.headline ?? 'the store did not answer.');
	else if (pager.rows.length > 0 && matches.length === 0) empty = scoped !== null ? scopeNoMatchText(scoped) : EMPTY.noMatch(applied.trim());
	else if (pager.rows.length === 0 && pager.status === 'done' && scoped !== null) empty = scopeNoMatchText(scoped);

	return (
		<section aria-label="Documents" style={{ ...styles.panel, flex: 1 }}>
			<div style={styles.panelTitle}>
				{onView ? (
					<span role="group" aria-label="Documents or trash" style={{ display: 'inline-flex', gap: 4 }}>
						{(['active', 'trash'] as const).map((which) => (
							<button key={which} type="button" aria-pressed={shownView === which} onClick={() => onView(which)} style={{ background: 'none', border: 'none', borderBottom: shownView === which ? '2px solid currentColor' : '2px solid transparent', padding: '0 2px', color: 'inherit', font: 'inherit', fontWeight: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', cursor: 'pointer' }} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
								{which === 'active' ? 'Documents' : trashCount === null ? 'Trash' : `Trash (${formatCount(trashCount)})`}
							</button>
						))}
					</span>
				) : (
					<span>Documents</span>
				)}
				<span style={{ ...styles.small, fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>{pager.status === 'idle' ? '' : directoryHeading(pager)}</span>
				<ExportMenu items={exportItems} collection={collection} />
			</div>
			<ScopeBar text={filter} scopeText={applied} onText={setFilter} scope={scope} onScope={onScope} cap={cap} available={available} folders={folders} saved={saved} onSave={onSave} onDeleteSaved={onDeleteSaved} listing={pager} />
			{folderError !== null && (
				<div role="alert" style={{ ...styles.small, padding: '0 12px 6px' }}>
					{folderError}
				</div>
			)}
			{(summary || progress) && (
				<div style={{ ...styles.small, padding: '0 12px 6px' }} role="status">
					{summary ?? progress}
				</div>
			)}
			{inTrash && onEmptyTrash && (
				<div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 12px 8px' }}>
					<Button small variant="danger" disabled={!writes.enabled || (pager.rows.length === 0 && (trashCount ?? 0) === 0)} title={writes.reason ?? undefined} onClick={onEmptyTrash}>
						Empty trash
					</Button>
				</div>
			)}
			{checkedItems.length > 0 && (
				<div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 12px 8px' }}>
					<span style={styles.small}>{`${checkedItems.length} selected`}</span>
					{inTrash ? (
						<>
							<Button small variant="secondary" disabled={!writes.enabled} title={writes.reason ?? undefined} onClick={() => onRestore?.(checkedItems.map(targetOf))}>
								Restore selected
							</Button>
							<Button small variant="danger" disabled={!writes.enabled} title={writes.reason ?? undefined} onClick={() => onDelete?.(checkedItems.map(targetOf))}>
								Delete selected permanently
							</Button>
						</>
					) : (
						<Button small variant="secondary" disabled={!writes.enabled} title={writes.reason ?? undefined} onClick={() => onRemove(checkedItems.map(targetOf))}>
							Move selected to the trash
						</Button>
					)}
					<Button small variant="ghost" onClick={() => setChecked(new Set())}>
						Clear
					</Button>
				</div>
			)}
			<div ref={viewport} style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative' }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
				{empty !== null ? (
					<div style={{ ...styles.small, padding: '16px 12px' }}>{empty}</div>
				) : pager.status === 'loading' && pager.rows.length === 0 ? (
					<div style={{ ...styles.small, padding: '16px 12px' }}>Loading documents…</div>
				) : (
					<div role="list" aria-label="Stored documents" style={{ height: lines.length * ROW_HEIGHT, position: 'relative' }}>
						{lines.slice(first, last).map((line, offset) => {
							const index = first + offset;
							const top = index * ROW_HEIGHT;
							if (line.kind === 'group') {
								return (
									<div key={line.group.key} role="listitem" aria-label={`Folder ${line.group.label}`} style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_HEIGHT }}>
										<button
											type="button"
											aria-expanded={!line.collapsed}
											onClick={() => toggle(line.group.key)}
											onContextMenu={(event) => {
												if (line.group.kind !== 'folder' || !onScope) return;
												event.preventDefault();
												const rect = event.currentTarget.getBoundingClientRect();
												const keyboard = event.clientX === 0 && event.clientY === 0;
												setFolderMenu({ folder: line.group.label, x: keyboard ? rect.left + 16 : event.clientX, y: keyboard ? rect.bottom : event.clientY });
											}}
											style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', height: ROW_HEIGHT, padding: '0 8px', background: 'none', border: 'none', color: 'inherit', font: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer', textAlign: 'left', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
											onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)}
											onBlur={(event) => (event.currentTarget.style.outline = 'none')}
										>
											<span style={{ width: 12, height: 12, flex: 'none', transform: line.collapsed ? 'none' : 'rotate(90deg)' }}>
												<ChevronIcon />
											</span>
											{line.group.label}
										</button>
									</div>
								);
							}
							const item = line.row.item;
							return (
								<div key={item.objectId} role="none" style={{ position: 'absolute', top, left: 0, right: 0 }}>
									<DocumentRow row={line.row} selected={item.objectId === selectedId} checked={checked.has(item.objectId)} writes={writes} onSelect={() => onSelect(item)} onToggleCheck={() => toggleCheck(item.objectId)} onRemove={() => onRemove([targetOf(item)])} mode={inTrash ? 'trash' : 'active'} onRestore={() => onRestore?.([targetOf(item)])} onDelete={() => onDelete?.([targetOf(item)])} />
								</div>
							);
						})}
					</div>
				)}
			</div>
			{folderMenu !== null && (
				<div
					role="menu"
					aria-label={`Folder ${folderMenu.folder}`}
					style={{ position: 'fixed', left: folderMenu.x, top: folderMenu.y, zIndex: 10, display: 'flex', flexDirection: 'column', padding: 4, background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border-input)', borderRadius: 6 }}
					onKeyDown={(event) => {
						if (event.key === 'Escape') setFolderMenu(null);
					}}
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFolderMenu(null);
					}}
				>
					<button
						type="button"
						role="menuitem"
						autoFocus
						style={{ ...styles.small, textAlign: 'left', padding: '4px 10px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
						onClick={() => {
							const next = scopeWith(scope, applied, { path_prefix: folderMenu.folder });
							const refused = checkScope(next);
							setFolderError(refused);
							if (refused === null) onScope?.(next);
							setFolderMenu(null);
						}}
						onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)}
					>
						Scope to this folder
					</button>
				</div>
			)}
			{footer && (
				<div style={{ ...styles.small, padding: '6px 12px', borderTop: '1px solid var(--rr-border)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
					<span>{footer.text}</span>
					{footer.loadMore && (
						<Button small variant="secondary" onClick={onLoadMore}>
							Load more
						</Button>
					)}
					{footer.retry && (
						<Button small variant="secondary" onClick={onRetry}>
							Retry
						</Button>
					)}
					{footer.caveat && <span style={{ flexBasis: '100%' }}>{footer.caveat}</span>}
				</div>
			)}
		</section>
	);
}

export default DocumentDirectory;
