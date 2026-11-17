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

// Source-level wiring checks (the shell has no React render harness; the real
// flows are covered end to end in PR2). App code runs in the shell origin (the
// `app` component of AppFrame) or in iframes the shell bridges to, and neither
// may receive the session token (#1022): both paths must hand out the
// `withoutCredentials` projection from `util/identity.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Read a shell source file, relative to `src/`. */
function source(rel: string): string {
	return readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

/** Assert on the source without echoing the whole file into the failure message. */
function has(code: string, re: RegExp): boolean {
	return re.test(code);
}

/** Return the text of every `post({ ... })` call that mentions the given message type (every call for ''). */
function postCalls(code: string, messageType: string): string[] {
	const calls: string[] = [];
	let from = 0;
	for (;;) {
		const start = code.indexOf('post({', from);
		if (start < 0) break;
		const end = code.indexOf('})', start);
		const text = code.slice(start, end + 2);
		if (!messageType || text.includes(`'${messageType}'`)) calls.push(text);
		from = end + 2;
	}
	return calls;
}

// ---- iframe bridge -------------------------------------------------------

test('useIframeBridge posts the user only through withoutCredentials (shell:init and shell:login)', () => {
	const code = source('hooks/useIframeBridge.ts');
	assert.ok(has(code, /from '\.\.\/util\/identity'/), 'useIframeBridge.ts must import withoutCredentials from ../util/identity');

	const init = postCalls(code, 'shell:init');
	const login = postCalls(code, 'shell:login');
	assert.equal(init.length, 1, 'one shell:init post');
	assert.equal(login.length, 1, 'one shell:login post');
	for (const call of [...init, ...login]) {
		assert.ok(has(call, /user:\s*withoutCredentials\(/), `user must be projected: ${call.replace(/\s+/g, ' ')}`);
	}
	// No raw user object may reach the iframe, in any post call.
	for (const call of postCalls(code, '')) {
		assert.ok(!has(call, /[{,]\s*user\s*[,}]/), `raw user (shorthand) is posted: ${call.replace(/\s+/g, ' ')}`);
		assert.ok(!has(call, /\buser:(?!\s*withoutCredentials\()/), `user is posted without withoutCredentials: ${call.replace(/\s+/g, ' ')}`);
	}
	assert.ok(!has(code, /user:\s*authUserRef\.current/), 'raw authUserRef.current is posted');
	assert.ok(!has(code, /type:\s*'shell:login',\s*user\s*\}/), 'raw user is posted in shell:login');
});

test('useIframeBridge sends the API config without RR_APIKEY', () => {
	const code = source('hooks/useIframeBridge.ts');
	const [init] = postCalls(code, 'shell:init');
	assert.ok(has(init, /apiConfig:\s*bridgedApiConfig\(\s*apiConfig\s*\)/), `apiConfig must go through bridgedApiConfig: ${init.replace(/\s+/g, ' ')}`);
});

// ---- app identity --------------------------------------------------------

test('AppFrame hands the app a credential-free identity', () => {
	const code = source('components/layout/AppFrame.tsx');
	assert.ok(has(code, /from '\.\.\/\.\.\/util\/identity'/), 'AppFrame.tsx must import withoutCredentials from ../../util/identity');
	const projected = /const (\w+) = useMemo\(\(\) => withoutCredentials\(\s*identity\s*\), \[identity\]\)/.exec(code);
	assert.ok(projected, 'AppFrame.tsx must project identity with withoutCredentials');
	assert.ok(has(code, new RegExp(`identity=\\{${projected[1]}\\}`)), 'the projected identity is the one passed to the app');
	assert.ok(!has(code, /identity=\{identity\}/), 'the raw identity prop is passed to the app');
});

test('the shell identity context carries the credential-free identity', () => {
	const code = source('components/layout/Shell.tsx');
	assert.ok(has(code, /from '\.\.\/\.\.\/util\/identity'/), 'Shell.tsx must import withoutCredentials from ../../util/identity');
	const provider = /<ShellIdentityContext\.Provider value=\{(\w+)\}>/.exec(code);
	assert.ok(provider, 'one ShellIdentityContext.Provider with a plain value');
	assert.notEqual(provider[1], 'identity', 'the raw identity is put in the context');
	assert.ok(has(code, new RegExp(`const ${provider[1]} = useMemo\\(\\(\\) => withoutCredentials\\(identity\\), \\[identity\\]\\)`)), 'the context value must be withoutCredentials(identity)');
});
