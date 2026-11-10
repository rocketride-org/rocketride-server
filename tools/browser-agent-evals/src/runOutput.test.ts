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

import fs from 'node:fs';
import path from 'node:path';

import type { RocketRideClient } from 'rocketride';

import { EVAL_DIR } from './catalog';
import { expectationFailures } from './expect';
import { runOutputCheck, type OwnedRun } from './runOutput';
import { loadTask } from './task';

test('the summary length counts each output once', () => {
	const expect = { nonempty: true, shorter_than_input: true };
	assert.deepEqual(expectationFailures(expect, { answers: ['abcdef'], text: [] }, 10), []);
	assert.deepEqual(expectationFailures(expect, { answers: [], text: ['abcdef'] }, 10), []);
	assert.deepEqual(expectationFailures(expect, { answers: ['abcdef'], text: ['ghij'] }, 10), ['the output (11 characters) is not shorter than the input (10)']);
	assert.deepEqual(expectationFailures(expect, { answers: [], text: [] }, 10), ['the output is empty', 'the output (0 characters) is not shorter than the input (10)']);
});

const BATCH_1 = path.join(EVAL_DIR, '..', 'tasks', 'batch-1');

/** An output check in tasks/batch-1, as the task file has it. */
function batchCheck(id: string): Record<string, unknown> {
	return loadTask(id, BATCH_1).checks.find((c) => c.type === 'output') as Record<string, unknown>;
}

/** An output check's expect in tasks/batch-1. */
function batchExpect(id: string): Record<string, unknown> {
	return batchCheck(id).expect as Record<string, unknown>;
}

test("text_match passes only when the pipeline's text matches", () => {
	const echo = batchExpect('build-15-echo-minimal');
	assert.deepEqual(expectationFailures(echo, { answers: [], text: ['echo check 5521: the quick brown fox'] }, 36), []);
	assert.deepEqual(expectationFailures(echo, { answers: [], text: ['the quick brown fox'] }, 36), ['the text does not match echo check 5521']);
	assert.deepEqual(expectationFailures(echo, { answers: [], text: [] }, 36), ['no text or answer came back, wanted text matching echo check 5521']);
	// a vision model answers rather than returning text
	const receipt = batchExpect('build-16-vision-receipt');
	assert.deepEqual(expectationFailures(receipt, { answers: ['Store: Corner Market\nTotal: $27.14'], text: [] }, 1000), []);
	assert.equal(expectationFailures(receipt, { answers: ['Store: Corner Market\nTotal: $31.00'], text: [] }, 1000).length, 1);
});

test('text_not_match fails when the text still holds what it must not', () => {
	const redact = batchExpect('build-06-redact-pii');
	assert.deepEqual(expectationFailures(redact, { answers: [], text: ['Please call <PERSON> at <PHONE> or email <EMAIL> about the order.'] }, 90), []);
	assert.equal(expectationFailures(redact, { answers: [], text: ['Please call Jane Smith at <PHONE> or email <EMAIL> about the order.'] }, 90).length, 1);
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
	// the parts of build-02's reference run_output reads: a webhook source and a project id
	const files = { [path]: JSON.stringify({ project_id: 'summarize-text', components: [{ id: 'webhook_1', provider: 'webhook' }] }) };
	const pipeline = JSON.parse(files[path]) as never;
	const ck = { id: 'runs', kind: 'run_output', path, send: { webhook: { text: 'some text' } }, expect: { nonempty: true } };
	const client = engine();
	const start = async (): Promise<OwnedRun> => {
		const { token } = await client.use({ pipeline, source: 'webhook_1' });
		return { token, startTime: (await client.getTaskStatus(token)).startTime };
	};
	// the agent's own test run is still running when the trial ends
	const ours = await start();
	assert.doesNotMatch((await runOutputCheck(client, ck, 'tasks', files, ['ROCKETRIDE_OPENAI_KEY'], [ours])).detail, /already running/);
	const theirs = await start();
	assert.match((await runOutputCheck(client, ck, 'tasks', files, ['ROCKETRIDE_OPENAI_KEY'], [ours])).detail, /already running/);
	assert.equal((await client.getTaskStatus(theirs.token)).completed, false);
});

test("an output check sends its input file from the task's own folder", async () => {
	const ck: Record<string, unknown> = { ...batchCheck('build-09-ocr-receipt'), kind: 'run_output' };
	const files = { [String(ck.path)]: JSON.stringify({ project_id: 'receipt-text', components: [{ id: 'dropper_1', provider: 'dropper' }] }) };
	const sent: Array<{ data: Uint8Array; name: string; mimetype: string }> = [];
	const client = {
		use: async () => ({ token: 'task-1', reused: false }),
		getTaskStatus: async () => ({}),
		terminate: async () => {},
		send: async (_token: string, data: Uint8Array, meta: { name: string }, mimetype: string) => {
			sent.push({ data, name: meta.name, mimetype });
			return { result_types: { text: 'text' }, text: ['TOTAL 27.14'] };
		},
	} as unknown as RocketRideClient;

	const result = await runOutputCheck(client, ck as never, BATCH_1, files, [], []);
	assert.equal(result.status, 'pass', result.detail);
	assert.deepEqual(
		sent.map((s) => ({ name: s.name, mimetype: s.mimetype, same: Buffer.from(s.data).equals(fs.readFileSync(path.join(BATCH_1, 'inputs', 'receipt.png'))) })),
		[{ name: 'receipt.png', mimetype: 'image/png', same: true }]
	);
});

test('an upload send uses a webhook when the pipeline has no dropper, and fails with neither', async () => {
	// build-09's prompt only says "upload"; both its batch-1 runs built a webhook and failed a dropper-only check
	const ck: Record<string, unknown> = { ...batchCheck('build-09-ocr-receipt'), kind: 'run_output' };
	const pipe = (provider: string) => ({ [String(ck.path)]: JSON.stringify({ project_id: 'receipt-text', components: [{ id: `${provider}_1`, provider }] }) });
	const used: string[] = [];
	const client = {
		use: async ({ source }: { source: string }) => (used.push(source), { token: 'task-1', reused: false }),
		getTaskStatus: async () => ({}),
		terminate: async () => {},
		send: async () => ({ result_types: { text: 'text' }, text: ['TOTAL 27.14'] }),
	} as unknown as RocketRideClient;

	assert.equal((await runOutputCheck(client, ck as never, BATCH_1, pipe('webhook'), [], [])).status, 'pass');
	assert.deepEqual(used, ['webhook_1']);
	assert.equal((await runOutputCheck(client, ck as never, BATCH_1, pipe('chat'), [], [])).detail, 'the pipeline has no dropper or webhook source');
});

test('an output check keeps every answer whole, so a reader can judge what the excerpt cuts', async () => {
	// edit-02 round 2 failed on two answers, and its excerpt kept 100 characters of each
	const long = `# What is a Webhook?\n\n${'A webhook sends data from one app to another when something happens. '.repeat(4)}`;
	const files = { 'pipelines/support.pipe': JSON.stringify({ project_id: 'support', components: [{ id: 'webhook_1', provider: 'webhook' }] }) };
	const ck = { id: 'runs', kind: 'run_output', path: 'pipelines/support.pipe', send: { webhook: { text: 'What is a webhook?' } }, expect: { nonempty: true } };
	const client = {
		use: async () => ({ token: 'task-1', reused: false }),
		getTaskStatus: async () => ({}),
		terminate: async () => {},
		send: async () => ({ result_types: { answers: 'answers' }, answers: [long, 'A webhook is a friendly ping.'] }),
	} as unknown as RocketRideClient;

	const result = await runOutputCheck(client, ck as never, BATCH_1, files, [], []);
	assert.deepEqual(result.output, { answers: [long, 'A webhook is a friendly ping.'], text: [] });
});
