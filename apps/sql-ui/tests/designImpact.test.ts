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
// DESIGNER IMPACT — which declared foreign keys a staged plan disturbs
// =============================================================================
//
// Pure helpers exported by TableDesignView. The component itself is not
// rendered here (the shell is stubbed inert); only the plan analysis is tested.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ISqlSchemaResponse } from '../src/connect';
import type { AlterOp } from '../src/sql/ddl';
import { changedColumns, inboundImpact } from '../src/views/TableDesignView';

// =============================================================================
// FIXTURE
// =============================================================================

/** A shop schema: orders and invoices both reference customers.id. */
const SCHEMA: ISqlSchemaResponse = {
	database: 'shop',
	tables: {
		customers: {
			columns: [{ column: 'id', type: 'INT' }, { column: 'email', type: 'VARCHAR(255)' }],
			primary_key: ['id'],
		},
		orders: {
			columns: [{ column: 'id', type: 'INT' }, { column: 'customer_id', type: 'INT' }],
			foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
		},
		invoices: {
			columns: [{ column: 'id', type: 'INT' }, { column: 'buyer_id', type: 'INT' }],
			foreign_keys: [{ columns: ['buyer_id'], referred_table: 'customers', referred_columns: ['id'] }],
		},
		shipments: {
			columns: [{ column: 'id', type: 'INT' }, { column: 'order_id', type: 'INT' }, { column: 'order_line', type: 'INT' }],
			foreign_keys: [{ columns: ['order_id', 'order_line'], referred_table: 'orders', referred_columns: ['id', 'line'] }],
		},
	},
};

// =============================================================================
// CHANGED COLUMNS
// =============================================================================

describe('changedColumns', () => {
	it('reports drops, renames and retypes, and ignores additions', () => {
		const ops: AlterOp[] = [
			{ kind: 'addColumn', spec: { name: 'note', type: 'TEXT', nullable: true, defaultExpr: '', primaryKey: false } },
			{ kind: 'dropColumn', name: 'email' },
			{ kind: 'changeType', name: 'id', type: 'BIGINT' },
		];
		assert.deepEqual(changedColumns(ops), [
			{ snapshotName: 'email', finalName: 'email', dropped: true },
			{ snapshotName: 'id', finalName: 'id', dropped: false },
		]);
	});

	it('traces a rename-then-retype back to the snapshot name', () => {
		const ops: AlterOp[] = [
			{ kind: 'renameColumn', name: 'id', newName: 'customer_id' },
			{ kind: 'changeType', name: 'customer_id', type: 'BIGINT' },
		];
		assert.deepEqual(changedColumns(ops), [{ snapshotName: 'id', finalName: 'customer_id', dropped: false }]);
	});

	it('keeps a column dropped once the plan drops it', () => {
		const ops: AlterOp[] = [
			{ kind: 'renameColumn', name: 'id', newName: 'old_id' },
			{ kind: 'dropColumn', name: 'old_id' },
		];
		assert.deepEqual(changedColumns(ops), [{ snapshotName: 'id', finalName: 'old_id', dropped: true }]);
	});

	it('returns nothing for an empty plan', () => {
		assert.deepEqual(changedColumns([]), []);
	});
});

// =============================================================================
// INBOUND IMPACT
// =============================================================================

describe('inboundImpact', () => {
	it('names every table that declares a key on the changed column', () => {
		const lines = inboundImpact(SCHEMA, 'customers', [{ kind: 'dropColumn', name: 'id' }]);
		assert.deepEqual(lines, [
			'customers.id is referenced by orders.customer_id (declared foreign key). The database may reject this change or cascade it.',
			'customers.id is referenced by invoices.buyer_id (declared foreign key). The database may reject this change or cascade it.',
		]);
	});

	it('follows a rename back to the referenced snapshot name', () => {
		const lines = inboundImpact(SCHEMA, 'customers', [
			{ kind: 'renameColumn', name: 'id', newName: 'customer_id' },
			{ kind: 'changeType', name: 'customer_id', type: 'BIGINT' },
		]);
		assert.equal(lines.length, 2);
		assert.match(lines[0], /^customers\.id is referenced by orders\.customer_id/);
	});

	it('pairs composite key columns positionally', () => {
		const lines = inboundImpact(SCHEMA, 'orders', [{ kind: 'dropColumn', name: 'line' }]);
		assert.deepEqual(lines, [
			'orders.line is referenced by shipments.order_line (declared foreign key). The database may reject this change or cascade it.',
		]);
	});

	it('says nothing when no declared key points at the changed column', () => {
		assert.deepEqual(inboundImpact(SCHEMA, 'customers', [{ kind: 'dropColumn', name: 'email' }]), []);
		assert.deepEqual(inboundImpact(SCHEMA, 'customers', []), []);
		assert.deepEqual(inboundImpact(null, 'customers', [{ kind: 'dropColumn', name: 'id' }]), []);
	});

	it('ignores added columns — nothing can reference a column that does not exist yet', () => {
		const ops: AlterOp[] = [{ kind: 'addColumn', spec: { name: 'id', type: 'INT', nullable: true, defaultExpr: '', primaryKey: false } }];
		assert.deepEqual(inboundImpact(SCHEMA, 'customers', ops), []);
	});
});
