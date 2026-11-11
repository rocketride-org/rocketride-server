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
// CAUSE TESTS: each failed trial gets the one label its evidence points to
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { causeOf } from './cause';
import type { TrialResult } from './grade';
import type { SmokeRow } from './smoke-models';
import type { BrowserTrialRecord } from './trial';

const result = (status: TrialResult['status']) => ({ status, why: `${status} why`, checks: [] }) as unknown as TrialResult;
const record = (over: Record<string, unknown> = {}, turn: Record<string, unknown> = { outcome: 'done' }) => ({ endReason: 'turn_ended', infraError: null, browser: { leaks: [] }, turns: [{ result: turn, finalText: '' }], ...over }) as unknown as BrowserTrialRecord;
const answered: SmokeRow = { model: 'anthropic/claude-haiku-5-5', answered: true, seconds: 4, keyListed: true, detail: '4 characters' };
const refused: SmokeRow = { model: 'anthropic/claude-haiku-5-5', answered: false, seconds: 2, keyListed: true, detail: "AuthenticationError: Error code: 401 - {'type': 'authentication_error'}" };

test('a pass or a pending trial gets no label', () => {
	assert.equal(causeOf(result('pass'), record(), answered), null);
	assert.equal(causeOf(result('pending'), record(), null), null);
});

test('a runner error is the runner, even when the model is down too', () => {
	assert.equal(causeOf(result('error'), record({ endReason: 'runner_error', infraError: 'the Agent rail tab never became selected' }), refused)?.label, 'runner');
	assert.equal(causeOf(result('fail'), record({ browser: { leaks: [{ file: 'trace.jsonl', key: 'ROCKETRIDE_ANTHROPIC_KEY' }] } }), answered)?.label, 'runner');
});

test('a failed known-good call, a missing key, or a provider error is the environment', () => {
	const kg = causeOf(result('fail'), record(), refused);
	assert.equal(kg?.label, 'environment');
	assert.match(kg?.evidence ?? '', /known-good call .* failed: AuthenticationError/);
	assert.equal(causeOf(result('error'), record({ endReason: 'environment', infraError: 'the model picker says the anthropic key is missing' }), null)?.label, 'environment');
	assert.equal(causeOf(result('incomplete'), record({}, { outcome: 'failed', error: 'Error code: 429 rate limit' }), null)?.label, 'environment');
});

test('an output check that failed on a module missing from the engine is the environment', () => {
	const r = { status: 'fail', why: 'failed: runs', checks: [{ id: 'runs', kind: 'output', status: 'fail', detail: "the run reported an error: No module named 'langchain_text_splitters'", blocker: false }] } as unknown as TrialResult;
	assert.equal(causeOf(r, record(), answered)?.label, 'environment');
});

test('a failure with a working model is the agent', () => {
	const c = causeOf(result('fail'), record(), answered);
	assert.equal(c?.label, 'agent');
	assert.equal(c?.knownGood?.answered, true);
	assert.equal(causeOf(result('incomplete'), record({}, { outcome: 'incomplete', error: 'empty plan' }), answered)?.label, 'agent');
});

test("a failed turn is the agent when only its answer, or a pipeline it ran, shows a provider's error", () => {
	const answer = record({ turns: [{ result: { outcome: 'failed', error: 'the agent stopped' }, finalText: 'Your key failed authentication with OpenAI.' }] });
	assert.equal(causeOf(result('incomplete'), answer, null)?.label, 'agent');
	for (const error of ['**LLM error**: the pipeline answered nothing', 'Profile «secret:abc» is not defined in llm_anthropic']) {
		assert.equal(causeOf(result('incomplete'), record({}, { outcome: 'failed', error }), null)?.label, 'agent', error);
	}
});
