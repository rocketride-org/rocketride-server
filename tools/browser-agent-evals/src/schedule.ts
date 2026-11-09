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
// SCHEDULE: one run per task, then reruns of each failure
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

/**
 * Runs the schedule.
 *
 * @param ids - The task ids, in run order.
 * @param trial - Runs one trial of a task: its id and the trial number (1 for the first run, 2 and up for reruns).
 * @param statusOf - A trial's status.
 * @param reruns - How many times to rerun a failure (default 2).
 * @returns Each task's runs, in the order given.
 */
export async function runSchedule<T>(ids: string[], trial: (id: string, n: number) => Promise<T>, statusOf: (t: T) => RunStatus, reruns = 2): Promise<Array<TaskRuns<T>>> {
	const runs: Array<TaskRuns<T>> = [];
	// step: the first pass over every task, before any rerun, so the first-run rate is one sitting
	for (const id of ids) runs.push({ id, first: await trial(id, 1), reruns: [], verdict: 'pending' });
	for (const r of runs) {
		if (RERUN_ON.has(statusOf(r.first))) for (let n = 2; n <= reruns + 1; n++) r.reruns.push(await trial(r.id, n));
		r.verdict = verdictOf(statusOf(r.first), r.reruns.map(statusOf));
	}
	return runs;
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
