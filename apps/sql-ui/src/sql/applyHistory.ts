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
// SQL — APPLY HISTORY (an apply's statements, as history entries)
// =============================================================================
//
// Every statement an apply ran goes into the connection's history, like a
// statement run on the Query page: its text with the values shown in place
// (sql/preview.ts), and an outcome that says what happened to it:
//
//   saved                       `affected`, with the rows it changed;
//   ran, then rolled back       `error`, "Rolled back: …" (`abandoned`, "may be
//                               saved", where the table's engine was not known);
//   failed                      `error`, the database's words;
//   not known (a lost answer)   `abandoned`.
//
// A statement the apply never sent is not recorded. Pure, so it is tested
// directly; the caller records the entries (SqlEnv.history.record).
// =============================================================================

import type { SqlApplyResult, SqlApplyStatement, SqlDialect } from '../connect';
import type { HistoryEntry, HistoryKind } from '../history/types';
import type { ApplyWording } from './applyMode';
import { classifyStatement } from './classify';
import { previewSql } from './preview';

/**
 * The history entries for one apply.
 *
 * @param statements - The statements it carried, in order.
 * @param result - Its reply.
 * @param facts - The dialect (how values are shown), when it started, and how long it took.
 * @param facts.dialect - The connection's dialect.
 * @param facts.at - When the apply started (Unix ms).
 * @param facts.ms - The apply's round trip (each entry carries it).
 * @param facts.wording - What the confirmation promised (`hedged`: a rollback may have undone nothing).
 * @returns One entry per statement that ran, in order.
 */
export function applyHistoryEntries(statements: readonly SqlApplyStatement[], result: SqlApplyResult, facts: { dialect: SqlDialect; at: number; ms: number; wording?: ApplyWording }): HistoryEntry[] {
	const { dialect, at, ms } = facts;
	const hedged = facts.wording === 'hedged';
	const failure = result.failure;
	const stamp = `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const entry = (index: number, outcome: Pick<HistoryEntry, 'outcome'> & { affected?: number; error?: string }): HistoryEntry => {
		const statement = statements[index] as SqlApplyStatement;
		return {
			id: `${stamp}-apply-${index}`,
			sql: previewSql(statement, dialect),
			at,
			ms,
			kind: classifyStatement(statement.sql, dialect) as HistoryKind,
			outcome: outcome.outcome,
			...(outcome.affected !== undefined ? { affected: outcome.affected } : {}),
			...(outcome.error !== undefined ? { error: outcome.error } : {}),
		};
	};
	const affected = (index: number): number => result.results[index]?.affected_rows ?? 0;
	if (failure === null) return statements.map((_, index) => entry(index, { outcome: 'affected', affected: affected(index) }));

	const total = statements.length;
	const entries: HistoryEntry[] = [];
	if (result.transactional && hedged) {
		// A table whose engine may keep no transactions: what ran may be saved.
		const which = failure.stage === 'commit' ? 'The commit failed' : `Change ${failure.index + 1} of ${total} failed`;
		const maybe = `${which}. If the table's storage engine keeps no transactions, this change may be saved; check the data.`;
		const ran = failure.stage === 'commit' ? total : failure.index;
		for (let index = 0; index < ran; index++) entries.push(entry(index, { outcome: 'abandoned', error: maybe }));
		if (failure.stage !== 'commit') entries.push(entry(failure.index, { outcome: 'error', error: failure.message }));
		return entries;
	}
	if (result.transactional) {
		if (failure.stage === 'commit') {
			const error = failure.unknown
				? 'The commit\'s answer did not arrive: this change may or may not have been saved.'
				: 'Rolled back: the commit was refused, so nothing was saved.';
			for (let index = 0; index < total; index++) entries.push(entry(index, { outcome: failure.unknown ? 'abandoned' : 'error', error }));
			return entries;
		}
		const rolledBack = `Rolled back: change ${failure.index + 1} of ${total} failed, so nothing was saved.`;
		for (let index = 0; index < failure.index; index++) entries.push(entry(index, { outcome: 'error', error: rolledBack }));
		entries.push(entry(failure.index, { outcome: 'error', error: failure.message }));
		return entries;
	}
	// Statement by statement: the saved ones, then the one that stopped it.
	const saved = failure.stage === 'expect' ? failure.index : failure.committed;
	for (let index = 0; index < saved; index++) entries.push(entry(index, { outcome: 'affected', affected: affected(index) }));
	if (failure.stage === 'expect') {
		entries.push(entry(failure.index, { outcome: 'affected', affected: affected(failure.index), error: failure.message }));
	} else {
		entries.push(entry(failure.index, failure.unknown ? { outcome: 'abandoned', error: failure.message } : { outcome: 'error', error: failure.message }));
	}
	return entries;
}
