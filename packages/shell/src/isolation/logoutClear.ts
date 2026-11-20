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
// LOGOUT CLEAR — the planner for wiping app-origin storage (PR2b, plan §4.7)
// =============================================================================
//
// After `teardownAll`, open frames navigate to `<origin>/_rr/frame.html#clear`
// (the guest boot sends them on to `/_rr/clear`), every other origin listed in
// `rr:isolation:visited` gets a hidden sweep frame (4 at a time, 2 s each), and
// the list is forgotten. The list lives in shell `localStorage`, so every
// origin in it is re-validated as a plain http(s) origin before use.
// =============================================================================

import { SWEEP_SANDBOX } from './frameAttrs';

/** The `localStorage` key of the visited record. */
export const VISITED_KEY = 'rr:isolation:visited';

/** What `rr:isolation:visited` holds. */
export interface IVisitedRecord {
	/** sha256(userId), hex. */
	owner: string;
	origins: string[];
}

/** The steps of one logout clear. */
export interface ILogoutClearPlan {
	navigate: string[];
	sweep: string[];
	sweepSandbox: string;
	parallel: number;
	timeoutMs: number;
	forgetVisited: true;
}

/** A plain http(s) origin (no path, query, fragment or userinfo), or null. */
export function plainOrigin(raw: unknown): string | null {
	if (typeof raw !== 'string' || !raw) return null;
	try {
		const u = new URL(raw);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		return u.origin === raw ? raw : null;
	} catch {
		return null;
	}
}

function origins(list: readonly unknown[]): string[] {
	const out = new Set<string>();
	for (const o of Array.isArray(list) ? list : []) {
		const p = plainOrigin(o);
		if (p) out.add(p);
	}
	return [...out];
}

/** Plans the clear for the open frames' origins and the visited list. */
export function planLogoutClear(input: { open: readonly unknown[]; visited: readonly unknown[] }): ILogoutClearPlan {
	const open = origins(input.open);
	const openSet = new Set(open);
	return {
		navigate: open.map((o) => `${o}/_rr/frame.html#clear`),
		sweep: origins(input.visited).filter((o) => !openSet.has(o)),
		sweepSandbox: SWEEP_SANDBOX,
		parallel: 4,
		timeoutMs: 2000,
		forgetVisited: true,
	};
}

/** The record to store: origins deduplicated and sorted. */
export function visitedRecord(ownerHash: string, list: readonly string[]): IVisitedRecord {
	return { owner: ownerHash, origins: [...new Set(list)].sort() };
}

function isRecord(r: unknown): r is IVisitedRecord {
	if (r === null || typeof r !== 'object') return false;
	const v = r as Record<string, unknown>;
	return typeof v.owner === 'string' && Array.isArray(v.origins) && v.origins.every((o) => typeof o === 'string');
}

/**
 * The boot-time sweep (plan "Missed sweeps"): sweep the stored origins when
 * the boot is signed out or a different user signed in. A malformed record
 * is swept (fail closed).
 */
export function shouldSweepAtBoot(input: { record: unknown; signedIn: boolean; ownerHash: string | null }): boolean {
	const { record } = input;
	if (record === null || record === undefined) return false;
	if (!isRecord(record)) return true;
	if (record.origins.length === 0) return false;
	if (!input.signedIn) return true;
	return input.ownerHash !== record.owner;
}
