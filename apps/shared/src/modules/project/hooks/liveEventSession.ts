// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

/**
 * In-memory live-edge session.
 *
 * `useTaskEvents` reads every accumulating pane (Trace, Errors, Status, Tokens,
 * Flow, Log, Analyze) through a {@link TaskEventSession}. That session is
 * normally the server-backed DVR stream the host opens via `openEventStream`,
 * which can seek through *recorded* runs.
 *
 * Hosts that do not (yet) bridge `openEventStream` across their transport used
 * to pass `null`, and `useTaskEvents.ingestLive` then dropped every event on the
 * floor — the panes rendered their empty states while a run was executing, with
 * no error anywhere. This implements the same interface over the live events the
 * host already delivers, so those panes work at the live edge with no server
 * round-trip.
 *
 * Store vs view: `SourceSection` opens the factory more than once — once for the
 * pane session, and again per export (`fetchChapterEvents` walks a private
 * session so its seeking cannot disturb the live one). So the buffer lives in a
 * STORE, and each `open()` returns an independent VIEW with its own delivery
 * watermark and sink over that shared buffer.
 *
 * What this deliberately does NOT do: replay. There is no recorded history to
 * seek into, only what has been observed since the section mounted. Wire up the
 * real `openEventStream` for DVR.
 */

import type { TaskEventMessage, TaskEventSession } from './useTaskEvents';

/**
 * Retained live events. Past this the oldest fifth is dropped in one splice,
 * mirroring the fold's own backstop in `useTaskEvents` so a long-running task
 * cannot grow the buffer without bound.
 */
export const LIVE_BUFFER_CAP = 20_000;

/** How many are dropped when the cap is hit. */
const TRIM_COUNT = LIVE_BUFFER_CAP / 5;

/** Delivery sink registered by `play`. */
type Sink = (item: { event: TaskEventMessage }) => void;

/** A live session view, plus the introspection its callers and tests need. */
export interface LiveEventSession extends TaskEventSession {
	/** Number of events currently retained by the shared store. */
	readonly size: number;
	/**
	 * Event time of the newest evicted event once the cap has bitten, else
	 * null. Callers surface this as coverage honesty rather than silently
	 * showing a truncated run.
	 */
	readonly truncatedBefore: number | null;
}

/** Shared buffer behind one stream identity. */
export interface LiveEventStore {
	/** Open an independent view (own watermark and sink) over the buffer. */
	open(): LiveEventSession;
	/** Retained event count — for tests and diagnostics. */
	readonly size: number;
}

const eventTimeOf = (message: TaskEventMessage): number => Number(message.body?.eventTime ?? 0);
const seqOf = (message: TaskEventMessage): number => Number(message.body?.logSeq ?? 0);

/**
 * Create a store for one stream identity.
 *
 * Ordering contract: `useTaskEvents.deliver` is a pure append — no sort, no
 * dedupe — so a view must hand events over exactly once, oldest first. The
 * per-view watermark is what guarantees that across repeated `play` calls.
 */
export function createLiveEventStore(): LiveEventStore {
	let buffer: TaskEventMessage[] = [];
	let evictedBefore: number | null = null;
	/** Views are notified on ingest so a playing view delivers immediately. */
	const views = new Set<{ drain: () => void; shift: (count: number) => void }>();

	const ingest = (message: TaskEventMessage): void => {
		buffer.push(message);
		if (buffer.length > LIVE_BUFFER_CAP) {
			const dropped = buffer.slice(0, TRIM_COUNT);
			buffer = buffer.slice(TRIM_COUNT);
			evictedBefore = eventTimeOf(dropped[dropped.length - 1]);
			for (const view of views) view.shift(TRIM_COUNT);
		}
		for (const view of views) view.drain();
	};

	const open = (): LiveEventSession => {
		/** Index of the next event this view delivers. */
		let watermark = 0;
		let sink: Sink | null = null;
		let attached = true;

		const drain = (): void => {
			if (!sink) return;
			while (watermark < buffer.length) {
				const message = buffer[watermark];
				watermark++;
				sink({ event: message });
			}
		};
		const shift = (count: number): void => {
			watermark = Math.max(0, watermark - count);
		};

		const handle = { drain, shift };
		views.add(handle);

		const session: LiveEventSession = {
			get size() {
				return buffer.length;
			},

			get truncatedBefore() {
				return evictedBefore;
			},

			/**
			 * Move this view's watermark. 'live' means the tail — everything
			 * already observed counts as delivered. A numeric position rewinds
			 * to the first retained event at-or-after it, which is as far back
			 * as a live-only session can honestly go.
			 */
			async seek(pos: number | 'live'): Promise<void> {
				if (pos === 'live') {
					watermark = buffer.length;
					return;
				}
				let index = 0;
				while (index < buffer.length && eventTimeOf(buffer[index]) < pos) index++;
				watermark = index;
			},

			/**
			 * The most recent status snapshot at-or-before this view's position,
			 * or null when none has arrived — the hook falls back to its own seed
			 * in that case. Scanning back from the watermark rather than the live
			 * edge is what makes it honour a `seek()` to an earlier anchor: the
			 * hook calls this straight after seeking, and the live-edge status
			 * would otherwise seed a replayed run with the current one.
			 */
			async getStatus(): Promise<Record<string, unknown> | null> {
				for (let index = Math.min(watermark, buffer.length) - 1; index >= 0; index--) {
					const message = buffer[index];
					if (message.event === 'apaevt_status' || message.event === 'apaevt_status_update') {
						return (message.body ?? null) as Record<string, unknown> | null;
					}
				}
				return null;
			},

			/**
			 * Register the sink and drain. Speed is ignored: live events are
			 * already paced by the wall clock and there is no recorded span to
			 * replay at a multiple of it. The sink stays registered afterwards
			 * so later arrivals reach the fold immediately rather than waiting
			 * for the hook's next nudge.
			 */
			async play(pos: number | 'live' | undefined, _speed: number, cb: Sink): Promise<void> {
				if (pos !== undefined) await session.seek(pos);
				sink = cb;
				drain();
			},

			/**
			 * One trace's events. Identity is the BEGIN event's continuum seq,
			 * the same rule the server-backed session uses, so a `traceId` taken
			 * from a rendered row resolves here unchanged.
			 */
			async getTrace(traceId: number): Promise<{ events: TaskEventMessage[] }> {
				const beginIndex = buffer.findIndex((message) => message.event === 'apaevt_flow' && message.body?.op === 'begin' && seqOf(message) === traceId);
				if (beginIndex < 0) return { events: [] };

				const pipe = buffer[beginIndex].body?.id;
				const events: TaskEventMessage[] = [];
				for (let index = beginIndex; index < buffer.length; index++) {
					const message = buffer[index];
					if (message.event !== 'apaevt_flow' || message.body?.id !== pipe) continue;
					// A later `begin` on the same pipe slot is the NEXT request
					// reusing it — the pipe id is a slot, not an identity.
					if (index > beginIndex && message.body?.op === 'begin') break;
					events.push(message);
					if (message.body?.op === 'end') break;
				}
				return { events };
			},

			/** Stop delivering to this view; `play` resumes from the watermark. */
			pause(): void {
				sink = null;
			},

			/**
			 * Buffer one live event. Ingest is store-wide: every open view sees
			 * it, which is what keeps an export walker consistent with the pane.
			 */
			ingestLive(message: TaskEventMessage): void {
				if (!attached) return;
				ingest(message);
			},

			/**
			 * Detach this view. The store's buffer survives so sibling views
			 * (an in-flight export) keep working; the store itself is dropped
			 * by whoever owns the stream identity.
			 */
			closeEventStream(): void {
				sink = null;
				attached = false;
				views.delete(handle);
			},
		};

		return session;
	};

	return {
		open,
		get size() {
			return buffer.length;
		},
	};
}

/** Convenience for a store with exactly one view — used by tests. */
export function createLiveEventSession(): LiveEventSession {
	return createLiveEventStore().open();
}
