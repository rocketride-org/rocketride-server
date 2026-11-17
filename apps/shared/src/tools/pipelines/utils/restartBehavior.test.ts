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

/** The restart-behavior setting as the server's onChange (plan §3.4). */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onChangeArgs, onChangeOf } from './restartBehavior';

test('auto repoints, manual keeps, prompt and anything else leave the server default', () => {
	assert.equal(onChangeOf('auto'), 'auto');
	assert.equal(onChangeOf('manual'), 'keep');
	assert.equal(onChangeOf('prompt'), undefined);
	assert.equal(onChangeOf(undefined), undefined);
	assert.equal(onChangeOf('bogus'), undefined);
});

test('the spread form carries onChange only when the setting names one', () => {
	assert.deepEqual(onChangeArgs('auto'), { onChange: 'auto' });
	assert.deepEqual(onChangeArgs('manual'), { onChange: 'keep' });
	assert.deepEqual(onChangeArgs('prompt'), {});
	assert.equal('onChange' in onChangeArgs(undefined), false);
});
