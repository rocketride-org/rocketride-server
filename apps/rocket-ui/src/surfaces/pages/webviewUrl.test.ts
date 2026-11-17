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

// The `webview:` document frames its URL with `allow-scripts allow-same-origin`.
// A shell-origin URL would therefore run with the shell's full authority, so
// only https, loopback http, and the engine's own /chat/ and /dropper/ pages
// on the shell origin may be framed (#1022).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedWebviewUrl } from './webviewUrl';

const SHELL = 'https://shell.example';

test('accepts external https and loopback http', () => {
	for (const url of ['https://docs.example', 'https://docs.example/a/b?c=d#e', 'http://localhost:5565/chat/p/s', 'http://127.0.0.1:5565/anything', 'http://[::1]:5565/anything']) {
		assert.equal(isAllowedWebviewUrl(url, SHELL), true, url);
	}
});

test('accepts shell-origin URLs only under /chat/ and /dropper/', () => {
	for (const url of [`${SHELL}/chat/p/s`, `${SHELL}/chat/p/s?auth=x`, `${SHELL}/dropper/p/s`]) {
		assert.equal(isAllowedWebviewUrl(url, SHELL), true, url);
	}
});

test('refuses every other shell-origin URL, including traversal and prefix tricks', () => {
	for (const url of [`${SHELL}/`, SHELL, `${SHELL}/apps/x/v1/a.html`, `${SHELL}/shell/index.html`, `${SHELL}/chat/../apps/x/v1/a.html`, `${SHELL}/chat/%2e%2e/apps/x/v1/a.html`, `${SHELL}/chat/..%2fapps/x/v1/a.html`, `${SHELL}/chat/..%2Fapps/x/v1/a.html`, `${SHELL}/chat/..%5capps/x/v1/a.html`, `${SHELL}/chat/..%5Capps/x/v1/a.html`, 'https://shell.example./apps/x/v1/a.html', 'https://SHELL.example/', 'https://shell.example:443/shell/index.html', `${SHELL}/chatty/x`, `${SHELL}/dropper-x/y`, `${SHELL}/x/chat/p`]) {
		assert.equal(isAllowedWebviewUrl(url, SHELL), false, url);
	}
});

test('applies the same shell-origin rule to a loopback http shell', () => {
	const shell = 'http://localhost:5565';
	assert.equal(isAllowedWebviewUrl(`${shell}/chat/p/s`, shell), true);
	assert.equal(isAllowedWebviewUrl(`${shell}/`, shell), false);
	assert.equal(isAllowedWebviewUrl(`${shell}/apps/x/v1/a.html`, shell), false);
});

test('treats another loopback name on the shell port as the shell itself', () => {
	const shell = 'http://localhost:5565';
	for (const alias of ['http://127.0.0.1:5565', 'http://[::1]:5565', 'http://localhost.:5565']) {
		assert.equal(isAllowedWebviewUrl(`${alias}/chat/p/s`, shell), true, `${alias}/chat`);
		assert.equal(isAllowedWebviewUrl(`${alias}/`, shell), false, `${alias}/`);
		assert.equal(isAllowedWebviewUrl(`${alias}/shell/index.html`, shell), false, `${alias}/shell`);
	}
	// A different local port is a different server, not the shell.
	assert.equal(isAllowedWebviewUrl('http://127.0.0.1:3000/', shell), true);
});

test('lets a plain-http engine on a non-loopback host open its own chat and dropper pages', () => {
	for (const shell of ['http://10.0.0.5:5565', 'http://engine.lan:5565']) {
		assert.equal(isAllowedWebviewUrl(`${shell}/chat/p/s`, shell), true, `${shell}/chat`);
		assert.equal(isAllowedWebviewUrl(`${shell}/dropper/p/s`, shell), true, `${shell}/dropper`);
		assert.equal(isAllowedWebviewUrl(`${shell}/`, shell), false, `${shell}/`);
		assert.equal(isAllowedWebviewUrl(`${shell}/apps/x/v1/a.html`, shell), false, `${shell}/apps`);
	}
	// Other plain-http hosts are still refused.
	assert.equal(isAllowedWebviewUrl('http://10.0.0.6:5565/chat/p/s', 'http://10.0.0.5:5565'), false);
});

test('refuses app bundles on any origin', () => {
	for (const url of ['https://docs.example/apps/x/v1/a.html', 'https://docs.example/apps', 'http://localhost:3000/apps/x/remoteEntry.js', 'https://docs.example/a/../apps/x']) {
		assert.equal(isAllowedWebviewUrl(url, SHELL), false, url);
	}
	assert.equal(isAllowedWebviewUrl('https://docs.example/appstore', SHELL), true);
});

test('refuses non-http(s) schemes, credentials, non-loopback http and unparsable input', () => {
	for (const url of ['javascript:alert(1)', 'data:text/html,x', `blob:${SHELL}/u`, 'file:///etc/passwd', 'ws://localhost:5565/chat/p/s', 'https://u:p@x.example', 'https://u@x.example/chat/p', 'http://evil.example', '//evil.example/x', '/chat/p/s', '', 'not a url']) {
		assert.equal(isAllowedWebviewUrl(url, SHELL), false, JSON.stringify(url));
	}
});
