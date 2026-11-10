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
// MERGE: one results.json for a batch that ran as many small runs
// =============================================================================

/**
 * A batch run one task per fresh stack (batch 1) leaves a results.json in
 * each small run's folder. merge reads every one under the batch folder and
 * writes one results.json and report.md for the whole batch, scored the way
 * one `run --trials` scores it.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ResultsFile, ResultsTask, ResultsTrial } from './results';
import { RESULTS_SCHEMA } from './results';
import { scoreOf, summarize, trialsVerdict } from './schedule';

/** Folders that hold no run's results.json: a trial's own folder, a stack, rendered pages. */
const SKIP = /^(trial-\d+.*|final|stack.*|pages|node_modules)$/;

/**
 * Every small run's results.json under a batch folder, sorted by path. The
 * batch's own results.json, directly in the folder, is not one of them.
 *
 * @param dir - The batch folder.
 */
export function findResults(dir: string): string[] {
	const found: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.isDirectory() && !SKIP.test(e.name)) walk(path.join(d, e.name));
			else if (e.name === 'results.json' && d !== dir) found.push(path.join(d, e.name));
		}
	};
	walk(dir);
	return found.sort();
}

/** The one value every run shares in a field, or an error naming the values when they differ. */
function same(runs: ResultsFile[], field: string, of: (r: ResultsFile) => string): string {
	const values = [...new Set(runs.map(of))];
	if (values.length > 1) throw new Error(`the runs differ in ${field}: ${values.join(', ')}`);
	return values[0];
}

/**
 * Merges small runs' results into one batch's.
 *
 * @param runs - Each run's folder and its results.json content.
 * @param out - The batch folder; trial paths are made relative to it.
 * @param trials - How many times the batch meant to run each task.
 * @returns The batch's results, with each task's trials renumbered in the order they started.
 */
export function mergeResults(runs: Array<{ dir: string; results: ResultsFile }>, out: string, trials: number): ResultsFile {
	if (!runs.length) throw new Error('no runs to merge');
	const sorted = [...runs].sort((a, b) => a.results.startedAt.localeCompare(b.results.startedAt));
	const all = sorted.map((r) => r.results);
	same(all, 'model', (r) => r.model);
	same(all, 'task set', (r) => r.taskSet);
	same(all, 'checkout', (r) => r.checkout.commit);

	const tasks = new Map<string, ResultsTask>();
	for (const { dir, results } of sorted) {
		const rebase = (p: string) => (p ? path.relative(out, path.resolve(dir, p)) : '');
		for (const t of results.tasks) {
			const task = tasks.get(t.id) ?? { ...t, trials: [] };
			tasks.set(t.id, task);
			// step: this run's trial numbers become the batch's, and a retry points at its error's new number
			const renumbered = new Map<number, number>();
			for (const x of t.trials) {
				renumbered.set(x.trial, task.trials.length + 1);
				const trial: ResultsTrial = { ...x, trial: task.trials.length + 1, record: rebase(x.record), result: rebase(x.result) };
				if (x.retryOf !== undefined) trial.retryOf = renumbered.get(x.retryOf);
				task.trials.push(trial);
			}
		}
	}
	const merged = [...tasks.values()].map((t) => {
		const statuses = t.trials.map((x) => x.status);
		return { ...t, score: scoreOf(statuses), verdict: trialsVerdict(statuses) };
	});

	const every = merged.flatMap((t) => t.trials);
	const startedAt = all[0].startedAt;
	const finishedAt = all.map((r) => r.finishedAt).sort().at(-1) as string;
	const firstRunStatuses: Record<string, number> = {};
	for (const t of merged) if (t.trials[0]) firstRunStatuses[t.trials[0].status] = (firstRunStatuses[t.trials[0].status] ?? 0) + 1;
	return {
		schema: RESULTS_SCHEMA,
		startedAt,
		finishedAt,
		model: all[0].model,
		taskSet: all[0].taskSet,
		schedule: { mode: 'trials', trials },
		// a small run's stop ended that run, not the batch: whatever drove the runs went on
		stopped: null,
		engine: all[0].engine,
		checkout: { ...all[0].checkout, dirtyFiles: Math.max(...all.map((r) => r.checkout.dirtyFiles)) },
		summary: {
			...summarize(
				merged.filter((t) => t.trials.length).map((t) => ({ id: t.id, first: t.trials[0], reruns: t.trials.slice(1), verdict: t.verdict })),
				(x) => x.status
			),
			firstRunStatuses,
			totals: {
				estimatedCostUsd: every.reduce((usd, x) => usd + (x.estimatedCostUsd ?? 0), 0),
				trialsWithoutCost: every.filter((x) => x.estimatedCostUsd === null).length,
				trialWallMs: every.reduce((ms, x) => ms + (x.wallMs ?? 0), 0),
				elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt),
			},
		},
		tasks: merged,
	};
}
