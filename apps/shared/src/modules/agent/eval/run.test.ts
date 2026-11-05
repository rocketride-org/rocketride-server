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
// RUNNER TESTS: how L3 starts and stops the engine through the skill
// =============================================================================

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Provenance } from './report';

// run.ts reads RR_VERIFY_STATE once, when it loads, so the tests share one state folder
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-'));
after(() => fs.rmSync(state, { recursive: true, force: true }));
let runs = 0;

/** Writes the run id launch records once it has started an engine, a new one each time. */
function recordEngine(): void {
	fs.writeFileSync(path.join(state, 'engine.run'), `agent-${++runs}\n`);
}

/**
 * Runs work with the skill's steps mocked: each spawnSync records its step and
 * the keys folder it would use, and exits with skill(step).
 */
async function withSkill(skill: (step: string) => number, work: (run: typeof import('./run')) => Promise<unknown>): Promise<Array<{ step: string; keysDir: string | undefined }>> {
	const env = { RR_VERIFY_STATE: state, EVAL_KEYS_DIR: '/keys/eval', RR_VERIFY_KEYS_DIR: '/keys/verify', EVAL_LOCK_HELD: '1' };
	const saved = Object.keys(env).map((k) => [k, process.env[k]] as const);
	Object.assign(process.env, env);
	const calls: Array<{ step: string; keysDir: string | undefined }> = [];
	const spawned = mock.method(childProcess, 'spawnSync', (_cmd: string, argv: string[], opts: { env?: NodeJS.ProcessEnv }) => {
		calls.push({ step: argv[0], keysDir: opts.env?.RR_VERIFY_KEYS_DIR });
		return { status: skill(argv[0]) };
	});
	try {
		await work(await import('./run'));
		return calls;
	} finally {
		spawned.mock.restore();
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** The skill steps an L3 run takes before it throws error. */
async function l3Steps(skill: (step: string) => number, error: RegExp): Promise<string[]> {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-out-'));
	try {
		const calls = await withSkill(skill, (run) => assert.rejects(run.cmdRun({ layer: 'L3', scenarios: 'build-01-chat-claude', out }), error));
		return calls.map((c) => c.step);
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
}

/** What a launch that started an engine does: it records the engine, then exits with code. */
function started(code: number): number {
	recordEngine();
	return code;
}

test('L3 starts the engine and fingerprints its Variables with the keys in EVAL_KEYS_DIR', async () => {
	const calls = await withSkill(
		() => 0,
		(run) => run.startEngine({} as Provenance)
	);
	assert.deepEqual(calls, [
		{ step: 'launch', keysDir: '/keys/eval' },
		{ step: 'keys', keysDir: '/keys/eval' },
	]);
});

test('L3 stops the engine when fingerprinting its Variables fails', async () => {
	assert.deepEqual(await l3Steps((step) => (step === 'launch' ? started(0) : Number(step === 'keys')), /could not fingerprint/), ['launch', 'keys', 'cleanup']);
});

test('L3 stops what launch started when launch fails part way', async () => {
	assert.deepEqual(await l3Steps((step) => (step === 'launch' ? started(1) : 0), /did not start/), ['launch', 'cleanup']);
});

test('L3 leaves alone the running engine that made launch refuse', async () => {
	recordEngine();
	assert.deepEqual(await l3Steps((step) => Number(step === 'launch'), /did not start/), ['launch']);
});
