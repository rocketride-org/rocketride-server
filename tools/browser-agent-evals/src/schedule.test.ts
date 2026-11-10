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
import { freeGb, stopReason } from './guards';
import { writeRunReport } from './report';
import { buildResults, spentUsd } from './results';
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

test('an error is retried once, at the end of the queue, as a new trial; it stays recorded and is left out of k of n', async () => {
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

test("an error's retry starts as soon as the error ends, while another worker is still in the last round", async () => {
	const events: string[] = [];
	const runs = await runTrials(
		['quick', 'slow'],
		1,
		async (job, worker) => {
			events.push(`start ${job.id}#${job.trial} on ${worker}`);
			await new Promise((r) => setTimeout(r, job.id === 'slow' ? 60 : 5));
			events.push(`end ${job.id}#${job.trial}`);
			return { ...fake(job.id, job.trial, job.id === 'quick' && !job.retryOf ? 'error' : 'pass'), ...(job.retryOf ? { retryOf: job.retryOf } : {}) };
		},
		(r) => r.status,
		() => assert.fail('no trial throws here'),
		{ workers: 2 }
	);
	assert.ok(events.indexOf('start quick#2 on 0') < events.indexOf('end slow#1'), events.join(', '));
	assert.deepEqual(
		runs.map((r) => [r.id, [r.first, ...r.reruns].map((t) => `${t.trial} ${t.status}`)]),
		[
			['quick', ['1 error', '2 pass']],
			['slow', ['1 pass']],
		]
	);
});

test('a worker whose stack died takes no more jobs; its errored job is retried on a worker that is still up', async () => {
	const dead = new Set<number>();
	const ran: string[] = [];
	const runs = await runTrials(
		['a', 'b', 'c', 'd'],
		1,
		async (job, worker) => {
			ran.push(`${job.id}#${job.trial}${job.retryOf ? `<-${job.retryOf}` : ''} on ${worker}`);
			if (job.id === 'a' && !job.retryOf) {
				// worker 0's stack dies under its first trial
				dead.add(worker);
				return fake(job.id, job.trial, 'error');
			}
			await new Promise((r) => setTimeout(r, 10));
			return { ...fake(job.id, job.trial, 'pass'), ...(job.retryOf ? { retryOf: job.retryOf } : {}) };
		},
		(r) => r.status,
		() => assert.fail('no trial throws here'),
		{ workers: 2, usable: (w) => !dead.has(w) }
	);
	assert.deepEqual(ran, ['a#1 on 0', 'b#1 on 1', 'c#1 on 1', 'd#1 on 1', 'a#2<-1 on 1']);
	assert.deepEqual(
		runs.map((r) => [r.id, r.verdict]),
		[
			['a', 'pass'],
			['b', 'pass'],
			['c', 'pass'],
			['d', 'pass'],
		]
	);
	// once every worker is out, the jobs still queued do not run
	const left = await runJobs(trialJobs(['x', 'y', 'z'], 1), async (job) => job.id, () => assert.fail('no job throws here'), { usable: () => false });
	assert.deepEqual(left, []);
});

test('the spend cap stops new trials once the finished ones reach it; running trials finish and the report says why', async () => {
	const guards = { maxSpendUsd: 7, minFreeGb: 3 };
	assert.equal(stopReason(guards, 6.99, 9.2), null);
	const finished: TrialResult[] = [];
	let stopped: string | null = null;
	// 4 tasks, 2 trials each, 2 workers, $3 a trial: trials 1 and 2 start at $0, 3 starts at $3, 4 at $6; at $9 nothing more starts
	const runs = await runTrials(
		['t1', 't2', 't3', 't4'],
		2,
		async (job) => {
			await new Promise((r) => setTimeout(r, 5));
			const r = { ...fake(job.id, job.trial, 'pass'), diagnostics: { estimatedCostUsd: 3, waves: 5, wallMs: 1000 } };
			finished.push(r);
			return r;
		},
		(r) => r.status,
		() => assert.fail('no trial throws here'),
		{ workers: 2, stop: () => (stopped ??= stopReason(guards, spentUsd(finished), 9.2)) }
	);
	assert.equal(finished.length, 4, 'the trial running when the cap was reached still finished');
	assert.match(stopped ?? '', /^the spend cap: the finished trials' estimated cost is \$9\.00, at or over --max-spend \$7\.00$/);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
	const tasks = new Map(['t1', 't2', 't3', 't4'].map((id) => [id, { id, type: 'BUILD', target: 'pipeline', judge: [] } as unknown as Task]));
	const results = buildResults(runs, tasks, dir, { startedAt: 't0', finishedAt: 't1', model: 'm', taskSet: 'tasks/batch-1', schedule: { mode: 'trials', trials: 2 }, stopped, engine: null, checkout: { commit: 'abc', branch: 'b', dirtyFiles: 0 } });
	assert.equal(results.stopped, stopped);
	assert.equal(results.summary.totals.estimatedCostUsd, 12);
	assert.match(fs.readFileSync(writeRunReport(dir, results), 'utf8'), /^The batch stopped early, at the spend cap: .* no other trial started/m);
	fs.rmSync(dir, { recursive: true });
});

test('the disk floor stops new trials once the output disk has less free than it', async () => {
	let free = 4;
	const ran: string[] = [];
	await runJobs(
		trialJobs(['a', 'b', 'c'], 2),
		async (job) => {
			ran.push(`${job.id}#${job.trial}`);
			free -= 0.6;
			return job.id;
		},
		() => assert.fail('no job throws here'),
		{ stop: () => stopReason({ maxSpendUsd: null, minFreeGb: 3 }, 1000, free) }
	);
	assert.deepEqual(ran, ['a#1', 'b#1']);
	assert.match(stopReason({ maxSpendUsd: null, minFreeGb: 3 }, 0, free) ?? '', /^the disk floor: 2\.8 GB free on the output folder's disk, under --min-free-disk 3 GB$/);
	// the output folder does not exist before the first trial; its disk is read from the nearest folder that does
	assert.ok(freeGb(path.join(os.tmpdir(), 'not-made-yet', 'run')) > 0);
});

test('errors and undecided runs are not rerun, and keep their own verdicts', () => {
	assert.equal(verdictOf('error', []), 'error');
	assert.equal(verdictOf('pending', []), 'pending');
	assert.equal(verdictOf('abstain', ['abstain', 'fail']), 'failing');
	assert.equal(verdictOf('pass', []), 'pass');
});
