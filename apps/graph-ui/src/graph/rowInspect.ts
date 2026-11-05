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
// GRAPH - TABLE ROW INSPECTOR (one result row, in full, positional)
// =============================================================================
//
// What the shared row inspector shows for a clicked Table row: every cell in COLUMN
// ORDER, labelled with its column name (a duplicate name appears twice, because rows
// are positional arrays), each value in full and exact, and Copy-as-JSON that keeps
// the columns beside the cells. Nothing is looked up by column name.
// =============================================================================

import { toJsonText, valueText } from './values';

/** One cell of the row. */
export interface IRowField {
	label: string;
	value: string;
	copyText: string;
}

/** What the row inspector shows. */
export interface IRowView {
	fields: IRowField[];
	json: string;
	note: string;
}

/**
 * The inspector content of one row.
 *
 * @param columns - The result's column names.
 * @param row - The row's cells, in column order.
 * @returns Fields, JSON text and the note.
 */
export function inspectorTextOfRow(columns: readonly string[], row: readonly unknown[]): IRowView {
	return {
		fields: columns.map((name, i) => ({ label: name === '' ? `(column ${i + 1})` : name, value: valueText(row[i]), copyText: valueText(row[i]) })),
		json: toJsonText({ columns, row }, 2),
		note: 'Values are shown exactly as the node sent them: an integer beyond 2^53 is shown as its full text, never rounded.',
	};
}
