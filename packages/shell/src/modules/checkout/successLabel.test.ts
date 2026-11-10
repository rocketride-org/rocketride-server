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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantSuccessLabel, PIPE_BUILDER_APP_ID } from './successLabel';

test('the button after a redeemed code names the app', () => {
	assert.equal(grantSuccessLabel('Judge Hack'), 'Continue to Judge Hack');
	assert.equal(grantSuccessLabel('Judge Hack', 'judgehack.app'), 'Continue to Judge Hack');
});

test('the pipeline builder keeps Start building', () => {
	assert.equal(PIPE_BUILDER_APP_ID, 'rocketride.pipeBuilder');
	assert.equal(grantSuccessLabel('Rocket Builder', PIPE_BUILDER_APP_ID), 'Start building');
	// Only the id decides: a store app named like the builder is still a store app.
	assert.equal(grantSuccessLabel('Rocket Builder', 'acme.builder'), 'Continue to Rocket Builder');
});

test('surrounding whitespace in the app name is trimmed', () => {
	assert.equal(grantSuccessLabel('  Converge  '), 'Continue to Converge');
});

test('a blank or missing app name falls back to a plain Continue', () => {
	assert.equal(grantSuccessLabel(''), 'Continue');
	assert.equal(grantSuccessLabel('   '), 'Continue');
	assert.equal(grantSuccessLabel(undefined), 'Continue');
});
