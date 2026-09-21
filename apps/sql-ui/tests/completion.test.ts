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
// SQL COMPLETION — unit tests for the schema-aware suggestion model
// =============================================================================
//
// Covers the UX spec's AC2.1 (alias-scoped columns first), AC2.2 (tables first
// after JOIN) and AC2.5 (a JOIN snippet prefilled from a DECLARED foreign key
// — never from a name that merely looks like one).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ISqlSchemaResponse } from '../src/connect';
import type { ICompletionCandidate } from '../src/sql/completion';
import { buildCompletionModel, resolveAliases, suggestAt } from '../src/sql/completion';

// =============================================================================
// FIXTURES
// =============================================================================

/** Two tables joined by one declared foreign key, plus an awkward table name. */
const SCHEMA: ISqlSchemaResponse = {
	database: 'sample_shop',
	tables: {
		orders: {
			columns: [
				{ column: 'id', type: 'BIGINT' },
				{ column: 'customer_id', type: 'BIGINT' },
				{ column: 'total', type: 'DECIMAL(10,2)' },
			],
			primary_key: ['id'],
			foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
		},
		customers: {
			columns: [
				{ column: 'id', type: 'BIGINT' },
				{ column: 'name', type: 'VARCHAR(64)' },
			],
			primary_key: ['id'],
		},
		'order details': {
			columns: [{ column: 'line no', type: 'INT' }],
		},
	},
};

const MODEL = buildCompletionModel(SCHEMA, Date.parse('2026-09-14T14:02:00Z'));

/**
 * Labels of the candidates, in the order the sort text puts them.
 *
 * @param candidates - The candidates to order.
 * @returns The labels, sorted by sortText.
 */
function ordered(candidates: ICompletionCandidate[]): string[] {
	return [...candidates].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((c) => c.label);
}

/**
 * Find one candidate by label.
 *
 * @param candidates - The candidates to search.
 * @param label - The label to find.
 * @returns The candidate, or undefined.
 */
function byLabel(candidates: ICompletionCandidate[], label: string): ICompletionCandidate | undefined {
	return candidates.find((c) => c.label === label);
}

// =============================================================================
// MODEL
// =============================================================================

describe('buildCompletionModel', () => {
	it('lists every table', () => {
		assert.deepEqual(MODEL.tables, ['orders', 'customers', 'order details']);
	});

	it('keeps each table its columns', () => {
		assert.deepEqual(MODEL.columnsByTable.customers.map((c) => c.column), ['id', 'name']);
	});

	it('collects declared foreign keys only', () => {
		assert.deepEqual(MODEL.foreignKeys, [
			{ fromTable: 'orders', fromColumns: ['customer_id'], toTable: 'customers', toColumns: ['id'] },
		]);
	});

	it('dates the snapshot and does not promise Refresh will re-read it', () => {
		// A node without the refresh_schema tool serves its task-start
		// reflection however often Refresh is pressed, so the hint must not
		// say "Refresh schema on the connection page" as if that fixed it.
		assert.match(MODEL.snapshotNote, /The snapshot dates from \d{2}:\d{2}/);
		assert.match(MODEL.snapshotNote, /only on nodes with refresh_schema/);
	});

	it('tolerates a null schema', () => {
		const empty = buildCompletionModel(null);
		assert.deepEqual(empty.tables, []);
		assert.deepEqual(empty.foreignKeys, []);
	});

	it('tolerates a schema that failed to reflect', () => {
		assert.deepEqual(buildCompletionModel({ error: 'nope' }).tables, []);
	});
});

// =============================================================================
// ALIASES
// =============================================================================

describe('resolveAliases', () => {
	it('maps an alias to its table', () => {
		assert.equal(resolveAliases('SELECT * FROM orders o').o, 'orders');
	});

	it('maps an AS alias', () => {
		assert.equal(resolveAliases('SELECT * FROM orders AS ord').ord, 'orders');
	});

	it('maps a joined table', () => {
		const aliases = resolveAliases('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id');
		assert.equal(aliases.c, 'customers');
	});

	it('maps a table with no alias to itself', () => {
		assert.equal(resolveAliases('SELECT * FROM orders').orders, 'orders');
	});

	it('does not take a following keyword as an alias', () => {
		const aliases = resolveAliases('SELECT * FROM orders WHERE id = 1');
		assert.equal(aliases.where, undefined);
		assert.equal(aliases.orders, 'orders');
	});

	it('does not take JOIN as an alias', () => {
		assert.equal(resolveAliases('SELECT * FROM orders JOIN customers').join, undefined);
	});

	it('reads an UPDATE target', () => {
		assert.equal(resolveAliases('UPDATE orders SET total = 1').orders, 'orders');
	});

	it('reads an INSERT INTO target', () => {
		assert.equal(resolveAliases('INSERT INTO orders (id) VALUES (1)').orders, 'orders');
	});
});

// =============================================================================
// SUGGESTIONS
// =============================================================================

describe('suggestAt', () => {
	it('AC2.1 — alias-scoped columns come first and are the only group', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM orders o WHERE o.', 'mysql');
		assert.deepEqual(ordered(out), ['id', 'customer_id', 'total']);
		assert.ok(out.every((c) => c.sortText.startsWith('0_')));
		assert.ok(out.every((c) => c.kind === 'column'));
	});

	it('AC2.1 — resolves an alias declared after the cursor', () => {
		const out = suggestAt(MODEL, 'SELECT o.', 'mysql', ' FROM orders o');
		assert.deepEqual(ordered(out), ['id', 'customer_id', 'total']);
	});

	it('scopes by a bare table name too', () => {
		assert.deepEqual(ordered(suggestAt(MODEL, 'SELECT customers.', 'mysql')), ['id', 'name']);
	});

	it('keeps the partial word out of the qualifier lookup', () => {
		assert.deepEqual(ordered(suggestAt(MODEL, 'SELECT * FROM orders o WHERE o.cu', 'mysql')), ['id', 'customer_id', 'total']);
	});

	it('suggests nothing for a qualifier it cannot resolve', () => {
		assert.deepEqual(suggestAt(MODEL, 'SELECT zz.', 'mysql'), []);
	});

	it('names the column type in the detail', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM orders o WHERE o.', 'mysql');
		assert.equal(byLabel(out, 'total')?.detail, 'orders · DECIMAL(10,2)');
	});

	it('AC2.2 — tables come first after JOIN', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM orders o JOIN ', 'mysql');
		const first = ordered(out)[0];
		assert.ok(out.some((c) => c.kind === 'table'));
		assert.ok(out.filter((c) => c.kind === 'table').every((c) => c.sortText.startsWith('1_')));
		assert.ok(first === 'customers' || first.startsWith('customers c ON'));
	});

	it('offers tables after FROM', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM ', 'mysql');
		assert.ok(out.filter((c) => c.kind === 'table').every((c) => c.sortText.startsWith('1_')));
		assert.ok(out.some((c) => c.label === 'orders'));
	});

	it('offers tables after a partially typed name', () => {
		assert.ok(suggestAt(MODEL, 'SELECT * FROM ord', 'mysql').some((c) => c.label === 'orders'));
	});

	it('offers tables after UPDATE and after INSERT INTO', () => {
		assert.ok(suggestAt(MODEL, 'UPDATE ', 'mysql').some((c) => c.label === 'orders'));
		assert.ok(suggestAt(MODEL, 'INSERT INTO ', 'mysql').some((c) => c.label === 'orders'));
	});

	it('is not in a table position once the name is finished', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM orders ', 'mysql');
		assert.equal(out.filter((c) => c.kind === 'table' && c.sortText.startsWith('1_')).length, 0);
	});

	it('offers the mentioned tables columns at group 2', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM orders o WHERE ', 'mysql');
		const columns = out.filter((c) => c.kind === 'column');
		assert.ok(columns.length > 0);
		assert.ok(columns.every((c) => c.sortText.startsWith('2_')));
		assert.deepEqual(columns.map((c) => c.label), ['id', 'customer_id', 'total']);
	});

	it('offers every table at group 2 when none is mentioned yet', () => {
		const out = suggestAt(MODEL, 'SELECT ', 'mysql');
		const tables = out.filter((c) => c.kind === 'table');
		assert.ok(tables.every((c) => c.sortText.startsWith('2_')));
		assert.equal(tables.length, 3);
	});

	it('always offers the keyword snippets last', () => {
		const out = suggestAt(MODEL, 'SELECT ', 'mysql');
		const snippets = out.filter((c) => c.kind === 'snippet');
		assert.ok(snippets.length >= 5);
		assert.ok(snippets.every((c) => c.sortText.startsWith('3_')));
		assert.ok(snippets.some((c) => c.label === 'SELECT … FROM'));
	});

	it('AC2.5 — JOIN prefilled from the declared foreign key', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM orders o JOIN ', 'mysql');
		const candidate = byLabel(out, 'customers c ON c.id = o.customer_id');
		assert.ok(candidate, 'expected a FK-derived join candidate');
		assert.equal(candidate.insertText, 'customers c ON c.id = o.customer_id');
		assert.equal(candidate.detail, 'FK orders.customer_id -> customers.id');
		assert.ok(candidate.sortText < '1_1');
	});

	it('AC2.5 — the same foreign key read from the other side', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM customers c JOIN ', 'mysql');
		const candidate = byLabel(out, 'orders o ON o.customer_id = c.id');
		assert.ok(candidate, 'expected the reverse FK-derived join candidate');
		assert.equal(candidate.detail, 'FK orders.customer_id -> customers.id');
	});

	it('offers no FK join when the mentioned table has no declared key', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM `order details` d JOIN ', 'mysql');
		assert.equal(out.filter((c) => c.detail.startsWith('FK ')).length, 0);
	});

	it('quotes an awkward table name in the insert text only', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM ', 'mysql');
		const candidate = byLabel(out, 'order details');
		assert.equal(candidate?.insertText, '`order details`');
	});

	it('quotes for the dialect', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM ', 'postgres');
		assert.equal(byLabel(out, 'order details')?.insertText, '"order details"');
	});

	it('leaves a plain name unquoted', () => {
		assert.equal(byLabel(suggestAt(MODEL, 'SELECT * FROM ', 'mysql'), 'orders')?.insertText, 'orders');
	});

	it('names the column count in a table detail', () => {
		assert.equal(byLabel(suggestAt(MODEL, 'SELECT * FROM ', 'mysql'), 'customers')?.detail, 'customers · 2 columns');
	});

	it('documents the snapshot on the first item of each group', () => {
		const out = suggestAt(MODEL, 'SELECT * FROM ', 'mysql');
		assert.match(out.find((c) => c.kind === 'table')?.documentation ?? '', /The snapshot dates from/);
	});

	it('falls back to snippets alone when the snapshot is empty', () => {
		const out = suggestAt(buildCompletionModel(null), 'SELECT * FROM ', 'mysql');
		assert.ok(out.length > 0);
		assert.ok(out.every((c) => c.kind === 'snippet'));
	});
});
