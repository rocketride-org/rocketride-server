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


// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_START_STAMP_KEY, generatePkce, getStoredVerifier } from './pkce';
import { resetDevGateForTests } from './devGate';

/** Stage a window and a sessionStorage over a Map for one test; the dev gate recomputes from the staged window. */
async function staged(win: Record<string, unknown>, run: (data: Map<string, string>) => Promise<void>, setItemThrowsFor?: string): Promise<void> {
	const data = new Map<string, string>();
	const storage = {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => {
			if (k === setItemThrowsFor) throw new Error('quota');
			data.set(k, v);
		},
		removeItem: (k: string) => { data.delete(k); },
	};
	const originals = ['window', 'sessionStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
	Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
	resetDevGateForTests();
	try {
		await run(data);
	} finally {
		resetDevGateForTests();
		for (const [key, original] of originals) {
			if (original) Object.defineProperty(globalThis, key, original);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
}

/** A top-level tab: self and top are the same window. */
function tab(): Record<string, unknown> {
	const win: Record<string, unknown> = { location: { search: '', pathname: '/' } };
	win.self = win;
	win.top = win;
	return win;
}

test('generatePkce stores the verifier and stamps the moment its redirect starts', async () => {
	await staged(tab(), async (data) => {
		const before = Date.now();
		const { verifier, challenge } = await generatePkce();
		assert.equal(getStoredVerifier(), verifier);
		assert.ok(challenge.length > 0 && challenge !== verifier);
		const stamp = Number(data.get(AUTH_START_STAMP_KEY));
		assert.ok(stamp >= before && stamp <= Date.now(), 'the stamp is this redirect\'s start');
	});
});

test('an embedded dev preview never writes the round-trip stamp (same-origin frames share sessionStorage)', async () => {
	await staged({ self: {}, top: {}, location: { search: '?rrdev=1', pathname: '/' } }, async (data) => {
		await generatePkce();
		assert.equal(data.has(AUTH_START_STAMP_KEY), false);
	});
});

test('a stamp that cannot be stored does not stop the redirect', async () => {
	await staged(tab(), async (data) => {
		const { verifier } = await generatePkce();
		assert.equal(data.get('rr:pkce_verifier'), verifier, 'the verifier is still stored');
		assert.equal(data.has(AUTH_START_STAMP_KEY), false);
	}, AUTH_START_STAMP_KEY);
});
