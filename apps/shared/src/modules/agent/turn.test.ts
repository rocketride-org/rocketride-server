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
// TURN CARD TESTS — the card each outcome gets under its row
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { choiceAction, CONTINUE, OPEN_VARIABLES, outcomeOf, redactDeep, turnCard, type TurnResult } from './turn';

/** A turn that changed three files and checked two things. */
function turn(extra: Partial<TurnResult>): TurnResult {
	return {
		turnId: 't1',
		outcome: 'done',
		reason: 'done',
		finalText: 'Built it.',
		files: [
			{ path: 'pipelines/chat.pipe', change: 'added' },
			{ path: 'apps/a-ui/src/new.ts', change: 'renamed', from: 'apps/a-ui/src/old.ts' },
			{ path: 'apps/a-ui/src/gone.ts', change: 'deleted' },
		],
		checks: [
			{ target: 'pipelines/chat.pipe', step: 'validate', status: 'pass', summary: 'validate OK' },
			{ target: 'acme.a', step: 'types', status: 'fail', summary: 'types: 2 errors' },
			{ target: 'acme.a', step: 'build', status: 'not_run', summary: 'preview closed: build not checked' },
		],
		usage: { waves: 3, modelRequests: 3, toolCalls: 4 },
		...extra,
	};
}

test('each loop stop maps to its outcome', () => {
	assert.deepEqual((['done', 'needs_input', 'stopped', 'error', 'empty_plan'] as const).map(outcomeOf), ['done', 'needs_input', 'stopped', 'failed', 'incomplete']);
});

test('the card says how each outcome ended, with the files left as links and the deleted ones as lines', () => {
	const files = ['pipelines/chat.pipe', 'apps/a-ui/src/new.ts'];
	assert.deepEqual(turnCard(turn({})), {
		tone: 'success',
		title: 'Done',
		lines: ['pipelines/chat.pipe: validate OK', 'acme.a: types: 2 errors', 'acme.a: preview closed: build not checked', 'Deleted apps/a-ui/src/gone.ts'],
		files,
	});
	assert.deepEqual(turnCard(turn({ outcome: 'stopped', reason: 'stopped', finalText: '' })), { tone: 'neutral', title: 'Stopped', lines: ['Deleted apps/a-ui/src/gone.ts'], files });
	assert.deepEqual(turnCard(turn({ outcome: 'failed', reason: 'error', error: 'The model pipeline stopped responding: gone' })), {
		tone: 'danger',
		title: 'Not finished',
		lines: ['The model pipeline stopped responding: gone', 'acme.a: types: 2 errors', 'Deleted apps/a-ui/src/gone.ts'],
		files,
	});
	assert.deepEqual(turnCard(turn({ outcome: 'incomplete', reason: 'empty_plan', files: [] })), { tone: 'danger', title: 'Not finished', lines: ['acme.a: types: 2 errors'] });
});

test('a needs-you card offers each choice, Open Variables, or Continue, and an answered one disables its answers', () => {
	const question = turn({ outcome: 'needs_input', reason: 'needs_input', files: [], request: { id: 'r1', kind: 'question', question: 'Which model?', choices: ['Claude', 'GPT-5'] } });
	assert.deepEqual(turnCard(question), {
		tone: 'info',
		title: 'Needs you',
		actions: [
			{ id: choiceAction(0), label: 'Claude' },
			{ id: choiceAction(1), label: 'GPT-5' },
		],
	});
	const answered = { ...question, request: { ...question.request!, answeredBy: 't2' } };
	assert.deepEqual(
		turnCard(answered).actions?.map((a) => a.disabled),
		[true, true]
	);
	// step: a Variable says only whether its name is set, never whether the key works
	const variable = turn({ outcome: 'needs_input', reason: 'needs_input', files: [], request: { id: 'r2', kind: 'variable', question: 'Add your OpenAI key.', variable: 'ROCKETRIDE_OPENAI_KEY', variableSet: false } });
	assert.deepEqual(turnCard(variable), { tone: 'info', title: 'Needs you', lines: ['ROCKETRIDE_OPENAI_KEY is not set in Variables'], actions: [{ id: OPEN_VARIABLES, label: 'Open Variables' }] });
	const unknown = { ...variable, request: { ...variable.request!, variableSet: undefined } };
	assert.deepEqual(turnCard(unknown).lines, ['ROCKETRIDE_OPENAI_KEY']);
	const paused = turn({ outcome: 'needs_input', reason: 'needs_input', files: [], request: { id: 'r3', kind: 'continue', question: 'Paused after 60 steps.' } });
	assert.deepEqual(turnCard(paused).actions, [{ id: CONTINUE, label: 'Continue' }]);
});

test('redactDeep hides a key in any string of a turn and keeps the run token', () => {
	const key = `sk-proj-${'k'.repeat(40)}`;
	const redacted = redactDeep({ finalText: `use ${key}`, runsStarted: [{ token: 'tk_some_run_token', projectId: 'p', source: 's', startTime: 1, scopeKey: '', conversationId: 'c' }], usage: { waves: 1 } });
	assert.equal(redacted.finalText, 'use [redacted]');
	assert.equal(redacted.runsStarted[0].token, 'tk_some_run_token');
	assert.deepEqual(redacted.usage, { waves: 1 });
});
