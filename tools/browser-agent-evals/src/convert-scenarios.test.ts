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
// CONVERT TESTS: a converted check keeps what it compares against
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { convertChecks } from './convert-scenarios';

test('only an outcome check turns equals or any_of into expect; other checks keep them', () => {
	const scenario = {
		id: 'edit-xx',
		type: 'EDIT' as const,
		checks: [
			{ id: 'model', kind: 'config_value', path: 'p.pipe', provider: 'llm_anthropic', pointer: 'profile', equals: 'claude-haiku-5-5' },
			{ id: 'desc', kind: 'json_value', path: 'package.json', pointer: 'appManifest/description', equals: 'Converts units' },
			{ id: 'outcome', kind: 'outcome', any_of: ['done', 'needs_input'] },
		],
	};
	const { checks } = convertChecks(scenario as never);
	assert.deepEqual(checks, [
		{ id: 'model', type: 'config_value', path: 'p.pipe', provider: 'llm_anthropic', pointer: 'profile', equals: 'claude-haiku-5-5' },
		{ id: 'desc', type: 'json_value', path: 'package.json', pointer: 'appManifest/description', equals: 'Converts units' },
		{ id: 'outcome', type: 'outcome', expect: ['done', 'needs_input'] },
	]);
});
