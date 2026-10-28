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
// L1 REPLAY TESTS: every recording plays back as it was recorded
// =============================================================================

/**
 * shared:test runs these, so CI replays every recording on each pull request
 * to develop or main. A replay that differs means the agent's loop, its tools,
 * what they read or the scoring changed how a recorded trial plays out. When a
 * change is meant to do that, record the scenarios again (README.md).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DATA_DIR, EVAL_DIR, REPO_ROOT } from './catalog';
import { callDigest, loadRecordings, type Recording } from './recordings';
import { reproduces, type Comparison } from './report';
import type { ScenarioResult } from './types';

/** Node's process. The package's global.d.ts declares a browser `process` that has only `env`. */
const proc = process as unknown as NodeJS.Process;

/** Runs L1 as shared:eval does, with no model key, and returns its results and comparisons. */
function replay(extra: string[] = [], dataDir?: string): { status: number | null; results: ScenarioResult[]; comparisons: Comparison[]; invalid: Array<{ id: string; problems: string[] }> } {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-l1-'));
	const env: NodeJS.ProcessEnv = { ...proc.env, ...(dataDir ? { EVAL_DATA_DIR: dataDir } : {}) };
	for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_OPENAI_KEY']) delete env[k];
	try {
		const r = spawnSync(proc.execPath, ['--import', 'tsx', path.join(EVAL_DIR, 'run.ts'), 'run', '--layer', 'L1', '--out', out, ...extra], { cwd: path.join(REPO_ROOT, 'apps/shared'), env, encoding: 'utf8' });
		const { results, comparisons, invalid } = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')) as { results: ScenarioResult[]; comparisons: Comparison[]; invalid: Array<{ id: string; problems: string[] }> };
		return { status: r.status, results, comparisons, invalid };
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
}

test('every scenario has a recording, and each replays as it was recorded', { timeout: 10 * 60_000 }, () => {
	const r = replay();
	// L1 gives a scenario with no recording a pending result
	assert.deepEqual(
		r.results.filter((x) => x.status === 'pending').map((x) => `${x.scenario}: ${x.why}`),
		[]
	);
	const off = r.comparisons.filter((x) => !reproduces(x)).map((x) => ({ recording: x.recording, status: x.status, differ: x.differ, mismatches: x.mismatches, diverged: x.diverged, finalFiles: x.finalFiles.differ }));
	assert.deepEqual(off, []);
	assert.equal(r.comparisons.length, loadRecordings().length);
	assert.equal(r.status, 0);
});

test('a replay that runs out of recorded replies does not reproduce', { timeout: 5 * 60_000 }, () => {
	const { file, recording } = loadRecordings()[0];
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-data-'));
	try {
		fs.cpSync(DATA_DIR, copy, { recursive: true });
		const cut: Recording = { ...recording, turns: recording.turns.map((t, i) => (i === 0 ? { ...t, events: t.events.slice(0, -1) } : t)) };
		fs.writeFileSync(path.join(copy, path.relative(DATA_DIR, file)), JSON.stringify(cut));
		const r = replay(['--scenarios', recording.scenario, '--set', recording.set], copy);
		assert.equal(r.status, 1);
		assert.match(r.comparisons[0]?.diverged ?? '', /the recording has nothing there/);
	} finally {
		fs.rmSync(copy, { recursive: true, force: true });
	}
});

test('a second recording of the same scenario and trial is invalid', () => {
	const { file, recording } = loadRecordings()[0];
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-data-'));
	try {
		fs.cpSync(DATA_DIR, copy, { recursive: true });
		fs.writeFileSync(path.join(copy, path.relative(DATA_DIR, path.dirname(file)), 'dup-t1.json'), JSON.stringify({ ...recording, set: 'dup' }));
		const r = replay(['--scenarios', recording.scenario], copy);
		assert.equal(r.status, 2);
		assert.deepEqual(r.invalid, [{ id: `recording ${recording.scenario}/dup-t1.json`, problems: [`${recording.scenario} trial ${recording.trial} is also recorded in ${recording.scenario}/${path.basename(file)}; delete one`] }]);
	} finally {
		fs.rmSync(copy, { recursive: true, force: true });
	}
});

test('a call digest leaves out ids, run tokens, start times and Variable values, and nothing else', () => {
	const live = '{"project_id":"6744c740-0cdb-4667-b471-6c31d17d92d2","token":"task-1","startTime":1761600000000,"value":"rrEvalVar0123456789abcdef01234567","text":"a"}';
	const replayed = '{"project_id":"1327e7c0-8479-4ab7-a319-c4dc944daeb5","token":"task-7","startTime":1761600099999,"value":"rrEvalVarfedcba9876543210fedcba98","text":"a"}';
	assert.equal(callDigest(replayed), callDigest(live));
	assert.notEqual(callDigest(replayed.replace('"a"', '"b"')), callDigest(live));
});
