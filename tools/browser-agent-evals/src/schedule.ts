// MIT License
//
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
// SCHEDULE: one run per task, then reruns of each failure; or n trials of each
// =============================================================================

/**
 * Task 2.4. Runs every task once, then reruns each task that failed, twice
 * by default. A task that failed first is flaky when a rerun passes, and
 * failing when every rerun fails too. The first-run pass rate is first-run
 * passes over tasks run; the flake rate is flaky tasks over tasks run.
 *
 * What counts as a failure to rerun is the agent's: fail, incomplete,
 * needs_input and abstain. A trial that ends `error` (the runner, the stack
 * or a missing key) or `pending` (a check that could not be decided) is not
 * rerun; its task's verdict says so instead.
 *
 * With a fixed trial count (runTrials), every task runs n times in rounds
 * and is scored k of n, with no reruns; only errors are retried, once.
 * Both modes take their trials from one job queue (runJobs), which several
 * workers can share.
 */

import type { RunStatus } from './types';

/** The statuses that send a task to its reruns. */
export const RERUN_ON: ReadonlySet<RunStatus> = new Set<RunStatus>(['fail', 'incomplete', 'needs_input', 'abstain']);

/** How a task ended across its runs. */
export type TaskVerdict = 'pass' | 'flaky' | 'failing' | 'error' | 'pending';

/** The verdicts, in report order. */
export const VERDICTS: TaskVerdict[] = ['pass', 'flaky', 'failing', 'error', 'pending'];

/** One task's runs: the first, the reruns, and the verdict. */
export interface TaskRuns<T> {
	id: string;
	first: T;
	reruns: T[];
	verdict: TaskVerdict;
}

/** Rates over the tasks run, as fractions. */
export interface ScheduleSummary {
	tasks: number;
	firstRunPassRate: number;
	flakeRate: number;
	verdicts: Record<TaskVerdict, number>;
}

/**
 * The verdict of a task from its first status and its reruns' statuses.
 *
 * @param first - The first run's status.
 * @param reruns - Each rerun's status.
 */
export function verdictOf(first: RunStatus, reruns: RunStatus[]): TaskVerdict {
	if (first === 'pass') return 'pass';
	if (first === 'error') return 'error';
	if (!RERUN_ON.has(first)) return 'pending';
	return reruns.includes('pass') ? 'flaky' : 'failing';
}

/** One trial to run: the task, its trial number, and the trial it retries when it is a retry. */
export interface Job {
	id: string;
	trial: number;
	retryOf?: number;
}

/** How the queue runs: how many workers take from it, and what is asked before each job starts. */
export interface QueueOptions {
	/** Workers taking jobs from the one queue (default 1). */
	workers?: number;
	/** Asked before each job starts; a reason stops the queue there. Jobs already running finish. */
	stop?: () => string | null;
}

/**
 * Runs jobs from one queue. Each worker takes the next job until the queue
 * is empty or `stop` gives a reason; a job that throws becomes `errored`'s
 * value and the queue goes on.
 *
 * @returns Each job that ran and its value, in the order they finished.
 */
export async function runJobs<T>(jobs: Job[], run: (job: Job) => Promise<T>, errored: (job: Job, err: unknown) => T, opts: QueueOptions = {}): Promise<Array<{ job: Job; result: T }>> {
	const queue = [...jobs];
	const done: Array<{ job: Job; result: T }> = [];
	let stopped = false;
	const worker = async (): Promise<void> => {
		while (queue.length && !stopped) {
			if (opts.stop?.()) {
				stopped = true;
				return;
			}
			const job = queue.shift() as Job;
			let result: T;
			try {
				result = await run(job);
			} catch (err) {
				result = errored(job, err);
			}
			done.push({ job, result });
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, opts.workers ?? 1) }, worker));
	return done;
}

/**
 * Runs the schedule.
 *
 * @param ids - The task ids, in run order.
 * @param trial - Runs one trial of a task: its id and the trial number (1 for the first run, 2 and up for reruns).
 * @param statusOf - A trial's status.
 * @param errored - The value of a trial that threw: its id, its number and what it threw. The schedule goes on with the next trial.
 * @param reruns - How many times to rerun a failure (default 2).
 * @param opts - The queue's workers, and what stops it. A task whose first run never started is left out.
 * @returns Each task's runs, in the order given.
 */
export async function runSchedule<T>(ids: string[], trial: (id: string, n: number) => Promise<T>, statusOf: (t: T) => RunStatus, errored: (id: string, n: number, err: unknown) => T, reruns = 2, opts: QueueOptions = {}): Promise<Array<TaskRuns<T>>> {
	const run = (j: Job) => trial(j.id, j.trial);
	const fail = (j: Job, err: unknown) => errored(j.id, j.trial, err);
	// step: the first pass over every task, before any rerun, so the first-run rate is one sitting
	const firsts = new Map((await runJobs(ids.map((id) => ({ id, trial: 1 })), run, fail, opts)).map((d) => [d.job.id, d.result]));
	const runs: Array<TaskRuns<T>> = ids.filter((id) => firsts.has(id)).map((id) => ({ id, first: firsts.get(id) as T, reruns: [], verdict: 'pending' }));
	const again = runs.filter((r) => RERUN_ON.has(statusOf(r.first))).flatMap((r) => Array.from({ length: reruns }, (_, i) => ({ id: r.id, trial: i + 2 })));
	const later = await runJobs(again, run, fail, opts);
	for (const r of runs) {
		r.reruns = later
			.filter((d) => d.job.id === r.id)
			.sort((a, b) => a.job.trial - b.job.trial)
			.map((d) => d.result);
		r.verdict = verdictOf(statusOf(r.first), r.reruns.map(statusOf));
	}
	return runs;
}

// =============================================================================
// FIXED TRIALS: every task n times, in rounds, with one retry of each error
// =============================================================================

/**
 * The order of the tasks within a round: tasks whose id starts with `real-`,
 * then app tasks, then the rest, each group in the order given.
 */
export function roundOrder(tasks: Array<{ id: string; target: string }>): string[] {
	const rank = (t: { id: string; target: string }) => (t.id.startsWith('real-') ? 0 : t.target === 'app' ? 1 : 2);
	return tasks
		.map((t, i) => ({ t, i }))
		.sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
		.map(({ t }) => t.id);
}

/** Every task `trials` times, in rounds: each task once in order, then each again. Round r is trial r. */
export function trialJobs(ids: string[], trials: number): Job[] {
	return Array.from({ length: trials }, (_, r) => ids.map((id) => ({ id, trial: r + 1 }))).flat();
}

/**
 * The verdict of a task that ran a fixed number of trials, from every
 * trial's status. Errors are left out: they are the runner's or the
 * environment's, not the agent's.
 */
export function trialsVerdict(statuses: RunStatus[]): TaskVerdict {
	const real = statuses.filter((s) => s !== 'error');
	const passed = real.filter((s) => s === 'pass').length;
	if (!real.length) return 'error';
	if (passed === real.length) return 'pass';
	if (passed) return 'flaky';
	return real.some((s) => RERUN_ON.has(s)) ? 'failing' : 'pending';
}

/** k of n: the trials that passed, of the trials that ran (errors left out), with the errors and the undecided trials beside them. */
export interface TrialScore {
	passed: number;
	runs: number;
	errors: number;
	pending: number;
}

/** A task's k of n from every trial's status. */
export function scoreOf(statuses: RunStatus[]): TrialScore {
	const count = (s: RunStatus) => statuses.filter((x) => x === s).length;
	return { passed: count('pass'), runs: statuses.length - count('error'), errors: count('error'), pending: count('pending') };
}

/**
 * Runs every task `trials` times, pass or fail, in rounds, through one job
 * queue. After the last round each trial that ended `error` is retried once,
 * as the task's next trial number, and the errored trial stays recorded.
 *
 * @param ids - The task ids, in round order (roundOrder).
 * @param trials - How many times each task runs.
 * @param trial - Runs one job; a retry carries `retryOf`.
 * @param statusOf - A trial's status.
 * @param errored - The value of a job that threw.
 * @param opts - The queue's workers, and what stops it. A task none of whose trials started is left out.
 * @returns Each task's trials, in the order given: `first` is trial 1 and `reruns` the task's other trials in trial order (no trial here is a rerun of a failure).
 */
export async function runTrials<T>(ids: string[], trials: number, trial: (job: Job) => Promise<T>, statusOf: (t: T) => RunStatus, errored: (job: Job, err: unknown) => T, opts: QueueOptions = {}): Promise<Array<TaskRuns<T>>> {
	const done = await runJobs(trialJobs(ids, trials), trial, errored, opts);
	// step: one retry of each error, after every round, numbered after the task's last trial
	const next = new Map(ids.map((id) => [id, trials + 1]));
	const retries = done
		.filter((d) => statusOf(d.result) === 'error')
		.sort((a, b) => ids.indexOf(a.job.id) - ids.indexOf(b.job.id) || a.job.trial - b.job.trial)
		.map((d) => {
			const n = next.get(d.job.id) as number;
			next.set(d.job.id, n + 1);
			return { id: d.job.id, trial: n, retryOf: d.job.trial };
		});
	done.push(...(await runJobs(retries, trial, errored, opts)));
	return ids.flatMap((id) => {
		const mine = done.filter((d) => d.job.id === id).sort((a, b) => a.job.trial - b.job.trial);
		if (!mine.length) return [];
		const results = mine.map((d) => d.result);
		return [{ id, first: results[0] as T, reruns: results.slice(1), verdict: trialsVerdict(results.map(statusOf)) }];
	});
}

/** The rates and verdict counts of a schedule. */
export function summarize<T>(runs: Array<TaskRuns<T>>, statusOf: (t: T) => RunStatus): ScheduleSummary {
	const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<TaskVerdict, number>;
	for (const r of runs) verdicts[r.verdict]++;
	const n = runs.length;
	return {
		tasks: n,
		firstRunPassRate: n ? runs.filter((r) => statusOf(r.first) === 'pass').length / n : 0,
		flakeRate: n ? verdicts.flaky / n : 0,
		verdicts,
	};
}
