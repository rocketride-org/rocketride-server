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
// SQL — ROW EDITS (staged grid changes -> bound UPDATE / INSERT / DELETE)
// =============================================================================
//
// The data browser never writes as you edit: every edit, new row and delete
// is staged here, and Apply sends the statements this module builds, as one
// transaction where the engine has one (SqlSession.applyBatch). Pure
// and immutable: every function returns a new RowEdits and never writes to
// the row object it was given (a grid row is Tabulator's to mutate; PLAN-MAP
// fact 4), so React state can hold it as is.
//
//   KEYED BY PRIMARY KEY. A row is named by its key values, never by its
//   position, so a refetch or a page change cannot point an edit at another
//   row. A table without a primary key cannot be edited: nothing could pick
//   out one row exactly. Key columns are read-only.
//
//   EXACT KEYS. A 64-bit key travels as text: JavaScript numbers are exact
//   only up to 2^53, so a key that already arrived as a larger number may
//   have been rounded to ANOTHER row's key, and such a row is refused rather
//   than risked. A table whose key is binary is refused outright: the node
//   sends bytes as text it decoded with errors='replace' (PostgreSQL's bytea
//   as '<memory at 0x…>'), which matches no row, and every edit would fail as
//   if someone else had changed it. Every statement expects to change exactly one row, which is
//   what catches a key that matched nothing, or more than one row.
//
//   CONFLICTS. An edit also matches the old value of every column it changes,
//   and a delete the old value of every column, null-safe (PostgreSQL
//   `IS NOT DISTINCT FROM`, MySQL `<=>`), so a row someone else changed since
//   it was read matches no row and the apply stops instead of overwriting
//   their change. Only values that come back exactly are compared: whole
//   numbers, text, booleans, and decimals DECLARED with at most 15 digits
//   (the node sends a DECIMAL as a float, so its value cannot be trusted
//   beyond that). Floats, timestamps, JSON, binary values, unconstrained or
//   longer decimals are matched by key only (uncheckedColumns names them,
//   for edits and deletes, so Review SQL can say so).
//
//   TYPED VALUES. A form gives text; the reflected column type decides what
//   is bound: a number when a JavaScript number holds it exactly, else the
//   typed text (an integer beyond 2^53, a long decimal, any exponent form),
//   which the database reads exactly; a boolean (1 or 0 for a MySQL
//   TINYINT(1)); or the text itself. A fraction for a whole-number column is
//   refused (the database would round it), and nothing non-finite is sent.
//   Values are always bound as `$1..$n`, never written into the statement;
//   only identifiers are, quoted for the dialect, and against the table as
//   it is when the statements are built.
//
//   INSERTS omit empty fields, so the database's default applies; NULL is
//   sent only when the form says NULL.
//
// PostgreSQL and MySQL only. ClickHouse has no unique keys and runs UPDATE
// and DELETE as background mutations that report no row count, so it is
// refused with the reason, as is an engine that did not report its type.
// =============================================================================

import type { SqlApplyResult, SqlApplyStatement, SqlDialect, SqlSchemaTable } from '../connect';
import { executeGateReason } from '../executeGate';
import type { ExecuteState } from '../schema/schemaStore';
import { quoteIdent } from './paging';
import { isBinarySqlType, rrTypeFromSqlType } from './resultTypes';

// =============================================================================
// TYPES
// =============================================================================

/** A row's values, by column name. */
export type RowValues = Readonly<Record<string, unknown>>;

/** What the edits are made to. */
export interface RowEditTarget {
	/** The connection's dialect. */
	dialect: SqlDialect;
	/** The table's name. */
	table: string;
	/** The table's reflected schema (columns, types, primary key). */
	def: SqlSchemaTable;
}

/** One staged change. */
export type RowEdit =
	/** Changed fields of an existing row. */
	| { kind: 'update'; key: string; pk: RowValues; changes: RowValues; was: RowValues }
	/** A new row (`key` is local: `new:<n>`). */
	| { kind: 'insert'; key: string; values: RowValues }
	/** An existing row to delete (`original`: its values as read, for the conflict check). */
	| { kind: 'delete'; key: string; pk: RowValues; original: RowValues };

/** The staged changes of one table, in staging order. */
export interface RowEdits {
	/** The changes; at most one per row key. */
	readonly entries: readonly RowEdit[];
	/** The number the next new row's key takes. */
	readonly nextInsert: number;
}

/** Whether a table can be edited here. */
export type RowEditability = { editable: true; pk: string[] } | { editable: false; reason: string };

/** The outcome of typing one value. */
export type CoercedValue = { ok: true; value: unknown } | { ok: false; reason: string };

/** A change the model refuses; `message` is the reason, written for the user. */
export class RowEditError extends Error {
	/**
	 * @param message - The reason.
	 */
	constructor(message: string) {
		super(message);
		this.name = 'RowEditError';
	}
}

// =============================================================================
// TYPES OF VALUES
// =============================================================================

/** An integer written as text. */
const INTEGER_TEXT = /^[+-]?\d+$/;

/** A decimal or exponent number written as text. */
const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The most significant digits a JavaScript number holds exactly. */
const EXACT_DIGITS = 15;

/** Whole type-name tokens of whole-number columns. */
const INTEGER_TOKENS = /^(?:tinyint|smallint|mediumint|int|int2|int4|int8|integer|bigint|serial|serial2|serial4|serial8|smallserial|bigserial|year|u?int(?:8|16|32|64|128|256))$/i;

/** MySQL's BOOLEAN, which it reports as TINYINT(1). */
const MYSQL_BOOLEAN = /^\s*tinyint\s*\(\s*1\s*\)/i;

/** Column types that hold 64 bits or more, whose keys travel as text. */
const WIDE_INTEGER = /\b(?:bigint|int8|bigserial|serial8|u?int(?:64|128|256))\b/i;

/** Spellings of true and false a form may send. */
const TRUE_TEXT = /^(?:true|t|yes|y|on|1)$/i;
const FALSE_TEXT = /^(?:false|f|no|n|off|0)$/i;

/** Text-type tokens whose values come back exactly (compared for conflicts). */
const TEXT_TOKENS = /^(?:char|character|varchar|nchar|nvarchar|bpchar|text|tinytext|mediumtext|longtext|citext|name|uuid|enum|string)$/i;

/** Exact decimal types (compared for conflicts only when declared with at most 15 digits). */
const DECIMAL_TOKENS = /^(?:decimal|dec|numeric|fixed)$/i;

/** A decimal type's declared precision: `NUMERIC(10, 2)` -> 10. */
const DECIMAL_PRECISION = /\b(?:decimal|dec|numeric|fixed)\s*\(\s*(\d+)/i;

/** Boolean types (compared for conflicts). */
const BOOLEAN_TOKENS = /^(?:bool|boolean)$/i;

/**
 * A type name's tokens, quoted runs removed (`ENUM('int','x')` is `ENUM`).
 *
 * @param sqlType - The reflected type.
 * @returns The tokens.
 */
function typeTokens(sqlType: string): string[] {
	return sqlType.replace(/'[^']*'|"[^"]*"/g, ' ').split(/[^A-Za-z0-9]+/).filter((token) => token !== '');
}

/**
 * Whether a column type holds whole numbers only.
 *
 * @param sqlType - The reflected type.
 * @returns True for the integer types.
 */
function isWholeNumberType(sqlType: string): boolean {
	return typeTokens(sqlType).some((token) => INTEGER_TOKENS.test(token));
}

/**
 * Whether a value read from a column comes back exactly, so the database can
 * be asked whether the column still holds it (the conflict check).
 *
 * @param sqlType - The column's reflected type.
 * @param value - The value as read (undefined: the row did not carry the column).
 * @returns True for whole numbers, decimals declared with at most 15 digits, text and booleans (and NULL in any of them).
 */
function comparesExactly(sqlType: string, value: unknown): boolean {
	if (value === undefined) return false;
	const tokens = typeTokens(sqlType);
	const is = (pattern: RegExp): boolean => tokens.some((token) => pattern.test(token));
	if (is(INTEGER_TOKENS)) return value === null || (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && INTEGER_TEXT.test(value));
	if (is(DECIMAL_TOKENS)) {
		// By the DECLARED precision, never the value: the node sends a DECIMAL
		// as a float, so a numeric(38,20) value can arrive rounded and look
		// short (review P4 R3-M1). Unconstrained numeric is never compared.
		const precision = DECIMAL_PRECISION.exec(sqlType);
		if (!precision || Number(precision[1]) > EXACT_DIGITS) return false;
		if (value === null) return true;
		return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && DECIMAL_TEXT.test(value.trim()));
	}
	if (is(BOOLEAN_TOKENS)) return value === null || typeof value === 'boolean';
	if (is(TEXT_TOKENS)) return value === null || typeof value === 'string';
	return false;
}

/** What the apply says when an edit or a delete matched no row (review P4 R2-I2). */
export const ROW_CONFLICT_TEXT = 'This row was changed by someone else since you loaded it. Reload, then edit again.';

/**
 * A number from text: a JavaScript number when that holds it exactly, else
 * the text itself (the database reads it exactly). An exponent form always
 * stays text: `1e400` would become Infinity (sent as NULL), and `1e-400` 0.
 *
 * @param text - The trimmed text.
 * @param whole - The column holds whole numbers only.
 * @returns The value, or the reason it is refused.
 */
function numberFromText(text: string, whole: boolean): CoercedValue {
	if (INTEGER_TEXT.test(text)) {
		const value = Number(text);
		return { ok: true, value: Number.isSafeInteger(value) ? value : text };
	}
	if (!DECIMAL_TEXT.test(text)) return { ok: false, reason: whole ? 'needs a whole number' : 'needs a number' };
	if (whole) return { ok: false, reason: 'needs a whole number' };
	if (/[eE]/.test(text)) return { ok: true, value: text };
	const digits = text.replace(/^[+-]/, '').replace('.', '').replace(/^0+/, '');
	const value = Number(text);
	return { ok: true, value: digits.length <= EXACT_DIGITS && Number.isFinite(value) ? value : text };
}

/**
 * Type one value for a column (from a form field or from the row itself).
 *
 * @param sqlType - The column's reflected type.
 * @param raw - The value: text from a form, or a value the database returned; null is NULL.
 * @param dialect - The connection's dialect (MySQL's TINYINT(1) takes true and false).
 * @returns The value to bind, or the reason it cannot be.
 */
export function coerceValue(sqlType: string, raw: unknown, dialect: SqlDialect = 'unknown'): CoercedValue {
	if (raw === null) return { ok: true, value: null };
	if (dialect === 'mysql' && MYSQL_BOOLEAN.test(sqlType)) {
		const text = typeof raw === 'boolean' ? String(raw) : typeof raw === 'number' || typeof raw === 'string' ? String(raw).trim() : '';
		if (text === '1' || text === '0') return { ok: true, value: Number(text) };
		if (TRUE_TEXT.test(text)) return { ok: true, value: 1 };
		if (FALSE_TEXT.test(text)) return { ok: true, value: 0 };
		return { ok: false, reason: 'needs true or false (1 or 0)' };
	}
	const kind = rrTypeFromSqlType(sqlType);
	if (kind === 'number') {
		const whole = isWholeNumberType(sqlType);
		if (typeof raw === 'number') {
			if (!Number.isFinite(raw)) return { ok: false, reason: 'needs a finite number' };
			if (whole && !Number.isInteger(raw)) return { ok: false, reason: 'needs a whole number' };
			return { ok: true, value: raw };
		}
		return typeof raw === 'string' ? numberFromText(raw.trim(), whole) : { ok: false, reason: whole ? 'needs a whole number' : 'needs a number' };
	}
	if (kind === 'boolean') {
		if (typeof raw === 'boolean') return { ok: true, value: raw };
		const text = typeof raw === 'number' || typeof raw === 'string' ? String(raw).trim() : '';
		if (TRUE_TEXT.test(text)) return { ok: true, value: true };
		if (FALSE_TEXT.test(text)) return { ok: true, value: false };
		return { ok: false, reason: 'needs true or false' };
	}
	if (typeof raw === 'number' && !Number.isFinite(raw)) return { ok: false, reason: 'needs a finite number' };
	if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: raw };
	// A JSON value a driver handed back as an object: sent as its text.
	return { ok: true, value: JSON.stringify(raw) };
}

// =============================================================================
// TABLES AND KEYS
// =============================================================================

/** Why a table keyed by a binary column cannot be edited (kept as is: it names the table's key, not the table). */
const BINARY_KEY_REASON = 'This table\'s key is binary, which the node sends as text, so rows cannot be changed here. Use the Query page.';

/**
 * Whether a table can be edited here, and if not, why.
 *
 * @param dialect - The connection's dialect.
 * @param def - The table's reflected schema (null: not known).
 * @returns The key columns, or the reason.
 */
export function rowEditability(dialect: SqlDialect, def: SqlSchemaTable | null | undefined): RowEditability {
	if (dialect === 'clickhouse') {
		return { editable: false, reason: 'ClickHouse has no unique row keys, and it runs UPDATE and DELETE as background mutations, so rows cannot be edited here. Use the Query page.' };
	}
	if (dialect !== 'postgres' && dialect !== 'mysql') {
		return { editable: false, reason: 'The database did not report its type, so rows cannot be edited here.' };
	}
	const pk = def?.primary_key ?? [];
	if (!def || pk.length === 0) {
		return { editable: false, reason: 'This table has no primary key, so a row cannot be picked out exactly. Rows can be edited only in tables with a primary key.' };
	}
	if (pk.some((column) => isBinarySqlType(def.columns.find((c) => c.column === column)?.type ?? ''))) {
		return { editable: false, reason: BINARY_KEY_REASON };
	}
	return { editable: true, pk: [...pk] };
}

/**
 * Why rows of a table cannot be changed now, or null when they can: the
 * table (no primary key, ClickHouse, an engine that did not report its
 * type), a schema-only node, or no connection (in the dev tool, also no
 * sidebar to send through).
 *
 * @param input - What the data page knows.
 * @param input.dialect - The connection's dialect.
 * @param input.def - The table's reflected schema (null: not known).
 * @param input.table - The table's name.
 * @param input.executeState - Whether the node runs statements (sql/executeGate.ts).
 * @param input.ready - The engine is reachable (in a dev-tool frame, its controller too).
 * @returns The reason, or null.
 */
export function rowEditGate(input: { dialect: SqlDialect; def: SqlSchemaTable | null | undefined; table: string; executeState: ExecuteState; ready: boolean }): string | null {
	const editability = rowEditability(input.dialect, input.def);
	if (!editability.editable) return editability.reason.replace(/^This table(?!')/, input.table);
	const off = executeGateReason(input.executeState);
	if (off !== null) return off;
	if (!input.ready) return 'Not connected (in the dev tool, the SQL Explorer sidebar must be open), so rows cannot be changed now.';
	return null;
}

/**
 * The key columns of an editable target.
 *
 * @param target - The table.
 * @returns The key column names.
 * @throws RowEditError with the reason when the table cannot be edited.
 */
function keyColumns(target: RowEditTarget): string[] {
	const editability = rowEditability(target.dialect, target.def);
	if (!editability.editable) throw new RowEditError(editability.reason.replace(/^This table(?!')/, target.table));
	return editability.pk;
}

/**
 * A column's reflected type.
 *
 * @param target - The table.
 * @param column - The column.
 * @returns Its type.
 * @throws RowEditError when the table has no such column.
 */
function typeOf(target: RowEditTarget, column: string): string {
	const found = target.def.columns.find((c) => c.column === column);
	if (!found) throw new RowEditError(`${target.table} has no column ${column}.`);
	return found.type;
}

/**
 * The value one key column binds, exact.
 *
 * @param target - The table.
 * @param column - The key column.
 * @param value - The row's value in it.
 * @returns The value to bind (text for a 64-bit integer column).
 * @throws RowEditError when the value is missing or may have lost precision.
 */
function keyValue(target: RowEditTarget, column: string, value: unknown): string | number | boolean {
	if (value === null || value === undefined) throw new RowEditError(`This row has no value in its key column ${column}, so it cannot be changed here.`);
	const wide = WIDE_INTEGER.test(typeOf(target, column));
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new RowEditError(`This row's key ${column} (${value}) is larger than this app can hold exactly, so the row cannot be changed here. Use the Query page.`);
		}
		return wide ? String(value) : value;
	}
	if (typeof value === 'string' || typeof value === 'boolean') return value;
	throw new RowEditError(`This row's key ${column} is not a value this app can match exactly, so the row cannot be changed here.`);
}

/**
 * A row's key values, exact.
 *
 * @param target - The table.
 * @param row - The row (by column name).
 * @returns Key column -> bound value.
 */
function keyValues(target: RowEditTarget, row: RowValues): RowValues {
	return Object.fromEntries(keyColumns(target).map((column) => [column, keyValue(target, column, row[column])]));
}

/**
 * The stable name of a row: its key values (a number and its text are the same key).
 *
 * @param target - The table.
 * @param row - The row.
 * @returns The key.
 * @throws RowEditError when the table cannot be edited or the row's key is not exact.
 */
export function rowKey(target: RowEditTarget, row: RowValues): string {
	const pk = keyValues(target, row);
	return JSON.stringify(Object.values(pk).map((value) => String(value)));
}

/**
 * Two values the same for the database's purposes (a number and its text are).
 *
 * @param a - One.
 * @param b - The other.
 * @returns True when equal.
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || a === undefined || b === undefined) return false;
	return typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b);
}

/**
 * Type a set of form fields for the table, dropping what an insert leaves to the default.
 *
 * @param target - The table.
 * @param fields - Column -> raw value.
 * @param forInsert - Omit empty text and undefined (the default applies).
 * @returns Column -> bound value.
 * @throws RowEditError naming the column and its need.
 */
function typedFields(target: RowEditTarget, fields: RowValues, forInsert: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [column, raw] of Object.entries(fields)) {
		const type = typeOf(target, column);
		if (raw === undefined || (forInsert && raw === '')) continue;
		const typed = coerceValue(type, raw, target.dialect);
		if (!typed.ok) throw new RowEditError(`${column} ${typed.reason}.`);
		out[column] = typed.value;
	}
	return out;
}

/**
 * Order a record's columns the way the table orders them.
 *
 * @param target - The table.
 * @param values - Column -> value.
 * @returns The columns present, in table order.
 */
function inTableOrder(target: RowEditTarget, values: RowValues): string[] {
	return target.def.columns.map((c) => c.column).filter((column) => Object.prototype.hasOwnProperty.call(values, column));
}

// =============================================================================
// THE MODEL
// =============================================================================

/**
 * No staged changes.
 *
 * @returns The empty model.
 */
export function emptyRowEdits(): RowEdits {
	return { entries: [], nextInsert: 1 };
}

/**
 * The staged change for a row key, if any.
 *
 * @param edits - The model.
 * @param key - A row key ({@link rowKey}) or a new row's key.
 * @returns The change.
 */
export function pendingOf(edits: RowEdits, key: string): RowEdit | undefined {
	return edits.entries.find((edit) => edit.key === key);
}

/**
 * Replace (in place, keeping its position), add, or remove the change for one key.
 *
 * @param edits - The model.
 * @param key - The key.
 * @param next - The change, or null to remove it.
 * @returns The new model.
 */
function put(edits: RowEdits, key: string, next: RowEdit | null): RowEdits {
	const at = edits.entries.findIndex((edit) => edit.key === key);
	const entries = [...edits.entries];
	if (at === -1) {
		if (next !== null) entries.push(next);
	} else if (next === null) {
		entries.splice(at, 1);
	} else {
		entries[at] = next;
	}
	return { ...edits, entries };
}

/**
 * Stage changed fields of an existing row. Fields set back to the row's own
 * value drop out; a row left with no change is unstaged.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param row - The row as the database returned it.
 * @param changes - Column -> new raw value (text from a form, or null for NULL).
 * @returns The new model.
 * @throws RowEditError with the reason (a key column, a bad value, a row marked for deletion).
 */
export function stageUpdate(edits: RowEdits, target: RowEditTarget, row: RowValues, changes: RowValues): RowEdits {
	const pk = keyColumns(target);
	const key = rowKey(target, row);
	const existing = pendingOf(edits, key);
	if (existing?.kind === 'delete') throw new RowEditError('This row is marked for deletion. Undo that before editing it.');
	for (const column of Object.keys(changes)) {
		typeOf(target, column);
		if (pk.includes(column)) throw new RowEditError(`${column} is part of the key, so it cannot be changed here.`);
	}
	const typed = typedFields(target, changes, false);
	const merged: Record<string, unknown> = { ...(existing?.kind === 'update' ? existing.changes : {}) };
	const was: Record<string, unknown> = { ...(existing?.kind === 'update' ? existing.was : {}) };
	for (const [column, value] of Object.entries(typed)) {
		const original = row[column] ?? null;
		if (sameValue(value, original)) {
			delete merged[column];
			delete was[column];
		} else {
			merged[column] = value;
			was[column] = original;
		}
	}
	if (Object.keys(merged).length === 0) return put(edits, key, null);
	return put(edits, key, { kind: 'update', key, pk: keyValues(target, row), changes: merged, was });
}

/**
 * Stage a new row. Empty fields are left out, so the database's default applies.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param values - Column -> raw value.
 * @returns The new model (the row's key is `new:<n>`).
 * @throws RowEditError with the reason.
 */
export function stageInsert(edits: RowEdits, target: RowEditTarget, values: RowValues): RowEdits {
	keyColumns(target);
	const key = `new:${edits.nextInsert}`;
	const next = put(edits, key, { kind: 'insert', key, values: typedFields(target, values, true) });
	return { ...next, nextInsert: edits.nextInsert + 1 };
}

/**
 * Replace a new row's values before it is applied.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param key - The new row's key.
 * @param values - Column -> raw value (the whole row; empty fields take the default).
 * @returns The new model.
 * @throws RowEditError with the reason, or when there is no such new row.
 */
export function updateInsert(edits: RowEdits, target: RowEditTarget, key: string, values: RowValues): RowEdits {
	keyColumns(target);
	if (pendingOf(edits, key)?.kind !== 'insert') throw new RowEditError('That new row is no longer staged.');
	return put(edits, key, { kind: 'insert', key, values: typedFields(target, values, true) });
}

/**
 * Stage a row's deletion (replacing any edit to it). Deleting a new row just drops it.
 *
 * @param edits - The model.
 * @param target - The table.
 * @param row - The row as the database returned it, or a new row's key.
 * @returns The new model.
 * @throws RowEditError with the reason.
 */
export function stageDelete(edits: RowEdits, target: RowEditTarget, row: RowValues | string): RowEdits {
	keyColumns(target);
	if (typeof row === 'string') {
		if (pendingOf(edits, row)?.kind !== 'insert') throw new RowEditError('That new row is no longer staged.');
		return put(edits, row, null);
	}
	const key = rowKey(target, row);
	const original = Object.fromEntries(target.def.columns.filter((c) => Object.prototype.hasOwnProperty.call(row, c.column)).map((c) => [c.column, row[c.column]]));
	return put(edits, key, { kind: 'delete', key, pk: keyValues(target, row), original });
}

/**
 * Drop the staged change for one key (undo one row).
 *
 * @param edits - The model.
 * @param key - The key.
 * @returns The new model.
 */
export function unstage(edits: RowEdits, key: string): RowEdits {
	return put(edits, key, null);
}

/**
 * Drop the changes an apply settled, by their keys: the keys of the first
 * {@link settledCount} statements it SENT (one per change, in order). Not by
 * position in the current list, which may have changed while the apply ran
 * (review P4 R2-I4). After a rolled-back transaction nothing is settled, and
 * every change stays staged.
 *
 * @param edits - The staged changes now.
 * @param keys - The keys of the settled changes.
 * @returns The changes still to apply.
 */
export function dropKeys(edits: RowEdits, keys: readonly string[]): RowEdits {
	if (keys.length === 0) return edits;
	const settled = new Set(keys);
	return { ...edits, entries: edits.entries.filter((edit) => !settled.has(edit.key)) };
}

/**
 * How many of the changes an apply sent are settled: saved, or possibly
 * saved, and so not to be staged again without the user seeing them. All
 * after success; none after a rolled-back transaction; per statement, the
 * committed ones, plus the failed one when its outcome is unknown (it is
 * dropped, and the result says to check the data).
 *
 * @param result - The apply's reply.
 * @param total - How many changes it sent.
 * @returns How many of the sent changes are settled ({@link dropKeys} drops their keys).
 */
export function settledCount(result: SqlApplyResult, total: number): number {
	const failure = result.failure;
	if (failure === null) return total;
	if (result.transactional) return 0;
	return Math.min(total, failure.committed + (failure.unknown ? 1 : 0));
}

/**
 * How many rows each kind of change touches.
 *
 * @param edits - The model.
 * @returns The counts.
 */
export function rowEditCounts(edits: RowEdits): { edited: number; inserted: number; deleted: number; total: number } {
	const count = (kind: RowEdit['kind']): number => edits.entries.filter((edit) => edit.kind === kind).length;
	return { edited: count('update'), inserted: count('insert'), deleted: count('delete'), total: edits.entries.length };
}

// =============================================================================
// THE GRID AND THE FORM
// =============================================================================

/** What a grid cell of a staged row shows. */
export type PendingCell =
	/** This field is edited: its new value, and what it was. */
	| { kind: 'edited'; value: unknown; was: unknown }
	/** Another field of this row is edited. */
	| { kind: 'row-edited' }
	/** The row is staged for deletion. */
	| { kind: 'deleted' };

/**
 * What a grid cell shows for the row it belongs to. The row must be the
 * PRISTINE row as fetched, never the object the grid was handed (Tabulator
 * writes into those; PLAN-MAP fact 4): the caller finds it by position.
 *
 * @param edits - The staged changes.
 * @param target - The table.
 * @param row - The pristine row.
 * @param column - The cell's column.
 * @returns The mark, or null for a row with nothing staged (or no exact key).
 */
export function pendingCell(edits: RowEdits, target: RowEditTarget, row: RowValues, column: string): PendingCell | null {
	if (edits.entries.length === 0) return null;
	let key: string;
	try {
		key = rowKey(target, row);
	} catch {
		return null;
	}
	const edit = pendingOf(edits, key);
	if (edit?.kind === 'delete') return { kind: 'deleted' };
	if (edit?.kind !== 'update') return null;
	return Object.prototype.hasOwnProperty.call(edit.changes, column)
		? { kind: 'edited', value: edit.changes[column], was: edit.was[column] ?? null }
		: { kind: 'row-edited' };
}

/** One field of the record drawer's edit form. */
export interface FormField {
	/** The column. */
	column: string;
	/** Its reflected type (shown, and what the value is typed by). */
	type: string;
	/** Part of the key: shown, never edited. */
	key: boolean;
	/** The value as text ('' when NULL, or empty in a new row). */
	text: string;
	/** The NULL toggle. */
	isNull: boolean;
}

/**
 * A value as the form's text.
 *
 * @param value - The value.
 * @returns Its text.
 */
function formText(value: unknown): string {
	if (value === null || value === undefined) return '';
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * The edit form's fields, in table order: a row's values (with any staged
 * edit showing through), or an empty form for a new row (with a staged new
 * row's values when it is edited again).
 *
 * @param target - The table.
 * @param row - The pristine row, or null for a new row.
 * @param pending - The row's staged change, if any.
 * @returns The fields.
 */
export function editFormFields(target: RowEditTarget, row: RowValues | null, pending: RowEdit | undefined): FormField[] {
	const pk = target.def.primary_key ?? [];
	return target.def.columns.map(({ column, type }) => {
		let has = row !== null && Object.prototype.hasOwnProperty.call(row, column);
		let value: unknown = row?.[column];
		if (pending?.kind === 'update' && Object.prototype.hasOwnProperty.call(pending.changes, column)) {
			has = true;
			value = pending.changes[column];
		} else if (pending?.kind === 'insert') {
			has = Object.prototype.hasOwnProperty.call(pending.values, column);
			value = pending.values[column];
		}
		const isNull = has && (value === null || value === undefined);
		return { column, type, key: pk.includes(column), text: isNull ? '' : formText(value), isNull };
	});
}

/**
 * The fields the user changed, for {@link stageUpdate}: NULL when toggled,
 * the text otherwise. Key columns never.
 *
 * @param before - The fields the form opened with.
 * @param after - The fields as the user left them.
 * @returns Column -> new raw value.
 */
export function changesFromForm(before: readonly FormField[], after: readonly FormField[]): Record<string, unknown> {
	const changes: Record<string, unknown> = {};
	for (const field of after) {
		const was = before.find((f) => f.column === field.column);
		if (field.key || !was) continue;
		if (was.isNull !== field.isNull || (!field.isNull && was.text !== field.text)) changes[field.column] = field.isNull ? null : field.text;
	}
	return changes;
}

/**
 * A new row's values, for {@link stageInsert}: NULL when toggled, the text
 * otherwise ('' is left to the column default).
 *
 * @param fields - The form's fields.
 * @returns Column -> raw value.
 */
export function valuesFromForm(fields: readonly FormField[]): Record<string, unknown> {
	return Object.fromEntries(fields.map((field) => [field.column, field.isNull ? null : field.text]));
}

// =============================================================================
// STATEMENTS
// =============================================================================

/**
 * The statements Apply sends, one per change in staging order, each bound
 * and expected to change exactly one row.
 *
 * @param edits - The model.
 * @param target - The table.
 * @returns The statements.
 * @throws RowEditError when the table cannot be edited.
 */
export function buildRowStatements(edits: RowEdits, target: RowEditTarget): SqlApplyStatement[] {
	const pk = keyColumns(target);
	const q = (name: string): string => quoteIdent(target.dialect, name);
	const table = q(target.table);
	const restage = 'Discard them and stage them again.';
	// The table may have changed since the edits were staged (a schema
	// refresh): build nothing that would aim at another row, or drop a value.
	const sameKey = (keys: RowValues): boolean => {
		const names = Object.keys(keys);
		return names.length === pk.length && pk.every((column) => names.includes(column));
	};
	const known = (columns: string[]): void => {
		for (const column of columns) {
			if (!target.def.columns.some((c) => c.column === column)) throw new RowEditError(`${target.table} no longer has a column ${column}, so these changes cannot be applied. ${restage}`);
		}
	};
	for (const edit of edits.entries) {
		if (edit.kind !== 'insert' && !sameKey(edit.pk)) throw new RowEditError(`The table's key changed since these changes were staged, so they cannot be applied. ${restage}`);
		if (edit.kind === 'update') {
			if (Object.keys(edit.changes).length === 0) throw new RowEditError('A staged edit has no change left to apply.');
			known(Object.keys(edit.changes));
			if (Object.keys(edit.changes).some((column) => pk.includes(column))) throw new RowEditError(`The table's key changed since these changes were staged, so they cannot be applied. ${restage}`);
		}
		if (edit.kind === 'insert') known(Object.keys(edit.values));
	}
	return edits.entries.map((edit) => {
		const params: unknown[] = [];
		const bind = (value: unknown): string => {
			params.push(value);
			return `$${params.length}`;
		};
		// The key, then the old value of each column that compares exactly
		// (null-safe), so a row changed since it was read matches nothing.
		const sameAs = target.dialect === 'mysql' ? '<=>' : 'IS NOT DISTINCT FROM';
		const where = (keys: RowValues, old: RowValues, columns: string[]): string => [
			...pk.map((column) => `${q(column)} = ${bind(keys[column])}`),
			...columns.filter((column) => comparesExactly(typeOf(target, column), old[column])).map((column) => `${q(column)} ${sameAs} ${bind(old[column])}`),
		].join(' AND ');
		if (edit.kind === 'update') {
			const changed = inTableOrder(target, edit.changes);
			const set = changed.map((column) => `${q(column)} = ${bind(edit.changes[column])}`).join(', ');
			return { sql: `UPDATE ${table} SET ${set} WHERE ${where(edit.pk, edit.was, changed)}`, params, expect: 1 };
		}
		if (edit.kind === 'delete') {
			const others = inTableOrder(target, edit.original).filter((column) => !pk.includes(column));
			return { sql: `DELETE FROM ${table} WHERE ${where(edit.pk, edit.original, others)}`, params, expect: 1 };
		}
		const columns = inTableOrder(target, edit.values);
		if (columns.length === 0) {
			// Every column takes its default.
			const sql = target.dialect === 'mysql' ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES`;
			return { sql, params, expect: 1 };
		}
		const values = columns.map((column) => bind(edit.values[column])).join(', ');
		return { sql: `INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES (${values})`, params, expect: 1 };
	});
}

/**
 * The columns staged changes match by key only: an edit's changed columns,
 * and a delete's other columns, whose old values cannot be compared exactly
 * (Review SQL says so).
 *
 * @param edits - The staged changes.
 * @param target - The table.
 * @returns The columns, once each, in table order.
 */
export function uncheckedColumns(edits: RowEdits, target: RowEditTarget): string[] {
	const pk = target.def.primary_key ?? [];
	const unchecked = new Set<string>();
	const check = (column: string, value: unknown): void => {
		const found = target.def.columns.find((c) => c.column === column);
		if (found && !comparesExactly(found.type, value)) unchecked.add(column);
	};
	for (const edit of edits.entries) {
		if (edit.kind === 'update') for (const column of Object.keys(edit.changes)) check(column, edit.was[column]);
		if (edit.kind === 'delete') for (const column of Object.keys(edit.original)) if (!pk.includes(column)) check(column, edit.original[column]);
	}
	return target.def.columns.map((c) => c.column).filter((column) => unchecked.has(column));
}

// =============================================================================
// WORDING
// =============================================================================

/** Longest value shown in a one-line description. */
const MAX_SHOWN_VALUE = 40;

/**
 * A value as one short line of text.
 *
 * @param value - The value.
 * @returns Its text (NULL for null), shortened.
 */
function shown(value: unknown): string {
	const text = value === null || value === undefined ? 'NULL' : String(value).replace(/\s+/g, ' ');
	return text.length > MAX_SHOWN_VALUE ? `${text.slice(0, MAX_SHOWN_VALUE - 1)}…` : text;
}

/**
 * One line for a change, for the Apply confirmation:
 * `Edit row 5: status pending → paid`, `New row: status pending`, `Delete row 14`.
 *
 * @param edit - The change.
 * @param target - The table.
 * @returns The line.
 */
export function describeRowEdit(edit: RowEdit, target: RowEditTarget): string {
	if (edit.kind === 'insert') {
		const columns = inTableOrder(target, edit.values);
		return columns.length === 0 ? 'New row (every column takes its default)' : `New row: ${columns.map((column) => `${column} ${shown(edit.values[column])}`).join(', ')}`;
	}
	const parts = Object.values(edit.pk).map(shown);
	const row = parts.length === 1 ? `row ${parts[0]}` : `row (${parts.join(', ')})`;
	if (edit.kind === 'delete') return `Delete ${row}`;
	const changes = inTableOrder(target, edit.changes).map((column) => `${column} ${shown(edit.was[column])} → ${shown(edit.changes[column])}`);
	return `Edit ${row}: ${changes.join(', ')}`;
}
