/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Run-log segment codec — INTERNAL TypeScript mirror of the Python reference
 * (`rocketride._log_codec`). The storage encoding is plumbing, never public
 * SDK surface: this module is deliberately NOT exported from the package
 * barrel — consumers only ever see reconstructed events via the session.
 *
 * Segments are self-contained containers: each opens with a
 * `{"type":"keyframe"}` preamble line, and interior events may carry DELTA
 * bodies whose base is guaranteed to live in the SAME segment (status deltas
 * against the previous status / keyframe base; trace LEAVE deltas against
 * their paired ENTER).
 */

import type { LogEvent } from './types/log.js';

// =============================================================================
// CONSTANTS / TYPES
// =============================================================================

/** Delta body marker key. */
export const DELTA_KEY = '__delta__';

/** Deleted-keys list key inside a delta. */
export const DELETED_KEY = '__deleted__';

/** One open-frame entry inside a keyframe (compact summary + pointers). */
export interface KeyframeOpenFrame {
	id: number | string;
	component?: string;
	doc?: string;
	enterTime?: number;
	enterSeq?: number;
	/** Segment ids that contain this trace's events (sparse expand list). */
	touched?: number[];
}

/** One recently-closed trace summary inside a keyframe. */
export interface KeyframeClosedTrace {
	doc?: string;
	id: number | string;
	/** Begin-event continuum seq — the trace's permanent identity. */
	beginSeq?: number;
	beginTime?: number;
	elapsed?: number;
	calls?: number;
	touched?: number[];
}

/** The segment keyframe preamble (container metadata, not an event). */
export interface SegmentKeyframe {
	type: 'keyframe';
	ver: number;
	/** False on the first keyframe after a writer restart (state unknown). */
	complete: boolean;
	/** True when the open-frame list hit its sanity ceiling. */
	partial: boolean;
	chapter?: { beginSeq?: number; beginTime?: number } | null;
	/** Full status snapshot at the boundary — the status delta base. */
	status: Record<string, unknown>;
	byPipe: Record<string, string[]>;
	openFrames: KeyframeOpenFrame[];
	closedRecent: KeyframeClosedTrace[];
	console: { lines: string[]; truncated: boolean };
}

// =============================================================================
// DELTA APPLICATION
// =============================================================================

/**
 * Inverse of the writer's shallow delta — reconstruct the full object.
 *
 * Dict-valued fields merge one level deep; keys under `__deleted__` are
 * removed. The base is not mutated.
 *
 * @param base - The base object the delta was computed against.
 * @param changes - The changes object from the delta body.
 * @returns The reconstructed full object.
 */
export function applyShallowDelta(base: unknown, changes: unknown): unknown {
	if (typeof base !== 'object' || base === null || typeof changes !== 'object' || changes === null) {
		return changes;
	}
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	const changeMap = changes as Record<string, unknown>;
	for (const key of (changeMap[DELETED_KEY] as string[] | undefined) ?? []) {
		delete result[key];
	}
	for (const [key, value] of Object.entries(changeMap)) {
		if (key === DELETED_KEY) continue;
		const old = result[key];
		if (value !== null && typeof value === 'object' && !Array.isArray(value) && old !== null && typeof old === 'object' && !Array.isArray(old)) {
			const merged: Record<string, unknown> = { ...(old as Record<string, unknown>) };
			const sub = value as Record<string, unknown>;
			for (const subKey of (sub[DELETED_KEY] as string[] | undefined) ?? []) {
				delete merged[subKey];
			}
			for (const [subKey, subValue] of Object.entries(sub)) {
				if (subKey !== DELETED_KEY) merged[subKey] = subValue;
			}
			result[key] = merged;
		} else {
			result[key] = value;
		}
	}
	return result;
}

// =============================================================================
// SEGMENT DECODER
// =============================================================================

/**
 * Stateful per-segment decoder: resolves delta bodies back to full events.
 *
 * Feed it every line of ONE segment in order (keyframe first). Matching
 * identity for leave deltas mirrors the writer: most-recent open frame of
 * the same (pipe id, component).
 */
export class SegmentDecoder {
	private prevStatus: Record<string, unknown> | null = null;
	/** Per pipe id: stack of [component, enter trace.data as written]. */
	private open = new Map<unknown, Array<[unknown, unknown]>>();

	/** Seed decoder state from a segment's keyframe preamble. */
	seed(keyframe: SegmentKeyframe): void {
		const status = keyframe.status;
		this.prevStatus = status && typeof status === 'object' && Object.keys(status).length > 0 ? status : null;
	}

	/**
	 * Resolve one event's delta body (if any) and update decoder state.
	 *
	 * @param msg - A parsed event line (NOT a keyframe line).
	 * @returns The event with a fully reconstructed body.
	 */
	decode(msg: LogEvent): LogEvent {
		const event = msg.event;
		const body = msg.body as Record<string, unknown> | undefined;

		if (event === 'apaevt_status_update' && body && typeof body === 'object') {
			if (DELTA_KEY in body) {
				const full = applyShallowDelta(this.prevStatus ?? {}, body[DELTA_KEY]) as Record<string, unknown>;
				this.prevStatus = full;
				return { ...msg, body: full as LogEvent['body'] };
			}
			this.prevStatus = body;
			return msg;
		}

		if (event === 'apaevt_flow' && body && typeof body === 'object') {
			const op = body.op;
			const pid = body.id;
			const component = body.component;
			const trace = (body.trace ?? {}) as Record<string, unknown>;
			const data = trace.data;

			if (op === 'begin') {
				if (!this.open.has(pid)) this.open.set(pid, []);
				return msg;
			}
			if (op === 'end') {
				this.open.delete(pid);
				return msg;
			}
			if (op === 'enter') {
				if (!this.open.has(pid)) this.open.set(pid, []);
				this.open.get(pid)!.push([component, data]);
				return msg;
			}
			if (op === 'leave') {
				const stack = this.open.get(pid) ?? [];
				let base: unknown = null;
				for (let i = stack.length - 1; i >= 0; i--) {
					if (stack[i][0] === component) {
						base = stack.splice(i, 1)[0][1];
						break;
					}
				}
				if (data !== null && typeof data === 'object' && DELTA_KEY in (data as Record<string, unknown>)) {
					const fullData = applyShallowDelta(
						base !== null && typeof base === 'object' ? base : {},
						(data as Record<string, unknown>)[DELTA_KEY],
					);
					return { ...msg, body: { ...body, trace: { ...trace, data: fullData } } as unknown as LogEvent['body'] };
				}
				return msg;
			}
		}

		return msg;
	}
}

/**
 * Canonicalize the continuum stamps INTO the body — the single place they
 * live. Current recordings (and the live wire) already carry
 * `body.eventTime` + `body.logSeq`; legacy v2 segments carried the stamps
 * at the header with the continuum under `seq`, so decode moves those into
 * the body once and old data reads identically to new. The DAP envelope is
 * never a source of truth (its `seq` is per-connection bookkeeping).
 *
 * @param msg - A decoded event (mutated in place).
 * @returns The same event with body.eventTime/body.logSeq guaranteed.
 */
export function normalizeStamps(msg: LogEvent): LogEvent {
	let body = msg.body as Record<string, unknown> | undefined;
	if (!body || typeof body !== 'object') {
		body = {};
		(msg as Record<string, unknown>).body = body;
	}
	if (typeof body.eventTime !== 'number' && typeof (msg as Record<string, unknown>).eventTime === 'number') {
		body.eventTime = (msg as Record<string, unknown>).eventTime;
	}
	if (typeof body.logSeq !== 'number' && typeof (msg as Record<string, unknown>).seq === 'number') {
		body.logSeq = (msg as Record<string, unknown>).seq;
	}
	return msg;
}

/**
 * Parse one whole-line-aligned raw segment chunk into keyframe + events,
 * decoding deltas through the supplied decoder.
 *
 * @param text - Raw JSONL text (every line complete — the fetch guarantees it).
 * @param decoder - The segment's decoder (carries state across chunks).
 * @returns The keyframe (when this chunk contained it) and decoded events.
 */
export function parseSegmentChunk(
	text: string,
	decoder: SegmentDecoder,
): { keyframe: SegmentKeyframe | null; events: LogEvent[] } {
	let keyframe: SegmentKeyframe | null = null;
	const events: LogEvent[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (msg.type === 'keyframe') {
			keyframe = msg as unknown as SegmentKeyframe;
			decoder.seed(keyframe);
			continue;
		}
		events.push(normalizeStamps(decoder.decode(msg as unknown as LogEvent)));
	}
	return { keyframe, events };
}
