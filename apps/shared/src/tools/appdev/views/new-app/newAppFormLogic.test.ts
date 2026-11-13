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


// Unit tests: the New App form's Developer ID row, id shape, and Create gate.
// Run via `shared:test` (node --import tsx --test), matching the package convention.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canCreateApp, canRegisterDeveloperId, developerIdProblem, developerIdRow, isValidDeveloperId } from './NewAppForm';
import type { ICreateState } from './NewAppForm';
import type { NewAppIdentity } from '../../types';

/** An identity snapshot with overrides. */
function identity(over: Partial<NewAppIdentity>): NewAppIdentity {
	return { developerId: 'local', source: 'default', workspaceOpen: true, existingFolders: [], ...over };
}

/** A Create state that would allow Create, with overrides. */
function ready(over: Partial<ICreateState>): ICreateState {
	return { nameValid: true, collision: false, displayName: 'Hello', workspaceOpen: true, creating: false, registering: false, pendingId: false, ...over };
}

test('row: field when the org has no id and the host can register', () => {
	assert.equal(developerIdRow(identity({ canRegisterDeveloper: true }), true), 'field');
});

test('row: chip when the org has an id', () => {
	assert.equal(developerIdRow(identity({ developerId: 'acme', source: 'organization' }), true), 'chip');
});

test('row: chip when the host cannot register', () => {
	assert.equal(developerIdRow(identity({}), false), 'chip');
});

test('row: unconfirmed when the lookup failed', () => {
	assert.equal(developerIdRow(identity({ lookupFailed: true }), true), 'unconfirmed');
	assert.equal(developerIdRow(identity({ lookupFailed: true }), false), 'unconfirmed');
});

test('id shape: lowercase letters and underscores, starting with a letter', () => {
	for (const ok of ['acme', 'acme_labs', 'a']) assert.equal(isValidDeveloperId(ok), true, ok);
	for (const bad of ['Acme', '_acme', 'acme-labs', 'acme1', '', 'ac me']) assert.equal(isValidDeveloperId(bad), false, bad);
});

test('create: blocked while the field holds an unregistered id', () => {
	assert.equal(canCreateApp(ready({ pendingId: true })), false);
});

test('create: allowed once the field is cleared', () => {
	assert.equal(canCreateApp(ready({ pendingId: false })), true);
});

test('create: blocked while a register request is in flight', () => {
	assert.equal(canCreateApp(ready({ registering: true })), false);
});

test('id problem: "local" is reserved', () => {
	assert.match(developerIdProblem('local') ?? '', /reserved/);
	assert.equal(canRegisterDeveloperId('local'), false);
});

test('id problem: a bad shape says what is allowed', () => {
	assert.match(developerIdProblem('Acme') ?? '', /lowercase letters and underscores/);
	assert.equal(canRegisterDeveloperId('Acme'), false);
});

test('id problem: a valid id has none, and an empty field shows none but cannot register', () => {
	assert.equal(developerIdProblem('acme_labs'), null);
	assert.equal(canRegisterDeveloperId('acme_labs'), true);
	assert.equal(developerIdProblem(''), null);
	assert.equal(canRegisterDeveloperId(''), false);
});
