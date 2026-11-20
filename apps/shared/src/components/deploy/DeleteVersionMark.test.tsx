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
 * The version card's delete mark renders ONLY when the server says the
 * version is deletable and the host can delete (plan 2.3; no greyed control,
 * decided 2026-11-16). Both DEPLOY screens draw their mark from this one
 * component, so this is the card rule under test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeleteVersionMark } from './DeleteVersionMark';

const noop = async (): Promise<void> => undefined;

test('a deletable version shows the delete mark, named for assistive tech', () => {
	const markup = renderToStaticMarkup(<DeleteVersionMark version={3} deletable subject="docBrain" onDelete={noop} />);
	assert.match(markup, /aria-label="Delete v3"/);
	assert.match(markup, /title="Delete v3 from the server"/);
	assert.match(markup, /✕/);
	// Confirmation is a separate step: no dialog until the mark is pressed.
	assert.doesNotMatch(markup, /Delete v3 of docBrain\?/);
});

test('a pinned, in-review or building version shows no mark at all', () => {
	assert.equal(renderToStaticMarkup(<DeleteVersionMark version={3} deletable={false} subject="docBrain" onDelete={noop} />), '');
	// An older row source that carries no flag draws no mark either: never a guess.
	assert.equal(renderToStaticMarkup(<DeleteVersionMark version={3} deletable={undefined} subject="docBrain" onDelete={noop} />), '');
});

test('a host that cannot delete shows no mark even for a deletable version', () => {
	assert.equal(renderToStaticMarkup(<DeleteVersionMark version={3} deletable subject="docBrain" onDelete={undefined} />), '');
});

test('the mark is disabled while the screen is busy', () => {
	const markup = renderToStaticMarkup(<DeleteVersionMark version={3} deletable subject="docBrain" onDelete={noop} disabled />);
	assert.match(markup, /aria-label="Delete v3"/);
	assert.match(markup, /disabled=""/);
});
