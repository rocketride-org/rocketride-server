// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Table — a small, static data table with sortable columns and optional
 * clickable rows: usage breakdowns, a model's limits, a run's steps.
 *
 * For large, remote, paged, filterable or user-configurable data use
 * DataGrid; Table renders every row it is given and sorts in memory.
 *
 * Sortable headers are buttons inside `<th aria-sort>`; clicking toggles
 * ascending/descending. Empty values always sort last. Clickable rows are
 * focusable and open with Enter. Controlled (`sort` + `onSortChange`) or
 * uncontrolled (`defaultSort`).
 *
 * Built on `.rr-table` from components.css.
 */

import React, { ReactNode, useState } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Sort direction. */
export type SortDirection = 'asc' | 'desc';

/** The active sort. */
export interface ITableSort {
	/** Column id. */
	columnId: string;
	/** Direction. */
	direction: SortDirection;
}

/** A sortable cell value. */
export type SortValue = string | number | boolean | Date | null | undefined;

/** One column of a {@link Table}. */
export interface ITableColumn<T> {
	/** Stable id. */
	id: string;
	/** Header text. */
	header: ReactNode;
	/** The cell's raw value: shown when there is no `render`, and used for sorting. */
	value?: (row: T) => SortValue;
	/** Custom cell content. */
	render?: (row: T) => ReactNode;
	/** Allow sorting on this column (needs `value`). */
	sortable?: boolean;
	/** Text alignment. Numbers usually go right. Defaults to `'left'`. */
	align?: 'left' | 'center' | 'right';
	/** Monospace cells (ids, numbers, durations). */
	mono?: boolean;
	/** Fixed column width (CSS length or px). */
	width?: number | string;
}

/** Props for the {@link Table} component. */
export interface ITableProps<T> {
	/** Columns, in order. */
	columns: ITableColumn<T>[];
	/** Rows. */
	rows: T[];
	/** Stable key for a row. */
	getRowId: (row: T) => string;
	/** Active sort (controlled). */
	sort?: ITableSort | null;
	/** Initial sort (uncontrolled). */
	defaultSort?: ITableSort | null;
	/** Fired with the new sort. */
	onSortChange?: (sort: ITableSort) => void;
	/** Make rows clickable (and keyboard-activatable). */
	onRowClick?: (row: T) => void;
	/** Accessible name / visually hidden caption. */
	caption?: string;
	/** Shown in place of the body when there are no rows. */
	emptyText?: ReactNode;
	/** Tighter cell padding. */
	dense?: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Whether a value counts as empty for sorting. */
function isEmptyValue(value: SortValue): boolean {
	return value === null || value === undefined || value === '';
}

/**
 * Compares two cell values ascending. Strings compare naturally ("run 2"
 * before "run 10") and case-insensitively; dates and booleans compare by
 * their numeric value.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns Negative, zero or positive.
 */
export function compareValues(a: SortValue, b: SortValue): number {
	if (a instanceof Date) a = a.getTime();
	if (b instanceof Date) b = b.getTime();
	if (typeof a === 'boolean') a = Number(a);
	if (typeof b === 'boolean') b = Number(b);
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sorts rows by a column value. Stable; empty values always go last,
 * whatever the direction.
 *
 * @param rows - Rows to sort (not mutated).
 * @param getValue - Reads the sort value of a row.
 * @param direction - Sort direction.
 * @returns A new, sorted array.
 */
export function sortRows<T>(rows: readonly T[], getValue: (row: T) => SortValue, direction: SortDirection): T[] {
	const indexed = rows.map((row, index) => ({ row, index, value: getValue(row) }));
	indexed.sort((left, right) => {
		const isLeftEmpty = isEmptyValue(left.value);
		const isRightEmpty = isEmptyValue(right.value);
		if (isLeftEmpty && isRightEmpty) return left.index - right.index;
		if (isLeftEmpty) return 1;
		if (isRightEmpty) return -1;
		let result = compareValues(left.value, right.value);
		if (direction === 'desc') result = -result;
		if (result === 0) return left.index - right.index;
		return result;
	});
	return indexed.map((entry) => entry.row);
}

/**
 * The sort after clicking a header: a new column starts ascending, the
 * active column flips.
 *
 * @param current - The active sort, if any.
 * @param columnId - The clicked column.
 * @returns The next sort.
 */
export function nextSort(current: ITableSort | null | undefined, columnId: string): ITableSort {
	if (!current || current.columnId !== columnId) return { columnId, direction: 'asc' };
	if (current.direction === 'asc') return { columnId, direction: 'desc' };
	return { columnId, direction: 'asc' };
}

/** Renders a raw value as text. */
function formatValue(value: SortValue): ReactNode {
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toLocaleString();
	return String(value);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a small sortable table.
 *
 * @param props - {@link ITableProps}.
 * @returns The table element.
 */
export function Table<T>({ columns, rows, getRowId, sort, defaultSort = null, onSortChange, onRowClick, caption, emptyText = 'No data', dense = false }: ITableProps<T>): React.ReactElement {
	const [internalSort, setInternalSort] = useState<ITableSort | null>(defaultSort);

	let activeSort = internalSort;
	if (sort !== undefined) activeSort = sort;

	let shownRows: T[] = rows;
	const sortColumn = columns.find((column) => column.id === activeSort?.columnId);
	if (activeSort && sortColumn?.value) shownRows = sortRows(rows, sortColumn.value, activeSort.direction);

	/** Header click: compute and report the next sort. */
	function handleSort(columnId: string): void {
		const next = nextSort(activeSort, columnId);
		if (sort === undefined) setInternalSort(next);
		onSortChange?.(next);
	}

	let tableClassName = 'rr-table';
	if (onRowClick) tableClassName += ' rr-table--hover rr-table--clickable';
	if (dense) tableClassName += ' rr-table--dense';

	return (
		<table className={tableClassName}>
			{caption && <caption className="rr-sr-only">{caption}</caption>}
			<thead>
				<tr>
					{columns.map((column) => {
						let ariaSort: 'ascending' | 'descending' | 'none' | undefined;
						if (column.sortable) ariaSort = 'none';
						if (column.sortable && activeSort?.columnId === column.id && activeSort.direction === 'asc') ariaSort = 'ascending';
						if (column.sortable && activeSort?.columnId === column.id && activeSort.direction === 'desc') ariaSort = 'descending';

						return (
							<th key={column.id} scope="col" aria-sort={ariaSort} style={{ textAlign: column.align ?? 'left', width: column.width }}>
								{column.sortable && column.value && (
									<button type="button" className="rr-table__sort" data-sort={ariaSort} onClick={() => handleSort(column.id)}>
										{column.header}
										<span className="rr-table__sort-icon" aria-hidden="true" />
									</button>
								)}
								{!(column.sortable && column.value) && column.header}
							</th>
						);
					})}
				</tr>
			</thead>
			<tbody>
				{shownRows.length === 0 && (
					<tr>
						<td colSpan={columns.length} className="rr-table__empty">
							{emptyText}
						</td>
					</tr>
				)}
				{shownRows.map((row) => {
					let rowProps: React.HTMLAttributes<HTMLTableRowElement> = {};
					if (onRowClick) {
						rowProps = {
							tabIndex: 0,
							onClick: () => onRowClick(row),
							onKeyDown: (event) => {
								if (event.key === 'Enter') onRowClick(row);
							},
						};
					}
					return (
						<tr key={getRowId(row)} {...rowProps}>
							{columns.map((column) => {
								let content: ReactNode = null;
								if (column.render) {
									content = column.render(row);
								} else if (column.value) {
									content = formatValue(column.value(row));
								}
								let cellClassName: string | undefined;
								if (column.mono) cellClassName = 'rr-text-mono';
								return (
									<td key={column.id} className={cellClassName} style={{ textAlign: column.align ?? 'left' }}>
										{content}
									</td>
								);
							})}
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
