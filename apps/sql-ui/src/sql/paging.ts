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
// SQL — PAGING (dialect-aware SELECT/COUNT builders for the data browser)
// =============================================================================
//
// Pure SQL string building: no client, no session. The data browser forwards
// the DataGrid's page request here and executes the returned statements
// through the connection's session.
// =============================================================================

import type { IDataGridPageRequest } from 'shell';
import type { SqlSchemaTable, SqlDialect } from '../connect';
import { chipPredicate, escapeLike, isCompleteChip, likePredicate } from './filters';
import type { FilterChip } from './filters';

// =============================================================================
// QUOTING
// =============================================================================

/**
 * Quote an identifier (table/column name) for the dialect: backticks for
 * MySQL/ClickHouse, double quotes elsewhere (Postgres and ANSI engines).
 *
 * The quote character is doubled. ClickHouse also reads backslash escapes
 * inside a backtick identifier, so there a backslash is doubled too, first:
 * otherwise a name ending in `\` escapes the closing backtick and the rest
 * of the statement becomes part of the name. MySQL and PostgreSQL read a
 * backslash in an identifier as itself, so it is left alone there.
 *
 * Identifiers are the ONLY thing this module renders into SQL text. Values
 * are bound (see {@link buildPageStatements}).
 *
 * @param dialect - The engine dialect.
 * @param name - The identifier to quote.
 * @returns The quoted identifier.
 */
export function quoteIdent(dialect: SqlDialect, name: string): string {
	if (dialect === 'clickhouse') {
		return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '``') + '`';
	}
	if (dialect === 'mysql') {
		return '`' + name.replace(/`/g, '``') + '`';
	}
	return '"' + name.replace(/"/g, '""') + '"';
}

// =============================================================================
// PREDICATES
// =============================================================================

/** Column-type test: text-ish columns participate in the free-text search. */
const TEXT_TYPE = /char|text|string|uuid|enum/i;

/** A WHERE clause plus the values its `$n` placeholders bind to. */
interface WhereClause {
	/** The clause (with leading ' WHERE ') or ''. */
	clause: string;
	/** Bind values, in placeholder order. */
	params: unknown[];
}

/**
 * Build the WHERE clause for a page request: the title-bar search term ORed
 * across the table's text columns, ANDed with the committed per-column
 * filters (string = contains, array = IN, __gte/__lte = range bounds) and
 * then the filter chips. Search and contains are case-insensitive per
 * dialect, with `%`, `_` and `\` in the typed text matching themselves.
 *
 * Every value the user typed is bound as `$n`, never rendered into the
 * statement. The search term binds ONCE and its placeholder repeats across
 * the ORed columns.
 *
 * @param dialect - The engine dialect.
 * @param table - The table's reflected schema (drives the search columns).
 * @param req - The grid's page request.
 * @param chips - The filter chips above the grid.
 * @returns The clause and its bind values.
 */
function buildWhere(dialect: SqlDialect, table: SqlSchemaTable, req: IDataGridPageRequest, chips: readonly FilterChip[]): WhereClause {
	const clauses: string[] = [];
	const params: unknown[] = [];

	/**
	 * Append one bind value and return its placeholder.
	 *
	 * @param value - The value to bind.
	 * @returns The `$n` placeholder naming it.
	 */
	const bind = (value: unknown): string => {
		params.push(value);
		return `$${params.length}`;
	};

	// Free-text search across text-typed columns.
	if (req.search) {
		const targets = table.columns.filter((c) => TEXT_TYPE.test(c.type));
		if (targets.length > 0) {
			// One placeholder, reused: the same pattern for every column.
			const term = bind(`%${escapeLike(req.search)}%`);
			clauses.push('(' + targets.map((c) => likePredicate(dialect, quoteIdent(dialect, c.column), term)).join(' OR ') + ')');
		}
	}

	// Committed per-column filters.
	for (const [key, value] of Object.entries(req.filters ?? {})) {
		// Range bounds ride as `${field}__gte` / `${field}__lte` string entries.
		if (key.endsWith('__gte') || key.endsWith('__lte')) {
			const field = key.slice(0, -5);
			const op = key.endsWith('__gte') ? '>=' : '<=';
			clauses.push(`${quoteIdent(dialect, field)} ${op} ${bind(String(value))}`);
			continue;
		}
		if (Array.isArray(value)) {
			if (value.length > 0) {
				clauses.push(`${quoteIdent(dialect, key)} IN (${value.map((v) => bind(v)).join(', ')})`);
			}
			continue;
		}
		// String value = contains. The wrapping `%` belongs to the VALUE, not
		// to the statement (see the placeholder caveat on buildPageStatements).
		clauses.push(likePredicate(dialect, quoteIdent(dialect, key), bind(`%${escapeLike(value)}%`)));
	}

	// Filter chips, ANDed with everything above.
	for (const chip of chips) {
		if (!isCompleteChip(chip)) continue;
		const type = table.columns.find((c) => c.column === chip.column)?.type ?? '';
		clauses.push(chipPredicate(dialect, quoteIdent(dialect, chip.column), chip, bind, type));
	}

	return { clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

// =============================================================================
// PAGE STATEMENTS
// =============================================================================

/** Extras for one page request beyond what the grid sends. */
export interface PageOptions {
	/** The filter chips above the grid. */
	chips?: readonly FilterChip[];
	/** Select one row past the page, so the caller can tell more rows exist. */
	overfetch?: boolean;
}

/** The page SELECT and its matching COUNT for one grid page request. */
export interface PageStatements {
	/** The WHERE clause (with leading ' WHERE ') or '' — what a count depends on. */
	where: string;
	/** The page SELECT (LIMIT/OFFSET applied). */
	select: string;
	/** The COUNT(*) over the same WHERE (drives the pager total). */
	count: string;
	/** Bind values for the `$n` placeholders — the SAME list for both. */
	params: unknown[];
}

/**
 * Build the SELECT + COUNT statements for one grid page request.
 *
 * Filter and search values are bound as positional `$1..$n` parameters and
 * passed to `SqlSession.execute` alongside the statement; nothing the user
 * typed is rendered into SQL text. Only identifiers (quoted) and the grid's
 * own page numbers reach the statement directly.
 *
 * Placeholder caveat: the node rewrites `$n` TEXTUALLY before binding
 * (packages/ai/src/ai/common/database/tx_registry.py:43-45), so a literal
 * `$1` inside a string body would be rewritten too. Every statement this
 * module emits is generated here and never places a placeholder inside a
 * literal — which is precisely why LIKE patterns are assembled as bind
 * VALUES (`%term%`) instead of as `'%' || $1 || '%'` or an inlined pattern.
 *
 * Paging is OFFSET-based: the shell pager jumps to any page number, which a
 * keyset cursor cannot do, and OFFSET is correct on every engine. It gets
 * slower the deeper the page on a large table; the data browser therefore
 * does not count big filtered tables (see `estimate.ts`).
 *
 * @param dialect - The engine dialect.
 * @param tableName - The table to page over.
 * @param table - The table's reflected schema.
 * @param req - The grid's page request.
 * @param opts - The filter chips and the overfetch switch.
 * @returns The page statements and their bind values.
 */
export function buildPageStatements(
	dialect: SqlDialect,
	tableName: string,
	table: SqlSchemaTable,
	req: IDataGridPageRequest,
	opts: PageOptions = {},
): PageStatements {
	const target = quoteIdent(dialect, tableName);
	const { clause: where, params } = buildWhere(dialect, table, req, opts.chips ?? []);

	// ORDER BY from the grid's sorters; fall back to the primary key so
	// paging is deterministic even without a user sort. A table with neither
	// pages unordered — the data browser says so above the grid.
	const sorters = req.sort.length > 0
		? req.sort
		: (table.primary_key ?? []).map((c) => ({ field: c, dir: 'asc' as const }));
	const orderBy = sorters.length > 0
		? ` ORDER BY ${sorters.map((s) => `${quoteIdent(dialect, s.field)} ${s.dir.toUpperCase()}`).join(', ')}`
		: '';

	// LIMIT/OFFSET stay inline: they are the grid's own numbers, never user
	// text, and several engines reject a bind parameter in those positions.
	const offset = (req.page - 1) * req.size;
	const limit = req.size + (opts.overfetch ? 1 : 0);
	return {
		where,
		select: `SELECT * FROM ${target}${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`,
		count: `SELECT COUNT(*) AS total FROM ${target}${where}`,
		params,
	};
}

/**
 * The key a total is cached under: the table, the WHERE clause and its bound
 * values. Paging, sorting and the page size do not change it, so another
 * page of the same filter finds the count already known.
 *
 * @param tableName - The table.
 * @param statements - The statements built for one of the filter's pages.
 * @returns The cache key.
 */
export function countKey(tableName: string, statements: Pick<PageStatements, 'where' | 'params'>): string {
	return JSON.stringify([tableName, statements.where, statements.params]);
}
