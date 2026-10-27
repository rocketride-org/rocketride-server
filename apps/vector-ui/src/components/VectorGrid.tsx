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
// VECTOR-UI - VECTOR GRID (a sortable, hand-windowed grid: APG grid, one focusable row)
// =============================================================================
//
// The Documents and Trash tabs and a document tab's chunks list their rows
// here. It is a grid in the WAI-ARIA sense (role="grid", a header row of
// column headers with aria-sort, rows with aria-rowindex out of
// aria-rowcount) with ONE row in the tab order at a time:
//
//   Up / Down        the row above or below
//   Page Up / Down   a page of rows
//   Home / End       the first and the last row
//   Enter            onActivate (the Documents tab opens the drawer)
//   Space            onToggle (the Documents tab stages the document)
//
// Only the rows in view are rendered (fixed-height rows, placed by their
// index), plus the focused row wherever the list is scrolled, so a row
// scrolled out of view never takes the focus with it. Rows are keyed by
// their id, so new pages and changed rows keep the focused row's element
// and its focus. When the focused row leaves the list (moved to the trash,
// restored, filtered out), the focus goes to the row after it, else the one
// before it, else the grid itself: never to the page. A listing that starts
// over (after a write or a Refresh) has no row until its first page: with
// `hold` the grid keeps its last rows until then, so it neither flashes
// empty nor drops the focus. While a confirmation is about to take rows
// away (`leaving`), the row after them is rendered and marked
// `data-return-focus`: the workbench puts the focus there when the
// confirmation closes after Confirm (views/ConsoleView.tsx returnFocus).
//
// Every rule (the sort, the keys, the window, where the focus goes) is in
// vector/grid.ts. The grid reads the rows it is given and never writes to
// them. The keys are handled on the grid's own element: no document or
// window listener, and no event is stopped.
// =============================================================================

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ForwardedRef, ReactElement, ReactNode, Ref } from 'react';
import { ACCENT_TOKEN, selectedRowBackground } from '../vector/colors';
import { gridKey, gridTemplate, gridWindow, nextFocusAfterRemoval, nextRowAfter, nextSort, scrollToShow, sortRows } from '../vector/grid';
import type { IGridSort, IGridSortable } from '../vector/grid';
import { FOCUS_RING } from '../styles';

/** The header row's height (px). */
export const GRID_HEADER_HEIGHT = 32;

/** The default row height (px). */
export const GRID_ROW_HEIGHT = 30;

/** Rows rendered above and below the view. */
const OVERSCAN = 12;

/** Layout effects in a browser; plain effects where nothing is laid out (a static render runs neither). */
const useLayoutish = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** What a cell's content is told about its row. */
export interface IGridCellContext {
	/** 0 in the row that is in the tab order, else -1: controls inside a cell use it as their tabIndex. */
	tabIndex: 0 | -1;
}

/** One column. */
export interface IGridColumn<R> extends IGridSortable<R> {
	id: string;
	/** The header's words (also the column's accessible name unless `ariaLabel` is given). */
	label: string;
	/** The accessible name when the header shows no words (a checkbox column). */
	ariaLabel?: string;
	/** A fixed width (px), or 'flex' for a column that takes the room left. */
	width: number | 'flex';
	/** The narrowest a 'flex' column gets (px). */
	minWidth?: number;
	align?: 'left' | 'right' | 'center';
	/** The header's tooltip. */
	title?: string;
	/** The cell. */
	cell(row: R, ctx: IGridCellContext): ReactNode;
}

/** Props for the {@link VectorGrid} component. */
export interface IVectorGridProps<R> {
	/** The grid's accessible name. */
	label: string;
	/** The rows, in their own order (read, never written). */
	rows: readonly R[];
	/** A row's id: stable and unique. Keep the function's identity (a module function or a memoised callback). */
	rowId(row: R): string;
	/** The columns (memoise them). */
	columns: ReadonlyArray<IGridColumn<R>>;
	/** The sort, or null for the rows' own order. */
	sort: IGridSort | null;
	onSort(next: IGridSort | null): void;
	/** The row shown as selected (aria-selected), e.g. the one the drawer shows; absent: rows are not selectable. */
	selectedId?: string | null;
	/** Enter on a row (and a click on it with `activateOnClick`). */
	onActivate?(row: R): void;
	/** Space on a row. */
	onToggle?(row: R): void;
	/** A click on a row outside its controls activates it. */
	activateOnClick?: boolean;
	rowHeight?: number;
	/** Shown under the header when there is no row. */
	empty?: ReactNode;
	/** A row's tooltip. */
	rowTitle?(row: R): string | undefined;
	/** The header's background (it stays on top while the rows scroll): the surface the grid sits on. */
	surface?: string;
	/**
	 * Keep showing the last rows (a listing that starts over has no row until its first page): no flash, and the
	 * focused row stays where it is until the new rows arrive.
	 */
	hold?: boolean;
	/**
	 * The rows a write is about to take away (an open, or just confirmed, confirmation): the row after them (else
	 * before them) is rendered and marked `data-return-focus`, where the workbench puts the focus when the
	 * confirmation closes.
	 */
	leaving?: ReadonlySet<string> | null;
}

/** What a parent can ask of the grid. */
export interface IVectorGridHandle {
	/** Bring a row into view and focus it; false when it is not listed. */
	focusRow(id: string): boolean;
	/** Focus the grid itself (no row listed, or nothing better). */
	focusGrid(): void;
	/** Focus the row in the tab order, else the grid itself. */
	focusStop(): void;
	/** Bring a row into view and make it the one in the tab order, without moving the focus; false when not listed. */
	showRow(id: string): boolean;
	/** The ids in the order they are shown. */
	shownIds(): readonly string[];
}

const styles = {
	wrap: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	grid: { flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', outline: 'none', fontSize: 13 } as CSSProperties,
	headerGroup: (surface: string, minWidth: number): CSSProperties => ({ position: 'sticky', top: 0, zIndex: 1, background: surface, minWidth }),
	header: (template: string): CSSProperties => ({ display: 'grid', gridTemplateColumns: template, height: GRID_HEADER_HEIGHT, borderBottom: '1px solid var(--rr-border)' }),
	columnHeader: (align: IGridColumn<unknown>['align']): CSSProperties => ({ display: 'flex', alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start', minWidth: 0, padding: '0 8px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden' }),
	sortButton: { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', padding: 0, border: 'none', background: 'none', color: 'inherit', font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
	body: (height: number, minWidth: number): CSSProperties => ({ position: 'relative', height, minWidth }),
	row: (opts: { top: number; height: number; template: string; selected: boolean; hovered: boolean; focused: boolean; clickable: boolean }): CSSProperties => ({
		position: 'absolute',
		top: opts.top,
		left: 0,
		right: 0,
		height: opts.height,
		display: 'grid',
		gridTemplateColumns: opts.template,
		alignItems: 'center',
		boxSizing: 'border-box',
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
		boxShadow: opts.selected ? `inset 3px 0 0 var(${ACCENT_TOKEN})` : undefined,
		background: opts.selected ? selectedRowBackground() : opts.hovered ? 'var(--rr-bg-list-hover)' : 'transparent',
		outline: opts.focused ? FOCUS_RING : 'none',
		outlineOffset: -2,
		cursor: opts.clickable ? 'pointer' : 'default',
	}),
	cell: (align: IGridColumn<unknown>['align']): CSSProperties => ({ display: 'flex', alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start', gap: 4, minWidth: 0, height: '100%', padding: '0 8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }),
	empty: { padding: '16px 12px', fontSize: 12.5 } as CSSProperties,
};

/** Whether an event started on a control inside a row (it does its own thing; the row does not). */
function onControl(target: EventTarget | null, row: Element): boolean {
	const el = target instanceof Element ? target.closest('button, input, select, textarea, a, label, [data-grid-control]') : null;
	return el !== null && el !== row && row.contains(el);
}

/** The row element an event happened in, if it is one of this grid's. */
function rowOf(target: EventTarget | null, grid: HTMLElement | null): HTMLElement | null {
	const row = target instanceof Element ? target.closest<HTMLElement>('[data-grid-row]') : null;
	return row !== null && grid !== null && grid.contains(row) ? row : null;
}

/** The narrowest the columns get together (px): the grid scrolls sideways below it. */
function minimumWidth(columns: ReadonlyArray<{ width: number | 'flex'; minWidth?: number }>): number {
	return columns.reduce((sum, c) => sum + (c.width === 'flex' ? (c.minWidth ?? 120) : c.width), 0);
}

/**
 * The grid.
 *
 * @param props - {@link IVectorGridProps}.
 * @param ref - {@link IVectorGridHandle}.
 * @returns The grid element.
 */
function VectorGridInner<R>(props: IVectorGridProps<R>, ref: ForwardedRef<IVectorGridHandle>): ReactElement {
	const { label, rowId, columns, sort, onSort, selectedId, onActivate, onToggle, activateOnClick = false, rowHeight = GRID_ROW_HEIGHT, empty, rowTitle, surface = 'var(--rr-bg-paper)', hold = false, leaving = null } = props;
	// While held, the rows of the last render that was not.
	const lastRows = useRef(props.rows);
	if (!hold) lastRows.current = props.rows;
	const rows = hold ? lastRows.current : props.rows;
	const grid = useRef<HTMLDivElement>(null);
	const rowEls = useRef(new Map<string, HTMLElement>());
	const [scrollTop, setScrollTop] = useState(0);
	const [viewHeight, setViewHeight] = useState(400);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	// A row to focus once it is rendered (a key move, focusRow, or the row after one that left).
	const pending = useRef<string | null>(null);
	const [, setTick] = useState(0);
	// True while the focus is in the grid (a row or a control in it); a row leaving the list keeps it true.
	const focusInside = useRef(false);

	const shown = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
	const ids = useMemo(() => shown.map(rowId), [shown, rowId]);
	const indexOf = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids]);
	const template = useMemo(() => gridTemplate(columns), [columns]);
	const minWidth = useMemo(() => minimumWidth(columns), [columns]);
	const count = ids.length;
	const activeIndex = activeId === null ? -1 : (indexOf.get(activeId) ?? -1);
	// The row in the tab order: the active one, else the first.
	const stop = activeIndex >= 0 ? activeIndex : count > 0 ? 0 : -1;
	const bodyHeight = Math.max(rowHeight, viewHeight - GRID_HEADER_HEIGHT);
	const view = gridWindow({ scrollTop, height: bodyHeight, rowHeight, count, overscan: OVERSCAN, focused: stop });
	// The row the focus goes to when a confirmation for `leaving` closes (rendered wherever the list is scrolled).
	const returnId = useMemo(() => (leaving === null || leaving.size === 0 ? null : nextRowAfter(ids, leaving)), [leaving, ids]);
	const returnIndex = returnId === null ? -1 : (indexOf.get(returnId) ?? -1);

	// The rows' viewport (never a 0x0 box: a hidden tab keeps the last size).
	useEffect(() => {
		const el = grid.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => {
			if (el.clientHeight > 0) setViewHeight(el.clientHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// The focused row left the list: the focus goes to the row after it (else before it, else the grid) when it fell to the page.
	const before = useRef<readonly string[]>(ids);
	useLayoutish(() => {
		const previous = before.current;
		before.current = ids;
		if (activeId === null || indexOf.has(activeId)) return;
		const next = nextFocusAfterRemoval(previous, new Set(ids), activeId);
		setActiveId(next);
		const fell = typeof document !== 'undefined' && (document.activeElement === null || document.activeElement === document.body);
		if (focusInside.current && fell) {
			if (next === null) grid.current?.focus({ preventScroll: true });
			else pending.current = next;
		}
	}, [ids, indexOf, activeId]);

	// Focus the row asked for, now that it is rendered.
	useLayoutish(() => {
		const id = pending.current;
		if (id === null) return;
		const el = rowEls.current.get(id);
		if (!el) return;
		pending.current = null;
		el.focus({ preventScroll: true });
	});

	/** Scroll a row into view (as little as needed). */
	const show = useCallback(
		(index: number): void => {
			const el = grid.current;
			if (!el) return;
			const to = scrollToShow(index, { scrollTop: el.scrollTop, height: Math.max(rowHeight, el.clientHeight - GRID_HEADER_HEIGHT), rowHeight });
			if (to !== null) {
				el.scrollTop = to;
				setScrollTop(to);
			}
		},
		[rowHeight]
	);

	useImperativeHandle(
		ref,
		() => ({
			focusRow(id: string): boolean {
				const index = indexOf.get(id);
				if (index === undefined) return false;
				show(index);
				setActiveId(id);
				pending.current = id;
				setTick((n) => n + 1);
				return true;
			},
			focusGrid(): void {
				grid.current?.focus({ preventScroll: true });
			},
			focusStop(): void {
				const id = stop >= 0 ? ids[stop] : undefined;
				if (id === undefined) {
					grid.current?.focus({ preventScroll: true });
					return;
				}
				show(stop);
				setActiveId(id);
				pending.current = id;
				setTick((n) => n + 1);
			},
			showRow(id: string): boolean {
				const index = indexOf.get(id);
				if (index === undefined) return false;
				show(index);
				setActiveId(id);
				return true;
			},
			shownIds: () => ids,
		}),
		[indexOf, ids, show, stop]
	);

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
		const row = rowOf(event.target, grid.current);
		// The grid itself has the focus (no row was left to take it): a move key enters at the row in the tab order.
		if (row === null) {
			if (event.target !== grid.current || stop < 0) return;
			const entered = gridKey(event.key, { index: stop, count, page: Math.floor(bodyHeight / rowHeight) });
			if (entered === null || entered.kind !== 'move') return;
			event.preventDefault();
			const to = event.key === 'Home' || event.key === 'End' ? entered.index : stop;
			show(to);
			setActiveId(ids[to] as string);
			pending.current = ids[to] as string;
			setTick((n) => n + 1);
			return;
		}
		const id = row.dataset.rowId ?? '';
		const index = indexOf.get(id);
		if (index === undefined) return;
		const action = gridKey(event.key, { index, count, page: Math.floor(bodyHeight / rowHeight) });
		if (action === null) return;
		// Enter and Space on a control inside the row are the control's (a checkbox ticks, a button clicks).
		if (action.kind !== 'move' && event.target !== row) return;
		const item = shown[index] as R;
		if (action.kind === 'move') {
			event.preventDefault();
			const to = ids[action.index] as string;
			show(action.index);
			setActiveId(to);
			pending.current = to;
			setTick((n) => n + 1);
		} else if (action.kind === 'activate' && onActivate) {
			event.preventDefault();
			onActivate(item);
		} else if (action.kind === 'toggle' && onToggle) {
			event.preventDefault();
			onToggle(item);
		}
	};

	const rowElements: ReactElement[] = [];
	const indices: number[] = [];
	for (let i = view.first; i < view.last; i++) indices.push(i);
	if (view.extra !== null) indices.push(view.extra);
	if (returnIndex >= 0 && !indices.includes(returnIndex)) indices.push(returnIndex);
	for (const index of indices) {
		const item = shown[index] as R;
		const id = ids[index] as string;
		const inTabOrder = index === stop;
		rowElements.push(
			<div
				key={id}
				role="row"
				data-grid-row=""
				data-row-id={id}
				aria-rowindex={index + 2}
				data-return-focus={returnId === id ? '' : undefined}
				aria-selected={selectedId === undefined ? undefined : selectedId === id}
				tabIndex={inTabOrder ? 0 : -1}
				title={rowTitle?.(item)}
				ref={(el) => {
					if (el) rowEls.current.set(id, el);
					else rowEls.current.delete(id);
				}}
				style={styles.row({ top: index * rowHeight, height: rowHeight, template, selected: selectedId === id, hovered: hoveredId === id, focused: focusedId === id, clickable: activateOnClick })}
				onMouseEnter={() => setHoveredId(id)}
				onMouseLeave={() => setHoveredId((h) => (h === id ? null : h))}
				onClick={(event) => {
					if (!activateOnClick || !onActivate || onControl(event.target, event.currentTarget)) return;
					onActivate(item);
				}}
			>
				{columns.map((column) => (
					<div key={column.id} role="gridcell" style={styles.cell(column.align)}>
						{column.cell(item, { tabIndex: inTabOrder ? 0 : -1 })}
					</div>
				))}
			</div>
		);
	}

	return (
		<div style={styles.wrap}>
			<div
				ref={grid}
				role="grid"
				aria-label={label}
				aria-rowcount={count + 1}
				aria-colcount={columns.length}
				tabIndex={-1}
				data-grid-focus=""
				style={styles.grid}
				onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
				onKeyDown={onKeyDown}
				onFocus={(event) => {
					focusInside.current = true;
					const row = rowOf(event.target, grid.current);
					if (row === null) return;
					const id = row.dataset.rowId ?? null;
					setActiveId(id);
					setFocusedId(event.target === row ? id : null);
				}}
				onBlur={(event) => {
					setFocusedId(null);
					const to = event.relatedTarget;
					if (to instanceof Node && grid.current?.contains(to)) return;
					// Leaving for another control, or for the page because the focused element is still there (a click outside):
					// the focus left on purpose. An element removed with the focus keeps focusInside (its row left the list).
					const from = event.target;
					if (to !== null) focusInside.current = false;
					else
						setTimeout(() => {
							if (from.isConnected) focusInside.current = false;
						}, 0);
				}}
			>
				<div role="rowgroup" style={styles.headerGroup(surface, minWidth)}>
					<div role="row" aria-rowindex={1} style={styles.header(template)}>
						{columns.map((column) => {
							const sorted = sort !== null && sort.column === column.id ? sort.dir : null;
							return (
								<div key={column.id} role="columnheader" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined} aria-label={column.ariaLabel} title={column.title} style={styles.columnHeader(column.align)}>
									{column.sortValue ? (
										<button
											type="button"
											style={styles.sortButton}
											title={column.title ?? `Sort by ${column.label}`}
											onClick={() => onSort(nextSort(sort, column.id))}
											onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)}
											onBlur={(event) => (event.currentTarget.style.outline = 'none')}
										>
											<span>{column.label}</span>
											{sorted !== null && <span aria-hidden="true">{sorted === 'asc' ? '▲' : '▼'}</span>}
										</button>
									) : (
										<span>{column.label}</span>
									)}
								</div>
							);
						})}
					</div>
				</div>
				<div role="rowgroup" style={styles.body(count * rowHeight, minWidth)}>
					{rowElements}
				</div>
			</div>
			{count === 0 && empty !== undefined && <div style={styles.empty}>{empty}</div>}
		</div>
	);
}

/** The grid (generic over its row type). */
export const VectorGrid = forwardRef(VectorGridInner) as <R>(props: IVectorGridProps<R> & { ref?: Ref<IVectorGridHandle> }) => ReactElement;

export default VectorGrid;
