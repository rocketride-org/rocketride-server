// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PlayBar — the needle-style DVR transport for one source's run-log continuum.
 *
 * Security-DVR paradigm: the playhead is a FIXED red needle; the timeline
 * strip slides underneath it. This makes one gesture set cover a 5-second
 * slice inside a run and a 90-day overview alike:
 *
 * - drag the strip     = scrub (the content moves, the needle does not)
 * - mouse wheel        = continuous zoom around the needle (the ruler
 *                        re-labels itself: seconds -> clock times -> dates)
 * - Shift + drag       = brush an Analyze time slice (purple overlay)
 * - double-click a run = play that track from its beginning
 * - readout button     = the needle's full date/time; clicking it opens the
 *                        CHAPTER MENU (all runs grouped by day) — picking one
 *                        jumps the needle to the run AND frames it at a
 *                        comfortable zoom. The menu is the scale-free answer
 *                        to hundreds of runs: a list never runs out of pixels.
 * - Arrow keys         = ±30 s skips while the bar has focus
 * - |< / >|            = jump to the previous / next run's beginning
 * - << / >>            = step by the selected JUMP AMOUNT (dropdown between
 *                        them): a fixed time delta, or Request = the nearest
 *                        completion begin. Independent of the zoom factor.
 *                        Buttons disable when there is nowhere to go.
 *
 * The DVR is central chrome: the full lane and transport row are ALWAYS
 * visible — no hover-reveal, no resting ribbon. (Live still slims the
 * transport row itself, since stepping means nothing at the live head.)
 *
 * Rendering is a pure projection of [chapters + position]; all transport
 * behavior lives in the useTaskEvents controller.
 */

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'shell';
import { useClickOutside } from 'shell';
import type {
	TaskChapter,
	TaskPlayerController,
	TaskPlayerState,
	TaskTimeline,
} from '../../modules/project/hooks/useTaskEvents';

// =============================================================================
// TYPES
// =============================================================================

/** A brushed Analyze time slice (epoch seconds). */
export interface ITimeSelection {
	from: number;
	to: number;
}

/** Props for {@link PlayBar}. */
export interface IPlayBarProps {
	/** Stream timeline (chapters + horizon) from log.chapters. */
	timeline: TaskTimeline | null;
	/**
	 * Host-announced task-active switch: true after apaevt_task 'begin',
	 * false after 'end', null while unknown (page opened mid-run) — the
	 * open run renders GREEN only while a task is actually running; the
	 * timeline's completed flag is the fallback.
	 */
	runActive?: boolean | null;
	/** Transport state from useTaskEvents. */
	player: TaskPlayerState;
	/** Transport controller from useTaskEvents. */
	controller: TaskPlayerController;
	/** The current Analyze slice (rendered as a purple overlay), if any. */
	selection?: ITimeSelection | null;
	/** Called when the user brushes a new slice (Shift+drag) or clears it. */
	onSelectionChange?: (selection: ITimeSelection | null) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Playback speeds the badge cycles through. */
const SPEEDS = [0.25, 0.5, 1, 2, 4, 10, 25];

/** Seconds skipped by the arrow keys. */
const SKIP_SECONDS = 30;

/**
 * Jump-amount choices for << / >>: Request steps to the nearest
 * completion-begin flow event; numbers are fixed time deltas in seconds.
 */
const JUMP_STEPS: Array<{ key: number | 'request'; label: string }> = [
	{ key: 'request', label: 'Request' },
	{ key: 1, label: '1 s' },
	{ key: 5, label: '5 s' },
	{ key: 15, label: '15 s' },
	{ key: 30, label: '30 s' },
	{ key: 60, label: '1 min' },
	{ key: 300, label: '5 min' },
	{ key: 900, label: '15 min' },
	{ key: 3600, label: '1 h' },
];

/** The fixed needle position as a fraction of the strip width. */
const NEEDLE_FRACTION = 0.68;

/** Zoom bounds (seconds of stream per pixel). */
const MIN_SEC_PER_PX = 0.25;
const MAX_SEC_PER_PX = 7200;

/** Strip height (px) — the lane is always fully unfolded. */
const STRIP_EXPANDED = 62;

/** Ruler steps (seconds) — the first that yields >= ~88px between labels wins. */
const TICK_STEPS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400];

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	container: {
		borderTop: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		padding: '8px 14px 12px',
	},
	chrome: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginBottom: 8,
		position: 'relative',
		transition: 'opacity 0.15s',
	},
	timeButton: {
		fontFamily: 'Consolas, "Courier New", monospace',
		fontSize: 13,
		fontWeight: 700,
		letterSpacing: '0.02em',
		display: 'inline-flex',
		alignItems: 'center',
		gap: 7,
	},
	timeCaret: {
		fontSize: 10,
		color: 'var(--rr-text-secondary)',
	},
	zoomReadout: {
		marginLeft: 'auto',
		fontFamily: 'Consolas, "Courier New", monospace',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	},
	strip: {
		position: 'relative',
		background: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		overflow: 'hidden',
		cursor: 'grab',
		transition: 'height 0.16s ease',
	},
	runBlock: {
		position: 'absolute',
		top: '14%',
		height: '52%',
		borderRadius: 3,
		background: 'var(--rr-brand)',
		opacity: 0.85,
	},
	future: {
		position: 'absolute',
		top: 0,
		bottom: 0,
		right: 0,
		background: 'repeating-linear-gradient(45deg, var(--rr-bg-surface-alt) 0 6px, var(--rr-bg-widget) 6px 12px)',
		borderLeft: '1px solid var(--rr-border)',
	},
	needle: {
		position: 'absolute',
		top: 0,
		bottom: 0,
		width: 0,
		borderLeft: '2px solid var(--rr-color-error)',
		zIndex: 5,
		pointerEvents: 'none',
	},
	needleFlag: {
		position: 'absolute',
		top: -1,
		left: -5,
		border: '5px solid transparent',
		borderTopColor: 'var(--rr-color-error)',
	},
	tick: {
		position: 'absolute',
		bottom: 0,
		width: 1,
		height: 11,
		background: 'var(--rr-border)',
	},
	tickLabel: {
		position: 'absolute',
		bottom: 1,
		fontSize: 9,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	},
	selection: {
		position: 'absolute',
		top: 0,
		bottom: 0,
		background: 'rgba(156, 39, 176, 0.18)',
		border: '1px solid var(--rr-chart-purple, #9c27b0)',
		zIndex: 2,
		pointerEvents: 'none',
	},
	// Fixed-position popup (escapes the section's overflow clipping); the
	// vertical placement/flip is applied inline from the measured trigger.
	menu: {
		position: 'fixed',
		zIndex: 10000,
		minWidth: 360,
		maxHeight: 420,
		overflowY: 'auto',
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 10,
		boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
		padding: 6,
	},
	menuDay: {
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: '0.06em',
		color: 'var(--rr-text-secondary)',
		padding: '10px 12px 4px',
		textTransform: 'uppercase',
	},
	menuItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 11,
		padding: '9px 12px',
		borderRadius: 6,
		cursor: 'pointer',
		fontSize: 13.5,
		color: 'var(--rr-text-primary)',
	},
	menuDot: {
		width: 10,
		height: 10,
		borderRadius: '50%',
		flex: '0 0 auto',
	},
	menuTime: {
		fontFamily: 'Consolas, "Courier New", monospace',
		fontWeight: 700,
		fontSize: 14,
	},
	menuDetail: {
		marginLeft: 'auto',
		color: 'var(--rr-text-secondary)',
		fontSize: 12.5,
	},
	menuEmpty: {
		padding: '10px 12px',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	},
	speedMenu: {
		position: 'fixed',
		zIndex: 10000,
		minWidth: 96,
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
		padding: 5,
	},
	speedItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 10px',
		borderRadius: 5,
		cursor: 'pointer',
		fontSize: 13,
		fontFamily: 'Consolas, "Courier New", monospace',
		color: 'var(--rr-text-primary)',
	},
	speedDot: {
		width: 12,
		fontSize: 9,
		color: 'var(--rr-brand)',
		flex: '0 0 auto',
		textAlign: 'center',
	},
	// Thin vertical rule between transport groups in the chrome row.
	separator: {
		width: 1,
		alignSelf: 'stretch',
		background: 'var(--rr-border)',
		margin: '1px 4px',
	},
};

// =============================================================================
// GLYPHS — inline SVG so Windows never substitutes emoji presentation
// =============================================================================

/** Bare play triangle. */
const PlayGlyph: React.FC = () => (
	<svg width="8" height="9" viewBox="0 0 11 12" aria-hidden="true" style={{ display: 'block' }}>
		<polygon points="1,0 11,6 1,12" fill="currentColor" />
	</svg>
);

/** Bare pause bars. */
const PauseGlyph: React.FC = () => (
	<svg width="8" height="9" viewBox="0 0 10 12" aria-hidden="true" style={{ display: 'block' }}>
		<rect x="0" y="0" width="3.4" height="12" fill="currentColor" />
		<rect x="6.6" y="0" width="3.4" height="12" fill="currentColor" />
	</svg>
);

// =============================================================================
// HELPERS
// =============================================================================

/** Same calendar day? */
const isSameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** Clock time, optionally with seconds. */
const fmtClock = (d: Date, withSeconds: boolean): string =>
	d.toLocaleTimeString([], withSeconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

/** Short date: "Mon, Jul 21". */
const fmtDate = (d: Date): string => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/** Compact duration from minutes-free seconds. */
const fmtDuration = (seconds: number): string => {
	if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
	if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
	return `${Math.max(1, Math.round(seconds))} s`;
};

/** Pick the ruler step for a zoom level (~88px between labels). */
const tickStep = (secPerPx: number): number => {
	for (const s of TICK_STEPS) if (s / secPerPx >= 88) return s;
	return TICK_STEPS[TICK_STEPS.length - 1];
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The per-source needle transport + timeline strip. One instance per source
 * section.
 */
export const PlayBar: React.FC<IPlayBarProps> = ({ timeline, player, controller, runActive = null, selection = null, onSelectionChange }) => {
	// The whole bar — the keyboard-transport scope (see the keydown effect).
	const containerRef = useRef<HTMLDivElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	// --- View state -----------------------------------------------------------
	const [secPerPx, setSecPerPx] = useState(2);
	const [menuOpen, setMenuOpen] = useState(false);
	const [dragging, setDragging] = useState(false);
	// While scrubbing, the strip renders from this local position; the real
	// seek is committed once on mouse-up (seeks fetch — not per mousemove).
	const [scrubPos, setScrubPos] = useState<number | null>(null);
	// In-flight brush (epoch-seconds pair), before it commits to `selection`.
	const [brush, setBrush] = useState<[number, number] | null>(null);
	// 1 Hz wall tick: keeps the future hatch / live edge moving even when the
	// transport is paused and no player state changes.
	const [, setNowTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setNowTick((v) => v + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	// Strip width (px) — observed, not just measured once: sidebar collapse,
	// panel resizes, and font settling all change the strip's width without a
	// window resize, and a stale width skews EVERY pixel computation (needle,
	// hatch, run blocks, ticks).
	const [stripWidth, setStripWidth] = useState(1000);
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const measure = () => setStripWidth(strip.clientWidth || 1000);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(strip);
		return () => observer.disconnect();
	}, []);

	// The ref wraps the toggle button AND the dropdown, so clicking the
	// button is "inside" (toggle works) while anything else closes it.
	const closeMenu = useCallback(() => setMenuOpen(false), []);
	useClickOutside(menuRef, closeMenu);
	// Fixed-position placement: drop DOWN over the strip (the mockup look);
	// flip up only when the viewport bottom leaves no room. Fixed positioning
	// escapes the section's overflow clipping either way.
	const [menuPos, setMenuPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
	useEffect(() => {
		if (!menuOpen || !menuRef.current) {
			setMenuPos(null);
			return;
		}
		const rect = menuRef.current.getBoundingClientRect();
		const up = window.innerHeight - rect.bottom < 340;
		setMenuPos({ top: up ? rect.top - 6 : rect.bottom + 6, left: rect.left, up });
	}, [menuOpen]);

	// Speed dropdown (replay only) — same fixed-placement treatment.
	const speedRef = useRef<HTMLDivElement>(null);
	const [speedOpen, setSpeedOpen] = useState(false);
	const closeSpeed = useCallback(() => setSpeedOpen(false), []);
	useClickOutside(speedRef, closeSpeed);
	const [speedPos, setSpeedPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
	useEffect(() => {
		if (!speedOpen || !speedRef.current) {
			setSpeedPos(null);
			return;
		}
		const rect = speedRef.current.getBoundingClientRect();
		const up = window.innerHeight - rect.bottom < 260;
		setSpeedPos({ top: up ? rect.top - 6 : rect.bottom + 6, left: rect.left, up });
	}, [speedOpen]);

	// Jump-amount dropdown (replay only) — what << / >> step by: a fixed
	// time delta or Request (nearest completion begin). Decoupled from zoom.
	const jumpRef = useRef<HTMLDivElement>(null);
	const [jumpOpen, setJumpOpen] = useState(false);
	const closeJump = useCallback(() => setJumpOpen(false), []);
	useClickOutside(jumpRef, closeJump);
	const [jumpPos, setJumpPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
	useEffect(() => {
		if (!jumpOpen || !jumpRef.current) {
			setJumpPos(null);
			return;
		}
		const rect = jumpRef.current.getBoundingClientRect();
		const up = window.innerHeight - rect.bottom < 320;
		setJumpPos({ top: up ? rect.top - 6 : rect.bottom + 6, left: rect.left, up });
	}, [jumpOpen]);
	const [jumpStep, setJumpStep] = useState<number | 'request'>(30);
	const jumpLabel = JUMP_STEPS.find((step) => step.key === jumpStep)?.label ?? '30 s';

	// --- Geometry -------------------------------------------------------------
	const nowSec = Date.now() / 1000;
	const isLive = player.mode === 'live';
	// The needle's time: local scrub position while dragging, else the DVR
	// position.
	const position = scrubPos ?? player.cursorTime ?? nowSec;
	const needleX = stripWidth * NEEDLE_FRACTION;
	/** Epoch seconds -> strip x (px). */
	const xOf = useCallback((t: number): number => needleX - (position - t) / secPerPx, [needleX, position, secPerPx]);
	/** Strip x (px) -> epoch seconds. */
	const timeAt = useCallback((x: number): number => position - (needleX - x) * secPerPx, [needleX, position, secPerPx]);

	// --- Interactions ---------------------------------------------------------

	// Wheel zoom around the needle (non-passive listener: we preventDefault).
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			setSecPerPx((current) => Math.min(MAX_SEC_PER_PX, Math.max(MIN_SEC_PER_PX, current * (e.deltaY > 0 ? 1.35 : 1 / 1.35))));
		};
		strip.addEventListener('wheel', onWheel, { passive: false });
		return () => strip.removeEventListener('wheel', onWheel);
	}, []);

	/** Mouse-down starts a scrub (plain) or a brush (Shift). */
	const handleStripMouseDown = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			if (!stripRef.current) return;
			const rect = stripRef.current.getBoundingClientRect();
			const startX = e.clientX;
			const startTime = timeAt(e.clientX - rect.left);
			e.preventDefault();

			if (e.shiftKey) {
				setBrush([startTime, startTime]);
				const move = (ev: MouseEvent) => {
					setBrush([startTime, timeAt(ev.clientX - rect.left)]);
				};
				const up = (ev: MouseEvent) => {
					window.removeEventListener('mousemove', move);
					window.removeEventListener('mouseup', up);
					const endTime = timeAt(ev.clientX - rect.left);
					setBrush(null);
					const from = Math.min(startTime, endTime);
					const to = Math.max(startTime, endTime);
					// Ignore accidental micro-brushes (< ~3px of drag).
					if (Math.abs(ev.clientX - startX) > 3) onSelectionChange?.({ from, to });
				};
				window.addEventListener('mousemove', move);
				window.addEventListener('mouseup', up);
				return;
			}

			// Scrub: content follows the pointer; commit the seek on mouse-up.
			const basePos = position;
			setDragging(true);
			let lastPos = basePos;
			const move = (ev: MouseEvent) => {
				// Grab-the-tape direction: the content follows the hand, so
				// dragging LEFT pulls later times under the needle (position
				// increases), dragging RIGHT rewinds.
				lastPos = Math.min(Date.now() / 1000, basePos - (ev.clientX - startX) * secPerPx);
				setScrubPos(lastPos);
			};
			const up = (ev: MouseEvent) => {
				window.removeEventListener('mousemove', move);
				window.removeEventListener('mouseup', up);
				setDragging(false);
				setScrubPos(null);
				if (Math.abs(ev.clientX - startX) <= 3) return; // click, not a drag
				// Scrubbing to (within a second of) the head = go live.
				if (Date.now() / 1000 - lastPos < 1) controller.goLive();
				else controller.seekToTime(lastPos);
			};
			window.addEventListener('mousemove', move);
			window.addEventListener('mouseup', up);
		},
		[timeAt, position, secPerPx, controller, onSelectionChange],
	);

	// ±30 s on arrow keys; Esc clears the selection. Bound to the BAR, not
	// window: several PlayBars mount at once (one per source), so a global
	// listener would make one keypress scrub every bar. tabIndex on the
	// container makes it focusable, so the keys reach it.
	useEffect(() => {
		const bar = containerRef.current;
		if (!bar) return;
		const onKey = (e: KeyboardEvent) => {
			// Stand down while the user is typing in a form field or editable
			// region (their keydowns bubble up through the bar).
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
			if (e.key === 'ArrowLeft') {
				e.preventDefault();
				controller.skip(-SKIP_SECONDS);
			} else if (e.key === 'ArrowRight') {
				e.preventDefault();
				controller.skip(SKIP_SECONDS);
			} else if (e.key === 'Escape' && selection) onSelectionChange?.(null);
		};
		bar.addEventListener('keydown', onKey);
		return () => bar.removeEventListener('keydown', onKey);
	}, [controller, selection, onSelectionChange]);

	/** Jump to a chapter from the menu and frame it at a comfortable zoom. */
	const jumpToChapter = useCallback(
		(chapter: TaskChapter) => {
			setMenuOpen(false);
			const durationSec = Math.max(1, (chapter.endTime ?? Date.now() / 1000) - chapter.beginTime);
			setSecPerPx(Math.min(MAX_SEC_PER_PX, Math.max(MIN_SEC_PER_PX, durationSec / (needleX * 0.55))));
			controller.seekToTime(chapter.beginTime);
		},
		[needleX, controller],
	);

	// --- Derived render pieces ------------------------------------------------

	// Readout: the needle's full date/time (date shown when not today).
	const readout = useMemo(() => {
		const d = new Date(position * 1000);
		const clock = fmtClock(d, true);
		const label = isSameDay(d, new Date()) ? clock : `${fmtDate(d)} · ${clock}`;
		return isLive && scrubPos === null ? `LIVE · ${clock}` : label;
	}, [position, isLive, scrubPos]);

	// Ruler ticks for the visible span.
	const ticks = useMemo(() => {
		const step = tickStep(secPerPx);
		const leftTime = timeAt(0);
		const rightTime = Math.min(nowSec, timeAt(stripWidth));
		const out: Array<{ x: number; label: string; isDate: boolean }> = [];
		for (let t = Math.ceil(leftTime / step) * step; t <= rightTime + step; t += step) {
			const x = xOf(t);
			if (x < -60 || x > stripWidth + 60) continue;
			const d = new Date(t * 1000);
			const isDate = step >= 86400 || (step >= 3600 && d.getHours() === 0);
			const label = nowSec - t < 1 ? 'now' : isDate ? fmtDate(d) : fmtClock(d, step < 60);
			out.push({ x, label, isDate });
		}
		return out;
	}, [secPerPx, timeAt, xOf, stripWidth, nowSec]);

	// Chapter menu entries, newest first, grouped by day.
	// Chapters normalized for display: only the NEWEST chapter may be
	// open-ended (live). An older chapter with a null endTime is a run that
	// died without writing run-end — clamp it to the next chapter's begin so
	// it neither reads as live nor stretches its block to "now". (The writer
	// also self-heals these at the next open; this covers stale caches.)
	const chapters = useMemo(() => {
		const raw = timeline?.chapters ?? [];
		return raw.map((chapter, index) =>
			chapter.endTime == null && index < raw.length - 1
				? { ...chapter, endTime: raw[index + 1].beginTime, outcome: chapter.outcome ?? 'interrupted' }
				: chapter,
		);
	}, [timeline]);

	const menuGroups = useMemo(() => {
		const reversed = [...chapters].reverse();
		const groups: Array<{ day: string; items: TaskChapter[] }> = [];
		for (const chapter of reversed) {
			const d = new Date(chapter.beginTime * 1000);
			const day = isSameDay(d, new Date()) ? 'Today' : fmtDate(d);
			const last = groups[groups.length - 1];
			if (last && last.day === day) last.items.push(chapter);
			else groups.push({ day, items: [chapter] });
		}
		return groups;
	}, [chapters]);
	const activeBrush: [number, number] | null = brush ?? (selection ? [selection.from, selection.to] : null);

	// --- Transport sensitivity: disable buttons with nowhere to go ------------
	const streamStart = timeline?.startTime ?? chapters[0]?.beginTime ?? null;
	const streamEnd = timeline?.endTime ?? null;
	// While the stream is still growing, forward can run to the wall clock.
	const streamGrowing = runActive ?? timeline?.completed === false;
	const forwardLimit = streamGrowing ? nowSec : streamEnd;
	const canStepBack = streamStart === null || position > streamStart + 0.5;
	const canStepForward = forwardLimit === null || position < forwardLimit - 0.5;
	// |<: an earlier landing exists (inside a run past its begin, or any
	// earlier run). >|: an end ahead in this run, or a later run's begin.
	const canPrevTrack = chapters.length > 0 && position > chapters[0].beginTime + 0.5;
	const insideChapter = chapters.find((c) => c.beginTime <= position && position <= (c.endTime ?? Number.POSITIVE_INFINITY));
	const canNextTrack =
		(insideChapter?.endTime != null && position < insideChapter.endTime - 1) || chapters.some((c) => c.beginTime > position + 1);

	// --- Render ---------------------------------------------------------------
	return (
		<div ref={containerRef} tabIndex={0} style={styles.container}>
			{/* Chrome row — always visible: the DVR is central chrome, live
			    and replay alike (live still slims the row to pause + clock,
			    since stepping means nothing at the live head). */}
			<div style={styles.chrome}>
				{/* Live means playing by definition — the button is simply Pause
				    (pressing it freezes the position and drops out of live). */}
				<Button
					variant="primary"
					small
					onClick={isLive || player.playing ? controller.pause : controller.play}
					title={isLive ? 'Pause (drop out of live)' : player.playing ? 'Pause' : 'Play'}
				>
					{isLive || player.playing ? <PauseGlyph /> : <PlayGlyph />}
				</Button>
				{/* The chrome row is ALWAYS visible, but live keeps it minimal:
				    pause + the time/run dropdown (+ zoom scale). Speed and
				    window stepping appear in replay, where they mean something. */}
				{!isLive && (
				<div ref={speedRef} style={{ position: 'relative', display: 'inline-flex' }}>
					<Button variant="ghost" small onClick={() => setSpeedOpen((open) => !open)} title="Playback speed">
						<span style={styles.timeButton}>
							{player.speed}×<span style={styles.timeCaret}>▼</span>
						</span>
					</Button>
					{speedOpen && speedPos && (
						<div role="menu" style={{ ...styles.speedMenu, top: speedPos.top, left: speedPos.left, transform: speedPos.up ? 'translateY(-100%)' : undefined }}>
							{SPEEDS.map((value) => {
								const select = () => {
									controller.setSpeed(value);
									setSpeedOpen(false);
								};
								return (
									<div
										key={value}
										role="menuitemradio"
										aria-checked={player.speed === value}
										tabIndex={0}
										style={styles.speedItem}
										onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'var(--rr-bg-widget)')}
										onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'transparent')}
										onClick={select}
										onKeyDown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												select();
											}
										}}
									>
										<span style={styles.speedDot}>{player.speed === value ? '●' : ''}</span>
										{value}×
									</div>
								);
							})}
						</div>
					)}
				</div>
				)}
				{/* Window stepping (replay only): |< / << / >> / >| step by
				    the JUMP AMOUNT selected in the dropdown between them (a
				    time delta or Request = nearest completion begin) —
				    independent of the zoom factor. Buttons disable when there
				    is nowhere to go in their direction. */}
				{!isLive && (
				<>
				<span style={styles.separator} />
				<Button variant="ghost" small disabled={!canPrevTrack} onClick={controller.previousTrack} title="Beginning of the previous run">
					{'|<'}
				</Button>
				<Button
					variant="ghost"
					small
					disabled={!canStepBack}
					onClick={() => (jumpStep === 'request' ? controller.stepBegin(-1) : controller.skip(-jumpStep))}
					title={jumpStep === 'request' ? 'Previous request begin' : `Back ${jumpLabel}`}
				>
					{'<<'}
				</Button>
				<div ref={jumpRef} style={{ position: 'relative', display: 'inline-flex' }}>
					<Button
						variant="ghost"
						small
						onClick={() => setJumpOpen((open) => !open)}
						title="Jump amount for << and >>"
						ariaExpanded={jumpOpen}
					>
						<span style={styles.timeButton}>
							{jumpLabel}
							<span style={styles.timeCaret}>▼</span>
						</span>
					</Button>
					{jumpOpen && jumpPos && (
						<div
							role="menu"
							style={{ ...styles.speedMenu, top: jumpPos.top, left: jumpPos.left, transform: jumpPos.up ? 'translateY(-100%)' : undefined }}
						>
							{JUMP_STEPS.map((step) => {
								const select = () => {
									setJumpStep(step.key);
									setJumpOpen(false);
								};
								return (
									<div
										key={step.key}
										role="menuitemradio"
										aria-checked={jumpStep === step.key}
										tabIndex={0}
										style={styles.speedItem}
										onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'var(--rr-bg-widget)')}
										onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'transparent')}
										onClick={select}
										onKeyDown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												select();
											}
										}}
									>
										<span style={styles.speedDot}>{jumpStep === step.key ? '●' : ''}</span>
										{step.label}
									</div>
								);
							})}
						</div>
					)}
				</div>
				<Button
					variant="ghost"
					small
					disabled={!canStepForward}
					onClick={() => (jumpStep === 'request' ? controller.stepBegin(1) : controller.skip(jumpStep))}
					title={jumpStep === 'request' ? 'Next request begin' : `Forward ${jumpLabel}`}
				>
					{'>>'}
				</Button>
				<Button variant="ghost" small disabled={!canNextTrack} onClick={controller.nextTrack} title="Beginning of the next run">
					{'>|'}
				</Button>
				<span style={styles.separator} />
				</>
				)}
				<div ref={menuRef} style={{ position: 'relative', display: 'inline-flex' }}>
					<Button variant="ghost" small onClick={() => setMenuOpen((open) => !open)} title="Jump to a run">
						<span style={styles.timeButton}>
							{readout}
							<span style={styles.timeCaret}>▼</span>
						</span>
					</Button>
					{menuOpen && menuPos && (
					<div role="menu" style={{ ...styles.menu, top: menuPos.top, left: menuPos.left, transform: menuPos.up ? 'translateY(-100%)' : undefined }}>
						{menuGroups.length === 0 && <div style={styles.menuEmpty}>No recorded runs yet</div>}
						{menuGroups.map((group) => (
							<React.Fragment key={group.day}>
								<div style={styles.menuDay}>{group.day}</div>
								{group.items.map((chapter) => {
									const liveChapter = chapter.endTime == null && (runActive ?? timeline?.completed === false);
									const dotColor = liveChapter ? 'var(--rr-color-success)' : chapter.outcome === 'error' ? 'var(--rr-color-error)' : 'var(--rr-brand)';
									const durationSec = (chapter.endTime ?? Date.now() / 1000) - chapter.beginTime;
									// A live row returns to the live edge; a recorded
									// row jumps the needle and frames the run.
									const activate = () => {
										if (liveChapter) {
											setMenuOpen(false);
											controller.goLive();
										} else jumpToChapter(chapter);
									};
									return (
										<div
											key={chapter.beginSeq}
											role="menuitem"
											tabIndex={0}
											style={styles.menuItem}
											onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'var(--rr-bg-widget)')}
											onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = 'transparent')}
											onClick={activate}
											onKeyDown={(e) => {
												if (e.key === 'Enter' || e.key === ' ') {
													e.preventDefault();
													activate();
												}
											}}
										>
											<span style={{ ...styles.menuDot, background: dotColor }} />
											<span style={styles.menuTime}>{fmtClock(new Date(chapter.beginTime * 1000), true)}</span>
											<span style={styles.menuDetail}>
												{liveChapter ? 'LIVE' : fmtDuration(durationSec) + (chapter.outcome === 'error' ? ' · failed' : '')}
											</span>
										</div>
									);
								})}
							</React.Fragment>
						))}
					</div>
					)}
				</div>
				{/* GO LIVE sits in the transport after the run selector — and
				    only in replay: at the live edge there is nowhere to go. */}
				{!isLive && (
					<Button variant="primary" small onClick={controller.goLive} title="Return to the live edge">
						GO LIVE
					</Button>
				)}
				<span style={styles.zoomReadout}>
					{secPerPx < 60 ? `1px = ${secPerPx.toFixed(1)}s` : `1px = ${(secPerPx / 60).toFixed(1)}m`}
				</span>
			</div>

			{/* The strip — the full lane, always. */}
			<div
				ref={stripRef}
				style={{ ...styles.strip, height: STRIP_EXPANDED, cursor: dragging ? 'grabbing' : 'grab' }}
				onMouseDown={handleStripMouseDown}
			>
				{/* Run blocks (double-click = play that track). */}
				{chapters.map((chapter) => {
					const liveChapter = chapter.endTime == null && (runActive ?? timeline?.completed === false);
					const x1 = xOf(chapter.beginTime);
					const x2 = xOf(chapter.endTime ?? nowSec);
					if (x2 < 0 || x1 > stripWidth) return null;
					const background = liveChapter ? 'var(--rr-color-success)' : chapter.outcome === 'error' ? 'var(--rr-color-error)' : 'var(--rr-brand)';
					const begin = new Date(chapter.beginTime * 1000);
					const title = `${fmtDate(begin)} ${fmtClock(begin, true)} · ${
						liveChapter ? 'live' : fmtDuration((chapter.endTime ?? nowSec) - chapter.beginTime)
					}${chapter.outcome ? ` · ${chapter.outcome}` : ''} — double-click to play this track`;
					return (
						<div
							key={chapter.beginSeq}
							style={{ ...styles.runBlock, left: x1, width: Math.max(3, x2 - x1), background, ...(liveChapter ? { borderRadius: '3px 0 0 3px' } : {}) }}
							title={title}
							onDoubleClick={(e) => {
								e.stopPropagation();
								jumpToChapter(chapter);
								controller.play();
							}}
						/>
					);
				})}

				{/* Ruler (only when unfolded). */}
				{ticks.map((tick) => (
					<React.Fragment key={tick.x}>
						<div style={{ ...styles.tick, left: tick.x }} />
						<div
							style={{
								...styles.tickLabel,
								left: tick.x + 3,
								color: tick.isDate ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
								fontWeight: tick.isDate ? 700 : 400,
							}}
						>
							{tick.label}
						</div>
					</React.Fragment>
				))}

				{/* Analyze slice overlay (in-flight brush or committed selection). */}
				{activeBrush && (
					<div
						style={{
							...styles.selection,
							left: xOf(Math.min(activeBrush[0], activeBrush[1])),
							width: Math.max(2, Math.abs(activeBrush[1] - activeBrush[0]) / secPerPx),
						}}
					/>
				)}

				{/* Future hatch: everything right of now does not exist yet. Never
				    wider than the right-of-needle region — server-stamp clock
				    skew can put the pinned position microseconds "ahead" of the
				    client clock, and the hatch must not cross the needle. */}
				<div style={{ ...styles.future, width: Math.max(0, Math.min(stripWidth - xOf(nowSec), stripWidth - needleX)) }} />

				{/* The fixed needle (CSS-percent so it can never drift from a
				    stale width measurement). */}
				<div style={{ ...styles.needle, left: `${NEEDLE_FRACTION * 100}%` }}>
					<div style={styles.needleFlag} />
				</div>
			</div>
		</div>
	);
};
