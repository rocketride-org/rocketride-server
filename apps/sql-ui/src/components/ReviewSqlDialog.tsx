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
// SQL-UI — REVIEW SQL, APPLY CONFIRMATION, APPLY RESULT (staged row edits)
// =============================================================================
//
// What the data browser shows between staging and saving:
//
//   ReviewSqlDialog      the exact statements Apply will send, in order, each
//                        with the rows it must change. BEGIN / COMMIT frame
//                        them ONLY when the apply asks for one transaction
//                        (sql/applyMode.ts: PostgreSQL, and MySQL unless the
//                        table's engine keeps none); otherwise the words say
//                        each statement commits on its own, and where the
//                        engine is not known they say it may. Values are
//                        shown inline to be read; Apply binds them.
//   ApplyConfirmDialog   "Apply 3 changes to orders on Shop Postgres?", one
//                        line per change, and whether it is all or none.
//   applyResultText      what the reply says was saved: all, none, some, or
//                        (a commit whose answer never arrived) unknown.
//
// Presentational: statements, flags and handlers come from props; the text
// is built by the pure helpers below, which the tests read.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, ConfirmDialog, Modal } from 'shell';
import type { SqlApplyResult, SqlApplyStatement, SqlDialect } from '../connect';
import { EACH_COMMITS_TEXT } from '../sql/applyMode';
import { previewSql } from '../sql/preview';
import type { ApplyWording } from '../sql/applyMode';
import { ROW_CONFLICT_TEXT } from '../sql/rowEdits';
import type { RowEdits } from '../sql/rowEdits';
import { applyButtonLabel, pendingCountText } from './PendingChangesBar';

// =============================================================================
// WORDING
// =============================================================================

// Values shown in place of `$n` (sql/preview.ts), re-exported for the review's readers.
export { previewSql, sqlLiteral } from '../sql/preview';

/**
 * A count of something, singular or plural.
 *
 * @param n - The count.
 * @param one - The singular noun.
 * @param many - The plural.
 * @returns `1 change`, `3 changes`.
 */
function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Review SQL's opening sentence.
 *
 * @param wording - What the apply may promise (sql/applyMode.ts).
 * @returns The sentence.
 */
export function reviewIntroText(wording: ApplyWording): string {
	if (wording === 'transaction') return 'These statements run in one transaction. If any fails, none are applied and your edits stay staged.';
	if (wording === 'hedged') return 'These statements run in one transaction if the table\'s storage engine keeps transactions (InnoDB does; MyISAM does not, and there each commits on its own).';
	return 'Each statement runs and commits on its own. If one fails, the ones before it stay applied and the rest are not run.';
}

/**
 * The statements and the rows they must change: `3 statements · 3 rows`.
 *
 * @param statements - The statements.
 * @returns The summary (rows only when every statement expects a count).
 */
export function reviewSummaryText(statements: readonly SqlApplyStatement[]): string {
	const head = count(statements.length, 'statement', 'statements');
	if (!statements.every((statement) => statement.expect !== undefined)) return head;
	const rows = statements.reduce((sum, statement) => sum + (statement.expect ?? 0), 0);
	return `${head} · ${count(rows, 'row', 'rows')}`;
}

/** Why Apply waits after an apply whose answer never came, until Review SQL is opened (review P4 R2-I1). */
export const MAY_HAVE_RUN_REASON = 'The last Apply may have run. Open Review SQL and check the data before applying again.';

/**
 * What Review SQL and the confirmation say after an apply whose answer never
 * came: its changes may already be saved, and applying them again could
 * insert new rows twice.
 *
 * @param inserted - How many of the staged changes are new rows.
 * @returns The warning.
 */
export function mayHaveRunWarning(inserted: number): string {
	const twice = inserted > 0 ? ' A new row that was saved would be inserted a second time.' : '';
	return `The last Apply may have run: its answer did not arrive. Some of these changes may already be saved, so check the data before you apply again.${twice}`;
}

/**
 * Review SQL's note on the columns staged changes match by key only (their
 * old values may not come back exactly, so a change someone else made to
 * them is not detected): an edit's changed columns, a delete's others.
 *
 * @param columns - The columns (sql/rowEdits.ts uncheckedColumns).
 * @returns The note, or null when every one is checked.
 */
export function conflictCheckNote(columns: readonly string[]): string | null {
	if (columns.length === 0) return null;
	if (columns.length === 1) return `Changes to ${columns[0]} can't be checked for conflicts: its value may not come back exactly, so it is not compared.`;
	const list = `${columns.slice(0, -1).join(', ')} and ${columns[columns.length - 1]}`;
	return `Changes to ${list} can't be checked for conflicts: their values may not come back exactly, so they are not compared.`;
}

/**
 * One label per staged change, in statement order: `1 row · edited`.
 *
 * @param edits - The staged row edits.
 * @returns The labels.
 */
export function rowStatementLabels(edits: RowEdits): string[] {
	const what = { update: 'edited', insert: 'new', delete: 'deleted' } as const;
	return edits.entries.map((edit) => `1 row · ${what[edit.kind]}`);
}

/** The line that opens a transactional apply in the review. */
const BEGIN_LINE = "BEGIN; -- through the node's begin tool";

/**
 * The line that closes a transactional apply in the review. "All or none"
 * only where the transaction is known to hold (not `hedged`: the table's
 * engine may keep none).
 *
 * @param total - How many statements it holds.
 * @param wording - What the apply may promise.
 * @returns `COMMIT; -- all 3, or none`, or a bare `COMMIT;`.
 */
function commitLine(total: number, wording: ApplyWording): string {
	return total === 1 || wording !== 'transaction' ? 'COMMIT;' : `COMMIT; -- all ${total}, or none`;
}

/**
 * The whole apply as one script, for reading and for Copy SQL: framed by
 * BEGIN / COMMIT only when it asks for one transaction.
 *
 * @param statements - The statements.
 * @param dialect - The dialect.
 * @param wording - What the apply may promise (`each`: no transaction is asked for).
 * @returns The script, one statement per line.
 */
export function reviewScript(statements: readonly SqlApplyStatement[], dialect: SqlDialect, wording: ApplyWording): string {
	const body = statements.map((statement) => `${previewSql(statement, dialect)};`);
	return (wording !== 'each' ? [BEGIN_LINE, ...body, commitLine(statements.length, wording)] : body).join('\n');
}

/**
 * The Apply confirmation's title.
 *
 * @param total - How many changes.
 * @returns `Apply 3 changes?`
 */
export function applyConfirmTitle(total: number): string {
	return `${applyButtonLabel(total)}?`;
}

/** What the Apply confirmation needs to know. */
export interface ApplyConfirmFacts {
	/** How many changes. */
	total: number;
	/** The table. */
	table: string;
	/** The connection's name. */
	connection: string;
	/** What the apply may promise (sql/applyMode.ts). */
	wording: ApplyWording;
	/** How many of the changes are deletes. */
	deletes: number;
}

/**
 * The Apply confirmation's two sentences: what runs where, and what happens
 * if one change fails.
 *
 * @param facts - See {@link ApplyConfirmFacts}.
 * @returns The lead and the note.
 */
export function applyConfirmParts(facts: ApplyConfirmFacts): { lead: string; note: string } {
	const { total, table, connection, wording, deletes } = facts;
	const lead = `Apply ${count(total, 'change', 'changes')} to ${table} on ${connection}?`;
	let note: string;
	if (wording === 'transaction') {
		note = total === 1 ? 'It runs in one transaction.' : `They run together in one transaction: all ${total} are saved, or none.`;
	} else if (wording === 'hedged') {
		note = 'They run in one transaction if the table\'s storage engine keeps transactions; if it does not, each change commits on its own and a failure leaves earlier changes saved.';
	} else {
		note = total === 1 ? 'It commits on its own.' : EACH_COMMITS_TEXT;
	}
	if (deletes > 0) note += ' A delete cannot be undone after it commits.';
	return { lead, note };
}

/**
 * The Apply confirmation as one text (also what a screen reader is told).
 *
 * @param facts - See {@link ApplyConfirmFacts}.
 * @returns The text.
 */
export function applyConfirmText(facts: ApplyConfirmFacts): string {
	const { lead, note } = applyConfirmParts(facts);
	return `${lead} ${note}`;
}

/** What an apply's outcome banner says. */
export interface ApplyResultText {
	/** Banner severity. */
	variant: 'info' | 'warning' | 'error';
	/** The first line: what is saved. */
	title: string;
	/** The app's own sentences. */
	detail: string;
	/** The database's (or node's) words, verbatim, for a "Database said" block; null when there are none. */
	message: string | null;
}

/**
 * Format a time as HH:MM.
 *
 * @param ms - Unix milliseconds.
 * @returns The local time.
 */
function clockTime(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * What an apply's reply says was saved.
 *
 * @param result - The reply (SqlSession.applyBatch).
 * @param facts - How many changes were sent, to which table, when it finished, and what was promised.
 * @param facts.total - How many changes were sent.
 * @param facts.table - The table.
 * @param facts.at - When the reply arrived (Unix ms).
 * @param facts.wording - What the confirmation promised (`hedged`: the table's engine was not known).
 * @returns The banner text.
 */
export function applyResultText(result: SqlApplyResult, facts: { total: number; table: string; at: number; wording?: ApplyWording }): ApplyResultText {
	const { total, table, at } = facts;
	const failure = result.failure;
	if (failure === null) {
		return {
			variant: 'info',
			title: `${count(total, 'change', 'changes')} applied to ${table}`,
			detail: result.transactional ? `1 transaction · committed ${clockTime(at)}` : `each committed on its own · ${clockTime(at)}`,
			message: null,
		};
	}
	// A row count that did not match is the app's sentence, not the database's;
	// no row at all is a row someone else changed (or deleted) since it was read.
	const conflict = failure.stage === 'expect' && result.results[failure.index]?.affected_rows === 0;
	const own = failure.stage === 'expect' ? ` ${conflict ? ROW_CONFLICT_TEXT : failure.message}` : '';
	const message = failure.stage === 'expect' ? null : failure.message;
	const locks = failure.rollbackConfirmed ? '' : ` The rollback was not confirmed; the database may hold locks on ${table} for up to 5 minutes.`;
	if (result.transactional) {
		if (failure.stage === 'commit' && failure.unknown) {
			return { variant: 'warning', title: 'The commit\'s answer did not arrive.', detail: `These changes may or may not have been saved; check the data.${locks}`, message };
		}
		const what = failure.stage === 'commit' ? 'The commit was refused.' : `Change ${failure.index + 1} of ${total} failed.${own}`;
		if (facts.wording === 'hedged') {
			return { variant: 'error', title: 'Apply failed.', detail: `${what} If the table's storage engine keeps no transactions, changes before the failure may be saved; check the data.${locks}`, message };
		}
		return { variant: 'error', title: 'Apply failed. No changes were applied.', detail: `${what} Your edits are still staged.${locks}`, message };
	}
	const parts: string[] = [];
	if (own !== '') parts.push(own.trim());
	// Not staged again silently: it may have run (sql/rowEdits.ts settledCount drops it).
	if (failure.unknown) parts.push(`Change ${failure.index + 1} may have been saved: its answer did not arrive. It is no longer staged; check the data.`);
	const firstNotRun = failure.index + 2;
	if (firstNotRun === total) parts.push(`Change ${total} was not run.`);
	else if (firstNotRun < total) parts.push(`Changes ${firstNotRun}–${total} were not run.`);
	return {
		variant: 'error',
		title: `Apply stopped at change ${failure.index + 1} of ${total}. ${failure.committed} of ${total} applied.`,
		detail: parts.join(' '),
		message,
	};
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	subtitle: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginBottom: 10,
	} as CSSProperties,

	intro: {
		fontSize: 12.5,
		lineHeight: 1.6,
		marginBottom: 12,
	} as CSSProperties,

	sectionHead: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginBottom: 6,
	} as CSSProperties,

	script: {
		margin: 0,
		padding: '8px 10px',
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		maxHeight: 320,
		overflow: 'auto',
	} as CSSProperties,

	line: {
		display: 'flex',
		gap: 12,
		alignItems: 'baseline',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		lineHeight: 1.7,
	} as CSSProperties,

	statement: {
		flex: 1,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,

	frame: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	label: {
		flexShrink: 0,
		fontFamily: 'var(--rr-font-family, inherit)',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	bindNote: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 8,
	} as CSSProperties,

	footer: {
		display: 'flex',
		gap: 8,
		width: '100%',
		flexWrap: 'wrap',
	} as CSSProperties,

	spacer: {
		flex: 1,
	} as CSSProperties,

	confirmList: {
		margin: '10px 0',
		paddingLeft: 18,
		fontSize: 12.5,
		lineHeight: 1.7,
	} as CSSProperties,

	confirmNote: {
		fontSize: 12.5,
		lineHeight: 1.6,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// REVIEW SQL
// =============================================================================

/** Props for the {@link ReviewSqlDialog} component. */
export interface ReviewSqlDialogProps {
	/** The table the changes are for. */
	table: string;
	/** The connection's name. */
	connectionName: string;
	/** The connection's dialect (how values are shown). */
	dialect: SqlDialect;
	/** The statements Apply will send (sql/rowEdits.ts buildRowStatements). */
	statements: SqlApplyStatement[];
	/** One label per statement (rowStatementLabels), or none. */
	labels?: string[];
	/** What the apply may promise (sql/applyMode.ts rowApplyMode). */
	wording: ApplyWording;
	/** An apply is running. */
	busy?: boolean;
	/** Why Apply cannot run now, or null. */
	applyDisabledReason?: string | null;
	/** Changed columns matched by key only (sql/rowEdits.ts uncheckedColumns). */
	uncheckedColumns?: readonly string[];
	/** A warning shown first (the last apply may have run: mayHaveRunWarning), or null. */
	warning?: string | null;
	/** Back to editing (also the ✕ and Escape). */
	onClose: () => void;
	/** Apply was chosen (the parent confirms first). */
	onApply: () => void;
	/** Discard all was chosen (the parent asks first when two or more would go). */
	onDiscardAll: () => void;
	/** Copy SQL, given the script (omitted: no Copy button). */
	onCopySql?: (script: string) => void;
	/** Open in a query tab, given the script (omitted: no button). */
	onOpenInQuery?: (script: string) => void;
}

/**
 * The Review SQL dialog: the exact statements, in order, framed by BEGIN /
 * COMMIT only when the apply asks for one transaction.
 *
 * @param props - {@link ReviewSqlDialogProps}.
 * @returns The dialog.
 */
export const ReviewSqlDialog: React.FC<ReviewSqlDialogProps> = (props) => {
	const { table, connectionName, dialect, statements, labels = [], wording, busy = false, applyDisabledReason = null, uncheckedColumns = [], warning = null, onClose, onApply, onDiscardAll, onCopySql, onOpenInQuery } = props;
	const unchecked = conflictCheckNote(uncheckedColumns);
	const script = reviewScript(statements, dialect, wording);
	const framed = wording !== 'each';
	const footer = (
		<div style={styles.footer}>
			{onCopySql && <Button variant="ghost" small onClick={() => onCopySql(script)}>Copy SQL</Button>}
			{onOpenInQuery && <Button variant="ghost" small onClick={() => onOpenInQuery(script)}>Open in a query tab</Button>}
			<span style={styles.spacer} />
			<Button variant="ghost" small onClick={onDiscardAll} disabled={busy}>Discard all</Button>
			<Button variant="secondary" small onClick={onClose}>Back to editing</Button>
			<Button
				variant="primary"
				small
				onClick={onApply}
				disabled={busy || applyDisabledReason !== null || statements.length === 0}
				{...(applyDisabledReason !== null ? { title: applyDisabledReason } : {})}
			>
				{busy ? 'Applying...' : applyButtonLabel(statements.length)}
			</Button>
		</div>
	);
	return (
		<Modal title="Review SQL" onClose={onClose} footer={footer} width={720}>
			<div style={styles.subtitle}>{pendingCountText(statements.length)} to {table} · {connectionName}</div>
			{warning && <div style={styles.intro} role="alert"><Banner variant="warning">{warning}</Banner></div>}
			<div style={styles.intro}>{reviewIntroText(wording)}</div>
			<div style={styles.sectionHead}>
				<span>Statements</span>
				<span>{reviewSummaryText(statements)}</span>
			</div>
			<div style={styles.script} role="list" aria-label="Statements Apply will run">
				{framed && (
					<div style={{ ...styles.line, ...styles.frame }}>
						<span style={styles.statement}>{BEGIN_LINE}</span>
					</div>
				)}
				{statements.map((statement, i) => (
					<div key={i} style={styles.line} role="listitem">
						<span style={styles.statement}>{previewSql(statement, dialect)};</span>
						{labels[i] && <span style={styles.label}>{labels[i]}</span>}
					</div>
				))}
				{framed && (
					<div style={{ ...styles.line, ...styles.frame }}>
						<span style={styles.statement}>{commitLine(statements.length, wording)}</span>
					</div>
				)}
			</div>
			<div style={styles.bindNote}>Values are shown in place to be read. Apply sends them separately, bound, never as part of the statement text. Each edit and delete also checks the row's old values, so a row someone else changed since you loaded it is not overwritten.</div>
			{unchecked && <div style={styles.bindNote}>{unchecked}</div>}
		</Modal>
	);
};

// =============================================================================
// APPLY CONFIRMATION
// =============================================================================

/** Props for the {@link ApplyConfirmDialog} component. */
export interface ApplyConfirmDialogProps extends ApplyConfirmFacts {
	/** One line per change (sql/rowEdits.ts describeRowEdit). */
	lines: string[];
	/** A warning shown first (the last apply may have run), or null. */
	warning?: string | null;
	/** An apply is running. */
	busy?: boolean;
	/** Apply. */
	onConfirm: () => void;
	/** Cancel. */
	onCancel: () => void;
}

/**
 * The Apply confirmation: what runs where, one line per change, and whether
 * it is all or none.
 *
 * @param props - {@link ApplyConfirmDialogProps}.
 * @returns The dialog.
 */
export const ApplyConfirmDialog: React.FC<ApplyConfirmDialogProps> = ({ lines, busy = false, warning = null, onConfirm, onCancel, ...facts }) => {
	const { lead, note } = applyConfirmParts(facts);
	return (
		<ConfirmDialog
			title={applyConfirmTitle(facts.total)}
			message={
				<>
					{warning && <div style={styles.confirmNote} role="alert"><strong>{warning}</strong></div>}
					<div>{lead}</div>
					<ul style={styles.confirmList}>
						{lines.map((line, i) => <li key={i}>{line} · 1 row</li>)}
					</ul>
					<div style={styles.confirmNote}>{note}</div>
				</>
			}
			confirmLabel={busy ? 'Applying...' : applyButtonLabel(facts.total)}
			destructive={facts.deletes > 0}
			confirmDisabled={busy}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
};

export default ReviewSqlDialog;
