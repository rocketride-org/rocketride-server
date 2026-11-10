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
// SCHEDULE TESTS: reruns, flake rate, and the report that shows them
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { TrialResult } from './grade';
import { writeRunReport } from './report';
import { buildResults } from './results';
import { roundOrder, runJobs, runSchedule, runTrials, summarize, trialJobs, verdictOf } from './schedule';
import type { Task } from './task';
import type { RunStatus } from './types';

/** A trial result with only what the schedule and the report read. */
function fake(id: string, trial: number, status: RunStatus): TrialResult {
	return { scenario: id, type: 'BUILD', layer: 'L3', trial, model: 'anthropic/claude-haiku-5-5', status, why: `${status} on trial ${trial}`, checks: [], blockersFired: [], counted: { passed: 0, total: 0, pending: 0, notInLayer: 0 }, diagnostics: {}, record: null, substitutions: [] };
}

test('10 tasks, 3 first-run failures, 1 passes on rerun: 70% first-run pass, 10% flake, and the report names the flaky task', async () => {
	const ids = Array.from({ length: 10 }, (_, i) => `task-${String(i + 1).padStart(2, '0')}`);
	// scripted: task-03, task-06 and task-09 fail first; task-06 passes its second rerun
	const script: Record<string, RunStatus[]> = { 'task-03': ['fail', 'fail', 'fail'], 'task-06': ['fail', 'incomplete', 'pass'], 'task-09': ['needs_input', 'fail', 'fail'] };
	const calls: string[] = [];
	const runs = await runSchedule(
		ids,
		async (id, n) => {
			calls.push(`${id}#${n}`);
			return { ...fake(id, n, script[id]?.[n - 1] ?? 'pass'), knownGood: { model: 'anthropic/claude-haiku-5-5', answered: true, seconds: 2, detail: 'answered' } };
		},
		(r) => r.status,
		() => assert.fail('no trial throws here')
	);
	// the first pass runs every task once before any rerun
	assert.deepEqual(
		calls.slice(0, 10),
		ids.map((id) => `${id}#1`)
	);
	assert.equal(calls.length, 16);
	const s = summarize(runs, (r) => r.status);
	assert.equal(s.firstRunPassRate, 0.7);
	assert.equal(s.flakeRate, 0.1);
	assert.deepEqual(s.verdicts, { pass: 7, flaky: 1, failing: 2, error: 0, pending: 0 });

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
	const tasks = new Map(ids.map((id) => [id, { id, type: 'BUILD', target: 'pipeline', judge: [] } as unknown as Task]));
	const results = buildResults(runs, tasks, dir, { startedAt: 't0', finishedAt: 't1', model: 'anthropic/claude-haiku-5-5', taskSet: 'tasks/breadth', engine: null, checkout: { commit: 'abc', branch: 'b', dirtyFiles: 0 } });
	assert.equal(results.tasks.find((t) => t.id === 'task-06')?.trials.length, 3);
	// every trial carries its known-good call, a passing one too
	assert.ok(results.tasks.every((t) => t.trials.every((r) => r.knownGood?.answered === true)));
	const report = fs.readFileSync(writeRunReport(dir, results), 'utf8');
	assert.match(report, /\| 70% \(7 of 10\) \| 10% \(1 of 10\) \| 10 \|/);
	assert.match(report, /Flaky: task-06\./);
	fs.rmSync(dir, { recursive: true });
});

test('a trial that throws ends as an error for its own task, and the next task still runs', async () => {
	const runs = await runSchedule(
		['task-01', 'task-02', 'task-03'],
		async (id, n) => {
			if (id === 'task-02') throw new Error('checkApps failed after the turn');
			return fake(id, n, 'pass');
		},
		(r) => r.status,
		(id, n, err) => ({ ...fake(id, n, 'error'), why: String(err) })
	);
	assert.deepEqual(
		runs.map((r) => [r.id, r.first.status, r.verdict]),
		[
			['task-01', 'pass', 'pass'],
			['task-02', 'error', 'error'],
			['task-03', 'pass', 'pass'],
		]
	);
	assert.match(runs[1].first.why, /checkApps failed after the turn/);
});

test('--trials runs every task n times in rounds, real- tasks then app tasks first, pass or fail, with no reruns', async () => {
	const tasks = [
		{ id: 'ask-01', target: 'pipeline' },
		{ id: 'build-11', target: 'app' },
		{ id: 'real-02', target: 'pipeline' },
		{ id: 'edit-07', target: 'app' },
		{ id: 'real-01', target: 'app' },
	];
	const calls: string[] = [];
	const runs = await runTrials(
		roundOrder(tasks),
		2,
		async (job) => {
			calls.push(`${job.id}#${job.trial}`);
			return fake(job.id, job.trial, job.id === 'ask-01' ? 'fail' : 'pass');
		},
		(r) => r.status,
		() => assert.fail('no trial throws here')
	);
	const round = ['real-02', 'real-01', 'build-11', 'edit-07', 'ask-01'];
	assert.deepEqual(calls, [...round.map((id) => `${id}#1`), ...round.map((id) => `${id}#2`)]);
	assert.deepEqual(
		runs.map((r) => [r.id, [r.first, ...r.reruns].map((t) => t.trial), r.verdict]),
		round.map((id) => [id, [1, 2], id === 'ask-01' ? 'failing' : 'pass'])
	);
});

test('an error is retried once after the last round as a new trial, stays recorded, and is left out of k of n', async () => {
	// task-a trial 1 errors and its retry passes; task-b errors every time, so its retry errors too and is not retried again
	const script: Record<string, RunStatus> = { 'task-a#1': 'error', 'task-a#2': 'fail', 'task-a#3': 'pass', 'task-b#1': 'pass', 'task-b#2': 'error', 'task-b#3': 'error' };
	const calls: string[] = [];
	const runs = await runTrials(
		['task-a', 'task-b'],
		2,
		async (job) => {
			calls.push(`${job.id}#${job.trial}${job.retryOf ? `<-${job.retryOf}` : ''}`);
			return { ...fake(job.id, job.trial, script[`${job.id}#${job.trial}`] ?? 'pass'), ...(job.retryOf ? { retryOf: job.retryOf } : {}) };
		},
		(r) => r.status,
		() => assert.fail('no trial throws here')
	);
	assert.deepEqual(calls, ['task-a#1', 'task-b#1', 'task-a#2', 'task-b#2', 'task-a#3<-1', 'task-b#3<-2']);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
	const tasks = new Map(['task-a', 'task-b'].map((id) => [id, { id, type: 'BUILD', target: 'pipeline', judge: [] } as unknown as Task]));
	const results = buildResults(runs, tasks, dir, { startedAt: 't0', finishedAt: 't1', model: 'm', taskSet: 'tasks/batch-1', schedule: { mode: 'trials', trials: 2 }, engine: null, checkout: { commit: 'abc', branch: 'b', dirtyFiles: 0 } });
	const a = results.tasks.find((t) => t.id === 'task-a');
	assert.deepEqual(
		a?.trials.map((t) => [t.trial, t.status, t.rerun, t.retryOf]),
		[
			[1, 'error', false, undefined],
			[2, 'fail', false, undefined],
			[3, 'pass', false, 1],
		]
	);
	assert.deepEqual(a?.score, { passed: 1, runs: 2, errors: 1, pending: 0 });
	assert.equal(a?.verdict, 'flaky');
	assert.deepEqual(results.tasks.find((t) => t.id === 'task-b')?.score, { passed: 1, runs: 1, errors: 2, pending: 0 });
	const report = fs.readFileSync(writeRunReport(dir, results), 'utf8');
	assert.match(report, /\| 67% \(2 of 3\) \| 1 of 2 \| 2 \|/);
	assert.match(report, /\| task-a \| BUILD \| 1 of 2 \| 1 error, 2 fail, 3 pass \(retry of 1\) \| flaky \|/);
	fs.rmSync(dir, { recursive: true });
});

test('several workers share one queue: every job runs once, and a stop lets running jobs finish but starts no more', async () => {
	const jobs = trialJobs(['a', 'b', 'c', 'd', 'e', 'f'], 2);
	let running = 0;
	let most = 0;
	const done = await runJobs(
		jobs,
		async (job) => {
			running++;
			most = Math.max(most, running);
			await new Promise((r) => setTimeout(r, 5));
			running--;
			return `${job.id}#${job.trial}`;
		},
		() => assert.fail('no job throws here'),
		{ workers: 3 }
	);
	assert.equal(most, 3);
	assert.deepEqual(done.map((d) => d.result).sort(), jobs.map((j) => `${j.id}#${j.trial}`).sort());
	let started = 0;
	const stopped = await runJobs(
		jobs,
		async (job) => {
			started++;
			return job.id;
		},
		() => assert.fail('no job throws here'),
		{ stop: () => (started >= 4 ? 'the spend cap' : null) }
	);
	assert.equal(stopped.length, 4);
});

test('errors and undecided runs are not rerun, and keep their own verdicts', () => {
	assert.equal(verdictOf('error', []), 'error');
	assert.equal(verdictOf('pending', []), 'pending');
	assert.equal(verdictOf('abstain', ['abstain', 'fail']), 'failing');
	assert.equal(verdictOf('pass', []), 'pass');
});
