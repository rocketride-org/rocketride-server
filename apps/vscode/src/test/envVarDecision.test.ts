// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideEnvVars, extractPipelineEnvVars } from '../shared/util/envVarDecision';

test('extractPipelineEnvVars finds each ROCKETRIDE_ reference once', () => {
	const pipeline = {
		a: { key: '${ROCKETRIDE_ANTHROPIC_KEY}' },
		b: { key: '${ROCKETRIDE_ANTHROPIC_KEY}', other: '${ROCKETRIDE_SLACK_TOKEN}' },
	};
	assert.deepEqual(extractPipelineEnvVars(pipeline).sort(), ['ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_SLACK_TOKEN']);
});

test('extractPipelineEnvVars ignores non-ROCKETRIDE placeholders', () => {
	assert.deepEqual(extractPipelineEnvVars({ a: '${HOME}', b: '${PATH}' }), []);
});

test('all referenced variables defined is ok', () => {
	const d = decideEnvVars(['ROCKETRIDE_A'], ['ROCKETRIDE_A', 'ROCKETRIDE_B']);
	assert.equal(d.kind, 'ok');
});

test('an undefined variable is reported as missing', () => {
	const d = decideEnvVars(['ROCKETRIDE_A', 'ROCKETRIDE_B'], ['ROCKETRIDE_A']);
	assert.equal(d.kind, 'missing');
	assert.deepEqual(d.kind === 'missing' ? d.missingKeys : [], ['ROCKETRIDE_B']);
});

test('a failed key fetch is unverified, not ok', () => {
	const d = decideEnvVars(['ROCKETRIDE_A'], new Error('ECONNREFUSED'));
	assert.equal(d.kind, 'unverified');
	assert.match(d.kind === 'unverified' ? d.reason : '', /ECONNREFUSED/);
});

test('ok and unverified are never the same value', () => {
	// This is the whole bug. checkMissingEnvVars used to return [] for both, and
	// the caller gates the run on that array being empty -- so a transient API
	// failure switched the pre-flight check off and looked exactly like a clean
	// pass. If these two ever compare equal again, the gate has silently
	// collapsed.
	const verified = decideEnvVars(['ROCKETRIDE_A'], ['ROCKETRIDE_A']);
	const couldNotCheck = decideEnvVars(['ROCKETRIDE_A'], new Error('boom'));
	assert.notDeepEqual(verified, couldNotCheck);
	assert.equal(verified.kind, 'ok');
	assert.equal(couldNotCheck.kind, 'unverified');
});

test('a pipeline referencing nothing is ok even when the fetch failed', () => {
	// Nothing to verify, so the outage did not cost anything -- do not warn about
	// a pipeline that uses no variables.
	const d = decideEnvVars([], new Error('ECONNREFUSED'));
	assert.equal(d.kind, 'ok');
});
