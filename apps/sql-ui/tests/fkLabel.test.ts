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
// FK LABELS — the "→ customers.customer_id" marker in the table drawer
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlSchemaTable } from '../src/connect';
import { fkLabelsByColumn } from '../src/schema/fkLabel';

const col = (column: string): { column: string; type: string } => ({ column, type: 'integer' });

describe('fkLabelsByColumn', () => {
	it('labels a single-column key with its target', () => {
		const orders: SqlSchemaTable = {
			columns: [col('order_id'), col('customer_id')],
			primary_key: ['order_id'],
			foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['customer_id'] }],
		};
		assert.deepEqual([...fkLabelsByColumn(orders)], [['customer_id', '→ customers.customer_id']]);
	});

	it('pairs the columns of a composite key by position', () => {
		const lines: SqlSchemaTable = {
			columns: [col('a'), col('b')],
			foreign_keys: [{ columns: ['a', 'b'], referred_table: 'parent', referred_columns: ['x', 'y'] }],
		};
		assert.deepEqual([...fkLabelsByColumn(lines)], [['a', '→ parent.x'], ['b', '→ parent.y']]);
	});

	it('lists every target when a column is in several keys', () => {
		const t: SqlSchemaTable = {
			columns: [col('a')],
			foreign_keys: [
				{ columns: ['a'], referred_table: 'p', referred_columns: ['id'] },
				{ columns: ['a'], referred_table: 'q', referred_columns: ['id'] },
			],
		};
		assert.equal(fkLabelsByColumn(t).get('a'), '→ p.id, q.id');
	});

	it('is empty for a table with no keys, or no definition', () => {
		assert.equal(fkLabelsByColumn({ columns: [col('a')] }).size, 0);
		assert.equal(fkLabelsByColumn(null).size, 0);
	});

	it('skips a column the key lists without a matching target', () => {
		const t: SqlSchemaTable = {
			columns: [col('a'), col('b')],
			foreign_keys: [{ columns: ['a', 'b'], referred_table: 'p', referred_columns: ['x'] }],
		};
		assert.deepEqual([...fkLabelsByColumn(t)], [['a', '→ p.x']]);
	});
});
