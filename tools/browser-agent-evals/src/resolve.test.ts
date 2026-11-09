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
// RESOLVE TESTS: a check's path when the file has another name
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePath } from './resolve';

const pipe = (id: string) => JSON.stringify({ project_id: id, components: [] });

test('an exact match is used as it is', () => {
	const r = resolvePath('pipelines/a.pipe', {}, { 'pipelines/a.pipe': pipe('p1') });
	assert.deepEqual([r.path, r.substituted], ['pipelines/a.pipe', false]);
});

test('one added file of the same kind stands in for a renamed one', () => {
	const r = resolvePath('pipelines/support-chat.pipe', {}, { 'pipelines/support_chat.pipe': pipe('p1'), 'apps/x/a.pipe': pipe('p2') });
	assert.deepEqual([r.path, r.substituted], ['pipelines/support_chat.pipe', true]);
});

test('two candidates leave the path as it was, and say which', () => {
	const r = resolvePath('pipelines/support-chat.pipe', {}, { 'pipelines/one.pipe': pipe('p1'), 'pipelines/two.pipe': pipe('p2') });
	assert.deepEqual([r.path, r.substituted], ['pipelines/support-chat.pipe', false]);
	assert.match(r.why, /2 added files could be it: pipelines\/one.pipe, pipelines\/two.pipe/);
});

test('no candidate leaves the path as it was', () => {
	const r = resolvePath('pipelines/support-chat.pipe', { 'pipelines/old.pipe': pipe('p0') }, { 'pipelines/old.pipe': pipe('p0'), 'apps/x/README.md': 'x' });
	assert.deepEqual([r.path, r.substituted], ['pipelines/support-chat.pipe', false]);
	assert.match(r.why, /no added file could be it/);
});

test('a renamed pipeline the task started with must keep its project_id', () => {
	const start = { 'pipelines/support-chat.pipe': pipe('support-chat') };
	const kept = resolvePath('pipelines/support-chat.pipe', start, { 'pipelines/help-chat.pipe': pipe('support-chat'), 'pipelines/other.pipe': pipe('other') });
	assert.deepEqual([kept.path, kept.substituted], ['pipelines/help-chat.pipe', true]);
	const lost = resolvePath('pipelines/support-chat.pipe', start, { 'pipelines/help-chat.pipe': pipe('new-id') });
	assert.equal(lost.substituted, false);
});
