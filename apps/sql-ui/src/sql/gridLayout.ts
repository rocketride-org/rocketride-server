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
// SQL — GRID LAYOUTS (what a saved layout may restore)
// =============================================================================
//
// Every grid lays out with fitColumns, and the shell saves each column's
// CURRENT width under the grid's tableId, flexible columns included. A grid
// built inside a hidden panel, or mid-transition, measures a 0-wide (or
// wrong) container, crushes its flexible columns to Tabulator's 40 px
// minimum, and saves that. Every later open restores the 40 px as a FIXED
// width, which no resize or redraw undoes: the Overview's Table column stayed
// 40 px and every Data column of a table had its header cut.
//
// So each sql-ui grid's persistence goes through this guard, which reads and
// writes a column layout with:
//
//   - no width for a column the code leaves flexible: it always fills, and
//     a width a user drags on one is not kept (the trade for never freezing
//     a crushed one);
//   - no width under MIN_SAVED_WIDTH for a column the code sizes, which only
//     a crushed build produces;
//   - every column a user cannot hide (the actions column: no header menu)
//     visible.
//
// A stored layout is healed as it is read, and sort, page size, display and
// format pass through untouched.
// =============================================================================

import type { IDataGridPersistence } from 'shell';

/** The narrowest saved width kept for a column the code sizes (px). */
export const MIN_SAVED_WIDTH = 60;

/** What a grid's saved column layout may keep. */
export interface LayoutRules {
	/** Columns the code gives a width: only these keep a saved width. */
	fixedWidths: string[];
	/** Columns a user cannot hide: always restored visible. */
	alwaysVisible: string[];
}

/** The part of a column definition the rules read. */
interface ColumnShape {
	/** The column's field. */
	field?: string;
	/** Its declared width, when the code sizes it. */
	width?: number | string;
	/** The shell's marker for a column without a header menu (no show/hide toggle). */
	rrNoPopup?: boolean;
}

/**
 * The rules for a grid, from its column definitions.
 *
 * @param columns - The grid's columns.
 * @returns Which widths it keeps and which columns always show.
 */
export function layoutRulesFor(columns: readonly ColumnShape[]): LayoutRules {
	const fields = (keep: (column: ColumnShape) => boolean): string[] => columns.filter((column) => typeof column.field === 'string' && keep(column)).map((column) => column.field as string);
	return {
		fixedWidths: fields((column) => typeof column.width === 'number'),
		alwaysVisible: fields((column) => column.rrNoPopup === true),
	};
}

/**
 * One saved column layout (Tabulator's `columns` blob: field, width,
 * visible), as the rules allow it. Anything else is returned as it is.
 *
 * @param blob - The saved blob.
 * @param rules - The grid's rules.
 * @returns The blob it may restore.
 */
export function sanitizeColumnLayout(blob: unknown, rules: LayoutRules): unknown {
	if (!Array.isArray(blob)) return blob;
	return blob.map((entry: unknown) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
		const column = { ...(entry as Record<string, unknown>) };
		const field = typeof column.field === 'string' ? column.field : null;
		const width = column.width;
		if (field === null || !rules.fixedWidths.includes(field) || typeof width !== 'number' || width < MIN_SAVED_WIDTH) delete column.width;
		if (field !== null && rules.alwaysVisible.includes(field)) column.visible = true;
		return column;
	});
}

/**
 * A grid's persistence, with its column layouts guarded both ways.
 *
 * @param inner - The env's grid persistence.
 * @param rules - The grid's rules ({@link layoutRulesFor}).
 * @returns The guarded persistence.
 */
export function guardLayouts(inner: IDataGridPersistence, rules: LayoutRules): IDataGridPersistence {
	return {
		read: (tableId, type) => {
			const stored = inner.read(tableId, type);
			return type === 'columns' ? sanitizeColumnLayout(stored, rules) : stored;
		},
		write: (tableId, type, data) => inner.write(tableId, type, type === 'columns' ? sanitizeColumnLayout(data, rules) : data),
		clear: (tableId) => inner.clear(tableId),
	};
}
