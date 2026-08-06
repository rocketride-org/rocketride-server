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
// SQL — INTROSPECT (details the node's get_schema does not carry)
// =============================================================================
//
// The node's get_schema tool reports columns/PKs/FKs but NOT constraint
// names. Dropping a foreign key needs its name, so the designer reads them
// from INFORMATION_SCHEMA through the ordinary execute path (decision: keep
// the server's get_schema untouched; app-side queries fill the gaps).
// =============================================================================

import type { ISqlSession, SqlDialect } from '../connect';
import { quoteValue } from './paging';

// =============================================================================
// FOREIGN KEY NAMES
// =============================================================================

/** One named foreign key constraint read from INFORMATION_SCHEMA. */
export interface INamedForeignKey {
	/** Constraint name (the handle DROP needs). */
	name: string;
	/** Local column name. */
	column: string;
	/** Referenced table name. */
	referredTable: string;
}

/**
 * Read the named foreign key constraints of one table. MySQL and Postgres
 * both expose INFORMATION_SCHEMA; ClickHouse has no foreign keys, and
 * unknown dialects return empty (the designer then hides FK drops).
 *
 * @param session - The connection's session.
 * @param dialect - The engine dialect.
 * @param table - The table name.
 * @returns The table's named foreign keys (possibly empty).
 */
export async function fetchForeignKeyNames(session: ISqlSession, dialect: SqlDialect, table: string): Promise<INamedForeignKey[]> {
	let sql: string;
	if (dialect === 'mysql') {
		// KEY_COLUMN_USAGE carries the referencing rows; scope to this schema.
		sql =
			'SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS ref ' +
			'FROM information_schema.KEY_COLUMN_USAGE ' +
			`WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${quoteValue(table)} AND REFERENCED_TABLE_NAME IS NOT NULL`;
	} else if (dialect === 'postgres') {
		// Constraint names are only unique PER SCHEMA in Postgres, so every
		// join carries constraint_schema. The referenced side pairs through
		// referential_constraints to the unique constraint's key columns via
		// position_in_unique_constraint = ordinal_position, so composite keys
		// map each referencing column to ITS referenced column (no cross join).
		sql =
			'SELECT tc.constraint_name AS name, kcu.column_name AS col, ref_kcu.table_name AS ref ' +
			'FROM information_schema.table_constraints tc ' +
			'JOIN information_schema.key_column_usage kcu ' +
			'ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name ' +
			'JOIN information_schema.referential_constraints rc ' +
			'ON rc.constraint_schema = tc.constraint_schema AND rc.constraint_name = tc.constraint_name ' +
			'JOIN information_schema.key_column_usage ref_kcu ' +
			'ON ref_kcu.constraint_schema = rc.unique_constraint_schema AND ref_kcu.constraint_name = rc.unique_constraint_name ' +
			'AND ref_kcu.ordinal_position = kcu.position_in_unique_constraint ' +
			`WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ${quoteValue(table)} AND tc.table_schema = current_schema()`;
	} else {
		return [];
	}

	const result = await session.execute(sql);
	return result.rows.map((row) => ({
		name: String((row as { name?: unknown }).name ?? ''),
		column: String((row as { col?: unknown }).col ?? ''),
		referredTable: String((row as { ref?: unknown }).ref ?? ''),
	})).filter((fk) => fk.name.length > 0);
}
