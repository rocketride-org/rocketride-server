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

test('a fresh popup is recognised by its window name or the ?rrauth=1 marker', () => {
	const storage = memoryStorage();
	assert.equal(isAuthPopupWindow('rrauth', new URLSearchParams(''), storage), true);
	assert.equal(isAuthPopupWindow('', new URLSearchParams('rrauth=1'), storage), true);
	assert.equal(isAuthPopupWindow('', new URLSearchParams(''), storage), false);
	assert.equal(isAuthPopupWindow('other', new URLSearchParams('rrauth=0'), storage), false);
});

test('the role survives the IdP round trip once remembered (window.name cleared, no marker)', () => {
	const storage = memoryStorage();
	rememberAuthPopup(storage);
	assert.equal(storage.data.get(AUTH_POPUP_KEY), '1');
	assert.equal(isAuthPopupWindow('', new URLSearchParams('code=abc&state=xyz'), storage), true);
	forgetAuthPopup(storage);
	assert.equal(isAuthPopupWindow('', new URLSearchParams('code=abc&state=xyz'), storage), false);
});

test('unavailable storage never throws and falls back to name and marker', () => {
	assert.doesNotThrow(() => rememberAuthPopup(brokenStorage));
	assert.doesNotThrow(() => forgetAuthPopup(brokenStorage));
	assert.equal(isAuthPopupWindow('', new URLSearchParams(''), brokenStorage), false);
	assert.equal(isAuthPopupWindow('rrauth', new URLSearchParams(''), brokenStorage), true);
	assert.equal(isAuthPopupWindow('', new URLSearchParams(''), null), false);
});

test('Shell.tsx remembers the role before startOAuth and forgets it on completion', () => {
	const code = readFileSync(path.join(__dirname, '..', 'components', 'layout', 'Shell.tsx'), 'utf8');
	assert.ok(/from '\.\.\/\.\.\/util\/authPopup'/.test(code), 'Shell.tsx must import the authPopup helpers');
	assert.ok(/const isAuthPopup = isAuthPopupWindow\(/.test(code), 'the popup role must come from isAuthPopupWindow');
	assert.ok(!/const isAuthPopup = window\.name === 'rrauth'/.test(code), 'the window.name-only check is gone');
	assert.ok(/rememberAuthPopup\([^)]*\);\s*void cm\.startOAuth\(\);/.test(code), 'the role is remembered right before the popup starts OAuth');
	assert.ok(/if \(isAuthPopup\) \{\s*forgetAuthPopup\(/.test(code), 'the role is forgotten when the popup completes');
});
