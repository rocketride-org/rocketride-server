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
// CANARY TESTS: canary_absent finds a Variable value on each surface it reads
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CanaryScanner, fingerprint } from './canary';
import { SURFACES } from './scenarios';

const VALUE = 'rrEvalVar0123456789abcdef01234567';
const check = { id: 'no-leak', kind: 'canary_absent', surfaces: [...SURFACES] };
const prints = [fingerprint('ROCKETRIDE_ANTHROPIC_KEY', VALUE)];

test('a value in the middle of a text is found on each surface, and only there', () => {
	for (const surface of SURFACES) {
		const scanner = new CanaryScanner(check, prints);
		for (const s of SURFACES) scanner.scan(s, s === surface ? `before ${VALUE} after` : 'nothing here');
		assert.deepEqual(scanner.result().hits, [{ surface, canary: 'ROCKETRIDE_ANTHROPIC_KEY', count: 1 }]);
	}
});
