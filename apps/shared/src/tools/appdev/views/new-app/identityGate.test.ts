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


// Unit tests: the wizard ignores an identity older than the one it shows.
// Run via `shared:test` (node --import tsx --test), matching the package convention.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isNewerIdentity } from './NewAppWizard';
import type { NewAppIdentity } from '../../types';

/** An identity at a revision. */
function at(revision: number | undefined, over: Partial<NewAppIdentity> = {}): NewAppIdentity {
	return { developerId: 'local', source: 'default', workspaceOpen: true, existingFolders: [], revision, ...over };
}

test('identity gate: a pushed identity is not overwritten by the initial pull', () => {
	const pushed = at(2, { developerId: 'acme', source: 'organization' }); // a claim from another wizard
	const slowPull = at(1, { canRegisterDeveloper: true }); // started earlier, landed later
	assert.equal(isNewerIdentity(pushed, slowPull), false);
});

test('identity gate: a newer identity replaces the shown one', () => {
	assert.equal(isNewerIdentity(at(1), at(2)), true);
});

test('identity gate: the first identity always applies', () => {
	assert.equal(isNewerIdentity(null, at(1)), true);
});

test('identity gate: hosts without revisions behave as before', () => {
	assert.equal(isNewerIdentity(at(undefined), at(undefined)), true);
	assert.equal(isNewerIdentity(at(5), at(undefined)), true);
});
