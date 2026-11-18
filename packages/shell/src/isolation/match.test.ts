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
// MATCHER TESTS — T131 (re-entrant scans), T132 (lengths per prefix group are capped)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createMatcher, matcherShape, scan } from './match';
import type { IMatch } from './match';

const hex = (chars: number): string =>
	randomBytes(Math.ceil(chars / 2))
		.toString('hex')
		.slice(0, chars);

test('T131 a scan inside another scan callback leaves both scans complete', () => {
	const outerNeedles = Array.from({ length: 3 }, () => `outer-${hex(24)}`);
	const innerNeedles = Array.from({ length: 3 }, () => `inner-${hex(24)}`);
	const outer = createMatcher(outerNeedles.map((n) => [n, n] as const));
	const inner = createMatcher(innerNeedles.map((n) => [n, n] as const));
	const filler = (k: number): string => hex(k);
	const outerText = outerNeedles.map((n) => `${filler(900)} ${n} `).join('') + filler(900);
	// The inner text is shorter than the outer one but covers its second needle: a window buffer shared
	// between the two scans would be overwritten in place under the outer scan.
	const innerText = innerNeedles.map((n) => `${filler(600)} ${n} `).join('') + filler(600);
	const foundOuter: string[] = [];
	const foundInner: string[][] = [];
	scan(outerText, [outer], (m: IMatch<string>) => {
		foundOuter.push(m.value);
		const nested: string[] = [];
		scan(innerText, [inner], (x: IMatch<string>) => {
			nested.push(x.value);
		});
		foundInner.push(nested);
	});
	assert.deepEqual(foundOuter, outerNeedles, 'the outer scan finds every needle after nested scans');
	for (const nested of foundInner) assert.deepEqual(nested, innerNeedles, 'every nested scan finds every needle');
});

test('T132 200 lengths sharing a 16-char prefix: each group holds a bounded number of lengths, 8 MiB scans in under 1000 ms, every needle found', async (tt) => {
	const prefix = 'shared-prefix-16';
	assert.equal(prefix.length, 16);
	const needles = Array.from({ length: 200 }, (_, i) => `${prefix}${hex(8 + i)}`);
	const m = createMatcher(needles.map((n) => [n, n] as const));
	const shape = matcherShape(m);
	tt.diagnostic(`T132 shape: ${JSON.stringify(shape)}`);
	assert.equal(shape.needles, 200);
	assert.ok(shape.maxLengthsPerGroup <= 16, `a group holds ${shape.maxLengthsPerGroup} lengths`);

	// Completeness: every needle is found, in place.
	const text = needles.map((n) => ` ${n} `).join('|');
	const found: string[] = [];
	scan(text, [m], (x: IMatch<string>) => {
		found.push(x.value);
	});
	assert.deepEqual(found, needles, 'every needle is found');

	// Cost: 8 MiB of the shared prefix repeated (a candidate every 16 chars).
	const strings = Array.from({ length: 2000 }, () => prefix.repeat(250));
	let best = Infinity;
	for (let r = 0; r < 3; r++) {
		const start = performance.now();
		for (const s of strings) scan(s, [m], () => undefined);
		best = Math.min(best, performance.now() - start);
	}
	tt.diagnostic(`T132 8 MiB shared-prefix flood: ${best.toFixed(1)} ms`);
	// 1000 ms: robust on a loaded CI host (seen at 779 ms), still far under the 2.8 s quadratic case.
	assert.ok(best < 1000, `the scan took ${best.toFixed(1)} ms`);
});
