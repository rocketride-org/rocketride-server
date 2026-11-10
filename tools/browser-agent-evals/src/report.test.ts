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
// REPORT TESTS: report.md for a run with a crashed trial
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { erroredTrial, type TrialResult } from './grade';
import { writeReport, writeRunReport, type Provenance } from './report';
import { buildResults } from './results';
import type { Task } from './task';
import type { ScenarioResult } from './types';

test('each run shows its steps, wall time and estimated cost, and the batch its totals', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-'));
	try {
		const trial = (n: number, status: 'pass' | 'fail', diagnostics: Record<string, unknown>): TrialResult => ({ scenario: 'build-01', type: 'BUILD', layer: 'L3', trial: n, model: 'm', status, why: status, checks: [], blockersFired: [], counted: { passed: 0, total: 0, pending: 0, notInLayer: 0 }, diagnostics, record: null, substitutions: [] });
		const build = { id: 'build-01', type: 'BUILD', target: 'pipeline', judge: [] } as unknown as Task;
		const ask = { id: 'answer-01', type: 'ANSWER', target: 'pipeline', judge: [] } as unknown as Task;
		const runs = [
			{ id: 'build-01', first: trial(1, 'pass', { waves: 12, wallMs: 95_000, estimatedCostUsd: 0.5 }), reruns: [trial(2, 'fail', { waves: 30, wallMs: 185_000, estimatedCostUsd: 1.25 })], verdict: 'flaky' as const },
			{ id: 'answer-01', first: erroredTrial(ask, 1, 'm', 'the browser crashed'), reruns: [], verdict: 'error' as const },
		];
		const results = buildResults(
			runs,
			new Map([
				['build-01', build],
				['answer-01', ask],
			]),
			dir,
			{ startedAt: '2026-11-09T23:00:00Z', finishedAt: '2026-11-10T00:30:00Z', model: 'm', taskSet: 'tasks/batch-1', schedule: { mode: 'trials', trials: 2 }, engine: null, checkout: { commit: 'abc', branch: 'b', dirtyFiles: 0 } }
		);
		assert.deepEqual(
			results.tasks.flatMap((t) => t.trials.map((r) => [t.id, r.trial, r.steps, r.wallMs, r.estimatedCostUsd])),
			[
				['build-01', 1, 12, 95_000, 0.5],
				['build-01', 2, 30, 185_000, 1.25],
				['answer-01', 1, null, null, null],
			]
		);
		assert.deepEqual(results.summary.totals, { estimatedCostUsd: 1.75, trialsWithoutCost: 1, trialWallMs: 280_000, elapsedMs: 5_400_000 });
		const report = fs.readFileSync(writeRunReport(dir, results), 'utf8');
		assert.match(report, /^Totals: estimated cost \$1\.75 over 3 run\(s\) \(1 with no estimate\); trial time 0h 5m summed, 1h 30m from start to finish\./m);
		assert.match(report, /^\| build-01 \| 2 \| fail \| - \| 30 \| 185 \| \$1\.25 \| - \|$/m);
		assert.match(report, /^\| answer-01 \| 1 \| error \| - \| - \| - \| - \| runner \|$/m);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a trial that wrote no record gets a diagnostics row with nothing in it, and the report is written', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-'));
	try {
		const prov: Provenance = { layer: 'L3', startedAt: '2026-10-27T00:00:00Z', checkout: { path: '/repo', commit: 'abc', branch: 'b', dirtyFiles: 0, base: 'def' }, model: 'm', settings: {}, guides: null, engine: 'e', keys: 'none', command: 'run' };
		// what run.ts's crashed() makes: an error with the trial's log as its record and no diagnostics
		const crashed: ScenarioResult = { scenario: 'build-01-chat-claude', layer: 'L3', trial: 1, model: 'stand-in', status: 'error', why: 'the trial wrote no record (exit 1); see t1.log', checks: [], blockersFired: [], counted: { passed: 0, total: 0, pending: 0, notInLayer: 0 }, diagnostics: {}, record: path.join(dir, 't1.log') };
		const report = writeReport(dir, prov, [crashed], [], []);
		const row = fs
			.readFileSync(report, 'utf8')
			.split('\n')
			.find((l) => l.startsWith('| build-01-chat-claude | 1 | no record |'));
		assert.equal(row, `| build-01-chat-claude | 1 | no record |${' - |'.repeat(15)}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
