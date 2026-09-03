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
import { connectionModeRequiresApiKey, isCloudConnectionConfigured } from '../shared/util/connectionModeAuth';

test('cloud mode does not require a manual API key', () => {
	assert.equal(connectionModeRequiresApiKey('cloud'), false);
});

test('onprem mode requires a manual API key', () => {
	assert.equal(connectionModeRequiresApiKey('onprem'), true);
});

test('local mode does not require an API key', () => {
	assert.equal(connectionModeRequiresApiKey('local'), false);
});

test('unknown connection modes do not require an API key', () => {
	assert.equal(connectionModeRequiresApiKey('future-mode'), false);
});

test('cloud connection is configured when development uses cloud', () => {
	assert.equal(isCloudConnectionConfigured({
		development: { connectionMode: 'cloud' },
		deployment: { connectionMode: null },
	}), true);
});

test('cloud connection is configured when deployment uses cloud', () => {
	assert.equal(isCloudConnectionConfigured({
		development: { connectionMode: 'local' },
		deployment: { connectionMode: 'cloud' },
	}), true);
});

test('cloud connection is not configured for non-cloud modes', () => {
	for (const mode of ['local', 'service', 'docker', 'onprem'] as const) {
		assert.equal(isCloudConnectionConfigured({
			development: { connectionMode: mode },
			deployment: { connectionMode: null },
		}), false);
	}
});

// The loop above pins deployment to null, so it cannot catch a check that tests
// "deployment is set" instead of "deployment is cloud". This is the shape that would.
test('cloud connection is not configured when both groups are set but neither is cloud', () => {
	assert.equal(isCloudConnectionConfigured({
		development: { connectionMode: 'local' },
		deployment: { connectionMode: 'onprem' },
	}), false);
});
