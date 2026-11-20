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
import type { SqlSchemaTable } from '../src/connect';
import { buildPageStatements, countKey, quoteIdent } from '../src/sql/paging';

// =============================================================================
// FIXTURES
// =============================================================================

/** A table with one text column, one numeric column, and a primary key. */
const TABLE: SqlSchemaTable = {
	columns: [
		{ column: 'id', type: 'BIGINT' },
		{ column: 'code', type: 'VARCHAR(32)' },
		{ column: 'note', type: 'TEXT' },
	],
	primary_key: ['id'],
};

/** The same table without a primary key (ORDER BY has nothing to fall back to). */
const TABLE_NO_PK: SqlSchemaTable = { columns: TABLE.columns };

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

	// DA-R1 M6: ClickHouse's lexer honours backslash escapes inside a backtick
	// identifier, so a name ending in `\` escaped the closing backtick and the
	// rest of the statement became part of the name. MySQL and PostgreSQL
	// read a backslash in an identifier as itself.
	it('escapes a backslash for ClickHouse, and only for ClickHouse', () => {
		assert.equal(quoteIdent('clickhouse', 'a\\'), '`a\\\\`');
		assert.equal(quoteIdent('clickhouse', 'a\\`b'), '`a\\\\``b`');
		assert.equal(quoteIdent('mysql', 'a\\'), '`a\\`');
		assert.equal(quoteIdent('postgres', 'a\\'), '"a\\"');
	});

	it('a ClickHouse identifier always ends at its own closing backtick and reads back as the name', () => {
		for (const name of ['orders', 'a\\', '\\', '\\\\', 'we`ird', 'a\\`', '`\\', 'x\\` OR 1=1 --', 'tab\\tname']) {
			const quoted = quoteIdent('clickhouse', name);
			const read = readClickHouseBacktick(quoted);
			assert.equal(read.end, quoted.length, `${JSON.stringify(name)}: the identifier ends where the quoting does`);
			assert.equal(read.name, name, `${JSON.stringify(name)}: and is the same name`);
		}
	});

	it('every statement the data browser builds quotes ClickHouse names this way', () => {
		const hostile: SqlSchemaTable = { columns: [{ column: 'c\\', type: 'String' }], primary_key: ['c\\'] };
		const statements = buildPageStatements('clickhouse', 't\\', hostile, req({ filters: { 'c\\': 'x' } }), { chips: [{ column: 'c\\', op: 'eq', value: 'y' }] });
		assert.ok(statements.select.startsWith('SELECT * FROM `t\\\\` WHERE '), statements.select);
		assert.ok(!/[^\\]\\`/.test(statements.select.replace(/\\\\/g, '')), `no backtick left escaped: ${statements.select}`);
		assert.match(statements.select, /ORDER BY `c\\\\` ASC/);
		assert.match(statements.count, /^SELECT COUNT\(\*\) AS total FROM `t\\\\`/);
	});
});

/**
 * Read one backtick-quoted identifier the way ClickHouse's lexer does
 * (src/Parsers/Lexer.cpp `quotedString`, readBackQuotedStringWithSQLStyle):
 * a backslash escapes the next character, a doubled backtick is a backtick,
 * and a single backtick ends it.
 *
 * @param text - Text starting with the opening backtick.
 * @returns The decoded name and the index just past the closing backtick.
 */
function readClickHouseBacktick(text: string): { name: string; end: number } {
	assert.equal(text[0], '`');
	let name = '';
	let at = 1;
	while (at < text.length) {
		const ch = text[at] as string;
		if (ch === '\\') {
			const next = text[at + 1] as string;
			name += next === 't' ? '\t' : next;
			at += 2;
		} else if (ch === '`') {
			if (text[at + 1] === '`') {
				name += '`';
				at += 2;
			} else {
				return { name, end: at + 1 };
			}
		} else {
			name += ch;
			at += 1;
		}
	}
	return { name, end: -1 };
}

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
		assert.equal(select, 'SELECT * FROM "orders" WHERE ("code"::text ILIKE $1 OR "note"::text ILIKE $1) LIMIT 50 OFFSET 0');
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
		assert.equal(select, 'SELECT * FROM `orders` WHERE LOWER(`code`) LIKE LOWER($1) LIMIT 50 OFFSET 0');
		assert.deepEqual(params, ['%7%']);
	});

	it('numbers placeholders sequentially across search and filters', () => {
		const { select, params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({
			search: 'ab',
			filters: { code: ['x', 'y'], note: 'z' },
		}));
		assert.equal(
			select,
			'SELECT * FROM "orders" WHERE ("code"::text ILIKE $1 OR "note"::text ILIKE $1) AND "code" IN ($2, $3) AND "note"::text ILIKE $4 LIMIT 50 OFFSET 0',
		);
		assert.deepEqual(params, ['%ab%', 'x', 'y', '%z%']);
	});

	it('omits the search clause when no column is text-typed', () => {
		const numeric: SqlSchemaTable = { columns: [{ column: 'id', type: 'BIGINT' }] };
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
		assert.equal(count, 'SELECT COUNT(*) AS total FROM "orders" WHERE "code"::text ILIKE $1');
		assert.deepEqual(params, ['%x%']);
	});

	it('carries no ORDER BY, LIMIT, or OFFSET', () => {
		const { count } = buildPageStatements('postgres', 'orders', TABLE, req({ page: 4, sort: [{ field: 'id', dir: 'asc' }] }));
		assert.equal(count, 'SELECT COUNT(*) AS total FROM "orders"');
	});
});

// =============================================================================
// PAGING — CASE-INSENSITIVE SEARCH PER DIALECT
// =============================================================================

describe('buildPageStatements search per dialect', () => {
	it('searches with LOWER() LIKE LOWER() on MySQL', () => {
		const { select } = buildPageStatements('mysql', 'orders', TABLE_NO_PK, req({ search: 'ab' }));
		assert.equal(select, 'SELECT * FROM `orders` WHERE (LOWER(`code`) LIKE LOWER($1) OR LOWER(`note`) LIKE LOWER($1)) LIMIT 50 OFFSET 0');
	});

	it('searches with toString() ILIKE on ClickHouse', () => {
		const { select } = buildPageStatements('clickhouse', 'orders', TABLE_NO_PK, req({ search: 'ab' }));
		assert.equal(select, 'SELECT * FROM `orders` WHERE (toString(`code`) ILIKE $1 OR toString(`note`) ILIKE $1) LIMIT 50 OFFSET 0');
	});

	it('keeps a plain LIKE on an unknown dialect', () => {
		const { select } = buildPageStatements('unknown', 'orders', TABLE_NO_PK, req({ search: 'ab' }));
		assert.equal(select, 'SELECT * FROM "orders" WHERE ("code" LIKE $1 OR "note" LIKE $1) LIMIT 50 OFFSET 0');
	});

	it('escapes %, _ and backslash inside the bound search value on every dialect', () => {
		for (const dialect of ['postgres', 'mysql', 'clickhouse', 'unknown'] as const) {
			const { select, params } = buildPageStatements(dialect, 'orders', TABLE_NO_PK, req({ search: '50%_a\\b' }));
			assert.deepEqual(params, ['%50\\%\\_a\\\\b%']);
			assert.ok(!select.includes('\\'), 'the statement text carries no backslash');
		}
	});

	it('escapes a header contains filter the same way', () => {
		const { params } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({ filters: { code: '100%' } }));
		assert.deepEqual(params, ['%100\\%%']);
	});
});

// =============================================================================
// PAGING — FILTER CHIPS
// =============================================================================

describe('buildPageStatements chips', () => {
	it('renders a chip after search and header filters, all ANDed, with sequential binds', () => {
		const { select, params, where } = buildPageStatements('postgres', 'orders', TABLE_NO_PK, req({
			search: 'ab',
			filters: { code: 'x' },
		}), {
			chips: [
				{ column: 'id', op: 'gte', value: '10' },
				{ column: 'note', op: 'isNull' },
				{ column: 'note', op: 'startsWith', value: 'q' },
			],
		});
		assert.equal(
			where,
			' WHERE ("code"::text ILIKE $1 OR "note"::text ILIKE $1) AND "code"::text ILIKE $2 AND "id" >= $3 AND "note" IS NULL AND "note"::text ILIKE $4',
		);
		assert.ok(select.startsWith(`SELECT * FROM "orders"${where}`));
		assert.deepEqual(params, ['%ab%', '%x%', 10, 'q%']);
	});

	it('quotes the chip column per dialect', () => {
		const chips = [{ column: 'we`ird', op: 'eq' as const, value: '1' }];
		assert.equal(buildPageStatements('mysql', 't', TABLE_NO_PK, req(), { chips }).where, ' WHERE `we``ird` = $1');
		assert.equal(buildPageStatements('postgres', 't', TABLE_NO_PK, req(), { chips: [{ column: 'a"b', op: 'ne', value: '1' }] }).where, ' WHERE "a""b" <> $1');
	});

	it('skips an incomplete chip', () => {
		const { where, params } = buildPageStatements('postgres', 't', TABLE_NO_PK, req(), { chips: [{ column: 'id', op: 'eq' }] });
		assert.equal(where, '');
		assert.deepEqual(params, []);
	});

	it('applies the chips to the COUNT as well', () => {
		const { count, params } = buildPageStatements('postgres', 't', TABLE_NO_PK, req(), { chips: [{ column: 'id', op: 'lt', value: '3' }] });
		assert.equal(count, 'SELECT COUNT(*) AS total FROM "t" WHERE "id" < $1');
		assert.deepEqual(params, [3]);
	});
});

// =============================================================================
// PAGING — ONE ROW PAST THE PAGE, AND THE COUNT KEY
// =============================================================================

describe('buildPageStatements overfetch', () => {
	it('asks for size + 1 rows so the caller can tell more rows exist', () => {
		const { select } = buildPageStatements('postgres', 'orders', TABLE, req({ page: 2, size: 25 }), { overfetch: true });
		assert.match(select, /LIMIT 26 OFFSET 25$/);
	});

	it('keeps OFFSET paging', () => {
		const { select } = buildPageStatements('mysql', 'orders', TABLE, req({ page: 3, size: 10 }));
		assert.match(select, /LIMIT 10 OFFSET 20$/);
	});
});

describe('countKey', () => {
	it('is the same for another page of the same filter, sort and size', () => {
		const a = buildPageStatements('postgres', 'orders', TABLE, req({ page: 1, search: 'x' }));
		const b = buildPageStatements('postgres', 'orders', TABLE, req({ page: 2, size: 10, search: 'x', sort: [{ field: 'code', dir: 'desc' }] }));
		assert.equal(countKey('orders', a), countKey('orders', b));
	});

	it('differs when a bound value, a chip or the table differs', () => {
		const a = buildPageStatements('postgres', 'orders', TABLE, req({ search: 'x' }));
		const b = buildPageStatements('postgres', 'orders', TABLE, req({ search: 'y' }));
		const c = buildPageStatements('postgres', 'orders', TABLE, req({ search: 'x' }), { chips: [{ column: 'id', op: 'isNull' }] });
		assert.notEqual(countKey('orders', a), countKey('orders', b));
		assert.notEqual(countKey('orders', a), countKey('orders', c));
		assert.notEqual(countKey('orders', a), countKey('items', a));
	});
});

describe('buildPageStatements chip values follow the column type', () => {
	it('binds a number for an equals chip on the BIGINT column', () => {
		const { params } = buildPageStatements('postgres', 'orders', TABLE, req(), { chips: [{ column: 'id', op: 'eq', value: '7' }] });
		assert.deepEqual(params, [7]);
	});

	it('keeps a string for a text column and for a column the schema does not list', () => {
		const { params } = buildPageStatements('postgres', 'orders', TABLE, req(), {
			chips: [{ column: 'code', op: 'eq', value: '7' }, { column: 'ghost', op: 'eq', value: '7' }],
		});
		assert.deepEqual(params, ['7', '7']);
	});
});
