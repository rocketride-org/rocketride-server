// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * useTaskEvents — THE single event-delivery point for one source's continuum.
 *
 * A media-player-style smart buffer over a task's run-log stream:
 *
 * 1. DVR ring buffer — live events accumulate (memory-capped, oldest dropped)
 *    even while paused or scrubbing, so pause-live / scrub-back / GO LIVE
 *    work without refetching.
 * 2. Speed-aware prefetch — replay fetches pages AHEAD of the playhead via
 *    the injected log reader; fetching overlaps dispatch so the network is
 *    never on the critical path of the next event.
 * 3. Generation-cancelled seeks — every seek bumps a generation counter;
 *    in-flight reads from a previous position are discarded on arrival.
 *    v1 buffer policy: ONE contiguous window around the cursor (near seek
 *    reuses it, far seek flushes and refills).
 * 4. Merge/dedupe on seq at the live/backfill seam.
 * 5. Pacing decoupled from fetching — events dispatch into the folds at
 *    eventTime deltas / speed from the buffer.
 *
 * The hook is host-agnostic: the host injects `readLog` (an SDK
 * `client.log.read` wrapper) and calls `ingestLive` from its subscription.
 * All panels (Status/Flow/Trace/Errors/Log) and the PlayBar consume the
 * outputs; one hook instance per source section (source-major layout).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

/** Player mode: pinned to the live edge, or replaying at a time cursor. */
export type PlayerMode = 'live' | 'replay';

/** Transport state exposed to the PlayBar. */
export interface TaskPlayerState {
	mode: PlayerMode;
	playing: boolean;
	/** Playback speed multiplier (1 | 2 | 4 | 10 | 25). */
	speed: number;
	/** Current cursor position (epoch seconds); null before first event. */
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

/** Hook inputs. */
export interface UseTaskEventsOptions {
	/** Pager over the stream's log (host-injected; null disables replay). */
	readLog: LogReadFetcher | null;
	/** Stream timeline (chapters) — drives track navigation + gap detection. */
	timeline: TaskTimeline | null;
	/** DVR/replay buffer cap (messages); oldest dropped beyond it. */
	bufferCap?: number;
}

/** Hook outputs. */
export interface UseTaskEventsResult {
	/**
	 * The ordered, deduped event window visible at the current cursor —
	 * feed these to the folds (trace/status/log projections).
	 */
	visibleEvents: TaskEventMessage[];
	/** Ingest one live event from the host's subscription. */
	ingestLive: (message: TaskEventMessage) => void;
	/** Transport state + controller for the PlayBar. */
	player: TaskPlayerState;
	controller: TaskPlayerController;
	/** True when the cursor sits in an idle gap between tracks. */
	inGap: boolean;
	/** The gap's neighbors when inGap (for the empty-state copy). */
	gapNeighbors: { previous: TaskChapter | null; next: TaskChapter | null };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default DVR/replay buffer cap (messages). */
const DEFAULT_BUFFER_CAP = 20_000;

/** Replay page size requested from the server (server clamps anyway). */
const REPLAY_PAGE_EVENTS = 1_000;

/** Dispatch tick while playing (ms) — events between ticks flush together. */
const PLAYBACK_TICK_MS = 120;

/** Prefetch when fewer than this many buffered events remain ahead. */
const PREFETCH_LOW_WATER = 400;

// =============================================================================
// HOOK
// =============================================================================

/**
 * Buffered event delivery + DVD-style transport for one source's continuum.
 *
 * @param options - Injected log pager, timeline, and buffer sizing.
 * @returns Visible events, live ingest, and the player state/controller.
 */
export function useTaskEvents(options: UseTaskEventsOptions): UseTaskEventsResult {
	const { readLog, timeline, bufferCap = DEFAULT_BUFFER_CAP } = options;

	// --- Buffer state (refs: mutated on hot paths without re-render) --------
	// One contiguous, seq-ordered window of messages (live tail + backfill).
	const bufferRef = useRef<TaskEventMessage[]>([]);
	// Seqs present in the buffer — the live/backfill dedupe seam.
	const seenSeqRef = useRef<Set<number>>(new Set());
	// Seek generation — in-flight fetches from older generations are dropped.
	const generationRef = useRef(0);
	// In replay: buffered continuation cursor (server nextSeq) if paged out.
	const nextSeqRef = useRef<number | undefined>(undefined);
	// Wall-clock of the last dispatch tick (for pacing).
	const lastTickRef = useRef<number>(0);

	// --- Rendered state ------------------------------------------------------
	const [visibleEvents, setVisibleEvents] = useState<TaskEventMessage[]>([]);
	const [mode, setMode] = useState<PlayerMode>('live');
	const [playing, setPlaying] = useState(true);
	const [speed, setSpeed] = useState(1);
	const [cursorTime, setCursorTime] = useState<number | null>(null);
	const [buffering, setBuffering] = useState(false);

	// =========================================================================
	// BUFFER PRIMITIVES
	// =========================================================================

	/** Insert messages into the buffer, seq-ordered and deduped. */
	const absorb = useCallback(
		(messages: TaskEventMessage[]) => {
			const buffer = bufferRef.current;
			const seen = seenSeqRef.current;
			let dirty = false;
			for (const message of messages) {
				if (typeof message.seq !== 'number' || seen.has(message.seq)) continue;
				seen.add(message.seq);
				buffer.push(message);
				dirty = true;
			}
			if (dirty) {
				buffer.sort((a, b) => a.seq - b.seq);
				// DVR ring: drop oldest beyond the cap.
				while (buffer.length > bufferCap) {
					const dropped = buffer.shift();
					if (dropped) seen.delete(dropped.seq);
				}
			}
			return dirty;
		},
		[bufferCap],
	);

	/** Reset the buffer entirely (far seek / stream switch). */
	const flush = useCallback(() => {
		bufferRef.current = [];
		seenSeqRef.current = new Set();
		nextSeqRef.current = undefined;
	}, []);

	/** Publish the window of buffered events at/before the cursor time. */
	const publish = useCallback((upToTime: number | null) => {
		const buffer = bufferRef.current;
		if (upToTime === null) {
			setVisibleEvents([...buffer]);
			return;
		}
		// The buffer is seq-ordered and eventTime is monotone with seq per
		// stream, so a linear cut suffices.
		const visible: TaskEventMessage[] = [];
		for (const message of buffer) {
			if (message.eventTime > upToTime) break;
			visible.push(message);
		}
		setVisibleEvents(visible);
	}, []);

	// =========================================================================
	// LIVE INGEST
	// =========================================================================

	const modeRef = useRef(mode);
	modeRef.current = mode;
	const playingRef = useRef(playing);
	playingRef.current = playing;

	/** Host subscription feed: buffer always; publish only when pinned live. */
	const ingestLive = useCallback(
		(message: TaskEventMessage) => {
			if (!absorb([message])) return;
			if (modeRef.current === 'live' && playingRef.current) {
				setCursorTime(message.eventTime);
				publish(null);
			}
			// Paused-live / replay: the DVR buffer grows silently (smart #1).
		},
		[absorb, publish],
	);

	// =========================================================================
	// REPLAY FETCHING (prefetch pipeline, generation-cancelled)
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
				absorb(page.events);
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

	/** Prefetch ahead of the playhead when the runway gets short (smart #2). */
	const maybePrefetch = useCallback(() => {
		if (nextSeqRef.current === undefined) return;
		const buffer = bufferRef.current;
		const cursor = cursorTime ?? 0;
		let ahead = 0;
		for (let i = buffer.length - 1; i >= 0; i--) {
			if (buffer[i].eventTime <= cursor) break;
			ahead++;
		}
		// Scale the runway with speed: 25X eats a page in seconds.
		if (ahead < PREFETCH_LOW_WATER * Math.max(1, speed / 4)) {
			void fetchFrom({ cursor: nextSeqRef.current }, generationRef.current);
			nextSeqRef.current = undefined; // one in-flight continuation at a time
		}
	}, [cursorTime, speed, fetchFrom]);

	// =========================================================================
	// PLAYBACK PACING (smart #5 — dispatch decoupled from fetching)
	// =========================================================================

	useEffect(() => {
		if (mode !== 'replay' || !playing) return;
		lastTickRef.current = Date.now();
		const timer = setInterval(() => {
			const now = Date.now();
			const elapsed = (now - lastTickRef.current) / 1000;
			lastTickRef.current = now;
			setCursorTime((current) => {
				const next = (current ?? 0) + elapsed * speed;
				publish(next);
				return next;
			});
			maybePrefetch();
		}, PLAYBACK_TICK_MS);
		return () => clearInterval(timer);
	}, [mode, playing, speed, publish, maybePrefetch]);

	// =========================================================================
	// GAP DETECTION (idle space between tracks)
	// =========================================================================

	const { inGap, gapNeighbors } = useMemo(() => {
		if (mode !== 'replay' || cursorTime === null || !timeline?.chapters?.length) {
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
	}, [mode, cursorTime, timeline]);

	// =========================================================================
	// TRANSPORT CONTROLLER (smart #3 — generation-cancelled seeks)
	// =========================================================================

	const seekToTime = useCallback(
		(time: number) => {
			generationRef.current += 1;
			const generation = generationRef.current;
			setMode('replay');
			setPlaying(false);
			setCursorTime(time);

			// Contiguous-window policy: reuse the buffer when the target sits
			// inside it; otherwise flush and refill from the target.
			const buffer = bufferRef.current;
			const covered =
				buffer.length > 0 && buffer[0].eventTime <= time && time <= buffer[buffer.length - 1].eventTime;
			if (covered) {
				publish(time);
				return;
			}
			flush();
			publish(time);
			void fetchFrom({ fromTime: time }, generation);
		},
		[flush, publish, fetchFrom],
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
			pause: () => setPlaying(false),
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
				generationRef.current += 1;
				setMode('live');
				setPlaying(true);
				setCursorTime(null);
				publish(null);
			},
		};
	}, [timeline, cursorTime, inGap, gapNeighbors, seekToTime, publish]);

	// =========================================================================
	// RESULT
	// =========================================================================

	const player = useMemo<TaskPlayerState>(
		() => ({ mode, playing, speed, cursorTime, buffering }),
		[mode, playing, speed, cursorTime, buffering],
	);

	return { visibleEvents, ingestLive, player, controller, inGap, gapNeighbors };
}
