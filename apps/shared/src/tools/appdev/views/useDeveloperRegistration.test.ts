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


// Unit tests: the shared register form's state transitions and claim flow.
// Run via `shared:test` (node --import tsx --test), matching the package convention.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { developerRegistrationReducer as reduce, INITIAL_DEVELOPER_REGISTRATION as idle, runDeveloperRegistration } from './useDeveloperRegistration';
import type { DeveloperRegistrationAction, IDeveloperRegistrationState } from './useDeveloperRegistration';

/** Runs one claim and folds its dispatched actions over `start`. */
async function claim<T>(start: IDeveloperRegistrationState, register: (id: string) => Promise<T>, isValid?: (slug: string) => boolean) {
	const actions: DeveloperRegistrationAction[] = [];
	const outcome = await runDeveloperRegistration(start.slug, register, (a) => actions.push(a), isValid);
	return { outcome, actions, state: actions.reduce(reduce, start) };
}

test('registration: editing the id clears the error', () => {
	const failed = { slug: 'taken', busy: false, error: 'slug taken' };
	assert.deepEqual(reduce(failed, { type: 'edit', slug: 'taken_2' }), { slug: 'taken_2', busy: false, error: '' });
});

test('registration: start marks busy and clears the error', () => {
	assert.deepEqual(reduce({ slug: 'acme', busy: false, error: 'old' }, { type: 'start' }), { slug: 'acme', busy: true, error: '' });
});

test('registration: success clears the id and returns the result', async () => {
	const seen: string[] = [];
	const { outcome, state } = await claim({ ...idle, slug: '  acme_labs ' }, async (id) => (seen.push(id), 'acme_labs'));
	assert.deepEqual(seen, ['acme_labs']);
	assert.deepEqual(outcome, { ok: true, result: 'acme_labs' });
	assert.deepEqual(state, idle);
});

test('registration: a refused claim keeps the id and shows the server message', async () => {
	const { outcome, state } = await claim({ ...idle, slug: 'acme' }, async () => {
		throw new Error('slug taken');
	});
	assert.deepEqual(outcome, { ok: false });
	assert.deepEqual(state, { slug: 'acme', busy: false, error: 'slug taken' });
});

test('registration: an empty or invalid id is skipped without calling the server', async () => {
	let calls = 0;
	const register = async (): Promise<void> => void calls++;
	assert.deepEqual((await claim({ ...idle, slug: '   ' }, register)).actions, []);
	assert.deepEqual((await claim({ ...idle, slug: 'Bad' }, register, (s) => /^[a-z][a-z_]*$/.test(s))).actions, []);
	assert.equal(calls, 0);
});
