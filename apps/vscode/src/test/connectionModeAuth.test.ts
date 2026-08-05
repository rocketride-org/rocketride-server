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
import { connectionModeRequiresApiKey, connectionModeUsesOAuth, connectionModeHasFixedUrl } from '../shared/util/connectionModeAuth';

// Auth per mode was reworked in #678: cloud moved to OAuth2 browser sign-in and
// on-prem became the only mode where the user supplies a key by hand. These two
// cases asserted the pre-#678 semantics and had drifted ever since.
test('cloud mode does not require a manually entered API key — it uses OAuth', () => {
	assert.equal(connectionModeRequiresApiKey('cloud'), false);
	assert.equal(connectionModeUsesOAuth('cloud'), true);
});

test('onprem mode requires a manually entered API key', () => {
	assert.equal(connectionModeRequiresApiKey('onprem'), true);
	assert.equal(connectionModeUsesOAuth('onprem'), false);
});

test('docker and service derive their key from the environment', () => {
	assert.equal(connectionModeRequiresApiKey('docker'), false);
	assert.equal(connectionModeRequiresApiKey('service'), false);
});

test('only onprem lets the user choose the URL', () => {
	assert.equal(connectionModeHasFixedUrl('onprem'), false);
	for (const mode of ['cloud', 'docker', 'service', 'local']) {
		assert.equal(connectionModeHasFixedUrl(mode), true, `${mode} should have a fixed URL`);
	}
});

test('local mode does not require an API key', () => {
	assert.equal(connectionModeRequiresApiKey('local'), false);
});

test('unknown connection modes do not require an API key', () => {
	assert.equal(connectionModeRequiresApiKey('future-mode'), false);
});
