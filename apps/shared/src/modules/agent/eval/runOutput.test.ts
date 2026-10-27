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
// RUN OUTPUT TESTS — run_output's expectations on what a pipeline returned
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expectationFailures } from './runOutput';

test('a sentence limit fails when the pipeline gave no answer, and holds for a short one', () => {
	const expect = { answers_max_sentences: 3 };
	assert.deepEqual(expectationFailures(expect, { answers: [], text: [] }, 26), ['no answer, wanted one with at most 3 sentences']);
	assert.deepEqual(expectationFailures(expect, { answers: ['A webhook is a callback. It posts to a URL.'], text: [] }, 26), []);
	assert.deepEqual(expectationFailures(expect, { answers: ['One. Two. Three. Four.'], text: [] }, 26), ['an answer has 4 sentences, wanted at most 3']);
});

test('the summary length counts each output once', () => {
	const expect = { nonempty: true, shorter_than_input: true };
	assert.deepEqual(expectationFailures(expect, { answers: ['abcdef'], text: [] }, 10), []);
	assert.deepEqual(expectationFailures(expect, { answers: [], text: ['abcdef'] }, 10), []);
	assert.deepEqual(expectationFailures(expect, { answers: ['abcdef'], text: ['ghij'] }, 10), ['the output (11 characters) is not shorter than the input (10)']);
	assert.deepEqual(expectationFailures(expect, { answers: [], text: [] }, 10), ['the output is empty', 'the output (0 characters) is not shorter than the input (10)']);
});
