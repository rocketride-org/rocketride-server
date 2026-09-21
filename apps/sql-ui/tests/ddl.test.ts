// MIT License
//
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
// SQL DDL — unit tests for the designer's statement generation
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlDialect } from '../src/connect';
import type { AlterOp, IColumnSpec } from '../src/sql/ddl';
import { describeOp, generateAlterStatements, generateCreateTable } from '../src/sql/ddl';

// =============================================================================
// FIXTURES
// =============================================================================

/** Every dialect the designer generates for. */
const DIALECTS: SqlDialect[] = ['mysql', 'postgres', 'clickhouse'];

/**
 * Build a column spec over a nullable, defaultless, non-key default.
 *
 * @param over - Fields to override.
 * @returns The column spec.
 */
function col(over: Partial<IColumnSpec> = {}): IColumnSpec {
	return { name: 'c', type: 'INT', nullable: true, defaultExpr: '', primaryKey: false, ...over };
}

// =============================================================================
// CREATE TABLE
// =============================================================================

describe('generateCreateTable', () => {
	it('renders one indented column per line with the dialect quoting', () => {
		const sql = generateCreateTable('mysql', 'orders', [col({ name: 'id', type: 'BIGINT' })]);
		assert.equal(sql, 'CREATE TABLE `orders` (\n  `id` BIGINT\n)');
	});

	it('appends NOT NULL and DEFAULT in that order', () => {
		const sql = generateCreateTable('postgres', 'orders', [col({ name: 'qty', type: 'INT', nullable: false, defaultExpr: '0' })]);
		assert.equal(sql, 'CREATE TABLE "orders" (\n  "qty" INT NOT NULL DEFAULT 0\n)');
	});

	it('collects the primary-key columns into one trailing PRIMARY KEY clause', () => {
		const sql = generateCreateTable('postgres', 'orders', [
			col({ name: 'a', primaryKey: true }),
			col({ name: 'b' }),
			col({ name: 'c', primaryKey: true }),
		]);
		assert.equal(sql, 'CREATE TABLE "orders" (\n  "a" INT,\n  "b" INT,\n  "c" INT,\n  PRIMARY KEY ("a", "c")\n)');
	});

	it('omits the PRIMARY KEY clause when no column is keyed', () => {
		const sql = generateCreateTable('postgres', 'orders', [col({ name: 'a' })]);
		assert.doesNotMatch(sql, /PRIMARY KEY/);
	});
});

// =============================================================================
// ALTER STATEMENTS
// =============================================================================

describe('generateAlterStatements', () => {
	it('emits exactly one statement per staged operation, in order', () => {
		const ops: AlterOp[] = [
			{ kind: 'addColumn', spec: col({ name: 'a' }) },
			{ kind: 'dropColumn', name: 'b' },
		];
		const out = generateAlterStatements('postgres', 'orders', ops);
		assert.equal(out.length, 2);
		assert.match(out[0]!, /ADD COLUMN "a" INT$/);
		assert.match(out[1]!, /DROP COLUMN "b"$/);
	});

	it('spells addColumn, dropColumn, and renameColumn the same way on every dialect', () => {
		for (const dialect of DIALECTS) {
			const q = dialect === 'postgres' ? '"' : '`';
			const [add, drop, rename] = generateAlterStatements(dialect, 't', [
				{ kind: 'addColumn', spec: col({ name: 'a', type: 'TEXT', nullable: false }) },
				{ kind: 'dropColumn', name: 'b' },
				{ kind: 'renameColumn', name: 'c', newName: 'd' },
			]);
			assert.equal(add, `ALTER TABLE ${q}t${q} ADD COLUMN ${q}a${q} TEXT NOT NULL`);
			assert.equal(drop, `ALTER TABLE ${q}t${q} DROP COLUMN ${q}b${q}`);
			assert.equal(rename, `ALTER TABLE ${q}t${q} RENAME COLUMN ${q}c${q} TO ${q}d${q}`);
		}
	});

	it('retypes with ALTER COLUMN ... TYPE on Postgres and MODIFY COLUMN elsewhere', () => {
		const op: AlterOp = { kind: 'changeType', name: 'c', type: 'BIGINT' };
		assert.equal(generateAlterStatements('postgres', 't', [op])[0], 'ALTER TABLE "t" ALTER COLUMN "c" TYPE BIGINT');
		assert.equal(generateAlterStatements('mysql', 't', [op])[0], 'ALTER TABLE `t` MODIFY COLUMN `c` BIGINT');
		assert.equal(generateAlterStatements('clickhouse', 't', [op])[0], 'ALTER TABLE `t` MODIFY COLUMN `c` BIGINT');
	});

	it('renders an added foreign key with both referential actions', () => {
		const op: AlterOp = {
			kind: 'addForeignKey',
			name: 'fk_o_c',
			column: 'customer_id',
			refTable: 'customers',
			refColumn: 'id',
			onUpdate: 'CASCADE',
			onDelete: 'SET NULL',
		};
		assert.equal(
			generateAlterStatements('postgres', 'orders', [op])[0],
			'ALTER TABLE "orders" ADD CONSTRAINT "fk_o_c" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON UPDATE CASCADE ON DELETE SET NULL',
		);
	});

	it('drops a foreign key with DROP FOREIGN KEY on MySQL and DROP CONSTRAINT elsewhere', () => {
		const op: AlterOp = { kind: 'dropForeignKey', name: 'fk_o_c' };
		assert.equal(generateAlterStatements('mysql', 'orders', [op])[0], 'ALTER TABLE `orders` DROP FOREIGN KEY `fk_o_c`');
		assert.equal(generateAlterStatements('postgres', 'orders', [op])[0], 'ALTER TABLE "orders" DROP CONSTRAINT "fk_o_c"');
		assert.equal(generateAlterStatements('clickhouse', 'orders', [op])[0], 'ALTER TABLE `orders` DROP CONSTRAINT `fk_o_c`');
	});

	it('escapes the quote character inside every identifier it renders', () => {
		const out = generateAlterStatements('mysql', 'we`ird', [{ kind: 'dropColumn', name: 'al`so' }]);
		assert.equal(out[0], 'ALTER TABLE `we``ird` DROP COLUMN `al``so`');
	});
});

// =============================================================================
// SUMMARIES
// =============================================================================

describe('describeOp', () => {
	it('summarises every operation kind', () => {
		assert.equal(describeOp({ kind: 'addColumn', spec: col({ name: 'a', type: 'TEXT' }) }), 'Add column a TEXT');
		assert.equal(describeOp({ kind: 'dropColumn', name: 'b' }), 'Drop column b');
		assert.equal(describeOp({ kind: 'renameColumn', name: 'c', newName: 'd' }), 'Rename column c to d');
		assert.equal(describeOp({ kind: 'changeType', name: 'c', type: 'BIGINT' }), 'Change c type to BIGINT');
		assert.equal(
			describeOp({ kind: 'addForeignKey', name: 'fk', column: 'x', refTable: 't', refColumn: 'id', onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
			'Add foreign key fk (x -> t.id)',
		);
		assert.equal(describeOp({ kind: 'dropForeignKey', name: 'fk' }), 'Drop foreign key fk');
	});
});
