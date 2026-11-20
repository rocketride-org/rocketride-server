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

// =============================================================================
// ALIAS TESTS — T105 (knownProjects, short ids, project-keyed maps and the N1-L flood case)
// =============================================================================

/// <reference types="node" />


// =============================================================================
// WALK — the binary member is recognised by its own keys only
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { isWireBinary } from './walk';

test('isWireBinary accepts exactly the two own members, never ones read through the prototype', () => {
	assert.equal(isWireBinary({ __rrbin: true, b64: 'aGVsbG8=' }), true);
	assert.equal(isWireBinary(Object.assign(Object.create(null), { __rrbin: true, b64: 'aGVsbG8=' })), true, 'a null-prototype object with the own members');
	const inherited = Object.assign(Object.create({ __rrbin: true, b64: 'aGVsbG8=' }), { x: 1, y: 2 });
	assert.equal(isWireBinary(inherited), false, 'two other own keys, the binary members supplied by the prototype');
	assert.equal(isWireBinary({ __rrbin: true, b64: 'aGVsbG8=', extra: 1 }), false, 'a third key');
	assert.equal(isWireBinary({ __rrbin: true }), false);
	assert.equal(isWireBinary([]), false);
	assert.equal(isWireBinary(null), false);
});
