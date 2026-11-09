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

// =============================================================================
// CANARY: find secret values on a surface without holding or printing them
// =============================================================================

/**
 * canary_absent looks for secret values on six surfaces: the questions sent to
 * the model, the thinking rows, the answer, the saved session file, the
 * session catalog and the workspace files. The scan works on fingerprints, not
 * values: each value's length, two rolling hashes and its sha256. The trial
 * process gets only fingerprints, so it never holds a real key, and a report
 * names a Variable and a surface, never what matched.
 *
 * For L3 the fingerprints of the engine's Variables are made by a process that
 * holds the keys (`fingerprint` in run.ts, run with the keys in its
 * environment). For L1 and L2 the Variables are synthetic and made here.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { CanaryScan, ScenarioCheck } from './types';

// =============================================================================
// FINGERPRINTS
// =============================================================================

/** One secret value, as the scanner knows it. */
export interface Fingerprint {
	/** What the report calls it: the Variable's name. */
	name: string;
	length: number;
	h1: number;
	h2: number;
	sha256: string;
}

const P1 = 1_000_000_007;
const P2 = 998_244_353;
const BASE = 131;

/** The two rolling hashes of a text. Codes are UTF-16 units; every term stays under 2^53. */
function hashes(text: string): [number, number] {
	let a = 0;
	let b = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = (a * BASE + c) % P1;
		b = (b * BASE + c) % P2;
	}
	return [a, b];
}

/** (BASE^n) mod p. */
function power(n: number, p: number): number {
	let r = 1;
	for (let i = 0; i < n; i++) r = (r * BASE) % p;
	return r;
}

function sha(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Fingerprints a value.
 *
 * @param name - What the report calls it.
 * @param value - The value; it is not kept.
 * @returns The fingerprint.
 */
export function fingerprint(name: string, value: string): Fingerprint {
	const [h1, h2] = hashes(value);
	return { name, length: value.length, h1, h2, sha256: sha(value) };
}

/**
 * Synthetic values for the run's Variables, for an engine that has no real ones.
 *
 * @param names - The Variable names.
 * @returns Name to value. Each value is unique to this run.
 */
export function syntheticVariables(names: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of names) out[name] = `rrEvalVar${randomBytes(12).toString('hex')}`;
	return out;
}

// =============================================================================
// SCRUB: what may be written to disk or printed
// =============================================================================

/** Strings shaped like provider keys. */
const KEY_SHAPES = [/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/g, /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g];

/**
 * Blanks every key-shaped string in a text, so a key that leaked into an
 * answer or a file never reaches a record or a report. Synthetic eval values
 * are left as they are: they are not secrets, and the scan names them anyway.
 *
 * @param text - Any text.
 * @returns The text with key-shaped strings replaced by [redacted].
 */
export function scrub(text: string): string {
	let out = text;
	for (const re of KEY_SHAPES) out = out.replace(re, '[redacted]');
	return out;
}

/**
 * Scrubs every string in a JSON value.
 *
 * @param value - Any JSON value.
 * @returns A copy with key-shaped strings blanked.
 */
export function scrubDeep<T>(value: T): T {
	return JSON.parse(JSON.stringify(value), (_k, v: unknown) => (typeof v === 'string' ? scrub(v) : v)) as T;
}

// =============================================================================
// SCAN
// =============================================================================

/**
 * Counts each fingerprinted value in a text: a rolling-hash pass per length,
 * and sha256 on each hash match, so a collision never counts.
 *
 * @param text - The surface's text.
 * @param prints - What to look for.
 * @returns Name to count, for the values seen.
 */
export function scanText(text: string, prints: Fingerprint[]): Map<string, number> {
	const found = new Map<string, number>();
	const byLength = new Map<number, Fingerprint[]>();
	for (const p of prints) if (p.length > 0) byLength.set(p.length, [...(byLength.get(p.length) ?? []), p]);
	for (const [len, group] of byLength) {
		if (text.length < len) continue;
		const top1 = power(len - 1, P1);
		const top2 = power(len - 1, P2);
		let [a, b] = hashes(text.slice(0, len));
		for (let i = 0; ; i++) {
			for (const p of group) {
				if (p.h1 === a && p.h2 === b && sha(text.slice(i, i + len)) === p.sha256) found.set(p.name, (found.get(p.name) ?? 0) + 1);
			}
			if (i + len >= text.length) break;
			const out = text.charCodeAt(i);
			const inc = text.charCodeAt(i + len);
			a = (((a - ((out * top1) % P1) + P1) % P1) * BASE + inc) % P1;
			b = (((b - ((out * top2) % P2) + P2) % P2) * BASE + inc) % P2;
		}
	}
	return found;
}

/** Collects a canary_absent check's hits as the surfaces are read. */
export class CanaryScanner {
	private readonly hits = new Map<string, number>();
	private readonly scanned = new Set<string>();
	private readonly missing = new Map<string, string>();

	constructor(
		private readonly check: ScenarioCheck,
		private readonly prints: Fingerprint[]
	) {}

	/** The surfaces this check reads. */
	get surfaces(): string[] {
		return (this.check.surfaces as string[]) ?? [];
	}

	/**
	 * Scans one piece of a surface. Pieces of one surface add up.
	 *
	 * @param surface - The surface the text belongs to.
	 * @param text - The text.
	 */
	scan(surface: string, text: string): void {
		if (!this.surfaces.includes(surface)) return;
		this.scanned.add(surface);
		this.missing.delete(surface);
		for (const [name, n] of scanText(text, this.prints)) this.hits.set(`${surface}\u0000${name}`, (this.hits.get(`${surface}\u0000${name}`) ?? 0) + n);
	}

	/**
	 * Marks a surface as unreadable, unless some of it was read.
	 *
	 * @param surface - The surface.
	 * @param why - Why it could not be read.
	 */
	unreadable(surface: string, why: string): void {
		if (this.surfaces.includes(surface) && !this.scanned.has(surface)) this.missing.set(surface, why);
	}

	/** Marks a surface as read even when it had nothing in it (an empty answer is a surface with no leak). */
	empty(surface: string): void {
		if (this.surfaces.includes(surface)) {
			this.scanned.add(surface);
			this.missing.delete(surface);
		}
	}

	/** The result, by name and surface only. */
	result(): CanaryScan {
		for (const s of this.surfaces) if (!this.scanned.has(s) && !this.missing.has(s)) this.missing.set(s, 'never produced');
		return {
			surfaces: this.surfaces,
			scanned: [...this.scanned],
			missing: [...this.missing].map(([surface, why]) => ({ surface, why })),
			hits: [...this.hits].map(([key, count]) => {
				const [surface, canary] = key.split('\u0000');
				return { surface, canary, count };
			}),
			values: this.prints.length,
		};
	}
}
