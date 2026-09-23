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
// SQL — RESULT COLUMN TYPES (grid types for a query result's columns)
// =============================================================================
//
// A query result arrives as plain JSON rows with no type information, so every
// column used to be declared 'string' — which disables numeric sorting and the
// number/date range filters in the grid.
//
// Two sources, in order:
//   1. THE SCHEMA SNAPSHOT, but only when the statement's source table is
//      CERTAIN: one `FROM <table>`, no join, and every returned column is one
//      of that table's columns. Anything less and this falls through, because
//      a wrong type is worse than a missing one.
//   2. VALUE INFERENCE over the returned rows.
//
// Which source was used is reported alongside the type, and the UI shows it in
// the column tooltip — `BIGINT (schema)` vs `number (inferred from 200 rows)`.
//
// Type-name matching is WHOLE-TOKEN. The previous substring test in the data
// browser matched `/int/` inside `POINT` and missed `MONEY`, `REAL` and
// `SERIAL`; every mapping here is a token comparison with a test to match.
//
// Value inference has to account for how the node sanitises values
// (db_instance_base._sanitize_value): `Decimal` becomes a float, `datetime`
// becomes an ISO string, `bytes` becomes a lossy string. An ISO-8601 string is
// therefore a date, not a string — that is where most of the win is.
// =============================================================================

import type { ISqlSchemaResponse, SqlDialect } from '../connect';
import { stripSqlComments } from './split';

// =============================================================================
// TYPES
// =============================================================================

/** The grid's value types (mirrors the shell's GridColumnRRType subset used here). */
export type RrType = 'string' | 'number' | 'date' | 'boolean' | 'json';

/** What was decided about one result column, and on what basis. */
export interface IColumnTypeInfo {
	/** The grid type to declare for this column. */
	rrType: RrType;
	/** Where the type came from. */
	source: 'schema' | 'inferred';
	/** Tooltip text naming the basis, e.g. `BIGINT (schema)`. */
	description: string;
}

// =============================================================================
// TYPE-NAME TABLES
// =============================================================================

/** How many values are looked at before a column's type is decided. */
const SAMPLE_SIZE = 200;

/** Whole type-name tokens that mean "json" (ClickHouse containers included). */
const JSON_TOKENS = /^(json|jsonb|array|map|tuple|nested|variant|object)$/i;

/** Whole type-name tokens that mean "date". */
const DATE_TOKENS = /^(date|date32|datetime|datetime64|smalldatetime|timestamp|timestamptz)$/i;

/** Whole type-name tokens that mean "boolean". */
const BOOL_TOKENS = /^(bool|boolean)$/i;

/**
 * Whole type-name tokens that mean "number". Covers the ANSI and MySQL names,
 * PostgreSQL's `serial`/`money`/`real`, and ClickHouse's sized integer, float
 * and decimal names.
 */
const NUMBER_TOKENS = /^(tinyint|smallint|mediumint|int|int2|int4|int8|integer|bigint|decimal|dec|numeric|fixed|float|float4|float8|double|real|money|smallmoney|serial|serial2|serial4|serial8|smallserial|bigserial|year|u?int(8|16|32|64|128|256)|float(32|64)|decimal(32|64|128|256))$/i;

/** Quoted runs inside a type name (`ENUM('int','x')`) — removed before tokenising. */
const TYPE_LITERAL = /'[^']*'|"[^"]*"/g;

// =============================================================================
// SQL TYPE NAMES
// =============================================================================

/**
 * Map an engine-reported type string onto a grid type.
 *
 * The string is tokenised on non-alphanumeric characters AFTER quoted runs are
 * removed, so `SET('int','x')` is the tokens `SET` (a string type) and not the
 * `int` hiding in its value list. Purely numeric tokens (the `10` and `2` of
 * `DECIMAL(10,2)`) are dropped. When several tokens match, the wider container
 * wins: json over date over boolean over number over string — that is what
 * makes `Array(UInt8)` json and `TIMESTAMP WITH TIME ZONE` a date rather than
 * the string that its `TIME` token would give.
 *
 * Known deliberate call: MySQL's `TINYINT(1)` is a number, not a boolean. The
 * engine reports the same type for a real one-byte integer and there is no way
 * to tell them apart from the type name.
 *
 * @param sqlType - The type string from `get_schema`.
 * @param dialect - The dialect that reported it (accepted for future
 *                  dialect-specific rules; the token tables are shared today).
 * @returns The grid type.
 */
export function rrTypeFromSqlType(sqlType: string, dialect: SqlDialect = 'unknown'): RrType {
	void dialect;
	if (!sqlType) return 'string';
	const tokens = sqlType
		.replace(TYPE_LITERAL, ' ')
		.split(/[^A-Za-z0-9]+/)
		.filter((token) => token.length > 0 && !/^\d+$/.test(token));
	if (tokens.some((token) => JSON_TOKENS.test(token))) return 'json';
	if (tokens.some((token) => DATE_TOKENS.test(token))) return 'date';
	if (tokens.some((token) => BOOL_TOKENS.test(token))) return 'boolean';
	if (tokens.some((token) => NUMBER_TOKENS.test(token))) return 'number';
	return 'string';
}

// =============================================================================
// VALUE INFERENCE
// =============================================================================

/** A number written as text, in the forms JSON and SQL drivers produce. */
const NUMERIC_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** ISO-8601 date, with an optional time part and zone. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Whether a string should be treated as a number.
 *
 * The leading-zero rule is the point: `0123` is a zip code, a product code or
 * an account number, and turning it into 123 in a numeric column would lose
 * the zero in front of the user. `0` and `0.5` are ordinary numbers.
 *
 * @param value - The string to test.
 * @returns True when the string is safe to treat as numeric.
 */
function isNumericText(value: string): boolean {
	return NUMERIC_TEXT.test(value);
}

/**
 * Whether a string is a real ISO-8601 date (shape AND a parseable value, so
 * `2026-13-45` stays a string).
 *
 * @param value - The string to test.
 * @returns True when the string is a date.
 */
function isIsoDate(value: string): boolean {
	if (!ISO_DATE.test(value)) return false;
	return !Number.isNaN(Date.parse(value.replace(' ', 'T')));
}

/**
 * Infer a grid type from the values a column actually returned.
 *
 * Only the first {@link SAMPLE_SIZE} non-null values are looked at, and the
 * type is only claimed when EVERY sampled value agrees; a mixed column is a
 * string. Null and undefined are skipped rather than counted against a type.
 *
 * @param values - The column's values, in row order.
 * @returns The grid type ('string' when there is nothing to go on).
 */
export function rrTypeFromValues(values: unknown[]): RrType {
	const sample: unknown[] = [];
	for (const value of values) {
		if (value === null || value === undefined) continue;
		sample.push(value);
		if (sample.length >= SAMPLE_SIZE) break;
	}
	if (sample.length === 0) return 'string';

	if (sample.every((value) => typeof value === 'boolean')) return 'boolean';
	if (sample.every((value) => typeof value === 'object')) return 'json';
	if (sample.every((value) => typeof value === 'string' && isIsoDate(value))) return 'date';
	if (sample.every((value) => typeof value === 'number' || (typeof value === 'string' && isNumericText(value)))) {
		return 'number';
	}
	return 'string';
}

// =============================================================================
// SINGLE SOURCE TABLE
// =============================================================================

/** `FROM <table>` or `FROM <schema>.<table>`, optionally quoted. */
const FROM_TABLE = /\bfrom\s+(?:["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?\s*\.\s*)?["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?/i;

/**
 * The one table a statement certainly reads from, or null.
 *
 * Deliberately strict, and deliberately NOT a SQL parser: exactly one `FROM`,
 * no `JOIN`, and no comma directly after the table name (an old-style join).
 * Anything else returns null and the caller infers from values instead.
 *
 * @param sql - The statement text.
 * @param dialect - The engine dialect (comment syntax).
 * @returns The table name, or null when it is not certain.
 */
function singleSourceTable(sql: string, dialect: SqlDialect): string | null {
	const text = stripSqlComments(sql, dialect);
	if (/\bjoin\b/i.test(text)) return null;
	if ((text.match(/\bfrom\b/gi) ?? []).length !== 1) return null;
	const match = FROM_TABLE.exec(text);
	if (!match) return null;
	// A comma right after the table name is an old-style join: two sources.
	const after = text.slice(match.index + match[0].length).trimStart();
	if (after.startsWith(',')) return null;
	return match[2];
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Decide a grid type for every column of a result.
 *
 * @param rows - The result rows (column set taken from every row, so a column
 *               that is absent from the first row is still typed).
 * @param schema - The connection's schema snapshot, when one is loaded.
 * @param sql - The statement that produced the rows, when it is known.
 * @param dialect - The engine dialect.
 * @returns One {@link IColumnTypeInfo} per column, keyed by column name.
 */
export function inferColumnTypes(
	rows: Record<string, unknown>[],
	schema?: ISqlSchemaResponse | null,
	sql?: string,
	dialect: SqlDialect = 'unknown',
): Record<string, IColumnTypeInfo> {
	const out: Record<string, IColumnTypeInfo> = {};
	if (rows.length === 0) return out;

	// Column set, in first-seen order.
	const columns: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!columns.includes(key)) columns.push(key);
		}
	}

	// Schema path: only when the source table is certain AND covers every
	// returned column. A single miss drops the whole result to inference,
	// because a half-schema-typed result cannot be labelled honestly.
	const table = sql ? singleSourceTable(sql, dialect) : null;
	const tableSchema = table ? schema?.tables?.[table] : undefined;
	if (tableSchema) {
		const byName = new Map(tableSchema.columns.map((column) => [column.column.toLowerCase(), column.type]));
		if (columns.every((column) => byName.has(column.toLowerCase()))) {
			for (const column of columns) {
				const sqlType = byName.get(column.toLowerCase()) ?? '';
				out[column] = {
					rrType: rrTypeFromSqlType(sqlType, dialect),
					source: 'schema',
					description: `${sqlType} (schema)`,
				};
			}
			return out;
		}
	}

	// Value inference.
	for (const column of columns) {
		const values = rows.map((row) => row[column]);
		const sampled = Math.min(values.filter((value) => value !== null && value !== undefined).length, SAMPLE_SIZE);
		const rrType = rrTypeFromValues(values);
		out[column] = {
			rrType,
			source: 'inferred',
			description: sampled === 0
				? `${rrType} (no non-null values to infer from)`
				: `${rrType} (inferred from ${sampled} rows)`,
		};
	}
	return out;
}
