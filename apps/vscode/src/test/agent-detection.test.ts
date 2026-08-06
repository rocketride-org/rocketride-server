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
import { detectAgentNames, mergeSelectedAgents, type DetectionInput } from '../agents/detection';

function input(overrides: Partial<DetectionInput> = {}): DetectionInput {
	return { appName: 'Visual Studio Code', hasClaudeExtension: false, hasClaudeCli: false, ...overrides };
}

test('Cursor app detects the Cursor agent', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Cursor' })), ['Cursor']);
});

test('Windsurf app detects the Windsurf agent', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Windsurf' })), ['Windsurf']);
});

test('standard VS Code detects Copilot', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Visual Studio Code' })), ['Copilot']);
});

test('Claude Code extension presence adds Claude Code', () => {
	const names = detectAgentNames(input({ appName: 'Visual Studio Code', hasClaudeExtension: true }));
	assert.deepEqual(names, ['Copilot', 'Claude Code']);
});

test('Claude CLI presence adds Claude Code when extension absent', () => {
	const names = detectAgentNames(input({ appName: 'Cursor', hasClaudeExtension: false, hasClaudeCli: true }));
	assert.deepEqual(names, ['Cursor', 'Claude Code']);
});

test('Claude Code is not added twice when both extension and CLI present', () => {
	const names = detectAgentNames(input({ appName: 'Cursor', hasClaudeExtension: true, hasClaudeCli: true }));
	assert.deepEqual(names, ['Cursor', 'Claude Code']);
});

test('"code" appName (VSCodium / code-oss) detects Copilot', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Code' })), ['Copilot']);
});

test('unrecognized appName returns empty when no Claude signals', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Theia' })), []);
});

test('mergeSelectedAgents unions detected and settings-checked, de-duplicated, order-stable', () => {
	const merged = mergeSelectedAgents(['Copilot', 'Claude Code'], ['Cursor', 'Copilot']);
	assert.deepEqual(merged, ['Copilot', 'Claude Code', 'Cursor']);
});

test('mergeSelectedAgents with empty inputs returns empty', () => {
	assert.deepEqual(mergeSelectedAgents([], []), []);
});
