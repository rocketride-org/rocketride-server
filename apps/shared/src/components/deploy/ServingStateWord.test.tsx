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

/**
 * The where-live row's state word both DEPLOY screens draw: a row means
 * serving, so a serving row says nothing and only a reason it does not
 * serve is drawn.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ServingStateWord } from './ServingStateWord';

test('a serving row says nothing', () => {
	assert.equal(renderToStaticMarkup(<ServingStateWord status={{ word: 'serving', tone: 'ok' }} />), '');
});

test('a row that does not serve says why', () => {
	for (const status of [
		{ word: 'disabled', tone: 'muted' as const },
		{ word: 'errored', tone: 'error' as const },
		{ word: 'in review', tone: 'warn' as const },
	]) {
		assert.match(renderToStaticMarkup(<ServingStateWord status={status} />), new RegExp(`>● ${status.word}</span>$`));
	}
});
