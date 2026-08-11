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
// VIEWER REGISTRY — unit tests for viewer compatibility + defaults
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FileCategory } from '../src/mediaTypes';
import { getCompatibleViewers, getDefaultViewer, VIEWER_LABELS } from '../src/viewerRegistry';

const ALL_CATEGORIES: FileCategory[] = [
	'text', 'code', 'json', 'markdown', 'image', 'video', 'audio', 'pdf', 'docx', 'spreadsheet', 'binary',
];

describe('viewerRegistry', () => {
	it('picks the default viewer as the first compatible one', () => {
		assert.equal(getDefaultViewer('markdown'), 'markdown');
		assert.equal(getDefaultViewer('json'), 'monaco'); // code editor by default; JSON tree is opt-in
		assert.equal(getDefaultViewer('image'), 'image');
		assert.equal(getDefaultViewer('binary'), 'hex');
	});

	it('lists compatible viewers with the default first', () => {
		assert.deepEqual(getCompatibleViewers('code'), ['monaco', 'text', 'hex']);
		assert.equal(getCompatibleViewers('json')[0], getDefaultViewer('json'));
		assert.ok(getCompatibleViewers('json').includes('json')); // the JSON tree is offered as an alternate
	});

	it('offers the hex viewer as a universal fallback', () => {
		for (const category of ALL_CATEGORIES) {
			assert.ok(getCompatibleViewers(category).includes('hex'), `${category} should allow the hex viewer`);
		}
	});

	it('gives every offered viewer a display label', () => {
		for (const category of ALL_CATEGORIES) {
			for (const viewerId of getCompatibleViewers(category)) {
				assert.ok(VIEWER_LABELS[viewerId], `missing label for viewer "${viewerId}"`);
			}
		}
	});
});
