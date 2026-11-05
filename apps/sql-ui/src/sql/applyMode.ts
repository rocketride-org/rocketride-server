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
// SQL — APPLY MODE (what an Apply may promise before it is sent)
// =============================================================================
//
// The confirmation is written before the reply, so it may promise only what
// the app knows then:
//
//   PostgreSQL   one transaction (the node's `begin`).
//   MySQL        by the table's storage engine: InnoDB keeps transactions,
//                MyISAM and others do not (`begin` succeeds there, but the
//                rollback undoes nothing). The engine is read from
//                information_schema before the confirmation; when that read
//                fails, one transaction is still asked for and the words are
//                hedged.
//   other        each change on its own (ClickHouse has no transactions; row
//                editing is refused there anyway).
//
// A node that answered "no transaction tools" (`transactions-unavailable`)
// is remembered, so its next confirmation already says each change commits
// on its own (review P4 C-1), but only for the schema snapshot it was learnt
// under: a schema refresh, or the reload after a reconnect, forgets it, in
// case the node was upgraded (R2-M4). Nothing here talks to the
// engine except readTableEngine, through the caller's session.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer/errors';
import type { SqlDialect, SqlSession } from '../connect';

// =============================================================================
// MODES
// =============================================================================

/**
 * What the confirmation may say: one transaction; each change on its own;
 * or one transaction asked for where the table's engine may ignore it.
 */
export type ApplyWording = 'transaction' | 'each' | 'hedged';

/** How staged row changes are applied, and what may be promised about it. */
export interface RowApplyMode {
	/** Ask the engine for one transaction. */
	atomic: boolean;
	/** What the review and the confirmation say. */
	wording: ApplyWording;
}

/** MySQL storage engines whose tables keep transactions. */
const TRANSACTIONAL_ENGINES = /^(?:innodb|ndb|ndbcluster)$/i;

/** MySQL storage engines whose tables keep none (a rollback undoes nothing). */
const NON_TRANSACTIONAL_ENGINES = /^(?:myisam|memory|heap|archive|csv|mrg_myisam|merge|blackhole|federated|aria)$/i;

/**
 * Whether a MySQL storage engine keeps transactions.
 *
 * @param engine - The engine name, or null when it could not be read.
 * @returns True or false for an engine this app knows; null otherwise.
 */
export function engineKeepsTransactions(engine: string | null): boolean | null {
	if (engine === null) return null;
	if (TRANSACTIONAL_ENGINES.test(engine)) return true;
	if (NON_TRANSACTIONAL_ENGINES.test(engine)) return false;
	return null;
}

/**
 * How staged row changes are applied on a connection.
 *
 * @param dialect - The connection's dialect.
 * @param facts - What is known: the MySQL table's engine (null or absent: not known), and whether the node has no transaction tools.
 * @param facts.engine - The table's storage engine (MySQL).
 * @param facts.noTransactions - The node answered `transactions-unavailable` before.
 * @returns The mode.
 */
export function rowApplyMode(dialect: SqlDialect, facts: { engine?: string | null; noTransactions?: boolean }): RowApplyMode {
	if (facts.noTransactions) return { atomic: false, wording: 'each' };
	if (dialect === 'postgres') return { atomic: true, wording: 'transaction' };
	if (dialect === 'mysql') {
		const keeps = engineKeepsTransactions(facts.engine ?? null);
		if (keeps === false) return { atomic: false, wording: 'each' };
		return { atomic: true, wording: keeps ? 'transaction' : 'hedged' };
	}
	return { atomic: false, wording: 'each' };
}

/**
 * Whether an apply that THREW (no reply came back) may still have run. Only
 * a refusal that sends nothing is known: the list refused (`invalid`), no
 * connection (`unavailable`), another account (`stale`), no transactions
 * (`upgrade`), or `begin` refused by the node (`raised`; a failure after
 * statements are sent is a reply, never a throw). Anything else, the frame's
 * own lost connection ("It may still have run") and every timeout included,
 * may have run (review P4 R2-I1).
 *
 * @param error - What the apply threw.
 * @returns True when the outcome is unknown.
 */
export function thrownApplyMayHaveRun(error: unknown): boolean {
	if (!(error instanceof ExplorerToolError)) return true;
	return !(error.kind === 'invalid' || error.kind === 'unavailable' || error.kind === 'stale' || error.kind === 'upgrade' || error.kind === 'raised');
}

/** What an apply without a transaction means, in the words every confirmation uses. */
export const EACH_COMMITS_TEXT = 'Each change commits on its own; a failure leaves earlier changes saved.';

/**
 * The question asked after an atomic apply was refused because there is no
 * transaction to have (`transactions-unavailable`): nothing was applied, and
 * the statements are sent one by one only if the user agrees.
 *
 * @param reason - The refusal's own sentence (it says nothing was applied).
 * @returns The dialog's title, text and confirm label.
 */
export function perStatementConfirmText(reason: string): { title: string; text: string; confirmLabel: string } {
	return { title: 'Apply without a transaction?', text: `${reason} ${EACH_COMMITS_TEXT}`, confirmLabel: 'Apply anyway' };
}

// =============================================================================
// THE TABLE'S ENGINE (MySQL)
// =============================================================================

/**
 * The statement that reads a MySQL table's storage engine, the name bound.
 *
 * @param table - The table (in the connection's current database).
 * @returns The statement and its bind values.
 */
export function tableEngineStatement(table: string): { sql: string; params: string[] } {
	return { sql: 'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1', params: [table] };
}

/**
 * Read a MySQL table's storage engine, as a read (never recorded in history).
 *
 * @param session - The connection's session.
 * @param table - The table.
 * @returns The engine, or null when it could not be read.
 */
export async function readTableEngine(session: SqlSession, table: string): Promise<string | null> {
	const { sql, params } = tableEngineStatement(table);
	try {
		const result = await session.execute(sql, { params, idempotent: true });
		const row = result.rows[0];
		const engine = row?.engine ?? row?.ENGINE;
		return typeof engine === 'string' && engine !== '' ? engine : null;
	} catch {
		return null;
	}
}

// =============================================================================
// NODES WITHOUT TRANSACTION TOOLS (this window)
// =============================================================================

/** Endpoint keys whose node answered `transactions-unavailable`, with the schema snapshot it was learnt under. */
const noTransactionEndpoints = new Map<string, number>();

/**
 * Remember that a node has no transaction tools.
 *
 * @param key - The endpoint key.
 * @param schemaAt - The schema snapshot's `refreshedAt` when it answered.
 */
export function noteNoTransactions(key: string, schemaAt: number): void {
	noTransactionEndpoints.set(key, schemaAt);
}

/**
 * Whether a node answered that it has no transaction tools, under this
 * schema snapshot. A newer snapshot (a refresh, or the reload after a
 * reconnect) forgets it.
 *
 * @param key - The endpoint key.
 * @param schemaAt - The schema snapshot's `refreshedAt` now.
 * @returns True only when it answered so under this snapshot.
 */
export function knownNoTransactions(key: string, schemaAt: number): boolean {
	const learnt = noTransactionEndpoints.get(key);
	if (learnt === undefined) return false;
	if (learnt !== schemaAt) {
		noTransactionEndpoints.delete(key);
		return false;
	}
	return true;
}

/** Forget every such node (tests). */
export function forgetNoTransactions(): void {
	noTransactionEndpoints.clear();
}
