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
// APP CHECK TESTS: the runner's own type-check and build of an app

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppCheckResult } from './app';
import { appPipelines, pipelineRuns, runVerdict, withRuns, type AppUsed, type RunSeen } from './appRun';

const PIPE = { path: 'apps/ask-ui/src/ask.pipe', projectId: 'p-ask' };
const used: AppUsed = { done: true, answered: true, detail: 'typed and pressed Ask; the page showed the answer after 3 s', excerpt: 'Paris' };
const seen = (over: Partial<RunSeen> = {}): RunSeen => ({ token: 'tk_1', name: 'ask', projectId: 'p-ask', completed: 0, failed: 0, errors: [], warnings: [], ...over });
const runs = (...list: RunSeen[]) => new Map(list.map((r) => [r.token, r]));

test("an app's pipelines are the files its glob matches that have a project_id", () => {
	const files = { 'apps/ask-ui/src/ask.pipe': JSON.stringify({ project_id: 'p-ask', components: [] }), 'apps/ask-ui/src/broken.pipe': '{', 'apps/ask-ui/src/none.pipe': '{}', 'pipelines/outside.pipe': JSON.stringify({ project_id: 'p-out' }) };
	assert.deepEqual(appPipelines(files, 'apps/ask-ui/*.pipe'), [PIPE]);
});

test("the engine's running tasks are kept only for the app's pipelines, with their status", async () => {
	const client = {
		getTasks: async () => [
			{ token: 'tk_1', name: 'ask', pipeline: { project_id: 'p-ask' } },
			{ token: 'tk_2', name: 'other', pipeline: { project_id: 'p-other' } },
		],
		getTaskStatus: async (token: string) => ({ completedCount: token === 'tk_1' ? 2 : 9, failedCount: 0, errors: [], warnings: [] }),
	};
	assert.deepEqual([...(await pipelineRuns(client, new Set(['p-ask']))).values()], [seen({ completed: 2 })]);
	// the record keeps no task token
	assert.ok(!JSON.stringify(runVerdict(used, [PIPE], runs(), runs(seen({ completed: 1 })), 'g').runs).includes('tk_1'));
});

test("a use passes when a task of the app's pipeline processed it with no new error and the page showed the answer", () => {
	const cases: Array<[label: string, before: Map<string, RunSeen>, after: Map<string, RunSeen>, u: AppUsed, ok: boolean, detail: RegExp]> = [
		['a new task', runs(), runs(seen({ completed: 1 })), used, true, /^runs: apps\/ask-ui\/src\/ask\.pipe \(ask: new task, 1 completed\), answer shown$/],
		['an existing task that completed one more', runs(seen({ completed: 3 })), runs(seen({ completed: 4 })), used, true, /ask: 1 completed/],
		['an existing task that did nothing', runs(seen({ completed: 3 })), runs(seen({ completed: 3 })), used, false, /no task of .* processed anything/],
		['no task at all', runs(), runs(), used, false, /has no running task of apps\/ask-ui\/src\/ask\.pipe/],
		['a new task that completed nothing', runs(), runs(seen()), used, false, /no task of .* processed anything/],
		['a new error', runs(seen({ errors: ['old'] })), runs(seen({ completed: 1, errors: ['old', 'Error*Invalid API key*x.py:1'] })), used, false, /reported 1 error\(s\), 0 failed object\(s\) and 0 failure warning\(s\): Invalid API key$/],
		['a failed object', runs(), runs(seen({ failed: 1 })), used, false, /1 failed object/],
		// as seen live: a failed model call still completes the question, and is only a warning
		['a model call that failed', runs(), runs(seen({ completed: 1, warnings: ['Warning*Streaming disabled for model=x*chat.py:568', 'Warning*Chat failed for model=x (AnthropicAuthenticationError): Error code: 401*chat.py:413'] })), { ...used, answered: null }, false, /1 failure warning\(s\): Chat failed for model=x \(AnthropicAuthenticationError\): Error code: 401$/],
		['the model error on the page', runs(), runs(seen({ completed: 1 })), { ...used, answered: null, excerpt: 'Ask Claude\n**LLM error** — 401' }, false, /the app showed the model's error: \*\*LLM error\*\* — 401/],
		['an old warning only', runs(seen({ completed: 1, warnings: ['Warning*Chat failed*x'] })), runs(seen({ completed: 2, warnings: ['Warning*Chat failed*x'] })), used, true, /ask: 1 completed/],
		['no answer on the page', runs(), runs(seen({ completed: 1 })), { ...used, answered: false, detail: 'typed and pressed Ask; the page did not show the answer in 120 s' }, false, /ran, but the page did not show the expected answer/],
		['an app with no text box', runs(), runs(), { done: false, answered: null, detail: "no text box on the app's page", excerpt: '' }, false, /could not use the app: no text box/],
	];
	for (const [label, before, after, u, ok, detail] of cases) {
		const v = runVerdict(u, [PIPE], before, after, 'apps/ask-ui/*.pipe');
		assert.equal(v.ok, ok, label);
		assert.match(v.detail, detail, label);
	}
	assert.match(runVerdict(used, [], runs(), runs(), 'apps/ask-ui/*.pipe').detail, /no pipeline file in the app matches apps\/ask-ui\/\*\.pipe/);
});

test('a failed run fails the app check, and one the engine could not report only adds a note', () => {
	const check = (): AppCheckResult => ({ ok: true, detail: 'types and build pass', types: { ok: true, output: '' }, build: { ok: true, output: '' } });
	const checks = { 'apps/a-ui': check(), 'apps/b-ui': check(), 'apps/c-ui': check(), 'apps/d-ui': check() };
	const base = { used, pipelines: [PIPE], runs: [] };
	withRuns(checks, {
		'apps/a-ui': { ...base, ok: true, detail: 'runs: ask.pipe' },
		'apps/b-ui': { ...base, ok: false, detail: 'run: no task' },
		'apps/c-ui': { ...base, ok: null, detail: 'run not read: no preview' },
	});
	assert.deepEqual(
		Object.values(checks).map((c) => [c.ok, c.detail]),
		[
			[true, 'types and build pass; runs: ask.pipe'],
			[false, 'run: no task'],
			[true, 'types and build pass; run not checked (run not read: no preview)'],
			[true, 'types and build pass'],
		]
	);
});
