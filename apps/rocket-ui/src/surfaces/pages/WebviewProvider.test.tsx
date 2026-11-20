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

// The provider must enforce the framing rule itself: removing its guard would
// frame shell-origin pages with allow-same-origin (#1022).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WebviewProvider from './WebviewProvider';

/** Render the provider with a stand-in shell location. */
function render(uri: string): string {
	(globalThis as unknown as { window: unknown }).window = {
		location: { origin: 'https://shell.example', href: 'https://shell.example/index.html' },
	};
	return renderToStaticMarkup(React.createElement(WebviewProvider, { uri }));
}

test('frames an allowed URL', () => {
	const html = render('webview:https://docs.example/a');
	assert.match(html, /<iframe[^>]+src="https:\/\/docs\.example\/a"/);
});

test('renders no iframe for a refused URL', () => {
	for (const uri of ['webview:https://shell.example/apps/x/index.html', 'webview:https:evil.example/../apps/x/index.html', 'webview:https:/apps/x/index.html', 'webview:javascript:alert(1)', 'webview:']) {
		const html = render(uri);
		assert.ok(!html.includes('<iframe'), uri);
		assert.match(html, /Invalid webview URI/, uri);
	}
});
