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
import { isShadowedByWorkspace } from '../shared/util/workspaceOverride';

test('no inspection result is not shadowed', () => {
	assert.equal(isShadowedByWorkspace(undefined, 'local'), false);
});

test('no workspace-level value is not shadowed', () => {
	assert.equal(isShadowedByWorkspace({}, 'onprem'), false);
});

test('a conflicting workspace value is shadowed (the RR-1257 case)', () => {
	// User saves 'onprem' but the workspace pins 'local' → the Global write is masked.
	assert.equal(isShadowedByWorkspace({ workspaceValue: 'local' }, 'onprem'), true);
});

test('a matching workspace value is not flagged', () => {
	// Override already equals what we are saving → no visible conflict.
	assert.equal(isShadowedByWorkspace({ workspaceValue: 'onprem' }, 'onprem'), false);
});

test('workspaceFolder value takes precedence over workspace value', () => {
	assert.equal(isShadowedByWorkspace({ workspaceValue: 'onprem', workspaceFolderValue: 'local' }, 'onprem'), true);
	assert.equal(isShadowedByWorkspace({ workspaceValue: 'local', workspaceFolderValue: 'onprem' }, 'onprem'), false);
});

test('equal array values (e.g. engineArgs) are not flagged', () => {
	assert.equal(isShadowedByWorkspace({ workspaceValue: ['--a', '--b'] }, ['--a', '--b']), false);
});

test('differing array values are shadowed', () => {
	assert.equal(isShadowedByWorkspace({ workspaceValue: ['--a'] }, ['--a', '--b']), true);
});

test('boolean and falsy overrides are handled by value, not truthiness', () => {
	// A workspace value of `false` differing from desired `true` must be flagged,
	// not skipped as "absent".
	assert.equal(isShadowedByWorkspace({ workspaceValue: false }, true), true);
	assert.equal(isShadowedByWorkspace({ workspaceValue: false }, false), false);
});
