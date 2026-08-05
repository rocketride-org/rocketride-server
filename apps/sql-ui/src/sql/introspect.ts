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
		// Join constraints to their key columns; ccu carries the referenced side.
		sql =
			'SELECT tc.constraint_name AS name, kcu.column_name AS col, ccu.table_name AS ref ' +
			'FROM information_schema.table_constraints tc ' +
			'JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name ' +
			'JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name ' +
			`WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ${quoteValue(table)}`;
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
