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
// ALIAS TESTS — T105 (knownProjects, short ids, project-keyed maps and the N1-L flood case)
// =============================================================================

/// <reference types="node" />


// =============================================================================
// THE TRANSCRIPT ORACLE'S OWN CONTROLS — assertNoReal must fail where a realm saw a real value
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoReal } from './__test__/n1';
import type { IFakeCm } from './__test__/fakeCm';

const SESSION = 'session-token-0123456789';

function fakeCm(userId = 'user-aaaaaaaaaaaa'): IFakeCm {
	return { engine: { runs: [], userId }, sessionToken: SESSION, apiKey: 'api-key-0123456789' } as unknown as IFakeCm;
}

const leaks = (message: unknown, cm = fakeCm(), from = 0): boolean => {
	try {
		assertNoReal({ received: [message] }, cm, [], from);
		return false;
	} catch {
		return true;
	}
};

test('oracle: a clean message passes (control)', () => {
	assert.equal(leaks({ body: { text: 'nothing here', list: [1, 2] } }), false);
});

test('oracle: a Map or Set carrying a real value fails the transcript', () => {
	assert.equal(leaks({ body: new Map([['credential', SESSION]]) }), true);
	assert.equal(leaks({ body: new Map([[SESSION, 'x']]) }), true);
	assert.equal(leaks({ body: new Set([SESSION]) }), true);
	assert.equal(leaks({ body: new Map([['teamId', 'x']]) }), true, 'a forbidden Map key');
	assert.equal(leaks({ body: new Map([['credential', 'fine']]) }), false, 'control');
});

test('oracle: other members of a binary-marker object are inspected', () => {
	assert.equal(leaks({ body: { __rrbin: true, b64: 'aGVsbG8=', extra: SESSION } }), true);
	assert.equal(leaks({ body: { __rrbin: true, b64: Buffer.from(SESSION).toString('base64') } }), true, 'the decoded bytes still count');
	assert.equal(leaks({ body: { __rrbin: true, b64: 'aGVsbG8=', extra: 'fine' } }), false, 'control');
});

test('oracle: a value that was real earlier stays forbidden after it changes', () => {
	const cm = fakeCm('user-aaaaaaaaaaaa');
	const early = { body: 'hello user-aaaaaaaaaaaa' };
	assert.equal(leaks(early, cm), true, 'real at the time');
	const rotated = fakeCm('user-bbbbbbbbbbbb');
	assertNoReal({ received: [{ body: 'fine' }] }, rotated); // remembers user-bbbbbbbbbbbb
	(rotated.engine as unknown as { userId: string }).userId = 'user-cccccccccccc';
	assert.equal(leaks(early, rotated), false, 'a message without the remembered values is clean');
	assert.equal(leaks({ body: 'user-bbbbbbbbbbbb' }, rotated), true, 'the replaced user id is still checked');
});
