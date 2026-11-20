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
// SQL-UI — CELL INSPECTOR (one result row, in full, in a drawer)
// =============================================================================
//
// The drawer is shared (shared/explorer/components/RowInspector); this gives it
// SQL's row and SQL's note. A grid cell truncates; the drawer shows one row's
// values whole, with a copy affordance per value. It also states the one thing
// a result grid cannot show: the node converts `Decimal` to a float before the
// value ever reaches the browser (db_instance_base._sanitize_value), and
// integers beyond 2^53 cannot survive JSON either — so a displayed number is
// not always the number the database holds.
//
// Port of 4c584a214.
// =============================================================================

import React from 'react';
import { RowInspector } from 'shared/explorer/components/RowInspector';
import { announce } from '../a11y/announce';

/** Props for the {@link CellInspector} component. */
export interface CellInspectorProps {
	/** Whether the drawer is open. */
	open: boolean;
	/** The row to inspect (null renders nothing). */
	row: Record<string, unknown> | null;
	/** One-based position of this row in the displayed result. */
	rowNumber: number;
	/** Total rows in the displayed result. */
	rowCount: number;
	/** Drawer subtitle, e.g. `statement 2 · executed 14:02`. */
	subtitle: string;
	/** Fired when the drawer is dismissed. */
	onClose: () => void;
}

/** What a row of SQL values loses on the way to the browser. */
const NOTE = 'Values as received: decimals arrive as floating point; integers above 2^53 may be rounded.';

/**
 * The row inspector drawer.
 *
 * @param props - {@link CellInspectorProps}.
 * @returns The drawer element, or null when there is no row.
 */
export const CellInspector: React.FC<CellInspectorProps> = ({ open, row, rowNumber, rowCount, subtitle, onClose }) => {
	if (!row) return null;
	return (
		<RowInspector
			open={open}
			onClose={onClose}
			title={`Row ${rowNumber} of ${rowCount.toLocaleString()}`}
			subtitle={subtitle}
			fields={Object.keys(row).map((column) => ({ label: column, value: row[column] }))}
			json={JSON.stringify(row, null, '\t')}
			note={NOTE}
			announce={announce}
		/>
	);
};

export default CellInspector;
