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
// T10 — THE CONTROLLER'S STATEMENT GATE (pure cases)
// =============================================================================
//
// The controller classifies every statement again before it sends it
// (sql/gate.ts). These are the cases the gate must get right whatever the
// frame asked for; the end-to-end cases are in devtool.wiring.test.ts (T10).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APPLY_UNKNOWN_DIALECT_TEXT, gateApplyStatements, gateStatement } from '../src/sql/gate';

describe('T10 — a write the server runs is never repeatable, however it is hidden', () => {
	it('mysql: a write inside an executable comment (/*!50000 ... */) makes the text a write', () => {
		assert.equal(gateStatement('SELECT 1; /*!50000 DELETE FROM orders */', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('/*!50000 DELETE FROM orders */', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('SELECT 1 /*!50000 , 2 */', 'mysql', true).idempotent, true, 'control: a read stays a read');
		// MySQL's DESCRIBE ANALYZE / DESC ANALYZE run the statement, like EXPLAIN ANALYZE (DA-R1 M4).
		assert.equal(gateStatement('DESCRIBE ANALYZE DELETE t FROM t JOIN u ON t.id = u.id', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('DESC ANALYZE UPDATE t JOIN u ON t.id = u.id SET t.x = 0', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('DESC orders', 'mysql', true).idempotent, true);
		// MariaDB's executable comments (DA CE-R2-3).
		assert.equal(gateStatement('SELECT 1; /*M!100000 DELETE FROM orders */', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('SELECT 1; /*M! DELETE FROM orders */', 'mysql', true).idempotent, false);
	});

	it('postgres: a write behind a line comment that a bare carriage return ends', () => {
		assert.equal(gateStatement('SELECT 1 -- x\r; DELETE FROM orders', 'postgres', true).idempotent, false);
		assert.equal(gateStatement('SELECT 1 -- x\r\nFROM t', 'postgres', true).idempotent, true, 'control');
	});
});

describe('T10 — every spelling of transaction control is refused in its dialect', () => {
	for (const [sql, dialect] of [['ABORT', 'postgres'], ['END', 'postgres'], ["PREPARE TRANSACTION 'x'", 'postgres'], ["XA START 'x'", 'mysql'], ['SET @@autocommit = 0', 'mysql'], ['SET @@session.autocommit = 0', 'mysql']] as const) {
		it(`${dialect}: ${sql}`, () => {
			assert.notEqual(gateStatement(sql, dialect, false).refusal, null);
		});
	}
});

describe('T10 — the gate needs the node\'s dialect: with it, PL/pgSQL passes; without it, nothing is repeated or refused', () => {
	const DO_BLOCK = 'DO $$\nBEGIN\n  UPDATE orders SET paid = true WHERE id = 1;\nEND\n$$;';
	const FUNCTION = 'CREATE FUNCTION bump() RETURNS void AS $$\nDECLARE x int;\nBEGIN\n  PERFORM 1;\nEND;\n$$ LANGUAGE plpgsql';

	it('postgres: a DO block and a CREATE FUNCTION with DECLARE/BEGIN/END are not transaction control', () => {
		for (const sql of [DO_BLOCK, FUNCTION]) assert.equal(gateStatement(sql, 'postgres', false).refusal, null);
	});

	it('unknown: never refused (the split cannot be trusted), never repeated', () => {
		for (const sql of [DO_BLOCK, FUNCTION, 'SELECT 1', 'SELECT 1--1; DELETE FROM orders', 'SELECT $$ -- $$; DELETE FROM orders', 'BEGIN']) {
			assert.deepEqual(gateStatement(sql, 'unknown', true), { refusal: null, idempotent: false }, sql);
		}
	});

	it('with the dialect known, the DA batches are writes', () => {
		assert.equal(gateStatement('SELECT 1--1; DELETE FROM orders', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('SELECT $$ -- $$; DELETE FROM orders', 'postgres', true).idempotent, false);
	});
});

describe('T10 — an Apply\'s list: one app-written statement each, never transaction control', () => {
	const EDIT = 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2';

	it('passes app-written row edits and DDL in every dialect it knows', () => {
		for (const dialect of ['postgres', 'mysql', 'clickhouse'] as const) {
			assert.equal(gateApplyStatements([EDIT, 'DELETE FROM "orders" WHERE "order_id" = $1'], dialect, true), null, dialect);
			// DDL: in one transaction on PostgreSQL (and ClickHouse's per-statement fallback); MySQL runs it per statement (I-3).
			assert.equal(gateApplyStatements([EDIT, 'ALTER TABLE "orders" ADD COLUMN "notes" text'], dialect, dialect !== 'mysql'), null, dialect);
		}
	});

	it('refuses transaction control anywhere in the list, before anything is sent', () => {
		for (const [tx, dialect] of [['BEGIN', 'postgres'], ['COMMIT', 'mysql'], ['ROLLBACK', 'postgres'], ['SAVEPOINT s1', 'postgres'], ['START TRANSACTION', 'mysql'], ['END', 'postgres'], ['SET autocommit = 1', 'mysql']] as const) {
			const refusal = gateApplyStatements([EDIT, tx], dialect, true);
			assert.match(refusal ?? '', /^Statement 2 is transaction control\./, `${dialect}: ${tx}`);
			assert.match(refusal ?? '', /nothing was applied/);
		}
		// Not atomic either: an apply never carries its own transaction text.
		assert.notEqual(gateApplyStatements(['COMMIT'], 'mysql', false), null);
	});

	it('refuses an entry that holds two statements (a value typed into the designer cannot smuggle one in)', () => {
		assert.match(gateApplyStatements(['ALTER TABLE "t" ADD COLUMN "x" int; COMMIT'], 'postgres', true) ?? '', /^Statement 1 holds more than one statement/);
		assert.match(gateApplyStatements([EDIT, 'SELECT 1; DELETE FROM "orders"'], 'mysql', false) ?? '', /^Statement 2 holds more than one statement/);
		assert.equal(gateApplyStatements(["UPDATE \"t\" SET \"note\" = 'a; b'"], 'postgres', true), null, 'a semicolon in a literal is not a second statement');
	});

	it('refuses an empty list and an empty entry', () => {
		assert.notEqual(gateApplyStatements([], 'postgres', true), null);
		assert.match(gateApplyStatements([EDIT, '  -- nothing\n'], 'postgres', true) ?? '', /^Statement 2 is empty/);
		assert.match(gateApplyStatements(['   '], 'unknown', false) ?? '', /^Statement 1 is empty/);
	});

	it('unknown dialect: one transaction is refused; without one, each entry is sent once and the node decides', () => {
		assert.equal(gateApplyStatements([EDIT], 'unknown', true), APPLY_UNKNOWN_DIALECT_TEXT);
		assert.equal(gateApplyStatements([EDIT, 'BEGIN'], 'unknown', false), null);
	});
});

describe('I-3 — one MySQL transaction holds only INSERT, UPDATE, DELETE and REPLACE (anything else may commit implicitly)', () => {
	const EDIT = 'UPDATE `orders` SET `status` = $1 WHERE `order_id` = $2';

	it('refuses DDL, TRUNCATE, LOCK and the rest inside an atomic MySQL list, before anything is sent', () => {
		for (const sql of ['ALTER TABLE `orders` ADD COLUMN `notes` text', 'CREATE TABLE `t` (`id` int)', 'TRUNCATE `orders`', 'LOCK TABLES `orders` WRITE', 'UNLOCK TABLES', 'DROP TABLE `t`', 'RENAME TABLE `a` TO `b`', 'SELECT 1', 'CALL p()', 'WITH x AS (SELECT 1) UPDATE `orders` SET `a` = 1']) {
			assert.match(gateApplyStatements([EDIT, sql], 'mysql', true) ?? '', /^Statement 2 is not INSERT, UPDATE, DELETE or REPLACE\./, sql);
		}
	});

	it('passes the four, behind comments too', () => {
		assert.equal(gateApplyStatements([EDIT, 'INSERT INTO `orders` (`a`) VALUES ($1)', '/* x */ DELETE FROM `orders` WHERE `id` = $1', 'REPLACE INTO `orders` (`a`) VALUES ($1)', '-- note\nupdate `orders` set `a` = 1'], 'mysql', true), null);
	});

	it('only one MySQL transaction is restricted: per statement, and on PostgreSQL, DDL passes', () => {
		assert.equal(gateApplyStatements(['ALTER TABLE `orders` ADD COLUMN `notes` text'], 'mysql', false), null);
		assert.equal(gateApplyStatements(['ALTER TABLE "orders" ADD COLUMN "notes" text', 'TRUNCATE "t"'], 'postgres', true), null);
	});
});
