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

// The embedded sign-in popup ('rrauth') must still know its role when the IdP
// redirects it back. Shell documents now send COOP same-origin-allow-popups
// (#1022): a popup whose opener sits in a cross-origin top-level page moves to
// a new browsing context group, which clears window.name, and the IdP round
// trip drops ?rrauth=1. The role is therefore kept in sessionStorage, which
// survives both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AUTH_POPUP_KEY, forgetAuthPopup, isAuthPopupWindow, rememberAuthPopup } from './authPopup';

/** A minimal in-memory Storage. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}

/** A Storage whose every call throws (sandboxed frame, storage disabled). */
const brokenStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
	getItem: () => {
		throw new Error('denied');
	},
	setItem: () => {
		throw new Error('denied');
	},
	removeItem: () => {
		throw new Error('denied');
	},
};

const RETURN = new URLSearchParams('code=abc&state=xyz');
const T0 = 1_700_000_000_000;
const THIRTY_MIN = 30 * 60 * 1000;

/** Environment of a top-level popup tab at time `now`. */
function top(storage: ReturnType<typeof memoryStorage> | typeof brokenStorage | null, now = T0) {
	return { storage, topLevel: true, now };
}

test('a fresh popup is recognised by its window name or the ?rrauth=1 marker', () => {
	const storage = memoryStorage();
	assert.equal(isAuthPopupWindow('rrauth', new URLSearchParams(''), top(storage)), true);
	assert.equal(isAuthPopupWindow('', new URLSearchParams('rrauth=1'), top(storage)), true);
	assert.equal(isAuthPopupWindow('', new URLSearchParams(''), top(storage)), false);
	assert.equal(isAuthPopupWindow('other', new URLSearchParams('rrauth=0'), top(storage)), false);
});

test('the role survives the IdP return leg (code, error or state) and the marker is consumed', () => {
	for (const back of ['code=abc&state=xyz', 'error=access_denied', 'state=xyz']) {
		const storage = memoryStorage();
		rememberAuthPopup(top(storage));
		assert.equal(storage.data.get(AUTH_POPUP_KEY), String(T0), 'the marker holds its timestamp');
		assert.equal(isAuthPopupWindow('', new URLSearchParams(back), top(storage, T0 + 1000)), true, back);
		assert.equal(storage.data.has(AUTH_POPUP_KEY), false, `marker removed once read (${back})`);
		assert.equal(isAuthPopupWindow('', new URLSearchParams(back), top(storage, T0 + 2000)), false, `single use (${back})`);
	}
});

test('a slow sign-in (email verification, MFA) keeps the role for up to 30 minutes', () => {
	const storage = memoryStorage();
	rememberAuthPopup(top(storage));
	assert.equal(isAuthPopupWindow('', RETURN, top(storage, T0 + 25 * 60 * 1000)), true, '25 minutes');
	rememberAuthPopup(top(storage));
	assert.equal(isAuthPopupWindow('', RETURN, top(storage, T0 + THIRTY_MIN)), true, 'exactly 30 minutes');
});

test('the marker is ignored, and removed, outside the IdP return leg', () => {
	const storage = memoryStorage();
	rememberAuthPopup(top(storage));
	assert.equal(isAuthPopupWindow('', new URLSearchParams(''), top(storage)), false);
	assert.equal(isAuthPopupWindow('', new URLSearchParams('appid=x'), top(storage)), false);
	assert.equal(storage.data.has(AUTH_POPUP_KEY), true, 'not read without a return-leg parameter');
	assert.equal(isAuthPopupWindow('', RETURN, top(storage, T0 + THIRTY_MIN + 1)), false, 'older than 30 minutes');
	assert.equal(storage.data.has(AUTH_POPUP_KEY), false, 'a stale marker is removed when read');
});

test('a marker from the future or with garbage content is ignored and removed', () => {
	for (const value of [String(T0 + 60_000), 'garbage', '1', '']) {
		const storage = memoryStorage();
		storage.data.set(AUTH_POPUP_KEY, value);
		assert.equal(isAuthPopupWindow('', RETURN, top(storage)), false, JSON.stringify(value));
		assert.equal(storage.data.has(AUTH_POPUP_KEY), false, JSON.stringify(value));
	}
});

test('a framed window neither sets nor honours the marker', () => {
	const storage = memoryStorage();
	rememberAuthPopup({ storage, topLevel: false, now: T0 });
	assert.equal(storage.data.has(AUTH_POPUP_KEY), false, 'not set when framed');
	storage.data.set(AUTH_POPUP_KEY, String(T0));
	assert.equal(isAuthPopupWindow('', RETURN, { storage, topLevel: false, now: T0 }), false, 'not honoured when framed');
	assert.equal(storage.data.get(AUTH_POPUP_KEY), String(T0), 'a framed window leaves the top-level marker alone');
});

test('unavailable storage never throws and falls back to name and marker', () => {
	assert.doesNotThrow(() => rememberAuthPopup(top(brokenStorage)));
	assert.doesNotThrow(() => forgetAuthPopup(brokenStorage));
	assert.equal(isAuthPopupWindow('', RETURN, top(brokenStorage)), false);
	assert.equal(isAuthPopupWindow('rrauth', new URLSearchParams(''), top(brokenStorage)), true);
	assert.equal(isAuthPopupWindow('', RETURN, top(null)), false);
});

test('Shell.tsx remembers the role before startOAuth and forgets it on completion', () => {
	const code = readFileSync(path.join(__dirname, '..', 'components', 'layout', 'Shell.tsx'), 'utf8');
	assert.ok(/from '\.\.\/\.\.\/util\/authPopup'/.test(code), 'Shell.tsx must import the authPopup helpers');
	assert.ok(/const isAuthPopup = isAuthPopupWindow\(/.test(code), 'the popup role must come from isAuthPopupWindow');
	assert.ok(!/const isAuthPopup = window\.name === 'rrauth'/.test(code), 'the window.name-only check is gone');
	assert.ok(/rememberAuthPopup\([^)]*\);\s*void cm\.startOAuth\(\);/.test(code), 'the role is remembered right before the popup starts OAuth');
	assert.ok(/if \(isAuthPopup\) \{\s*forgetAuthPopup\(/.test(code), 'the role is forgotten when the popup completes');
});
