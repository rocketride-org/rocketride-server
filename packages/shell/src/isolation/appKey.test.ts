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
// APP KEY TESTS — T18
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { appKeyOf } from './appKey';
import { refAppKey } from './__test__/fixtures';

test('T18 appKeyOf matches the shared vector file and separates look-alike ids', () => {
	assert.notEqual(appKeyOf('acme.x_foo'), appKeyOf('acme_x.foo'));
	assert.match(appKeyOf('acme.alpha'), /^a[a-z2-7]{24}$/);
	assert.equal(appKeyOf('acme.alpha'), refAppKey('acme.alpha'));

	const rows = JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', 'appkey_vectors.json'), 'utf8')) as Array<{ id: string; label: string }>;
	assert.ok(rows.length >= 7, 'the vector file must carry the fixed id list');
	for (const row of rows) assert.equal(appKeyOf(row.id), row.label, `appKeyOf(${row.id})`);
});
