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
// EXPLORER RUNNER — WORDING (per-statement outcomes and their sentences)
// =============================================================================
//
// Running N statements produces N outcomes, and each is its own call, so a
// batch that fails on statement 3 leaves 1 and 2 DONE and 4 onward not run.
// That is the single most important thing the UI has to say out loud, so the
// wording for it lives here, next to the data, and is unit-tested rather than
// assembled inline in a component.
//
// Elapsed time is always called ROUND TRIP: it measures the tool call leaving
// the browser and coming back, which includes queueing and transport. It is not
// the database's execution time and must never be labelled as such.
// =============================================================================

import type { IStatementRunBase } from './types';

// =============================================================================
// AT THE DATABASE
// =============================================================================

/**
 * Whether one of these statements is AT THE DATABASE right now.
 *
 * NOT the same question as "is the batch running". The batch is running from
 * the moment Run is pressed, which includes the time a confirmation dialog
 * sits open with nothing yet sent; only a run whose outcome is `running` has
 * been handed to the session and is waiting on an answer.
 *
 * The "Stop waiting" affordance keys on THIS, because what it says when it is
 * used — that the database may still be running the statement and cannot be
 * told to stop — is only true of a request that was actually made.
 *
 * @param runs - The batch's statements, in order.
 * @returns True when one of them has been sent and has not answered yet.
 */
export function hasStatementInFlight(runs: readonly IStatementRunBase[]): boolean {
	return runs.some((run) => run.outcome === 'running');
}

// =============================================================================
// ELAPSED + POSITION
// =============================================================================

/**
 * Format a round-trip duration.
 *
 * @param ms - Milliseconds measured in the browser.
 * @returns e.g. `round trip 0.031 s`.
 */
export function formatElapsed(ms: number): string {
	return `round trip ${(ms / 1000).toFixed(3)} s`;
}

/**
 * Describe a line range the way the pre-run line and the strip do.
 *
 * @param from - First line (one-based), or undefined for a statement with no
 *               position in the editor (a rerun from the history drawer).
 * @param to - Last line (one-based).
 * @returns e.g. `line 4` or `lines 4–6`; '' when there is no position.
 */
export function lineRange(from?: number, to?: number): string {
	if (from === undefined || to === undefined) return '';
	return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

/**
 * Clock time for the meta and history lines.
 *
 * @param at - Unix ms.
 * @returns `HH:MM`.
 */
export function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// =============================================================================
// BATCH SENTENCES
// =============================================================================

/** The words a batch position can be described with. */
type OutcomeGroup = 'ran' | 'done' | 'failed' | 'not run' | 'abandoned';

/** The word an app uses for a finished statement that changed something. SQL says `committed`. */
export interface IBatchWords {
	/** What a finished non-read statement is called (default `committed`). */
	changed: string;
	/** What the failure banner says about the statements BEFORE a failure that changed something. */
	priorChanged: (span: string) => string;
	/** What it says when nothing before the failure changed anything. */
	priorRead: (span: string) => string;
}

/** SQL Explorer's words: each statement runs and commits on its own. */
export const AUTOCOMMIT_WORDS: IBatchWords = {
	changed: 'committed',
	priorChanged: (span) => `${span} already committed (each statement runs in its own autocommit transaction).`,
	priorRead: (span) => `${span} already ran.`,
};

/**
 * Which word describes a finished statement.
 *
 * A read `ran`; anything else is the app's word for a change (`committed` in
 * SQL). The distinction matters because that word is the app's way of saying
 * the change is already durable and cannot be undone from here — saying it
 * about a read dilutes the one word that has to carry that weight. Anything
 * not clearly read-only is called changed, which is the safe direction.
 *
 * @param run - The statement.
 * @returns The group, or null for a statement that has not resolved.
 */
function groupOf(run: IStatementRunBase): OutcomeGroup | null {
	if (run.outcome === 'rows' || run.outcome === 'affected') return run.kind === 'read' ? 'ran' : 'done';
	if (run.outcome === 'error') return 'failed';
	if (run.outcome === 'abandoned') return 'abandoned';
	if (run.outcome === 'skipped' || run.outcome === 'pending') return 'not run';
	return null;
}

/**
 * Summarise a finished batch in one line, e.g.
 * `1 ran · 2 committed · 3 failed · 4–5 not run`.
 *
 * Positions are one-based and consecutive positions in the same group collapse
 * into a range. A statement still running contributes nothing, so the line is
 * only complete once the batch is.
 *
 * @param runs - The batch's statements, in order.
 * @param words - The app's words for a change (default SQL's `committed`).
 * @returns The summary line ('' when there is nothing to say).
 */
export function formatBatchOutcome(runs: readonly IStatementRunBase[], words: Pick<IBatchWords, 'changed'> = AUTOCOMMIT_WORDS): string {
	const parts: string[] = [];
	let groupStart = -1;
	let groupName: OutcomeGroup | null = null;

	/**
	 * Close the open range and push its phrase.
	 *
	 * @param endIndex - One-based position of the range's last statement.
	 */
	const flush = (endIndex: number): void => {
		if (groupName === null || groupStart < 0) return;
		const span = groupStart === endIndex ? `${groupStart}` : `${groupStart}–${endIndex}`;
		parts.push(`${span} ${groupName === 'done' ? words.changed : groupName}`);
	};

	for (let i = 0; i < runs.length; i++) {
		const group = groupOf(runs[i] as IStatementRunBase);
		if (group === groupName) continue;
		flush(i);
		groupName = group;
		groupStart = group === null ? -1 : i + 1;
	}
	flush(runs.length);
	return parts.join(' · ');
}

/**
 * What the failure banner says about the statements BEFORE the one that
 * failed — the sentence that has to stop a reader assuming a failed batch
 * rolled back.
 *
 * @param runs - The batch, in order.
 * @param failedIndex - Zero-based index of the statement that failed.
 * @param words - The app's words (default SQL's autocommit wording).
 * @returns The sentence, or '' when nothing ran before the failure.
 */
export function formatPriorStatements(runs: readonly IStatementRunBase[], failedIndex: number, words: Pick<IBatchWords, 'priorChanged' | 'priorRead'> = AUTOCOMMIT_WORDS): string {
	const prior = runs.slice(0, Math.max(0, failedIndex));
	if (prior.length === 0) return '';
	const span = prior.length === 1 ? 'Statement 1' : `Statements 1–${prior.length}`;
	// One write or DDL before the failure is enough: something is durable.
	const changed = prior.some((run) => run.kind !== 'read');
	return changed ? words.priorChanged(span) : words.priorRead(span);
}

/**
 * The status strip's label for one statement, e.g.
 * `2 UPDATE · 3 affected · round trip 0.012 s`.
 *
 * The full text is in the label rather than carried by colour, so the strip's
 * buttons have complete accessible names.
 *
 * @param run - The statement.
 * @returns The label.
 */
export function formatRunLabel(run: IStatementRunBase): string {
	const head = `${run.index + 1} ${run.verb}`;
	const elapsed = run.ms === undefined ? '' : ` · ${formatElapsed(run.ms)}`;
	switch (run.outcome) {
		case 'rows':
			return `${head} · ${(run.rowCount ?? 0).toLocaleString()} rows${elapsed}`;
		case 'affected':
			return `${head} · ${(run.affected ?? 0).toLocaleString()} affected${elapsed}`;
		case 'error':
			return `${head} · error${elapsed}`;
		case 'abandoned':
			return `${head} · abandoned${elapsed}`;
		case 'running':
			return `${head} · running…`;
		case 'skipped':
			return `${head} · not run`;
		default:
			return `${head} · queued`;
	}
}

/**
 * The banner sentence after the user stops waiting.
 *
 * @param ms - How long the statement had been waiting, in ms.
 * @returns The sentence.
 */
export function formatAbandonNotice(ms: number): string {
	return `Stopped waiting after ${(ms / 1000).toFixed(1)} s. The statement may still be running on the database; this tool cannot cancel it.`;
}
