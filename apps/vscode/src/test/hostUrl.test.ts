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
import { isValidHostUrl } from '../shared/util/hostUrl';

test('empty, missing and whitespace-only input is rejected', () => {
	assert.equal(isValidHostUrl(''), false);
	assert.equal(isValidHostUrl('   '), false);
	assert.equal(isValidHostUrl(undefined), false);
	assert.equal(isValidHostUrl(null), false);
});

test('bare hosts are accepted — normalizeUri supplies scheme and port', () => {
	assert.equal(isValidHostUrl('localhost'), true);
	assert.equal(isValidHostUrl('localhost:5565'), true);
	assert.equal(isValidHostUrl('my-server:5565'), true);
	assert.equal(isValidHostUrl('192.168.1.10:5565'), true);
});

test('explicit http and https URLs are accepted', () => {
	assert.equal(isValidHostUrl('http://localhost:5565'), true);
	assert.equal(isValidHostUrl('https://engine.example.com'), true);
	assert.equal(isValidHostUrl('https://engine.example.com/'), true);
});

test('surrounding whitespace is tolerated', () => {
	assert.equal(isValidHostUrl('  https://engine.example.com  '), true);
});

test('a scheme with no host is rejected', () => {
	assert.equal(isValidHostUrl('http://'), false);
	assert.equal(isValidHostUrl('https://'), false);
});

test('non-HTTP schemes are rejected', () => {
	assert.equal(isValidHostUrl('ftp://engine.example.com'), false);
	assert.equal(isValidHostUrl('file:///etc/passwd'), false);
	assert.equal(isValidHostUrl('javascript://alert(1)'), false);
});

test('input that cannot address a host is rejected', () => {
	assert.equal(isValidHostUrl('not a host'), false);
	assert.equal(isValidHostUrl('http://a b c'), false);
});

test('a single-label host is accepted — it is indistinguishable from localhost', () => {
	// Documented limitation: format validation cannot tell a typo'd hostname
	// from a real one. Reachability is Test Connection's job.
	assert.equal(isValidHostUrl('asdf'), true);
});
