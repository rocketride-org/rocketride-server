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
// Pure (no engine), so it is tested directly.
// =============================================================================

import type { SqlDialect } from '../connect';
import { classifyStatement } from './classify';
import { splitStatements } from './split';
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
