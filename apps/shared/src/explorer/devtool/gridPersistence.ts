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
// EXPLORER DEV TOOL — GRID LAYOUTS: never hand Tabulator a stored object
// =============================================================================
//
// A shell DataGrid with a `tableId` and no `persistence` prop persists its
// layout (Tabulator's sort, columns and page blobs, and DataGrid's own display
// and format blobs) through the grid config channel, which the HOST answers
// from the active app's workspace prefs. The host answers a read with the
// stored blob BY REFERENCE, and Tabulator's sort module rewrites a persisted
// sorter list in place, swapping each field name for its live column object
// (its table, DOM elements, functions). That list is the workspace store's own
// object, so the column now sits in the prefs until a sort write replaces it,
// and the web host's bridge merges each write over the prefs it saw at its
// last render, so a write of another blob in the same pass (a columns save
// after the layout) keeps the rewritten list, and can even undo a sort write.
// On #2625 9bd5d931f the next workspace save sends the prefs through the SDK's
// message redaction walk, which never finishes on a column: the page freezes.
// A remount reads the blob again, so a page switch, a re-run or a reload is
// enough once a sort is stored.
//
// Both factories here hand Tabulator COPIES (plain JSON) and store copies, so
// nothing Tabulator does to what it read can reach what is stored, and a blob
// that is not plain JSON is not stored at all:
//   - createSessionGridPersistence: a dev-tool frame. Its active app is the
//     host (Rocket Builder), and store tools get no prefs of their own
//     (§3.5), so frames keep layouts in memory, one store per realm. In
//     Rocket Builder every document shares the page's realm, so layouts last
//     until the page reloads; in VS Code each document is its own panel and
//     realm, so they last as long as that panel.
//   - createCopyingGridPersistence: a full app, over the shell's own channel
//     (`createMessageGridPersistence` from 'shell', passed in: this library
//     imports no 'shell' values here). Layouts stay in the app's own prefs.
// =============================================================================

import type { DataGridLayout, IDataGridPersistence } from 'shell';

/**
 * A plain-JSON copy of a value, or undefined when it has none (a cycle).
 *
 * @param value - The value.
 * @returns The copy.
 */
function jsonCopy(value: unknown): unknown {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Wrap a grid persistence so that it only ever stores and hands out plain-JSON
 * copies (see the header). A read of nothing stays false.
 *
 * The wrapped persistence is made on first use, once, the way DataGrid makes
 * its own default, so building an env never touches the shell.
 *
 * @param makeInner - Makes the persistence that stores the layouts (a full
 *   app: the shell's `createMessageGridPersistence`).
 * @returns The wrapped persistence.
 */
export function createCopyingGridPersistence(makeInner: () => IDataGridPersistence): IDataGridPersistence {
	let made: IDataGridPersistence | null = null;
	const inner = (): IDataGridPersistence => (made ??= makeInner());
	return {
		read(tableId, type) {
			const stored = inner().read(tableId, type);
			return stored === false ? false : (jsonCopy(stored) ?? false);
		},
		write(tableId, type, data) {
			const copy = jsonCopy(data);
			if (copy !== undefined) inner().write(tableId, type, copy);
		},
		clear(tableId) {
			inner().clear(tableId);
		},
	};
}

/**
 * A DataGrid persistence for dev-tool frames: in memory for the session,
 * copies in and out (see the header).
 *
 * @returns The persistence; share one per realm.
 */
export function createSessionGridPersistence(): IDataGridPersistence {
	const layouts = new Map<string, DataGridLayout>();
	return createCopyingGridPersistence(() => ({
		read(tableId, type) {
			const layout = layouts.get(tableId);
			return layout && type in layout ? layout[type] : false;
		},
		write(tableId, type, data) {
			layouts.set(tableId, { ...layouts.get(tableId), [type]: data });
		},
		clear(tableId) {
			layouts.delete(tableId);
		},
	}));
}
