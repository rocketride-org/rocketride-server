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
import { gateStatement } from '../src/sql/gate';

describe('T10 — a write the server runs is never repeatable, however it is hidden', () => {
	it('mysql: a write inside an executable comment (/*!50000 ... */) makes the text a write', () => {
		assert.equal(gateStatement('SELECT 1; /*!50000 DELETE FROM orders */', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('/*!50000 DELETE FROM orders */', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('SELECT 1 /*!50000 , 2 */', 'mysql', true).idempotent, true, 'control: a read stays a read');
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
