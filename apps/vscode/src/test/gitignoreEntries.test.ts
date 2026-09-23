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
import { appendGitignoreEntries, missingGitignoreEntries } from '../shared/util/gitignoreEntries';

const ENTRIES = ['.rocketride/', '.env'] as const;

test('creates both entries in an empty .gitignore', () => {
	assert.equal(appendGitignoreEntries('', ENTRIES), '.rocketride/\n.env\n');
});

test('appends only the missing entry', () => {
	assert.equal(appendGitignoreEntries('.rocketride/\n', ENTRIES), '.rocketride/\n.env\n');
});

test('returns null when nothing is missing, so the caller can skip the write', () => {
	assert.equal(appendGitignoreEntries('.rocketride/\n.env\n', ENTRIES), null);
});

test('preserves existing user content and trailing-newline shape', () => {
	const existing = '# my project\nnode_modules/\ndist/\n';
	assert.equal(appendGitignoreEntries(existing, ENTRIES), `${existing}.rocketride/\n.env\n`);
});

test('tolerates a missing trailing newline', () => {
	assert.equal(appendGitignoreEntries('node_modules/', ENTRIES), 'node_modules/\n.rocketride/\n.env\n');
});

test('whitespace-only content does not gain a leading blank line', () => {
	// Regression: trimming the content but testing the UNtrimmed string for the
	// separator emitted a leading newline here.
	assert.equal(appendGitignoreEntries('   ', ENTRIES), '   \n.rocketride/\n.env\n');
});

test("preserves the user's trailing blank lines verbatim", () => {
	// A hand-edited .gitignore is the user's file. Adding one entry must not
	// silently reformat the rest of it.
	const existing = 'node_modules/\n\n\n';
	assert.equal(appendGitignoreEntries(existing, ENTRIES), `${existing}.rocketride/\n.env\n`);
});

test('matches entries despite surrounding whitespace', () => {
	assert.deepEqual(missingGitignoreEntries('  .env  \n', ENTRIES), ['.rocketride/']);
});

test('does not treat .env.example as covering .env', () => {
	// .env.example is meant to be COMMITTED, so it must never be mistaken for
	// the ignore rule that protects the real key.
	assert.deepEqual(missingGitignoreEntries('.env.example\n', ['.env']), ['.env']);
});

test('a broader user pattern is not rewritten, only supplemented', () => {
	// Strict line matching means `*.env` does not suppress our `.env` entry.
	// The redundant line is harmless; silently trusting a pattern we did not
	// write would be worse.
	assert.deepEqual(missingGitignoreEntries('*.env\n', ['.env']), ['.env']);
});
