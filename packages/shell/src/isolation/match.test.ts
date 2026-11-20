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
import { GROUP_LENGTHS, createMatcher, matcherShape, scan, windowPoolStats } from './match';
import type { IMatch } from './match';
import { assertWithin } from './__test__/util';

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

test('T132 the length bound holds at the trie boundary: eight lengths fill one node and a ninth goes one block deeper', () => {
	const prefix = 'shared-prefix-16';
	assert.equal(prefix.length, 16);
	// Lengths 16..23 are the most one node holds (prefix length .. prefix length + 7); 24 sits in the child.
	const needles = Array.from({ length: GROUP_LENGTHS + 1 }, (_, i) => `${prefix}${'a'.repeat(i)}`);
	assert.deepEqual(needles.map((n) => n.length), [16, 17, 18, 19, 20, 21, 22, 23, 24]);
	const m = createMatcher(needles.map((n) => [n, n] as const));
	const shape = matcherShape(m);
	assert.equal(shape.needles, needles.length);
	assert.equal(shape.maxLengthsPerGroup, GROUP_LENGTHS, `the node holds exactly the documented ${GROUP_LENGTHS} lengths, got ${JSON.stringify(shape)}`);
	const found: string[] = [];
	const text = needles.map((n) => ` ${n} `).join('|');
	scan(text, [m], (x: IMatch<string>) => {
		found.push(x.value);
	});
	assert.deepEqual(found, needles, 'the ninth length, one block deeper, is found like the rest');
});

test('T132 200 lengths sharing a 16-char prefix: each group holds a bounded number of lengths, 8 MiB scans within 200 ms under RR_SHELL_PERF=1, every needle found', async (tt) => {
	const prefix = 'shared-prefix-16';
	assert.equal(prefix.length, 16);
	const needles = Array.from({ length: 200 }, (_, i) => `${prefix}${hex(8 + i)}`);
	const m = createMatcher(needles.map((n) => [n, n] as const));
	const shape = matcherShape(m);
	tt.diagnostic(`T132 shape: ${JSON.stringify(shape)}`);
	assert.equal(shape.needles, 200);
	assert.ok(shape.maxLengthsPerGroup <= GROUP_LENGTHS, `a group holds ${shape.maxLengthsPerGroup} lengths (bound ${GROUP_LENGTHS})`);

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
	assertWithin(best, 200, 'the scan');
});

test('the hash-buffer pool is bounded by bytes: a scan of a very large string does not stay in memory', () => {
	const m = createMatcher([['needle-needle-needle', 1]]);
	const text = 'x'.repeat(3_000_000); // a 12 MB window buffer, over the pool's per-buffer cap
	scan(text, [m], () => undefined);
	scan('a small string with needle-needle-needle inside', [m], () => undefined);
	const { buffers, bytes } = windowPoolStats();
	assert.ok(bytes <= 4 * 1024 * 1024, `the pool holds ${bytes} bytes in ${buffers} buffers`);
});

test('scan with every reports each needle that starts at one offset, longest first', () => {
	const m = createMatcher([
		['abcdefgh', 'short'],
		['abcdefgh12345678', 'long'],
		['abcdefgh1234', 'mid'],
	] as const);
	const text = 'xx abcdefgh12345678 yy';
	const longest: string[] = [];
	scan(text, [m], (x) => void longest.push(x.value), true);
	assert.deepEqual(longest, ['long'], 'control: the plain scan reports only the longest at the offset');
	const every: string[] = [];
	scan(text, [m], (x) => void every.push(`${x.index}:${x.value}`), true, undefined, true);
	assert.deepEqual(every.slice(0, 3), ['3:long', '3:mid', '3:short'], 'every needle at the offset, longest first');
	const resumed: string[] = [];
	scan(text, [m], (x) => void resumed.push(x.value), false, undefined, true);
	assert.deepEqual(resumed, ['long', 'mid', 'short'], 'without overlap the scan still resumes after the longest');
});
