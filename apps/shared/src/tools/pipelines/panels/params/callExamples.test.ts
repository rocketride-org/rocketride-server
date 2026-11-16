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

/** The call examples (M-1.6): every tab names the address and the exposed parameters with their values. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCallExamples, exampleValue } from './callExamples';

const PARAMS = [
	{ name: 'maxEdge', value: 2048 },
	{ name: 'outputFormat', value: 'webp' },
	{ name: 'detail', value: true },
];

describe('buildCallExamples', () => {
	it('names the address and every parameter in each language with that language\'s literals', () => {
		const out = buildCallExamples({ address: 'acme.myDropper', params: PARAMS, host: 'https://api.example.com/' });
		assert.match(out.javascript, /require\('rocketride'\)/);
		assert.match(out.javascript, /client\.submit\(\{/);
		assert.match(out.javascript, /name: 'acme\.myDropper'/);
		assert.match(out.javascript, /params: \{ maxEdge: 2048, outputFormat: 'webp', detail: true \}/);
		assert.match(out.typescript, /import \{ RocketRideClient \} from 'rocketride'/);
		assert.match(out.typescript, /params: \{ maxEdge: 2048, outputFormat: 'webp', detail: true \}/);
		assert.match(out.python, /await client\.submit\(/);
		assert.match(out.python, /params=\{'maxEdge': 2048, 'outputFormat': 'webp', 'detail': True\}/);
	});

	it('writes the HTTP door request: the dotted address in one segment, params on the query string, header auth', () => {
		const out = buildCallExamples({ address: 'acme.myDropper.chat', params: PARAMS, host: 'https://api.example.com/' });
		assert.match(out.http, /^POST https:\/\/api\.example\.com\/webhook\/acme\.myDropper\.chat\?maxEdge=2048&outputFormat=webp&detail=true$/m);
		assert.match(out.http, /^Authorization: Bearer rr_/m);
		assert.doesNotMatch(out.http, /auth=/);
	});

	it('shows an empty params map and a host placeholder when nothing is exposed and no host is known', () => {
		const out = buildCallExamples({ address: 'acme.p', params: [] });
		assert.match(out.javascript, /params: \{\},/);
		assert.match(out.python, /params=\{\},/);
		assert.match(out.http, /^POST https:\/\/\{host\}\/webhook\/acme\.p$/m);
	});

	it('escapes a quote inside a string value', () => {
		const out = buildCallExamples({ address: 'acme.p', params: [{ name: 'tone', value: "dry 'n wry" }] });
		assert.match(out.javascript, /tone: 'dry \\'n wry'/);
		assert.match(out.python, /'tone': 'dry \\'n wry'/);
	});
});

describe('exampleValue', () => {
	const descriptor = (over: Record<string, unknown>) => ({ field: 'f', type: 'string', title: null, description: null, default: null, ...over }) as never;

	it('prefers the effective default, then the declared default, then the first enum value, then a type-shaped sample', () => {
		assert.equal(exampleValue(descriptor({}), 'stored'), 'stored');
		assert.equal(exampleValue(descriptor({ default: 'declared' }), undefined), 'declared');
		assert.equal(exampleValue(descriptor({ enum: ['a', 'b'] }), null), 'a');
		assert.equal(exampleValue(descriptor({ type: 'integer', minimum: 256 }), undefined), 256);
		assert.equal(exampleValue(descriptor({ type: 'number' }), undefined), 1);
		assert.equal(exampleValue(descriptor({ type: 'boolean' }), undefined), true);
		assert.equal(exampleValue(descriptor({}), ''), 'value');
	});
});
