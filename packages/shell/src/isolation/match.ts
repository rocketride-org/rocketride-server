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
// The scrubber looks for thousands of exact values in every string it sends
// to a realm. The hash of every 8-character window of the string is computed
// once (a rolling hash with a random per-process base, so colliding windows
// cannot be precomputed). Needles of 16 characters or more are keyed by the
// hashes of their first TWO 8-character blocks, shorter ones (8-15) by the
// first. A position is a candidate only when its block hashes are a key;
// the prefix is then confirmed with `startsWith` and the needle found with
// ONE exact `Map` lookup per distinct length of that group. So the work at a
// position never depends on how many needles share a prefix or a hash: all
// minted ids of one app share `rrapp.<key>.` and still cost one lookup
// (DA R2-1, security N2). Worst case: O(string x distinct needle lengths).
// A matcher is immutable and built once per version of the sets it holds.
// =============================================================================

/** The shortest needle matched (shorter values would match ordinary text). */
export const PREFIX = 8;
const LONG = 2 * PREFIX;
/** 2^20 filter bits per table (128 KiB). */
const TABLE_BITS = 20;
const MASK = (1 << TABLE_BITS) - 1;

/** A random odd 32-bit hash base, per process. */
const BASE = ((): number => {
	const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
	const a = new Uint32Array(1);
	if (c?.getRandomValues) c.getRandomValues(a);
	else a[0] = Math.floor(Math.random() * 0x100000000);
	return a[0] | 1 | 0;
})();
/** BASE^(PREFIX-1) mod 2^32. */
const LEAD = ((): number => {
	let p = 1;
	for (let i = 0; i < PREFIX - 1; i++) p = Math.imul(p, BASE);
	return p;
})();

function hashAt(s: string, i: number): number {
	let h = 0;
	for (let j = 0; j < PREFIX; j++) h = (Math.imul(h, BASE) + s.charCodeAt(i + j)) | 0;
	return h;
}

/** Two block hashes as one filter key. */
const pairKey = (h1: number, h2: number): number => (Math.imul(h1, 0x9e3779b1) ^ h2) | 0;
const testBit = (bits: Uint32Array, h: number): boolean => (bits[(h & MASK) >>> 5] & (1 << (h & 31))) !== 0;
const setBit = (bits: Uint32Array, h: number): void => {
	bits[(h & MASK) >>> 5] |= 1 << (h & 31);
};

/** The needles of one length in a group, by exact value. */
interface ILengthEntry<T> {
	len: number;
	needles: Map<string, T>;
}

/** Needles sharing a prefix (8 chars for short needles, 16 for long ones), by length, longest first. */
interface IGroup<T> {
	prefix: string;
	lengths: Array<ILengthEntry<T>>;
}

/** A set of needles, each with a value. */
export interface IMatcher<T> {
	/** Identity for the union-filter cache. */
	readonly id: number;
	readonly size: number;
	/** Distinct needle lengths (the bound on lookups at one position). */
	readonly lengths: number;
	/** Needles of 16+ chars: filter on (block 1, block 2) hashes, then groups by pair key. */
	readonly longBits: Uint32Array | null;
	readonly long: Map<number, Array<IGroup<T>>>;
	/** Needles of 8-15 chars: filter on the block 1 hash, then groups by it. */
	readonly shortBits: Uint32Array | null;
	readonly short: Map<number, Array<IGroup<T>>>;
	has(needle: string): boolean;
}

/** An empty matcher (matches nothing). */
export const EMPTY_MATCHER: IMatcher<never> = { id: 0, size: 0, lengths: 0, longBits: null, long: new Map(), shortBits: null, short: new Map(), has: () => false };

let matcherIds = 0;

/** The OR of the filters of one tuple of matchers (long, short), cached by the tuple's ids. */
const unions = new Map<string, { long: Uint32Array | null; short: Uint32Array | null }>();
const UNIONS_MAX = 32;
function unionOf(matchers: ReadonlyArray<IMatcher<unknown>>): { long: Uint32Array | null; short: Uint32Array | null } {
	const key = matchers.map((m) => m.id).join(',');
	let u = unions.get(key);
	if (u) return u;
	const or = (pick: (m: IMatcher<unknown>) => Uint32Array | null): Uint32Array | null => {
		const parts = matchers.map(pick).filter((b): b is Uint32Array => b !== null);
		if (parts.length === 0) return null;
		if (parts.length === 1) return parts[0];
		const out = new Uint32Array(parts[0].length);
		for (const b of parts) for (let i = 0; i < out.length; i++) out[i] |= b[i];
		return out;
	};
	u = { long: or((m) => m.longBits), short: or((m) => m.shortBits) };
	unions.set(key, u);
	while (unions.size > UNIONS_MAX) unions.delete(unions.keys().next().value as string);
	return u;
}

function addTo<T>(index: Map<number, Array<IGroup<T>>>, key: number, prefix: string, needle: string, value: T): void {
	let slot = index.get(key);
	if (!slot) index.set(key, (slot = []));
	let group = slot.find((g) => g.prefix === prefix);
	if (!group) slot.push((group = { prefix, lengths: [] }));
	let entry = group.lengths.find((e) => e.len === needle.length);
	if (!entry) {
		group.lengths.push((entry = { len: needle.length, needles: new Map() }));
		group.lengths.sort((a, b) => b.len - a.len);
	}
	entry.needles.set(needle, value);
}

/**
 * Builds a matcher. A needle shorter than {@link PREFIX} is skipped; the first
 * value given for a needle wins.
 *
 * @param entries - Needles and their values.
 * @returns The matcher.
 */
export function createMatcher<T>(entries: Iterable<readonly [string, T]>): IMatcher<T> {
	const all = new Set<string>();
	const lengths = new Set<number>();
	const long = new Map<number, Array<IGroup<T>>>();
	const short = new Map<number, Array<IGroup<T>>>();
	let longBits: Uint32Array | null = null;
	let shortBits: Uint32Array | null = null;
	for (const [needle, value] of entries) {
		if (typeof needle !== 'string' || needle.length < PREFIX || all.has(needle)) continue;
		all.add(needle);
		lengths.add(needle.length);
		const h1 = hashAt(needle, 0);
		if (needle.length >= LONG) {
			const key = pairKey(h1, hashAt(needle, PREFIX));
			setBit((longBits ??= new Uint32Array((MASK + 1) >>> 5)), key);
			addTo(long, key, needle.slice(0, LONG), needle, value);
		} else {
			setBit((shortBits ??= new Uint32Array((MASK + 1) >>> 5)), h1);
			addTo(short, h1, needle.slice(0, PREFIX), needle, value);
		}
	}
	if (all.size === 0) return EMPTY_MATCHER as IMatcher<T>;
	return { id: ++matcherIds, size: all.size, lengths: lengths.size, longBits, long, shortBits, short, has: (needle) => all.has(needle) };
}

/** One match: where, the needle, its value and the index of the matcher it came from. */
export interface IMatch<T> {
	index: number;
	needle: string;
	value: T;
	matcher: number;
}

/** The window hashes of the last string scanned (a reused buffer). */
let windows = new Int32Array(1024);
let hashed: string | undefined;

/**
 * Scans `s` for the needles of `matchers`, leftmost first; at one position
 * the longest needle wins, and on equal length the earlier matcher wins.
 * Without `overlap`, matches do not overlap (the scan resumes after a match);
 * with it, every position is examined. `onMatch` returns false to stop.
 *
 * @param s - The string.
 * @param matchers - The matchers, in priority order.
 * @param onMatch - Called per match.
 * @param overlap - Report matches at every position.
 */
export function scan<T>(s: string, matchers: ReadonlyArray<IMatcher<T>>, onMatch: (m: IMatch<T>) => boolean | void, overlap = false): void {
	const n = s.length;
	if (n < PREFIX || !matchers.some((m) => m.size > 0)) return;
	const count = n - PREFIX + 1;
	// The scrubber scans one string twice (backstop, then replacements): its window hashes are reused.
	if (s !== hashed) {
		if (windows.length < count) windows = new Int32Array(Math.max(count, windows.length * 2));
		let h = hashAt(s, 0);
		windows[0] = h;
		for (let i = 1; i < count; i++) {
			h = (Math.imul((h - Math.imul(s.charCodeAt(i - 1), LEAD)) | 0, BASE) + s.charCodeAt(i + PREFIX - 1)) | 0;
			windows[i] = h;
		}
		hashed = s;
	}
	const H = windows;
	const union = unionOf(matchers);
	const consider = (groups: Array<IGroup<T>> | undefined, p: number, best: { len: number; needle: string; value: T | undefined; matcher: number }, mi: number): void => {
		if (!groups) return;
		for (const group of groups) {
			if (!s.startsWith(group.prefix, p)) continue;
			for (const entry of group.lengths) {
				if (entry.len <= best.len) break;
				if (p + entry.len > n) continue;
				const candidate = entry.len === group.prefix.length ? group.prefix : s.slice(p, p + entry.len);
				if (entry.needles.has(candidate)) {
					best.len = entry.len;
					best.needle = candidate;
					best.value = entry.needles.get(candidate);
					best.matcher = mi;
					break;
				}
			}
		}
	};
	const best = { len: 0, needle: '', value: undefined as T | undefined, matcher: -1 };
	let p = 0;
	while (p < count) {
		const h1 = H[p];
		best.len = 0;
		if (p + LONG <= n && union.long !== null) {
			const key = pairKey(h1, H[p + PREFIX]);
			if (testBit(union.long, key))
				for (let mi = 0; mi < matchers.length; mi++) {
					const m = matchers[mi];
					if (m.longBits !== null && testBit(m.longBits, key)) consider(m.long.get(key), p, best, mi);
				}
		}
		if (best.len === 0 && union.short !== null && testBit(union.short, h1)) {
			for (let mi = 0; mi < matchers.length; mi++) {
				const m = matchers[mi];
				if (m.shortBits !== null && testBit(m.shortBits, h1)) consider(m.short.get(h1), p, best, mi);
			}
		}
		if (best.len > 0) {
			if (onMatch({ index: p, needle: best.needle, value: best.value as T, matcher: best.matcher }) === false) return;
			if (!overlap) {
				p += best.len;
				continue;
			}
		}
		p++;
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
	let any = false;
	scan(s, matchers, (m) => {
		any = true;
		out += s.slice(last, m.index) + replace(m);
		last = m.index + m.needle.length;
	});
	return any ? out + s.slice(last) : s;
}

/**
 * The matcher's shape, for tests: needles held, the most lengths one group
 * holds (each is one exact lookup at a candidate position, never a scan over
 * needles), and the bound on that number (the distinct needle lengths).
 */
export function matcherShape(m: IMatcher<unknown>): { needles: number; maxLengthsPerGroup: number; lengthBound: number } {
	let max = 0;
	for (const index of [m.long, m.short]) for (const slot of index.values()) for (const group of slot) max = Math.max(max, group.lengths.length);
	return { needles: m.size, maxLengthsPerGroup: max, lengthBound: m.lengths };
}
