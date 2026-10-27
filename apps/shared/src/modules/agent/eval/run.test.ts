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
// RUNNER TESTS — where L3 tells the skill to find the keys
// =============================================================================

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Provenance } from './report';

test('L3 starts the engine and fingerprints its Variables with the keys in EVAL_KEYS_DIR', async () => {
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-'));
	// RR_VERIFY_STATE is read when run.ts loads
	const env = { RR_VERIFY_STATE: state, EVAL_KEYS_DIR: '/keys/eval', RR_VERIFY_KEYS_DIR: '/keys/verify', EVAL_LOCK_HELD: '1' };
	const saved = Object.keys(env).map((k) => [k, process.env[k]] as const);
	Object.assign(process.env, env);
	// no skill runs: each call records the keys folder it would have used
	const calls: Array<{ step: string; keysDir: string | undefined }> = [];
	const spawned = mock.method(childProcess, 'spawnSync', (_cmd: string, argv: string[], opts: { env?: NodeJS.ProcessEnv }) => {
		calls.push({ step: argv[0], keysDir: opts.env?.RR_VERIFY_KEYS_DIR });
		return { status: 0 };
	});
	try {
		const { startEngine } = await import('./run');
		await startEngine({} as Provenance);
		assert.deepEqual(calls, [
			{ step: 'launch', keysDir: '/keys/eval' },
			{ step: 'keys', keysDir: '/keys/eval' },
		]);
	} finally {
		spawned.mock.restore();
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fs.rmSync(state, { recursive: true, force: true });
	}
});
