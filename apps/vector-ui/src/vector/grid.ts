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
// VECTOR - THE GRID'S RULES (pure): sorting, keys, the rendered window and where focus goes
// =============================================================================
//
// components/VectorGrid.tsx is a hand-windowed grid (APG grid pattern, one
// focusable row at a time) for the Documents and Trash tabs and the document
// tab's chunks. Everything it decides lives here, so it is tested without a
// browser:
//
//   SORT     a header cycles ascending, descending, then the rows' own
//            order (as the shell's grids do). Sorting is stable, keeps empty
//            values (null: the store did not report it) last in both
//            directions, and compares text the same way in every browser and
//            locale. It reads the rows and never writes to them.
//   KEYS     Up and Down move one row, Page Up and Page Down a page, Home and
//            End to the first and last row; Enter activates the row and
//            Space toggles it.
//   WINDOW   only the rows in view (plus an overscan) are rendered, and the
//            focused row always is, wherever the list is scrolled, so the
//            focus never leaves with a row scrolled out of view.
//   FOCUS    a focused row that leaves the list hands the focus to the row
//            after it, else the one before it, else nobody (the caller then
//            focuses the grid itself or the tab).
// =============================================================================

/** A sort direction. */
export type SortDir = 'asc' | 'desc';

/** The grid's sort: a column and a direction, or null for the rows' own order. */
export interface IGridSort {
	column: string;
	dir: SortDir;
}

/** A column as sorting reads it. */
export interface IGridSortable<R> {
	id: string;
	/** The value the column sorts by; null or absent sorts last. Without it the column does not sort. */
	sortValue?(row: R): string | number | null;
}

/**
 * The sort after a click on a column's header: ascending, then descending, then none.
 *
 * @param current - The sort now.
 * @param column - The column clicked.
 * @returns The next sort.
 */
export function nextSort(current: IGridSort | null, column: string): IGridSort | null {
	if (current === null || current.column !== column) return { column, dir: 'asc' };
	return current.dir === 'asc' ? { column, dir: 'desc' } : null;
}

/** Code-point comparison, lower case first, so the order is the same in every browser and locale. */
function compareText(a: string, b: string): number {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	if (la !== lb) return la < lb ? -1 : 1;
	return a === b ? 0 : a < b ? -1 : 1;
}

/** Two present values of one column (numbers before text when a column mixes them). */
function compareValues(a: string | number, b: string | number): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'number') return -1;
	if (typeof b === 'number') return 1;
	return compareText(a, b);
}

/**
 * The rows in a sort's order (a new array), or the rows themselves when there is no sort or the column does not sort.
 *
 * @param rows - The rows, in their own order.
 * @param columns - The grid's columns.
 * @param sort - The sort.
 * @returns The rows to show, in order.
 */
export function sortRows<R>(rows: readonly R[], columns: ReadonlyArray<IGridSortable<R>>, sort: IGridSort | null): readonly R[] {
	if (sort === null) return rows;
	const column = columns.find((c) => c.id === sort.column);
	const read = column?.sortValue;
	if (!read) return rows;
	const sign = sort.dir === 'asc' ? 1 : -1;
	const keyed = rows.map((row, index) => {
		const value = read(row);
		return { row, index, value: value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value };
	});
	keyed.sort((a, b) => {
		if (a.value === null || b.value === null) return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
		return sign * compareValues(a.value, b.value) || a.index - b.index;
	});
	return keyed.map((k) => k.row);
}

/** What a key does in the grid. */
export type GridKeyAction = { kind: 'move'; index: number } | { kind: 'activate' } | { kind: 'toggle' };

/**
 * What a key pressed on a row does.
 *
 * @param key - `KeyboardEvent.key`.
 * @param at - The focused row's index (-1: none yet), how many rows, and how many fit in a page.
 * @returns The action, or null for a key the grid leaves alone.
 */
export function gridKey(key: string, at: { index: number; count: number; page: number }): GridKeyAction | null {
	const { index, count } = at;
	if (count === 0) return null;
	const page = Math.max(1, Math.floor(at.page));
	const last = count - 1;
	const from = Math.min(Math.max(index, -1), last);
	const move = (to: number): GridKeyAction => ({ kind: 'move', index: Math.min(Math.max(to, 0), last) });
	switch (key) {
		case 'ArrowDown':
			return move(from + 1);
		case 'ArrowUp':
			return move(from < 0 ? 0 : from - 1);
		case 'PageDown':
			return move(from < 0 ? page - 1 : from + page);
		case 'PageUp':
			return move(from - page);
		case 'Home':
			return move(0);
		case 'End':
			return move(last);
		case 'Enter':
			return from < 0 ? null : { kind: 'activate' };
		case ' ':
		case 'Spacebar':
			return from < 0 ? null : { kind: 'toggle' };
		default:
			return null;
	}
}

/** The rows to render: `first` to `last` (exclusive), and the focused row when it lies outside them. */
export interface IGridWindow {
	first: number;
	last: number;
	/** The focused row's index when it is outside first..last, else null. */
	extra: number | null;
}

/**
 * The rows a windowed list renders.
 *
 * @param view - The scroll offset and height of the rows' viewport (px), the row height, how many rows, the overscan
 *   (rows rendered above and below the view) and the focused row's index (-1: none).
 * @returns The window.
 */
export function gridWindow(view: { scrollTop: number; height: number; rowHeight: number; count: number; overscan: number; focused: number }): IGridWindow {
	const { scrollTop, height, rowHeight, count, overscan, focused } = view;
	const step = Math.max(1, rowHeight);
	const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / step) - overscan);
	const last = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, height)) / step) + overscan);
	const extra = focused >= 0 && focused < count && (focused < first || focused >= last) ? focused : null;
	return { first, last: Math.max(first, last), extra };
}

/**
 * Where to scroll so a row is in view, or null when it already is (only as far as needed).
 *
 * @param index - The row.
 * @param view - The viewport's scroll offset and height (px, the rows' part only) and the row height.
 * @returns The new scroll offset, or null.
 */
export function scrollToShow(index: number, view: { scrollTop: number; height: number; rowHeight: number }): number | null {
	const top = index * view.rowHeight;
	const bottom = top + view.rowHeight;
	if (top < view.scrollTop) return top;
	if (bottom > view.scrollTop + view.height) return Math.max(0, bottom - view.height);
	return null;
}

/**
 * The row that takes the focus when the focused row is no longer listed: itself while it is; else the next one of the
 * old order that is still listed; else the one before it; else null.
 *
 * @param before - The ids in the order they were shown.
 * @param now - The ids shown now.
 * @param focused - The focused row's id.
 * @returns The id to focus, or null when no row is left.
 */
export function nextFocusAfterRemoval(before: readonly string[], now: ReadonlySet<string>, focused: string): string | null {
	if (now.has(focused)) return focused;
	const at = before.indexOf(focused);
	if (at < 0) return now.size > 0 ? (now.values().next().value ?? null) : null;
	for (let i = at + 1; i < before.length; i++) if (now.has(before[i] as string)) return before[i] as string;
	for (let i = at - 1; i >= 0; i--) if (now.has(before[i] as string)) return before[i] as string;
	return now.size > 0 ? (now.values().next().value ?? null) : null;
}

/**
 * The row after a write that removes some rows (the lead's rule: the next row, else the grid): the first row after the
 * first target that is not a target, else the last row before it that is not one. Chosen while the targets are still
 * listed, so the focus lands on a row that stays.
 *
 * @param ids - The ids in the order they are shown.
 * @param targets - The rows the write removes.
 * @returns The id to focus, or null when no target is shown or no other row is left.
 */
export function nextRowAfter(ids: readonly string[], targets: ReadonlySet<string>): string | null {
	const at = ids.findIndex((id) => targets.has(id));
	if (at < 0) return null;
	for (let i = at + 1; i < ids.length; i++) if (!targets.has(ids[i] as string)) return ids[i] as string;
	for (let i = at - 1; i >= 0; i--) if (!targets.has(ids[i] as string)) return ids[i] as string;
	return null;
}

/**
 * The CSS grid template every row and the header share: a number is a fixed width in px, 'flex' a column that takes
 * the room left (never narrower than its minimum).
 *
 * @param columns - The columns' widths and minimum widths.
 * @returns The `grid-template-columns` value.
 */
export function gridTemplate(columns: ReadonlyArray<{ width: number | 'flex'; minWidth?: number }>): string {
	return columns.map((c) => (c.width === 'flex' ? `minmax(${Math.max(0, c.minWidth ?? 120)}px, 1fr)` : `${Math.max(0, c.width)}px`)).join(' ');
}
