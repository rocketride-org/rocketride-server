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
// TASK TESTS: the breadth set loads, and a broken task is refused by name
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DATA_DIR } from './catalog';
import { loadTasks, validateTask } from './task';

test('every task in tasks/breadth is valid', () => {
	const { tasks, invalid } = loadTasks(DATA_DIR);
	assert.deepEqual(invalid, []);
	assert.equal(tasks.length, 30);
});

test('a hand-broken copy of a task is refused, with each problem named', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-tasks-'));
	try {
		const id = 'edit-01-switch-model';
		const task = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${id}.json`), 'utf8')) as Record<string, unknown>;
		task.prompt = '';
		task.timeLimitSec = '300';
		task.cards = 'maybe';
		task.timelimit = 300;
		const checks = task.checks as Array<Record<string, unknown>>;
		checks.push({ id: 'tools', type: 'tool_called', tool: 'write_file' });
		checks.push({ id: 'typo', type: 'file_exist', path: 'pipelines/support-chat.pipe' });
		checks.push({ id: 'bad-regex', type: 'file_matches', path: 'pipelines/support-chat.pipe', regex: '(' });
		checks.push({ id: 'no-path', type: 'validates' });
		checks.push({ id: 'bad-reason', type: 'outcome', expect: 'failed', reason: 3 });
		// the starting file's text is not copied into the broken set
		fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(task));

		const { problems } = validateTask(id, dir);
		const expected = ['unknown field timelimit', 'prompt is empty', 'timeLimitSec must be a whole number of seconds above 0', 'file pipelines/support-chat.pipe comes from "fixtures/support-chat-openai/pipelines/support-chat.pipe", which is not a file in the task set folder', "check tools has type tool_called, which reads the agent's tool calls, so a browser trial cannot grade it", 'check typo has unknown type "file_exist"', 'check bad-regex regex is not a valid regex', 'check no-path (validates) needs path', 'check bad-reason reason must be text: the reason the saved turn must end with, such as refused'];
		for (const p of expected) assert.ok(problems.includes(p), `missing problem: ${p}\ngot:\n${problems.join('\n')}`);
		assert.ok(problems.some((p) => p.startsWith('cards must be')));
		assert.deepEqual(
			loadTasks(dir).invalid.map((v) => v.id),
			[id]
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
