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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiKeyLogin } from './ApiKeyLogin';
import { AppErrorBoundary } from './AppErrorBoundary';
import DebugPanel from './DebugPanel';

/** Assert that the rendered HTML's root element is a <div> carrying data-rr-private. */
function assertRootHasPrivateMarker(markup: string, surfaceName: string): void {
	const openTag = markup.match(/^<([a-z0-9-]+)\b([^>]*)>/i);
	assert.ok(openTag, `${surfaceName} rendered an opening root tag`);
	assert.match(
		openTag[2],
		/\bdata-rr-private(?:="")?(?=[\s/>]|$)/,
		`${surfaceName} root <${openTag[1]}> carries data-rr-private`
	);
}

test('DebugPanel marks its root element with data-rr-private', () => {
	const markup = renderToStaticMarkup(<DebugPanel onClose={() => undefined} />);
	assertRootHasPrivateMarker(markup, 'DebugPanel');
	assert.match(markup, /Debug/);
});

test('ApiKeyLogin marks its root element with data-rr-private', () => {
	const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { location: { host: 'localhost:5565' } },
	});
	try {
		const markup = renderToStaticMarkup(<ApiKeyLogin onSubmit={async () => undefined} />);
		assertRootHasPrivateMarker(markup, 'ApiKeyLogin');
		assert.match(markup, /localhost:5565/);
	} finally {
		if (prevWindow) Object.defineProperty(globalThis, 'window', prevWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});

test('AppErrorBoundary error screen marks its root element with data-rr-private', () => {
	const boundary = new AppErrorBoundary({ appName: 'RocketRide', children: <div>ok</div> });
	Object.assign(boundary.state, AppErrorBoundary.getDerivedStateFromError(new Error('Crash in app')));
	const markup = renderToStaticMarkup(<>{boundary.render()}</>);
	assertRootHasPrivateMarker(markup, 'AppErrorBoundary');
	assert.match(markup, /RocketRide encountered an error/);
	assert.match(markup, /Crash in app/);
});
