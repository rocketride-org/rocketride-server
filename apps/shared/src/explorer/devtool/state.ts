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
// EXPLORER DEV TOOL — RETAINED STATE SIZE (bulk results are op results, R4/T11)
// =============================================================================
//
// Retained channel state is cheap only while it is small, and its cost is the
// WHOLE map, not one topic:
//
//   - the sidebar peer keeps ONE retained map of every state topic and
//     republishes the whole map on every publish (busPeer.ts stateMap);
//   - the VS Code bridge posts that whole map, as JSON, to every frame realm
//     on every publish (busBridge.ts), so a frame's `onState` handlers are
//     re-run for EVERY topic on EVERY publish of ANY topic. Lanes' state
//     handlers must therefore be idempotent (rocket-ui, one realm, forwards
//     only the changed entry; do not rely on that);
//   - every frame replays the map when it attaches.
//
// So lanes publish SUMMARIES that are bounded by construction (endpoints,
// schemas by key, identity, previews), and anything bulky (graph rows,
// vector samples of up to ~1.2 MB) travels as an op RESULT, to the one frame
// that asked.
//
// The guard is the backstop, and it DEGRADES rather than withholds:
//
//   MAX_RETAINED_STATE_BYTES   64 KiB of JSON per snapshot
//   MAX_RETAINED_TOTAL_BYTES  128 KiB across every topic published through the
//                             guard (it tracks the last size per topic)
//
// An oversize publish is replaced by a bounded one: the lane's `shrink(topic,
// snapshot, info)` when given, else `truncateLists`, which cuts the largest
// list properties and records `truncated: { <prop>: { kept, total } }` in the
// snapshot (snapshots published through the guard reserve the key
// `truncated`). Only when nothing fits is the snapshot withheld; `withhold:
// true` makes withholding the rule, and `strict: true` throws (for tests). By
// default nothing is ever thrown into the publisher (often a store
// subscriber). `onOversize` reports every case, with its outcome.
// =============================================================================

import type { ToolChannel } from 'shell';

/** The largest JSON (in UTF-8 bytes) one retained state snapshot may have. */
export const MAX_RETAINED_STATE_BYTES = 64 * 1024;

/** The largest JSON (in UTF-8 bytes) of every topic published through one guard, together: the size of each republished map. */
export const MAX_RETAINED_TOTAL_BYTES = 128 * 1024;

/**
 * The size of a value as it crosses the wire: the UTF-8 bytes of its JSON.
 *
 * @param value - Anything JSON can serialise.
 * @returns The byte length (0 when JSON drops the value entirely).
 */
export function jsonByteLength(value: unknown): number {
	const text = JSON.stringify(value);
	return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

/** What the guard did with an oversize snapshot. */
export type OversizeOutcome = 'degraded' | 'withheld' | 'thrown';

/** A state snapshot too large to be retained as it is (it belongs in an op result, or in a summary). */
export class RetainedStateTooLargeError extends RangeError {
	/** The state topic. */
	readonly topic: string;

	/** The snapshot's JSON size in bytes. */
	readonly bytes: number;

	/** The budget it exceeded (the per-snapshot cap, or what the total budget left). */
	readonly maxBytes: number;

	/** Which limit: the snapshot cap, or the total across topics. */
	readonly reason: 'snapshot' | 'total';

	/** What the guard did (set by guardRetainedState; absent from assertRetainedStateSize). */
	outcome?: OversizeOutcome;

	/**
	 * @param topic - The state topic.
	 * @param bytes - The snapshot's size.
	 * @param maxBytes - The budget.
	 * @param reason - Which limit.
	 */
	constructor(topic: string, bytes: number, maxBytes: number, reason: 'snapshot' | 'total' = 'snapshot') {
		super(reason === 'snapshot'
			? `State '${topic}' is ${bytes} bytes of JSON, over the ${maxBytes}-byte cap for retained state; publish a bounded summary and send bulk data as an op result.`
			: `State '${topic}' is ${bytes} bytes of JSON, over the ${maxBytes} bytes the total retained-state budget leaves it; keep topics few and small.`);
		this.name = 'RetainedStateTooLargeError';
		this.topic = topic;
		this.bytes = bytes;
		this.maxBytes = maxBytes;
		this.reason = reason;
		Object.setPrototypeOf(this, RetainedStateTooLargeError.prototype);
	}
}

/**
 * Check a snapshot fits the retained-state cap.
 *
 * @param topic - The state topic (named in the error).
 * @param snapshot - The snapshot.
 * @param maxBytes - The cap (default {@link MAX_RETAINED_STATE_BYTES}).
 * @returns The snapshot's size in bytes.
 * @throws RetainedStateTooLargeError when it does not fit.
 */
export function assertRetainedStateSize(topic: string, snapshot: unknown, maxBytes: number = MAX_RETAINED_STATE_BYTES): number {
	const bytes = jsonByteLength(snapshot);
	if (bytes > maxBytes) throw new RetainedStateTooLargeError(topic, bytes, maxBytes);
	return bytes;
}

/**
 * The longest prefix of a list whose JSON (inside `wrap`) fits a budget.
 *
 * @param list - The list.
 * @param fits - Whether a candidate prefix fits.
 * @returns How many items to keep.
 */
function longestPrefix(list: readonly unknown[], fits: (prefix: unknown[]) => boolean): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(list.slice(0, mid))) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * The default shrink: cut list-valued properties (largest first) to the
 * longest prefixes that fit, and say so in `truncated: { <prop>: { kept,
 * total } }`. A top-level list keeps its longest fitting prefix (it cannot
 * carry the marker: publish objects when the frames must be told).
 *
 * @param snapshot - The snapshot.
 * @param budgetBytes - The JSON bytes it may have.
 * @returns The (possibly) cut snapshot, and whether anything was cut. Anything
 *   that is not a list or an object with list properties comes back as it was.
 */
export function truncateLists(snapshot: unknown, budgetBytes: number): { snapshot: unknown; truncated: boolean } {
	if (jsonByteLength(snapshot) <= budgetBytes) return { snapshot, truncated: false };
	if (Array.isArray(snapshot)) {
		const kept = longestPrefix(snapshot, (prefix) => jsonByteLength(prefix) <= budgetBytes);
		return { snapshot: snapshot.slice(0, kept), truncated: kept < snapshot.length };
	}
	if (snapshot === null || typeof snapshot !== 'object' || Object.getPrototypeOf(snapshot) !== Object.prototype) return { snapshot, truncated: false };
	const source = snapshot as Record<string, unknown>;
	const lists = Object.keys(source)
		.filter((key) => key !== 'truncated' && Array.isArray(source[key]))
		.sort((a, b) => jsonByteLength(source[b]) - jsonByteLength(source[a]));
	if (lists.length === 0) return { snapshot, truncated: false };
	const result: Record<string, unknown> = { ...source };
	const marks: Record<string, { kept: number; total: number }> = {};
	const build = (): Record<string, unknown> => ({ ...result, truncated: { ...marks } });
	for (const key of lists) {
		if (Object.keys(marks).length > 0 && jsonByteLength(build()) <= budgetBytes) break;
		const full = source[key] as unknown[];
		const kept = longestPrefix(full, (prefix) => {
			const trial = { ...result, [key]: prefix, truncated: { ...marks, [key]: { kept: prefix.length, total: full.length } } };
			return jsonByteLength(trial) <= budgetBytes;
		});
		result[key] = full.slice(0, kept);
		marks[key] = { kept, total: full.length };
	}
	return { snapshot: build(), truncated: true };
}

/** What a shrink hook is told. */
export interface IOversizeInfo {
	/** The snapshot's JSON size. */
	bytes: number;
	/** The per-snapshot cap. */
	maxBytes: number;
	/** What this publish may use: the cap, or less when the total budget is the limit. */
	budgetBytes: number;
	/** Which limit was hit. */
	reason: 'snapshot' | 'total';
}

/** How {@link guardRetainedState} handles an oversize snapshot. */
export interface IStateGuardOptions {
	/** The per-snapshot cap (default {@link MAX_RETAINED_STATE_BYTES}). */
	maxBytes?: number;
	/** The budget across every topic published through this guard (default {@link MAX_RETAINED_TOTAL_BYTES}). */
	maxTotalBytes?: number;
	/**
	 * Build the bounded snapshot to publish instead (a summary, a truncated
	 * list with a count). When omitted, or when its result still does not fit,
	 * {@link truncateLists} is applied.
	 */
	shrink?: (topic: string, snapshot: unknown, info: IOversizeInfo) => unknown;
	/** Told about every oversize snapshot, with its `outcome`. */
	onOversize?: (error: RetainedStateTooLargeError) => void;
	/** Refuse oversize snapshots instead of degrading them (opt-in; the frames keep the previous one). */
	withhold?: boolean;
	/** Throw instead (for tests that pin "never retained"). */
	strict?: boolean;
}

/** A guarded channel, with the sizes it has published. */
export interface IGuardedStateChannel extends ToolChannel {
	/** The JSON size of the last snapshot per topic, and their total. */
	retainedBytes(): { total: number; byTopic: Record<string, number> };
}

/**
 * A channel whose `publishState` keeps every snapshot within the per-snapshot
 * cap and the total budget, degrading an oversize one (see the header).
 * Everything else is the original channel.
 *
 * @param channel - The controller's channel.
 * @param opts - Caps, shrink and reporting.
 * @returns The guarded channel.
 */
export function guardRetainedState(channel: ToolChannel, opts: IStateGuardOptions = {}): IGuardedStateChannel {
	const maxBytes = opts.maxBytes ?? MAX_RETAINED_STATE_BYTES;
	const maxTotalBytes = opts.maxTotalBytes ?? MAX_RETAINED_TOTAL_BYTES;
	const sizes: Record<string, number> = {};
	const total = (): number => Object.values(sizes).reduce((sum, size) => sum + size, 0);

	const publish = (topic: string, snapshot: unknown, bytes: number): void => {
		channel.publishState(topic, snapshot);
		sizes[topic] = bytes;
	};

	return {
		publishState(topic, snapshot) {
			const bytes = jsonByteLength(snapshot);
			const others = total() - (sizes[topic] ?? 0);
			const budgetBytes = Math.max(0, Math.min(maxBytes, maxTotalBytes - others));
			if (bytes <= budgetBytes) {
				publish(topic, snapshot, bytes);
				return;
			}
			const reason = bytes > maxBytes ? 'snapshot' : 'total';
			const error = new RetainedStateTooLargeError(topic, bytes, reason === 'snapshot' ? maxBytes : budgetBytes, reason);
			if (opts.strict) {
				error.outcome = 'thrown';
				throw error;
			}
			if (!opts.withhold) {
				let replacement = opts.shrink ? opts.shrink(topic, snapshot, { bytes, maxBytes, budgetBytes, reason }) : snapshot;
				replacement = truncateLists(replacement, budgetBytes).snapshot;
				const size = jsonByteLength(replacement);
				if (replacement !== undefined && size <= budgetBytes) {
					error.outcome = 'degraded';
					opts.onOversize?.(error);
					publish(topic, replacement, size);
					return;
				}
			}
			error.outcome = 'withheld';
			opts.onOversize?.(error);
		},
		onState: (topic, cb) => channel.onState(topic, cb),
		sendEvent: (name, payload) => channel.sendEvent(name, payload),
		onEvent: (name, cb) => channel.onEvent(name, cb),
		retainedBytes: () => ({ total: total(), byTopic: { ...sizes } }),
	};
}
