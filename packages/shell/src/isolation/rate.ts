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
// RATE — per-realm buckets, quotas and size caps (plan section 4.2 and 4.3)
// =============================================================================

/** Size caps, in bytes unless named otherwise. */
export const SIZES = {
	/** One inbound request (UTF-8 JSON, binary members excluded). */
	request: 256 * 1024,
	/** One response to a realm (JSON plus binary). */
	response: 8 * 1024 * 1024,
	/** One binary member, and all binary members of one request together. */
	bytes: 8 * 1024 * 1024,
	/** A `json` argument. */
	json: 256 * 1024,
	/** One pref value. */
	prefValue: 16 * 1024,
	/** Pref key length, in characters. */
	prefKey: 64,
	/** Distinct pref keys per realm. */
	prefKeys: 256,
	/** `shell.notify` text, in characters. */
	notify: 200,
	/** `shell.statusMessage` text, in characters. */
	status: 120,
	/** A `string` argument, in UTF-8 bytes. */
	string: 4096,
	/** Names, sources, modes and subcommands, in UTF-8 bytes. */
	name: 128,
	/** Largest `fs_read.length` (the SDK default; the server clamps to it too). */
	fsRead: 4 * 1024 * 1024,
	/** Any one inbound string, in characters, checked before it is scanned (an 8 MiB base64 payload plus slack). */
	stringCeiling: Math.ceil((8 * 1024 * 1024 * 4) / 3) + 1024,
} as const;

/** Per-realm quotas (`quota`); `inflight` is reported as `rate`. */
export const QUOTAS = {
	runs: 8,
	pipes: 16,
	fsHandles: 32,
	monitorKeys: 16,
	registeredOps: 64,
	topics: 64,
	inflight: 32,
} as const;

/** The request bucket: a burst of 100, refilled at 20 per second. */
const REQUEST_BURST = 100;
const REQUEST_PER_MS = 20 / 1000;

/** Ops limited to one call per interval (ms). */
export const INTERVALS: Readonly<Record<string, number>> = {
	'shell.notify': 2000,
	'shell.openExternal': 2000,
	'shell.loginRequest': 10_000,
	'shell.frameToken.refresh': 60_000,
};

export interface IRateLimiter {
	/** Takes one unit from `bucket` (`request`, or an op of {@link INTERVALS}); false when empty. */
	allow(bucket: string): boolean;
}

/**
 * Buckets over an injectable clock. An unknown bucket name is refused.
 *
 * @param now - The clock (ms).
 * @returns The limiter.
 */
export function createRateLimiter(now: () => number): IRateLimiter {
	let tokens = REQUEST_BURST;
	let refilledAt = now();
	const lastCall = new Map<string, number>();
	return {
		allow(bucket) {
			const t = now();
			if (bucket === 'request') {
				tokens = Math.min(REQUEST_BURST, tokens + Math.max(0, t - refilledAt) * REQUEST_PER_MS);
				refilledAt = t;
				if (tokens < 1) return false;
				tokens -= 1;
				return true;
			}
			const interval = INTERVALS[bucket];
			if (interval === undefined) return false;
			const last = lastCall.get(bucket);
			if (last !== undefined && t - last < interval) return false;
			lastCall.set(bucket, t);
			return true;
		},
	};
}
