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
// SQL — PREVIEW (an app-written statement with its values shown in place)
// =============================================================================
//
// Apply binds every value as `$1..$n`; Review SQL, Copy SQL and history show
// the statement with each value written as a literal of the dialect, so it
// can be read (and run by hand). Reading only: what is sent stays bound.
// =============================================================================

import type { SqlApplyStatement, SqlDialect } from '../connect';

/**
 * A value as a SQL literal of the dialect, for reading only (Apply binds it).
 *
 * @param value - The bound value.
 * @param dialect - The dialect (MySQL and ClickHouse read a backslash as an escape).
 * @returns The literal.
 */
export function sqlLiteral(value: unknown, dialect: SqlDialect): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (typeof value === 'number') return String(value);
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	const escaped = dialect === 'mysql' || dialect === 'clickhouse' ? text.replace(/\\/g, '\\\\') : text;
	return `'${escaped.replace(/'/g, "''")}'`;
}

/**
 * A statement with its bound values shown in place of `$1..$n`. Placeholders
 * inside quoted text or quoted names are left alone, as the node's own
 * rewriting leaves them.
 *
 * @param statement - The statement.
 * @param dialect - The dialect.
 * @returns The text to read.
 */
export function previewSql(statement: SqlApplyStatement, dialect: SqlDialect): string {
	const params = statement.params ?? [];
	if (params.length === 0) return statement.sql;
	const sql = statement.sql;
	let out = '';
	let quote: string | null = null;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] as string;
		if (quote !== null) {
			out += ch;
			// A doubled quote stays inside; a single one ends the quoted run.
			if (ch === quote) {
				if (sql[i + 1] === quote) {
					out += quote;
					i++;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			out += ch;
			continue;
		}
		const digits = ch === '$' ? /^\d+/.exec(sql.slice(i + 1))?.[0] : undefined;
		const n = digits === undefined ? 0 : Number(digits);
		if (n >= 1 && n <= params.length) {
			out += sqlLiteral(params[n - 1], dialect);
			i += (digits as string).length;
			continue;
		}
		out += ch;
	}
	return out;
}
