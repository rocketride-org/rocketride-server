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

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { LAUNCH_PARAMS_STATE_KEY, launchKeysOf, launchSearch } from './launchParams';

test('a launch with params lands on them, beside the query already there', () => {
	assert.deepEqual(launchSearch('?appid=rocketride.home', [], { pipe: 'acme.supportBot' }), {
		search: '?appid=rocketride.home&pipe=acme.supportBot',
		keys: ['pipe'],
	});
	assert.deepEqual(launchSearch('', [], { pipe: 'acme.supportBot' }), { search: '?pipe=acme.supportBot', keys: ['pipe'] });
});

test('the next switch drops the keys the previous one wrote, and only those', () => {
	// An agent launch, then a plain app: the binding does not follow the user
	assert.deepEqual(launchSearch('?rrdev=1&pipe=acme.supportBot', ['pipe']), { search: '?rrdev=1', keys: [] });
	// A second agent: the old binding is replaced, not appended
	assert.deepEqual(launchSearch('?pipe=acme.a', ['pipe'], { pipe: 'acme.b' }), { search: '?pipe=acme.b', keys: ['pipe'] });
	// A deep link's own pipe= was never written by a switch: it stays
	assert.deepEqual(launchSearch('?pipe=acme.linked', []), { search: '?pipe=acme.linked', keys: [] });
});

test('a blank key or a non-string value is not written', () => {
	const params = { '': 'x', pipe: 'acme.a', node: 7 as unknown as string };
	assert.deepEqual(launchSearch('', [], params), { search: '?pipe=acme.a', keys: ['pipe'] });
});

test('the written keys are read back off a history entry, and a foreign state reads as none', () => {
	assert.deepEqual(launchKeysOf({ appId: 'x', [LAUNCH_PARAMS_STATE_KEY]: ['pipe', 3] }), ['pipe']);
	assert.deepEqual(launchKeysOf({ appId: 'x' }), []);
	assert.deepEqual(launchKeysOf(null), []);
	assert.deepEqual(launchKeysOf('state'), []);
});
