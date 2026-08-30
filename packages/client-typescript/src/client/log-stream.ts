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
 * LogEventStream — the DVR session over one source continuum.
 *
 * The PUBLIC replay/monitoring surface: consumers think in positions,
 * chapters, traces, and console — segments, keyframes, and deltas are
 * invisible internals. Everything is relative to the session's position.
 *
 * PROTOCOL (seed-then-stream): `seek(pos)` positions the session; the
 * `get*()` calls seed panels from state-at-position (each answer is "as of
 * seq S" — the watermark); `play(speed, cb)` then delivers reconstructed
 * events strictly AFTER the watermark, in order, paced by speed (0 = as
 * fast as possible, 1 = real time, 10 = 10×). Playing from a past position
 * AUTO-PINS on catching the wall clock — replay flows into live with no
 * seam. Live is not a separate mode: it is the position pinned to now.
 */

import type { RocketRideClient } from './client.js';
import type { LogChaptersResult, LogEvent, LogPlayCallback, LogPosition, LogStreamRef, LogTraceDetail, LogTraceSummary, LogTracesResult } from './types/log.js';
import { SegmentDecoder, parseSegmentChunk, type SegmentKeyframe } from './log-codec.js';

// =============================================================================
// INTERNAL TYPES / CONSTANTS
// =============================================================================

/** One cached (decoded) segment; the decoder persists for active growth. */
interface CachedSegment {
	id: number;
	keyframe: SegmentKeyframe | null;
	events: LogEvent[];
	decoder: SegmentDecoder;
	/** Byte offset to continue fetching from (active segments grow). */
	nextOffset: number | null;
	/** True when the fetch reached the segment's end at fetch time. */
	final: boolean;
}

/** Timeline cache lifetime — chapters/segments are one small server read. */
const TIMELINE_TTL_MS = 5_000;

/** Max traces a getTraces() call may request (the recency-window contract). */
const MAX_TRACES = 50;

/** Batch size between event-loop yields when playing at speed 0. */
const FLAT_OUT_BATCH = 250;

/**
 * Live-bucket split trigger (approx serialized bytes retained): crossing it
 * reloads the catalog and SPLITS the bucket — events provably covered by a
 * SEALED server segment (seq below the active segment's first seq) drop out
 * (they are fetchable as real segments now); the still-buffered suffix
 * stays. Residue is therefore at most the active segment (~16MB), so the
 * trigger always frees the sealed portion — the bucket stays bounded
 * through an arbitrarily long live watch.
 */
const LIVE_BUCKET_SPLIT_BYTES = 24 * 1024 * 1024;

/**
 * The live bucket's segment id — sorts AFTER every server segment id, so
 * ordered walks (pump, trace collection) reach it last, exactly like the
 * newest segment it conceptually is.
 */
const LIVE_BUCKET_ID = Number.MAX_SAFE_INTEGER;

/**
 * Resident decoded-segment cap. Eviction is LEAST RECENTLY USED — every
 * real access pattern (playback, seeded folds, trace expansion) touches the
 * segments that matter for the current position, so recency tracks the
 * needle without position math. Evicted segments re-materialize with one
 * raw fetch (sealed segments are immutable).
 */
const MAX_RESIDENT_SEGMENTS = 6;

// =============================================================================
// SESSION
// =============================================================================

/**
 * A stateful DVR session over one source continuum.
 *
 * Create via {@link LogApi.openEventStream}; dispose with
 * {@link closeEventStream}.
 */
export class LogEventStream {
	private timeline: LogChaptersResult | null = null;
	private timelineAt = 0;
	private cache = new Map<number, CachedSegment>();
	/**
	 * The LIVE BUCKET — incoming live events held as a segment like any
	 * other: it sorts after every server segment, its span is its events'
	 * seq range, and every read/walk iterates it uniformly. It shrinks by
	 * SPLITTING: events the server provably holds (sealed segments per the
	 * catalog, or a fetched active-segment prefix) drop out; the
	 * still-buffered suffix remains.
	 *
	 * INVARIANT: the bucket is NEVER discarded. Nothing leaves it except a
	 * PROVABLY server-backed prefix (sealed per a fresh catalog, or bytes
	 * actually fetched from disk) and exact duplicate arrivals — no size
	 * cap, no age cap, no drop-on-error. Unbacked events outlive any
	 * failure short of closing the session.
	 */
	private live: CachedSegment = { id: LIVE_BUCKET_ID, keyframe: null, events: [], decoder: new SegmentDecoder(), nextOffset: null, final: false };
	/** Approximate serialized size of the bucket + split-in-flight guard. */
	private liveBytes = 0;
	private reconciling = false;
	/** Highest seq ever fetched from disk — arrivals at/below it are already stored. */
	private maxDiskSeq = 0;

	/** The DVR position (epoch seconds) and whether it is pinned to now. */
	private basePos = 0;
	private pinned = false;
	/** Seed watermark: get*() answers are as-of this seq; play delivers > it. */
	private watermark = 0;

	private playing = false;
	private speed = 1;
	private callback: LogPlayCallback | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Monotonic pump generation — stale delivery loops retire themselves. */
	private pumpEpoch = 0;
	private closed = false;

	/** @param client - Owning client. @param stream - Identity tuple. */
	constructor(
		private client: RocketRideClient,
		private stream: LogStreamRef
	) {
		// The session owns its monitor registration: streaming needs
		// essentially every event class, and consumers should not have to
		// know that. Refcounted server-side, so it coexists with any host
		// registration on the same key. The stream's teamId rides the key —
		// a deploy stream must subscribe the team's run, not the caller's
		// dev run (the scope IS the kind). Best-effort — a session opened
		// before connect simply streams from disk until reconnect.
		void this.client
			.addMonitor(
				{
					projectId: stream.projectId,
					source: stream.source,
					...(stream.teamId ? { teamId: stream.teamId } : {}),
				},
				['all']
			)
			.catch(() => undefined);
	}

	// =========================================================================
	// TIMELINE
	// =========================================================================

	/**
	 * The stream's chapters (runs) — begin/end/outcome per run.
	 *
	 * @returns The chapters list (freshly fetched when the cache aged out).
	 */
	async getChapters(): Promise<LogChaptersResult['chapters']> {
		await this.refreshTimeline();
		return this.timeline?.chapters ?? [];
	}

	/** Fetch/refresh the timeline (chapters + segment spans) when stale. */
	private async refreshTimeline(force = false): Promise<void> {
		if (!force && this.timeline && Date.now() - this.timelineAt < TIMELINE_TTL_MS) return;
		this.timeline = await this.client.log.chapters(this.stream);
		this.timelineAt = Date.now();
	}

	// =========================================================================
	// POSITION
	// =========================================================================

	/**
	 * Position the session. Subsequent `get*()` calls answer as of this
	 * position; `play()` continues from it.
	 *
	 * @param pos - Epoch seconds, or 'live' to pin to now.
	 */
	async seek(pos: LogPosition): Promise<void> {
		this.assertOpen();
		this.stopTimer();
		// Retire any pump still in flight (awaiting a fetch) BEFORE the
		// repositioning awaits below. stopTimer only kills a scheduled
		// re-entry; a pump parked on an await would otherwise resume against
		// the old epoch and mutate watermark/basePos — or fire a stale
		// callback — interleaved with the new position. A play() following
		// this seek bumps the epoch again and starts the fresh pump.
		this.pumpEpoch += 1;
		await this.refreshTimeline(true);

		if (pos === 'live') {
			this.pinned = true;
			this.basePos = Date.now() / 1000;
			const seg = await this.ensureCoveringSegment(this.basePos);
			this.watermark = this.lastSeqAtOrBefore(seg, Number.POSITIVE_INFINITY);
			return;
		}

		this.pinned = false;
		this.basePos = pos;
		const seg = await this.ensureCoveringSegment(pos);
		this.watermark = this.lastSeqAtOrBefore(seg, pos);
	}

	/** The current position (epoch seconds); rides the wall clock when live. */
	position(): number {
		return this.pinned ? Date.now() / 1000 : this.basePos;
	}

	// =========================================================================
	// SEEDED READS (state AS OF the position)
	// =========================================================================

	/**
	 * The full status snapshot at the position (pipeflow byPipe included).
	 *
	 * @returns The reconstructed status body, or null before the first status.
	 */
	async getStatus(): Promise<Record<string, unknown> | null> {
		this.assertOpen();
		const pos = this.position();
		const seg = await this.ensureCoveringSegment(pos);
		let status: Record<string, unknown> | null = null;
		const kfStatus = seg?.keyframe?.status;
		if (kfStatus && Object.keys(kfStatus).length > 0) status = kfStatus;
		for (const ev of this.eventsThrough(seg, pos)) {
			if (ev.event === 'apaevt_status_update' && ev.body) status = ev.body as Record<string, unknown>;
		}
		return status;
	}

	/**
	 * The console exactly as it read at the position (terminal semantics:
	 * the keyframe scrollback + everything printed since, last `n` lines).
	 *
	 * @param n - Number of trailing lines wanted.
	 * @returns The last `n` console lines as of the position.
	 */
	async getConsole(n: number): Promise<string[]> {
		this.assertOpen();
		const pos = this.position();
		const seg = await this.ensureCoveringSegment(pos);
		const lines: string[] = [...(seg?.keyframe?.console?.lines ?? [])];
		for (const ev of this.eventsThrough(seg, pos)) {
			if (ev.event === 'output' && ev.body) {
				for (const line of String((ev.body as Record<string, unknown>).output ?? '').split('\n')) {
					if (line !== '') lines.push(line);
				}
			}
		}
		return lines.slice(-Math.max(0, n));
	}

	/**
	 * Trace state at the position: ALL in-flight traces plus the `n` most
	 * recently completed (the sliding recency window).
	 *
	 * @param n - Closed-window size; must be ≤ 50.
	 * @returns Open + recently-closed trace summaries.
	 */
	async getTraces(n: number): Promise<LogTracesResult> {
		this.assertOpen();
		if (n > MAX_TRACES) throw new Error(`getTraces: n must be <= ${MAX_TRACES}`);
		const pos = this.position();
		const seg = await this.ensureCoveringSegment(pos);
		const fold = this.foldTraces(seg, pos);
		return { open: [...fold.open.values()], closed: fold.closed.slice(-Math.max(0, n)) };
	}

	/**
	 * One trace's complete event set (its call tree's raw material).
	 *
	 * IDENTITY CONTRACT: a trace is identified by its BEGIN event's continuum
	 * seq — the only key that is unique forever. The flow events' `body.id`
	 * is a pipe SLOT, reused across requests, and cannot name a trace.
	 * Resolution is deterministic and position-independent: locate the
	 * segment containing the seq (the span table carries each segment's
	 * first seq), find the begin event, then collect that slot's events
	 * forward until its matching `end`, crossing segments and the live tail
	 * as needed. Fails when the seq has fallen below the retention horizon,
	 * or when no trace-begin event exists at that seq (a recycled slot id
	 * or a fold docId is NOT a trace identity).
	 *
	 * @param traceId - The trace's begin-event continuum seq.
	 * @returns Summary + every event of the trace, seq-ordered.
	 */
	async getTrace(traceId: number): Promise<LogTraceDetail> {
		this.assertOpen();
		await this.refreshTimeline();
		const spans = this.timeline?.segments ?? [];

		// 1. The segment containing the begin: last span with firstSeq <= seq.
		let beginSegId: number | undefined;
		for (const span of spans) {
			if (span.id !== undefined && typeof span.seq === 'number' && span.seq <= traceId) beginSegId = span.id;
		}
		if (beginSegId === undefined) {
			throw new Error(`getTrace: trace ${traceId} is below the retention horizon`);
		}

		// 2. Find the begin event and its slot. A cached copy of the ACTIVE
		// segment goes stale (fetched once; live growth normally rides the
		// tail) — when the seq lies beyond what we hold, re-extend from the
		// stored offset: the writer spools every line before broadcasting,
		// so the disk always has it.
		const beginSeg = await this.ensureSegment(beginSegId);
		if (beginSeg) {
			const last = beginSeg.events[beginSeg.events.length - 1];
			if ((last?.body.logSeq ?? 0) < traceId) await this.extendSegment(beginSeg);
		}
		const beginEvent = beginSeg ? beginSeg.events[firstSeqAbove(beginSeg.events, traceId - 1)] : undefined;
		const beginBody = beginEvent?.body as Record<string, unknown> | undefined;
		if (!beginSeg || !beginEvent || beginEvent.body.logSeq !== traceId || beginEvent.event !== 'apaevt_flow' || beginBody?.op !== 'begin') {
			// The bucket is the NEWEST segment: a begin not yet on disk (the
			// fetch raced the broadcast) is found there like anywhere else.
			const tailIdx = firstSeqAbove(this.live.events, traceId - 1);
			const tailBegin = this.live.events[tailIdx];
			const tailBody = tailBegin?.body as Record<string, unknown> | undefined;
			if (tailBegin && tailBegin.body.logSeq === traceId && tailBegin.event === 'apaevt_flow' && tailBody?.op === 'begin') {
				return this.collectTrace(traceId, tailBegin, tailBody, this.live.events, tailIdx, []);
			}
			throw new Error(`getTrace: no trace begins at seq ${traceId}`);
		}
		// 3. Walk forward from the begin, crossing later segments in id order.
		const laterSegs = spans.filter((span) => span.id !== undefined && span.id > beginSegId).map((span) => span.id as number);
		return this.collectTrace(traceId, beginEvent, beginBody, beginSeg.events, beginSeg.events.indexOf(beginEvent), laterSegs);
	}

	/**
	 * Collect one trace's events from its begin forward: the begin's own
	 * list, then later segments, then the live tail — stopping at the
	 * slot's matching `end` (an in-flight trace has no end yet; return
	 * what exists).
	 */
	private async collectTrace(traceId: number, beginEvent: LogEvent, beginBody: Record<string, unknown>, beginList: LogEvent[], beginIdx: number, laterSegIds: number[]): Promise<LogTraceDetail> {
		const slot = beginBody.id;
		const events: LogEvent[] = [];
		let ended = false;
		let endTime: number | undefined;
		let calls = 0;
		const consume = (list: LogEvent[], fromIdx: number): void => {
			for (let i = fromIdx; i < list.length && !ended; i++) {
				const ev = list[i];
				if (ev.body.logSeq < traceId) continue;
				const body = ev.body as Record<string, unknown> | undefined;
				if (!body) continue;
				// The trace's events: its flow ops (slot = body.id) and the
				// node's SSE narration on the same slot (body.pipe_id).
				const isFlow = ev.event === 'apaevt_flow' && body.id === slot;
				const isSse = ev.event === 'apaevt_sse' && body.pipe_id === slot;
				if (!isFlow && !isSse) continue;
				// Seq-dedupe across sources (a tail copy may duplicate disk).
				if (events.length > 0 && events[events.length - 1].body.logSeq >= ev.body.logSeq) continue;
				events.push(ev);
				if (isFlow && body.op === 'enter') calls += 1;
				if (isFlow && body.op === 'end') {
					ended = true;
					endTime = ev.body.eventTime;
				}
			}
		};
		consume(beginList, beginIdx);
		for (const segId of laterSegIds) {
			if (ended) break;
			const seg = await this.ensureSegment(segId);
			if (seg) consume(seg.events, 0);
		}
		if (!ended) consume(this.live.events, 0);

		const summary: LogTraceSummary = {
			id: traceId,
			doc: (beginBody.component as string | undefined) ?? (beginBody.pipes as string[] | undefined)?.[0] ?? undefined,
			beginTime: beginEvent.body.eventTime,
			...(endTime !== undefined ? { elapsed: Math.max(0, endTime - beginEvent.body.eventTime) } : {}),
			calls,
			open: !ended,
		};
		return { summary, events };
	}

	// =========================================================================
	// TRANSPORT
	// =========================================================================

	/**
	 * Stream reconstructed events to `cb`, in order, strictly after the seed
	 * watermark, paced by `speed`. Auto-pins to live on catching the wall
	 * clock; while pinned, delivery follows event arrival.
	 *
	 * @param pos - Optional position to seek first (number | 'live').
	 * @param speed - 0 = as fast as possible; 0.25/1/10 = time-scaled.
	 * @param cb - Receives `{ event }` items.
	 */
	async play(pos: LogPosition | undefined, speed: number, cb: LogPlayCallback): Promise<void> {
		this.assertOpen();
		if (pos !== undefined) await this.seek(pos);
		this.speed = speed;
		this.callback = cb;
		this.playing = true;
		// Exactly ONE delivery loop: a replay of play() (resume, speed change)
		// retires any pump still awaiting a fetch via the epoch guard.
		this.stopTimer();
		this.pumpEpoch += 1;
		void this.pump(this.pumpEpoch);
	}

	/** Freeze the position (unpins live; a later play resumes from here). */
	pause(): void {
		this.basePos = this.position();
		this.pinned = false;
		this.playing = false;
		this.stopTimer();
	}

	/**
	 * Feed one live event from the host's subscription. While pinned and
	 * playing, it is delivered to the callback immediately (arrival paces
	 * live delivery); otherwise it is retained for later catch-up.
	 *
	 * @param msg - A stamped event message from the live feed.
	 */
	ingestLive(msg: LogEvent): void {
		// The continuum stamps live in the BODY — the only place they exist
		// (the DAP header seq is this connection's protocol counter,
		// meaningless here). An event without body stamps is not a stamped
		// task event; drop it.
		const stamps = msg.body as Record<string, unknown> | undefined;
		const seq = stamps?.logSeq;
		const eventTime = stamps?.eventTime;
		if (this.closed || typeof seq !== 'number' || !Number.isFinite(seq) || typeof eventTime !== 'number' || !Number.isFinite(eventTime)) return;
		// A duplicate of something already bucketed: nothing new.
		const last = this.live.events[this.live.events.length - 1];
		if (seq <= (last?.body.logSeq ?? 0)) return;
		this.live.events.push(msg);
		this.liveBytes += JSON.stringify(msg).length;
		// LIVE MODE: deliver the arrival directly — the wire is ordered, so
		// arrival order IS delivery order. Disk copies are irrelevant here;
		// the history walk's cursor skips any overlap on its own.
		if (this.pinned && this.playing && this.callback && seq > this.watermark) {
			this.watermark = seq;
			this.callback({ event: msg });
		}
		// Size backstop: past the threshold, split the bucket against a
		// fresh catalog (async — arrivals keep landing while it runs).
		if (this.liveBytes > LIVE_BUCKET_SPLIT_BYTES && !this.reconciling) {
			this.reconciling = true;
			void this.splitLiveBucket();
		}
	}

	/** Dispose the session (stops playback, clears caches). */
	closeEventStream(): void {
		// Release this session's monitor registration (refcounted) — the key
		// must match the constructor's registration exactly, teamId included.
		void this.client
			.removeMonitor(
				{
					projectId: this.stream.projectId,
					source: this.stream.source,
					...(this.stream.teamId ? { teamId: this.stream.teamId } : {}),
				},
				['all']
			)
			.catch(() => undefined);
		this.playing = false;
		this.stopTimer();
		this.cache.clear();
		this.live.events = [];
		this.liveBytes = 0;
		this.closed = true;
	}

	/**
	 * Size-triggered bucket SPLIT: reload the catalog and drop the prefix
	 * the server provably holds — anything with seq below the ACTIVE
	 * segment's first seq lives in a sealed, cataloged segment and is
	 * fetchable as a real segment. The retained suffix is at most the
	 * active segment's worth of events.
	 */
	private async splitLiveBucket(): Promise<void> {
		try {
			await this.refreshTimeline(true);
			if (this.closed) return;
			const spans = this.timeline?.segments ?? [];
			const cutoff = spans.length ? spans[spans.length - 1].seq : undefined;
			if (typeof cutoff !== 'number') return;
			this.dropLiveBucketPrefix(cutoff - 1);
		} catch {
			// A failed catalog read leaves the bucket as-is; the next arrival
			// past the threshold retries.
		} finally {
			this.reconciling = false;
		}
	}

	/** Split operation: drop bucket events with seq <= coveredSeq. */
	private dropLiveBucketPrefix(coveredSeq: number): void {
		const events = this.live.events;
		const from = firstSeqAbove(events, coveredSeq);
		if (from === 0) return;
		this.live.events = events.slice(from);
		this.liveBytes = this.live.events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
	}

	// =========================================================================
	// PUMP (the delivery loop)
	// =========================================================================

	/** Deliver the next due event(s); reschedule or pin as appropriate. */
	private async pump(epoch: number): Promise<void> {
		if (epoch !== this.pumpEpoch || !this.playing || this.closed || !this.callback) return;

		let delivered = 0;
		for (;;) {
			if (epoch !== this.pumpEpoch || !this.playing || this.closed) return;
			const next = await this.nextEvent();
			if (epoch !== this.pumpEpoch || !this.playing || this.closed) return;
			if (next === null) {
				// The history walk ran out of buckets. A still-writing stream
				// means we caught the wall clock: flip to LIVE MODE — from
				// here arrivals deliver directly in ingestLive. A completed
				// stream simply ran out of disc: pause at the end.
				await this.refreshTimeline();
				if (epoch !== this.pumpEpoch || !this.playing || this.closed) return;
				if (this.timeline?.completed === false) {
					this.pinned = true;
					this.basePos = Date.now() / 1000;
					// Drain arrivals that landed in the live bucket during the
					// awaits above: ingestLive delivers only events arriving
					// AFTER the pin flips, so anything buffered in that window
					// must be delivered here or it is lost to the seam.
					// Synchronous — no await may interleave an arrival mid-drain.
					let idx = firstSeqAbove(this.live.events, this.watermark);
					while (idx < this.live.events.length && this.playing && this.callback) {
						const ev = this.live.events[idx];
						this.watermark = ev.body.logSeq;
						this.callback({ event: ev });
						idx += 1;
					}
				} else {
					this.pause();
				}
				return;
			}

			const eventTime = next.body.eventTime;
			if (this.speed > 0) {
				const delayMs = Math.max(0, ((eventTime - this.basePos) / this.speed) * 1000);
				if (delayMs > 4) {
					this.timer = setTimeout(() => {
						// Advance the playback clock past the wait so the
						// re-entered pump computes a zero delay and delivers —
						// without this the same event reschedules the same
						// wait forever and timed playback stalls. Guarded:
						// a retired epoch must not touch the live clock.
						if (epoch === this.pumpEpoch && this.playing) {
							this.basePos = Math.max(this.basePos, eventTime);
						}
						void this.pump(epoch);
					}, delayMs);
					return;
				}
			}

			this.watermark = next.body.logSeq;
			this.basePos = Math.max(this.basePos, eventTime);
			this.callback({ event: next });

			// At speed 0, yield to the event loop between batches so a huge
			// catch-up cannot starve the host.
			if (this.speed === 0 && ++delivered % FLAT_OUT_BATCH === 0) {
				this.timer = setTimeout(() => void this.pump(epoch), 0);
				return;
			}
		}
	}

	/** The next undelivered event (seq > watermark), fetching forward as needed. */
	private async nextEvent(): Promise<LogEvent | null> {
		// 1. From cached segments, in id order (touch on serve: the segment
		// being played must stay most-recently-used, never the LRU victim).
		const ids = [...this.cache.keys()].sort((a, b) => a - b);
		for (const id of ids) {
			const seg = this.cache.get(id)!;
			const idx = firstSeqAbove(seg.events, this.watermark);
			if (idx < seg.events.length) {
				this.touch(seg);
				return seg.events[idx];
			}
		}

		// 2. Grow the ACTIVE segment. "final" only means the last fetch
		// reached the then-current end — the segment regrows on disk, and
		// the log records more than the wire pushes, so the disk re-read is
		// the delivery guarantee for wire-less content.
		const last = ids.length ? this.cache.get(ids[ids.length - 1])! : null;
		if (last) {
			await this.extendSegment(last);
			const idx = firstSeqAbove(last.events, this.watermark);
			if (idx < last.events.length) return last.events[idx];
		}

		// 3. A later segment we have not fetched yet.
		await this.refreshTimeline();
		const spans = this.timeline?.segments ?? [];
		for (const span of spans) {
			if (span.id !== undefined && (last === null || span.id > last.id)) {
				const seg = await this.ensureSegment(span.id);
				if (seg) {
					const idx = firstSeqAbove(seg.events, this.watermark);
					if (idx < seg.events.length) return seg.events[idx];
				}
			}
		}

		// 4. The live tail (events newer than anything recorded to disk yet).
		const idx = firstSeqAbove(this.live.events, this.watermark);
		if (idx < this.live.events.length) return this.live.events[idx];

		return null;
	}

	// =========================================================================
	// SEGMENT MATERIALIZATION (internals — storage stays invisible)
	// =========================================================================

	/** Ensure the segment covering `pos` is cached; return it. */
	private async ensureCoveringSegment(pos: number): Promise<CachedSegment | null> {
		await this.refreshTimeline();
		const spans = this.timeline?.segments ?? [];
		let coveringId: number | undefined;
		for (const span of spans) {
			if (span.id === undefined) continue;
			if ((span.startTime ?? 0) <= pos) coveringId = span.id;
		}
		if (coveringId === undefined && spans.length && spans[0].id !== undefined) coveringId = spans[0].id;
		if (coveringId === undefined) return null;
		return this.ensureSegment(coveringId);
	}

	/** Move a segment to most-recently-used (Map order IS the LRU order). */
	private touch(seg: CachedSegment): void {
		this.cache.delete(seg.id);
		this.cache.set(seg.id, seg);
	}

	/** Fetch + decode one segment (all chunks) into the cache (LRU-capped). */
	private async ensureSegment(segId: number): Promise<CachedSegment | null> {
		const cached = this.cache.get(segId);
		if (cached) {
			this.touch(cached);
			return cached;
		}

		const decoder = new SegmentDecoder();
		const seg: CachedSegment = { id: segId, keyframe: null, events: [], decoder, nextOffset: 0, final: false };
		await this.extendSegment(seg);
		if (seg.keyframe === null && seg.events.length === 0 && seg.final) return null;
		this.cache.set(segId, seg);
		// LRU eviction: drop from the front of the Map until under the cap
		// (evicted segments re-materialize with one raw fetch).
		while (this.cache.size > MAX_RESIDENT_SEGMENTS) {
			const oldestId = this.cache.keys().next().value as number;
			this.cache.delete(oldestId);
		}
		return seg;
	}

	/** Continue fetching a segment from its stored offset (active growth). */
	private async extendSegment(seg: CachedSegment): Promise<void> {
		let offset = seg.nextOffset ?? 0;
		for (;;) {
			const chunk = await this.client.log.segment(this.stream, seg.id, { offset });
			if (chunk.data) {
				const parsed = parseSegmentChunk(chunk.data, seg.decoder);
				if (parsed.keyframe) seg.keyframe = parsed.keyframe;
				for (const ev of parsed.events) {
					if (ev.body.logSeq > this.maxDiskSeq) this.maxDiskSeq = ev.body.logSeq;
					seg.events.push(ev);
				}
			}
			seg.final = chunk.final;
			seg.nextOffset = chunk.nextOffset ?? chunk.size;
			if (chunk.final || chunk.nextOffset === null) break;
			offset = chunk.nextOffset;
		}
		// Disk coverage advanced: split the bucket's now-covered prefix out —
		// the same operation as the size-triggered catalog split.
		this.dropLiveBucketPrefix(this.maxDiskSeq);
	}

	// =========================================================================
	// FOLDS (state-at-position, keyframe + interior)
	// =========================================================================

	/** All events of `seg` plus the live bucket, with eventTime ≤ pos, in order. */
	private eventsThrough(seg: CachedSegment | null, pos: number): LogEvent[] {
		const events = seg ? seg.events.filter((e) => e.body.eventTime <= pos) : [];
		// The bucket is the stream's newest segment — it participates in the
		// fold exactly like disk events (dedupe is structural: the bucket
		// holds only seqs beyond maxDiskSeq).
		const lastDisk = events[events.length - 1]?.body.logSeq ?? 0;
		for (const ev of this.live.events) {
			if (ev.body.eventTime <= pos && ev.body.logSeq > lastDisk) events.push(ev);
		}
		return events;
	}

	/** Fold open/closed trace state from the keyframe + interior ≤ pos. */
	private foldTraces(seg: CachedSegment | null, pos: number): { open: Map<number | string, LogTraceSummary>; closed: LogTraceSummary[] } {
		const open = new Map<number | string, LogTraceSummary>();
		const closed: LogTraceSummary[] = [];

		for (const frame of seg?.keyframe?.openFrames ?? []) {
			if (!open.has(frame.id)) {
				open.set(frame.id, {
					id: frame.id,
					...(typeof frame.enterSeq === 'number' ? { beginSeq: frame.enterSeq } : {}),
					doc: frame.doc,
					beginTime: frame.enterTime,
					open: true,
					touched: frame.touched,
				});
			}
		}
		for (const done of seg?.keyframe?.closedRecent ?? []) {
			closed.push({
				id: done.id,
				...(typeof done.beginSeq === 'number' ? { beginSeq: done.beginSeq } : {}),
				doc: done.doc,
				beginTime: done.beginTime,
				elapsed: done.elapsed,
				calls: done.calls,
				open: false,
				touched: done.touched,
			});
		}

		for (const ev of this.eventsThrough(seg, pos)) {
			if (ev.event !== 'apaevt_flow' || !ev.body) continue;
			const body = ev.body as Record<string, unknown>;
			const pid = body.id as number | string;
			const op = body.op;
			// An interior event proves this trace touches the covering
			// segment — the keyframe's touched list predates it.
			const tracked = open.get(pid);
			if (tracked && seg) {
				if (!tracked.touched) tracked.touched = [];
				if (!tracked.touched.includes(seg.id)) tracked.touched.push(seg.id);
			}
			if (op === 'begin') {
				open.set(pid, {
					id: pid,
					// The trace's PERMANENT identity — what getTrace resolves.
					beginSeq: ev.body.logSeq,
					doc: body.component as string | undefined,
					beginTime: ev.body.eventTime,
					calls: 0,
					open: true,
					touched: seg ? [seg.id] : [],
				});
			} else if (op === 'enter') {
				const entry = open.get(pid);
				if (entry) entry.calls = (entry.calls ?? 0) + 1;
			} else if (op === 'end') {
				const entry = open.get(pid);
				open.delete(pid);
				if (entry) {
					closed.push({
						...entry,
						open: false,
						elapsed: entry.beginTime !== undefined ? Math.max(0, ev.body.eventTime - entry.beginTime) : undefined,
					});
				}
			}
		}
		return { open, closed };
	}

	/** Highest seq at-or-before `pos` in the segment (0 when none). */
	private lastSeqAtOrBefore(seg: CachedSegment | null, pos: number): number {
		let last = 0;
		for (const ev of this.eventsThrough(seg, pos)) {
			if (ev.body.logSeq > last) last = ev.body.logSeq;
		}
		return last;
	}

	private stopTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('LogEventStream is closed');
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/** Index of the first event with body.logSeq > `afterSeq` (seq-ascending). */
function firstSeqAbove(events: LogEvent[], afterSeq: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (events[mid].body.logSeq <= afterSeq) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
