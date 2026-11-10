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
// RESULTS: results.json, the file the judge and the report read
// =============================================================================

/**
 * The schema of a run's results.json (the judge reads and annotates
 * it). One entry per task, each with its first run and its
 * reruns; each trial points at its trial folder's record.json and
 * result.json. `judge` is null until the judge writes its verdict there.
 * Values are scrubbed; key values never appear.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TrialResult } from './grade';
import { scoreOf, summarize, type ScheduleSummary, type TaskRuns, type TaskVerdict, type TrialScore } from './schedule';
import type { JudgeLine, Task } from './task';
import type { RunStatus } from './types';

export const RESULTS_SCHEMA = 'browser-agent-evals/results/v1';

/** How the run scheduled its trials: reruns of each failure (runSchedule), or a fixed count of every task in rounds (runTrials). */
export type Schedule = { mode: 'reruns'; reruns: number } | { mode: 'trials'; trials: number };

/** One trial as results.json lists it. */
export interface ResultsTrial {
	trial: number;
	/** A rerun of a failed first run (reruns mode only). */
	rerun: boolean;
	/** The errored trial this one retries, when it is a retry. */
	retryOf?: number;
	status: RunStatus;
	why: string;
	/** The turn's steps (waves), from the saved turn; null when there was no turn. */
	steps: number | null;
	/** The trial's wall time, setup and grading included. */
	wallMs: number | null;
	/** The turn's estimated cost in US dollars, the agent's own meter (the figure its cost limit checks); null when there was none. */
	estimatedCostUsd: number | null;
	checks: Array<{ id: string; type: string; status: string; detail: string; blocker: boolean; soft?: boolean }>;
	/** The guides the agent read (guides.ts): how many reads, which guide files, how many catalog calls. */
	guides: { reads: number; files: string[]; catalogCalls: number } | null;
	/** A failed trial's label (cause.ts): agent, environment or runner, with the evidence. */
	cause: TrialResult['cause'];
	/** The known-good call made right after the trial (smoke-models.ts), or null when none was made. */
	knownGood: TrialResult['knownGood'];
	/** Checks that read another file than the one they name (resolve.ts). */
	substitutions: TrialResult['substitutions'];
	/** The trial folder's record.json and result.json, relative to results.json. */
	record: string;
	result: string;
	/** What the judge decided, once it has run. The runner writes null. */
	judge: null | { verdict: string; notes?: string; model?: string };
}

/** One task as results.json lists it. */
export interface ResultsTask {
	id: string;
	type: string;
	target: string;
	verdict: TaskVerdict;
	/** k of n: the trials that passed, of those that ran (errors left out). */
	score: TrialScore;
	trials: ResultsTrial[];
	/** The task's questions for the judge. */
	judgeQuestions: JudgeLine[];
}

/** The whole file. */
export interface ResultsFile {
	schema: typeof RESULTS_SCHEMA;
	startedAt: string;
	finishedAt: string;
	model: string;
	taskSet: string;
	/** Reruns mode when absent. */
	schedule?: Schedule;
	engine: unknown;
	checkout: { commit: string; branch: string; dirtyFiles: number };
	summary: ScheduleSummary & { firstRunStatuses: Record<string, number>; totals: Totals };
	tasks: ResultsTask[];
}

/** The batch's totals: the summed estimated cost and trial wall time, and the time from start to finish. */
export interface Totals {
	estimatedCostUsd: number;
	/** Trials with no cost estimate (no saved turn). */
	trialsWithoutCost: number;
	trialWallMs: number;
	/** finishedAt minus startedAt; with several workers it is less than the summed trial time. */
	elapsedMs: number | null;
}

/** A trial's steps, wall time and estimated cost, from its grade's diagnostics. */
export function trialCost(r: TrialResult): { steps: number | null; wallMs: number | null; estimatedCostUsd: number | null } {
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	return { steps: num(r.diagnostics.waves), wallMs: num(r.diagnostics.wallMs), estimatedCostUsd: num(r.diagnostics.estimatedCostUsd) };
}

/** The summed estimated cost of some trials, in US dollars. */
export function spentUsd(results: TrialResult[]): number {
	return results.reduce((usd, r) => usd + (trialCost(r).estimatedCostUsd ?? 0), 0);
}

/**
 * Builds results.json's content from a schedule.
 *
 * @param runs - The schedule's runs.
 * @param tasks - The tasks, by id.
 * @param dir - The run folder results.json goes in, which the trial paths are made relative to.
 * @param meta - Everything else the file carries.
 */
export function buildResults(runs: Array<TaskRuns<TrialResult>>, tasks: Map<string, Task>, dir: string, meta: Omit<ResultsFile, 'schema' | 'summary' | 'tasks'>): ResultsFile {
	const rel = (p: string | null) => (p ? path.relative(dir, p) : '');
	const reruns = (meta.schedule?.mode ?? 'reruns') === 'reruns';
	const entry = (r: TrialResult, later: boolean): ResultsTrial => ({
		guides: (r.diagnostics.guides as ResultsTrial['guides']) ?? null,
		trial: r.trial,
		rerun: reruns && later,
		...(r.retryOf ? { retryOf: r.retryOf } : {}),
		status: r.status,
		why: r.why,
		...trialCost(r),
		checks: r.checks.map((c) => ({ id: c.id, type: c.kind, status: c.status, detail: c.detail, blocker: c.blocker, ...(c.soft ? { soft: true } : {}) })),
		cause: r.cause ?? null,
		knownGood: r.knownGood ?? null,
		substitutions: r.substitutions,
		record: rel(r.record),
		result: rel(r.record ? path.join(path.dirname(r.record), 'result.json') : null),
		judge: null,
	});
	const firstRunStatuses: Record<string, number> = {};
	for (const r of runs) firstRunStatuses[r.first.status] = (firstRunStatuses[r.first.status] ?? 0) + 1;
	const every = runs.flatMap((r) => [r.first, ...r.reruns]);
	const elapsed = Date.parse(meta.finishedAt) - Date.parse(meta.startedAt);
	const totals: Totals = {
		estimatedCostUsd: spentUsd(every),
		trialsWithoutCost: every.filter((r) => trialCost(r).estimatedCostUsd === null).length,
		trialWallMs: every.reduce((ms, r) => ms + (trialCost(r).wallMs ?? 0), 0),
		elapsedMs: Number.isFinite(elapsed) ? elapsed : null,
	};
	return {
		schema: RESULTS_SCHEMA,
		...meta,
		summary: { ...summarize(runs, (t) => t.status), firstRunStatuses, totals },
		tasks: runs.map((r) => {
			const t = tasks.get(r.id);
			const all = [r.first, ...r.reruns];
			return { id: r.id, type: t?.type ?? '', target: t?.target ?? '', verdict: r.verdict, score: scoreOf(all.map((x) => x.status)), trials: all.map((x, i) => entry(x, i > 0)), judgeQuestions: t?.judge ?? [] };
		}),
	};
}

/** Writes results.json into the run folder and returns its path. */
export function writeResults(dir: string, results: ResultsFile): string {
	const file = path.join(dir, 'results.json');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(results, null, '\t')}\n`);
	return file;
}
