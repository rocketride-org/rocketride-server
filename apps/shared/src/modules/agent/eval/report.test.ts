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

import { writeReport, type Provenance } from './report';
import type { ScenarioResult } from './types';

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
