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
// VECTOR-UI - THE TRASH TAB (the documents with a chunk in the trash)
// =============================================================================
//
// The trash listing (`list_documents {deleted: 'deleted'}`, listed the first
// time this tab shows, then again after a Refresh or a write) in the same
// grid as the Documents tab. Its path box filters what is loaded. Writes,
// each through the console's controller:
//
//   Restore              a row's, or the ticked rows' (at once: it can be
//                        undone by moving them to the trash again);
//   Delete permanently   a row's, or the ticked rows' (confirmed inline,
//                        typed as vector/confirm.ts says);
//   Empty trash          every document in the trash (listed whole first,
//                        then confirmed, typed).
//
// Both permanent writes send `delete {deleted_only: true}`: a document that
// still has a chunk outside the trash is kept whole, and the result names it.
//
// The permanent writes sit apart from Restore, under their consequence. The
// Deleted chunks column shows where the store reports it (pgvector). Space
// ticks a row; the controls are unavailable, with the reason shown, while
// writing is off or another write runs.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BxTrash } from 'shell';
import type { IDocumentItem } from '../contract/types';
import { CONSOLE_ORIGIN } from '../vector/confirm';
import { writesDuringRemoval } from '../vector/consoleModel';
import { directoryHeading, listCountText, pagerFooter, pagerProgressText, splitPath, targetOf } from '../vector/documents';
import { formatSize } from '../vector/fileType';
import { FILTER_DEBOUNCE_MS, directoryView } from '../vector/filters';
import type { IGridSort } from '../vector/grid';
import { DEFAULT_LIMITS } from '../vector/results';
import { formatCount } from '../vector/stats';
import { CAVEAT_SENTENCES, EMPTY } from '../vector/wording';
import { FOCUS_RING, styles as appStyles } from '../styles';
import { useDebounced } from './DocumentsTab';
import GatedButton from './GatedButton';
import ScopeBar from './ScopeBar';
import VectorGrid from './VectorGrid';
import type { IGridColumn, IVectorGridHandle } from './VectorGrid';
import type { IWorkbenchPanelProps } from './workbenchProps';

/** What the permanent writes do, beside them. */
export const TRASH_DANGER_SENTENCE = 'Delete permanently removes from the store, for good, the documents whose chunks are all in the trash; a document that still has chunks outside the trash is kept whole. This cannot be undone and is not the same as Restore.';

/** What the Trash lists. */
export const TRASH_INTRO = 'Documents with chunks in the trash. Search, chat and the map leave trashed chunks out until they are restored.';

const styles = {
	main: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 8 } as CSSProperties,
	header: { ...appStyles.panelTitle, flexWrap: 'wrap' } as CSSProperties,
	headerCount: { ...appStyles.small, fontWeight: 400, textTransform: 'none', letterSpacing: 0 } as CSSProperties,
	headerEnd: { marginLeft: 'auto' } as CSSProperties,
	line: { ...appStyles.small, padding: '0 12px 6px' } as CSSProperties,
	toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '0 12px 8px' } as CSSProperties,
	danger: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, margin: '0 12px 8px', padding: '6px 8px', border: '1px solid var(--rr-border)', borderLeft: '4px solid var(--rr-color-error)', borderRadius: 6 } as CSSProperties,
	dangerText: { ...appStyles.small, flexBasis: '100%' } as CSSProperties,
	gridBox: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--rr-border)', margin: '0 8px' } as CSSProperties,
	footer: { ...appStyles.small, padding: '6px 12px', borderTop: '1px solid var(--rr-border)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as CSSProperties,
	caveat: { flexBasis: '100%' } as CSSProperties,
	check: { margin: 0 } as CSSProperties,
	rowButton: (off: boolean): CSSProperties => ({ ...appStyles.small, background: 'none', border: '1px solid var(--rr-border-input)', borderRadius: 4, padding: '0 6px', color: 'inherit', opacity: off ? 0.55 : 1, cursor: off ? 'not-allowed' : 'pointer' }),
	rowIcon: (off: boolean): CSSProperties => ({ ...appStyles.iconButton, opacity: off ? 0.55 : 1, cursor: off ? 'not-allowed' : 'pointer' }),
};

/** A row's id. */
const rowId = (item: IDocumentItem): string => item.objectId;

/** What the Trash grid's cells read. */
interface ITrashContext {
	checked: ReadonlySet<string>;
	/** Why writing is unavailable, or null. */
	off: string | null;
	onCheck(item: IDocumentItem): void;
	onRestore(item: IDocumentItem): void;
	onDelete(item: IDocumentItem): void;
}

/** A row button's focus ring. */
const ring = {
	onFocus: (event: React.FocusEvent<HTMLButtonElement>) => (event.currentTarget.style.outline = FOCUS_RING),
	onBlur: (event: React.FocusEvent<HTMLButtonElement>) => (event.currentTarget.style.outline = 'none'),
};

/**
 * The Trash grid's columns (declared here, never derived from rows).
 *
 * @param ctx - What the cells read.
 * @param deletedChunks - Show the Deleted chunks column (the store reports it).
 * @returns The columns.
 */
function trashColumns(ctx: { current: ITrashContext }, deletedChunks: boolean): Array<IGridColumn<IDocumentItem>> {
	const label = (item: IDocumentItem): string => item.path || item.objectId;
	const columns: Array<IGridColumn<IDocumentItem>> = [
		{ id: 'select', label: '', ariaLabel: 'Selected', width: 34, align: 'center', cell: (item, cell) => <input type="checkbox" style={styles.check} checked={ctx.current.checked.has(item.objectId)} aria-label={`Select ${label(item)}`} tabIndex={cell.tabIndex} onChange={() => ctx.current.onCheck(item)} /> },
		{ id: 'name', label: 'Name', width: 'flex', minWidth: 160, sortValue: (item) => splitPath(item.path).name, cell: (item) => splitPath(item.path).name },
		{ id: 'folder', label: 'Folder', width: 'flex', minWidth: 120, sortValue: (item) => splitPath(item.path).folder, cell: (item) => (splitPath(item.path).uploaded ? 'Uploaded' : splitPath(item.path).folder) },
		{ id: 'chunks', label: 'Chunks', width: 70, align: 'right', sortValue: (item) => item.chunks, cell: (item) => (item.chunks === null ? <span title="The store does not count chunks per document">—</span> : formatCount(item.chunks)) },
	];
	if (deletedChunks) columns.push({ id: 'deleted', label: 'Deleted chunks', width: 110, align: 'right', sortValue: (item) => item.deleted_chunks ?? null, cell: (item) => (item.deleted_chunks === null || item.deleted_chunks === undefined ? '—' : formatCount(item.deleted_chunks)) });
	columns.push(
		{ id: 'size', label: 'Size', width: 76, align: 'right', sortValue: (item) => item.size, cell: (item) => formatSize(item.size) },
		{ id: 'ingested', label: 'Ingested', width: 104, sortValue: (item) => item.ingestedAt, cell: (item) => (item.ingestedAt === null ? '—' : <span title={item.ingestedAt.replace('T', ' ').replace('Z', ' UTC')}>{item.ingestedAt.slice(0, 10)}</span>) },
		{
			id: 'actions',
			label: 'Actions',
			width: 110,
			cell: (item, cell) => {
				const off = ctx.current.off;
				return (
					<>
						<button type="button" style={styles.rowButton(off !== null)} aria-label={`Restore ${label(item)}`} title={off ?? `Restore ${label(item)}`} aria-disabled={off !== null || undefined} tabIndex={cell.tabIndex} onClick={() => off === null && ctx.current.onRestore(item)} {...ring}>
							Restore
						</button>
						<button type="button" style={styles.rowIcon(off !== null)} aria-label={`Delete ${label(item)} permanently`} title={off ?? `Delete ${label(item)} permanently`} aria-disabled={off !== null || undefined} tabIndex={cell.tabIndex} onClick={() => off === null && ctx.current.onDelete(item)} {...ring}>
							<BxTrash />
						</button>
					</>
				);
			},
		}
	);
	return columns;
}

/**
 * The Trash tab.
 *
 * @param props - {@link IWorkbenchPanelProps}.
 * @returns The tab's panel.
 */
export function TrashTab({ entry, model, console: state, visible }: IWorkbenchPanelProps): React.ReactElement {
	// Shown: the controller lists the trash (once), and Load more and Retry page it.
	useEffect(() => {
		if (visible) entry.controller.setView('trash');
	}, [visible, entry]);
	const pager = state.trash;
	const writes = writesDuringRemoval(model.writes, state.removal.status);
	const off = writes.enabled ? null : (writes.reason ?? 'Writing is not available.');
	const trashCount = state.stats.view?.deletedDocuments ?? null;
	const [text, setText] = useState('');
	const applied = useDebounced(text, FILTER_DEBOUNCE_MS);
	const view = useMemo(() => directoryView(pager, null, applied, DEFAULT_LIMITS.scope_keys_max), [pager, applied]);
	const rows = view.rows;

	// The ticked rows: a ticked document that is no longer listed is unticked.
	const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		if (checked.size === 0) return;
		const listed = new Set(pager.rows.map((r) => r.objectId));
		const kept = [...checked].filter((id) => listed.has(id));
		if (kept.length !== checked.size) setChecked(new Set(kept));
	}, [pager.rows, checked]);
	const checkedItems = pager.rows.filter((row) => checked.has(row.objectId));
	const toggle = (item: IDocumentItem): void => {
		const next = new Set(checked);
		if (next.has(item.objectId)) next.delete(item.objectId);
		else next.add(item.objectId);
		setChecked(next);
	};
	const ctx = useRef<ITrashContext>({ checked, off, onCheck: toggle, onRestore: () => undefined, onDelete: () => undefined });
	ctx.current = { checked, off, onCheck: toggle, onRestore: (item) => void entry.controller.restore([targetOf(item)]), onDelete: (item) => entry.controller.requestDelete([targetOf(item)]) };
	const deletedChunks = useMemo(() => pager.rows.some((row) => row.deleted_chunks !== null && row.deleted_chunks !== undefined), [pager.rows]);
	const columns = useMemo(() => trashColumns(ctx, deletedChunks), [deletedChunks]);
	const [sort, setSort] = useState<IGridSort | null>(null);
	const grid = useRef<IVectorGridHandle>(null);

	// The rows a permanent write is about to take away (its confirmation open, or its write running): the grid marks the
	// row after them, where the focus goes when the confirmation closes.
	const pendingDelete = state.confirm !== null && state.confirm.origin === CONSOLE_ORIGIN && state.confirm.action !== 'trash' ? state.confirm.targets : null;
	const deleting = useMemo(() => (pendingDelete === null ? null : new Set(pendingDelete.map((t) => t.objectId))), [pendingDelete]);
	const lastDeleting = useRef<ReadonlySet<string> | null>(null);
	if (deleting !== null) lastDeleting.current = deleting;
	else if (state.removal.status !== 'running') lastDeleting.current = null;
	const leaving = lastDeleting.current;

	let empty: string;
	if (pager.rows.length === 0 && pager.status === 'error') empty = EMPTY.unreachable(pager.error?.headline ?? 'the store did not answer.');
	else if (pager.rows.length === 0 && pager.status === 'done') empty = EMPTY.trash;
	else if (pager.rows.length === 0) empty = 'Loading the trash…';
	else empty = EMPTY.noMatch(applied.trim());
	const progress = pagerProgressText(pager);
	const footer = pagerFooter(pager);
	const firstChunkCaveat = pager.caveats.includes('documents_by_first_chunk');
	const nothingSelected = checkedItems.length === 0 ? 'Nothing selected.' : null;

	return (
		<section aria-label="Trash" style={styles.main} data-trash-tab="">
			<div style={styles.header}>
				<span>Trash</span>
				<span style={styles.headerCount}>{pager.status === 'idle' ? '' : directoryHeading(pager)}</span>
			</div>
			<p style={styles.line}>{TRASH_INTRO}</p>
			<ScopeBar text={text} scopeText={applied} onText={setText} listing={pager} />
			{(view.summary || progress) && (
				<div role="status" style={styles.line}>
					{view.summary ?? progress}
				</div>
			)}
			<div style={styles.toolbar} role="toolbar" aria-label="Restore">
				<span style={appStyles.small}>{`${formatCount(checkedItems.length)} selected`}</span>
				<GatedButton unavailable={rows.length === 0 ? 'Nothing is listed.' : null} onClick={() => setChecked(new Set([...checked, ...rows.map((r) => r.objectId)]))}>
					{`Select all shown (${formatCount(rows.length)})`}
				</GatedButton>
				<GatedButton unavailable={nothingSelected} onClick={() => setChecked(new Set())}>
					Clear
				</GatedButton>
				<GatedButton unavailable={off ?? nothingSelected} onClick={() => void entry.controller.restore(checkedItems.map(targetOf))}>
					Restore selected
				</GatedButton>
				{off !== null && <span style={appStyles.small}>{`Restoring and deleting are unavailable: ${off}`}</span>}
			</div>
			<div style={styles.danger} role="group" aria-label="Danger zone">
				<GatedButton variant="danger" unavailable={off ?? nothingSelected} onClick={() => entry.controller.requestDelete(checkedItems.map(targetOf))}>
					Delete selected permanently…
				</GatedButton>
				<GatedButton variant="danger" unavailable={off ?? (pager.rows.length === 0 && (trashCount ?? 0) === 0 ? EMPTY.trash : null)} onClick={() => void entry.controller.requestEmptyTrash()}>
					Empty trash…
				</GatedButton>
				<span style={styles.dangerText}>{TRASH_DANGER_SENTENCE}</span>
			</div>
			<div style={styles.gridBox}>
				<VectorGrid ref={grid} label="Documents in the trash" rows={rows} rowId={rowId} columns={columns} sort={sort} onSort={setSort} onToggle={toggle} hold={pager.status === 'loading' && pager.pages === 0} leaving={leaving} empty={empty} rowTitle={(item) => `${item.path || '(no path)'} · objectId ${item.objectId}`} />
			</div>
			<div style={styles.footer}>
				<span>{listCountText(rows.length, pager)}</span>
				{trashCount !== null && <span>{`The store counts ${formatCount(trashCount)} ${trashCount === 1 ? 'document' : 'documents'} in the trash.`}</span>}
				{footer && <span>{footer.text}</span>}
				{footer?.loadMore && <GatedButton onClick={() => entry.controller.loadMoreDocuments()}>Load more</GatedButton>}
				{footer?.retry && <GatedButton onClick={() => entry.controller.retryDocuments()}>Retry</GatedButton>}
				{footer?.caveat && <span style={styles.caveat}>{footer.caveat}</span>}
				{firstChunkCaveat && <span style={styles.caveat}>{CAVEAT_SENTENCES.documents_by_first_chunk}</span>}
			</div>
		</section>
	);
}

export default TrashTab;
