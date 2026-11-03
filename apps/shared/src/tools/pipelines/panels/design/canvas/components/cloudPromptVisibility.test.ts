// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldShowCloudPrompt, type CloudPromptVisibilityInput } from './cloudPromptVisibility';

const visibleBaseline: CloudPromptVisibilityInput = {
	isConnected: true,
	isReadonly: false,
	isLocked: false,
	isFlowReady: true,
	nodeCount: 1,
	hasCloudSetupHandler: true,
	hasDismissHandler: true,
	hasDismissForeverHandler: true,
	cloudConnectionConfigured: false,
	cloudPromptDismissed: false,
};

test('shows the Cloud canvas prompt when every visibility requirement is met', () => {
	assert.equal(shouldShowCloudPrompt(visibleBaseline), true);
});

test('hides the Cloud canvas prompt when disconnected', () => {
	assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, isConnected: false }), false);
});

test('hides the Cloud canvas prompt when the canvas is readonly', () => {
	assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, isReadonly: true }), false);
});

test('hides the Cloud canvas prompt when the canvas is locked', () => {
	assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, isLocked: true }), false);
});

test('hides the Cloud canvas prompt on an empty canvas to avoid onboarding collisions', () => {
	assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, nodeCount: 0 }), false);
});

test('hides the Cloud canvas prompt before the flow is ready', () => {
	assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, isFlowReady: false }), false);
});

test('hides the Cloud canvas prompt when the Cloud connection is configured', () => {
	assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, cloudConnectionConfigured: true }), false);
});

// `cloudPromptDismissed` collapses both dismissal kinds: ProjectView ORs the
// per-session flag with the persisted `cloudCanvasPromptDismissed` preference.
// Which kind set it is decided there, not here.
test('hides the Cloud canvas prompt once dismissed', () => {
	assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, cloudPromptDismissed: true }), false);
});

test('hides the Cloud canvas prompt when any required handler is absent', () => {
	for (const missingHandler of [
		{ hasCloudSetupHandler: false },
		{ hasDismissHandler: false },
		{ hasDismissForeverHandler: false },
	]) {
		assert.equal(shouldShowCloudPrompt({ ...visibleBaseline, ...missingHandler }), false);
	}
});
