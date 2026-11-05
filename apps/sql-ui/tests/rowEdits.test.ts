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
// ROW EDITS — staged grid changes -> bound UPDATE / INSERT / DELETE
// =============================================================================
//
// The pending-changes model the data browser stages into (sql/rowEdits.ts):
// keyed by primary key, typed by the reflected column types, and turned into
// one bound statement per change, each expected to change exactly one row.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlSchemaTable } from '../src/connect';
import {
	RowEditError,
	buildRowStatements,
	coerceValue,
	describeRowEdit,
	dropKeys,
	changesFromForm,
	editFormFields,
	pendingCell,
	rowEditGate,
	settledCount,
	uncheckedColumns,
	valuesFromForm,
	emptyRowEdits,
	pendingOf,
	rowEditCounts,
	rowEditability,
	rowKey,
	stageDelete,
	stageInsert,
	stageUpdate,
	unstage,
	updateInsert,
} from '../src/sql/rowEdits';
import type { RowEditTarget } from '../src/sql/rowEdits';

// =============================================================================
// FIXTURES
// =============================================================================

const ORDERS: SqlSchemaTable = {
	columns: [
		{ column: 'order_id', type: 'INTEGER' },
		{ column: 'customer_id', type: 'INTEGER' },
		{ column: 'quantity', type: 'INTEGER' },
		{ column: 'total', type: 'NUMERIC(10, 2)' },
		{ column: 'status', type: 'VARCHAR(20)' },
		{ column: 'paid', type: 'BOOLEAN' },
		{ column: 'ordered_at', type: 'TIMESTAMP' },
	],
	primary_key: ['order_id'],
};

/** A composite key, one part a 64-bit integer. */
const LINES: SqlSchemaTable = {
	columns: [
		{ column: 'order_id', type: 'BIGINT' },
		{ column: 'line', type: 'INTEGER' },
		{ column: 'note', type: 'TEXT' },
	],
	primary_key: ['order_id', 'line'],
};

const pg = (def: SqlSchemaTable = ORDERS, table = 'orders'): RowEditTarget => ({ dialect: 'postgres', table, def });
const my = (def: SqlSchemaTable = ORDERS, table = 'orders'): RowEditTarget => ({ dialect: 'mysql', table, def });

const ROW = { order_id: 5, customer_id: 3, quantity: 1, total: 96.5, status: 'pending', paid: false, ordered_at: '2026-02-02T14:02:00' };

/**
 * Whether a call throws a RowEditError whose reason matches.
 *
 * @param fn - The call.
 * @param reason - What the reason must say.
 */
function refuses(fn: () => unknown, reason: RegExp): void {
	assert.throws(fn, (error: unknown) => error instanceof RowEditError && reason.test(error.message));
}

// =============================================================================
// EDITABILITY
// =============================================================================

// =============================================================================
// BINARY KEYS (DA-R2 I1)
// =============================================================================
//
// The node sends bytes as text: `bytes.decode('utf-8', errors='replace')`
// puts U+FFFD for every byte that is not UTF-8, and PostgreSQL's bytea
// arrives as '<memory at 0x…>'. Live MySQL: a BINARY(16) key stored as
// 11F0A2B3C4D5E6F7… was bound back as 11EFBFBDEFBFBD… and matched 0 rows, so
// every edit failed as "changed by someone else". Such a table is refused.
// =============================================================================

/** What the node sends for BINARY(16) UNHEX('11f0a2b3c4d5e6f708192a3b4c5d6e7f') (DA-R2). */
const DECODED_KEY = JSON.parse('"\\u0011\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\\b\\u0019*;L]n\\u007f"') as string;

/** A table keyed by a UUID kept as BINARY(16). */
const TOKENS: SqlSchemaTable = {
	columns: [{ column: 'id', type: 'BINARY(16)' }, { column: 'note', type: 'VARCHAR(20)' }],
	primary_key: ['id'],
};

/** The refusal, word for word. */
const BINARY_KEY = 'This table\'s key is binary, which the node sends as text, so rows cannot be changed here. Use the Query page.';

describe('a table keyed by a binary column cannot be edited (DA-R2 I1)', () => {
	it('is refused for every binary key type, on both engines, with the reason', () => {
		for (const type of ['BINARY(16)', 'VARBINARY(255)', 'BLOB', 'LONGBLOB', 'BYTEA', 'BIT(1)', 'BIT VARYING(8)']) {
			for (const dialect of ['postgres', 'mysql'] as const) {
				const result = rowEditability(dialect, { columns: [{ column: 'id', type }, { column: 'note', type: 'TEXT' }], primary_key: ['id'] });
				assert.deepEqual(result, { editable: false, reason: BINARY_KEY }, `${dialect} ${type}`);
			}
		}
	});

	it('is refused when any part of a composite key is binary', () => {
		const composite: SqlSchemaTable = { columns: [{ column: 'tenant', type: 'INTEGER' }, { column: 'token', type: 'VARBINARY(32)' }], primary_key: ['tenant', 'token'] };
		assert.equal(rowEditability('mysql', composite).editable, false);
	});

	it('the data page says so, and no statement binds the text the node decoded', () => {
		assert.equal(rowEditGate({ dialect: 'mysql', def: TOKENS, table: 'tokens', executeState: 'on', ready: true }), BINARY_KEY);
		refuses(() => stageUpdate(emptyRowEdits(), my(TOKENS, 'tokens'), { id: DECODED_KEY, note: 'old' }, { note: 'new' }), /key is binary/);
		refuses(() => stageDelete(emptyRowEdits(), my(TOKENS, 'tokens'), { id: DECODED_KEY, note: 'old' }), /key is binary/);
		refuses(() => rowKey(pg({ ...TOKENS, columns: [{ column: 'id', type: 'BYTEA' }, { column: 'note', type: 'TEXT' }] }, 'tokens'), { id: '<memory at 0x7f3a2c1b0e80>' }), /key is binary/);
	});

	it('a binary column outside the key, or a word that only contains "bit", does not block editing', () => {
		const withBlob: SqlSchemaTable = { columns: [{ column: 'id', type: 'INTEGER' }, { column: 'photo', type: 'BLOB' }], primary_key: ['id'] };
		assert.deepEqual(rowEditability('mysql', withBlob), { editable: true, pk: ['id'] });
		const orbit: SqlSchemaTable = { columns: [{ column: 'id', type: 'ORBIT' }], primary_key: ['id'] };
		assert.equal(rowEditability('postgres', orbit).editable, true);
	});
});

describe('which tables can be edited', () => {
	it('a table with a primary key on PostgreSQL or MySQL', () => {
		assert.deepEqual(rowEditability('postgres', ORDERS), { editable: true, pk: ['order_id'] });
		assert.deepEqual(rowEditability('mysql', LINES), { editable: true, pk: ['order_id', 'line'] });
	});

	it('refuses a table without a primary key, and says why', () => {
		const result = rowEditability('postgres', { columns: ORDERS.columns });
		assert.equal(result.editable, false);
		assert.match(result.editable ? '' : result.reason, /has no primary key/);
		assert.equal(rowEditability('postgres', { columns: ORDERS.columns, primary_key: [] }).editable, false);
		assert.equal(rowEditability('postgres', null).editable, false);
	});

	it('refuses ClickHouse (no unique key; updates are background mutations) and an unknown engine, with reasons', () => {
		const ch = rowEditability('clickhouse', ORDERS);
		assert.match(ch.editable ? '' : ch.reason, /ClickHouse/);
		const unknown = rowEditability('unknown', ORDERS);
		assert.match(unknown.editable ? '' : unknown.reason, /did not report its type/);
	});

	it('every staging call refuses a table that cannot be edited', () => {
		refuses(() => stageUpdate(emptyRowEdits(), { dialect: 'postgres', table: 'logs', def: { columns: ORDERS.columns } }, ROW, { status: 'paid' }), /has no primary key/);
		refuses(() => stageInsert(emptyRowEdits(), { dialect: 'clickhouse', table: 'orders', def: ORDERS }, { status: 'x' }), /ClickHouse/);
	});
});

// =============================================================================
// STATEMENTS PER DIALECT
// =============================================================================

describe('statements: quoted identifiers, bound values, one row each', () => {
	it('postgres: UPDATE, INSERT and DELETE with double-quoted names and $n binds', () => {
		let edits = stageUpdate(emptyRowEdits(), pg(), ROW, { status: 'paid' });
		edits = stageInsert(edits, pg(), { customer_id: '3', status: 'pending' });
		edits = stageDelete(edits, pg(), { ...ROW, order_id: 14 });
		assert.deepEqual(buildRowStatements(edits, pg()), [
			{ sql: 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2 AND "status" IS NOT DISTINCT FROM $3', params: ['paid', 5, 'pending'], expect: 1 },
			{ sql: 'INSERT INTO "orders" ("customer_id", "status") VALUES ($1, $2)', params: [3, 'pending'], expect: 1 },
			{ sql: 'DELETE FROM "orders" WHERE "order_id" = $1 AND "customer_id" IS NOT DISTINCT FROM $2 AND "quantity" IS NOT DISTINCT FROM $3 AND "total" IS NOT DISTINCT FROM $4 AND "status" IS NOT DISTINCT FROM $5 AND "paid" IS NOT DISTINCT FROM $6', params: [14, 3, 1, 96.5, 'pending', false], expect: 1 },
		]);
	});

	it('mysql: the same, with backticks', () => {
		let edits = stageUpdate(emptyRowEdits(), my(), ROW, { status: 'paid' });
		edits = stageInsert(edits, my(), { customer_id: '3' });
		edits = stageDelete(edits, my(), { ...ROW, order_id: 14 });
		assert.deepEqual(buildRowStatements(edits, my()).map((statement) => statement.sql), [
			'UPDATE `orders` SET `status` = $1 WHERE `order_id` = $2 AND `status` <=> $3',
			'INSERT INTO `orders` (`customer_id`) VALUES ($1)',
			'DELETE FROM `orders` WHERE `order_id` = $1 AND `customer_id` <=> $2 AND `quantity` <=> $3 AND `total` <=> $4 AND `status` <=> $5 AND `paid` <=> $6',
		]);
	});

	it('a name that holds the quote character is escaped by doubling it, never left to end the identifier', () => {
		const def: SqlSchemaTable = { columns: [{ column: 'id', type: 'INT' }, { column: 'we"ird`', type: 'TEXT' }], primary_key: ['id'] };
		const pgEdits = stageUpdate(emptyRowEdits(), pg(def, 'my"table'), { id: 1, 'we"ird`': 'a' }, { 'we"ird`': 'b' });
		assert.equal(buildRowStatements(pgEdits, pg(def, 'my"table'))[0]!.sql, 'UPDATE "my""table" SET "we""ird`" = $1 WHERE "id" = $2 AND "we""ird`" IS NOT DISTINCT FROM $3');
		const myEdits = stageUpdate(emptyRowEdits(), my(def, 'my`table'), { id: 1, 'we"ird`': 'a' }, { 'we"ird`': 'b' });
		assert.equal(buildRowStatements(myEdits, my(def, 'my`table'))[0]!.sql, 'UPDATE `my``table` SET `we"ird``` = $1 WHERE `id` = $2 AND `we"ird``` <=> $3');
	});

	it('values never reach the statement text, however they look', () => {
		const edits = stageUpdate(emptyRowEdits(), pg(), ROW, { status: "x'; DROP TABLE orders; --" });
		const [statement] = buildRowStatements(edits, pg());
		assert.equal(statement!.sql, 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2 AND "status" IS NOT DISTINCT FROM $3');
		assert.deepEqual(statement!.params, ["x'; DROP TABLE orders; --", 5, 'pending']);
	});

	it('a composite key matches on every part, in key order', () => {
		const edits = stageUpdate(emptyRowEdits(), pg(LINES, 'order_lines'), { order_id: 7, line: 2, note: 'a' }, { note: 'b' });
		assert.deepEqual(buildRowStatements(edits, pg(LINES, 'order_lines')), [
			{ sql: 'UPDATE "order_lines" SET "note" = $1 WHERE "order_id" = $2 AND "line" = $3 AND "note" IS NOT DISTINCT FROM $4', params: ['b', '7', 2, 'a'], expect: 1 },
		]);
		const deleted = stageDelete(emptyRowEdits(), my(LINES, 'order_lines'), { order_id: '9007199254740993', line: 1, note: null });
		assert.deepEqual(buildRowStatements(deleted, my(LINES, 'order_lines')), [
			{ sql: 'DELETE FROM `order_lines` WHERE `order_id` = $1 AND `line` = $2 AND `note` <=> $3', params: ['9007199254740993', 1, null], expect: 1 },
		]);
	});

	it('NULL: an edit can set it (bound), an insert can send it, and an empty insert field is left to the default', () => {
		let edits = stageUpdate(emptyRowEdits(), pg(), ROW, { status: null, quantity: null });
		edits = stageInsert(edits, pg(), { customer_id: null, status: '', quantity: undefined });
		assert.deepEqual(buildRowStatements(edits, pg()), [
			{ sql: 'UPDATE "orders" SET "quantity" = $1, "status" = $2 WHERE "order_id" = $3 AND "quantity" IS NOT DISTINCT FROM $4 AND "status" IS NOT DISTINCT FROM $5', params: [null, null, 5, 1, 'pending'], expect: 1 },
			{ sql: 'INSERT INTO "orders" ("customer_id") VALUES ($1)', params: [null], expect: 1 },
		]);
	});

	it('an insert with every field empty takes every default', () => {
		assert.deepEqual(buildRowStatements(stageInsert(emptyRowEdits(), pg(), {}), pg()), [{ sql: 'INSERT INTO "orders" DEFAULT VALUES', params: [], expect: 1 }]);
		assert.deepEqual(buildRowStatements(stageInsert(emptyRowEdits(), my(), { status: '' }), my()), [{ sql: 'INSERT INTO `orders` () VALUES ()', params: [], expect: 1 }]);
	});

	it('columns are written in the table\'s order, whatever order the form sent them in', () => {
		const edits = stageInsert(emptyRowEdits(), pg(), { status: 'new', customer_id: 4 });
		assert.equal(buildRowStatements(edits, pg())[0]!.sql, 'INSERT INTO "orders" ("customer_id", "status") VALUES ($1, $2)');
	});
});

// =============================================================================
// KEYS
// =============================================================================

describe('keys: exact, or the row is not touched', () => {
	it('a 64-bit key is sent as a string, so it is never rounded on the way', () => {
		const target = pg(LINES, 'order_lines');
		const edits = stageDelete(emptyRowEdits(), target, { order_id: '9223372036854775807', line: 1 });
		assert.deepEqual(buildRowStatements(edits, target)[0]!.params, ['9223372036854775807', 1]);
		// A safe one too, so a 64-bit key always travels the same way.
		assert.deepEqual(buildRowStatements(stageDelete(emptyRowEdits(), target, { order_id: 42, line: 1 }), target)[0]!.params, ['42', 1]);
	});

	it('refuses a key that already lost precision as a JavaScript number (it could name another row)', () => {
		refuses(() => stageDelete(emptyRowEdits(), pg(LINES, 'order_lines'), { order_id: Number.MAX_SAFE_INTEGER + 2, line: 1 }), /larger than this app can hold exactly/);
		refuses(() => rowKey(pg(), { ...ROW, order_id: 2 ** 60 }), /larger than this app can hold exactly/);
	});

	it('refuses a row without a value in a key column', () => {
		refuses(() => stageDelete(emptyRowEdits(), pg(), { ...ROW, order_id: null }), /no value in its key column order_id/);
		refuses(() => stageUpdate(emptyRowEdits(), pg(), { status: 'x' }, { status: 'y' }), /no value in its key column order_id/);
	});

	it('key columns are read-only: an edit to one is refused', () => {
		refuses(() => stageUpdate(emptyRowEdits(), pg(), ROW, { order_id: 6 }), /order_id is part of the key/);
	});

	it('the same row is the same key, whether its key arrived as a number or as text', () => {
		assert.equal(rowKey(pg(), ROW), rowKey(pg(), { ...ROW, order_id: '5' }));
		assert.notEqual(rowKey(pg(), ROW), rowKey(pg(), { ...ROW, order_id: 6 }));
	});
});

// =============================================================================
// TYPES
// =============================================================================

describe('values are typed by the reflected column type', () => {
	it('numbers: text becomes a number; a 64-bit integer or a long decimal stays exact text', () => {
		assert.deepEqual(coerceValue('INTEGER', ' 42 '), { ok: true, value: 42 });
		assert.deepEqual(coerceValue('NUMERIC(10,2)', '96.50'), { ok: true, value: 96.5 });
		assert.deepEqual(coerceValue('BIGINT', '9007199254740993'), { ok: true, value: '9007199254740993' });
		assert.deepEqual(coerceValue('NUMERIC(30,10)', '12345678901234567890.0123456789'), { ok: true, value: '12345678901234567890.0123456789' });
		assert.deepEqual(coerceValue('INTEGER', 7), { ok: true, value: 7 });
	});

	it('numbers: anything else is refused with the column\'s need', () => {
		for (const raw of ['', 'abc', '1,000', '12abc', true]) {
			const result = coerceValue('INTEGER', raw);
			assert.equal(result.ok, false, String(raw));
			assert.match(result.ok ? '' : result.reason, /needs a (?:whole )?number/);
		}
		const decimal = coerceValue('NUMERIC(10,2)', 'abc');
		assert.match(decimal.ok ? '' : decimal.reason, /^needs a number$/);
	});

	it('booleans: true/false in the usual spellings, as real booleans', () => {
		for (const raw of ['true', 'T', 'yes', '1', 'on', 1, true]) assert.deepEqual(coerceValue('BOOLEAN', raw), { ok: true, value: true }, String(raw));
		for (const raw of ['false', 'f', 'NO', '0', 'off', 0, false]) assert.deepEqual(coerceValue('bool', raw), { ok: true, value: false }, String(raw));
		const bad = coerceValue('BOOLEAN', 'maybe');
		assert.match(bad.ok ? '' : bad.reason, /needs true or false/);
	});

	it('text, dates and JSON pass through as typed; NULL is NULL everywhere', () => {
		assert.deepEqual(coerceValue('VARCHAR(20)', ' padded '), { ok: true, value: ' padded ' });
		assert.deepEqual(coerceValue('VARCHAR(20)', ''), { ok: true, value: '' });
		assert.deepEqual(coerceValue('TIMESTAMP', '2026-02-02 14:02:00'), { ok: true, value: '2026-02-02 14:02:00' });
		assert.deepEqual(coerceValue('JSONB', { a: [1] }), { ok: true, value: '{"a":[1]}' });
		for (const type of ['INTEGER', 'BOOLEAN', 'TEXT']) assert.deepEqual(coerceValue(type, null), { ok: true, value: null });
	});

	it('staging coerces: a typed number goes out as a number, and a bad value is refused with its reason', () => {
		const edits = stageUpdate(emptyRowEdits(), pg(), ROW, { quantity: '3', paid: 'true' });
		assert.deepEqual(buildRowStatements(edits, pg())[0]!.params, [3, true, 5, 1, false]);
		refuses(() => stageUpdate(emptyRowEdits(), pg(), ROW, { quantity: 'three' }), /quantity needs a whole number/);
		refuses(() => stageInsert(emptyRowEdits(), pg(), { paid: 'maybe' }), /paid needs true or false/);
		refuses(() => stageUpdate(emptyRowEdits(), pg(), ROW, { nope: 1 }), /orders has no column nope/);
	});
});

// =============================================================================
// THE MODEL
// =============================================================================

describe('the pending model: keyed by primary key, in staging order', () => {
	it('two edits to one row merge; an edit back to the original value drops out; a row with no change left is unstaged', () => {
		const target = pg();
		let edits = stageUpdate(emptyRowEdits(), target, ROW, { status: 'paid' });
		edits = stageUpdate(edits, target, ROW, { quantity: '2' });
		assert.equal(rowEditCounts(edits).edited, 1);
		assert.deepEqual(buildRowStatements(edits, target)[0]!.sql, 'UPDATE "orders" SET "quantity" = $1, "status" = $2 WHERE "order_id" = $3 AND "quantity" IS NOT DISTINCT FROM $4 AND "status" IS NOT DISTINCT FROM $5');
		edits = stageUpdate(edits, target, ROW, { quantity: '1' });
		assert.deepEqual(buildRowStatements(edits, target)[0]!.params, ['paid', 5, 'pending']);
		edits = stageUpdate(edits, target, ROW, { status: 'pending' });
		assert.deepEqual(edits.entries, []);
	});

	it('remembers what each changed field was, for "Edited, was paid"', () => {
		const edits = stageUpdate(emptyRowEdits(), pg(), ROW, { status: 'paid' });
		const pending = pendingOf(edits, rowKey(pg(), ROW));
		assert.equal(pending?.kind, 'update');
		assert.deepEqual(pending?.kind === 'update' ? pending.was : null, { status: 'pending' });
	});

	it('deleting an edited row replaces the edit; an edit to a row marked deleted is refused', () => {
		const target = pg();
		let edits = stageUpdate(emptyRowEdits(), target, ROW, { status: 'paid' });
		edits = stageDelete(edits, target, ROW);
		assert.deepEqual(rowEditCounts(edits), { edited: 0, inserted: 0, deleted: 1, total: 1 });
		refuses(() => stageUpdate(edits, target, ROW, { status: 'x' }), /marked for deletion/);
	});

	it('a new row can be edited before Apply, and deleting it just drops it', () => {
		const target = pg();
		let edits = stageInsert(emptyRowEdits(), target, { status: 'new' });
		const key = edits.entries[0]!.key;
		edits = updateInsert(edits, target, key, { status: 'newer', customer_id: '2' });
		assert.deepEqual(buildRowStatements(edits, target)[0]!.params, [2, 'newer']);
		assert.deepEqual(stageDelete(edits, target, key).entries, []);
	});

	it('two inserts get distinct keys; unstage removes one change; counts add up', () => {
		const target = pg();
		let edits = stageInsert(emptyRowEdits(), target, { status: 'a' });
		edits = stageInsert(edits, target, { status: 'b' });
		edits = stageUpdate(edits, target, ROW, { status: 'paid' });
		assert.notEqual(edits.entries[0]!.key, edits.entries[1]!.key);
		assert.deepEqual(rowEditCounts(edits), { edited: 1, inserted: 2, deleted: 0, total: 3 });
		edits = unstage(edits, edits.entries[0]!.key);
		assert.deepEqual(rowEditCounts(edits), { edited: 1, inserted: 1, deleted: 0, total: 2 });
	});

	it('after an apply stopped part-way, only what it saved drops out; after a rollback everything stays', () => {
		const target = pg();
		let edits = stageUpdate(emptyRowEdits(), target, ROW, { status: 'paid' });
		edits = stageInsert(edits, target, { status: 'a' });
		edits = stageDelete(edits, target, { ...ROW, order_id: 14 });
		const sent = edits.entries.map((edit) => edit.key);
		assert.deepEqual(dropKeys(edits, []), edits);
		assert.deepEqual(dropKeys(edits, sent.slice(0, 2)).entries.map((edit) => edit.kind), ['delete']);
		assert.deepEqual(buildRowStatements(dropKeys(edits, sent.slice(0, 2)), target).map((statement) => statement.sql), ['DELETE FROM "orders" WHERE "order_id" = $1 AND "customer_id" IS NOT DISTINCT FROM $2 AND "quantity" IS NOT DISTINCT FROM $3 AND "total" IS NOT DISTINCT FROM $4 AND "status" IS NOT DISTINCT FROM $5 AND "paid" IS NOT DISTINCT FROM $6']);
	});

	it('every function returns a new value and leaves its input alone', () => {
		const before = emptyRowEdits();
		const after = stageUpdate(before, pg(), ROW, { status: 'paid' });
		assert.deepEqual(before.entries, []);
		assert.notEqual(before, after);
		const row = { ...ROW };
		stageUpdate(after, pg(), row, { quantity: '9' });
		assert.deepEqual(row, ROW, 'the row object is never written to');
	});

	it('describes each change in one line for the confirmation', () => {
		const target = pg();
		let edits = stageUpdate(emptyRowEdits(), target, ROW, { status: 'paid', quantity: '2' });
		edits = stageInsert(edits, target, { status: 'pending' });
		edits = stageDelete(edits, target, { ...ROW, order_id: 14 });
		assert.deepEqual(edits.entries.map((edit) => describeRowEdit(edit, target)), [
			'Edit row 5: quantity 1 → 2, status pending → paid',
			'New row: status pending',
			'Delete row 14',
		]);
		const lines = pg(LINES, 'order_lines');
		assert.equal(describeRowEdit(stageDelete(emptyRowEdits(), lines, { order_id: 7, line: 2 }).entries[0]!, lines), 'Delete row (7, 2)');
		assert.equal(describeRowEdit(stageUpdate(emptyRowEdits(), target, ROW, { status: null }).entries[0]!, target), 'Edit row 5: status pending → NULL');
	});
});

// =============================================================================
// REVIEW FIXES
// =============================================================================

describe('I-5: a number is sent as typed, or refused; never changed on the way', () => {
	it('an exponent, or a value a JavaScript number cannot hold, keeps the typed text', () => {
		assert.deepEqual(coerceValue('NUMERIC', '1e400'), { ok: true, value: '1e400' });
		assert.deepEqual(coerceValue('NUMERIC', '1e-400'), { ok: true, value: '1e-400' });
		assert.deepEqual(coerceValue('DOUBLE', '-1.5e3'), { ok: true, value: '-1.5e3' });
		assert.deepEqual(coerceValue('NUMERIC(10,2)', '96.50'), { ok: true, value: 96.5 });
	});

	it('a whole-number column refuses a fraction (the database would round it), with the reason', () => {
		for (const raw of ['1.5', '1e3', '-0.25', 2.5]) {
			const result = coerceValue('INTEGER', raw);
			assert.equal(result.ok, false, String(raw));
			assert.match(result.ok ? '' : result.reason, /needs a whole number/);
		}
		assert.deepEqual(coerceValue('BIGINT UNSIGNED', '18446744073709551615'), { ok: true, value: '18446744073709551615' });
		assert.deepEqual(coerceValue('SMALLINT', '-7'), { ok: true, value: -7 });
	});

	it('Infinity and NaN never reach the JSON (they would arrive as NULL)', () => {
		for (const raw of [Infinity, -Infinity, Number.NaN]) {
			const result = coerceValue('DOUBLE', raw);
			assert.equal(result.ok, false, String(raw));
		}
		const edits = stageInsert(emptyRowEdits(), pg(), { total: '1e400' });
		assert.deepEqual(JSON.parse(JSON.stringify(buildRowStatements(edits, pg())[0]!.params)), ['1e400']);
	});
});

describe('M-6: a MySQL BOOLEAN (TINYINT(1)) column takes true and false', () => {
	it('true/false spellings become 1/0 on MySQL; a number still works; other TINYINTs stay numbers', () => {
		assert.deepEqual(coerceValue('TINYINT(1)', 'true', 'mysql'), { ok: true, value: 1 });
		assert.deepEqual(coerceValue('TINYINT(1)', 'off', 'mysql'), { ok: true, value: 0 });
		assert.deepEqual(coerceValue('TINYINT(1)', '1', 'mysql'), { ok: true, value: 1 });
		assert.deepEqual(coerceValue('TINYINT(1)', false, 'mysql'), { ok: true, value: 0 });
		assert.equal(coerceValue('TINYINT(4)', 'true', 'mysql').ok, false);
	});
});

describe('M-3: the statements are built against the table as it is now', () => {
	it('a key that changed since staging refuses the build, with the reason', () => {
		const edits = stageUpdate(emptyRowEdits(), pg(), ROW, { status: 'paid' });
		const rekeyed: RowEditTarget = { ...pg(), def: { ...ORDERS, primary_key: ['order_id', 'customer_id'] } };
		refuses(() => buildRowStatements(edits, rekeyed), /key changed since these changes were staged/);
	});

	it('a column that is gone refuses the build, so no value is dropped without a word', () => {
		const edits = stageInsert(stageUpdate(emptyRowEdits(), pg(), ROW, { status: 'paid' }), pg(), { quantity: '2' });
		const fewer: RowEditTarget = { ...pg(), def: { ...ORDERS, columns: ORDERS.columns.filter((c) => c.column !== 'quantity') } };
		refuses(() => buildRowStatements(edits, fewer), /no longer has a column quantity/);
	});

	it('an update never builds an empty SET', () => {
		const edits = stageUpdate(emptyRowEdits(), pg(), ROW, { status: 'paid' });
		const hollow = { ...edits, entries: edits.entries.map((edit) => (edit.kind === 'update' ? { ...edit, changes: {} } : edit)) };
		refuses(() => buildRowStatements(hollow, pg()), /no change left/);
	});
});

describe('I-1: what an apply settled, so nothing that may have run is staged again silently', () => {
	const base = { index: 1, stage: 'statement' as const, message: 'x', rollbackConfirmed: true };

	it('all of them after success; none after a rolled-back transaction', () => {
		assert.equal(settledCount({ transactional: true, results: [], failure: null }, 3), 3);
		assert.equal(settledCount({ transactional: true, results: [], failure: { ...base, committed: 0, unknown: false } }, 3), 0);
	});

	it('per statement: the committed ones, and the failed one too when its outcome is unknown', () => {
		assert.equal(settledCount({ transactional: false, results: [], failure: { ...base, committed: 1, unknown: false } }, 3), 1);
		assert.equal(settledCount({ transactional: false, results: [], failure: { ...base, committed: 1, unknown: true } }, 3), 2);
	});
});

// =============================================================================
// PHASE 2: THE DATA BROWSER'S PIECES
// =============================================================================

describe('rowEditGate: editing is off, with the reason, wherever it cannot work', () => {
	const ready = { dialect: 'postgres' as const, def: ORDERS, table: 'orders', executeState: 'on' as const, ready: true };

	it('a usable connection and table: on', () => {
		assert.equal(rowEditGate(ready), null);
		assert.equal(rowEditGate({ ...ready, executeState: 'unknown' }), null, 'a probe in flight disables nothing');
	});

	it('no primary key, ClickHouse, schema only, and no connection (or, in the dev tool, no sidebar) each say why', () => {
		assert.match(rowEditGate({ ...ready, def: { columns: ORDERS.columns } }) ?? '', /^orders has no primary key/);
		assert.match(rowEditGate({ ...ready, dialect: 'clickhouse' }) ?? '', /ClickHouse/);
		assert.equal(rowEditGate({ ...ready, executeState: 'off' }), 'Needs allow_execute on the node.');
		assert.match(rowEditGate({ ...ready, ready: false }) ?? '', /^Not connected \(in the dev tool, the SQL Explorer sidebar must be open\)/);
	});
});

describe('pendingCell: what a grid cell of a staged row shows (read from the pristine row, never the grid\'s)', () => {
	const target = pg();
	let edits = stageUpdate(emptyRowEdits(), target, ROW, { status: 'paid' });
	edits = stageDelete(edits, target, { ...ROW, order_id: 14 });

	it('an edited field shows its new value and what it was; another field of the row is marked as part of an edited row', () => {
		assert.deepEqual(pendingCell(edits, target, ROW, 'status'), { kind: 'edited', value: 'paid', was: 'pending' });
		assert.deepEqual(pendingCell(edits, target, ROW, 'quantity'), { kind: 'row-edited' });
	});

	it('a deleted row is marked in every cell; a row with nothing staged, or whose key cannot be read exactly, is not marked', () => {
		assert.deepEqual(pendingCell(edits, target, { ...ROW, order_id: 14 }, 'status'), { kind: 'deleted' });
		assert.equal(pendingCell(edits, target, { ...ROW, order_id: 6 }, 'status'), null);
		assert.equal(pendingCell(edits, target, { ...ROW, order_id: null }, 'status'), null);
		assert.equal(pendingCell(emptyRowEdits(), { ...target, dialect: 'clickhouse' }, ROW, 'status'), null);
	});
});

describe('the record drawer\'s form: fields in table order, NULL as its own toggle, only what changed is staged', () => {
	const target = pg();

	it('an existing row: its values as text, NULL as a toggle, key columns read-only; a staged edit shows through', () => {
		const fields = editFormFields(target, { ...ROW, quantity: null }, undefined);
		assert.deepEqual(fields.map((f) => f.column), ORDERS.columns.map((c) => c.column));
		assert.deepEqual(fields.find((f) => f.column === 'order_id'), { column: 'order_id', type: 'INTEGER', key: true, text: '5', isNull: false });
		assert.deepEqual(fields.find((f) => f.column === 'quantity'), { column: 'quantity', type: 'INTEGER', key: false, text: '', isNull: true });
		const staged = stageUpdate(emptyRowEdits(), target, ROW, { status: 'paid' });
		assert.equal(editFormFields(target, ROW, staged.entries[0]).find((f) => f.column === 'status')?.text, 'paid');
	});

	it('only the fields the user changed are staged, NULL included; key columns never are', () => {
		const before = editFormFields(target, ROW, undefined);
		const after = before.map((f) => (f.column === 'status' ? { ...f, text: 'paid' } : f.column === 'total' ? { ...f, isNull: true } : f.column === 'order_id' ? { ...f, text: '99' } : f));
		assert.deepEqual(changesFromForm(before, after), { total: null, status: 'paid' });
		const edits = stageUpdate(emptyRowEdits(), target, ROW, changesFromForm(before, after));
		assert.deepEqual(buildRowStatements(edits, target)[0]!.params, [null, 'paid', 5, 96.5, 'pending']);
	});

	it('a new row: an empty form; empty fields are left to the default, NULL is sent only when toggled', () => {
		const fields = editFormFields(target, null, undefined);
		assert.ok(fields.every((f) => f.text === '' && !f.isNull));
		const filled = fields.map((f) => (f.column === 'status' ? { ...f, text: 'new' } : f.column === 'customer_id' ? { ...f, isNull: true } : f));
		const edits = stageInsert(emptyRowEdits(), target, valuesFromForm(filled));
		assert.deepEqual(buildRowStatements(edits, target)[0], { sql: 'INSERT INTO "orders" ("customer_id", "status") VALUES ($1, $2)', params: [null, 'new'], expect: 1 });
	});
});

// =============================================================================
// R2-I2: A ROW SOMEONE ELSE CHANGED IS NOT OVERWRITTEN
// =============================================================================

describe('R2-I2: an edit or a delete also matches the old values it read, so a row changed since then matches nothing', () => {
	it('postgres: each changed column\'s old value, null-safe (IS NOT DISTINCT FROM), bound', () => {
		const edits = stageUpdate(emptyRowEdits(), pg(), { ...ROW, quantity: null }, { quantity: '2', status: 'paid' });
		assert.deepEqual(buildRowStatements(edits, pg())[0], {
			sql: 'UPDATE "orders" SET "quantity" = $1, "status" = $2 WHERE "order_id" = $3 AND "quantity" IS NOT DISTINCT FROM $4 AND "status" IS NOT DISTINCT FROM $5',
			params: [2, 'paid', 5, null, 'pending'],
			expect: 1,
		});
	});

	it('mysql: the same with the null-safe <=>', () => {
		const edits = stageUpdate(emptyRowEdits(), my(), ROW, { paid: 'true' });
		assert.deepEqual(buildRowStatements(edits, my())[0], { sql: 'UPDATE `orders` SET `paid` = $1 WHERE `order_id` = $2 AND `paid` <=> $3', params: [true, 5, false], expect: 1 });
	});

	it('a delete matches every column it can compare exactly; a timestamp is matched by key only', () => {
		const edits = stageDelete(emptyRowEdits(), pg(), ROW);
		const [statement] = buildRowStatements(edits, pg());
		assert.doesNotMatch(statement!.sql, /ordered_at/);
		assert.deepEqual(statement!.params, [5, 3, 1, 96.5, 'pending', false]);
	});

	it('values that may not come back exactly are not compared: floats, timestamps, JSON, binary, long decimals, keys already rounded', () => {
		const def: SqlSchemaTable = {
			columns: [
				{ column: 'id', type: 'INTEGER' },
				{ column: 'ratio', type: 'DOUBLE PRECISION' },
				{ column: 'seen', type: 'TIMESTAMP WITH TIME ZONE' },
				{ column: 'meta', type: 'JSONB' },
				{ column: 'blob', type: 'BYTEA' },
				{ column: 'amount', type: 'NUMERIC(30,10)' },
				{ column: 'big', type: 'BIGINT' },
				{ column: 'label', type: 'TEXT' },
			],
			primary_key: ['id'],
		};
		const target = pg(def, 'readings');
		const row = { id: 1, ratio: 0.1, seen: '2026-01-01T00:00:00+00:00', meta: '{"a":1}', blob: 'xyz', amount: 1234567890123.457, big: Number.MAX_SAFE_INTEGER + 2, label: 'x' };
		const edits = stageUpdate(emptyRowEdits(), target, row, { ratio: '0.2', seen: '2026-01-02', meta: '{}', blob: 'abc', amount: '1', big: '7', label: 'y' });
		const [statement] = buildRowStatements(edits, target);
		assert.match(statement!.sql, /WHERE "id" = \$8 AND "label" IS NOT DISTINCT FROM \$9$/);
		assert.deepEqual(uncheckedColumns(edits, target), ['ratio', 'seen', 'meta', 'blob', 'amount', 'big']);
		assert.deepEqual(uncheckedColumns(stageUpdate(emptyRowEdits(), pg(), ROW, { status: 'paid' }), pg()), []);
	});
});

describe('round 3: decimals by their declared type; a delete\'s key-only columns are named', () => {
	const def = (type: string): SqlSchemaTable => ({ columns: [{ column: 'id', type: 'INTEGER' }, { column: 'amount', type }], primary_key: ['id'] });
	const where = (type: string, value: number | string): string => {
		const target = pg(def(type), 't');
		return buildRowStatements(stageUpdate(emptyRowEdits(), target, { id: 1, amount: value }, { amount: '1' }), target)[0]!.sql;
	};

	it('R3-M1: a DECIMAL is compared only when its declared precision is 15 or less (the node sends it as a float)', () => {
		assert.match(where('NUMERIC(10, 2)', 96.5), /"amount" IS NOT DISTINCT FROM/);
		assert.match(where('DECIMAL(15,2)', 1234567890123.45), /"amount" IS NOT DISTINCT FROM/);
		assert.doesNotMatch(where('NUMERIC(38,20)', 2), /"amount" IS NOT/, 'a high-scale value arrives rounded: never compared');
		assert.doesNotMatch(where('DECIMAL(16,2)', 3), /"amount" IS NOT/);
		assert.doesNotMatch(where('NUMERIC', 3), /"amount" IS NOT/, 'unconstrained numeric');
	});

	it('R3-M3: a staged delete names the columns it matches by key only, as an edit does', () => {
		assert.deepEqual(uncheckedColumns(stageDelete(emptyRowEdits(), pg(), ROW), pg()), ['ordered_at']);
	});
});
