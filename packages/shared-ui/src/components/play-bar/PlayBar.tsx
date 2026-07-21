// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PlayBar — the DVD-style transport + activity timeline for one source's
 * run-log continuum.
 *
 * The disc is the stream's whole retained history; TRACKS are runs (the
 * control file's chapters). Transport: previous/next track, rewind-30s /
 * forward-30s, play/pause, playback speeds (1X/2X/4X/10X/25X), GO LIVE.
 * The timeline is the ACTIVITY BAR rendered purely from the chapters
 * metadata (one small `log.chapters` read): filled spans where the task was
 * executing, gaps where it was idle, the retention horizon at the left edge,
 * and the cursor crossing the lane. Clicking a span (or anywhere on the
 * lane) seeks; tiny spans keep a minimum visual width so a 3-second failed
 * run stays clickable.
 *
 * Rendering is pure — all behavior lives in the useTaskEvents controller.
 */

import React, { CSSProperties, useCallback, useRef } from 'react';
import { Button } from '../button/Button';
import type {
	TaskPlayerController,
	TaskPlayerState,
	TaskTimeline,
} from '../../modules/project/hooks/useTaskEvents';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link PlayBar}. */
export interface IPlayBarProps {
	/** Stream timeline (chapters + spans + horizon) from log.chapters. */
	timeline: TaskTimeline | null;
	/** Transport state from useTaskEvents. */
	player: TaskPlayerState;
	/** Transport controller from useTaskEvents. */
	controller: TaskPlayerController;
	/** True while a live run is streaming this source. */
	hasLiveRun: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Available playback speeds (Rod's spec). */
const SPEEDS = [1, 2, 4, 10, 25];

/** Minimum span width (%) so tiny runs stay visible and clickable. */
const MIN_SPAN_PERCENT = 0.8;

/** Seconds skipped by the rewind/forward buttons. */
const SKIP_SECONDS = 30;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	container: {
		borderTop: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		padding: '8px 14px 12px',
	},
	transport: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginBottom: 8,
	},
	timeReadout: {
		marginLeft: 10,
		fontFamily: 'Consolas, "Courier New", monospace',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	},
	timeStrong: {
		color: 'var(--rr-text-primary)',
		fontWeight: 700,
	},
	goLiveWrap: {
		marginLeft: 'auto',
	},
	laneWrap: {
		position: 'relative',
	},
	lane: {
		position: 'relative',
		height: 20,
		background: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: 5,
		cursor: 'pointer',
		overflow: 'hidden',
	},
	span: {
		position: 'absolute',
		top: 3,
		bottom: 3,
		borderRadius: 3,
		background: 'var(--rr-brand)',
		opacity: 0.85,
	},
	spanFailed: {
		background: 'var(--rr-color-error)',
	},
	spanLive: {
		background: 'var(--rr-color-success)',
	},
	cursor: {
		position: 'absolute',
		top: -4,
		bottom: -2,
		width: 0,
		borderLeft: '2px solid var(--rr-text-primary)',
		pointerEvents: 'none',
	},
	cursorKnob: {
		position: 'absolute',
		top: -5,
		left: -5,
		width: 8,
		height: 8,
		borderRadius: '50%',
		background: 'var(--rr-text-primary)',
	},
	axis: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: 10.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 3,
	},
	axisHorizon: {
		color: 'var(--rr-text-disabled)',
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format an epoch-seconds timestamp as a compact local time readout.
 *
 * @param time - Epoch seconds, or null for the live edge.
 * @returns Readable HH:MM:SS (with date when not today), or 'LIVE'.
 */
function formatCursor(time: number | null): string {
	if (time === null) return 'LIVE';
	const date = new Date(time * 1000);
	const today = new Date();
	const sameDay = date.toDateString() === today.toDateString();
	const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	return sameDay ? clock : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}

/**
 * Format the horizon-age label for the axis (e.g. "3 days ago").
 *
 * @param startTime - Retained-window start (epoch seconds), if any.
 * @returns Human age string, or an empty placeholder.
 */
function formatHorizon(startTime: number | null | undefined): string {
	if (!startTime) return '';
	const ageSeconds = Date.now() / 1000 - startTime;
	const days = Math.floor(ageSeconds / 86400);
	if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
	const hours = Math.floor(ageSeconds / 3600);
	if (hours >= 1) return `${hours}h ago`;
	return `${Math.max(1, Math.floor(ageSeconds / 60))}m ago`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The per-source transport + activity bar. One instance per source section.
 */
export const PlayBar: React.FC<IPlayBarProps> = ({ timeline, player, controller, hasLiveRun }) => {
	const laneRef = useRef<HTMLDivElement>(null);

	// --- Timeline geometry ---------------------------------------------------
	// The lane maps [windowStart, windowEnd] -> [0%, 100%]. The window is the
	// retained history; a live stream's right edge rides "now".
	const windowStart = timeline?.startTime ?? null;
	const windowEnd = timeline?.completed === false ? Date.now() / 1000 : (timeline?.endTime ?? null);
	const windowSpan = windowStart !== null && windowEnd !== null ? Math.max(1, windowEnd - windowStart) : null;

	/** Convert an epoch time to a lane percentage (clamped). */
	const toPercent = useCallback(
		(time: number): number => {
			if (windowStart === null || windowSpan === null) return 0;
			return Math.min(100, Math.max(0, ((time - windowStart) / windowSpan) * 100));
		},
		[windowStart, windowSpan],
	);

	// --- Lane click = seek ---------------------------------------------------
	/** Translate a click position on the lane into a time seek. */
	const handleLaneClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if (!laneRef.current || windowStart === null || windowSpan === null) return;
			const rect = laneRef.current.getBoundingClientRect();
			const fraction = (event.clientX - rect.left) / rect.width;
			controller.seekToTime(windowStart + fraction * windowSpan);
		},
		[controller, windowStart, windowSpan],
	);

	// --- Render --------------------------------------------------------------
	const isLive = player.mode === 'live';
	const chapters = timeline?.chapters ?? [];

	return (
		<div style={styles.container}>
			{/* Transport row: |prev  rew-30  play/pause  fwd-30  next|  speeds  readout  GO LIVE */}
			<div style={styles.transport}>
				<Button variant="ghost" small onClick={controller.previousTrack} title="Previous track">
					{'|◀'}
				</Button>
				<Button variant="ghost" small onClick={() => controller.skip(-SKIP_SECONDS)} title="Back 30 seconds">
					{'↺'}30
				</Button>
				<Button
					variant="primary"
					small
					onClick={player.playing ? controller.pause : controller.play}
					title={player.playing ? 'Pause' : 'Play'}
				>
					{player.playing ? '❚❚' : '▶'}
				</Button>
				<Button
					variant="ghost"
					small
					disabled={isLive}
					onClick={() => controller.skip(SKIP_SECONDS)}
					title={isLive ? 'Already at the live head' : 'Forward 30 seconds'}
				>
					30{'↻'}
				</Button>
				<Button variant="ghost" small disabled={isLive} onClick={controller.nextTrack} title="Next track">
					{'▶|'}
				</Button>

				{/* Speeds — event dispatch paced by eventTime deltas / speed. */}
				<div style={{ display: 'inline-flex', gap: 3, marginLeft: 6 }}>
					{SPEEDS.map((value) => (
						<Button
							key={value}
							variant={player.speed === value ? 'primary' : 'ghost'}
							small
							onClick={() => controller.setSpeed(value)}
						>
							{value}X
						</Button>
					))}
				</div>

				<span style={styles.timeReadout}>
					<span style={styles.timeStrong}>{formatCursor(player.cursorTime)}</span>
					{player.buffering ? ' · buffering…' : ''}
				</span>

				<div style={styles.goLiveWrap}>
					<Button
						variant={isLive ? 'primary' : 'ghost'}
						small
						disabled={!hasLiveRun && isLive}
						onClick={controller.goLive}
						title="Return to the live edge"
					>
						{isLive ? 'LIVE' : 'GO LIVE'}
					</Button>
				</div>
			</div>

			{/* Activity bar: rendered from chapters metadata alone. */}
			<div style={styles.laneWrap}>
				<div ref={laneRef} style={styles.lane} onClick={handleLaneClick}>
					{chapters.map((chapter, index) => {
						if (windowStart === null || windowSpan === null) return null;
						const begin = chapter.beginTime;
						const end = chapter.endTime ?? windowEnd ?? begin;
						const left = toPercent(begin);
						const width = Math.max(MIN_SPAN_PERCENT, toPercent(end) - left);
						const liveSpan = chapter.endTime == null && timeline?.completed === false;
						const spanStyle: CSSProperties = {
							...styles.span,
							...(chapter.outcome === 'error' ? styles.spanFailed : {}),
							...(liveSpan ? styles.spanLive : {}),
							left: `${left}%`,
							width: `${width}%`,
						};
						const label = `${formatCursor(begin)} → ${
							chapter.endTime ? formatCursor(chapter.endTime) : 'live'
						}${chapter.outcome ? ` · ${chapter.outcome}` : ''} · track ${index + 1}`;
						return <div key={chapter.beginSeq} style={spanStyle} title={label} />;
					})}

					{/* Cursor — hidden while pinned live (it rides the edge). */}
					{player.cursorTime !== null && windowStart !== null && (
						<div style={{ ...styles.cursor, left: `${toPercent(player.cursorTime)}%` }}>
							<div style={styles.cursorKnob} />
						</div>
					)}
				</div>
				<div style={styles.axis}>
					<span style={styles.axisHorizon}>
						{formatHorizon(windowStart)}
						{timeline && timeline.horizonSeq > 0 ? ' · retention horizon' : ''}
					</span>
					<span>Now</span>
				</div>
			</div>
		</div>
	);
};
