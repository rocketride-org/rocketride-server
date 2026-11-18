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
// MATCH — one linear pass that finds many needles in a string (PR2a-2, N1)
// =============================================================================
//
// The scrubber looks for thousands of exact values (seen tokens and task ids,
// foreign project ids, identity ids, every realm's live ledger values) in
// every string it sends to a realm. Checking each needle with `includes`
// costs O(string x needles). Here every needle is indexed by a rolling hash
// of its first {@link PREFIX} characters, so a scan costs O(string) whatever
// the set size: one hash update and one bit test per character, and a
// `startsWith` check only where a prefix hash hits. A matcher is immutable
// and built once per version of the sets it holds (security M2, DA F3).
// =============================================================================

/** Characters hashed per needle; shorter needles are never matched (they would match ordinary text). */
export const PREFIX = 8;
const BASE = 0x01000193;
/** BASE^(PREFIX-1) mod 2^32, for removing the leaving character. */
const LEAD = ((): number => {
	let p = 1;
	for (let i = 0; i < PREFIX - 1; i++) p = Math.imul(p, BASE);
	return p;
})();
const TABLE_BITS = 18;
const MASK = (1 << TABLE_BITS) - 1;

/** A set of needles, each with a value, indexed by prefix hash. */
export interface IMatcher<T> {
	readonly size: number;
	/** Bit per hash slot: a cheap filter before the bucket lookup. */
	readonly bits: Uint8Array;
	/** Prefix hash → needles with that prefix hash, longest first. */
	readonly buckets: Map<number, Array<readonly [string, T]>>;
}

function hashAt(s: string, i: number): number {
	let h = 0;
	for (let j = 0; j < PREFIX; j++) h = (Math.imul(h, BASE) + s.charCodeAt(i + j)) | 0;
	return h;
}

/** An empty matcher (matches nothing). */
export const EMPTY_MATCHER: IMatcher<never> = { size: 0, bits: new Uint8Array(0), buckets: new Map() };

/**
 * Builds a matcher. A needle shorter than {@link PREFIX} is skipped; the first
 * value given for a needle wins.
 *
 * @param entries - Needles and their values.
 * @returns The matcher.
 */
export function createMatcher<T>(entries: Iterable<readonly [string, T]>): IMatcher<T> {
	const buckets = new Map<number, Array<readonly [string, T]>>();
	const taken = new Set<string>();
	for (const entry of entries) {
		const needle = entry[0];
		if (typeof needle !== 'string' || needle.length < PREFIX || taken.has(needle)) continue;
		taken.add(needle);
		const h = hashAt(needle, 0);
		const bucket = buckets.get(h);
		if (bucket) bucket.push(entry);
		else buckets.set(h, [entry]);
	}
	if (taken.size === 0) return EMPTY_MATCHER as IMatcher<T>;
	const bits = new Uint8Array(MASK + 1);
	for (const [h, bucket] of buckets) {
		bits[h & MASK] = 1;
		if (bucket.length > 1) bucket.sort((a, b) => b[0].length - a[0].length);
	}
	return { size: taken.size, bits, buckets };
}

/** One match: the needle, its value and the index of the matcher it came from. */
export interface IMatch<T> {
	index: number;
	needle: string;
	value: T;
	matcher: number;
}

/**
 * Scans `s` for the needles of `matchers`, leftmost first; at one position
 * the longest needle wins, and on equal length the earlier matcher wins.
 * Matches do not overlap. `onMatch` returns false to stop the scan.
 *
 * @param s - The string.
 * @param matchers - The matchers, in priority order.
 * @param onMatch - Called per match.
 */
export function scan<T>(s: string, matchers: ReadonlyArray<IMatcher<T>>, onMatch: (m: IMatch<T>) => boolean | void): void {
	const n = s.length;
	if (n < PREFIX) return;
	const live = matchers.filter((m) => m.size > 0);
	if (live.length === 0) return;
	let i = 0;
	let h = hashAt(s, 0);
	while (i + PREFIX <= n) {
		const slot = h & MASK;
		let bestNeedle: string | undefined;
		let bestValue: T | undefined;
		let bestMatcher = -1;
		for (let k = 0; k < live.length; k++) {
			const m = live[k];
			if (m.bits[slot] === 0) continue;
			const bucket = m.buckets.get(h);
			if (!bucket) continue;
			for (const [needle, value] of bucket) {
				if ((bestNeedle === undefined || needle.length > bestNeedle.length) && s.startsWith(needle, i)) {
					bestNeedle = needle;
					bestValue = value;
					bestMatcher = matchers.indexOf(m);
					break;
				}
			}
		}
		if (bestNeedle !== undefined) {
			if (onMatch({ index: i, needle: bestNeedle, value: bestValue as T, matcher: bestMatcher }) === false) return;
			i += bestNeedle.length;
			if (i + PREFIX <= n) h = hashAt(s, i);
			continue;
		}
		if (i + PREFIX < n) h = (Math.imul((h - Math.imul(s.charCodeAt(i), LEAD)) | 0, BASE) + s.charCodeAt(i + PREFIX)) | 0;
		i++;
	}
}

/** Whether `s` holds any needle of `matchers`. */
export function hasMatch(s: string, matchers: ReadonlyArray<IMatcher<unknown>>): boolean {
	let found = false;
	scan(s, matchers, () => {
		found = true;
		return false;
	});
	return found;
}

/**
 * Replaces every match in `s` with what `replace` returns for it.
 *
 * @returns `s` itself when nothing matched.
 */
export function replaceMatches<T>(s: string, matchers: ReadonlyArray<IMatcher<T>>, replace: (m: IMatch<T>) => string): string {
	let out = '';
	let last = 0;
	scan(s, matchers, (m) => {
		out += s.slice(last, m.index) + replace(m);
		last = m.index + m.needle.length;
	});
	return last === 0 ? s : out + s.slice(last);
}

/** Most per-group work a match position may cost, as a count of exact lookups (the structural bound T126 checks). */
export const LENGTH_BOUND = 32;

/**
 * The matcher's shape, for tests: needles held and the most entries one
 * group examines one by one at a matching position.
 */
export function matcherShape(m: IMatcher<unknown>): { needles: number; maxLengthsPerGroup: number; lengthBound: number } {
	let max = 0;
	for (const bucket of m.buckets.values()) max = Math.max(max, bucket.length);
	return { needles: m.size, maxLengthsPerGroup: max, lengthBound: LENGTH_BOUND };
}
