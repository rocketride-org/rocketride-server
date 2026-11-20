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
//
// Two notes under the grid are decided here too, and both only when they
// apply: the PRECISION note (a value that could have lost digits on the way),
// and the SAME-NAME note (rows arrive as objects, so two columns with one
// name merge into one; the node does not return column names any other way).
// =============================================================================

import type { SqlSchemaResponse, SqlDialect } from '../connect';
import { codeOnly, keywordSites, stripSqlComments } from './split';

// =============================================================================
// TYPES
// =============================================================================

/** The grid's value types (mirrors the shell's GridColumnRRType subset used here). */
export type RrType = 'string' | 'number' | 'date' | 'boolean' | 'json';

/** What was decided about one result column, and on what basis. */
export interface ColumnTypeInfo {
	/** The grid type to declare for this column. */
	rrType: RrType;
	/** Where the type came from. */
	source: 'schema' | 'inferred';
	/** Tooltip text naming the basis, e.g. `BIGINT (schema)`. */
	description: string;
	/** The engine-reported type, when the type came from the schema. */
	sqlType?: string;
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

/**
 * Whole type-name tokens of binary types, whose values the node sends as
 * text it decoded (`bytes.decode('utf-8', errors='replace')`; PostgreSQL's
 * bytea as '<memory at 0x…>'). MySQL's `CHAR(n) CHARACTER SET binary` is
 * BINARY(n) under another name, and carries the token too.
 */
const BINARY_TOKENS = /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bytea|bit|varbit)$/i;

/** Whole type-name tokens of exact decimal types, which the node sends as floats. */
const DECIMAL_TOKENS = /^(decimal|dec|numeric|fixed|decimal(32|64|128|256))$/i;

// =============================================================================
// SQL TYPE NAMES
// =============================================================================

/**
 * The whole-word tokens of a type string: quoted runs removed, purely
 * numeric tokens (the `10` and `2` of `DECIMAL(10,2)`) dropped.
 *
 * @param sqlType - The type string from `get_schema`.
 * @returns The tokens.
 */
function typeTokens(sqlType: string): string[] {
	return sqlType
		.replace(TYPE_LITERAL, ' ')
		.split(/[^A-Za-z0-9]+/)
		.filter((token) => token.length > 0 && !/^\d+$/.test(token));
}

/**
 * Whether a type is an exact decimal (DECIMAL, NUMERIC and their spellings,
 * ClickHouse's `Decimal(P, S)` and `Decimal64(S)`). The node sends those
 * values as floats, so the digits shown may not be the digits stored.
 *
 * @param sqlType - The type string from `get_schema`.
 * @returns True for a decimal type.
 */
export function isDecimalSqlType(sqlType: string): boolean {
	return typeTokens(sqlType).some((token) => DECIMAL_TOKENS.test(token));
}

/**
 * Whether a type holds bytes (BINARY, VARBINARY, the BLOBs, bytea, BIT and
 * BIT VARYING). The node sends such a value as text that is not the value
 * stored, so it can be shown but never matched against the database. Read by
 * whole token, so ORBIT or a `_bin` collation is not one.
 *
 * @param sqlType - The type string from `get_schema`.
 * @returns True for a binary type.
 */
export function isBinarySqlType(sqlType: string): boolean {
	return typeTokens(sqlType).some((token) => BINARY_TOKENS.test(token));
}

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
	const tokens = typeTokens(sqlType);
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
 * @param rows - The result rows.
 * @param schema - The connection's schema snapshot, when one is loaded.
 * @param sql - The statement that produced the rows, when it is known.
 * @param dialect - The engine dialect.
 * @param resultColumns - The result's columns as captured when it settled.
 *                        Without them the set is read off every row, so a
 *                        column absent from the first row is still typed; a
 *                        row the grid has rendered carries the grid's keys
 *                        too, which is why the query view passes its list.
 * @returns One {@link ColumnTypeInfo} per column, keyed by column name.
 */
export function inferColumnTypes(
	rows: Record<string, unknown>[],
	schema?: SqlSchemaResponse | null,
	sql?: string,
	dialect: SqlDialect = 'unknown',
	resultColumns?: readonly string[],
): Record<string, ColumnTypeInfo> {
	const out: Record<string, ColumnTypeInfo> = {};
	if (rows.length === 0) return out;

	// Column set, in first-seen order.
	const columns: string[] = resultColumns ? [...resultColumns] : [];
	if (!resultColumns) {
		for (const row of rows) {
			for (const key of Object.keys(row)) {
				if (!columns.includes(key)) columns.push(key);
			}
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
					sqlType,
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

// =============================================================================
// NOTES UNDER THE GRID
// =============================================================================

/** The same-name note, word for word. */
export const MERGED_COLUMNS_NOTE = 'Columns with the same name are merged; alias them';

/** Significant digits a float shows before its last digits may be noise. */
const FLOAT_DIGITS = 15;

/**
 * The significant digits of a finite number as JavaScript prints it (the
 * shortest text that reads back as the same double).
 *
 * @param value - The number.
 * @returns The digit count.
 */
function significantDigits(value: number): number {
	const mantissa = Math.abs(value).toExponential().split('e')[0] as string;
	return mantissa.replace('.', '').length;
}

/**
 * Whether a value may not be the number the database holds: an integer beyond
 * ±2^53 (JSON cannot carry it exactly), or a float with more than 15
 * significant digits (a `Decimal` the node turned into a float shows this).
 *
 * @param value - A cell value.
 * @returns True when the value may have lost precision.
 */
function mayHaveLostPrecision(value: unknown): boolean {
	if (typeof value !== 'number' || !Number.isFinite(value)) return false;
	if (Number.isInteger(value)) return !Number.isSafeInteger(value);
	return significantDigits(value) > FLOAT_DIGITS;
}

/**
 * Whether the precision note applies to a result: a column the schema types
 * as DECIMAL/NUMERIC, or a value that may have lost precision on the way.
 *
 * @param columns - The result's captured columns.
 * @param rows - The rows.
 * @param types - The columns' types (from {@link inferColumnTypes}).
 * @returns True when the note should show.
 */
export function precisionNoteApplies(columns: readonly string[], rows: readonly Record<string, unknown>[], types: Record<string, ColumnTypeInfo>): boolean {
	if (columns.some((column) => isDecimalSqlType(types[column]?.sqlType ?? ''))) return true;
	return rows.some((row) => columns.some((column) => mayHaveLostPrecision(row[column])));
}

/** A name: double-quoted, backquoted, or bare. */
const NAME = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_\\u0080-\\uffff][A-Za-z0-9_$\\u0080-\\uffff]*)';

/** A column reference, possibly qualified: `c.name`, `"s"."t"."c"`. */
const COLUMN_REF = new RegExp(`^${NAME}(?:\\s*\\.\\s*${NAME})*$`);

/** A reference followed by an alias without AS: `c.name customer`. */
const REF_ALIAS = new RegExp(`^${NAME}(?:\\s*\\.\\s*${NAME})*\\s+(${NAME})$`);

/** A star, bare or table-qualified: `*`, `o.*`. */
const STAR = new RegExp(`^(?:${NAME}\\s*\\.\\s*)*\\*$`);

/** The clauses that end a FROM list. */
const AFTER_FROM = ['where', 'group', 'having', 'order', 'limit', 'window', 'union', 'intersect', 'except', 'offset', 'fetch', 'for', 'qualify', 'settings', 'format'];

/**
 * The output name of a name token as the server labels the column: a quoted
 * name as written inside its quotes; a bare one folded to lower case on
 * PostgreSQL, as written elsewhere.
 *
 * @param token - The name as written.
 * @param dialect - The engine dialect.
 * @returns The output name.
 */
function outputName(token: string, dialect: SqlDialect): string {
	const quote = token[0];
	if (quote === '"' || quote === '`') return token.slice(1, -1).split(`${quote}${quote}`).join(quote);
	return dialect === 'postgres' ? token.toLowerCase() : token;
}

/**
 * The output name of one select-list item, or null when it is not certain
 * (an expression with no alias). Only `ref`, `ref AS alias`, `ref alias` and
 * `expr AS alias` are read.
 *
 * @param item - The item's text (comments removed).
 * @param masked - The same text with literals and quoted names blanked.
 * @param dialect - The engine dialect.
 * @returns The name, or null.
 */
function itemName(item: string, masked: string, dialect: SqlDialect): string | null {
	const text = item.trim();
	const sites = keywordSites(masked, ['as'], dialect).filter((site) => site.depth === 0);
	const lastAs = sites[sites.length - 1];
	if (lastAs) {
		const alias = item.slice(lastAs.index + 2).trim();
		return new RegExp(`^${NAME}$`).test(alias) ? outputName(alias, dialect) : null;
	}
	if (COLUMN_REF.test(text)) {
		const parts = text.match(new RegExp(NAME, 'g')) ?? [];
		const last = parts[parts.length - 1];
		return last ? outputName(last, dialect) : null;
	}
	const aliased = REF_ALIAS.exec(text);
	return aliased?.[1] ? outputName(aliased[1], dialect) : null;
}

/**
 * Split masked text at its depth-0 commas.
 *
 * @param masked - Masked text.
 * @returns The [start, end) offsets of each part.
 */
function splitTopLevel(masked: string): Array<[number, number]> {
	const parts: Array<[number, number]> = [];
	let depth = 0;
	let start = 0;
	for (let at = 0; at < masked.length; at++) {
		const ch = masked[at];
		if (ch === '(') depth += 1;
		else if (ch === ')') depth -= 1;
		else if (ch === ',' && depth === 0) {
			parts.push([start, at]);
			start = at + 1;
		}
	}
	parts.push([start, masked.length]);
	return parts;
}

/**
 * Whether a statement may return two columns with one name, which merge into
 * one because rows arrive as objects. Deliberately conservative: it reads the
 * outermost SELECT and says yes only for a `*` over a join (JOIN or a comma
 * list), two table stars over a join, or an output name the select list
 * spells twice. An unaliased expression is never counted.
 *
 * @param sql - The statement.
 * @param dialect - The engine dialect.
 * @returns True when the same-name note should show.
 */
export function mayMergeColumns(sql: string, dialect: SqlDialect = 'unknown'): boolean {
	const text = stripSqlComments(sql, dialect);
	const masked = codeOnly(text, dialect);
	const sites = keywordSites(text, ['select', 'from', 'join', ...AFTER_FROM], dialect).filter((site) => site.depth === 0);
	const select = sites.find((site) => site.keyword === 'select');
	if (!select) return false;
	// The SELECT must lead the statement, or follow a WITH chain.
	const lead = masked.slice(0, select.index).trim();
	if (lead !== '' && !/^with\b/i.test(lead)) return false;
	const from = sites.find((site) => site.keyword === 'from' && site.index > select.index);
	const listEnd = from?.index ?? masked.length;
	let listStart = select.index + 'select'.length;
	const modifier = /^\s*(?:distinct\s+on\s*\([^)]*\)|distinct|all)(?![A-Za-z0-9_$])/i.exec(masked.slice(listStart, listEnd));
	if (modifier) listStart += modifier[0].length;

	let joined = false;
	if (from) {
		const fromEnd = sites.find((site) => site.index > from.index && AFTER_FROM.includes(site.keyword))?.index ?? masked.length;
		joined = sites.some((site) => site.keyword === 'join' && site.index > from.index && site.index < fromEnd)
			|| splitTopLevel(masked.slice(from.index, fromEnd)).length > 1;
	}

	const names = new Set<string>();
	let stars = 0;
	for (const [start, end] of splitTopLevel(masked.slice(listStart, listEnd))) {
		const item = text.slice(listStart + start, listStart + end);
		if (STAR.test(item.trim())) {
			stars += 1;
			if (joined && (item.trim() === '*' || stars > 1)) return true;
			continue;
		}
		const name = itemName(item, masked.slice(listStart + start, listStart + end), dialect);
		if (name === null) continue;
		if (names.has(name)) return true;
		names.add(name);
	}
	return false;
}
