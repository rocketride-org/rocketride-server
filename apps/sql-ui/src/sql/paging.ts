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
import type { ISqlSchemaTable, SqlDialect } from '../connect';

// =============================================================================
// QUOTING
// =============================================================================

/**
 * Quote an identifier (table/column name) for the dialect: backticks for
 * MySQL/ClickHouse, double quotes elsewhere (Postgres and ANSI engines).
 *
 * @param dialect - The engine dialect.
 * @param name - The identifier to quote.
 * @returns The quoted identifier.
 */
export function quoteIdent(dialect: SqlDialect, name: string): string {
	if (dialect === 'mysql' || dialect === 'clickhouse') {
		return '`' + name.replace(/`/g, '``') + '`';
	}
	return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * Quote a literal value for embedding in a statement: single quotes with
 * doubled embedded quotes. Numbers pass through bare.
 *
 * @param value - The value to quote.
 * @returns The quoted literal.
 */
export function quoteValue(value: string): string {
	if (/^-?\d+(\.\d+)?$/.test(value)) return value;
	return "'" + value.replace(/'/g, "''") + "'";
}

// =============================================================================
// PREDICATES
// =============================================================================

/** Column-type test: text-ish columns participate in the free-text search. */
const TEXT_TYPE = /char|text|string|uuid|enum/i;

/**
 * Build the WHERE clause for a page request: the title-bar search term ORed
 * across the table's text columns, ANDed with the committed per-column
 * filters (string = contains, array = IN, __gte/__lte = range bounds).
 *
 * @param dialect - The engine dialect.
 * @param table - The table's reflected schema (drives the search columns).
 * @param req - The grid's page request.
 * @returns The WHERE clause (with leading ' WHERE ') or ''.
 */
function buildWhere(dialect: SqlDialect, table: ISqlSchemaTable, req: IDataGridPageRequest): string {
	const clauses: string[] = [];

	// Free-text search across text-typed columns.
	if (req.search) {
		const term = quoteValue(`%${req.search}%`);
		const targets = table.columns.filter((c) => TEXT_TYPE.test(c.type));
		if (targets.length > 0) {
			clauses.push('(' + targets.map((c) => `${quoteIdent(dialect, c.column)} LIKE ${term}`).join(' OR ') + ')');
		}
	}

	// Committed per-column filters.
	for (const [key, value] of Object.entries(req.filters ?? {})) {
		// Range bounds ride as `${field}__gte` / `${field}__lte` string entries.
		if (key.endsWith('__gte') || key.endsWith('__lte')) {
			const field = key.slice(0, -5);
			const op = key.endsWith('__gte') ? '>=' : '<=';
			clauses.push(`${quoteIdent(dialect, field)} ${op} ${quoteValue(String(value))}`);
			continue;
		}
		if (Array.isArray(value)) {
			if (value.length > 0) {
				clauses.push(`${quoteIdent(dialect, key)} IN (${value.map((v) => quoteValue(v)).join(', ')})`);
			}
			continue;
		}
		// String value = contains.
		clauses.push(`${quoteIdent(dialect, key)} LIKE ${quoteValue(`%${value}%`)}`);
	}

	return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

// =============================================================================
// PAGE STATEMENTS
// =============================================================================

/** The page SELECT and its matching COUNT for one grid page request. */
export interface IPageStatements {
	/** The page SELECT (LIMIT/OFFSET applied). */
	select: string;
	/** The COUNT(*) over the same WHERE (drives the pager total). */
	count: string;
}

/**
 * Build the SELECT + COUNT statements for one grid page request.
 *
 * @param dialect - The engine dialect.
 * @param tableName - The table to page over.
 * @param table - The table's reflected schema.
 * @param req - The grid's page request.
 * @returns The page statements.
 */
export function buildPageStatements(dialect: SqlDialect, tableName: string, table: ISqlSchemaTable, req: IDataGridPageRequest): IPageStatements {
	const target = quoteIdent(dialect, tableName);
	const where = buildWhere(dialect, table, req);

	// ORDER BY from the grid's sorters; fall back to the primary key so
	// paging is deterministic even without a user sort.
	const sorters = req.sort.length > 0 ? req.sort : (table.primary_key ?? []).map((c) => ({ field: c, dir: 'asc' as const }));
	const orderBy = sorters.length > 0 ? ` ORDER BY ${sorters.map((s) => `${quoteIdent(dialect, s.field)} ${s.dir.toUpperCase()}`).join(', ')}` : '';

	const offset = (req.page - 1) * req.size;
	return {
		select: `SELECT * FROM ${target}${where}${orderBy} LIMIT ${req.size} OFFSET ${offset}`,
		count: `SELECT COUNT(*) AS total FROM ${target}${where}`,
	};
}
