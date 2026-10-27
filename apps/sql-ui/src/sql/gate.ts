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
// SQL — STATEMENT GATE (the controller's own write classification, T10)
// =============================================================================
//
// A frame classifies what it sends: it refuses transaction control, marks a
// read `idempotent` (repeatable once after a pre-dispatch TASK_STOPPED), and
// asks before a pattern it flags. The CONTROLLER does not trust that: before
// it sends a statement it classifies the text again, with the dialect the
// node itself reported, and
//
//   - refuses transaction control outright (each call autocommits, so
//     BEGIN / COMMIT / ROLLBACK can only mislead), and
//   - lets a statement be repeated only when the frame asked for it AND
//     every statement in the text is a read: a write, a DDL statement, a
//     SELECT ... INTO, or any text that holds more than one statement with
//     a write among them, is sent at most once.
//
// UNKNOWN DIALECT: FAIL CLOSED. Where a statement ends, and what is a comment,
// depend on the dialect (`--1` is arithmetic in MySQL, `$$ … $$` is a literal
// in PostgreSQL), so a text split without the dialect cannot be trusted
// either way: it could pass a write as a read, and it would refuse valid
// PL/pgSQL (`CREATE FUNCTION … $$ BEGIN … END; $$`) as transaction control.
// With no dialect the text is never repeated and never refused: it is sent
// once, and the node decides.
//
// LIMITS. The classification reads the text, not the server: a server setting
// that changes lexing (MySQL NO_BACKSLASH_ESCAPES or ANSI_QUOTES, PostgreSQL
// standard_conforming_strings off) is not seen, and a read with side effects
// (`SELECT nextval('s')`) is a read.
//
// AN APPLY'S LIST (gateApplyStatements). Staged row edits and designer plans
// are written by the app, but their values and types come from the user, so
// the engine core checks the whole list before anything is sent: every entry
// must be exactly one statement (a type typed as `int; COMMIT` must not end
// the transaction early, and a row count belongs to one statement), and none
// may be transaction control, since the apply opens and ends its own. One
// transaction needs the dialect: without it no entry can be split, so an
// atomic apply is refused, and an apply without a transaction is sent entry
// by entry, once each, as `execute` sends a statement. One MySQL transaction
// holds only INSERT, UPDATE, DELETE and REPLACE: MySQL commits implicitly
// before DDL, TRUNCATE, LOCK TABLES and more, which would leave a committed
// prefix behind a reply that says "one transaction".
//
// Pure (no engine), so it is tested directly.
// =============================================================================

import type { SqlDialect } from '../connect';
import { classifyStatement } from './classify';
import { splitStatements, stripSqlComments } from './split';
import { TRANSACTION_REFUSAL_TEXT } from './failure';

/** What the controller does with a statement a frame sent. */
export interface StatementGate {
	/** Why it is refused (nothing is sent), or null. */
	refusal: string | null;
	/** Whether the session may repeat it once after a pre-dispatch TASK_STOPPED. */
	idempotent: boolean;
}

/**
 * Classify a statement the way the controller will treat it.
 *
 * @param sql - The text as the frame sent it.
 * @param dialect - The dialect the node reported; 'unknown' fails closed (sent once, never repeated, never refused).
 * @param idempotentRequested - What the frame asked for.
 * @returns The gate.
 */
export function gateStatement(sql: string, dialect: SqlDialect, idempotentRequested: boolean): StatementGate {
	if (dialect === 'unknown') return { refusal: null, idempotent: false };
	const statements = splitStatements(sql, dialect);
	const kinds = statements.length > 0 ? statements.map((statement) => classifyStatement(statement.sql, dialect)) : [classifyStatement(sql, dialect)];
	if (kinds.includes('tx')) return { refusal: TRANSACTION_REFUSAL_TEXT, idempotent: false };
	return { refusal: null, idempotent: idempotentRequested && kinds.every((kind) => kind === 'read') };
}

/** The statements one MySQL transaction may hold (none of them commits implicitly). */
const MYSQL_IN_TRANSACTION = /^(?:insert|update|delete|replace)\b/i;

/** Why an atomic apply is refused when the node did not report its dialect. */
export const APPLY_UNKNOWN_DIALECT_TEXT = 'The database did not report its type, so these statements cannot be checked and run as one transaction. Nothing was applied.';

/**
 * Check an apply's whole list the way the engine core will send it.
 *
 * @param sqls - The statements, in order.
 * @param dialect - The dialect the node reported; 'unknown' refuses one transaction and otherwise checks only for empty entries.
 * @param atomic - Whether they are to run as one transaction.
 * @returns Why the list is refused (nothing is sent), or null.
 */
export function gateApplyStatements(sqls: readonly string[], dialect: SqlDialect, atomic: boolean): string | null {
	if (sqls.length === 0) return 'There is nothing to apply.';
	if (atomic && dialect === 'unknown') return APPLY_UNKNOWN_DIALECT_TEXT;
	for (const [index, sql] of sqls.entries()) {
		const which = `Statement ${index + 1}`;
		if (dialect === 'unknown') {
			if (sql.trim() === '') return `${which} is empty, so nothing was applied.`;
			continue;
		}
		const statements = splitStatements(sql, dialect);
		if (statements.length === 0) return `${which} is empty, so nothing was applied.`;
		if (statements.length > 1) return `${which} holds more than one statement, so nothing was applied.`;
		if (classifyStatement(statements[0]!.sql, dialect) === 'tx') {
			return `${which} is transaction control. An apply opens and ends its own transaction, so nothing was applied.`;
		}
		if (atomic && dialect === 'mysql' && !MYSQL_IN_TRANSACTION.test(stripSqlComments(statements[0]!.sql, dialect).trim())) {
			return `${which} is not INSERT, UPDATE, DELETE or REPLACE. On MySQL other statements can commit on their own, so they cannot run inside one transaction here. Nothing was applied.`;
		}
	}
	return null;
}
