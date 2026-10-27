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
// SQL — RECORD (the pure model behind the data browser's row drawer)
// =============================================================================
//
// Fields come from the table's reflected column list, never from the keys of
// the row object: the grid writes an undefined key into every row object for
// each column it renders, so a row's own keys are not a column list. A
// foreign-key link looks the referenced row up with bound values; "Show rows"
// presets filter chips on the child table.
//
// A key that arrived as a number past 2^53 is never looked up or preset. The
// node sends an integer as a full-digit JSON number, and JSON.parse rounds
// one that long to the nearest double, which may be another row's key: the
// lookup would say "No row" for a row that exists, or open the wrong one.
// Nor is a key of a binary type: the node sends bytes as text it decoded with
// errors='replace' (PostgreSQL's bytea as '<memory at 0x…>'), which is not
// the key the database holds either.
// =============================================================================

import type { SqlDialect, SqlSchemaTable } from '../connect';
import { fkTargetFor, inboundReferences } from '../schema/relations';
import type { RelationEdge, RelationGraph } from '../schema/relations';
import type { FilterChip } from './filters';
import { quoteIdent } from './paging';
import { isBinarySqlType } from './resultTypes';

/** One field of the drawer. */
export interface RecordField {
	/** The column name. */
	column: string;
	/** The column's declared type. */
	type: string;
	/** The value (undefined when the row has none for this column). */
	value: unknown;
	/** Whether the column is part of the primary key. */
	pk: boolean;
	/** The foreign keys the column takes part in (each one a link). */
	links: RelationEdge[];
}

/**
 * The drawer's fields, one per reflected column, in schema order.
 *
 * @param def - The table's reflected schema.
 * @param row - The row.
 * @param graph - The relation graph, for the foreign-key links.
 * @param table - The table's name (needed with `graph`).
 * @returns The fields.
 */
export function recordFields(def: SqlSchemaTable, row: Record<string, unknown>, graph?: RelationGraph, table?: string): RecordField[] {
	const pk = new Set(def.primary_key ?? []);
	return def.columns.map((col) => ({
		column: col.column,
		type: col.type,
		value: row[col.column],
		pk: pk.has(col.column),
		links: graph && table ? fkTargetFor(graph, table, col.column) : [],
	}));
}

/**
 * A column list for a table the schema snapshot lacks, read from a row that
 * came straight back from a lookup (never from a row the grid has seen, which
 * carries a key per column it renders). Types are unknown.
 *
 * @param freshRow - A row from a fresh, untouched result.
 * @returns A schema entry listing the row's columns.
 */
export function fallbackDef(freshRow: Record<string, unknown>): SqlSchemaTable {
	return { columns: Object.keys(freshRow).map((column) => ({ column, type: '' })) };
}

/**
 * The row as JSON for "Copy row", keys in schema order. A column the row
 * lacks is written as null.
 *
 * @param def - The table's reflected schema.
 * @param row - The row.
 * @returns Pretty-printed JSON.
 */
export function recordJson(def: SqlSchemaTable, row: Record<string, unknown>): string {
	const ordered: Record<string, unknown> = {};
	for (const col of def.columns) ordered[col.column] = row[col.column] ?? null;
	return JSON.stringify(ordered, null, '\t');
}

/** A statement and its bind values. */
export interface BoundStatement {
	/** The statement, with `$n` placeholders. */
	sql: string;
	/** Bind values. */
	params: unknown[];
}

/** Why a key is not looked up: it arrived as a number the browser had already rounded. */
export const KEY_TOO_LARGE = 'This key is too large to look up exactly in the browser.';

/**
 * Whether a key value was rounded on its way in: an integer held as a number
 * beyond ±2^53, which is where doubles stop holding every integer. A value
 * that arrived as text is exact.
 *
 * @param value - The value as the row holds it.
 * @returns True when the number in hand may not be the key the database holds.
 */
export function isRoundedKey(value: unknown): boolean {
	return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value);
}

/** Why a key is not looked up: it is binary, and the node sent it as text that is not the stored key. */
export const KEY_BINARY = 'This key is binary, which the node sends as text, so it cannot be looked up here.';

/**
 * Whether either side of a foreign key is a binary column, by the reflected
 * types (a table the schema lacks has none, and is followed as before).
 *
 * @param edge - The foreign key.
 * @param tables - The reflected tables.
 * @returns True when a key column on either side holds bytes.
 */
function binaryKey(edge: RelationEdge, tables: Record<string, SqlSchemaTable> | undefined): boolean {
	const binary = (table: string, column: string): boolean => isBinarySqlType(tables?.[table]?.columns.find((c) => c.column === column)?.type ?? '');
	return edge.columns.some((column) => binary(edge.table, column)) || edge.refColumns.some((column) => binary(edge.refTable, column));
}

/**
 * Why a referencing row's key cannot be followed, or null when it can (or
 * when it is NULL, which shows no link at all).
 *
 * @param edge - The foreign key.
 * @param row - The referencing row.
 * @param tables - The reflected tables, for the key columns' types.
 * @returns {@link KEY_BINARY}, {@link KEY_TOO_LARGE}, or null.
 */
export function linkRefusal(edge: RelationEdge, row: Record<string, unknown>, tables?: Record<string, SqlSchemaTable>): string | null {
	if (binaryKey(edge, tables)) return KEY_BINARY;
	return edge.columns.some((column) => isRoundedKey(row[column])) ? KEY_TOO_LARGE : null;
}

/**
 * Why "Show rows" cannot preset the child table's filter from this row, or
 * null when it can (or when the key is NULL, which leaves it off as before).
 *
 * @param edge - The inbound foreign key.
 * @param row - The referenced (parent) row.
 * @param tables - The reflected tables, for the key columns' types.
 * @returns {@link KEY_BINARY}, {@link KEY_TOO_LARGE}, or null.
 */
export function showRowsRefusal(edge: RelationEdge, row: Record<string, unknown>, tables?: Record<string, SqlSchemaTable>): string | null {
	if (binaryKey(edge, tables)) return KEY_BINARY;
	return edge.refColumns.some((column) => isRoundedKey(row[column])) ? KEY_TOO_LARGE : null;
}

/**
 * Whether a row's value(s) for a key can be followed: every key column holds
 * a value (a NULL key points at nothing).
 *
 * @param edge - The foreign key.
 * @param row - The referencing row.
 * @returns True when no key column is NULL or missing.
 */
export function hasKeyValues(edge: RelationEdge, row: Record<string, unknown>): boolean {
	return edge.columns.every((column) => row[column] !== null && row[column] !== undefined);
}

/**
 * The statement a foreign-key link runs: the referenced row, looked up by the
 * key's value(s). LIMIT 2 so a key that is not unique can say so. Returns
 * null when any key value is NULL (a NULL key points at nothing), or is not
 * the key the database holds ({@link linkRefusal}).
 *
 * @param dialect - The engine dialect.
 * @param edge - The foreign key.
 * @param row - The referencing row.
 * @param tables - The reflected tables, for the key columns' types.
 * @returns The statement, or null when there is nothing to look up.
 */
export function referencedRowStatement(dialect: SqlDialect, edge: RelationEdge, row: Record<string, unknown>, tables?: Record<string, SqlSchemaTable>): BoundStatement | null {
	if (!hasKeyValues(edge, row) || linkRefusal(edge, row, tables) !== null) return null;
	const params: unknown[] = [];
	const conditions: string[] = [];
	for (let i = 0; i < edge.columns.length; i++) {
		params.push(row[edge.columns[i]!]);
		conditions.push(`${quoteIdent(dialect, edge.refColumns[i]!)} = $${params.length}`);
	}
	return { sql: `SELECT * FROM ${quoteIdent(dialect, edge.refTable)} WHERE ${conditions.join(' AND ')} LIMIT 2`, params };
}

/**
 * The child tables' keys that point at a table ("Rows that reference this
 * one"), including a key the table declares on itself.
 *
 * @param graph - The relation graph.
 * @param table - The referenced table.
 * @returns The inbound keys.
 */
export function referencingEdges(graph: RelationGraph, table: string): RelationEdge[] {
	return inboundReferences(graph, table);
}

/**
 * The chips "Show rows" presets on the child table: its key column(s) equal
 * this row's referenced value(s). Null when a value is NULL, or is not the
 * key the database holds ({@link showRowsRefusal}).
 *
 * @param edge - The inbound foreign key.
 * @param row - The referenced (parent) row.
 * @param tables - The reflected tables, for the key columns' types.
 * @returns The chips, or null when there is nothing to match.
 */
export function childRowsPreset(edge: RelationEdge, row: Record<string, unknown>, tables?: Record<string, SqlSchemaTable>): FilterChip[] | null {
	if (binaryKey(edge, tables)) return null;
	const chips: FilterChip[] = [];
	for (let i = 0; i < edge.columns.length; i++) {
		const value = row[edge.refColumns[i]!];
		if (value === null || value === undefined || isRoundedKey(value)) return null;
		chips.push({ column: edge.columns[i]!, op: 'eq', value: String(value) });
	}
	return chips;
}
