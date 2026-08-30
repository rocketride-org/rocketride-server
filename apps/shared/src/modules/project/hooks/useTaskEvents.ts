// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * useTaskEvents — THE single event-delivery point for one source's continuum.
 *
 * Data model: ONE session-fed fold and ONE position.
 *
 * - The DATA PLANE is the host-injected DVR SESSION (`openEventStream` in the
 *   client SDK): segment residency, raw fetches, keyframe/delta decode, seq
 *   ordering, live/backfill splice — all invisible behind seek/play. The hook
 *   consumes ONE delivery path (the session's play callback) into a FOLD: an
 *   append-only, already-ordered event array plus a parallel status index.
 *   There is no fetch pager, no buffer re-sort, no reuse ladder, and no
 *   late-joiner backfill here — a seek is `session.seek(anchor)` + replay,
 *   and the session's segment cache makes a warm seek instant.
 * - The POSITION is an epoch-seconds cursor. "Live" is not a separate mode:
 *   it is the position PINNED to now, riding the wall clock. Unpinned, the
 *   position advances at speed x wall clock; paused, it is frozen. One
 *   ticker owns the clock — event arrival never moves it, so an idle stream
 *   still slides dead space past every consumer.
 *
 * Delivery: purpose-shaped reads over the fold, all binary-search +
 * enumerate — no pushed arrays, no per-tick copies:
 *
 * 1. statusAt()            — the last status snapshot at-or-before the
 *    position (falling back to the session's state-at-anchor seed). Status
 *    bodies are ABSOLUTE, so one snapshot fully feeds the snapshot panes.
 * 2. trackEvents(types?)   — the EFFECTIVE TRACK's events from its begin up
 *    to min(position, track end); accumulating panes persist a finished run
 *    through the dead zone and reset only when the next run begins.
 * 3. chartSeries(range)    — the chart's 1-second grid ending at the
 *    position: per-second rates from absolute-counter deltas, step-
 *    interpolated gauges, hard zeros through dead space.
 * 4. trackStats()          — Now/Avg/Peak/Min completion rates scoped to the
 *    EFFECTIVE TRACK (begin to min(position, track end)).
 *
 * Fetch policy (the whole of it): the session plays at speed 0 from the
 * anchor and the hook PAUSES it when delivery runs past the position's
 * runway, resuming from the transport ticker as the position advances —
 * prefetch-ahead in two moves, with pacing owned entirely by the cursor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChartStats, StatusDataPoint } from '../../../components/utilization/types';

// =============================================================================
// TYPES
// =============================================================================

/** A stamped DAP event message (header eventTime + continuum seq). */
/**
 * The body of a stamped task event — the COMPLETE task-scoped record: the
 * project_id/source identity, the continuum stamps, and the event payload.
 * The DAP envelope around it is pure protocol (its `seq` is per-connection
 * bookkeeping) and carries nothing of ours.
 */
export interface TaskEventBody {
	/** Continuum emission time (epoch seconds), stamped at engine ingress. */
	eventTime: number;
	/** Continuum sequence — catalog-seeded, strictly monotonic per stream. */
	logSeq: number;
	[key: string]: unknown;
}

/**
 * One stamped task event. There is ONE representation of the stamps: the
 * body. The host gate admits only events whose body carries them, so every
 * consumer reads body.eventTime / body.logSeq directly.
 */
export interface TaskEventMessage {
	type?: string;
	event: string;
	body: TaskEventBody;
	[key: string]: unknown;
}

/** One chapter (track) of the stream, as returned by log.chapters. */
export interface TaskChapter {
	beginTime: number;
	beginSeq: number;
	endTime?: number | null;
	outcome?: string | null;
	/** The run's trace level (null/'none' = tracing off; absent on
	    chapters recorded before the stamp existed). */
	traceLevel?: string | null;
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

/**
 * The DVR session surface the hook consumes — structurally satisfied by the
 * client SDK's `LogEventStream` (`client.log.openEventStream(stream)`). The
 * host owns creation and disposal; the hook only drives it.
 */
export interface TaskEventSession {
	/** Position the session (epoch seconds | 'live'). */
	seek(pos: number | 'live'): Promise<void>;
	/** Full status snapshot as of the session position (delta-resolved). */
	getStatus(): Promise<Record<string, unknown> | null>;
	/** Stream reconstructed events after the seed watermark, paced by speed. */
	play(pos: number | 'live' | undefined, speed: number, cb: (item: { event: TaskEventMessage }) => void): Promise<void>;
	/** One trace's complete reconstructed event set. The id is the trace's
	    BEGIN event's continuum seq — its permanent identity. */
	getTrace(traceId: number): Promise<{ events: TaskEventMessage[] }>;
	/** Stop delivery (the hook's runway throttle; resumed via play). */
	pause(): void;
	/** Feed one live event from the host's subscription. */
	ingestLive(message: TaskEventMessage): void;
	/** Dispose (host-owned; called by the session's creator, not the hook). */
	closeEventStream(): void;
}

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
	/**
	 * Jump to the previous/next REQUEST — the nearest completion-begin flow
	 * event relative to the cursor, bounded by the current chapter: with no
	 * begin left in that direction the position lands on the chapter's own
	 * boundary (begin for backward, end for forward). |< / >| cross run
	 * boundaries instead.
	 */
	stepBegin: (direction: -1 | 1) => void;
	/** |<: current task's begin, or the previous task's just-before-end. */
	previousTrack: () => void;
	/** >|: current task's just-before-end, or the next task's begin. */
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
	/**
	 * Coverage honesty: set (to the fold's start time) when the fold does NOT
	 * reach the track's begin — events before it exist but are not loaded
	 * (fold cap trim). Panes surface this instead of silently truncating.
	 */
	truncatedBefore?: number;
}

/** Hook inputs. */
export interface UseTaskEventsOptions {
	/** The stream's DVR session (host-created; null disables replay). */
	session: TaskEventSession | null;
	/** Stream timeline (chapters) — drives track resolution + gap detection. */
	timeline: TaskTimeline | null;
}

/** Hook outputs. */
export interface UseTaskEventsResult {
	/** The last status snapshot body at-or-before the position (absolute counters/flow/errors), or null. */
	statusAt: () => Record<string, unknown> | null;
	/** The effective track's events (optionally type-filtered) — see {@link TrackWindow}. */
	trackEvents: (types?: readonly string[]) => TrackWindow;
	/**
	 * Events within an arbitrary [from, to] time slice (the Analyze brush).
	 * Serves from the fold — a slice brushed on screen is inside the
	 * delivered window by construction.
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

/** Fold size cap (messages) — memory backstop, trimmed in chunks. */
const FOLD_CAP = 50_000;

/** Transport tick (ms) — position advance + consumer re-read cadence. */
const PLAYBACK_TICK_MS = 120;

/** Largest chart range (seconds) — seeks anchor at least this window back. */
const MAX_CHART_RANGE_SECONDS = 900;

/**
 * Delivery runway (seconds ahead of the position) before the hook pauses the
 * session; the ticker resumes it as the position advances. Scaled by speed
 * so 25X keeps a proportional cushion. While PINNED the runway is infinite —
 * live delivery follows arrival.
 */
const RUNWAY_BASE_SECONDS = 120;

/**
 * Request stepping lands THIS far past the begin event, so the begin frame
 * plays through: the begin itself plus the enters sharing its instant
 * render, and the panes show the request as started rather than the moment
 * just before it.
 */
const STEP_BEGIN_LEAD = 0.05;

/**
 * Origin-search epsilon for request stepping: a begin within this of the
 * cursor counts as the one the needle is standing on (the landing lead
 * above puts the cursor just past it), not as a neighbor to jump to.
 */
const STEP_BEGIN_EPSILON = 0.05;

/**
 * Forward request-hunt backstop (ms): if delivery produces neither a begin
 * nor an event past the chapter end within this window (stalled stream,
 * interrupted run that never wrote another event), the hunt disarms and
 * the cursor lands on the chapter end cap.
 */
const HUNT_DEADLINE_MS = 15_000;

/**
 * Live FALLBACK anchor (seconds): entering live with no open chapter in the
 * cache yet, the seed anchors this far behind the head; once the chapters
 * cache reveals the open run's earlier begin, the seed re-anchors there.
 */
const LIVE_FALLBACK_SECONDS = 1_800;

/**
 * Seek offset (seconds) placing the position just BEFORE a track's
 * termination flurry (final zeroed status + task end + run-end share the
 * track's end instant) — the |< / >| target that shows the run's final
 * stats before the live view clears them.
 */
const TRACK_END_EPSILON = 0.001;

// =============================================================================
// BINARY SEARCH HELPERS
// =============================================================================

/** First index whose eventTime is >= time (fold is eventTime-ascending). */
function lowerBound(events: TaskEventMessage[], time: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (events[mid].body.eventTime < time) lo = mid + 1;
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
		if (events[mid].body.eventTime <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Session-fed event delivery + DVD-style transport for one source's
 * continuum.
 *
 * @param options - Injected DVR session and timeline.
 * @returns The shaped reads, live ingest, and the player state/controller.
 */
export function useTaskEvents(options: UseTaskEventsOptions): UseTaskEventsResult {
	const { session, timeline: rawTimeline } = options;

	// Chapter normalization: only the NEWEST chapter may be open-ended. An
	// older chapter with a null endTime is a run that died without writing
	// run-end — treated as containing (endTime ?? Infinity) it would swallow
	// every later run's positions in track/gap resolution. Clamp it to the
	// next chapter's begin. (The writer self-heals these at its next open;
	// this covers caches written before that.)
	const timeline = useMemo<TaskTimeline | null>(() => {
		if (!rawTimeline) return null;
		const raw = rawTimeline.chapters ?? [];
		const chapters = raw.map((chapter, index) => (chapter.endTime == null && index < raw.length - 1 ? { ...chapter, endTime: raw[index + 1].beginTime, outcome: chapter.outcome ?? 'interrupted' } : chapter));
		return { ...rawTimeline, chapters };
	}, [rawTimeline]);

	// --- The fold (refs: mutated on the delivery path without re-render) -----
	// Append-only, session-ordered window of delivered messages.
	const foldRef = useRef<TaskEventMessage[]>([]);
	// Parallel index of ONLY the status snapshots (same ordering) — makes
	// statusAt and the chart grid O(log n) instead of scanning the fold.
	const statusIndexRef = useRef<TaskEventMessage[]>([]);
	// The session's state-at-anchor snapshot (statusAt fallback before the
	// first delivered status).
	const seedStatusRef = useRef<Record<string, unknown> | null>(null);
	// The anchor the current fold starts at (coverage check for seeks).
	const foldAnchorRef = useRef<number | null>(null);
	// Seek generation — deliveries from a superseded reseed are dropped.
	const generationRef = useRef(0);
	// True while the hook has the session delivering (vs runway-paused).
	const sessionRunningRef = useRef(false);
	// Wall-clock of the last transport tick.
	const lastTickRef = useRef<number>(0);

	// --- Transport state ------------------------------------------------------
	// ONE DVR, one position. "Live" is the position PINNED to now.
	const [pinned, setPinned] = useState(true);
	const [playing, setPlaying] = useState(true);
	const [speed, setSpeed] = useState(1);
	const [cursorTime, setCursorTime] = useState<number | null>(null);
	const [buffering, setBuffering] = useState(false);
	// Bumped when events land AT/BELOW the position: readers re-derive.
	// Growth beyond a frozen position is invisible by design (the recorder
	// records; the paused view does not move).
	const [rebuildTick, setRebuildTick] = useState(0);

	// Externally the pin state reads as the familiar mode label.
	const mode: PlayerMode = pinned ? 'live' : 'replay';

	// Ref mirrors for the interval closure.
	const pinnedRef = useRef(pinned);
	pinnedRef.current = pinned;
	const speedRef = useRef(speed);
	speedRef.current = speed;
	const cursorTimeRef = useRef(cursorTime);
	cursorTimeRef.current = cursorTime;
	const sessionRef = useRef(session);
	sessionRef.current = session;
	const timelineRef = useRef(timeline);
	timelineRef.current = timeline;

	// =========================================================================
	// DELIVERY (the session's play callback → the fold)
	// =========================================================================

	/**
	 * Forward request-hunt (stepBegin past the delivered window): while
	 * armed, the runway throttle is suspended so delivery keeps draining
	 * until the next completion-begin past fromTime arrives — deliver()
	 * lands the cursor on it, or on endCap (the chapter's end) if the
	 * stream passes it with no begin. Stale generations never fire; any
	 * explicit transport action disarms it.
	 */
	const beginHuntRef = useRef<{ generation: number; fromTime: number; endCap: number } | null>(null);

	/** Disarm a pending forward request-hunt and drop its buffering flag. */
	const disarmHunt = useCallback(() => {
		if (beginHuntRef.current) {
			beginHuntRef.current = null;
			setBuffering(false);
		}
	}, []);

	/** End of the delivery runway for the current position (epoch seconds). */
	const runwayEnd = useCallback((): number => {
		if (pinnedRef.current || beginHuntRef.current) return Number.POSITIVE_INFINITY;
		const cursor = cursorTimeRef.current ?? 0;
		return cursor + RUNWAY_BASE_SECONDS * Math.max(1, speedRef.current);
	}, []);

	/**
	 * Fold one delivered event. The session guarantees order and the
	 * seed/stream splice, so this is a pure append — no sort, no dedupe.
	 * Past the runway, pause the session; the ticker resumes it.
	 */
	const deliver = useCallback(
		(generation: number, message: TaskEventMessage) => {
			if (generation !== generationRef.current) return;
			const fold = foldRef.current;
			fold.push(message);
			if (message.event === 'apaevt_status_update') statusIndexRef.current.push(message);

			// Memory backstop: trim the oldest fifth in one splice (amortized;
			// the session's segment cache makes any deep re-seek cheap).
			if (fold.length > FOLD_CAP) {
				fold.splice(0, FOLD_CAP / 5);
				const floorSeq = fold[0].body.logSeq;
				foldAnchorRef.current = fold[0].body.eventTime;
				statusIndexRef.current = statusIndexRef.current.filter((snapshot) => snapshot.body.logSeq >= floorSeq);
			}

			// A forward request-hunt lands here: the first begin past the hunt
			// origin becomes the new position; passing the chapter's end
			// without one lands on the end itself. Either way the hunt
			// disarms (restoring the runway throttle).
			const hunt = beginHuntRef.current;
			if (hunt && hunt.generation === generation) {
				const time = message.body.eventTime;
				const isBegin = message.event === 'apaevt_flow' && (message.body as Record<string, unknown>).op === 'begin' && time > hunt.fromTime + STEP_BEGIN_EPSILON;
				if (isBegin && time <= hunt.endCap) {
					disarmHunt();
					// Land just PAST the begin so its frame plays through.
					setCursorTime(time + STEP_BEGIN_LEAD);
					setRebuildTick((value) => value + 1);
				} else if (time > hunt.endCap) {
					disarmHunt();
					setCursorTime(hunt.endCap);
					setRebuildTick((value) => value + 1);
				}
			}

			const position = cursorTimeRef.current;
			if (position === null || message.body.eventTime <= position) {
				setRebuildTick((value) => value + 1);
			}
			if (message.body.eventTime > runwayEnd()) {
				sessionRef.current?.pause();
				sessionRunningRef.current = false;
			}
		},
		[runwayEnd, disarmHunt]
	);

	/**
	 * Re-anchor the whole delivery: clear the fold, position the session at
	 * the anchor, seed state-at-anchor, and play forward at speed 0 (the
	 * runway throttle bounds how far it actually drains). ONE code path for
	 * tab-open, seek-and-play, and go-live — only the anchor differs.
	 */
	const reseed = useCallback(
		(anchor: number) => {
			// A generation change supersedes any pending request-hunt — the
			// runway throttle must not stay suspended for the new delivery.
			disarmHunt();
			const generation = ++generationRef.current;
			foldRef.current = [];
			statusIndexRef.current = [];
			seedStatusRef.current = null;
			foldAnchorRef.current = anchor;
			const target = sessionRef.current;
			if (!target) return;
			setBuffering(true);
			void (async () => {
				try {
					await target.seek(anchor);
					if (generation !== generationRef.current) return;
					seedStatusRef.current = await target.getStatus();
					if (generation !== generationRef.current) return;
					await target.play(undefined, 0, (item) => deliver(generation, item.event));
					sessionRunningRef.current = true;
					setRebuildTick((value) => value + 1);
				} catch {
					// A failed seed (e.g. a never-logged stream) leaves the fold
					// empty; clearing the anchor re-arms the seeding effect so
					// the next timeline refresh retries.
					if (generation === generationRef.current) foldAnchorRef.current = null;
				} finally {
					if (generation === generationRef.current) setBuffering(false);
				}
			})();
		},
		[deliver]
	);

	/** Resume a runway-paused session (position advanced; more disc needed). */
	const maybeResume = useCallback(() => {
		const target = sessionRef.current;
		if (!target || sessionRunningRef.current) return;
		const fold = foldRef.current;
		const tail = fold.length > 0 ? fold[fold.length - 1].body.eventTime : null;
		if (tail !== null && tail > runwayEnd()) return;
		const generation = generationRef.current;
		sessionRunningRef.current = true;
		void target
			.play(undefined, 0, (item) => deliver(generation, item.event))
			.catch(() => {
				sessionRunningRef.current = false;
			});
	}, [runwayEnd, deliver]);

	// Wall-clock of the last arrival-triggered resume (rate limit).
	const lastNudgeRef = useRef(0);

	/**
	 * Host subscription feed: hand the event to the SESSION (its live tail /
	 * watermark splice decides when it reaches the fold). Arrival does NOT
	 * move the position — the transport ticker owns the clock. While pinned,
	 * an arrival also nudges a session that idled out at the end of a
	 * completed stream (its pump pauses there; a new run must wake it) —
	 * rate-limited, and harmless when delivery is already running (the
	 * session keeps exactly one delivery loop).
	 */
	const ingestLive = useCallback(
		(message: TaskEventMessage) => {
			const target = sessionRef.current;
			if (!target) return;
			target.ingestLive(message);
			const now = Date.now();
			if (pinnedRef.current && now - lastNudgeRef.current > 2_000) {
				lastNudgeRef.current = now;
				const generation = generationRef.current;
				sessionRunningRef.current = true;
				void target
					.play(undefined, 0, (item) => deliver(generation, item.event))
					.catch(() => {
						sessionRunningRef.current = false;
					});
			}
		},
		[deliver]
	);

	// --- Initial seeding ------------------------------------------------------
	// A session appearing (or the open track's begin becoming known while the
	// fold is still shallow) seeds the live view: anchor at the open run's
	// begin so the accumulating panes have the whole run, with a bounded
	// fallback until the chapters cache reveals it.
	useEffect(() => {
		if (!session || !pinned) return;
		const now = Date.now() / 1000;
		const openTrackBegin = timeline?.chapters?.find((chapter) => chapter.endTime == null)?.beginTime;
		const anchor = openTrackBegin ?? now - LIVE_FALLBACK_SECONDS;
		// Already anchored at least this deep (1s slack absorbs float noise).
		const current = foldAnchorRef.current;
		if (current !== null && anchor >= current - 1) return;
		reseed(anchor);
	}, [session, pinned, timeline, reseed]);

	// =========================================================================
	// TRANSPORT TICKER — the ONE clock that moves the DVR position
	// =========================================================================
	// Runs whenever the transport is playing, pinned or not. Pinned: the
	// position IS now (wall clock, never trailing the newest delivered
	// event — absorbs client/server clock skew). Unpinned: the position
	// advances at speed x wall clock; when it catches the wall clock it
	// re-pins automatically (the DVD ran out of disc — hand the transport
	// back to the live head). Paused: no ticks, the position is frozen.

	useEffect(() => {
		if (!playing) return;
		lastTickRef.current = Date.now();
		const timer = setInterval(() => {
			const nowMs = Date.now();
			const elapsed = (nowMs - lastTickRef.current) / 1000;
			lastTickRef.current = nowMs;
			const wallNow = nowMs / 1000;
			const fold = foldRef.current;
			const tail = fold.length > 0 ? fold[fold.length - 1].body.eventTime : null;

			let next: number;
			if (pinnedRef.current) {
				next = Math.max(wallNow, tail ?? wallNow);
			} else {
				next = (cursorTimeRef.current ?? tail ?? wallNow) + elapsed * speed;
				if (next >= wallNow) {
					// Caught the WALL CLOCK — that is what "caught up" means:
					// trailing dead space after the last recorded event is part
					// of the disc and is swept at playback speed like any other
					// dead zone; only reaching now itself re-pins. (No event can
					// be stamped in the future, so nothing undelivered can exist
					// beyond this point.)
					setPinned(true);
					next = Math.max(wallNow, tail ?? wallNow);
				}
			}

			// Advance-ahead: a runway-paused session resumes as the position
			// eats into its cushion (also drains live catch-up after re-pin).
			maybeResume();
			setCursorTime(next);
		}, PLAYBACK_TICK_MS);
		return () => clearInterval(timer);
	}, [playing, speed, maybeResume]);

	// =========================================================================
	// TRACK RESOLUTION
	// =========================================================================

	/**
	 * True when a folded message marks the start of a run — the writer's
	 * run-begin lifecycle marker (replayed from the log) or the task's
	 * begin announcement (live broadcast).
	 */
	const isRunBegin = (message: TaskEventMessage): boolean => {
		const action = (message.body as Record<string, unknown> | undefined)?.action;
		return (message.event === 'apaevt_log_lifecycle' && action === 'run-begin') || (message.event === 'apaevt_task' && action === 'begin');
	};

	/**
	 * Resolve the EFFECTIVE track for a position: the chapter containing it,
	 * else the last chapter that ended before it — extended by one rule for
	 * the live edge: chapters refresh slowly, so events in the fold AFTER
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
			const fold = foldRef.current;
			const afterTime = lastEnded?.endTime ?? Number.NEGATIVE_INFINITY;
			const firstIdx = lastEnded === null ? (fold.length > 0 ? 0 : -1) : lowerBound(fold, afterTime + 0.001);
			if (firstIdx >= 0 && firstIdx < fold.length && fold[firstIdx].body.eventTime <= position) {
				// Scan backward from the position for the newest run-begin
				// marker — that is the synthetic track's true begin. Fall back
				// to the first post-chapter event only when no marker exists
				// in the window (marker evicted or pre-marker stream).
				let first = fold[firstIdx];
				for (let i = upperBound(fold, position) - 1; i >= firstIdx; i--) {
					if (isRunBegin(fold[i])) {
						first = fold[i];
						break;
					}
				}
				// traceLevel spreads conditionally: an ABSENT key means "no
				// stamp" (pre-stamp marker, or the non-marker fallback event)
				// and must stay absent — null would claim tracing was OFF.
				return {
					chapter: { beginTime: first.body.eventTime, beginSeq: first.body.logSeq, endTime: null, outcome: null, ...(typeof first.body.traceLevel === 'string' ? { traceLevel: first.body.traceLevel } : {}) },
					active: true,
				};
			}

			if (lastEnded !== null) return { chapter: lastEnded, active: false };
			return null;
		},
		[timeline]
	);

	// =========================================================================
	// THE SHAPED READS — binary search + enumerate over the fold
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
		if (idx >= 0) return (statusIndex[idx].body ?? null) as Record<string, unknown> | null;
		// Before the first delivered snapshot the session's state-at-anchor
		// seed answers (it already folded keyframe + interior to the anchor).
		return seedStatusRef.current;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cursorTime, rebuildTick]);

	/** The effective track's events from its begin to min(position, end). */
	const trackEvents = useCallback(
		(types?: readonly string[]): TrackWindow => {
			const position = cursorTimeRef.current;
			if (position === null) return { chapter: null, active: false, events: [] };
			const resolved = resolveTrack(position);
			if (resolved === null) return { chapter: null, active: false, events: [] };
			// DEAD ZONE = CLEARED, at any position: a run's data renders only
			// INSIDE its track. Final stats are reached by positioning just
			// before the end (|< / >|), not by dead-zone ghosting — trailing
			// state was v1's crutch for not having a DVR.
			if (!resolved.active) return { chapter: null, active: false, events: [] };

			const fold = foldRef.current;
			const begin = resolved.chapter.beginTime;
			const endCap = Math.min(position, resolved.chapter.endTime ?? position);
			const from = lowerBound(fold, begin);
			const to = upperBound(fold, endCap);
			const slice = fold.slice(from, to);
			const events = types ? slice.filter((message) => types.includes(message.event)) : slice;
			// Coverage honesty: a cap-trimmed fold that no longer reaches the
			// track's begin must say so (1s slack absorbs float noise).
			const anchor = foldAnchorRef.current;
			const truncated = anchor !== null && anchor > begin + 1 ? { truncatedBefore: anchor } : null;
			return { chapter: resolved.chapter, active: resolved.active, events, ...truncated };
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[resolveTrack, cursorTime, rebuildTick]
	);

	/** Events within an arbitrary [from, to] slice — the Analyze brush read. */
	const rangeEvents = useCallback(
		(fromTime: number, toTime: number, types?: readonly string[]): TaskEventMessage[] => {
			const fold = foldRef.current;
			const slice = fold.slice(lowerBound(fold, fromTime), upperBound(fold, toTime));
			return types ? slice.filter((message) => types.includes(message.event)) : slice;
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[rebuildTick]
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
				while (index < statusIndex.length && statusIndex[index].body.eventTime <= t) index++;
				const at = index > 0 ? statusIndex[index - 1] : null;
				const next = index < statusIndex.length ? statusIndex[index] : null;
				const atBody = (at?.body ?? null) as Record<string, any> | null;
				const nextBody = (next?.body ?? null) as Record<string, any> | null;

				let totalDelta = 0;
				let failedDelta = 0;
				if (at && next && nextBody && atBody && next.body.eventTime > at.body.eventTime) {
					const span = next.body.eventTime - at.body.eventTime;
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
		[clockSecond, rebuildTick]
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
		// DEAD ZONE = CLEARED (see trackEvents): stats zero outside a track.
		if (!resolved.active) return zero;

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
			const span = statusIndex[i].body.eventTime - prevTime;
			if (span > 0) {
				const rate = Math.max(0, total - prevTotal) / span;
				processed += Math.max(0, total - prevTotal);
				peak = Math.max(peak, rate);
				minimum = Math.min(minimum, rate);
				current = rate;
				intervals++;
			}
			prevTime = statusIndex[i].body.eventTime;
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
	// TRANSPORT CONTROLLER
	// =========================================================================

	const seekToTime = useCallback(
		(time: number) => {
			// Any explicit seek supersedes a pending forward request-hunt.
			disarmHunt();
			setPinned(false);
			setPlaying(false);
			setCursorTime(time);

			// Anchor: the effective track's BEGIN (so accumulating panes replay
			// the whole run) and at least the largest chart window — clamped to
			// what the stream actually retains.
			const resolved = resolveTrack(time);
			const rawAnchor = Math.min(resolved?.chapter.beginTime ?? time, time - MAX_CHART_RANGE_SECONDS);
			const streamFloor = timelineRef.current?.startTime ?? null;
			const anchor = streamFloor !== null ? Math.max(rawAnchor, streamFloor) : rawAnchor;

			// Coverage check (the whole seek policy): if the fold already spans
			// the position from at least the anchor, only the cursor moves —
			// the session keeps delivering ahead and reads gate by position.
			// Anything else re-anchors; the session's segment cache makes a
			// warm reseed instant.
			const fold = foldRef.current;
			const first = fold.length > 0 ? fold[0].body.eventTime : null;
			const last = fold.length > 0 ? fold[fold.length - 1].body.eventTime : null;
			const inWindow = first !== null && last !== null && time >= first && time <= last + 1;
			const depthOk = first !== null && first <= anchor + 1;
			if (inWindow && depthOk) return;
			reseed(anchor);
		},
		[resolveTrack, reseed, disarmHunt]
	);

	const controller = useMemo<TaskPlayerController>(() => {
		const chapters = timeline?.chapters ?? [];
		return {
			play: () => {
				// PLAY inside a gap auto-skips to the next track's begin —
				// exactly how a DVD treats the space between tracks.
				disarmHunt();
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
				disarmHunt();
				setPinned(false);
				setPlaying(false);
			},
			setSpeed: (value: number) => setSpeed(value),
			seekToTime,
			skip: (deltaSeconds: number) => {
				const base = cursorTime ?? timeline?.endTime ?? Date.now() / 1000;
				seekToTime(base + deltaSeconds);
			},
			stepBegin: (direction: -1 | 1) => {
				// Request stepping is bounded by the CURRENT chapter: scan for
				// the nearest completion-begin; none left in that direction
				// lands on the chapter's own boundary (begin for <<, end for
				// >>). The fold can span past both boundaries (chart depth
				// behind, runway ahead), so both scans clamp to the chapter.
				const cursor = cursorTime ?? timeline?.endTime ?? Date.now() / 1000;
				const inside = chapters.find((chapter) => chapter.beginTime <= cursor && cursor <= (chapter.endTime ?? Number.POSITIVE_INFINITY));
				const floor = inside?.beginTime ?? Number.NEGATIVE_INFINITY;
				// An open (live) chapter has no end yet — the wall clock caps it.
				const endCap = inside?.endTime != null ? inside.endTime - TRACK_END_EPSILON : Date.now() / 1000;
				const fold = foldRef.current;
				let target: number | null = null;
				for (const message of fold) {
					if (message.event !== 'apaevt_flow') continue;
					if ((message.body as Record<string, unknown>).op !== 'begin') continue;
					const time = message.body.eventTime;
					if (direction < 0) {
						// Last begin strictly before the cursor, inside the chapter.
						if (time < cursor - STEP_BEGIN_EPSILON) {
							if (time >= floor) target = time;
						} else break;
					} else if (time > cursor + STEP_BEGIN_EPSILON) {
						// First begin strictly after the cursor.
						target = time;
						break;
					}
				}

				if (direction < 0) {
					// << : nearest earlier begin, else the chapter's beginning.
					// Landing sits just PAST the begin so its frame plays
					// through — the request reads as started, not about-to-be.
					if (target !== null) seekToTime(target + STEP_BEGIN_LEAD);
					else if (inside) seekToTime(inside.beginTime);
					return;
				}

				// >> : nearest later begin within the chapter (landing just
				// past it, same as <<); a begin beyond the chapter (or none at
				// all with the end already delivered) lands on the chapter's
				// end.
				if (target !== null) {
					seekToTime(Math.min(target + STEP_BEGIN_LEAD, endCap));
					return;
				}
				const tail = fold.length > 0 ? fold[fold.length - 1].body.eventTime : null;
				if (tail !== null && tail >= endCap) {
					if (inside) seekToTime(endCap);
					return;
				}
				// The next begin (or the chapter end) is past the delivered
				// window — the runway throttle only drains ~2 min past the
				// needle. Arm the hunt (suspends the throttle; deliver() lands
				// on the next begin or the endCap) and kick a runway-paused
				// session back into motion.
				const hunt = { generation: generationRef.current, fromTime: cursor, endCap };
				beginHuntRef.current = hunt;
				// The wait is a fetch from the user's seat — say so.
				setBuffering(true);
				// Backstop: a stalled stream (interrupted run that never wrote
				// another event) would otherwise leave the hunt armed forever —
				// after the deadline, land on the cap and restore the throttle.
				setTimeout(() => {
					if (beginHuntRef.current === hunt) {
						disarmHunt();
						setCursorTime(endCap);
						setRebuildTick((value) => value + 1);
					}
				}, HUNT_DEADLINE_MS);
				const session = sessionRef.current;
				if (session && !sessionRunningRef.current) {
					const generation = generationRef.current;
					sessionRunningRef.current = true;
					void session
						.play(undefined, 0, (item) => deliver(generation, item.event))
						.catch(() => {
							sessionRunningRef.current = false;
						});
				}
			},
			previousTrack: () => {
				// |<: to the CURRENT task's beginning; already there (or in a
				// dead zone) -> to the PREVIOUS task's end, just BEFORE its
				// termination flurry — the run's final stats, still visible.
				const cursor = cursorTime ?? Number.POSITIVE_INFINITY;
				const inside = chapters.find((chapter) => chapter.beginTime <= cursor && cursor <= (chapter.endTime ?? Number.POSITIVE_INFINITY));
				if (inside && cursor > inside.beginTime + 1) {
					seekToTime(inside.beginTime);
					return;
				}
				const bound = inside ? inside.beginTime : cursor;
				let previous: TaskChapter | null = null;
				for (const chapter of chapters) {
					if (chapter.endTime != null && chapter.endTime <= bound && (previous === null || chapter.endTime > (previous.endTime ?? 0))) {
						previous = chapter;
					}
				}
				if (previous?.endTime != null) seekToTime(previous.endTime - TRACK_END_EPSILON);
				else if (chapters[0]) seekToTime(chapters[0].beginTime);
			},
			nextTrack: () => {
				// >|: to the CURRENT task's end, just BEFORE its termination
				// flurry (final stats); in a dead zone -> the next task's
				// beginning. At the live edge of an open run there is no end
				// yet — nothing to do.
				const cursor = cursorTime ?? 0;
				const inside = chapters.find((chapter) => chapter.beginTime <= cursor && cursor <= (chapter.endTime ?? Number.POSITIVE_INFINITY));
				if (inside && inside.endTime != null && cursor < inside.endTime - TRACK_END_EPSILON - 0.5) {
					seekToTime(inside.endTime - TRACK_END_EPSILON);
					return;
				}
				const next = chapters.find((chapter) => chapter.beginTime > cursor + 1);
				if (next) seekToTime(next.beginTime);
			},
			goLive: () => {
				// GO LIVE = pin the position to now and resume; the ticker
				// keeps it riding the wall clock and maybeResume drains the
				// session up to the head.
				disarmHunt();
				const fold = foldRef.current;
				const tail = fold.length > 0 ? fold[fold.length - 1].body.eventTime : null;
				const head = Math.max(Date.now() / 1000, tail ?? 0);
				setPinned(true);
				setPlaying(true);
				setCursorTime(head);
			},
		};
	}, [timeline, cursorTime, inGap, gapNeighbors, seekToTime, deliver, disarmHunt]);

	// =========================================================================
	// RESULT
	// =========================================================================

	const player = useMemo<TaskPlayerState>(() => ({ mode, playing, speed, cursorTime, buffering }), [mode, playing, speed, cursorTime, buffering]);

	return { statusAt, trackEvents, rangeEvents, chartSeries, trackStats, ingestLive, player, controller, inGap, gapNeighbors };
}
