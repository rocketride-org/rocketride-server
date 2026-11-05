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
// SQL — FILTERS (filter-chip predicates and case-insensitive text match)
// =============================================================================
//
// Pure SQL string building, like `paging.ts`, which calls in here. The caller
// quotes the column; this module only renders the predicate around it. Every
// value the user typed is bound through the caller's `bind` and never placed
// in the statement text. The NULL operators bind nothing.
// =============================================================================

import type { SqlDialect } from '../connect';

// =============================================================================
// TYPES
// =============================================================================

/** The operators a filter chip offers. */
export type FilterOp = 'eq' | 'ne' | 'contains' | 'startsWith' | 'gt' | 'lt' | 'gte' | 'lte' | 'isNull' | 'notNull';

/** One "+ Filter" chip: a column, an operator, and (for most operators) a value. */
export interface FilterChip {
	/** The column the chip filters. */
	column: string;
	/** The operator. */
	op: FilterOp;
	/** The value (ignored by the NULL operators). */
	value?: string;
}

/** One operator as the "+ Filter" form lists it. */
export interface FilterOpInfo {
	/** The operator. */
	op: FilterOp;
	/** The label in the operator picker. */
	label: string;
	/** Whether the operator takes a value. */
	needsValue: boolean;
}

/** The operators in picker order. */
export const FILTER_OPS: readonly FilterOpInfo[] = [
	{ op: 'eq', label: 'equals', needsValue: true },
	{ op: 'ne', label: 'not equals', needsValue: true },
	{ op: 'contains', label: 'contains', needsValue: true },
	{ op: 'startsWith', label: 'starts with', needsValue: true },
	{ op: 'gt', label: '>', needsValue: true },
	{ op: 'lt', label: '<', needsValue: true },
	{ op: 'gte', label: '≥', needsValue: true },
	{ op: 'lte', label: '≤', needsValue: true },
	{ op: 'isNull', label: 'is null', needsValue: false },
	{ op: 'notNull', label: 'is not null', needsValue: false },
];

/** Comparison operators and the SQL symbol each renders. */
const COMPARE_SYMBOL: Partial<Record<FilterOp, string>> = {
	eq: '=',
	ne: '<>',
	gt: '>',
	lt: '<',
	gte: '>=',
	lte: '<=',
};

// =============================================================================
// TEXT MATCH
// =============================================================================

/**
 * Escape LIKE wildcards in a user's text so `%`, `_` and `\` match themselves.
 * Backslash is the default LIKE escape on Postgres, MySQL and ClickHouse, so
 * the statement carries no ESCAPE clause (ClickHouse has none); the
 * backslashes travel inside the bound value.
 *
 * @param value - The text the user typed.
 * @returns The text with `\`, `%` and `_` escaped.
 */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * What the "+ Filter" form says about upper and lower case, per engine. It
 * must match what the predicates send: the text operators and the search box
 * go through {@link likePredicate} (ILIKE, or LOWER() on MySQL), while equals
 * and not equals send a plain `=` / `<>`, which compares exactly on PostgreSQL
 * and ClickHouse and by the column's collation on MySQL.
 *
 * @param dialect - The engine dialect.
 * @returns The hint.
 */
export function textMatchHint(dialect: SqlDialect): string {
	const insensitive = 'Search, contains and starts with ignore upper and lower case.';
	switch (dialect) {
		case 'postgres':
			return `${insensitive} Equals and not equals compare exactly, as PostgreSQL does.`;
		case 'mysql':
			return `${insensitive} Equals and not equals compare as the column's collation does; MySQL's usual collations ignore case too.`;
		case 'clickhouse':
			return `${insensitive} Equals and not equals compare exactly.`;
		default:
			// An unknown dialect gets a plain LIKE, whose case rules are the database's.
			return 'Text matches compare as the database does until the database is known.';
	}
}

/**
 * A case-insensitive LIKE over one column, per engine. Postgres casts to text
 * (a plain LIKE on a uuid or enum column errors); MySQL lowers both sides
 * because its LIKE follows the column's collation; ClickHouse has ILIKE and
 * `toString` covers uuid and enum. An unknown dialect keeps a plain LIKE.
 *
 * @param dialect - The engine dialect.
 * @param column - The already-quoted column.
 * @param placeholder - The `$n` placeholder bound to the pattern.
 * @returns The predicate.
 */
export function likePredicate(dialect: SqlDialect, column: string, placeholder: string): string {
	switch (dialect) {
		case 'postgres':
			return `${column}::text ILIKE ${placeholder}`;
		case 'mysql':
			return `LOWER(${column}) LIKE LOWER(${placeholder})`;
		case 'clickhouse':
			return `toString(${column}) ILIKE ${placeholder}`;
		default:
			return `${column} LIKE ${placeholder}`;
	}
}

// =============================================================================
// CHIPS
// =============================================================================

/** Integer column types, with the wrappers ClickHouse puts around them. */
const INTEGER_TYPE = /^(u?int\d*|tinyint|smallint|mediumint|bigint|integer|serial|smallserial|bigserial)\b/i;

/** Exact decimal column types. */
const EXACT_TYPE = /^(numeric|decimal\d*|number)\b/i;

/** Floating-point column types. */
const FLOAT_TYPE = /^(real|double|float\d*)\b/i;

/**
 * A plain decimal as a number only when the number holds it exactly: at most
 * 15 significant digits that read back unchanged (`1.50` is 1.5). Anything
 * longer stays text, and the database casts text to an exact decimal.
 *
 * @param text - The trimmed text.
 * @returns The number, or null when a number would round it.
 */
function exactDecimal(text: string): number | null {
	const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
	if (!m) return null;
	const whole = m[2]!.replace(/^0+(?=\d)/, '');
	const frac = (m[3] ?? '').replace(/0+$/, '');
	const normal = `${m[1]}${whole}${frac ? `.${frac}` : ''}`;
	const digits = (whole + frac).replace(/^0+/, '');
	return digits.length <= 15 && String(Number(normal)) === normal ? Number(normal) : null;
}

/**
 * The value a comparison chip binds, by the column's type. A text value
 * against an integer column can be refused by Postgres and ClickHouse, so
 * numbers and booleans bind as such. Text that does not read as that type
 * stays text (the engine then says what is wrong). An integer beyond 2^53,
 * or an exact decimal with more digits than a number holds, stays text
 * because a number would round it.
 *
 * @param type - The column's reflected type, e.g. `NUMERIC(10,2)`.
 * @param value - What the user typed.
 * @returns The value to bind.
 */
export function coerceChipValue(type: string, value: string): string | number | boolean {
	// Nullable(Int32), LowCardinality(UInt8): look at the type inside.
	let inner = type.trim();
	for (let wrapped = /^(?:Nullable|LowCardinality)\((.*)\)$/i.exec(inner); wrapped; wrapped = /^(?:Nullable|LowCardinality)\((.*)\)$/i.exec(inner)) {
		inner = wrapped[1]!.trim();
	}
	const text = value.trim();
	if (INTEGER_TYPE.test(inner)) {
		return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : value;
	}
	if (EXACT_TYPE.test(inner)) return exactDecimal(text) ?? value;
	if (FLOAT_TYPE.test(inner)) {
		return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? Number(text) : value;
	}
	if (/^bool(ean)?\b/i.test(inner)) {
		if (/^(true|t|1)$/i.test(text)) return true;
		if (/^(false|f|0)$/i.test(text)) return false;
	}
	return value;
}

/**
 * Render one chip as a predicate. Values go through `bind`; `isNull` and
 * `notNull` call it zero times. Comparison values bind by the column's type.
 *
 * @param dialect - The engine dialect.
 * @param column - The already-quoted column.
 * @param chip - The chip.
 * @param bind - Adds a bind value and returns its `$n` placeholder.
 * @param columnType - The column's reflected type (default: text).
 * @returns The predicate.
 */
export function chipPredicate(dialect: SqlDialect, column: string, chip: FilterChip, bind: (value: unknown) => string, columnType = ''): string {
	const value = chip.value ?? '';
	switch (chip.op) {
		case 'isNull':
			return `${column} IS NULL`;
		case 'notNull':
			return `${column} IS NOT NULL`;
		case 'contains':
			return likePredicate(dialect, column, bind(`%${escapeLike(value)}%`));
		case 'startsWith':
			return likePredicate(dialect, column, bind(`${escapeLike(value)}%`));
		default:
			return `${column} ${COMPARE_SYMBOL[chip.op]} ${bind(coerceChipValue(columnType, value))}`;
	}
}

/**
 * Whether a chip is ready to filter: it names a column, and an operator that
 * takes a value has one (an empty string is a value).
 *
 * @param chip - The chip.
 * @returns True when the chip can be applied.
 */
export function isCompleteChip(chip: FilterChip): boolean {
	if (!chip.column) return false;
	const info = FILTER_OPS.find((o) => o.op === chip.op);
	if (!info) return false;
	return !info.needsValue || chip.value !== undefined;
}

/**
 * A chip in plain words, e.g. `total > 100`.
 *
 * @param chip - The chip.
 * @returns The text shown on the chip.
 */
export function describeChip(chip: FilterChip): string {
	const info = FILTER_OPS.find((o) => o.op === chip.op);
	const label = info?.label ?? chip.op;
	return info?.needsValue ? `${chip.column} ${label} ${chip.value ?? ''}` : `${chip.column} ${label}`;
}
