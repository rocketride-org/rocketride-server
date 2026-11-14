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
// RUN OUTPUT TESTS: run_output's expectations, and which runs it ends first
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RocketRideClient } from 'rocketride';

import { expectationFailures, runOutputCheck, type OwnedRun } from './runOutput';
import { referenceTree } from './scenarios';

test('the summary length counts each output once', () => {
	const expect = { nonempty: true, shorter_than_input: true };
	assert.deepEqual(expectationFailures(expect, { answers: ['abcdef'], text: [] }, 10), []);
	assert.deepEqual(expectationFailures(expect, { answers: [], text: ['abcdef'] }, 10), []);
	assert.deepEqual(expectationFailures(expect, { answers: ['abcdef'], text: ['ghij'] }, 10), ['the output (11 characters) is not shorter than the input (10)']);
	assert.deepEqual(expectationFailures(expect, { answers: [], text: [] }, 10), ['the output is empty', 'the output (0 characters) is not shorter than the input (10)']);
});

/** A client with the one engine rule run_output meets here: a second start of a running pipeline and source is refused. */
function engine(): RocketRideClient {
	const runs = new Map<string, { project_id: string; source: string; startTime: number; completed: boolean }>();
	const client = {
		use: async ({ pipeline, source }: { pipeline: { project_id?: string }; source: string }) => {
			const project_id = String(pipeline.project_id ?? '');
			if ([...runs.values()].some((r) => !r.completed && r.project_id === project_id && r.source === source)) throw new Error('Pipeline execution failed: Pipeline is already running');
			const token = `task-${runs.size + 1}`;
			runs.set(token, { project_id, source, startTime: runs.size + 1, completed: false });
			return { token, reused: false };
		},
		getTaskStatus: async (token: string) => runs.get(token),
		terminate: async (token: string) => void Object.assign(runs.get(token) ?? {}, { completed: true }),
		send: async () => ({ result_types: {} }),
	};
	return client as unknown as RocketRideClient;
}

test("run_output ends the trial's own run of the pipeline before it starts one, and never another's", async () => {
	const path = 'pipelines/summarize-text.pipe';
	const files = referenceTree('build-02-summarize-webhook') ?? {};
	const pipeline = JSON.parse(files[path]) as never;
	const ck = { id: 'runs', kind: 'run_output', path, send: { webhook: { text: 'some text' } }, expect: { nonempty: true } };
	const client = engine();
	const start = async (): Promise<OwnedRun> => {
		const { token } = await client.use({ pipeline, source: 'webhook_1' });
		return { token, startTime: (await client.getTaskStatus(token)).startTime };
	};
	// the agent's own test run is still running when the trial ends
	const ours = await start();
	assert.doesNotMatch((await runOutputCheck(client, ck, files, ['ROCKETRIDE_OPENAI_KEY'], [ours])).detail, /already running/);
	const theirs = await start();
	assert.match((await runOutputCheck(client, ck, files, ['ROCKETRIDE_OPENAI_KEY'], [ours])).detail, /already running/);
	assert.equal((await client.getTaskStatus(theirs.token)).completed, false);
});
