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
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { TypescriptSetupHandle } from 'shared/components/monaco';
import { createAtaEngine } from './ata';

/** Type files in the fake `heavy` package, more than one session may fetch. */
const HEAVY_FILES = 3000;

/** The npm package a jsDelivr URL names. */
function packageOf(url: string): string {
	return /\/npm\/((?:@[^/@]+\/)?[^/@]+)/.exec(url)?.[1] ?? url;
}

/**
 * Stands in for jsDelivr: every package resolves to 1.0.0 and ships one
 * index.d.ts, except `heavy`, which ships HEAVY_FILES of them.
 */
function fakeJsdelivr(t: TestContext): string[] {
	const requests: string[] = [];
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		const name = packageOf(url);
		if (url.includes('/resolve/npm/')) return Response.json({ version: '1.0.0' });
		if (url.endsWith('/flat')) {
			const count = name === 'heavy' ? HEAVY_FILES : 1;
			return Response.json({ default: '/index.js', files: Array.from({ length: count }, (_, i) => ({ name: i === 0 ? '/index.d.ts' : `/f${i}.d.ts` })) });
		}
		return new Response(url.endsWith('/package.json') ? '{}' : 'export declare const value: number;\n');
	});
	return requests;
}

/** Opens an engine on one source file and resolves once its requests stop. */
async function acquire(source: string, requests: readonly string[]): Promise<{ libs: string[]; problems: string[] }> {
	const libs: string[] = [];
	const problems: string[] = [];
	const handle: TypescriptSetupHandle = {
		addExtraLib: (_content, path) => {
			libs.push(path);
			return { dispose: () => {} };
		},
		dispose: () => {},
	};
	const engine = createAtaEngine(handle, (message) => problems.push(message));
	engine.enqueue('app.tsx', () => source);
	for (let seen = 0; requests.length === 0 || requests.length !== seen; ) {
		seen = requests.length;
		await delay(200);
	}
	engine.dispose();
	return { libs, problems };
}

test('downloads types only for packages the platform does not provide', { timeout: 20_000 }, async (t) => {
	const requests = fakeJsdelivr(t);
	const source = ["import { PipeException } from 'rocketride';", "import { useApp } from 'shell';", "import React from 'react';", "import { createRoot } from 'react-dom/client';", "import leftPad from 'left-pad';"].join('\n');

	const { libs } = await acquire(source, requests);

	assert.deepEqual([...new Set(requests.map(packageOf))], ['left-pad']);
	assert.ok(libs.includes('file:///node_modules/left-pad/index.d.ts'), 'a third-party import still gets its types');
});

test('stops a heavy package at 1,000 requests and reports it once', { timeout: 20_000 }, async (t) => {
	const requests = fakeJsdelivr(t);

	const { problems } = await acquire("import { thing } from 'heavy';", requests);

	assert.equal(requests.length, 1000);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /^\[types\] /);
});
