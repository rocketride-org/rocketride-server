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
// SQL — DDL (staged designer operations -> CREATE/ALTER statements)
// =============================================================================
//
// The designer never executes edits directly: every gesture appends an
// operation to an AlterPlan, the DDL page previews the generated statements,
// and Apply executes them in order. Pure string building — no client here.
// =============================================================================

import type { SqlDialect } from '../connect';
import { quoteIdent } from './paging';

// =============================================================================
// OPERATIONS
// =============================================================================

/** A column definition used by add-column and create-table operations. */
export interface IColumnSpec {
	/** Column name. */
	name: string;
	/** SQL datatype (verbatim, e.g. 'VARCHAR(255)'). */
	type: string;
	/** NOT NULL when false (default true = nullable). */
	nullable: boolean;
	/** Default value expression, verbatim ('' = none). */
	defaultExpr: string;
	/** Part of the primary key (create-table mode only). */
	primaryKey: boolean;
}

/** One staged designer operation. */
export type AlterOp =
	| { kind: 'addColumn'; spec: IColumnSpec }
	| { kind: 'dropColumn'; name: string }
	| { kind: 'renameColumn'; name: string; newName: string }
	| { kind: 'changeType'; name: string; type: string }
	| { kind: 'addForeignKey'; name: string; column: string; refTable: string; refColumn: string; onUpdate: string; onDelete: string }
	| { kind: 'dropForeignKey'; name: string };

/** Referential action options offered by the FK editor. */
export const FK_ACTIONS = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'] as const;

// =============================================================================
// FRAGMENTS
// =============================================================================

/**
 * Render one column definition fragment (shared by ADD COLUMN and CREATE).
 *
 * @param dialect - The engine dialect.
 * @param spec - The column spec.
 * @returns The column definition SQL fragment.
 */
function columnFragment(dialect: SqlDialect, spec: IColumnSpec): string {
	const parts = [quoteIdent(dialect, spec.name), spec.type];
	if (!spec.nullable) parts.push('NOT NULL');
	if (spec.defaultExpr) parts.push(`DEFAULT ${spec.defaultExpr}`);
	return parts.join(' ');
}

// =============================================================================
// GENERATION
// =============================================================================

/**
 * Generate the CREATE TABLE statement for a new table.
 *
 * @param dialect - The engine dialect.
 * @param tableName - The new table's name.
 * @param columns - The column specs (at least one).
 * @returns The CREATE TABLE statement.
 */
export function generateCreateTable(dialect: SqlDialect, tableName: string, columns: IColumnSpec[]): string {
	const lines = columns.map((c) => '  ' + columnFragment(dialect, c));
	const pk = columns.filter((c) => c.primaryKey).map((c) => quoteIdent(dialect, c.name));
	if (pk.length > 0) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
	return `CREATE TABLE ${quoteIdent(dialect, tableName)} (\n${lines.join(',\n')}\n)`;
}

/**
 * Generate the ALTER statements for a staged plan, in op order. Each op maps
 * to exactly one statement; dialect differences (MODIFY vs ALTER COLUMN,
 * DROP FOREIGN KEY vs DROP CONSTRAINT) are resolved here.
 *
 * @param dialect - The engine dialect.
 * @param tableName - The table being altered.
 * @param ops - The staged operations.
 * @returns One SQL statement per operation.
 */
export function generateAlterStatements(dialect: SqlDialect, tableName: string, ops: AlterOp[]): string[] {
	const target = quoteIdent(dialect, tableName);

	return ops.map((op) => {
		switch (op.kind) {
			case 'addColumn':
				return `ALTER TABLE ${target} ADD COLUMN ${columnFragment(dialect, op.spec)}`;

			case 'dropColumn':
				return `ALTER TABLE ${target} DROP COLUMN ${quoteIdent(dialect, op.name)}`;

			case 'renameColumn':
				// RENAME COLUMN is shared by MySQL 8+, Postgres, and ClickHouse.
				return `ALTER TABLE ${target} RENAME COLUMN ${quoteIdent(dialect, op.name)} TO ${quoteIdent(dialect, op.newName)}`;

			case 'changeType':
				// Postgres spells retyping differently from MySQL/ClickHouse.
				if (dialect === 'postgres') {
					return `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(dialect, op.name)} TYPE ${op.type}`;
				}
				return `ALTER TABLE ${target} MODIFY COLUMN ${quoteIdent(dialect, op.name)} ${op.type}`;

			case 'addForeignKey':
				return (
					`ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(dialect, op.name)} ` +
					`FOREIGN KEY (${quoteIdent(dialect, op.column)}) ` +
					`REFERENCES ${quoteIdent(dialect, op.refTable)} (${quoteIdent(dialect, op.refColumn)}) ` +
					`ON UPDATE ${op.onUpdate} ON DELETE ${op.onDelete}`
				);

			case 'dropForeignKey':
				// MySQL names the gesture; everyone else drops the constraint.
				if (dialect === 'mysql') {
					return `ALTER TABLE ${target} DROP FOREIGN KEY ${quoteIdent(dialect, op.name)}`;
				}
				return `ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(dialect, op.name)}`;
		}
	});
}

/**
 * One-line human summary of an op, for the pending-changes list.
 *
 * @param op - The staged operation.
 * @returns The summary line.
 */
export function describeOp(op: AlterOp): string {
	switch (op.kind) {
		case 'addColumn': return `Add column ${op.spec.name} ${op.spec.type}`;
		case 'dropColumn': return `Drop column ${op.name}`;
		case 'renameColumn': return `Rename column ${op.name} to ${op.newName}`;
		case 'changeType': return `Change ${op.name} type to ${op.type}`;
		case 'addForeignKey': return `Add foreign key ${op.name} (${op.column} -> ${op.refTable}.${op.refColumn})`;
		case 'dropForeignKey': return `Drop foreign key ${op.name}`;
	}
}
