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
// SQL-UI — FK LABELS (the "→ customers.customer_id" marker for a column)
// =============================================================================

import type { SqlSchemaTable } from '../connect';

/**
 * The foreign-key marker of every column that is part of a declared key.
 *
 * The columns of a composite key are paired with the referenced columns by
 * position. A column that belongs to several keys lists every target. A column
 * the key names without a matching target gets no marker rather than a guess.
 *
 * @param def - The table's reflected schema (null = no definition).
 * @returns Column name to label, e.g. `→ customers.customer_id`.
 */
export function fkLabelsByColumn(def: SqlSchemaTable | null): Map<string, string> {
	const targets = new Map<string, string[]>();
	for (const fk of def?.foreign_keys ?? []) {
		fk.columns.forEach((column, index) => {
			const referred = fk.referred_columns[index];
			if (referred === undefined) return;
			targets.set(column, [...(targets.get(column) ?? []), `${fk.referred_table}.${referred}`]);
		});
	}
	return new Map([...targets].map(([column, list]) => [column, `→ ${list.join(', ')}`]));
}
