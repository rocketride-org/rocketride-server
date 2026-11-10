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
// JUDGE TESTS: the command's arguments, its checklist, its key and its summary
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { JudgeResult } from '../judge/judge.mjs';
import { sessionEnv } from '../judge/session.mjs';
import { readModelKeys } from './evidence';
import { clearStore, judgeKey, judgePlan, judgeSummary } from './judge';

/** A workspace with one app whose package.json says `manifest`, and a checklist file holding `checklist`. */
function fixture(manifest: unknown, checklist: string): { workspace: string; checklist: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-plan-'));
	const app = path.join(dir, 'final', 'apps', 'expenses-ui');
	fs.mkdirSync(app, { recursive: true });
	fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, 'checklist.txt'), checklist);
	return { workspace: path.join(dir, 'final'), checklist: path.join(dir, 'checklist.txt') };
}

test('judgePlan reads the app id from the app folder and the checklist one line each, blank lines left out', () => {
	const f = fixture({ appManifest: { id: 'rocketride.expenses' } }, 'Adding an expense shows it.\r\n\n  The total is the sum.  \n');
	const plan = judgePlan({ workspace: f.workspace, app: 'apps/expenses-ui', checklist: f.checklist, out: 'out', runs: null });
	assert.equal(plan.app, 'apps/expenses-ui');
	assert.equal(plan.appId, 'rocketride.expenses');
	assert.deepEqual(plan.checklist, ['Adding an expense shows it.', 'The total is the sum.']);
	assert.equal(plan.out, path.resolve('out'));
	// an absolute app folder inside the workspace is the same app
	assert.equal(judgePlan({ workspace: f.workspace, app: path.join(f.workspace, 'apps', 'expenses-ui'), checklist: f.checklist, out: 'out', runs: 1 }).app, 'apps/expenses-ui');
});

test('judgePlan refuses what it cannot judge', () => {
	const f = fixture({ appManifest: { id: 'rocketride.expenses' } }, 'One line\n');
	const plan = (over: Partial<Parameters<typeof judgePlan>[0]>) => () => judgePlan({ workspace: f.workspace, app: 'apps/expenses-ui', checklist: f.checklist, out: 'out', runs: null, ...over });
	assert.throws(plan({ app: null, checklist: null }), /--app, --checklist/);
	assert.throws(plan({ app: '../elsewhere' }), /not a folder inside the workspace/);
	assert.throws(plan({ app: '.' }), /not a folder inside the workspace/);
	assert.throws(judgePlan.bind(null, { ...fixture({ appManifest: {} }, 'One line\n'), app: 'apps/expenses-ui', out: 'out', runs: null }), /no appManifest.id/);
	assert.throws(judgePlan.bind(null, { ...fixture({ appManifest: { id: 'a.b' } }, '\n  \n'), app: 'apps/expenses-ui', out: 'out', runs: null }), /has no lines/);
	assert.throws(plan({ inputs: path.join(os.tmpdir(), 'no-such-inputs-folder') }), /--inputs .* is not a folder/);
});

test('judgePlan takes a folder of files the judge may upload, and none by default', () => {
	// real-05, real-07 and real-08 need invoices, statements and CVs to upload
	const f = fixture({ appManifest: { id: 'rocketride.invoices' } }, 'Dropping in an invoice adds a row.\n');
	const inputs = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-inputs-'));
	const base = { workspace: f.workspace, app: 'apps/expenses-ui', checklist: f.checklist, out: 'out', runs: null };
	assert.equal(judgePlan(base).inputs, null);
	assert.equal(judgePlan({ ...base, inputs }).inputs, path.resolve(inputs));
});

test("the judge's sessions run on EVAL_ANTHROPIC_KEY alone, never on an Anthropic credential from the env file's other lines or the shell", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-key-'));
	const file = path.join(dir, 'keys.txt');
	fs.writeFileSync(file, 'ANTHROPIC_API_KEY=file-anthropic-key\nexport EVAL_ANTHROPIC_KEY="eval-anthropic-key"\nEVAL_OPENAI_KEY=eval-openai-key\n');
	const shell = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
	const saved = Object.fromEntries(shell.map((name) => [name, process.env[name]]));
	for (const name of shell) process.env[name] = `shell-${name}`;
	try {
		const env = sessionEnv(judgeKey(readModelKeys(file)), { TMPDIR: '/tmp' });
		assert.deepEqual(
			Object.keys(env).filter((name) => /ANTHROPIC|CLAUDE_CODE_OAUTH/.test(name)),
			['ANTHROPIC_API_KEY']
		);
		assert.equal(env.ANTHROPIC_API_KEY, 'eval-anthropic-key');
		assert.throws(() => sessionEnv(''), /EVAL_ANTHROPIC_KEY/);
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("summary.md gives each line's verdict with the evidence of the run that decided it", () => {
	const run = (n: number, verdicts: Array<'pass' | 'fail'>, invalidReason: string | null = null) => ({
		run: n,
		verdict: invalidReason ? 'inconclusive' : verdicts.includes('fail') ? 'fail' : 'pass',
		invalidReason,
		lines: invalidReason ? [] : verdicts.map((verdict, i) => ({ line: i + 1, verdict, did: 'Added 19.99, 0.01 and 10.10', saw: `run ${n} line ${i + 1}: Total | $30.10\nshown` })),
		overall: null,
		costUsd: 0.1,
		durationMs: 60_000,
		exit: 0,
		transcript: `run-${n}.jsonl`,
	});
	const result = {
		verdict: 'fail',
		costUsd: 0.3,
		runs: [run(1, ['pass', 'pass']), run(2, ['pass', 'fail']), run(3, [], 'timed out after 600000 ms')],
		lines: [
			{ line: 1, text: 'Adding shows it.', verdict: 'inconclusive', runs: ['pass', 'pass', null] },
			{ line: 2, text: 'The total adds up.', verdict: 'fail', runs: ['pass', 'fail', null] },
		],
	} as unknown as JudgeResult;
	const summary = judgeSummary(result, { workspace: path.join(os.tmpdir(), 'final'), app: 'apps/expenses-ui', appId: 'rocketride.expenses', version: 1, url: 'http://127.0.0.1:3000/?appid=rocketride.expenses' });
	assert.match(summary, /Verdict: \*\*fail\*\* over 3 run\(s\), \$0\.30/);
	assert.match(summary, /\| 1 \| Adding shows it\. \| inconclusive \| pass pass invalid \| run 3 invalid: timed out after 600000 ms \|/);
	assert.match(summary, /\| 2 \| The total adds up\. \| fail \| pass fail invalid \| run 2: run 2 line 2: Total \\\| \$30\.10 shown \|/);
});

test("the stack's store is cleared when the judge is done, its logs kept, unless --keep-store", () => {
	// each judge run's store is about 250 MB of the engine's own copies; 16 runs would fill this disk
	const make = () => {
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-out-'));
		fs.mkdirSync(path.join(out, 'stack', 'store', 'apps'), { recursive: true });
		fs.writeFileSync(path.join(out, 'stack', 'store', 'apps', 'big.bin'), 'x');
		fs.writeFileSync(path.join(out, 'stack', 'engine.log'), 'log');
		return out;
	};
	const cleared = make();
	clearStore(cleared, false);
	assert.deepEqual(fs.readdirSync(path.join(cleared, 'stack')), ['engine.log']);
	const kept = make();
	clearStore(kept, true);
	assert.deepEqual(fs.readdirSync(path.join(kept, 'stack')).sort(), ['engine.log', 'store']);
	// nothing to clear is not an error
	clearStore(fs.mkdtempSync(path.join(os.tmpdir(), 'judge-out-')), false);
});
