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
// EXPLORER RUNNER — BATCH (the control flow of running N statements)
// =============================================================================
//
// `runStatementBatch` is the whole sequence a Run button triggers, with every
// language-specific decision handed in as a hook and every state change pushed
// out through a view. It imports no React and no platform code, so the rules
// the UI promises are unit-tested here against a fake session instead of being
// trusted to a component:
//
//   - statements are sent ONE AT A TIME, in order;
//   - the first failure ends the batch, and the rest are `skipped`, never
//     "rolled back" — each statement was its own call;
//   - a text pattern check may ask for confirmation BEFORE a statement is sent,
//     and the user may decline (the rest are skipped), run, or run and stop asking;
//   - a refusal vetoes the WHOLE batch before anything is sent;
//   - when the owner invalidates the batch's ticket (Stop waiting, a new run,
//     the owner unmounting: a closed document or a switch to another app) the
//     batch stops at once: nothing more is sent, and a late answer, and a late
//     failure, are DROPPED — never shown, never recorded;
//   - every finished statement is recorded exactly once, through `record`.
// =============================================================================

import { isStaleError } from '../errors';
import type { IGenerationTicket } from '../generation';
import { lineRange } from './format';
import type { IFailureNotice, IFailureState, IPatternFinding, IRunTarget, IStatementRunBase, PatternAnswer } from './types';

// =============================================================================
// HOOKS (what the app decides)
// =============================================================================

/** The language-specific decisions of one app's runner. */
export interface IBatchHooks<TRun extends IStatementRunBase, TSend, TResult, TNotice extends IFailureNotice = IFailureNotice> {
	/** Build the pending run for one target (the app adds its text field, kind and verb). */
	initRun(target: IRunTarget, index: number): TRun;
	/** The statement text of a run (for pattern checks and history). */
	textOf(run: TRun): string;
	/**
	 * Veto the whole batch before anything is sent (e.g. transaction control, or
	 * a write in a read-only editor). Return the message to show, or null to proceed.
	 */
	refuse?(runs: TRun[]): string | null;
	/** Whether pattern checks are on RIGHT NOW (read before every statement: "Run and stop asking" flips it mid-batch). */
	patternChecksOn?(): boolean;
	/** The text pattern check for one statement; null means nothing to confirm. */
	patternCheck?(run: TRun): IPatternFinding | null;
	/** "Run and stop asking on this connection" was chosen. */
	disablePatternChecks?(): void;
	/**
	 * Decide what is sent: the payload, and the fields to merge into the run
	 * (row limit applied, how it came about). A row limit is DATA the node
	 * enforces; nothing here rewrites the user's text unless the app chooses to.
	 */
	prepare(run: TRun): { send: TSend; patch?: Partial<TRun> };
	/** Send it. Receives the batch's ticket so the app can pass it down to the session. */
	execute(run: TRun, send: TSend, ticket: IGenerationTicket): Promise<TResult>;
	/** Turn the answer into the settled fields (outcome, row count, rows…). */
	settle(run: TRun, result: TResult, ms: number): Partial<TRun>;
	/**
	 * Read a failed statement. Receives the message AND the original thrown
	 * value, so an app can tell an ExplorerToolError's `kind` (upgrade, timeout,
	 * malformed, unavailable…) and its headline/detail apart instead of
	 * re-parsing text.
	 */
	describeFailure(message: string, error: unknown): TNotice;
	/** The sentence about the statements BEFORE a failure ('' when none). */
	formatPrior?(runs: TRun[], failedIndex: number): string;
	/** Called once for every finished statement (rows, affected, error, abandoned). */
	record?(run: TRun): void;
	/** A statement failed (the app may react, e.g. to "execute is disabled"). */
	onFailure?(notice: TNotice, run: TRun): void;
	/** Current time in ms (default `performance.now`). */
	now?(): number;
}

// =============================================================================
// VIEW (what the runner tells the screen)
// =============================================================================

/** Where the runner pushes every state change. The React hook is one implementation; a test is another. */
export interface IBatchView<TRun extends IStatementRunBase, TNotice extends IFailureNotice = IFailureNotice> {
	/** The batch was refused before anything was sent. */
	refused(message: string): void;
	/** The batch began: reset notices, show the pending list. */
	started(runs: TRun[]): void;
	/** The run list changed. */
	runs(runs: TRun[]): void;
	/** A statement was sent. `startedAt` is the clock reading when it was. */
	active(index: number, startedAt: number): void;
	/** Ask the user about a pattern finding; resolves with the answer. */
	confirm(run: TRun, finding: IPatternFinding): Promise<PatternAnswer>;
	/** A statement failed. */
	failed(failure: IFailureState<TNotice>): void;
	/** The batch ended normally (not dropped). `failedAt` is -1 when nothing failed. */
	finished(info: { runs: TRun[]; shown: TRun | null; resolved: TRun | null; failedAt: number }): void;
}

/** How a batch ended. */
export type BatchStatus = 'done' | 'refused' | 'dropped';

// =============================================================================
// THE BATCH
// =============================================================================

/**
 * Run a list of statements in order, stopping at the first error.
 *
 * @param targets - The statements to send, in order.
 * @param hooks - The app's decisions.
 * @param view - Where state changes go.
 * @param ticket - The batch's ticket; when it expires the batch stops silently.
 * @returns How it ended.
 */
export async function runStatementBatch<TRun extends IStatementRunBase, TSend, TResult, TNotice extends IFailureNotice = IFailureNotice>(
	targets: IRunTarget[],
	hooks: IBatchHooks<TRun, TSend, TResult, TNotice>,
	view: IBatchView<TRun, TNotice>,
	ticket: IGenerationTicket,
): Promise<BatchStatus> {
	const now = hooks.now ?? ((): number => performance.now());
	const list = targets.map((target, index) => hooks.initRun(target, index));

	// A refusal (transaction control, a write in a read-only editor) cannot work
	// through per-call execution, so it is raised before anything is sent rather
	// than run and misunderstood.
	const refusal = hooks.refuse?.(list) ?? null;
	if (refusal !== null) {
		view.refused(refusal);
		return 'refused';
	}

	view.started(list);
	const results = [...list];
	let failedAt = -1;

	for (let i = 0; i < results.length; i++) {
		if (!ticket.isCurrent()) return 'dropped';

		// One confirmation per matching statement, asked before it is sent.
		if (hooks.patternChecksOn?.() === true) {
			const finding = hooks.patternCheck?.(results[i] as TRun) ?? null;
			if (finding !== null) {
				const answer = await view.confirm(results[i] as TRun, finding);
				if (!ticket.isCurrent()) return 'dropped';
				if (answer === 'cancel') {
					for (let j = i; j < results.length; j++) results[j] = { ...(results[j] as TRun), outcome: 'skipped' };
					view.runs([...results]);
					break;
				}
				if (answer === 'always') hooks.disablePatternChecks?.();
			}
		}

		const prepared = hooks.prepare(results[i] as TRun);
		results[i] = { ...(results[i] as TRun), ...(prepared.patch ?? {}), outcome: 'running' };
		view.runs([...results]);
		const started = now();
		view.active(i, started);

		try {
			const response = await hooks.execute(results[i] as TRun, prepared.send, ticket);
			if (!ticket.isCurrent()) return 'dropped';
			const ms = now() - started;
			results[i] = { ...(results[i] as TRun), ms, ...hooks.settle(results[i] as TRun, response, ms) };
			view.runs([...results]);
			hooks.record?.(results[i] as TRun);
		} catch (error) {
			// An abandoned call's late failure is not this run's failure, and a
			// session-level stale marker is exactly that: drop, never show.
			if (!ticket.isCurrent() || isStaleError(error)) return 'dropped';
			const message = error instanceof Error ? error.message : String(error);
			const notice = hooks.describeFailure(message, error);
			results[i] = { ...(results[i] as TRun), outcome: 'error', error: message, ms: now() - started };
			for (let j = i + 1; j < results.length; j++) results[j] = { ...(results[j] as TRun), outcome: 'skipped' };
			view.runs([...results]);
			failedAt = i;
			view.failed({
				notice,
				index: i,
				lines: lineRange((results[i] as TRun).startLine, (results[i] as TRun).endLine),
				// Says what is true of the statements before the failure — the sentence
				// that stops a reader assuming the batch rolled back.
				prior: hooks.formatPrior?.(results, i) ?? '',
			});
			hooks.onFailure?.(notice, results[i] as TRun);
			hooks.record?.(results[i] as TRun);
			break;
		}
	}

	if (!ticket.isCurrent()) return 'dropped';

	// Show the last statement that returned rows; failing that, the last one
	// that resolved at all.
	const reversed = [...results].reverse();
	const withRows = reversed.find((run) => run.outcome === 'rows') ?? null;
	const resolved = reversed.find((run) => run.outcome === 'rows' || run.outcome === 'affected') ?? null;
	view.finished({ runs: results, shown: withRows ?? resolved, resolved, failedAt });
	return 'done';
}

/**
 * Mark a batch the user stopped waiting for: the statement in flight becomes
 * `abandoned` (it MAY still be running), the ones not yet sent become
 * `skipped`, and everything already settled stays as it was.
 *
 * @param runs - The batch as last published.
 * @param elapsedMs - How long the in-flight statement had been waiting.
 * @returns The new list, and the abandoned statement (for recording), if any.
 */
export function abandonRuns<TRun extends IStatementRunBase>(runs: readonly TRun[], elapsedMs: number): { runs: TRun[]; abandoned: TRun | null } {
	const next = runs.map((run): TRun => {
		if (run.outcome === 'running') return { ...run, outcome: 'abandoned', ms: elapsedMs };
		if (run.outcome === 'pending') return { ...run, outcome: 'skipped' };
		return run;
	});
	return { runs: next, abandoned: next.find((run) => run.outcome === 'abandoned') ?? null };
}
