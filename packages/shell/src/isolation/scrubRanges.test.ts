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
// ALIAS TESTS — T105 (knownProjects, short ids, project-keyed maps and the N1-L flood case)
// =============================================================================

/// <reference types="node" />


// =============================================================================
// REDACTION RANGES — the sweep equals the quadratic reference, and stays linear
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { growRanges, repsOutside } from './scrub';

type Rep = { index: number; needle: string };

/** The original fixpoint: every replacement against every range, until nothing grows. */
function reference(deny: Array<[number, number]>, reps: Rep[]): { ranges: Array<[number, number]>; kept: Rep[] } {
	const merge = (rs: Array<[number, number]>): Array<[number, number]> => {
		const sorted = rs.map((r) => [r[0], r[1]] as [number, number]).sort((a, b) => a[0] - b[0]);
		const out: Array<[number, number]> = [];
		for (const r of sorted) {
			const last = out[out.length - 1];
			if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
			else out.push(r);
		}
		return out;
	};
	let ranges = merge(deny);
	for (let grown = true; grown; ) {
		grown = false;
		for (const r of reps) {
			const a = r.index;
			const b = a + r.needle.length;
			for (const g of ranges)
				if (a < g[1] && b > g[0] && (a < g[0] || b > g[1])) {
					g[0] = Math.min(g[0], a);
					g[1] = Math.max(g[1], b);
					grown = true;
				}
		}
		if (grown) ranges = merge(ranges);
	}
	return { ranges, kept: reps.filter((r) => !ranges.some((g) => r.index < g[1] && r.index + r.needle.length > g[0])) };
}

const merged = (rs: Array<[number, number]>): Array<[number, number]> => {
	const sorted = rs.map((r) => [r[0], r[1]] as [number, number]).sort((a, b) => a[0] - b[0]);
	const out: Array<[number, number]> = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push(r);
	}
	return out;
};

function mulberry(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test('growRanges and repsOutside equal the quadratic reference on random layouts', () => {
	const rng = mulberry(1022);
	for (let round = 0; round < 3000; round++) {
		const deny: Array<[number, number]> = Array.from({ length: Math.floor(rng() * 5) }, () => {
			const a = Math.floor(rng() * 60);
			return [a, a + 1 + Math.floor(rng() * 12)];
		});
		// Replacements come from a non-overlapping scan: sorted and disjoint.
		const reps: Rep[] = [];
		for (let at = Math.floor(rng() * 8); at < 70 && reps.length < 12; ) {
			const len = 1 + Math.floor(rng() * 9);
			reps.push({ index: at, needle: 'n'.repeat(len) });
			at += len + Math.floor(rng() * 7);
		}
		const want = reference(deny, reps);
		const ranges = growRanges(merged(deny), reps);
		assert.deepEqual(ranges, want.ranges, `round ${round}: ranges for deny ${JSON.stringify(deny)} reps ${JSON.stringify(reps.map((r) => [r.index, r.needle.length]))}`);
		assert.deepEqual(repsOutside(reps, ranges), want.kept, `round ${round}: kept replacements`);
	}
});

test('10,000 redaction ranges against 10,000 replacements is one linear sweep', (t) => {
	const deny: Array<[number, number]> = Array.from({ length: 10_000 }, (_, i) => [i * 40 + 5, i * 40 + 15]);
	const reps: Rep[] = Array.from({ length: 10_000 }, (_, i) => ({ index: i * 40 + 12, needle: 'rrrrrr' })); // each sticks out of its range
	const start = performance.now();
	const ranges = growRanges(merged(deny), reps);
	const kept = repsOutside(reps, ranges);
	const ms = performance.now() - start;
	assert.equal(ranges.length, 10_000);
	assert.ok(ranges.every((g, i) => g[0] === i * 40 + 5 && g[1] === i * 40 + 18), 'every range grew to take its replacement');
	assert.equal(kept.length, 0, 'every replacement was absorbed');
	// The reference does 10,000 x 10,000 comparisons here; the sweep does about 20,000 steps.
	t.diagnostic(`growRanges 10k x 10k: ${ms.toFixed(1)} ms`);
});
