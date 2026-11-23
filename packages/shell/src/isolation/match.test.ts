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

test('T132 200 lengths sharing a 16-char prefix: each group holds a bounded number of lengths, 8 MiB scans in under 1000 ms or 15x the linear floor, every needle found', async (tt) => {
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
	// The control is the same 8 MiB under a matcher of ONE needle whose prefix
	// never occurs in it: the scan's linear floor on this host, measured in the
	// same rounds, so a host slowed by suites running beside this one slows
	// both alike. One needle, not the 200 lengths: work done per length at
	// every position would slow a 200-length control just as much and hide.
	const strings = Array.from({ length: 2000 }, () => prefix.repeat(250));
	const control = createMatcher([[`other-prefix-xyz${needles[0].slice(16)}`, needles[0]] as const]);
	const time = (matcher: typeof m): number => {
		const start = performance.now();
		for (const s of strings) scan(s, [matcher], () => undefined);
		return performance.now() - start;
	};
	let best = Infinity;
	let floor = Infinity;
	const rounds: string[] = [];
	for (let r = 0; r < 3; r++) {
		// The order alternates, so neither side always runs first (warm-up, a cooling host).
		const controlFirst = r % 2 === 0;
		let f: number;
		let b: number;
		if (controlFirst) {
			f = time(control);
			b = time(m);
		} else {
			b = time(m);
			f = time(control);
		}
		floor = Math.min(floor, f);
		best = Math.min(best, b);
		rounds.push(`round ${r} (${controlFirst ? 'control first' : 'matcher first'}): matcher ${b.toFixed(1)} ms, control ${f.toFixed(1)} ms`);
	}
	tt.diagnostic(`T132 8 MiB shared-prefix flood: ${best.toFixed(1)} ms (linear floor ${floor.toFixed(1)} ms); ${rounds.join('; ')}`);
	// 1000 ms on a quiet host (seen at 779 ms under load), and never more than
	// 15x the floor on a contended one; the quadratic case is 2.8 s, 35x or more.
	assert.ok(best < 1000 || best < 15 * floor, `the scan took ${best.toFixed(1)} ms against a ${floor.toFixed(1)} ms floor`);
});
