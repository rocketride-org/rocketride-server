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


// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

// `withoutCredentials` is the one projection of the signed-in user that app
// code and iframes may receive: the session token (`userToken`) never leaves
// the shell (#1022).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutCredentials } from './identity';

// ---- the projection -----------------------------------------------------

test('withoutCredentials drops userToken and keeps every other field', () => {
	const user = { userId: 'u1', userName: 'Ada', email: 'ada@example.com', userToken: 'secret', organizations: [{ id: 'o1' }] };
	const safe = withoutCredentials(user);
	assert.ok(safe);
	assert.equal('userToken' in safe, false);
	assert.deepEqual(safe, { userId: 'u1', userName: 'Ada', email: 'ada@example.com', organizations: [{ id: 'o1' }] });
});

test('withoutCredentials never mutates the stored user and returns a new object', () => {
	const user = { userId: 'u1', userToken: 'secret' };
	const safe = withoutCredentials(user);
	assert.notEqual(safe, user);
	assert.equal(user.userToken, 'secret');
});

test('withoutCredentials passes null through and tolerates a user without a token', () => {
	assert.equal(withoutCredentials(null), null);
	assert.deepEqual(withoutCredentials({ userId: 'u1' }), { userId: 'u1' });
});
