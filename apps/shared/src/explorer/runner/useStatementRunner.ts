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
// EXPLORER RUNNER — useStatementRunner (the batch, as React state)
// =============================================================================
//
// A thin binding of runStatementBatch to component state. All the rules live in
// batch.ts (and are tested there); this file only turns the batch's view calls
// into state, owns the generation that makes "Stop waiting" honest, and keeps
// the refs the original query view kept:
//
//   - a GENERATION, not a counter: Stop waiting, and the owner unmounting (a
//     closed document, a switch to another app), expire the batch's ticket:
//     nothing more is sent and the late answer is dropped;
//   - the clock reading of the statement in flight, for "stopped waiting after N s";
//   - the pending confirmation's resolver, cancelled on unmount so the batch
//     never awaits a dialog nobody can answer;
//   - a MOUNTED flag, set on EVERY setup (React StrictMode runs setup, cleanup
//     and setup again on one instance, and a flag the cleanup cleared would
//     otherwise stay false for the life of that instance — silently dropping
//     every later statement from history).
//
// The hooks are read from a ref at call time, so a run always uses the app's
// CURRENT decisions (the row limit chosen now, the pattern-check switch as it
// is now) without making `runTargets` change identity on every render.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGeneration } from '../generation';
import type { IGeneration } from '../generation';
import { abandonRuns, runStatementBatch } from './batch';
import type { IBatchHooks, IBatchView } from './batch';
import { formatAbandonNotice, formatBatchOutcome, hasStatementInFlight } from './format';
import type { IFailureNotice, IFailureState, IPatternFinding, IRunTarget, IStatementRunBase, PatternAnswer } from './types';

/** How long a statement must be in flight before "Stop waiting" is offered. */
export const STOP_WAITING_AFTER_MS = 1000;

/** What an app gives the runner on top of the batch hooks. */
export interface IStatementRunnerConfig<TRun extends IStatementRunBase, TSend, TResult, TNotice extends IFailureNotice = IFailureNotice>
	extends IBatchHooks<TRun, TSend, TResult, TNotice> {
	/** Whether a run may start now (e.g. the shell is connected). Default: always. */
	canRun?(): boolean;
	/** The app's reset at the start of a run (clear an inspector, retire a preview banner…). */
	onStart?(): void;
	/** The app's reaction when a batch ends normally. */
	onFinished?(info: { runs: TRun[]; shown: TRun | null; resolved: TRun | null; failedAt: number }, opts: { fromEditor: boolean }): void;
	/** The sentence to announce when a batch ends, or null for none. Default: the batch summary for several statements. */
	summarize?(info: { runs: TRun[]; shown: TRun | null; failedAt: number }): string | null;
	/** Politely announce a sentence (the app's announcer). */
	announce?(text: string): void;
	/** The user stopped waiting (e.g. return focus to the editor). */
	onStopped?(): void;
	/** The banner sentence after Stop waiting. Default: the shared sentence. */
	abandonMessage?(ms: number): string;
	/** Wording for the batch summary announcement. */
	batchWords?: { changed: string };
}

/** The pending confirmation. */
export interface IPatternPrompt<TRun extends IStatementRunBase> {
	/** The statement the check fired on. */
	run: TRun;
	/** What the check saw. */
	finding: IPatternFinding;
}

/** What the runner exposes. */
export interface IStatementRunner<TRun extends IStatementRunBase, TNotice extends IFailureNotice = IFailureNotice> {
	/** The batch's statements, in order. */
	runs: TRun[];
	/** Whether a batch is running (including while a confirmation is open). */
	running: boolean;
	/** Whether a statement is AT THE NODE (not the same as `running`). */
	inFlight: boolean;
	/** Whether "Stop waiting" should be offered (a statement has been in flight for a second). */
	canStop: boolean;
	/** Index of the statement whose result is shown, or null. */
	selectedRun: number | null;
	/** Choose which statement's result is shown. */
	setSelectedRun(index: number | null): void;
	/** Index of the statement being sent. */
	activeIndex: number;
	/** The failure, if the last batch ended in one. */
	failure: IFailureState<TNotice> | null;
	/** The "stopped waiting" sentence, if the user stopped. */
	abandonNotice: string | null;
	/** The reason the last batch was refused, if it was. */
	refusal: string | null;
	/** The open confirmation, if any. */
	patternPrompt: IPatternPrompt<TRun> | null;
	/** Answer the open confirmation. */
	answerPattern(answer: PatternAnswer): void;
	/** Run statements in order, stopping at the first error. */
	runTargets(targets: IRunTarget[], opts?: { fromEditor?: boolean }): Promise<void>;
	/** Stop waiting for the statement in flight (it is NOT cancelled on the node). */
	stopWaiting(): void;
}

/** What the runner's owner holds for as long as it is mounted. */
export interface IRunnerLifetime {
	/** The runner's generation: expiring it drops the batch in progress. */
	generation: IGeneration;
	/** Whether the owner is mounted (gates `record`). */
	mounted: { current: boolean };
	/** The pending confirmation's resolver, if a dialog is open. */
	patternResolver: { current: ((answer: PatternAnswer) => void) | null };
}

/**
 * The runner's mount effect. Sets the mounted flag on EVERY setup (React
 * StrictMode runs setup, cleanup and setup again on one instance) and returns
 * the cleanup the owner's unmount runs: it expires the batch in progress (the
 * statement in flight finishes at the node; nothing after it is sent) and
 * cancels an open confirmation.
 *
 * @param lifetime - The runner's refs.
 * @returns The cleanup.
 */
export function attachRunnerLifetime(lifetime: IRunnerLifetime): () => void {
	lifetime.mounted.current = true;
	return () => {
		lifetime.mounted.current = false;
		// Expire the batch's ticket: a closed tab or a switched-away app must not
		// keep sending statements nobody is watching. The batch checks its ticket
		// before every statement, so nothing after the one in flight is sent; that
		// one finishes at the node (it cannot be cancelled) and its answer is dropped.
		lifetime.generation.invalidate();
		// A dialog open at unmount would otherwise leave the batch awaiting a
		// promise nobody can settle.
		lifetime.patternResolver.current?.('cancel');
		lifetime.patternResolver.current = null;
	};
}

/**
 * Run batches of statements with the Explorer's honesty rules, as React state.
 *
 * @param config - The app's decisions.
 * @returns The runner's state and actions.
 */
export function useStatementRunner<TRun extends IStatementRunBase, TSend, TResult, TNotice extends IFailureNotice = IFailureNotice>(
	config: IStatementRunnerConfig<TRun, TSend, TResult, TNotice>,
): IStatementRunner<TRun, TNotice> {
	const [running, setRunning] = useState(false);
	const [runs, setRuns] = useState<TRun[]>([]);
	const [selectedRun, setSelectedRun] = useState<number | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [failure, setFailure] = useState<IFailureState<TNotice> | null>(null);
	const [abandonNotice, setAbandonNotice] = useState<string | null>(null);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [canStop, setCanStop] = useState(false);
	const [patternPrompt, setPatternPrompt] = useState<IPatternPrompt<TRun> | null>(null);

	const configRef = useRef(config);
	configRef.current = config;
	// Expiring this ticket is "Stop waiting": the late answer is dropped.
	const generationRef = useRef(createGeneration());
	const runningRef = useRef(false);
	const runStartedRef = useRef(0);
	const runsRef = useRef<TRun[]>([]);
	const mountedRef = useRef(true);
	const patternResolverRef = useRef<((answer: PatternAnswer) => void) | null>(null);

	useEffect(() => attachRunnerLifetime({ generation: generationRef.current, mounted: mountedRef, patternResolver: patternResolverRef }), []);

	// "Stop waiting" only appears once a statement IN FLIGHT has been slow.
	// Keying this on `running` offered it while a confirmation was open, and
	// clicking it then announced that the database might still be running a
	// statement that had never been sent.
	const inFlight = useMemo(() => hasStatementInFlight(runs), [runs]);
	useEffect(() => {
		if (!inFlight) {
			setCanStop(false);
			return undefined;
		}
		const timer = setTimeout(() => setCanStop(true), STOP_WAITING_AFTER_MS);
		return () => clearTimeout(timer);
	}, [inFlight]);

	/**
	 * Commit a run list to state and to the ref the abandon path reads.
	 *
	 * @param next - The new run list.
	 */
	const publishRuns = useCallback((next: TRun[]): void => {
		runsRef.current = next;
		setRuns(next);
	}, []);

	/**
	 * Publish a finished statement to the app's recorder, but only while this
	 * document is still mounted — a closed tab must not write.
	 *
	 * @param run - The finished statement.
	 */
	const record = useCallback((run: TRun): void => {
		if (!mountedRef.current) return;
		configRef.current.record?.(run);
	}, []);

	const answerPattern = useCallback((answer: PatternAnswer): void => {
		setPatternPrompt(null);
		const resolve = patternResolverRef.current;
		patternResolverRef.current = null;
		resolve?.(answer);
	}, []);

	const runTargets = useCallback(async (targets: IRunTarget[], opts?: { fromEditor?: boolean }): Promise<void> => {
		const cfg = configRef.current;
		if (cfg.canRun !== undefined && !cfg.canRun()) return;
		if (runningRef.current || targets.length === 0) return;

		const ticket = generationRef.current.next();
		const view: IBatchView<TRun, TNotice> = {
			refused: (message) => setRefusal(message),
			started: (list) => {
				runningRef.current = true;
				setRunning(true);
				setRefusal(null);
				setFailure(null);
				setAbandonNotice(null);
				setSelectedRun(null);
				cfg.onStart?.();
				publishRuns(list);
			},
			runs: publishRuns,
			active: (index, startedAt) => {
				setActiveIndex(index);
				runStartedRef.current = startedAt;
			},
			confirm: (run, finding) => new Promise<PatternAnswer>((resolve) => {
				patternResolverRef.current = resolve;
				setPatternPrompt({ run, finding });
			}),
			failed: (state) => setFailure(state),
			finished: (info) => {
				runningRef.current = false;
				setRunning(false);
				setSelectedRun(info.shown ? info.shown.index : null);
				cfg.onFinished?.(info, { fromEditor: opts?.fromEditor === true });
				// Only outcomes that have NO live region of their own are announced:
				// a failure is not one (the error banner is an assertive alert).
				const sentence = cfg.summarize
					? cfg.summarize(info)
					: info.runs.length > 1 ? `${info.runs.length} statements: ${formatBatchOutcome(info.runs, cfg.batchWords)}` : null;
				if (sentence) cfg.announce?.(sentence);
			},
		};

		await runStatementBatch(targets, { ...cfg, record }, view, ticket);
	}, [publishRuns, record]);

	const stopWaiting = useCallback((): void => {
		if (!runningRef.current) return;
		const cfg = configRef.current;
		generationRef.current.invalidate();
		runningRef.current = false;
		const ms = (cfg.now ?? ((): number => performance.now()))() - runStartedRef.current;
		setRunning(false);
		const { runs: next, abandoned } = abandonRuns(runsRef.current, ms);
		publishRuns(next);
		if (abandoned) record(abandoned);
		setAbandonNotice((cfg.abandonMessage ?? formatAbandonNotice)(ms));
		cfg.onStopped?.();
	}, [publishRuns, record]);

	return {
		runs, running, inFlight, canStop, selectedRun, setSelectedRun, activeIndex,
		failure, abandonNotice, refusal, patternPrompt, answerPattern, runTargets, stopWaiting,
	};
}
