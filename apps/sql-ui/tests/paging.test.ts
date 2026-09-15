// MIT License
//
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
// SQL PAGING — unit tests for the data browser's statement builders
// =============================================================================
//
// The filter/search assertions are the regression contract for the numeric
// passthrough documented in the architecture audit (§D.4): every value the
// user typed is DATA and must ride as a bound `$n` parameter, never as an
// inlined literal.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IDataGridPageRequest } from 'shell';
import type { ISqlSchemaTable } from '../src/connect';
import { buildPageStatements, quoteIdent } from '../src/sql/paging';

// =============================================================================
// FIXTURES
// =============================================================================

/** A table with one text column, one numeric column, and a primary key. */
const TABLE: ISqlSchemaTable = {
	columns: [
		{ column: 'id', type: 'BIGINT' },
		{ column: 'code', type: 'VARCHAR(32)' },
		{ column: 'note', type: 'TEXT' },
	],
	primary_key: ['id'],
};

/** The same table without a primary key (ORDER BY has nothing to fall back to). */
const TABLE_NO_PK: ISqlSchemaTable = { columns: TABLE.columns };

/**
 * Build a page request with the given overrides over a page-1 default.
 *
 * @param over - Fields to override.
 * @returns The page request.
 */
function req(over: Partial<IDataGridPageRequest> = {}): IDataGridPageRequest {
	return { page: 1, size: 50, sort: [], filters: {}, ...over };
}

// =============================================================================
// QUOTE IDENT
// =============================================================================

describe('quoteIdent', () => {
	it('backticks identifiers for MySQL and ClickHouse', () => {
		assert.equal(quoteIdent('mysql', 'orders'), '`orders`');
		assert.equal(quoteIdent('clickhouse', 'orders'), '`orders`');
	});

	it('double-quotes identifiers for Postgres and unknown engines', () => {
		assert.equal(quoteIdent('postgres', 'orders'), '"orders"');
		assert.equal(quoteIdent('unknown', 'orders'), '"orders"');
	});

	it('escapes the quote character by doubling it', () => {
		assert.equal(quoteIdent('mysql', 'we`ird'), '`we``ird`');
		assert.equal(quoteIdent('postgres', 'we"ird'), '"we""ird"');
	});
});

// =============================================================================
// PAGING — ORDER BY AND OFFSET
// =============================================================================

describe('buildPageStatements order and offset', () => {
	it('orders by the grid sorters when the grid sent any', () => {
		const { select } = buildPageStatements('postgres', 'orders', TABLE, req({ sort: [{ field: 'code', dir: 'desc' }] }));
		assert.equal(select, 'SELECT * FROM "orders" ORDER BY "code" DESC LIMIT 50 OFFSET 0');
	});

	it('falls back to the primary key when the grid sent no sorters', () => {
		const { select } = buildPageStatements('mysql', 'orders', TABLE, req());
		assert.equal(select, 'SELECT * FROM `orders` ORDER BY `id` ASC LIMIT 50 OFFSET 0');
	});

	it('emits no ORDER BY at all when the table has no primary key and no sort', () => {
		const { select } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req());
		assert.equal(select, 'SELECT * FROM "orders" LIMIT 50 OFFSET 0');
	});

	it('computes OFFSET from the 1-based page number', () => {
		const { select } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ page: 3, size: 25 }));
		assert.match(select, /LIMIT 25 OFFSET 50$/);
	});
});

// =============================================================================
// PAGING — VALUES ARE BOUND, NEVER INLINED
// =============================================================================

describe('buildPageStatements binds every user value', () => {
	it('binds the free-text search term across the text columns', () => {
		const { select, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ search: "o'brien" }));
		assert.equal(select, 'SELECT * FROM "orders" WHERE ("code" LIKE $1 OR "note" LIKE $1) LIMIT 50 OFFSET 0');
		assert.deepEqual(params, ["%o'brien%"]);
	});

	it('binds a numeric-looking range bound instead of inlining it as a number', () => {
		// The audit's §D.4 bug: `code >= 0100` on a VARCHAR column coerces the
		// column to a number on MySQL and is a type error on Postgres.
		const { select, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ filters: { code__gte: '0100' } }));
		assert.equal(select, 'SELECT * FROM "orders" WHERE "code" >= $1 LIMIT 50 OFFSET 0');
		assert.deepEqual(params, ['0100']);
	});

	it('binds the upper range bound with the <= operator', () => {
		const { select, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ filters: { code__lte: '42' } }));
		assert.equal(select, 'SELECT * FROM "orders" WHERE "code" <= $1 LIMIT 50 OFFSET 0');
		assert.deepEqual(params, ['42']);
	});

	it('binds every member of an IN list', () => {
		const { select, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ filters: { code: ['1', 'two'] } }));
		assert.equal(select, 'SELECT * FROM "orders" WHERE "code" IN ($1, $2) LIMIT 50 OFFSET 0');
		assert.deepEqual(params, ['1', 'two']);
	});

	it('drops an empty IN list rather than emitting IN ()', () => {
		const { select, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ filters: { code: [] } }));
		assert.equal(select, 'SELECT * FROM "orders" LIMIT 50 OFFSET 0');
		assert.deepEqual(params, []);
	});

	it('binds a contains filter as a LIKE pattern value', () => {
		// The `%` wrapping MUST be part of the bound value: the server rewrites
		// `$n` textually, so a pattern built around an inlined value would put
		// the placeholder inside a string literal.
		const { select, params } = buildPageStatements('mysql', 'orders', TABLE_NO_PK, req({ filters: { code: '7' } }));
		assert.equal(select, 'SELECT * FROM `orders` WHERE `code` LIKE $1 LIMIT 50 OFFSET 0');
		assert.deepEqual(params, ['%7%']);
	});

	it('numbers placeholders sequentially across search and filters', () => {
		const { select, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({
			search: 'ab',
			filters: { code: ['x', 'y'], note: 'z' },
		}));
		assert.equal(
			select,
			'SELECT * FROM "orders" WHERE ("code" LIKE $1 OR "note" LIKE $1) AND "code" IN ($2, $3) AND "note" LIKE $4 LIMIT 50 OFFSET 0',
		);
		assert.deepEqual(params, ['%ab%', 'x', 'y', '%z%']);
	});

	it('omits the search clause when no column is text-typed', () => {
		const numeric: ISqlSchemaTable = { columns: [{ column: 'id', type: 'BIGINT' }] };
		const { select, params } = buildPageStatements('postgres', 'orders', numeric, req({ search: 'ab' }));
		assert.equal(select, 'SELECT * FROM "orders" LIMIT 50 OFFSET 0');
		assert.deepEqual(params, []);
	});
});

// =============================================================================
// PAGING — THE COUNT STATEMENT
// =============================================================================

describe('buildPageStatements count', () => {
	it('counts over the same WHERE and reuses the same bound parameters', () => {
		const { count, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ filters: { code: 'x' } }));
		assert.equal(count, 'SELECT COUNT(*) AS total FROM "orders" WHERE "code" LIKE $1');
		assert.deepEqual(params, ['%x%']);
	});

	it('carries no ORDER BY, LIMIT, or OFFSET', () => {
		const { count } = buildPageStatements('postgres', 'orders', TABLE, req({ page: 4, sort: [{ field: 'id', dir: 'asc' }] }));
		assert.equal(count, 'SELECT COUNT(*) AS total FROM "orders"');
	});
});
