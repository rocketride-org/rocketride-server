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


// Unit tests: the New App form's footer note (an if / else-if chain).
// Run via `shared:test` (node --import tsx --test), matching the package convention.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { footerNote } from './NewAppForm';

test('footer note: no workspace uses the host phrasing, then the default', () => {
	assert.equal(footerNote({ workspaceOpen: false, noWorkspaceNote: 'Connect first.', canRegister: true, lookupFailed: false, source: 'default' }), 'Connect first.');
	assert.match(footerNote({ workspaceOpen: false, canRegister: false, lookupFailed: false, source: 'organization' }), /Open a workspace folder first/);
});

test('footer note: can register points at the field, and at the Deploy tab for later', () => {
	const note = footerNote({ workspaceOpen: true, canRegister: true, lookupFailed: false, source: 'default' });
	assert.match(note, /claim one above/);
	assert.match(note, /Deploy tab/);
});

test('footer note: no id and no field points at the Deploy tab', () => {
	const note = footerNote({ workspaceOpen: true, canRegister: false, lookupFailed: false, source: 'default' });
	assert.match(note, /claim one on the Deploy tab/);
	assert.doesNotMatch(note, /above/);
});

test('footer note: an organization id is attached at deploy', () => {
	assert.match(footerNote({ workspaceOpen: true, canRegister: false, lookupFailed: false, source: 'organization' }), /attached at deploy/);
});

test('footer note: a failed lookup says the id could not be confirmed, and that the app can still be created', () => {
	const note = footerNote({ workspaceOpen: true, canRegister: false, lookupFailed: true, source: 'default' });
	assert.match(note, /Could not confirm your organization's developer id/);
	assert.match(note, /can still be created/);
});

test('footer note: every note says the files carry the slug, and none names a default id', () => {
	for (const canRegister of [true, false]) {
		for (const lookupFailed of [true, false]) {
			for (const source of ['default', 'organization'] as const) {
				const note = footerNote({ workspaceOpen: true, canRegister, lookupFailed, source });
				assert.match(note, /files carry the app slug only/, note);
				assert.doesNotMatch(note, /local/, note);
			}
		}
	}
});
