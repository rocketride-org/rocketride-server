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
// MERGE TESTS: one batch results.json from many small runs
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findResults, mergeResults } from './merge';
import type { ResultsFile, ResultsTrial } from './results';
import type { RunStatus } from './types';

function trial(n: number, status: RunStatus, cost: number | null, extra: Partial<ResultsTrial> = {}): ResultsTrial {
	return { trial: n, rerun: false, status, why: '', steps: 3, wallMs: 1000, estimatedCostUsd: cost, checks: [], guides: null, cause: null, knownGood: null, substitutions: [], record: `t1/trial-${n}/record.json`, result: `t1/trial-${n}/result.json`, judge: null, ...extra };
}

function run(startedAt: string, finishedAt: string, trials: ResultsTrial[], model = 'anthropic/claude-haiku-5-5'): ResultsFile {
	return {
		schema: 'browser-agent-evals/results/v1',
		startedAt,
		finishedAt,
		model,
		taskSet: 'tasks/batch-1',
		schedule: { mode: 'trials', trials: 1 },
		stopped: null,
		engine: {},
		checkout: { commit: 'abc', branch: 'evals/judge-and-sets', dirtyFiles: 0 },
		summary: { tasks: 1, firstRunPassRate: 0, flakeRate: 0, verdicts: { pass: 0, flaky: 0, failing: 0, error: 0, pending: 0 }, firstRunStatuses: {}, totals: { estimatedCostUsd: 0, trialsWithoutCost: 0, trialWallMs: 0, elapsedMs: 0 } },
		tasks: [{ id: 't1', type: 'BUILD', target: 'pipeline', verdict: 'pass', score: { passed: 0, runs: 0, errors: 0, pending: 0 }, trials, judgeQuestions: [] }],
	};
}

test("merge lists each task's trials from every run in time order, and scores them as one batch", () => {
	const out = '/b';
	// round 2 is listed first, so the order comes from startedAt, not the list
	const merged = mergeResults(
		[
			{ dir: '/b/round-2/x', results: run('2026-11-10T12:00:00Z', '2026-11-10T12:10:00Z', [trial(1, 'fail', 0.25)]) },
			{ dir: '/b/round-1/x', results: { ...run('2026-11-10T10:00:00Z', '2026-11-10T10:10:00Z', [trial(1, 'error', null), trial(2, 'pass', 0.5, { retryOf: 1 })]), stopped: 'at the disk floor' } },
		],
		out,
		2
	);
	// one small run stopping is not the batch stopping
	assert.equal(merged.stopped, null);
	const t = merged.tasks[0];
	assert.deepEqual(
		t.trials.map((x) => [x.trial, x.status, x.retryOf ?? null, x.record]),
		[
			[1, 'error', null, 'round-1/x/t1/trial-1/record.json'],
			[2, 'pass', 1, 'round-1/x/t1/trial-2/record.json'],
			[3, 'fail', null, 'round-2/x/t1/trial-1/record.json'],
		]
	);
	// the error is left out of n, as a single run's report does
	assert.deepEqual(t.score, { passed: 1, runs: 2, errors: 1, pending: 0 });
	assert.equal(t.verdict, 'flaky');
	assert.deepEqual(merged.schedule, { mode: 'trials', trials: 2 });
	assert.equal(merged.startedAt, '2026-11-10T10:00:00Z');
	assert.equal(merged.finishedAt, '2026-11-10T12:10:00Z');
	assert.deepEqual(merged.summary.totals, { estimatedCostUsd: 0.75, trialsWithoutCost: 1, trialWallMs: 3000, elapsedMs: 130 * 60_000 });
	assert.deepEqual(merged.summary.verdicts, { pass: 0, flaky: 1, failing: 0, error: 0, pending: 0 });
});

test('merge refuses runs of different models, so one report never mixes them', () => {
	assert.throws(
		() => mergeResults([{ dir: '/b/a', results: run('2026-11-10T10:00:00Z', '2026-11-10T10:01:00Z', []) }, { dir: '/b/c', results: run('2026-11-10T11:00:00Z', '2026-11-10T11:01:00Z', [], 'openai/gpt-6-luna') }], '/b', 1),
		/model/
	);
});

test("findResults finds each run's results.json, but not the batch's own, a stack's or a trial's", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
	const put = (rel: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), '{}');
	};
	for (const rel of ['results.json', 'round-1/a/results.json', 'round-2/b/results.json', 'round-1/a/stack/results.json', 'round-1/a/t1/trial-1/final/results.json']) put(rel);
	assert.deepEqual(
		findResults(dir).map((f) => path.relative(dir, f)),
		['round-1/a/results.json', 'round-2/b/results.json']
	);
	fs.rmSync(dir, { recursive: true });
});
