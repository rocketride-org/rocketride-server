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
// GRAPH - GRID LAYOUTS (what a saved layout may restore)
// =============================================================================
//
// Ported from SQL Explorer (sql-ui/src/sql/gridLayout.ts, #2864). Every grid lays
// out with fitColumns, and the shell saves each column's CURRENT width, flexible
// columns included. A result grid built inside a hidden tab (a result usually lands
// while another tab is showing) measures a 0-wide container, crushes its flexible
// columns to Tabulator's 40 px minimum, and saves that; every later open restores
// 40 px as a FIXED width that no resize or redraw undoes. The results key is a tab
// id plus a counter that restarts with the surface, so the same key comes back after
// a reload.
//
// So the results grid's persistence goes through this guard, which reads and writes a
// column layout with:
//
//   - no width for a column the code leaves flexible (every result column: they
//     always fill, and a width a user drags is not kept, the trade for never
//     freezing a crushed one);
//   - no width under MIN_SAVED_WIDTH for a column the code sizes;
//   - every column a user cannot hide visible.
//
// A stored layout is healed as it is read, and sort, page size, display and format
// pass through untouched.
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

// =============================================================================
// SESSION-ONLY RESULT LAYOUTS
// =============================================================================
//
// A result grid's key is the connection, the tab id and a result counter that restarts at 1 on every page load, so a
// stored sort or hidden column would come back, after a reload, on whatever result is first in that tab: a Table that
// disagrees with the statement's own ORDER BY and with the export. So the results grid keeps its sort and shown
// columns for the page session only, in this store, and never in the env's persistence (prefs or the host's files).

/** The page session's layouts, by `tableId/type`. Held as JSON text: the grid writes keys into any object it is handed. */
const SESSION = new Map<string, string>();

/**
 * Layouts kept in memory for the life of the page.
 *
 * @returns A persistence whose reads and writes never leave this page.
 */
export function createSessionLayouts(): IDataGridPersistence {
	return {
		read: (tableId, type) => {
			const text = SESSION.get(`${tableId}/${type}`);
			return text === undefined ? false : (JSON.parse(text) as unknown);
		},
		write: (tableId, type, data) => {
			const text = JSON.stringify(data);
			if (text !== undefined) SESSION.set(`${tableId}/${type}`, text);
		},
		clear: (tableId) => {
			for (const key of [...SESSION.keys()]) if (key.startsWith(`${tableId}/`)) SESSION.delete(key);
		},
	};
}

/** The one session store the results grid uses. */
export const RESULT_LAYOUTS: IDataGridPersistence = createSessionLayouts();

/** Mounts so far in this page, for {@link nextMountNonce}. */
let mounts = 0;

/**
 * A number no other mount of a results Table in this page has had.
 *
 * @returns The next nonce.
 */
export function nextMountNonce(): number {
	mounts += 1;
	return mounts;
}

/**
 * A short signature of a result's column names, so a layout is never applied to a result with other columns.
 *
 * @param columns - The result's column names, in order.
 * @returns Eight hex digits.
 */
export function columnSignature(columns: readonly string[]): string {
	let hash = 5381;
	for (const ch of `${columns.length}\u0001${columns.join('\u0001')}`) hash = ((hash * 33) ^ (ch.codePointAt(0) ?? 0)) >>> 0;
	return hash.toString(16).padStart(8, '0');
}

/**
 * The key a results grid keeps its layout under. A tab id and a result counter both restart when a workbench is opened
 * again in the same page, so the key also carries this mount's nonce and the result's column signature: a layout is
 * only ever applied to the result it was made on.
 *
 * @param tableKey - The connection, tab and result counter (the caller's own key).
 * @param nonce - This mount's {@link nextMountNonce}.
 * @param columns - The result's column names.
 * @returns The grid's `tableId`.
 */
export function resultLayoutKey(tableKey: string, nonce: number, columns: readonly string[]): string {
	return `graph-results-${tableKey}-m${nonce}-${columnSignature(columns)}`;
}
