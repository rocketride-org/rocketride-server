// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * useTaskEvents — THE single event-delivery point for one source's continuum.
 *
 * Data model: ONE ascending buffer and ONE position.
 *
 * - The BUFFER is a seq-ordered array of raw stamped events — the DVR disc in
 *   memory. Live ingest and fetched log pages merge into it (deduped on seq);
 *   eventTime rides monotonically with seq, so time lookups are binary
 *   searches. A parallel index of just the status snapshots makes the
 *   status-shaped reads O(log n).
 * - The POSITION is an epoch-seconds cursor. "Live" is not a separate mode:
 *   it is the position PINNED to now, riding the wall clock. Unpinned, the
 *   position advances at speed x wall clock; paused, it is frozen. One
 *   ticker owns the clock — event arrival never moves it, so an idle stream
 *   still slides dead space past every consumer.
 *
 * Delivery: three purpose-shaped reads over that one buffer, all
 * binary-search + enumerate — no pushed arrays, no per-tick copies:
 *
 * 1. statusAt()            — the last status snapshot at-or-before the
 *    position. Status bodies are ABSOLUTE (counters, flow tree, errors), so
 *    one snapshot fully feeds the Tokens/Flow/Errors/header panes; in a dead
 *    zone this is naturally the previous run's final state.
 * 2. trackEvents(types?)   — the EFFECTIVE TRACK's events from its begin up
 *    to min(position, track end). The effective track is the run containing
 *    the position, else the last run that ended before it — so accumulating
 *    panes (trace/log/analyze) persist a finished run through the dead zone
 *    and reset only when the next run begins, and a mid-track seek replays
 *    from the track's beginning.
 * 3. chartSeries(range)    — the chart's 1-second grid ending at the
 *    position: tracks and dead zones merged into one continuous timeline,
 *    per-second rates from absolute-counter deltas, step-interpolated
 *    gauges, hard zeros through dead space (the engine's final zeroed
 *    snapshot bounds every run).
 * 4. trackStats()          — Now/Avg/Peak/Min completion rates scoped to the
 *    EFFECTIVE TRACK (begin to min(position, track end)), not the chart's
 *    visible window — the fixed one-minute chart would otherwise report
 *    zeros whenever the run's activity happened outside the last 60s.
 *
 * Machinery (not model): a prefetching reader over the injected log pager
 * with generation-cancelled seeks, and a fetch anchor at the effective
 * track's begin so a mid-track seek pulls the whole track, not just the
 * window ahead of the cursor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChartStats, StatusDataPoint } from '../../../components/status/types';

// =============================================================================
// TYPES
// =============================================================================

/** A stamped DAP event message (header eventTime + continuum seq). */
export interface TaskEventMessage {
	type?: string;
	event: string;
	/** Server-stamped emission time (epoch seconds, float). */
	eventTime: number;
	/** Server-stamped continuum seq (epoch-us seeded, monotonic). */
	seq: number;
	body?: Record<string, unknown>;
	[key: string]: unknown;
}

/** One chapter (track) of the stream, as returned by log.chapters. */
export interface TaskChapter {
	beginTime: number;
	beginSeq: number;
	endTime?: number | null;
	outcome?: string | null;
}

/** Chapters + activity metadata (log.chapters response shape). */
export interface TaskTimeline {
	chapters: TaskChapter[];
	segments: Array<{ startTime?: number | null; endTime?: number | null; chapterStart: boolean }>;
	startTime?: number | null;
	endTime?: number | null;
	horizonSeq: number;
	completed: boolean;
}

/** Host-injected pager over `client.log.read` for THIS stream. */
export type LogReadFetcher = (params: {
	fromSeq?: number;
	fromTime?: number;
	toTime?: number;
	cursor?: number;
	maxEvents?: number;
	types?: string[];
}) => Promise<{ events: TaskEventMessage[]; nextSeq?: number; truncatedAtSeq?: number }>;

/**
 * Player mode label. NOT two code paths: there is one DVR position and one
 * windowed delivery — 'live' just means the position is PINNED to now
 * (riding the wall clock at 1X); 'replay' means it is behind the head
 * (moving at speed x wall clock, or frozen while paused).
 */
export type PlayerMode = 'live' | 'replay';

/** Transport state exposed to the PlayBar. */
export interface TaskPlayerState {
	mode: PlayerMode;
	playing: boolean;
	/** Playback speed multiplier (0.25 … 25). */
	speed: number;
	/** The DVR position (epoch seconds); pinned to now while live. Null only before the first transport tick. */
	cursorTime: number | null;
	/** True while a replay fetch is filling the buffer. */
	buffering: boolean;
}

/** Controller returned to the PlayBar / section chrome. */
export interface TaskPlayerController {
	play: () => void;
	pause: () => void;
	setSpeed: (speed: number) => void;
	/** Seek to an absolute time (epoch seconds) and enter replay mode. */
	seekToTime: (time: number) => void;
	/** Skip relative to the cursor (e.g. -30 / +30 seconds). */
	skip: (deltaSeconds: number) => void;
	/** Jump to the previous/next chapter (track) begin. */
	previousTrack: () => void;
	nextTrack: () => void;
	/** Return to the live edge and resume streaming. */
	goLive: () => void;
}

/** The effective track's slice for the accumulating panes. */
export interface TrackWindow {
	/** The track's chapter metadata (synthetic for a not-yet-chaptered live run); null when no track precedes the position. */
	chapter: TaskChapter | null;
	/** True when the position sits INSIDE the track (still executing at the position). */
	active: boolean;
	/** Events from the track's begin up to min(position, track end), oldest first. */
	events: TaskEventMessage[];
}

/** Hook inputs. */
export interface UseTaskEventsOptions {
	/** Pager over the stream's log (host-injected; null disables replay). */
	readLog: LogReadFetcher | null;
	/** Stream timeline (chapters) — drives track resolution + gap detection. */
	timeline: TaskTimeline | null;
	/** DVR/replay buffer cap (messages); oldest dropped beyond it. */
	bufferCap?: number;
}

/** Hook outputs. */
export interface UseTaskEventsResult {
	/** The last status snapshot body at-or-before the position (absolute counters/flow/errors), or null. */
	statusAt: () => Record<string, unknown> | null;
	/** The effective track's events (optionally type-filtered) — see {@link TrackWindow}. */
	trackEvents: (types?: readonly string[]) => TrackWindow;
	/**
	 * Events within an arbitrary [from, to] time slice (the Analyze brush).
	 * Serves from the buffer — a slice brushed on screen is inside the
	 * fetched window by construction.
	 */
	rangeEvents: (fromTime: number, toTime: number, types?: readonly string[]) => TaskEventMessage[];
	/** The chart's 1-second grid ending at the position (tracks + dead zones merged). */
	chartSeries: (rangeSeconds: number) => StatusDataPoint[];
	/** Track-scoped Now/Avg/Peak/Min completion rates at the position. */
	trackStats: () => ChartStats;
	/** Ingest one live event from the host's subscription. */
	ingestLive: (message: TaskEventMessage) => void;
	/** Transport state + controller for the PlayBar. */
	player: TaskPlayerState;
	controller: TaskPlayerController;
	/** True when the cursor sits in an idle gap between tracks. */
	inGap: boolean;
	/** The gap's neighbors when inGap (used by PLAY's auto-skip). */
	gapNeighbors: { previous: TaskChapter | null; next: TaskChapter | null };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default DVR/replay buffer cap (messages). */
const DEFAULT_BUFFER_CAP = 20_000;

/** Replay page size requested from the server (server clamps anyway). */
const REPLAY_PAGE_EVENTS = 1_000;

/** Transport tick (ms) — position advance + consumer re-read cadence. */
const PLAYBACK_TICK_MS = 120;

/** Prefetch when fewer than this many buffered events remain ahead. */
const PREFETCH_LOW_WATER = 400;

/** Largest chart range (seconds) — seeks backfill at least this window. */
const MAX_CHART_RANGE_SECONDS = 900;

/**
 * Late-joiner FALLBACK window (seconds): a view opened mid-run backfills the
 * whole open track (same rule as replay seeks — accumulating panes get the
 * run from its begin). Only while the chapters cache has not loaded yet —
 * so the run's begin is unknown — does the backfill anchor this far behind
 * the live edge instead; once the cache reveals an earlier begin, the
 * backfill extends backward to it.
 */
const LIVE_BACKFILL_FALLBACK_SECONDS = 1_800;

// =============================================================================
// BINARY SEARCH HELPERS
// =============================================================================

/** First index whose eventTime is >= time (buffer is eventTime-ascending). */
function lowerBound(events: TaskEventMessage[], time: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (events[mid].eventTime < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** First index whose eventTime is > time. */
function upperBound(events: TaskEventMessage[], time: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (events[mid].eventTime <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Buffered event delivery + DVD-style transport for one source's continuum.
 *
 * @param options - Injected log pager, timeline, and buffer sizing.
 * @returns The three shaped reads, live ingest, and the player state/controller.
 */
export function useTaskEvents(options: UseTaskEventsOptions): UseTaskEventsResult {
	const { readLog, timeline: rawTimeline, bufferCap = DEFAULT_BUFFER_CAP } = options;

	// Chapter normalization: only the NEWEST chapter may be open-ended. An
	// older chapter with a null endTime is a run that died without writing
	// run-end — treated as containing (endTime ?? Infinity) it would swallow
	// every later run's positions in track/gap resolution. Clamp it to the
	// next chapter's begin. (The writer self-heals these at its next open;
	// this covers caches written before that.)
	const timeline = useMemo<TaskTimeline | null>(() => {
		if (!rawTimeline) return null;
		const raw = rawTimeline.chapters ?? [];
		const chapters = raw.map((chapter, index) =>
			chapter.endTime == null && index < raw.length - 1
				? { ...chapter, endTime: raw[index + 1].beginTime, outcome: chapter.outcome ?? 'interrupted' }
				: chapter,
		);
		return { ...rawTimeline, chapters };
	}, [rawTimeline]);

	// --- The buffer (refs: mutated on hot paths without re-render) -----------
	// One contiguous, seq-ordered window of messages (live tail + backfill).
	const bufferRef = useRef<TaskEventMessage[]>([]);
	// Seqs present in the buffer — the live/backfill dedupe seam.
	const seenSeqRef = useRef<Set<number>>(new Set());
	// Parallel index of ONLY the status snapshots (same ordering) — makes
	// statusAt and the chart grid O(log n) instead of scanning the buffer.
	const statusIndexRef = useRef<TaskEventMessage[]>([]);
	// Seek generation — in-flight fetches from older generations are dropped.
	const generationRef = useRef(0);
	// In replay: buffered continuation cursor (server nextSeq) if paged out.
	const nextSeqRef = useRef<number | undefined>(undefined);
	// Wall-clock of the last transport tick.
	const lastTickRef = useRef<number>(0);

	// --- Transport state ------------------------------------------------------
	// ONE DVR, one position. "Live" is the position PINNED to now.
	const [pinned, setPinned] = useState(true);
	const [playing, setPlaying] = useState(true);
	const [speed, setSpeed] = useState(1);
	const [cursorTime, setCursorTime] = useState<number | null>(null);
	const [buffering, setBuffering] = useState(false);
	// Bumped when events land AT/BELOW the position (backfill, live-at-head):
	// readers re-derive. Growth beyond a frozen position is invisible by
	// design (the recorder records; the paused view does not move).
	const [rebuildTick, setRebuildTick] = useState(0);

	// Externally the pin state reads as the familiar mode label.
	const mode: PlayerMode = pinned ? 'live' : 'replay';

	// Ref mirrors for the interval closure.
	const pinnedRef = useRef(pinned);
	pinnedRef.current = pinned;
	const bufferingRef = useRef(buffering);
	bufferingRef.current = buffering;
	const cursorTimeRef = useRef(cursorTime);
	cursorTimeRef.current = cursorTime;

	// =========================================================================
	// BUFFER PRIMITIVES
	// =========================================================================

	/**
	 * Insert messages into the buffer, seq-ordered and deduped, maintaining
	 * the status index and the ring cap.
	 *
	 * @returns True when anything landed at/below the current position (the
	 *          visible past changed — readers must re-derive).
	 */
	const absorb = useCallback(
		(messages: TaskEventMessage[]) => {
			const buffer = bufferRef.current;
			const seen = seenSeqRef.current;
			const position = cursorTimeRef.current;
			let dirty = false;
			let behind = false;
			for (const message of messages) {
				if (typeof message.seq !== 'number' || seen.has(message.seq)) continue;
				seen.add(message.seq);
				buffer.push(message);
				if (message.event === 'apaevt_status_update') statusIndexRef.current.push(message);
				dirty = true;
				if (position === null || message.eventTime <= position) behind = true;
			}
			if (dirty) {
				buffer.sort((a, b) => a.seq - b.seq);
				statusIndexRef.current.sort((a, b) => a.seq - b.seq);
				// DVR ring: drop oldest beyond the cap (both structures).
				while (buffer.length > bufferCap) {
					const dropped = buffer.shift();
					if (dropped) seen.delete(dropped.seq);
				}
				if (buffer.length > 0) {
					const floorSeq = buffer[0].seq;
					const statusIndex = statusIndexRef.current;
					while (statusIndex.length > 0 && statusIndex[0].seq < floorSeq) statusIndex.shift();
				}
			}
			return behind && dirty;
		},
		[bufferCap],
	);

	// The anchor the live late-joiner backfill has fetched back to (null =
	// none yet). A flush discards the backfilled history, so it re-arms; a
	// later chapters refresh that reveals an EARLIER run begin re-triggers
	// with the deeper anchor.
	const liveBackfillAnchorRef = useRef<number | null>(null);

	/** Reset the buffer entirely (far seek / stream switch). */
	const flush = useCallback(() => {
		bufferRef.current = [];
		seenSeqRef.current = new Set();
		statusIndexRef.current = [];
		nextSeqRef.current = undefined;
		liveBackfillAnchorRef.current = null;
	}, []);

	/**
	 * Host subscription feed: absorb into the DVR buffer, nothing more.
	 * Arrival does NOT move the position — the transport ticker owns the
	 * clock, so an idle stream still slides dead space past every view.
	 */
	const ingestLive = useCallback(
		(message: TaskEventMessage) => {
			if (absorb([message])) setRebuildTick((value) => value + 1);
		},
		[absorb],
	);

	// =========================================================================
	// FETCHING (prefetch pipeline, generation-cancelled)
	// =========================================================================

	/** Fill the buffer around/onward from a time; obeys the generation. */
	const fetchFrom = useCallback(
		async (params: { fromTime?: number; cursor?: number }, generation: number) => {
			if (!readLog) return;
			setBuffering(true);
			try {
				const page = await readLog({ ...params, maxEvents: REPLAY_PAGE_EVENTS });
				// A newer seek supersedes this fetch: discard stale pages.
				if (generation !== generationRef.current) return;
				if (absorb(page.events)) setRebuildTick((value) => value + 1);
				nextSeqRef.current = page.nextSeq;
			} catch {
				// Fetch errors leave the buffer as-is; the next tick retries
				// via the low-water check.
			} finally {
				if (generation === generationRef.current) setBuffering(false);
			}
		},
		[readLog, absorb],
	);

	/** Prefetch ahead of the playhead when the runway gets short. */
	const maybePrefetch = useCallback(() => {
		if (nextSeqRef.current === undefined) return;
		const buffer = bufferRef.current;
		const cursor = cursorTimeRef.current ?? 0;
		const ahead = buffer.length - upperBound(buffer, cursor);
		// Scale the runway with speed: 25X eats a page in seconds.
		if (ahead < PREFETCH_LOW_WATER * Math.max(1, speed / 4)) {
			void fetchFrom({ cursor: nextSeqRef.current }, generationRef.current);
			nextSeqRef.current = undefined; // one in-flight continuation at a time
		}
	}, [speed, fetchFrom]);

	// Late-joiner backfill: a view opened mid-run has NOTHING from before its
	// subscribe instant — status keeps the chart alive (it streams ~1/s), but
	// the run's earlier output/flow/trace events already happened and will
	// never arrive live. On entering live with a log reader available, read
	// the WHOLE open track (the same track-begin anchor replay seeks use);
	// while the chapters cache has not revealed the run's begin, fall back to
	// a bounded window and extend backward once it does. The seq dedupe
	// splices fetched history under the live tail, and the continuation (if
	// the track spans multiple pages) drains through maybePrefetch on the
	// pinned tick.
	useEffect(() => {
		if (!pinned || readLog === null) return;
		const now = Date.now() / 1000;
		const openTrackBegin = timeline?.chapters?.find((chapter) => chapter.endTime == null)?.beginTime;
		const anchor = openTrackBegin ?? now - LIVE_BACKFILL_FALLBACK_SECONDS;
		// Already backfilled at least this deep (1s slack absorbs float noise).
		if (liveBackfillAnchorRef.current !== null && anchor >= liveBackfillAnchorRef.current - 1) return;
		liveBackfillAnchorRef.current = anchor;
		void fetchFrom({ fromTime: anchor }, generationRef.current);
	}, [pinned, readLog, timeline, fetchFrom]);

	// =========================================================================
	// TRANSPORT TICKER — the ONE clock that moves the DVR position
	// =========================================================================
	// Runs whenever the transport is playing, pinned or not. Pinned: the
	// position IS now (wall clock, never trailing the newest server-stamped
	// event — absorbs client/server clock skew). Unpinned: the position
	// advances at speed x wall clock; when it catches the end of recorded
	// content with nothing left to page in, it re-pins automatically (the
	// DVD ran out of disc — hand the transport back to the live head).
	// Paused: no ticks, the position is frozen wherever it is.

	useEffect(() => {
		if (!playing) return;
		lastTickRef.current = Date.now();
		const timer = setInterval(() => {
			const nowMs = Date.now();
			const elapsed = (nowMs - lastTickRef.current) / 1000;
			lastTickRef.current = nowMs;
			const wallNow = nowMs / 1000;
			const buffer = bufferRef.current;
			const tail = buffer.length > 0 ? buffer[buffer.length - 1].eventTime : null;

			let next: number;
			if (pinnedRef.current) {
				next = Math.max(wallNow, tail ?? wallNow);
				// Drain a pending backfill continuation (no-op without one) —
				// live joins mid-run may need several pages to reach the tail.
				maybePrefetch();
			} else {
				next = (cursorTimeRef.current ?? tail ?? wallNow) + elapsed * speed;
				if (next >= wallNow) {
					// Caught the WALL CLOCK — that is what "caught up" means:
					// the trailing dead space after the last recorded event is
					// part of the disc and is swept at playback speed like any
					// other dead zone; only reaching now itself re-pins. (No
					// event can be stamped in the future, so nothing unfetched
					// can exist beyond this point.)
					generationRef.current += 1;
					setPinned(true);
					next = Math.max(wallNow, tail ?? wallNow);
				} else {
					maybePrefetch();
				}
			}

			setCursorTime(next);
		}, PLAYBACK_TICK_MS);
		return () => clearInterval(timer);
	}, [playing, speed, maybePrefetch]);

	// =========================================================================
	// TRACK RESOLUTION
	// =========================================================================

	/**
	 * True when a buffered message marks the start of a run — the writer's
	 * run-begin lifecycle marker (backfilled from the log) or the task's
	 * begin announcement (live broadcast).
	 */
	const isRunBegin = (message: TaskEventMessage): boolean => {
		const action = (message.body as Record<string, unknown> | undefined)?.action;
		return (message.event === 'apaevt_log_lifecycle' && action === 'run-begin') || (message.event === 'apaevt_task' && action === 'begin');
	};

	/**
	 * Resolve the EFFECTIVE track for a position: the chapter containing it,
	 * else the last chapter that ended before it — extended by one rule for
	 * the live edge: chapters refresh slowly, so events in the buffer AFTER
	 * the last closed chapter mean a new run is underway and form a
	 * synthetic open track. The synthetic track begins at the LATEST
	 * run-begin marker at-or-before the position — several runs can start
	 * and die between chapter-cache refreshes (rapid dev restarts), and
	 * anchoring at the first stray event would merge them into one track.
	 */
	const resolveTrack = useCallback(
		(position: number): { chapter: TaskChapter; active: boolean } | null => {
			const chapters = timeline?.chapters ?? [];
			let lastEnded: TaskChapter | null = null;
			for (const chapter of chapters) {
				const end = chapter.endTime ?? Number.POSITIVE_INFINITY;
				if (chapter.beginTime <= position && position <= end) {
					return { chapter, active: chapter.endTime == null || position < chapter.endTime };
				}
				if (end <= position && (lastEnded === null || end >= (lastEnded.endTime ?? 0))) {
					lastEnded = chapter;
				}
			}

			// Live-edge rule: events after the last closed chapter = the next
			// run, not yet in the chapters cache.
			const buffer = bufferRef.current;
			const afterTime = lastEnded?.endTime ?? Number.NEGATIVE_INFINITY;
			const firstIdx = lastEnded === null ? (buffer.length > 0 ? 0 : -1) : lowerBound(buffer, afterTime + 0.001);
			if (firstIdx >= 0 && firstIdx < buffer.length && buffer[firstIdx].eventTime <= position) {
				// Scan backward from the position for the newest run-begin
				// marker — that is the synthetic track's true begin. Fall back
				// to the first post-chapter event only when no marker exists
				// in the window (marker evicted or pre-marker stream).
				let first = buffer[firstIdx];
				for (let i = upperBound(buffer, position) - 1; i >= firstIdx; i--) {
					if (isRunBegin(buffer[i])) {
						first = buffer[i];
						break;
					}
				}
				return {
					chapter: { beginTime: first.eventTime, beginSeq: first.seq, endTime: null, outcome: null },
					active: true,
				};
			}

			if (lastEnded !== null) return { chapter: lastEnded, active: false };
			return null;
		},
		[timeline],
	);

	// =========================================================================
	// THE THREE READS — binary search + enumerate over the one buffer
	// =========================================================================

	// Whole-second clock: the chart re-derives once per position-second, not
	// per 120ms tick (its grid is 1-second pitch anyway).
	const clockSecond = cursorTime === null ? null : Math.floor(cursorTime);

	/** The last status snapshot body at-or-before the position. */
	const statusAt = useCallback((): Record<string, unknown> | null => {
		const position = cursorTimeRef.current;
		if (position === null) return null;
		const statusIndex = statusIndexRef.current;
		const idx = upperBound(statusIndex, position) - 1;
		return idx >= 0 ? ((statusIndex[idx].body ?? null) as Record<string, unknown> | null) : null;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cursorTime, rebuildTick]);

	/** The effective track's events from its begin to min(position, end). */
	const trackEvents = useCallback(
		(types?: readonly string[]): TrackWindow => {
			const position = cursorTimeRef.current;
			if (position === null) return { chapter: null, active: false, events: [] };
			const resolved = resolveTrack(position);
			if (resolved === null) return { chapter: null, active: false, events: [] };

			const buffer = bufferRef.current;
			const begin = resolved.chapter.beginTime;
			const endCap = Math.min(position, resolved.chapter.endTime ?? position);
			const from = lowerBound(buffer, begin);
			const to = upperBound(buffer, endCap);
			const slice = buffer.slice(from, to);
			const events = types ? slice.filter((message) => types.includes(message.event)) : slice;
			return { chapter: resolved.chapter, active: resolved.active, events };
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[resolveTrack, cursorTime, rebuildTick],
	);

	/** Events within an arbitrary [from, to] slice — the Analyze brush read. */
	const rangeEvents = useCallback(
		(fromTime: number, toTime: number, types?: readonly string[]): TaskEventMessage[] => {
			const buffer = bufferRef.current;
			const slice = buffer.slice(lowerBound(buffer, fromTime), upperBound(buffer, toTime));
			return types ? slice.filter((message) => types.includes(message.event)) : slice;
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[rebuildTick],
	);

	/**
	 * The chart's 1-second grid ending at the position: rates from
	 * absolute-counter deltas between consecutive snapshots (a counter
	 * decrease = restart = zero-rate boundary), step-interpolated gauges,
	 * zeros through dead space. Tracks and dead zones merge into one
	 * continuous timeline; the engine's final zeroed snapshot terminates
	 * every run in the data itself.
	 */
	const chartSeries = useCallback(
		(rangeSeconds: number): StatusDataPoint[] => {
			if (clockSecond === null) return [];
			const statusIndex = statusIndexRef.current;
			const start = clockSecond - rangeSeconds + 1;

			// Walk pointer starts at the last snapshot before the window so the
			// left edge step-interpolates correctly.
			let index = upperBound(statusIndex, start);
			const points: StatusDataPoint[] = [];
			for (let t = start; t <= clockSecond; t++) {
				while (index < statusIndex.length && statusIndex[index].eventTime <= t) index++;
				const at = index > 0 ? statusIndex[index - 1] : null;
				const next = index < statusIndex.length ? statusIndex[index] : null;
				const atBody = (at?.body ?? null) as Record<string, any> | null;
				const nextBody = (next?.body ?? null) as Record<string, any> | null;

				let totalDelta = 0;
				let failedDelta = 0;
				if (at && next && nextBody && atBody && next.eventTime > at.eventTime) {
					const span = next.eventTime - at.eventTime;
					totalDelta = Math.max(0, Number(nextBody.totalCount ?? 0) - Number(atBody.totalCount ?? 0)) / span;
					failedDelta = Math.max(0, Number(nextBody.failedCount ?? 0) - Number(atBody.failedCount ?? 0)) / span;
				}

				points.push({
					timestamp: t * 1000,
					totalDelta,
					failedDelta,
					cpuPercent: Number(atBody?.metrics?.cpu_percent ?? 0),
					cpuMemoryMb: Number(atBody?.metrics?.cpu_memory_mb ?? 0),
					gpuMemoryMb: Number(atBody?.metrics?.gpu_memory_mb ?? 0),
				});
			}
			return points;
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[clockSecond, rebuildTick],
	);

	/**
	 * Track-scoped statistics at the position: interval rates between the
	 * effective track's status snapshots, from its begin to min(position,
	 * track end). Counters reset at run begin, so an implicit (begin, 0)
	 * point seeds the first interval; a mid-run counter decrease (engine
	 * restart) re-baselines instead of producing a negative rate. Average
	 * is total processed / track time — exact from the counters, not a mean
	 * of the sampled intervals. In a dead zone the stats freeze at the
	 * finished run's values rather than diluting toward zero with idle time.
	 */
	const trackStats = useCallback((): ChartStats => {
		const zero: ChartStats = { current: 0, average: 0, peak: 0, minimum: 0, duration: 0 };
		const position = cursorTimeRef.current;
		if (position === null) return zero;
		const resolved = resolveTrack(position);
		if (resolved === null) return zero;

		const begin = resolved.chapter.beginTime;
		const effEnd = Math.min(position, resolved.chapter.endTime ?? position);
		const duration = Math.max(0, effEnd - begin);
		const statusIndex = statusIndexRef.current;
		const from = lowerBound(statusIndex, begin);
		const to = upperBound(statusIndex, effEnd);

		// Walk the snapshot intervals: rate = counter delta / time span.
		const round1 = (value: number) => Math.round(value * 10) / 10;
		let prevTime = begin;
		let prevTotal = 0;
		let processed = 0;
		let peak = 0;
		let minimum = Number.POSITIVE_INFINITY;
		let current = 0;
		let intervals = 0;
		for (let i = from; i < to; i++) {
			const body = statusIndex[i].body as Record<string, any> | null;
			const total = Number(body?.totalCount ?? 0);
			const span = statusIndex[i].eventTime - prevTime;
			if (span > 0) {
				const rate = Math.max(0, total - prevTotal) / span;
				processed += Math.max(0, total - prevTotal);
				peak = Math.max(peak, rate);
				minimum = Math.min(minimum, rate);
				current = rate;
				intervals++;
			}
			prevTime = statusIndex[i].eventTime;
			prevTotal = total;
		}

		return {
			current: round1(current),
			average: round1(duration > 0 ? processed / duration : 0),
			peak: round1(peak),
			minimum: round1(intervals > 0 ? minimum : 0),
			duration,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [resolveTrack, cursorTime, rebuildTick]);

	// =========================================================================
	// GAP DETECTION (idle space between tracks)
	// =========================================================================

	const { inGap, gapNeighbors } = useMemo(() => {
		if (pinned || cursorTime === null || !timeline?.chapters?.length) {
			return { inGap: false, gapNeighbors: { previous: null, next: null } };
		}
		let previous: TaskChapter | null = null;
		let next: TaskChapter | null = null;
		for (const chapter of timeline.chapters) {
			const end = chapter.endTime ?? Number.POSITIVE_INFINITY;
			if (chapter.beginTime <= cursorTime && cursorTime <= end) {
				return { inGap: false, gapNeighbors: { previous: null, next: null } };
			}
			if (end < cursorTime) previous = chapter;
			if (chapter.beginTime > cursorTime && next === null) next = chapter;
		}
		return { inGap: true, gapNeighbors: { previous, next } };
	}, [pinned, cursorTime, timeline]);

	// =========================================================================
	// TRANSPORT CONTROLLER (generation-cancelled seeks)
	// =========================================================================

	const seekToTime = useCallback(
		(time: number) => {
			generationRef.current += 1;
			const generation = generationRef.current;
			setPinned(false);
			setPlaying(false);
			setCursorTime(time);

			// Fetch anchor: the effective track's BEGIN (so accumulating panes
			// replay the whole run) and at least the largest chart window —
			// clamped to what the stream actually retains, or no buffer could
			// ever satisfy the check and every small step would flush.
			const resolved = resolveTrack(time);
			const rawAnchor = Math.min(resolved?.chapter.beginTime ?? time, time - MAX_CHART_RANGE_SECONDS);
			const streamFloor = timeline?.startTime ?? null;
			const anchor = streamFloor !== null ? Math.max(rawAnchor, streamFloor) : rawAnchor;

			// Buffer reuse ladder (a flush blanks every pane for a frame — it
			// is the LAST resort, not the default):
			// 1. Position inside the buffer with enough left depth: serve as-is.
			// 2. Inside but shallow on the left: extend backward IN PLACE (the
			//    fetched range overlaps the buffer start, so it stays one
			//    contiguous window) — panes keep rendering throughout.
			// 3. Just past the tail: extend forward in place, same reasoning.
			// 4. Truly elsewhere: flush and refill from the anchor.
			const buffer = bufferRef.current;
			const first = buffer.length > 0 ? buffer[0].eventTime : null;
			const last = buffer.length > 0 ? buffer[buffer.length - 1].eventTime : null;
			const inWindow = first !== null && last !== null && time >= first && time <= last + 1;
			const depthOk = first !== null && first <= anchor + 1;
			if (inWindow && depthOk) return;
			if (inWindow && !depthOk) {
				void fetchFrom({ fromTime: anchor }, generation);
				return;
			}
			if (first !== null && last !== null && time > last && depthOk) {
				void fetchFrom({ fromTime: last }, generation);
				return;
			}
			flush();
			void fetchFrom({ fromTime: anchor }, generation);
		},
		[resolveTrack, flush, fetchFrom],
	);

	const controller = useMemo<TaskPlayerController>(() => {
		const chapters = timeline?.chapters ?? [];
		return {
			play: () => {
				// PLAY inside a gap auto-skips to the next track's begin —
				// exactly how a DVD treats the space between tracks.
				if (inGap && gapNeighbors.next) {
					seekToTime(gapNeighbors.next.beginTime);
				}
				lastTickRef.current = Date.now();
				setPlaying(true);
			},
			pause: () => {
				// Pausing freezes the position while now moves on — by
				// definition no longer pinned. Resume plays forward from the
				// pause point (and re-pins when it catches the head);
				// GO LIVE jumps straight back.
				setPinned(false);
				setPlaying(false);
			},
			setSpeed: (value: number) => setSpeed(value),
			seekToTime,
			skip: (deltaSeconds: number) => {
				const base = cursorTime ?? timeline?.endTime ?? Date.now() / 1000;
				seekToTime(base + deltaSeconds);
			},
			previousTrack: () => {
				const cursor = cursorTime ?? Number.POSITIVE_INFINITY;
				const candidates = chapters.filter((chapter) => chapter.beginTime < cursor - 1);
				const target = candidates[candidates.length - 1] ?? chapters[0];
				if (target) seekToTime(target.beginTime);
			},
			nextTrack: () => {
				const cursor = cursorTime ?? 0;
				const target = chapters.find((chapter) => chapter.beginTime > cursor + 1);
				if (target) seekToTime(target.beginTime);
			},
			goLive: () => {
				// GO LIVE = pin the position to now and resume; the ticker
				// keeps it riding the wall clock from here.
				generationRef.current += 1;
				const buffer = bufferRef.current;
				const tail = buffer.length > 0 ? buffer[buffer.length - 1].eventTime : null;
				const head = Math.max(Date.now() / 1000, tail ?? 0);
				setPinned(true);
				setPlaying(true);
				setCursorTime(head);
			},
		};
	}, [timeline, cursorTime, inGap, gapNeighbors, seekToTime]);

	// =========================================================================
	// RESULT
	// =========================================================================

	const player = useMemo<TaskPlayerState>(
		() => ({ mode, playing, speed, cursorTime, buffering }),
		[mode, playing, speed, cursorTime, buffering],
	);

	return { statusAt, trackEvents, rangeEvents, chartSeries, trackStats, ingestLive, player, controller, inGap, gapNeighbors };
}
