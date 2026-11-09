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
import { runSchedule, summarize, verdictOf } from './schedule';
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
		(r) => r.status
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

test('errors and undecided runs are not rerun, and keep their own verdicts', () => {
	assert.equal(verdictOf('error', []), 'error');
	assert.equal(verdictOf('pending', []), 'pending');
	assert.equal(verdictOf('abstain', ['abstain', 'fail']), 'failing');
	assert.equal(verdictOf('pass', []), 'pass');
});
